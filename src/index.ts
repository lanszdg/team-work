/**
 * Team Collaboration Plugin - Entry Point
 *
 * Detects the host environment (Claude Code vs Open Code) and initializes
 * the appropriate adapter. Provides a unified API for team collaboration
 * features across both platforms.
 *
 * Architecture:
 * - L1: Agent Swarms (cloud messaging, team files, pane backends)
 * - L2: Team Memory Sync (cloud API integration)
 * - Platform adapters for Claude Code and Open Code
 */

// Core exports
export {
  readTeamFile,
  readTeamFileAsync,
  writeTeamFile,
  writeTeamFileAsync,
  createTeam,
  addMember,
  removeTeammateFromTeamFile,
  removeMemberByPaneId,
  setMemberMode,
  setMultipleMemberModes,
  setMemberActive,
  sanitizeName,
  sanitizeAgentName,
  listTeams,
  cleanupTeamDirectories,
  getProfileService,
  clearProfileServiceCache,
} from './core/teamFile.js'

// Cloud messaging (MessageDispatcher + CloudMessageRouter)

export {
  getTeammateStatuses,
  getTeamSummary,
  listAllTeams,
  getCurrentTeam,
  isTeammate,
  isTeamLeader,
  scanCloud,
} from './core/teamDiscovery.js'

export {
  syncTeamMemory,
  createMemoryEntry,
  getSyncStatus,
  saveLocalEntry,
  readLocalEntry,
  listLocalEntries,
  deleteLocalEntry,
} from './core/teamMemorySync.js'

export {
  SyncServerAdapter,
  SyncServerError,
} from './core/syncServerAdapter.js'

export type {
  SyncServerConfig,
  PullResult,
  PushResult,
  SyncResult as ServerSyncResult,
  ServerEvent,
  PushResponse,
  ServerContent,
  ServerResponse,
  HashesResponse,
} from './core/syncServerAdapter.js'

export { InboxPoller, startInboxPoller } from './hooks/inboxPoller.js'
export { initializeTeammateHooks } from './hooks/teammateStop.js'

export {
  sendPermissionRequest,
  sendPermissionResponse,
  findPendingPermissionRequests,
  autoRespondToPermissionRequests,
} from './hooks/permissionBridge.js'

export {
  detectBackend,
  getBackend,
  createTeammatePane,
  sendCommandToPane,
  killPane,
  registerBackend,
  clearBackendCache,
} from './backends/registry.js'

export { TmuxBackend } from './backends/tmux.js'
export { ITermBackend } from './backends/iterm2.js'
export { InProcessBackend, runInTeammateContext, getCurrentTeammateContext } from './backends/inProcess.js'

export {
  initializeClaudeCodePlugin,
  isClaudeCode,
  isCoordinatorMode,
  preToolUseCheck,
  handleJoinCommand,
} from './platform/claude-code.js'

export { initTeamCollab, isInitialized } from './init.js'

export { teamCollabPlugin } from './platform/open-code.js'

export type {
  TeamFile,
  TeamMember,
  TeamAllowedPath,
  TeamRole,
  RolePermissions,
  TeamSummary,
  TeammateStatus,
  TeammateMessage,
  TeamMemoryEntry,
  TeamMemorySyncConfig,
  SyncResult,
  ConflictStrategy,
  SyncDirection,
  BackendType,
  TeammateMode,
  PermissionMode,
  TaskStatus,
  TaskArtifact,
  TeamTask,
  // LockOptions removed in v3.6 Phase 1
  // v4 Architecture types
  TeamMemberProfile,
  CloudTeamState,
  TeamPolicy,
  TeamMemberPresence,
  LocalRuntime,
  LocalPreference,
  TeamMemberView,
} from './core/types.js'

export { ROLE_PERMISSIONS } from './core/types.js'

export {
  TaskStore,
  TaskStoreError,
  TaskStateError,
  TaskClaimConflictError,
  TaskOwnershipError,
  TaskRoleMismatchError,
  TaskAssignmentError,
  TaskPermissionError,
  DEFAULT_TASK_LEASE_MS,
} from './core/taskStore.js'

export type {
  CreateTaskParams,
  TaskListFilter,
  TaskStoreAdapter,
  TaskStoreConfig,
} from './core/taskStore.js'

export {
  TaskWorkerLoop,
  completeTaskReview,
  returnTaskForRevision,
} from './core/taskWorkerLoop.js'

export type {
  CompleteTaskReviewParams,
  ReturnTaskForRevisionParams,
  TaskExecutionContext,
  TaskExecutionResult,
  TaskWorkerLoopConfig,
  TaskWorkerLoopResult,
  TaskWorkerLoopStatus,
} from './core/taskWorkerLoop.js'

export {
  projectAgentTaskState,
  projectAllAgentTaskStates,
} from './core/taskProjection.js'

export type {
  AgentTaskProjection,
  AgentWorkState,
} from './core/taskProjection.js'

export { TaskTools } from './core/taskTools.js'
export {
  getStableAgentId,
  getStableAgentName,
  hasStableIdentity,
  getIdentityFilePath,
} from './core/agentIdentity.js'
export type {
  TaskCompleteToolParams,
  TaskCreateToolParams,
  TaskReviewToolParams,
  TaskReturnToolParams,
  TaskToolsConfig,
} from './core/taskTools.js'

