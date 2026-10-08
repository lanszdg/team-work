/**
 * Structured Message Types for Team Cloud Messaging
 *
 * Defines all message schemas exchanged between team members
 * via cloud sync (KV persistence + SSE real-time delivery).
 *
 * Each message type has a unique `type` field for protocol routing.
 * The `isStructuredProtocolMessage()` function identifies messages
 * that should be routed by the inbox poller rather than consumed as
 * raw LLM context.
 */

import { z } from 'zod'

// ============================================================
// Backward-compatible re-exports from split files
// ============================================================

export {
  IdleNotificationMessage,
  IdleNotificationSchema,
  createIdleNotification,
} from './messages/idleNotification.js'

export {
  PermissionRequestMessage,
  PermissionRequestSchema,
  PermissionResponseMessage,
  PermissionResponseSchema,
  createPermissionResponse,
} from './messages/permissionRequest.js'

// ============================================================
// Shutdown Protocol
// ============================================================

/**
 * Leader sends to request a teammate to gracefully shut down.
 */
export interface ShutdownRequestMessage {
  type: 'shutdown_request'
  requestId: string
  from: string
  reason?: string
  timestamp: string
}

export const ShutdownRequestSchema = z.object({
  type: z.literal('shutdown_request'),
  requestId: z.string(),
  from: z.string(),
  reason: z.string().optional(),
  timestamp: z.string(),
})

/**
 * Teammate confirms shutdown.
 */
export interface ShutdownApprovedMessage {
  type: 'shutdown_approved'
  requestId: string
  from: string
  timestamp: string
  paneId?: string
  backendType?: string
}

export const ShutdownApprovedSchema = z.object({
  type: z.literal('shutdown_approved'),
  requestId: z.string(),
  from: z.string(),
  timestamp: z.string(),
  paneId: z.string().optional(),
  backendType: z.string().optional(),
})

/**
 * Teammate rejects the shutdown request.
 */
export interface ShutdownRejectedMessage {
  type: 'shutdown_rejected'
  requestId: string
  from: string
  reason: string
  timestamp: string
}

export const ShutdownRejectedSchema = z.object({
  type: z.literal('shutdown_rejected'),
  requestId: z.string(),
  from: z.string(),
  reason: z.string(),
  timestamp: z.string(),
})

// ============================================================
// Plan Approval
// ============================================================

/**
 * Teammate sends implementation plan for leader review.
 */
export interface PlanApprovalRequestMessage {
  type: 'plan_approval_request'
  from: string
  timestamp: string
  planFilePath: string
  planContent: string
  requestId: string
}

export const PlanApprovalRequestSchema = z.object({
  type: z.literal('plan_approval_request'),
  from: z.string(),
  timestamp: z.string(),
  planFilePath: z.string(),
  planContent: z.string(),
  requestId: z.string(),
})

/**
 * Leader's approval or rejection of a plan.
 */
export interface PlanApprovalResponseMessage {
  type: 'plan_approval_response'
  requestId: string
  approved: boolean
  feedback?: string
  timestamp: string
  permissionMode?: string
}

export const PlanApprovalResponseSchema = z.object({
  type: z.literal('plan_approval_response'),
  requestId: z.string(),
  approved: z.boolean(),
  feedback: z.string().optional(),
  timestamp: z.string(),
  permissionMode: z.string().optional(),
})

// ============================================================
// Task Assignment
// ============================================================

export interface TaskAssignmentMessage {
  type: 'task_assignment'
  taskId: string
  subject: string
  description: string
  assignedBy: string
  timestamp: string
}

export const TaskAssignmentSchema = z.object({
  type: z.literal('task_assignment'),
  taskId: z.string(),
  subject: z.string(),
  description: z.string(),
  assignedBy: z.string(),
  timestamp: z.string(),
})

// ============================================================
// Team Permission Update
// ============================================================

/**
 * Leader broadcasts a permission update to all teammates.
 */
