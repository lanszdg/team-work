/**
 * Messages — re-export all message type definitions.
 *
 * Re-exports from messageTypes.ts core + sub-files so consumers
 * can import from a single entry point.
 */

// Sub-file exports
export {
  IdleNotificationMessage,
  IdleNotificationSchema,
  createIdleNotification,
} from './idleNotification.js'

export {
  PermissionRequestMessage,
  PermissionRequestSchema,
  PermissionResponseMessage,
  PermissionResponseSchema,
  createPermissionResponse,
} from './permissionRequest.js'

// Core message types (shutdown, plan, task, code review, merge, etc.)
export {
  ShutdownRequestMessage,
  ShutdownRequestSchema,
  ShutdownApprovedMessage,
  ShutdownApprovedSchema,
  ShutdownRejectedMessage,
  ShutdownRejectedSchema,
  PlanApprovalRequestMessage,
  PlanApprovalRequestSchema,
  PlanApprovalResponseMessage,
  PlanApprovalResponseSchema,
  TaskAssignmentMessage,
  TaskAssignmentSchema,
  TeamPermissionUpdateMessage,
  TeamPermissionUpdateSchema,
  ModeSetRequestMessage,
  ModeSetRequestSchema,
  SandboxPermissionRequestMessage,
  SandboxPermissionRequestSchema,
  SandboxPermissionResponseMessage,
  SandboxPermissionResponseSchema,
  CodeReviewSubmissionMessage,
  CodeReviewSubmissionSchema,
  createCodeReviewSubmission,
  CodeReviewResponseMessage,
  CodeReviewResponseSchema,
  createCodeReviewResponse,
  MergeRequestMessage,
  MergeRequestSchema,
  createMergeRequest,
  MergeResponseMessage,
  MergeResponseSchema,
  createMergeResponse,
  isStructuredProtocolMessage,
} from '../messageTypes.js'
