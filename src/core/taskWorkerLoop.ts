import {
  createTaskClaimed,
  createTaskCompleted,
  createTaskFailed,
  createTaskStatusUpdate,
  createTaskSubmittedForReview,
} from './messageTypes.js'
import { sendLifecycleNotification } from './lifecycleNotification.js'
import type { MessageDispatcher } from './messageDispatcher.js'
import {
  TaskClaimConflictError,
  TaskOwnershipError,
  TaskRoleMismatchError,
  TaskAssignmentError,
  type TaskStore,
} from './taskStore.js'
import type { TaskArtifact, TeamRole, TeamTask } from './types.js'

export interface TaskExecutionContext {
  task: TeamTask
  signal: AbortSignal
}

export type TaskExecutionResult = TaskArtifact[] | { artifacts?: TaskArtifact[] }

export interface TaskWorkerLoopConfig {
  taskStore: TaskStore
  agentId: string
  agentName?: string
  agentRole: TeamRole
  dispatcher?: MessageDispatcher
  reviewerAgentId?: string
  reviewerAgentName?: string
  leaseTtlMs?: number
  renewIntervalMs?: number
  executeTask: (context: TaskExecutionContext) => Promise<TaskExecutionResult>
}

export type TaskWorkerLoopStatus =
  | 'no_task'
  | 'submitted_for_review'
  | 'failed'
  | 'aborted'
  | 'claim_skipped'

export interface TaskWorkerLoopResult {
  status: TaskWorkerLoopStatus
  task?: TeamTask
  error?: unknown
  notificationErrors?: unknown[]
}

const DEFAULT_WORKER_LEASE_TTL_MS = 30 * 60 * 1000
const DEFAULT_RENEW_INTERVAL_MS = 60_000

export class TaskWorkerLoop {
  private readonly config: TaskWorkerLoopConfig

  constructor(config: TaskWorkerLoopConfig) {
    this.config = config
  }

  async runOnce(): Promise<TaskWorkerLoopResult> {
    const readyTasks = await this.config.taskStore.listReadyTasks(
      this.config.agentRole,
      this.config.agentId,
    )
    const candidate = readyTasks[0]
    if (!candidate) return { status: 'no_task' }

    let claimed: TeamTask
    try {
      claimed = await this.config.taskStore.claimTask(
        candidate.taskId,
        this.config.agentId,
        this.config.agentName,
        this.config.agentRole,
        this.leaseTtlMs,
      )
    } catch (err) {
      if (this.isClaimSkip(err)) {
        return { status: 'claim_skipped', task: candidate, error: err }
      }
      throw err
    }

    const notificationErrors: unknown[] = []

    notificationErrors.push(...await this.notifyReviewer(createTaskClaimed({
      taskId: claimed.taskId,
      fromAgentId: this.config.agentId,
      fromAgentName: this.config.agentName,
      agentRole: this.config.agentRole,
      leaseExpiresAt: claimed.leaseExpiresAt ?? new Date().toISOString(),
    })))

    const started = await this.config.taskStore.startTask(
      claimed.taskId,
      this.config.agentId,
      this.leaseTtlMs,
    )

    notificationErrors.push(...await this.notifyReviewer(createTaskStatusUpdate({
      taskId: started.taskId,
      fromAgentId: this.config.agentId,
      fromAgentName: this.config.agentName,
      oldStatus: 'claimed',
      newStatus: 'in_progress',
    })))

    const abortController = new AbortController()
    let leaseError: unknown
    const renewTimer = this.startLeaseRenewal(started.taskId, abortController, (err) => {
      leaseError = err
    })

    try {
      const result = await this.config.executeTask({
        task: started,
        signal: abortController.signal,
      })

      if (abortController.signal.aborted) {
        return { status: 'aborted', task: started, error: leaseError }
      }

      const artifacts = Array.isArray(result) ? result : result.artifacts ?? []
      const review = await this.config.taskStore.submitForReview(
        started.taskId,
        artifacts,
        this.config.agentId,
      )

      notificationErrors.push(...await this.notifyReviewer(createTaskSubmittedForReview({
        taskId: review.taskId,
        fromAgentId: this.config.agentId,
        fromAgentName: this.config.agentName,
        artifacts,
      })))

      return {
        status: 'submitted_for_review',
        task: review,
        notificationErrors: notificationErrors.length > 0 ? notificationErrors : undefined,
      }
    } catch (err) {
      if (abortController.signal.aborted || err instanceof TaskOwnershipError) {
        return { status: 'aborted', task: started, error: err }
      }

      try {
        const failed = await this.config.taskStore.failTask(
          started.taskId,
          err instanceof Error ? err.message : String(err),
          this.config.agentId,
        )

        notificationErrors.push(...await this.notifyReviewer(createTaskFailed({
          taskId: failed.taskId,
          fromAgentId: this.config.agentId,
          fromAgentName: this.config.agentName,
          reason: failed.failureReason ?? 'task execution failed',
        })))

        return {
          status: 'failed',
          task: failed,
          error: err,
          notificationErrors: notificationErrors.length > 0 ? notificationErrors : undefined,
        }
      } catch (failErr) {
        if (failErr instanceof TaskOwnershipError) {
          return { status: 'aborted', task: started, error: failErr }
        }
        throw failErr
      }
    } finally {
      clearInterval(renewTimer)
    }
  }