// v4 Architecture: Cloud-First Team State Management
export { TeamProfileService, DuplicateTeamError, CreateTeamError } from './core/teamProfileService.js'
export * as runtimeRegistry from './core/runtimeRegistry.js'
export { LocalPreferenceStore } from './core/localPreference.js'

export {
  IdleNotificationMessage,
  PermissionRequestMessage,
  PermissionResponseMessage,
  ShutdownRequestMessage,
  ShutdownApprovedMessage,
  ShutdownRejectedMessage,
  PlanApprovalRequestMessage,
  PlanApprovalResponseMessage,
  TaskAssignmentMessage,
  TeamPermissionUpdateMessage,
  ModeSetRequestMessage,
  SandboxPermissionRequestMessage,
  SandboxPermissionResponseMessage,
  TaskAcknowledgedMessage,
  TaskClaimedMessage,
  TaskStatusUpdateMessage,
  TaskSubmittedForReviewMessage,
  TaskCompletedMessage,
  TaskFailedMessage,
  isStructuredProtocolMessage,
  looksLikeProtocolMessage,
  createIdleNotification,
  createPermissionResponse,
  createTaskAcknowledged,
  createTaskClaimed,
  createTaskStatusUpdate,
  createTaskSubmittedForReview,
  createTaskCompleted,
  createTaskFailed,
} from './core/messageTypes.js'

export type { OpenCodePluginContext, OpenCodePlugin } from './platform/open-code.js'

// ============================================================
// Cloud Collaboration (Multi-Machine Team Support)
// ============================================================

export { CloudInvitation } from './core/cloudInvitation.js'
export type { Invitation, CloudTeamInfo } from './core/cloudInvitation.js'

export { CloudKickManager } from './core/cloudKick.js'

export { CloudPlanApproval } from './core/cloudPlanApproval.js'
export type { PlanApprovalRequestPayload, PlanApprovalResponsePayload, PlanState } from './core/cloudPlanApproval.js'

export { CloudCodeReview } from './core/codeReview.js'
export type { CodeReviewSubmission, CodeReviewResponse, MergeRequest, MergeResponse, ReviewState } from './core/codeReview.js'

export { CloudPermissionBroadcast } from './core/cloudPermissionBroadcast.js'
export type { PermissionUpdatePayload } from './core/cloudPermissionBroadcast.js'

export { CloudPresence } from './core/cloudPresence.js'
export type { PresenceInfo, PresenceTaskProjectionProvider } from './core/cloudPresence.js'

export { CloudMessageRouter } from './core/cloudMessageRouter.js'
export type { CloudMessage, SSEFrame, StartListeningOptions } from './core/cloudMessageRouter.js'

export { MessageDispatcher } from './core/messageDispatcher.js'
export type { DispatcherConfig } from './core/messageDispatcher.js'

export { sendLifecycleNotification } from './core/lifecycleNotification.js'
export type {
  SendLifecycleNotificationParams,
  TaskLifecycleNotificationPayload,
} from './core/lifecycleNotification.js'

export { checkMessagePermission, getRequiredPermission } from './core/messagePermissions.js'
export type { PermissionCheckResult } from './core/messagePermissions.js'

export { GitSync } from './core/gitSync.js'
export type { GitState, SyncRequest as GitSyncRequest } from './core/gitSync.js'

export { SkillEvolution } from './core/skillEvolution.js'
export type { SkillEntry, SkillSyncRequest as SkillSyncRequestType } from './core/skillEvolution.js'

export { CloudVoting } from './core/cloudVoting.js'
export { VotingTools } from './core/cloudVotingTools.js'
export { VOTE_PASS_ACTIONS, VOTE_REJECT_ACTIONS, formatVoteReminder, onVoteResolved } from './core/voteWorkflow.js'
export type { VoteWorkflowContext } from './core/voteWorkflow.js'
export { ROLE_CAPABILITIES, getRolePrompt, getWorkMode, getRoleTools, getRoleGoal } from './core/roleCapabilities.js'
export type { RoleCapability } from './core/roleCapabilities.js'
export type {
  Vote, VoteType, VoteStatus, VoteThreshold,
  Ballot, RollbackInfo,
} from './core/cloudVotingTypes.js'

// ============================================================
// Kanban Board (Web-based Team Dashboard)
// ============================================================

export { startKanbanServer, extractTaskProjectionFromEntries } from './core/kanbanServer.js'
export type { KanbanMember, KanbanState } from './core/kanbanServer.js'

// ============================================================
// Auto-Initialization
//
// When this module is imported, it auto-detects the platform
// and initializes the appropriate plugin adapter.
// ============================================================

// Fallback: derive plugin root from current module location
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..')

async function autoInitialize(): Promise<void> {
  const isCC = process.env.CLAUDE_CODE_AGENT_ID || pluginRoot

  if (isCC) {
    const { initializeClaudeCodePlugin } = await import('./platform/claude-code.js')
    await initializeClaudeCodePlugin()
  }
  // For Open Code, the plugin is exported as `teamCollabPlugin`
  // and loaded by the Open Code plugin loader separately.
}

// Auto-initialize on import (non-blocking)
autoInitialize().catch(console.error)
