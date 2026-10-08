/**
 * Core Type Definitions for Team Collaboration Plugin
 *
 * Extracted from open-claude-code source code.
 * Covers all types needed for L1 Agent Swarms + L2 Team Memory Sync.
 */

// ============================================================
// Backend Types
// ============================================================

/**
 * The backend execution environment for a teammate pane.
 * - 'tmux': Terminal multiplexer split panes
 * - 'iterm2': Native iTerm2 split panes on macOS
 * - 'in-process': In-process execution using AsyncLocalStorage for isolation
 */
export type BackendType = 'tmux' | 'iterm2' | 'in-process'

/**
 * Teammate mode for pane-based execution environments.
 * - 'auto': Automatically detect and select the best backend
 * - 'tmux': Force tmux backend
 * - 'in-process': Force in-process execution
 */
export type TeammateMode = 'auto' | 'tmux' | 'in-process'

/**
 * Permission mode for a teammate session.
 * Controls how tool use permissions are handled.
 */
export type PermissionMode = 'auto' | 'yolo' | 'acceptEdits' | 'plan' | 'default'

// ============================================================
// Team File Types
// ============================================================

/**
 * A team-wide allowed path rule that grants permission
 * for a specific tool to operate in a specific directory.
 */
export interface TeamAllowedPath {
  /** Directory path (can be absolute or relative) */
  path: string
  /** The tool this rule applies to (e.g., "Edit", "Write", "Bash") */
  toolName: string
  /** Name of the agent who added this rule */
  addedBy: string
  /** Timestamp when this rule was added (epoch ms) */
  addedAt: number
}

/**
 * Fixed team role. Replaces the old free-form agentType field.
 * @since v3.6 Phase 2
 */
export type TeamRole =
  | 'tech-lead'
  | 'product-manager'
  | 'architect'
  | 'developer'
  | 'qa-engineer'
  | 'ops-engineer'
  | 'designer'

/** Role-based permission flags. */
export interface RolePermissions {
  canCreateTask: boolean
  canDecomposeTask: boolean
  canInitiateVote: boolean
  canExecuteTask: boolean
  canReviewCode: boolean
  /** Accept/reject a task at the TaskStore fact-source layer. */
  canCompleteTask: boolean
  canApproveRelease: boolean
  canManageTeam: boolean
}

/** Role → permissions lookup table. */
export const ROLE_PERMISSIONS: Record<TeamRole, RolePermissions> = {
  'tech-lead': {
    canCreateTask: true, canDecomposeTask: true, canInitiateVote: true,
    canExecuteTask: true, canReviewCode: true, canCompleteTask: true, canApproveRelease: true,
    canManageTeam: true,
  },
  'product-manager': {
    canCreateTask: true, canDecomposeTask: true, canInitiateVote: true,
    canExecuteTask: false, canReviewCode: false, canCompleteTask: true, canApproveRelease: false,
    canManageTeam: false,
  },
  'architect': {
    canCreateTask: false, canDecomposeTask: true, canInitiateVote: true,
    canExecuteTask: true, canReviewCode: true, canCompleteTask: true, canApproveRelease: true,
    canManageTeam: false,
  },
  'developer': {
    canCreateTask: false, canDecomposeTask: false, canInitiateVote: false,
    canExecuteTask: true, canReviewCode: true, canCompleteTask: false, canApproveRelease: false,
    canManageTeam: false,
  },
  'qa-engineer': {
    canCreateTask: false, canDecomposeTask: false, canInitiateVote: true,
    canExecuteTask: true, canReviewCode: true, canCompleteTask: true, canApproveRelease: false,
    canManageTeam: false,
  },
  'ops-engineer': {
    canCreateTask: false, canDecomposeTask: false, canInitiateVote: false,
    canExecuteTask: false, canReviewCode: false, canCompleteTask: false, canApproveRelease: true,
    canManageTeam: false,
  },
  'designer': {
    canCreateTask: false, canDecomposeTask: false, canInitiateVote: false,
    canExecuteTask: true, canReviewCode: true, canCompleteTask: false, canApproveRelease: false,
    canManageTeam: false,
  },
}

// ============================================================
// Agent Team Task Orchestration Types
// ============================================================

/** Lifecycle status for TaskStore-backed agent team tasks. */
export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'failed'
  | 'blocked'

/** A concrete task artifact produced by a worker. */
export interface TaskArtifact {
  type: 'file' | 'branch' | 'commit' | 'url'
  value: string
  description?: string
}

/**
 * TaskStore task model.
 *
 * Stored only in `{teamName}__tasks/task_store/{taskId}`. It is the
 * authoritative task-state fact source; message and presence layers may only
 * project from it.
 */
export interface TeamTask {
  taskId: string
  title: string
  description: string
  status: TaskStatus
  dependencies: string[]
  expectedOutput?: string
  acceptanceCriteria?: string[]
  requiredRole?: TeamRole
  assignedToAgentId?: string
  createdByAgentId: string
  createdByAgentName?: string
  claimedByAgentId?: string
  claimedByAgentName?: string
  leaseExpiresAt?: string
  artifacts: TaskArtifact[]
  createdAt: string
  updatedAt: string
  completedAt?: string
  completedByAgentId?: string
  completedByAgentName?: string
  failureReason?: string
  revisionReason?: string
}