export interface TeamPermissionUpdateMessage {
  type: 'team_permission_update'
  permissionUpdate: {
    type: 'addRules'
    rules: Array<{ toolName: string; ruleContent?: string }>
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'session'
  }
  /** The directory path that was allowed */
  directoryPath: string
  /** The tool name this applies to */
  toolName: string
}

export const TeamPermissionUpdateSchema = z.object({
  type: z.literal('team_permission_update'),
  permissionUpdate: z.object({
    type: z.literal('addRules'),
    rules: z.array(
      z.object({
        toolName: z.string(),
        ruleContent: z.string().optional(),
      }),
    ),
    behavior: z.enum(['allow', 'deny', 'ask']),
    destination: z.literal('session'),
  }),
  directoryPath: z.string(),
  toolName: z.string(),
})

// ============================================================
// Mode Set Request
// ============================================================

export interface ModeSetRequestMessage {
  type: 'mode_set_request'
  mode: string
  from: string
}

export const ModeSetRequestSchema = z.object({
  type: z.literal('mode_set_request'),
  mode: z.string(),
  from: z.string(),
})

// ============================================================
// Sandbox Permission Request / Response
// ============================================================

export interface SandboxPermissionRequestMessage {
  type: 'sandbox_permission_request'
  requestId: string
  workerId: string
  workerName: string
  workerColor?: string
  hostPattern: {
    host: string
  }
  createdAt: number
}

export const SandboxPermissionRequestSchema = z.object({
  type: z.literal('sandbox_permission_request'),
  requestId: z.string(),
  workerId: z.string(),
  workerName: z.string(),
  workerColor: z.string().optional(),
  hostPattern: z.object({ host: z.string() }),
  createdAt: z.number(),
})

export interface SandboxPermissionResponseMessage {
  type: 'sandbox_permission_response'
  requestId: string
  host: string
  allow: boolean
  timestamp: string
}

export const SandboxPermissionResponseSchema = z.object({
  type: z.literal('sandbox_permission_response'),
  requestId: z.string(),
  host: z.string(),
  allow: z.boolean(),
  timestamp: z.string(),
})

// ============================================================
// Code Review Submission / Response / Merge
// ============================================================

/**
 * Sent by a teammate to submit code for review to the team leader.
 */
export interface CodeReviewSubmissionMessage {
  type: 'code_review_submission'
  requestId: string
  from: string
  to: string
  branchName: string
  filesChanged: string[]
  description: string
  diffSummary?: string
  timestamp: string
}

export const CodeReviewSubmissionSchema = z.object({
  type: z.literal('code_review_submission'),
  requestId: z.string(),
  from: z.string(),
  to: z.string(),
  branchName: z.string(),
  filesChanged: z.array(z.string()),
  description: z.string(),
  diffSummary: z.string().optional(),
  timestamp: z.string(),
})

