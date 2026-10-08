/**
 * TaskStore — authoritative task-state fact source for agent team work.
 *
 * Stores tasks in an isolated sync-server repo (`{teamName}__tasks`) so
 * message and presence writes do not interfere with task CAS operations.
 */

import { randomUUID } from 'crypto'
import {
  SyncServerAdapter,
  SyncServerError,
  type SyncServerConfig,
} from './syncServerAdapter.js'
import {
  ROLE_PERMISSIONS,
  type TaskArtifact,
  type TaskStatus,
  type TeamRole,
  type TeamTask,
} from './types.js'

const TASK_KEY_PREFIX = 'task_store/'
export const DEFAULT_TASK_LEASE_MS = 30 * 60 * 1000

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['claimed', 'blocked'],
  blocked: ['pending'],
  claimed: ['in_progress', 'pending', 'failed'],
  in_progress: ['review', 'failed', 'pending'],
  review: ['done', 'pending'],
  failed: ['pending'],
  done: [],
}

export interface TaskStoreConfig {
  apiUrl: string
  apiKey: string
  teamName: string
  developerId?: string
}

export interface CreateTaskParams {
  title: string
  description: string
  createdByAgentId: string
  createdByAgentName?: string
  dependencies?: string[]
  expectedOutput?: string
  acceptanceCriteria?: string[]
  requiredRole?: TeamRole
  assignedToAgentId?: string
}

export interface TaskListFilter {
  status?: TaskStatus
  assignedToAgentId?: string
  claimedByAgentId?: string
}

export interface TaskStoreAdapter {
  setEtag(etag: string | undefined): void
  pull(): Promise<{ entries: Record<string, string>; etag?: string; checksum?: string } | null>
  push(entries: Record<string, string>, ifMatch?: string): Promise<unknown>
}

export class TaskStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskStoreError'
  }
}

export class TaskStateError extends TaskStoreError {
  constructor(
    public taskId: string,
    public from: TaskStatus,
    public to: TaskStatus,
  ) {
    super(`Invalid transition: ${from} -> ${to} (task ${taskId})`)
    this.name = 'TaskStateError'
  }
}

export class TaskClaimConflictError extends TaskStoreError {
  constructor(public taskId: string, public currentClaimant: string) {
    super(`Task ${taskId} already claimed by ${currentClaimant}`)
    this.name = 'TaskClaimConflictError'
  }
}

export class TaskOwnershipError extends TaskStoreError {
  constructor(public taskId: string, public agentId: string) {
    super(`Agent ${agentId} is not the owner of task ${taskId}`)
    this.name = 'TaskOwnershipError'
  }
}

export class TaskRoleMismatchError extends TaskStoreError {
  constructor(public taskId: string, public agentRole: TeamRole, public requiredRole: TeamRole) {
    super(`Role ${agentRole} cannot claim task ${taskId} (requires ${requiredRole})`)
    this.name = 'TaskRoleMismatchError'
  }
}

export class TaskAssignmentError extends TaskStoreError {
  constructor(public taskId: string, public agentId: string, public assignedToAgentId: string) {
    super(`Task ${taskId} is assigned to ${assignedToAgentId}, not ${agentId}`)
    this.name = 'TaskAssignmentError'
  }
}

export class TaskPermissionError extends TaskStoreError {
  constructor(public taskId: string, public role: TeamRole, public action: string) {
    super(`Role ${role} cannot ${action} task ${taskId}`)
    this.name = 'TaskPermissionError'
  }
}

export class TaskStore {
  private readonly adapter: TaskStoreAdapter

  constructor(config: TaskStoreConfig)
  constructor(adapter: TaskStoreAdapter)
  constructor(configOrAdapter: TaskStoreConfig | TaskStoreAdapter) {
    if ('pull' in configOrAdapter && 'push' in configOrAdapter) {
      this.adapter = configOrAdapter
      return
    }

    const config = configOrAdapter
    const adapterConfig: SyncServerConfig = {
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      repo: `${config.teamName}__tasks`,
      developerId: config.developerId ?? 'task-store',
    }
    this.adapter = new SyncServerAdapter(adapterConfig)
  }