/**
 * Represents a member of a team in the team config file.
 * Stored in ~/.claude/teams/{team-name}/config.json
 *
 * @since v3.6 — agentType replaced by required role; runtime fields nested.
 */
export interface TeamMember {
  // === Persistent fields (synced to cloud) ===
  /** Unique agent identifier (format: "{agentName}@{teamName}") */
  agentId: string
  /** Human-readable name of the agent */
  name: string
  /** Fixed team role (replaces optional agentType) */
  role: TeamRole
  /** @deprecated Legacy agent type — use role instead */
  agentType?: string
  /** Model assigned to this agent (e.g., "opus", "sonnet") */
  model?: string
  /** System prompt or task instructions for this agent */
  prompt?: string
  /** Assigned display color (e.g., 'red', 'blue', 'green') */
  color?: string
  /** Whether this agent requires plan mode */
  planModeRequired?: boolean
  /** Timestamp when the member joined the team (epoch ms) */
  joinedAt: number
  /** Event subscriptions for this agent */
  subscriptions: string[]

  // === Runtime fields (local only, kept flat for backward compat) ===
  /** @deprecated Use runtime.tmuxPaneId instead */
  tmuxPaneId?: string
  /** @deprecated Use runtime.cwd instead */
  cwd?: string
  /** @deprecated Use runtime.worktreePath instead */
  worktreePath?: string
  /** @deprecated Use runtime.sessionId instead */
  sessionId?: string
  /** @deprecated Use runtime.isActive instead */
  isActive?: boolean
  /** @deprecated Use runtime.backendType instead */
  backendType?: BackendType
  /** @deprecated Use runtime.mode instead */
  mode?: PermissionMode
  /** Runtime-only state that is filtered before cloud push. */
  runtime?: {
    tmuxPaneId?: string
    cwd?: string
    worktreePath?: string
    sessionId?: string
    isActive?: boolean
    backendType?: BackendType
    mode?: PermissionMode
  }
}

/**
 * The team configuration file structure.
 * Persists in ~/.claude/teams/{team-name}/config.json
 */
export interface TeamFile {
  /** Team display name */
  name: string
  /** Team description/purpose */
  description?: string
  /** Timestamp when the team was created (epoch ms) */
  createdAt: number
  /** Agent ID of the team leader */
  leadAgentId: string
  /** Actual session UUID of the leader (for discovery purposes) */
  leadSessionId?: string
  /** V5-6: Per-team cloud sync server URL (overrides env var TEAM_MEMORY_SYNC_URL) */
  syncUrl?: string
  /** Pane IDs that are currently hidden from the swarm UI view */
  hiddenPaneIds?: string[]
  /** Directory paths that all teammates can edit without asking for permission */
  teamAllowedPaths?: TeamAllowedPath[]
  /** List of all team members (including the leader as 'team-lead') */
  members: TeamMember[]
  /** C20: Monotonic version counter for cloud state conflict detection */
  version?: number
}

// ============================================================
// Cloud-First Team State Types (v4 Architecture)
// ============================================================

/**
 * Layer 1: Cloud team member profile — the single source of truth.
 * Stored in cloud KV `team_state.members[]`.
 * No runtime fields, no presence fields.
 */
export interface TeamMemberProfile {
  agentId: string
  name: string
  role: TeamRole
  model?: string
  prompt?: string
  color?: string
  joinedAt: number
  subscriptions: string[]
  /** @deprecated Legacy agent type — use role instead */
  agentType?: string
}

/**
 * Layer 2: Cloud team policy — shared across machines.
 * Stored in cloud KV `team_state.policy`.
 */
export interface TeamPolicy {
  /** Per-member permission mode (agentId → mode) */
  memberModes: Record<string, PermissionMode>
  /** Team-wide allowed paths */
  allowedPaths: TeamAllowedPath[]
  /** Join policy: open = auto-join, invite-only = requires invitation */
  joinPolicy: 'open' | 'invite-only'
}

/**
 * Complete cloud team state — the authoritative structure in cloud KV.
 * Written/read atomically via TeamProfileService.mutate().
 */
export interface CloudTeamState {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  syncUrl?: string
  members: TeamMemberProfile[]
  policy: TeamPolicy
  /** Monotonic version counter for conflict detection */
  version: number
}

/**
 * Layer 3: Cloud presence state per agent.
 * Stored in cloud KV `presence/{agentId}`.
 * Managed by CloudPresence heartbeat.
 */
export interface TeamMemberPresence {
  agentId: string
  isActive: boolean
  lastHeartbeat: string  // ISO timestamp
  hostname: string
  role: TeamRole
  workState?: 'idle' | 'claimed' | 'in_progress' | 'review'
  currentTaskId?: string
  currentTaskTitle?: string
}