export function createCodeReviewSubmission(params: {
  requestId: string
  from: string
  to: string
  branchName: string
  filesChanged: string[]
  description: string
  diffSummary?: string
}): CodeReviewSubmissionMessage {
  return {
    type: 'code_review_submission',
    requestId: params.requestId,
    from: params.from,
    to: params.to,
    branchName: params.branchName,
    filesChanged: params.filesChanged,
    description: params.description,
    diffSummary: params.diffSummary,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Leader's response to a code review submission.
 */
export interface CodeReviewResponseMessage {
  type: 'code_review_response'
  requestId: string
  from: string
  approved: boolean
  comments?: string[]
  requestedChanges?: string[]
  timestamp: string
}

export const CodeReviewResponseSchema = z.object({
  type: z.literal('code_review_response'),
  requestId: z.string(),
  from: z.string(),
  approved: z.boolean(),
  comments: z.array(z.string()).optional(),
  requestedChanges: z.array(z.string()).optional(),
  timestamp: z.string(),
})

export function createCodeReviewResponse(params: {
  requestId: string
  from: string
  approved: boolean
  comments?: string[]
  requestedChanges?: string[]
}): CodeReviewResponseMessage {
  return {
    type: 'code_review_response',
    requestId: params.requestId,
    from: params.from,
    approved: params.approved,
    comments: params.comments,
    requestedChanges: params.requestedChanges,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Sent by a teammate to request a merge after CR approved.
 */
export interface MergeRequestMessage {
  type: 'merge_request'
  requestId: string
  from: string
  to: string
  sourceBranch: string
  targetBranch: string
  description: string
  timestamp: string
}

export const MergeRequestSchema = z.object({
  type: z.literal('merge_request'),
  requestId: z.string(),
  from: z.string(),
  to: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  description: z.string(),
  timestamp: z.string(),
})

export function createMergeRequest(params: {
  requestId: string
  from: string
  to: string
  sourceBranch: string
  targetBranch: string
  description: string
}): MergeRequestMessage {
  return {
    type: 'merge_request',
    requestId: params.requestId,
    from: params.from,
    to: params.to,
    sourceBranch: params.sourceBranch,
    targetBranch: params.targetBranch,
    description: params.description,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Leader's response to a merge request.
 */
export interface MergeResponseMessage {
  type: 'merge_response'
  requestId: string
  from: string
  success: boolean
  message?: string
  timestamp: string
}

export const MergeResponseSchema = z.object({
  type: z.literal('merge_response'),
  requestId: z.string(),
  from: z.string(),
  success: z.boolean(),
  message: z.string().optional(),
  timestamp: z.string(),
})

export function createMergeResponse(params: {
  requestId: string
  from: string
  success: boolean
  message?: string
}): MergeResponseMessage {
  return {
    type: 'merge_response',
    requestId: params.requestId,
    from: params.from,
    success: params.success,
    message: params.message,
    timestamp: new Date().toISOString(),
  }
}

// ============================================================
// Task Lifecycle Protocol
// ============================================================

const TaskStatusEnum = z.enum([
  'pending',
  'claimed',
  'in_progress',
  'review',
  'done',
  'failed',
  'blocked',
])

const TaskArtifactSchema = z.object({
  type: z.enum(['file', 'branch', 'commit', 'url']),
  value: z.string(),
  description: z.string().optional(),
})

const TaskLifecycleBaseSchema = z.object({
  taskId: z.string(),
  fromAgentId: z.string(),
  fromAgentName: z.string().optional(),
  timestamp: z.string(),
})

export interface TaskAcknowledgedMessage {
  type: 'task_acknowledged'
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  timestamp: string
}

export const TaskAcknowledgedSchema = TaskLifecycleBaseSchema.extend({
  type: z.literal('task_acknowledged'),
})

export interface TaskClaimedMessage {
  type: 'task_claimed'
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  agentRole: string
  leaseExpiresAt: string
  timestamp: string
}

export const TaskClaimedSchema = TaskLifecycleBaseSchema.extend({
  type: z.literal('task_claimed'),
  agentRole: z.string(),
  leaseExpiresAt: z.string(),
})

export interface TaskStatusUpdateMessage {
  type: 'task_status_update'
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  oldStatus: z.infer<typeof TaskStatusEnum>
  newStatus: z.infer<typeof TaskStatusEnum>
  timestamp: string
  meta?: Record<string, unknown>
}

export const TaskStatusUpdateSchema = TaskLifecycleBaseSchema.extend({
  type: z.literal('task_status_update'),
  oldStatus: TaskStatusEnum,
  newStatus: TaskStatusEnum,
  meta: z.record(z.unknown()).optional(),
})

export interface TaskSubmittedForReviewMessage {
  type: 'task_submitted_for_review'
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  artifacts: Array<z.infer<typeof TaskArtifactSchema>>
  timestamp: string
}

export const TaskSubmittedForReviewSchema = TaskLifecycleBaseSchema.extend({
  type: z.literal('task_submitted_for_review'),
  artifacts: z.array(TaskArtifactSchema),
})

export interface TaskCompletedMessage {
  type: 'task_completed'
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  timestamp: string
}

export const TaskCompletedSchema = TaskLifecycleBaseSchema.extend({
  type: z.literal('task_completed'),
})

export interface TaskFailedMessage {
  type: 'task_failed'
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  reason: string
  timestamp: string
}

export const TaskFailedSchema = TaskLifecycleBaseSchema.extend({
  type: z.literal('task_failed'),
  reason: z.string(),
})

function timestamp(): string {
  return new Date().toISOString()
}

export function createTaskAcknowledged(params: {
  taskId: string
  fromAgentId: string
  fromAgentName?: string
}): TaskAcknowledgedMessage {
  return TaskAcknowledgedSchema.parse({
    type: 'task_acknowledged',
    timestamp: timestamp(),
    ...params,
  })
}

export function createTaskClaimed(params: {
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  agentRole: string
  leaseExpiresAt: string
}): TaskClaimedMessage {
  return TaskClaimedSchema.parse({
    type: 'task_claimed',
    timestamp: timestamp(),
    ...params,
  })
}

export function createTaskStatusUpdate(params: {
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  oldStatus: z.infer<typeof TaskStatusEnum>
  newStatus: z.infer<typeof TaskStatusEnum>
  meta?: Record<string, unknown>
}): TaskStatusUpdateMessage {
  return TaskStatusUpdateSchema.parse({
    type: 'task_status_update',
    timestamp: timestamp(),
    ...params,
  })
}

export function createTaskSubmittedForReview(params: {
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  artifacts: Array<z.infer<typeof TaskArtifactSchema>>
}): TaskSubmittedForReviewMessage {
  return TaskSubmittedForReviewSchema.parse({
    type: 'task_submitted_for_review',
    timestamp: timestamp(),
    ...params,
  })
}

export function createTaskCompleted(params: {
  taskId: string
  fromAgentId: string
  fromAgentName?: string
}): TaskCompletedMessage {
  return TaskCompletedSchema.parse({
    type: 'task_completed',
    timestamp: timestamp(),
    ...params,
  })
}

export function createTaskFailed(params: {
  taskId: string
  fromAgentId: string
  fromAgentName?: string
  reason: string
}): TaskFailedMessage {
  return TaskFailedSchema.parse({
    type: 'task_failed',
    timestamp: timestamp(),
    ...params,
  })
}

// ============================================================
// Protocol Routing
// ============================================================

/**
 * Set of all structured protocol message types that should be
 * routed by the inbox poller rather than consumed as raw LLM context.
 *
 * These must be intercepted by InboxPoller before reaching the LLM
 * context, otherwise they get bundled as raw text in attachments.
 */
const STRUCTURED_PROTOCOL_TYPES = new Set([
  'idle_notification',
  'task_assignment',
  'permission_request',
  'permission_response',
  'sandbox_permission_request',
  'sandbox_permission_response',
  'shutdown_request',
  'shutdown_approved',
  'shutdown_rejected',
  'team_permission_update',
  'mode_set_request',
  'plan_approval_request',
  'plan_approval_response',
  'code_review_submission',
  'code_review_response',
  'merge_request',
  'merge_response',
  'task_acknowledged',
  'task_claimed',
  'task_status_update',
  'task_submitted_for_review',
  'task_completed',
  'task_failed',
])

/**
 * Low-level structural protocol detection.
 *
 * Unlike isStructuredProtocolMessage(), this does not require registration.
 * It is used by permission checks to default-deny unknown protocol-like JSON.
 */
export function looksLikeProtocolMessage(messageText: string): boolean {
  try {
    const parsed = JSON.parse(messageText)
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { type?: unknown }).type === 'string'
    )
  } catch {
    return false
  }
}

/**
 * Checks if a message text is a structured protocol message that
 * should be routed by useInboxPoller rather than consumed as raw
 * LLM context.
 */
export function isStructuredProtocolMessage(messageText: string): boolean {
  try {
    const parsed = JSON.parse(messageText)
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return false
    }
    const type = (parsed as { type: unknown }).type
    return STRUCTURED_PROTOCOL_TYPES.has(String(type))
  } catch {
    return false
  }
}
