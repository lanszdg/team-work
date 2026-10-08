/**
 * Auto-Split Layout Engine — zelliz.md style
 *
 * Layout:
 * ┌──────────────┬─────────────────┐
 * │              │  Team Dashboard  │
 * │   Leader     │  (右上 - 只读TUI)│
 * │   (左侧 30%)  ├─────────────────┤
 * │              │  Teammate 1      │
 * │              ├─────────────────┤
 * │              │  Teammate 2      │
 * │              ├─────────────────┤
 * │              │  Teammate N...   │
 * └──────────────┴─────────────────┘
 *
 * Uses tmux to split the Leader's window into:
 *   1. Leader (left, 30%)
 *   2. Dashboard (right-top, reads team_state.json, polls every 2s)
 *   3. Teammates (right-bottom, one per teammate, split horizontally)
 */

import { readTeamFile, writeTeamFile, createTeam } from '../core/teamFile.js'
import * as runtimeRegistry from '../core/runtimeRegistry.js'
import { createTeammatePane, sendCommandToPane, killPane, getBackend, createDashboardPane, setPaneTitle, getDashboardPaneId, setDashboardPaneId, enablePaneBorderStatus, resetLayoutTracking } from '../backends/registry.js'
import type { TeamFile, BackendType, TeammateMode } from '../core/types.js'
import type { PaneBackend } from '../backends/types.js'
import { readTeamFileAsync, writeTeamFileAsync } from '../core/teamFile.js'
import { AGENT_COLORS, type AgentColorName } from '../platform/constants.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ============================================================
// P19: Dependency injection for backend factory
//
// The core layer should not depend directly on the backends layer (DDD).
// Callers can inject a BackendFactory via injectBackendFactory().
// When no factory is injected, the default implementation falls back
// to the direct registry imports (existing behavior, opt-in DI).
// ============================================================

/**
 * Factory interface for all backend operations needed by autoSplitLayout.
 * Allows the core layer to use backends without importing from backends/ directly.
 */
export interface BackendFactory {
  createTeammatePane(teammateName: string, teammateColor: AgentColorName, mode?: TeammateMode): Promise<{ paneId: string; isFirstTeammate: boolean }>
  sendCommandToPane(paneId: string, command: string): Promise<void>
  killPane(paneId: string): Promise<boolean>
  getBackend(): Promise<PaneBackend>
  createDashboardPane(): Promise<{ paneId: string } | null>
  setPaneTitle(paneId: string, title: string): Promise<void>
  getDashboardPaneId(): string | null
  setDashboardPaneId(paneId: string): void
  enablePaneBorderStatus(): Promise<void>
  resetLayoutTracking(): void
}

let _backendFactory: BackendFactory | null = null

/**
 * Opt-in: inject a custom BackendFactory to break the core→backends dependency.
 * Call this before running any layout operations.
 */
export function injectBackendFactory(factory: BackendFactory): void {
  _backendFactory = factory
}

/**
 * Returns the active BackendFactory — injected or default (direct registry imports).
 */