/**
 * Layer 4a: Local runtime state — process memory only, never persisted to cloud.
 * Managed by runtimeRegistry.
 */
export interface LocalRuntime {
  tmuxPaneId: string
  cwd: string
  worktreePath?: string
  sessionId?: string
  backendType: BackendType
}

/**
 * Layer 4b: Local UI preferences — persisted locally, never pushed to cloud.
 * Managed by LocalPreferenceStore.
 */
export interface LocalPreference {
  hiddenPaneIds: string[]
}

/**
 * Composite view combining all layers — used by Dashboard and teamDiscovery.
 */
export interface TeamMemberView {
  profile: TeamMemberProfile
  mode?: PermissionMode
  presence?: TeamMemberPresence
  local?: LocalRuntime
}

// ============================================================
// Status & Discovery Types
// ============================================================

/**
 * Summary of a team's overall status.
 */
export interface TeamSummary {
  /** Team name */
  name: string
  /** Total number of members (excluding team-lead) */
  memberCount: number
  /** Number of currently active/running members */
  runningCount: number
  /** Number of currently idle members */
  idleCount: number
}

/**
 * Detailed status of an individual teammate.
 */
export interface TeammateStatus {
  /** Human-readable name */
  name: string
  /** Unique agent ID */
  agentId: string
  /** Fixed team role (v3.6) */
  role?: TeamRole
  /** @deprecated Legacy agent type — use role instead */
  agentType?: string
  /** Model being used */
  model?: string
  /** Task prompt/instructions */
  prompt?: string
  /** Current activity status */
  status: 'running' | 'idle' | 'unknown'
  /** Assigned display color */
  color?: string
  /** ISO timestamp when the agent became idle */
  idleSince?: string
  /** Terminal pane ID (tmux/iTerm2) */
  tmuxPaneId: string
  /** Current working directory */
  cwd: string
  /** Git worktree path (if enabled) */
  worktreePath?: string
  /** Whether the pane is currently hidden from swarm view */
  isHidden?: boolean
  /** Backend type for this teammate */
  backendType?: BackendType
  /** Current permission mode */
  mode?: PermissionMode
}

// ============================================================
// Cloud Discovery Types (multi-machine)
// ============================================================

/** A team discovered from the cloud __teams__ registry. */
export interface DiscoveredTeam {
  name: string
  description: string
  leadAgentId: string
  leadAgentName: string
  memberCount: number
  createdAt: string
}

/** An invitation pending for the current agent. */
export interface InvitationInfo {
  id: string
  teamName: string
  fromAgentId: string
  fromAgentName: string
  toAgentId: string
  toAgentName: string
  message: string
  status: 'pending' | 'accepted' | 'declined'
  createdAt: string
}

/** Result of a cloud discovery scan. */
export interface CloudDiscoveryResult {
  discovered: DiscoveredTeam[]
  invited: InvitationInfo[]
}

// ============================================================
// Cloud Message Types
// ============================================================

/**
 * A message exchanged between teammates via cloud messaging.
 */
export interface TeammateMessage {
  /** Sender's agent name */
  from: string
  /** Message content (text or structured JSON string) */
  text: string
  /** ISO timestamp when the message was sent */
  timestamp: string
  /** Whether the message has been read */
  read: boolean
  /** Sender's assigned color for UI display */
  color?: string
  /** 5-10 word preview summary shown in the UI */
  summary?: string
}


// ============================================================
// L2 Team Memory Sync Types
// ============================================================

/**
 * A single team memory entry synced to the cloud.
 */
export interface TeamMemoryEntry {
  /** Unique entry ID (UUID) */
  id: string
  /** Team name this entry belongs to */
  teamName: string
  /** Agent name who created this entry */
  agentName: string
  /** Memory content/key */
  key: string
  /** Memory value (text) */
  value: string
  /** ISO timestamp of last update */
  updatedAt: string
  /** Entry version for conflict resolution */
  version: number
}

/**
 * Sync direction for team memory operations.
 */
export type SyncDirection = 'push' | 'pull' | 'bidirectional'

/**
 * Configuration for the L2 Team Memory Sync module.
 */
export interface TeamMemorySyncConfig {
  /** Cloud API base URL */
  apiUrl: string
  /** Authentication token for the sync API */
  authToken: string
  /** How often to auto-sync (ms). 0 = manual only. */
  syncIntervalMs: number
  /** Whether to enable the file watcher for auto-sync */
  enableWatcher: boolean
  /** Debounce time for watcher-triggered syncs (ms) */
  watcherDebounceMs: number
  /** Sync direction */
  direction: SyncDirection
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  /** Number of entries pushed to the cloud */
  pushed: number
  /** Number of entries pulled from the cloud */
  pulled: number
  /** Number of conflicts detected */
  conflicts: number
  /** ISO timestamp when the sync completed */
  syncedAt: string
}

/**
 * Conflict resolution strategy.
 */
export type ConflictStrategy = 'local-wins' | 'remote-wins' | 'newest-wins' | 'manual'
