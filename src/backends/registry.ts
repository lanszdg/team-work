/**
 * Backend Detection and Registry
 *
 * Automatically detects the best available backend and provides
 * a registry for backend selection.
 *
 * Extracted from open-claude-code src/utils/swarm/backends/detection.ts + registry.ts
 */

import type { PaneBackend, BackendDetectionResult } from './types.js'
import type { BackendType, TeammateMode } from '../core/types.js'
import type { AgentColorName } from '../platform/constants.js'
import { TmuxBackend, resetLayoutState, getDashboardPaneId as _getDashPaneId, setDashboardPaneId as _setDashPaneId } from './tmux.js'
import { ITermBackend } from './iterm2.js'
import { InProcessBackend } from './inProcess.js'

/**
 * Registry of all available backends.
 */
const backendRegistry = new Map<BackendType, () => PaneBackend>()

/**
 * Cached detection result.
 */
let cachedResult: BackendDetectionResult | null = null

/**
 * Cached tmux backend singleton.
 *
 * CRITICAL: The factory registered below creates new TmuxBackend() instances
 * on every detectBackend() call. Even though tmux.ts has module-level state
 * (_globalTeammateCount), reusing the same instance avoids any edge cases
 * and keeps the backend lifecycle consistent.
 */
let _tmuxBackendSingleton: TmuxBackend | null = null

/**
 * Factory that returns a cached TmuxBackend singleton.
 */
function getTmuxBackend(): TmuxBackend {
  if (!_tmuxBackendSingleton) {
    _tmuxBackendSingleton = new TmuxBackend()
  }
  return _tmuxBackendSingleton
}

/**
 * Register a backend factory function.
 */
export function registerBackend(type: BackendType, factory: () => PaneBackend): void {
  backendRegistry.set(type, factory)
}

// Register built-in backends
registerBackend('tmux', () => getTmuxBackend())
registerBackend('iterm2', () => new ITermBackend())
registerBackend('in-process', () => new InProcessBackend())

/**
 * Checks if we're currently running inside a tmux session.
 */
async function isInsideTmux(): Promise<boolean> {
  return !!process.env.TMUX
}

/**
 * Detects the best available backend based on the current environment.
 *
 * Priority:
 * 1. If teammateMode is 'tmux' -> TmuxBackend
 * 2. If teammateMode is 'in-process' -> InProcessBackend
 * 3. If inside tmux -> TmuxBackend
 * 4. If iTerm2 available -> ITermBackend
 * 5. Fallback -> InProcessBackend
 */
export async function detectBackend(mode?: TeammateMode): Promise<BackendDetectionResult> {
  if (cachedResult) return cachedResult

  const resolvedMode = mode || process.env.CLAUDE_CODE_TEAMMATE_MODE || 'auto'

  // If mode is explicitly set, use that backend
  if (resolvedMode === 'tmux') {
    const backend = getTmuxBackend()
    if (await backend.isAvailable()) {
      cachedResult = { backend, type: 'tmux', isFirst: true }
      return cachedResult
    }
    throw new Error('tmux mode requested but tmux is not available')
  }

  if (resolvedMode === 'in-process') {
    const backend = new InProcessBackend()
    cachedResult = { backend, type: 'in-process', isFirst: true }
    return cachedResult
  }

  // Auto-detect: try tmux first (if inside tmux session)
  if (await isInsideTmux()) {
    const tmuxBackend = getTmuxBackend()
    if (await tmuxBackend.isAvailable()) {
      cachedResult = { backend: tmuxBackend, type: 'tmux', isFirst: true }
      return cachedResult
    }
  }

  // Try iTerm2
  const itermBackend = new ITermBackend()
  if (await itermBackend.isAvailable()) {
    cachedResult = { backend: itermBackend, type: 'iterm2', isFirst: true }
    return cachedResult
  }

  // Fallback to in-process
  const inProcessBackend = new InProcessBackend()
  cachedResult = { backend: inProcessBackend, type: 'in-process', isFirst: true }
  return cachedResult
}

/**
 * Gets the detected backend (cached).
 */
export async function getBackend(): Promise<PaneBackend> {
  const result = await detectBackend()
  return result.backend
}

/**
 * Clears the detection cache.
 * Useful when the environment changes (e.g., user enters/exits tmux).
 */
export function clearBackendCache(): void {
  cachedResult = null
  _tmuxBackendSingleton = null
  resetLayoutState()
}

/**
 * Creates a teammate pane using the detected backend.
 */
export async function createTeammatePane(
  teammateName: string,
  teammateColor: AgentColorName,
  mode?: TeammateMode,
): Promise<{ paneId: string; isFirstTeammate: boolean }> {
  const { backend } = await detectBackend(mode)
  return backend.createTeammatePaneInSwarmView(teammateName, teammateColor)
}

/**
 * Sends a command to a specific pane using the detected backend.
 */
export async function sendCommandToPane(
  paneId: string,
  command: string,
): Promise<void> {
  const { backend } = await detectBackend()
  return backend.sendCommandToPane(paneId, command)
}

/**
 * Kills a pane using the detected backend.
 */
export async function killPane(paneId: string): Promise<boolean> {
  const { backend } = await detectBackend()
  return backend.killPane(paneId)
}

/**
 * Enables pane border status (shows pane titles at the top).
 */
export async function enablePaneBorderStatus(): Promise<void> {
  const { backend } = await detectBackend()
  return backend.enablePaneBorderStatus()
}

/**
 * Creates a dashboard pane using the detected backend.
 * Only tmux backend supports this; others return null.
 */
export async function createDashboardPane(): Promise<{ paneId: string } | null> {
  const { backend, type } = await detectBackend()
  if (type === 'tmux' && backend instanceof TmuxBackend) {
    return backend.createDashboardPaneInSwarmView()
  }
  return null
}

/**
 * Sets the title of a pane using the detected backend.
 * Only tmux backend supports this.
 */
export async function setPaneTitle(paneId: string, title: string): Promise<void> {
  const { backend, type } = await detectBackend()
  if (type === 'tmux' && backend instanceof TmuxBackend) {
    return backend.setPaneTitle(paneId, title)
  }
}

/**
 * Gets the recorded dashboard pane ID.
 */
export function getDashboardPaneId(): string | null {
  return _getDashPaneId()
}

/**
 * Sets the recorded dashboard pane ID.
 */
export function setDashboardPaneId(paneId: string): void {
  _setDashPaneId(paneId)
}

/**
 * Resets layout tracking state. Called before rebuildLayout to ensure
 * clean slate when all right-side panes have been killed.
 */
export function resetLayoutTracking(): void {
  resetLayoutState()
}
