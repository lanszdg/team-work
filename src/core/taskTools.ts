import type { CreateTaskParams, TaskStore } from './taskStore.js'
import type { RolePermissions, TaskArtifact, TeamRole } from './types.js'
import { ROLE_PERMISSIONS } from './types.js'

export interface TaskToolsConfig {
  taskStore: TaskStore
  agentId: string
  agentName?: string
  agentRole: TeamRole
}

export interface TaskCreateToolParams {
  title: string
  description: string
  dependencies?: string[]
  expectedOutput?: string
  acceptanceCriteria?: string[]
  requiredRole?: TeamRole
  assignedToAgentId?: string
}

export interface TaskReviewToolParams {
  taskId: string
  artifacts: TaskArtifact[]
}

export interface TaskCompleteToolParams {
  taskId: string
}

export interface TaskReturnToolParams {
  taskId: string
  reason: string
}

export class TaskTools {
  private readonly config: TaskToolsConfig

  constructor(config: TaskToolsConfig) {
    this.config = config
  }

  async taskCreate(params: TaskCreateToolParams): Promise<string> {
    this.assertPermission('canCreateTask', 'create tasks')
    const createParams: CreateTaskParams = {
      ...params,
      createdByAgentId: this.config.agentId,
      createdByAgentName: this.config.agentName,
    }
    const task = await this.config.taskStore.createTask(createParams)
    return `Task created: ${task.taskId}\nStatus: ${task.status}\nTitle: ${task.title}`
  }

  async taskListReady(): Promise<string> {
    this.assertPermission('canExecuteTask', 'list ready tasks')
    const tasks = await this.config.taskStore.listReadyTasks(
      this.config.agentRole,
      this.config.agentId,
    )
    if (tasks.length === 0) return 'No ready tasks.'
    return tasks
      .map(task => `- [${task.status}] ${task.title} (${task.taskId})`)
      .join('\n')
  }

  async taskSubmitReview(params: TaskReviewToolParams): Promise<string> {
    this.assertPermission('canExecuteTask', 'submit tasks for review')
    const task = await this.config.taskStore.submitForReview(
      params.taskId,
      params.artifacts,
      this.config.agentId,
    )
    return `Task submitted for review: ${task.taskId}\nArtifacts: ${params.artifacts.length}`
  }

  async taskComplete(params: TaskCompleteToolParams): Promise<string> {
    this.assertPermission('canCompleteTask', 'complete tasks')
    const task = await this.config.taskStore.completeTask(
      params.taskId,
      this.config.agentId,
      this.config.agentName,
      this.config.agentRole,
    )
    return `Task completed: ${task.taskId}`
  }

  async taskReturn(params: TaskReturnToolParams): Promise<string> {
    this.assertPermission('canCompleteTask', 'return tasks for revision')
    const task = await this.config.taskStore.returnForRevision(
      params.taskId,
      this.config.agentId,
      this.config.agentRole,
      params.reason,
    )
    return `Task returned for revision: ${task.taskId}\nReason: ${params.reason}`
  }

  private assertPermission(permission: keyof RolePermissions, action: string): void {
    const permissions = ROLE_PERMISSIONS[this.config.agentRole]
    if (!permissions?.[permission] && !permissions?.canManageTeam) {
      throw new Error(`[TaskTools] Role "${this.config.agentRole}" cannot ${action}`)
    }
  }
}