  async createTask(params: CreateTaskParams): Promise<TeamTask> {
    const taskId = randomUUID()
    const maxRetries = 5

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.adapter.setEtag(undefined)
      const result = await this.adapter.pull()
      const entries = result?.entries ?? {}
      const etag = result?.etag
      const now = new Date().toISOString()
      const dependencies = params.dependencies ?? []

      const task: TeamTask = {
        taskId,
        title: params.title,
        description: params.description,
        status: this.dependenciesReady(dependencies, entries) ? 'pending' : 'blocked',
        dependencies,
        expectedOutput: params.expectedOutput,
        acceptanceCriteria: params.acceptanceCriteria,
        requiredRole: params.requiredRole,
        assignedToAgentId: params.assignedToAgentId,
        createdByAgentId: params.createdByAgentId,
        createdByAgentName: params.createdByAgentName,
        artifacts: [],
        createdAt: now,
        updatedAt: now,
      }

      try {
        await this.adapter.push({ [this.key(taskId)]: JSON.stringify(task) }, etag)
        return task
      } catch (err) {
        if (this.isCasConflict(err)) continue
        throw err
      }
    }

    throw new TaskStoreError('createTask CAS failed after max retries')
  }

  async claimTask(
    taskId: string,
    agentId: string,
    agentName: string | undefined,
    agentRole: TeamRole,
    ttlMs = DEFAULT_TASK_LEASE_MS,
  ): Promise<TeamTask> {
    return this.mutateTask(taskId, (task, entries) => {
      if (task.status !== 'pending') {
        if (task.status === 'claimed' && task.claimedByAgentId) {
          throw new TaskClaimConflictError(taskId, task.claimedByAgentId)
        }
        throw new TaskStateError(taskId, task.status, 'claimed')
      }

      if (task.requiredRole && task.requiredRole !== agentRole) {
        throw new TaskRoleMismatchError(taskId, agentRole, task.requiredRole)
      }

      if (task.assignedToAgentId && task.assignedToAgentId !== agentId) {
        throw new TaskAssignmentError(taskId, agentId, task.assignedToAgentId)
      }

      if (!this.dependenciesReady(task.dependencies, entries)) {
        throw new TaskStateError(taskId, 'blocked', 'claimed')
      }

      return {
        ...task,
        status: 'claimed',
        claimedByAgentId: agentId,
        claimedByAgentName: agentName,
        leaseExpiresAt: this.leaseTimestamp(ttlMs),
      }
    })
  }

  async startTask(taskId: string, agentId: string, ttlMs = DEFAULT_TASK_LEASE_MS): Promise<TeamTask> {
    return this.mutateTask(taskId, (task) => {
      this.assertOwnership(task, agentId)
      this.assertTransition(task, 'in_progress')
      return {
        ...task,
        status: 'in_progress',
        leaseExpiresAt: this.leaseTimestamp(ttlMs),
      }
    })
  }

  async renewLease(taskId: string, agentId: string, ttlMs = DEFAULT_TASK_LEASE_MS): Promise<TeamTask> {
    return this.mutateTask(taskId, (task) => {
      this.assertOwnership(task, agentId)
      if (task.status !== 'claimed' && task.status !== 'in_progress') {
        throw new TaskStateError(taskId, task.status, task.status)
      }
      return {
        ...task,
        leaseExpiresAt: this.leaseTimestamp(ttlMs),
      }
    })
  }

  async releaseClaim(taskId: string, agentId: string): Promise<TeamTask> {
    return this.mutateTask(taskId, (task) => {
      this.assertOwnership(task, agentId)
      this.assertTransition(task, 'pending')
      return {
        ...task,
        status: 'pending',
        claimedByAgentId: undefined,
        claimedByAgentName: undefined,
        leaseExpiresAt: undefined,
      }
    })
  }

  async submitForReview(
    taskId: string,
    artifacts: TaskArtifact[],
    agentId: string,
  ): Promise<TeamTask> {
    return this.mutateTask(taskId, (task) => {
      this.assertOwnership(task, agentId)
      this.assertTransition(task, 'review')
      return {
        ...task,
        status: 'review',
        artifacts: [...(task.artifacts ?? []), ...artifacts],
        leaseExpiresAt: undefined,
      }
    })
  }

  async completeTask(
    taskId: string,
    reviewerId: string,
    reviewerName: string | undefined,
    reviewerRole: TeamRole,
  ): Promise<TeamTask> {
    this.assertCanComplete(taskId, reviewerRole)
    const completed = await this.mutateTask(taskId, (task) => {
      this.assertTransition(task, 'done')
      return {
        ...task,
        status: 'done',
        completedAt: new Date().toISOString(),
        completedByAgentId: reviewerId,
        completedByAgentName: reviewerName,
        leaseExpiresAt: undefined,
      }
    })

    await this.unblockDependents(taskId)
    return completed
  }

  async returnForRevision(
    taskId: string,
    reviewerId: string,
    reviewerRole: TeamRole,
    reason: string,
  ): Promise<TeamTask> {
    this.assertCanComplete(taskId, reviewerRole)
    return this.mutateTask(taskId, (task) => {
      this.assertTransition(task, 'pending')
      return {
        ...task,
        status: 'pending',
        assignedToAgentId: task.claimedByAgentId ?? task.assignedToAgentId,
        claimedByAgentId: undefined,
        claimedByAgentName: undefined,
        leaseExpiresAt: undefined,
        revisionReason: reason,
        completedByAgentId: undefined,
        completedByAgentName: undefined,
        completedAt: undefined,
      }
    })
  }

  async failTask(taskId: string, reason: string, agentId: string): Promise<TeamTask> {
    return this.mutateTask(taskId, (task) => {
      this.assertOwnership(task, agentId)
      if (task.status !== 'claimed' && task.status !== 'in_progress') {
        throw new TaskStateError(taskId, task.status, 'failed')
      }
      return {
        ...task,
        status: 'failed',
        failureReason: reason,
        leaseExpiresAt: undefined,
      }
    })
  }

  async retryTask(taskId: string, actorRole: TeamRole): Promise<TeamTask> {
    const permissions = ROLE_PERMISSIONS[actorRole]
    if (!permissions?.canCreateTask && !permissions?.canManageTeam) {
      throw new TaskPermissionError(taskId, actorRole, 'retry')
    }

    return this.mutateTask(taskId, (task) => {
      this.assertTransition(task, 'pending')
      return {
        ...task,
        status: 'pending',
        claimedByAgentId: undefined,
        claimedByAgentName: undefined,
        leaseExpiresAt: undefined,
        failureReason: undefined,
      }
    })
  }

  async releaseExpiredLeases(): Promise<string[]> {
    this.adapter.setEtag(undefined)
    const result = await this.adapter.pull()
    const entries = result?.entries ?? {}
    const released: string[] = []

    for (const [key, raw] of Object.entries(entries)) {
      if (!key.startsWith(TASK_KEY_PREFIX)) continue
      const task = this.parseTask(raw)
      if (!this.isLeasedStatus(task.status)) continue
      if (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) >= Date.now()) continue

      try {
        const next = await this.mutateTask(task.taskId, (fresh) => {
          if (!this.isLeasedStatus(fresh.status)) return fresh
          if (!fresh.leaseExpiresAt || Date.parse(fresh.leaseExpiresAt) >= Date.now()) return fresh
          return {
            ...fresh,
            status: 'pending',
            claimedByAgentId: undefined,
            claimedByAgentName: undefined,
            leaseExpiresAt: undefined,
          }
        })
        if (next.status === 'pending' && !next.claimedByAgentId) {
          released.push(task.taskId)
        }
      } catch (err) {
        if (this.isCasConflict(err)) continue
        throw err
      }
    }

    return released
  }

  async listTasks(filter?: TaskListFilter): Promise<TeamTask[]> {
    const entries = await this.pullEntries()
    const tasks = this.tasksFromEntries(entries)

    return tasks.filter(task => {
      if (filter?.status && task.status !== filter.status) return false
      if (filter?.assignedToAgentId && task.assignedToAgentId !== filter.assignedToAgentId) return false
      if (filter?.claimedByAgentId && task.claimedByAgentId !== filter.claimedByAgentId) return false
      return true
    })
  }

  async listReadyTasks(agentRole: TeamRole, agentId: string): Promise<TeamTask[]> {
    const entries = await this.pullEntries()
    const doneIds = this.doneTaskIds(entries)
    return this.tasksFromEntries(entries).filter(task => {
      if (task.status !== 'pending') return false
      if (task.requiredRole && task.requiredRole !== agentRole) return false
      if (task.assignedToAgentId && task.assignedToAgentId !== agentId) return false
      return task.dependencies.every(dep => doneIds.has(dep))
    })
  }

  async getTask(taskId: string): Promise<TeamTask | null> {
    const entries = await this.pullEntries()
    const raw = entries[this.key(taskId)]
    return raw ? this.parseTask(raw) : null
  }

  private async mutateTask(
    taskId: string,
    fn: (task: TeamTask, entries: Record<string, string>) => TeamTask,
    maxRetries = 5,
  ): Promise<TeamTask> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.adapter.setEtag(undefined)
      const result = await this.adapter.pull()
      const entries = result?.entries ?? {}
      const etag = result?.etag
      const raw = entries[this.key(taskId)]

      if (!raw) {
        throw new TaskStoreError(`Task ${taskId} not found`)
      }

      const next = fn(this.parseTask(raw), entries)
      next.updatedAt = new Date().toISOString()

      try {
        await this.adapter.push({ [this.key(taskId)]: JSON.stringify(next) }, etag)
        return next
      } catch (err) {
        if (this.isCasConflict(err)) continue
        throw err
      }
    }

    throw new TaskStoreError(`Task ${taskId} CAS failed after max retries`)
  }

  private async unblockDependents(completedTaskId: string): Promise<void> {
    const entries = await this.pullEntries()
    const doneIds = this.doneTaskIds(entries)

    for (const task of this.tasksFromEntries(entries)) {
      if (task.status !== 'blocked') continue
      if (!task.dependencies.includes(completedTaskId)) continue
      if (!task.dependencies.every(dep => doneIds.has(dep))) continue

      try {
        await this.mutateTask(task.taskId, (fresh) => {
          if (fresh.status !== 'blocked') return fresh
          if (!fresh.dependencies.every(dep => this.doneTaskIdsFromCurrent(fresh.taskId, completedTaskId, doneIds).has(dep))) {
            return fresh
          }
          return { ...fresh, status: 'pending' }
        })
      } catch (err) {
        if (!this.isCasConflict(err)) throw err
      }
    }
  }

  private doneTaskIdsFromCurrent(
    _taskId: string,
    completedTaskId: string,
    doneIds: Set<string>,
  ): Set<string> {
    const next = new Set(doneIds)
    next.add(completedTaskId)
    return next
  }

  private async pullEntries(): Promise<Record<string, string>> {
    this.adapter.setEtag(undefined)
    const result = await this.adapter.pull()
    return result?.entries ?? {}
  }

  private tasksFromEntries(entries: Record<string, string>): TeamTask[] {
    return Object.entries(entries)
      .filter(([key]) => key.startsWith(TASK_KEY_PREFIX))
      .map(([, raw]) => this.parseTask(raw))
  }

  private doneTaskIds(entries: Record<string, string>): Set<string> {
    return new Set(
      this.tasksFromEntries(entries)
        .filter(task => task.status === 'done')
        .map(task => task.taskId),
    )
  }

  private dependenciesReady(dependencies: string[], entries: Record<string, string>): boolean {
    if (dependencies.length === 0) return true
    const doneIds = this.doneTaskIds(entries)
    return dependencies.every(dep => doneIds.has(dep))
  }

  private parseTask(raw: string): TeamTask {
    return JSON.parse(raw) as TeamTask
  }

  private key(taskId: string): string {
    return `${TASK_KEY_PREFIX}${taskId}`
  }

  private leaseTimestamp(ttlMs: number): string {
    return new Date(Date.now() + ttlMs).toISOString()
  }

  private assertTransition(task: TeamTask, to: TaskStatus): void {
    if (!VALID_TRANSITIONS[task.status]?.includes(to)) {
      throw new TaskStateError(task.taskId, task.status, to)
    }
  }

  private assertOwnership(task: TeamTask, agentId: string): void {
    const owners = [task.claimedByAgentId, task.assignedToAgentId].filter(Boolean)
    if (owners.length > 0 && !owners.includes(agentId)) {
      throw new TaskOwnershipError(task.taskId, agentId)
    }
  }

  private assertCanComplete(taskId: string, role: TeamRole): void {
    const permissions = ROLE_PERMISSIONS[role]
    if (!permissions?.canCompleteTask && !permissions?.canManageTeam) {
      throw new TaskPermissionError(taskId, role, 'complete')
    }
  }

  private isLeasedStatus(status: TaskStatus): boolean {
    return status === 'claimed' || status === 'in_progress'
  }

  private isCasConflict(err: unknown): boolean {
    return err instanceof SyncServerError && err.status === 412
  }
}