function bf(): BackendFactory {
  if (_backendFactory) return _backendFactory
  // Default: fall back to direct imports (preserves existing behavior)
  return {
    createTeammatePane,
    sendCommandToPane,
    killPane,
    getBackend,
    createDashboardPane,
    setPaneTitle,
    getDashboardPaneId,
    setDashboardPaneId,
    enablePaneBorderStatus,
    resetLayoutTracking,
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ============================================================
// Types
// ============================================================

export interface AutoSplitResult {
  /** Whether auto-split was performed */
  performed: boolean
  /** Number of panes created (dashboard + teammates) */
  panesCreated: number
  /** Dashboard pane ID */
  dashboardPaneId?: string
  /** Members that got panes */
  membersWithPanes: string[]
  /** Members that already had panes */
  membersExisting: string[]
  /** Errors encountered */
  errors: string[]
}

export interface AutoSplitConfig {
  /** Team name */
  teamName: string
  /** Leader agent ID */
  leadAgentId: string
  /** Whether to skip members that already have pane IDs */
  skipExisting: boolean
  /** Custom command template for launching teammate (default: 'claude') */
  teammateCommand?: string
  /** Whether to create the dashboard pane (default: true) */
  enableDashboard?: boolean
}

// ============================================================
// Core: Auto-split on plugin load
// ============================================================

/**
 * Automatically creates zelliz.md-style layout on plugin load.
 * Called from initializeClaudeCodePlugin() when running as Leader.
 *
 * Key design: Dashboard pane is created UNCONDITIONALLY so the user
 * always sees a split-screen workspace. Teammate panes are created
 * only if the team file exists and has members.
 */
export async function autoSplitLayout(config: AutoSplitConfig): Promise<AutoSplitResult> {
  const result: AutoSplitResult = {
    performed: false,
    panesCreated: 0,
    membersWithPanes: [],
    membersExisting: [],
    errors: [],
  }

  // Check if we're in a terminal-multiplexing environment.
  // In-process backend cannot create visible panes — skip silently.
  const backend = await bf().getBackend()
  if (backend.type === 'in-process') {
    console.log('[AutoSplit] Skipping layout split — running in in-process mode (no terminal available)')
    console.log('[AutoSplit] Tip: run inside tmux for automatic split-screen: tmux new-session -A -s claude-team')
    return result
  }

  // Enable pane border status so titles are visible
  await bf().enablePaneBorderStatus().catch(() => {})

  // Step 0: Auto-create team if not exists (P0-2 fix)
  let teamFile = readTeamFile(config.teamName)
  if (!teamFile) {
    const defaultTeamName = config.teamName || 'default-team'
    console.log(`[AutoSplit] Team "${defaultTeamName}" not found — auto-creating...`)
    teamFile = await createTeam({
      teamName: defaultTeamName,
      leadAgentId: config.leadAgentId,
      leadSessionId: process.env.CLAUDE_CODE_SESSION_ID,
      description: 'Auto-created team for multi-machine collaboration',
    })
    console.log(`[AutoSplit] Team "${defaultTeamName}" created with lead: ${config.leadAgentId}`)
  }

  // Step 1: ALWAYS create Dashboard pane (right side)
  // This ensures the user always gets a split-screen workspace
  if (config.enableDashboard !== false) {
    try {
      const dashResult = await bf().createDashboardPane()
      if (dashResult) {
        result.dashboardPaneId = dashResult.paneId
        bf().setDashboardPaneId(dashResult.paneId)

        // Launch the dashboard TUI in this pane
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
          ? process.env.CLAUDE_PLUGIN_ROOT
          : join(__dirname, '..', '..') // __dirname is dist/core/ → go up 2 levels to plugin root
        const dashPath = join(pluginRoot, 'dist', 'core', 'teamDashboard.js')
        const dashCmd = `cd "${pluginRoot}" && exec node "${dashPath}" ${config.teamName}`
        await bf().sendCommandToPane(dashResult.paneId, dashCmd)

        // Set pane title AFTER sending command to ensure persistence
        await bf().setPaneTitle(dashResult.paneId, 'Team Dashboard')

        result.panesCreated++
        console.log(`[AutoSplit] Created Dashboard pane — pane: ${dashResult.paneId}`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Failed to create Dashboard pane: ${msg}`)
      console.error('[AutoSplit] Dashboard pane error:', err)
    }
  }

  // Step 2: Use team file (already ensured to exist from Step 0), create teammate panes only if teammates exist
  if (teamFile) {
    const teammates = teamFile.members.filter(m => m.agentId !== config.leadAgentId)
    if (teammates.length === 0) {
      console.log(`[AutoSplit] Team "${config.teamName}" exists but has no teammates — Dashboard will show setup guide`)
    } else {
      console.log(`[AutoSplit] Found ${teammates.length} teammate(s) in team "${config.teamName}"`)
    }

    const cmd = config.teammateCommand || 'claude'

    // Collect pane ID updates for batched atomic write (P05 fix: race-condition-safe)
    const paneUpdates: Array<{ agentId: string; paneId: string }> = []

    for (const member of teammates) {
      try {
        if (config.skipExisting && member.tmuxPaneId && member.tmuxPaneId !== '') {
          result.membersExisting.push(member.name)
          console.log(`[AutoSplit] Skipping "${member.name}" — already has pane: ${member.tmuxPaneId}`)
          continue
        }

        const colorIndex = result.panesCreated % AGENT_COLORS.length
        const color = member.color || AGENT_COLORS[colorIndex]
        const paneResult = await bf().createTeammatePane(member.name, color as AgentColorName)

        // Launch Claude Code in the new pane with teammate env vars
        const launchCmd = buildTeammateLaunchCmd(cmd, {
          teamName: config.teamName,
          agentId: member.agentId,
          agentName: member.name,
          // Map BackendType → TeammateMode (iterm2 has no TeammateMode equivalent → fallback to auto)
          teammateMode: mapBackendToTeammateMode(member.backendType)
            || process.env.CLAUDE_CODE_TEAMMATE_MODE
            || 'auto',
        })

        await bf().sendCommandToPane(paneResult.paneId, launchCmd)

        // Set pane title AFTER sending command to ensure persistence
        await bf().setPaneTitle(paneResult.paneId, member.name)

        // Collect pane ID for batched atomic write (P05 fix)
        paneUpdates.push({ agentId: member.agentId, paneId: paneResult.paneId })

        result.membersWithPanes.push(member.name)
        result.panesCreated++

        console.log(`[AutoSplit] Created pane for "${member.name}" — pane: ${paneResult.paneId}`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        result.errors.push(`Failed to create pane for "${member.name}": ${msg}`)
        console.error(`[AutoSplit] Error for "${member.name}":`, err)
      }
    }

    // Batch-apply all pane ID updates in a single atomic write (P05 fix)
    if (paneUpdates.length > 0) {
      await applyBatchedPaneUpdates(config.teamName, paneUpdates, (msg: string) => {
        result.errors.push(msg)
      })
    }
  } else {
    console.log(`[AutoSplit] No team "${config.teamName}" — Dashboard will show setup guide`)
  }

  result.performed = result.panesCreated > 0
  return result
}

// ============================================================
// Helper: Build teammate launch command
// ============================================================

function buildTeammateLaunchCmd(
  baseCmd: string,
  env: {
    teamName: string
    agentId: string
    agentName: string
    teammateMode: string
  },
): string {
  const vars = [
    `CLAUDE_CODE_TEAM_NAME="${env.teamName}"`,
    `CLAUDE_CODE_AGENT_ID="${env.agentId}"`,
    `CLAUDE_CODE_AGENT_NAME="${env.agentName}"`,
    `CLAUDE_CODE_TEAMMATE_MODE="${env.teammateMode}"`,
    `TEAM_MEMORY_SYNC_URL="${process.env.TEAM_MEMORY_SYNC_URL || ''}"`,
    `TEAM_MEMORY_SYNC_API_KEY="${process.env.TEAM_MEMORY_SYNC_API_KEY || ''}"`,
    `CLAUDE_CODE_TEAM_DEV_ID="${process.env.CLAUDE_CODE_TEAM_DEV_ID || env.agentId}"`,
  ].join(' ')

  return `${vars} ${baseCmd}`
}

// ============================================================
// Helper: Map BackendType to TeammateMode
// ============================================================

/**
 * Maps BackendType to TeammateMode. 'iterm2' has no direct TeammateMode
 * equivalent (TeammateMode only covers 'auto'|'tmux'|'in-process'),
 * so it returns undefined for auto-detect fallback.
 */
function mapBackendToTeammateMode(bt?: BackendType): TeammateMode | undefined {
  if (bt === 'tmux') return 'tmux'
  if (bt === 'in-process') return 'in-process'
  return undefined
}

// ============================================================
// Helper: Batched member pane ID update (concurrency-safe)
// ============================================================

/**
 * Updates all member pane IDs in a single atomic write,
 * avoiding the read-modify-write race that individual
 * fire-and-forget updates would cause.
 */
async function applyBatchedPaneUpdates(
  teamName: string,
  paneUpdates: Array<{ agentId: string; paneId: string }>,
  onError?: (msg: string) => void,
): Promise<void> {
  if (paneUpdates.length === 0) return

  try {
    const tf = await readTeamFileAsync(teamName)
    if (!tf) return

    const updateMap = new Map(paneUpdates.map(u => [u.agentId, u.paneId]))
    for (const member of tf.members) {
      const newPaneId = updateMap.get(member.agentId)
      if (newPaneId) {
        member.tmuxPaneId = newPaneId
        // V4: Also update runtimeRegistry
        runtimeRegistry.setRuntime(member.agentId, {
          tmuxPaneId: newPaneId,
          cwd: member.cwd || process.cwd(),
          worktreePath: member.worktreePath,
          sessionId: member.sessionId,
          backendType: member.backendType || 'tmux',
        })
      }
    }

    await writeTeamFileAsync(teamName, tf)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[AutoSplit] Batched pane ID update failed: ${msg}`)
    if (onError) onError(msg)
  }
}

// ============================================================
// Helper: Rebuild layout from scratch
// ============================================================

export async function rebuildLayout(config: AutoSplitConfig): Promise<AutoSplitResult> {
  const teamFile = readTeamFile(config.teamName)
  if (!teamFile) {
    return {
      performed: false,
      panesCreated: 0,
      membersWithPanes: [],
      membersExisting: [],
      errors: ['Team file not found'],
    }
  }

  // Kill existing dashboard pane
  const existingDashId = bf().getDashboardPaneId()
  if (existingDashId) {
    await bf().killPane(existingDashId).catch(() => {})
  }

  // Kill existing teammate panes
  for (const member of teamFile.members) {
    if (member.agentId !== config.leadAgentId && member.tmuxPaneId) {
      await bf().killPane(member.tmuxPaneId).catch(() => {})
      member.tmuxPaneId = ''
      runtimeRegistry.removeRuntime(member.agentId)
    }
  }

  writeTeamFile(config.teamName, teamFile)

  // Reset layout tracking so the rebuild starts with a clean split state
  bf().resetLayoutTracking()

  return autoSplitLayout({ ...config, skipExisting: false })
}
