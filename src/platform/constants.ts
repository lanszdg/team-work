/**
 * Shared Constants for Team Collaboration Plugin
 *
 * Centralized constants used across core, platform adapters, and hooks.
 */

// ============================================================
// Team Constants
// ============================================================

/** The reserved name for the team leader agent */
export const TEAM_LEAD_NAME = 'team-lead'

/** Default team name when none is specified */
export const DEFAULT_TEAM_NAME = 'default'

// ============================================================
// Color Palette
// ============================================================

/**
 * Available colors for teammate identification in the UI.
 * Assigned in round-robin order.
 */
export const AGENT_COLORS = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'cyan',
  'magenta',
] as const

export type AgentColorName = (typeof AGENT_COLORS)[number]

/**
 * Round-robin color assignment tracker.
 */
const colorAssignments = new Map<string, AgentColorName>()
let colorIndex = 0

/**
 * Assigns a unique color to a teammate.
 */
export function assignTeammateColor(teammateId: string): AgentColorName {
  const existing = colorAssignments.get(teammateId)
  if (existing) return existing

  const color = AGENT_COLORS[colorIndex % AGENT_COLORS.length]!
  colorAssignments.set(teammateId, color)
  colorIndex++
  return color
}

/**
 * Gets the assigned color for a teammate.
 */
export function getTeammateColor(teammateId: string): AgentColorName | undefined {
  return colorAssignments.get(teammateId)
}

/**
 * Clears all color assignments. Called during team cleanup.
 */
export function clearTeammateColors(): void {
  colorAssignments.clear()
  colorIndex = 0
}

// ============================================================
// Environment Variable Names
// ============================================================

export const ENV = {
  TEAM_NAME: 'CLAUDE_CODE_TEAM_NAME',
  AGENT_ID: 'CLAUDE_CODE_AGENT_ID',
  AGENT_NAME: 'CLAUDE_CODE_AGENT_NAME',
  AGENT_COLOR: 'CLAUDE_CODE_AGENT_COLOR',
  COORDINATOR_MODE: 'CLAUDE_CODE_COORDINATOR_MODE',
  TEAMMATE_MODE: 'CLAUDE_CODE_TEAMMATE_MODE',
  PLUGIN_ROOT: 'CLAUDE_PLUGIN_ROOT',
  PLUGIN_DATA: 'CLAUDE_PLUGIN_DATA',
  HOME: 'HOME',
  USERPROFILE: 'USERPROFILE',
} as const

// ============================================================
// Directory Paths
// ============================================================

/** Default subdirectories within the teams directory */
export const TEAM_SUBDIRS = {
  worktrees: 'worktrees',
} as const

/** Configuration file name within each team directory */
export const TEAM_CONFIG_FILE = 'config.json'

// ============================================================
// Tool Names
// ============================================================

/** Tool name for spawning agents */
export const AGENT_TOOL_NAME = 'Agent'

/** Tool name for sending messages to existing agents */
export const SEND_MESSAGE_TOOL_NAME = 'SendMessage'

/** Tool name for stopping a running agent */
export const TASK_STOP_TOOL_NAME = 'TaskStop'

/** Tool name for creating teams */
export const TEAM_CREATE_TOOL_NAME = 'TeamCreate'

/** Tool name for deleting teams */
export const TEAM_DELETE_TOOL_NAME = 'TeamDelete'

/** Tool name for editing files */
export const FILE_EDIT_TOOL_NAME = 'Edit'

/** Tool name for writing files */
export const FILE_WRITE_TOOL_NAME = 'Write'

/** Tool name for reading files */
export const FILE_READ_TOOL_NAME = 'Read'

/** Tool name for bash execution */
export const BASH_TOOL_NAME = 'Bash'

// ============================================================
// XML Tags
// ============================================================

/** XML tag wrapper for teammate messages */
export const TEAMMATE_MESSAGE_TAG = 'teammate-message'

/** XML tag for task notifications from workers */
export const TASK_NOTIFICATION_TAG = 'task-notification'

// ============================================================
// Timing Constants
// ============================================================

/** Default debounce time for monitor script (ms) */
export const DEFAULT_DEBOUNCE_MS = 5000

/** Default max events per window before triggering output */
export const DEFAULT_MAX_EVENTS_PER_WINDOW = 3

/** Default inbox poll interval (ms) */
export const DEFAULT_POLL_INTERVAL_MS = 1000

/** Timeout for lock acquisition (ms) */
export const LOCK_TIMEOUT_MS = 5000

// ============================================================
// L2 Sync API Endpoints
// ============================================================

export const SYNC_ENDPOINTS = {
  push: '/api/team_memory/push',
  pull: '/api/team_memory/pull',
  sync: '/api/team_memory/sync',
  status: '/api/team_memory/status',
  conflicts: '/api/team_memory/conflicts',
} as const