  private startLeaseRenewal(
    taskId: string,
    abortController: AbortController,
    onLeaseError: (err: unknown) => void,
  ): ReturnType<typeof setInterval> {
    return setInterval(() => {
      void this.config.taskStore.renewLease(
        taskId,
        this.config.agentId,
        this.leaseTtlMs,
      ).catch((err) => {
        onLeaseError(err)
        abortController.abort(err)
      })
    }, this.renewIntervalMs)
  }

  private async notifyReviewer(payload: Parameters<typeof sendLifecycleNotification>[1]['payload']): Promise<unknown[]> {
    if (!this.config.dispatcher || !this.config.reviewerAgentId) return []
    try {
      await sendLifecycleNotification(this.config.dispatcher, {
        toAgentId: this.config.reviewerAgentId,
        toAgentName: this.config.reviewerAgentName,
        payload,
      })
      return []
    } catch (err) {
      return [err]
    }
  }

  private get leaseTtlMs(): number {
    return this.config.leaseTtlMs ?? DEFAULT_WORKER_LEASE_TTL_MS
  }

  private get renewIntervalMs(): number {
    return this.config.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS
  }

  private isClaimSkip(err: unknown): boolean {
    return (
      err instanceof TaskClaimConflictError ||
      err instanceof TaskRoleMismatchError ||
      err instanceof TaskAssignmentError
    )
  }
}

export interface CompleteTaskReviewParams {
  taskStore: TaskStore
  taskId: string
  reviewerId: string
  reviewerName?: string
  reviewerRole: TeamRole
  dispatcher?: MessageDispatcher
  workerAgentId?: string
  workerAgentName?: string
}

export async function completeTaskReview(params: CompleteTaskReviewParams): Promise<TeamTask> {
  const completed = await params.taskStore.completeTask(
    params.taskId,
    params.reviewerId,
    params.reviewerName,
    params.reviewerRole,
  )

  if (params.dispatcher && params.workerAgentId) {
    await sendLifecycleNotification(params.dispatcher, {
      toAgentId: params.workerAgentId,
      toAgentName: params.workerAgentName,
      payload: createTaskCompleted({
        taskId: completed.taskId,
        fromAgentId: params.reviewerId,
        fromAgentName: params.reviewerName,
      }),
    })
  }

  return completed
}

export interface ReturnTaskForRevisionParams extends CompleteTaskReviewParams {
  reason: string
}

export async function returnTaskForRevision(params: ReturnTaskForRevisionParams): Promise<TeamTask> {
  const previous = await params.taskStore.getTask(params.taskId)
  const returned = await params.taskStore.returnForRevision(
    params.taskId,
    params.reviewerId,
    params.reviewerRole,
    params.reason,
  )

  if (params.dispatcher && params.workerAgentId) {
    await sendLifecycleNotification(params.dispatcher, {
      toAgentId: params.workerAgentId,
      toAgentName: params.workerAgentName,
      payload: createTaskStatusUpdate({
        taskId: returned.taskId,
        fromAgentId: params.reviewerId,
        fromAgentName: params.reviewerName,
        oldStatus: previous?.status ?? 'review',
        newStatus: 'pending',
        meta: { reason: params.reason },
      }),
    })
  }

  return returned
}
