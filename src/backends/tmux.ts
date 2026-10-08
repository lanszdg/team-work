/**
 * Tmux Backend Implementation
 *
 * Uses tmux split panes for terminal-based teammate execution.
 * Leader stays on left (30%), teammates on right (70%).
 *
 * Extracted from open-claude-code src/utils/swarm/backends/TmuxBackend.ts
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PaneBackend, CreatePaneResult } from './types.js'
import type { AgentColorName } from '../platform/constants.js'
import type { BackendType } from '../core/types.js'

const execAsync = promisify(execFile)

/**
 * Module-level singleton state for TmuxBackend.
 *
 * CRITICAL: The registry creates new TmuxBackend instances on every
 * detectBackend() call. Without shared state, _teammateCount resets
 * each time, causing every call to perform the "first split" (vertical)
 * instead of subsequent splits (horizontal). This module-scoped counter
 * ensures layout logic is correct regardless of how many instances exist.
 */
let _globalTeammateCount = 0

/**
 * Tracks which tmux session:window combinations have already received
 * the initial Leader-Dashboard split. Uses a Set to support multi-window
 * scenarios where each window needs its own first split.
 */
let _initialSplitWindows = new Set<string>()

/**
 * Tracks the right-side pane ID from the first horizontal split.
 * Used to target subsequent vertical splits to the right side area.
 */
let _rightSidePaneId: string | null = null

/**
 * Tracks the current dashboard pane ID for rebuild/cleanup.
 */
let _dashboardPaneId: string | null = null

/**
 * Builds a unique key for the current tmux session and window.
 * Format: "sessionName:windowIndex"
 */
async function getSplitWindowKey(): Promise<string> {
  try {
    const { stdout } = await execAsync('tmux', [
      'display-message', '-p', '#{session_name}:#{window_index}'
    ])
    return stdout.trim()
  } catch {
    // Fallback: use TMUX env var to derive a unique key
    return process.env.TMUX || 'unknown'
  }
}

/**
 * Resets all module-level layout state.
 * Called when the environment changes (e.g., user exits tmux and re-enters).
 */
export function resetLayoutState(): void {
  _globalTeammateCount = 0
  _initialSplitWindows.clear()
  _dashboardPaneId = null
  _rightSidePaneId = null
}

/**
 * Gets the current dashboard pane ID.
 */
export function getDashboardPaneId(): string | null {
  return _dashboardPaneId
}

/**
 * Sets the dashboard pane ID.
 */
export function setDashboardPaneId(paneId: string): void {
  _dashboardPaneId = paneId
}

/**
 * TmuxBackend manages teammate panes using tmux window splits.
 */
export class TmuxBackend implements PaneBackend {
  readonly type: BackendType = 'tmux'

  private _socketName: string | null = null

  constructor(socketName?: string) {
    this._socketName = socketName || null
  }

  /**
   * Gets the tmux socket name, defaulting to 'claude-swarm' for external sessions.
   */
  private getSocketName(): string {
    if (this._socketName) return this._socketName
    // If running inside tmux, use the current socket
    if (process.env.TMUX) return ''
    return 'claude-swarm'
  }

  /**
   * Builds the tmux command prefix with socket option if needed.
   */
  private tmuxArgs(): string[] {
    const socket = this.getSocketName()
    return socket ? ['-L', socket] : []
  }

  /**
   * Executes a tmux command and returns stdout.
   */
  private async execTmux(args: string[]): Promise<string> {
    const { stdout } = await execAsync('tmux', [...this.tmuxArgs(), ...args])
    return stdout.trim()
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('tmux', [...this.tmuxArgs(), 'display-message', '-p', '#{session_name}'])
      return true
    } catch {
      return false
    }
  }

  async createTeammatePaneInSwarmView(
    teammateName: string,
    _teammateColor: AgentColorName,
  ): Promise<CreatePaneResult> {
    _globalTeammateCount++
    const isFirst = _globalTeammateCount === 1

    // Determine the current window to apply per-window split tracking
    const windowKey = await getSplitWindowKey()
    const windowAlreadySplit = _initialSplitWindows.has(windowKey)

    let newPaneId: string | null = null

    if (isFirst && !windowAlreadySplit) {
      // First call: split the window horizontally (leader left 30%, right side 70%)
      // The right side will hold the Dashboard and teammate panes.
      newPaneId = await this.execTmux([
        'split-window',
        '-h',
        '-l', '70%',
        '-P',
        '-F', '#{pane_id}',
      ])
      // P12: Validate that split-window actually returned a pane ID before flagging
      if (!newPaneId) {
        throw new Error(
          'tmux split-window succeeded but returned no pane ID. ' +
          'The tmux state may be inconsistent — pane was created but not tracked.'
        )
      }
      _initialSplitWindows.add(windowKey)
      // Track the right-side pane for subsequent vertical splits
      _rightSidePaneId = newPaneId
    } else {
      // P12: Guard against missing right-side pane — prevents passing '-t ""' to tmux
      if (!_rightSidePaneId) {
        throw new Error(
          'Cannot create teammate pane: no right-side pane is available for vertical split. ' +
          'Ensure createDashboardPaneInSwarmView() or an initial teammate pane was created first.'
        )
      }
      // Subsequent calls: split the right-side pane vertically (stack panes)
      newPaneId = await this.execTmux([
        'split-window',
        '-v',
        '-t', _rightSidePaneId,
        '-P',
        '-F', '#{pane_id}',
      ])
      // Update the right-side tracker to the newly created pane
      if (newPaneId) _rightSidePaneId = newPaneId
    }

    // Use the captured pane ID from split-window output
    const paneId = newPaneId || await this.execTmux(['display-message', '-p', '#{pane_id}'])

    return { paneId, isFirstTeammate: isFirst }
  }

  async sendCommandToPane(paneId: string, command: string): Promise<void> {
    // Use send-keys to type the command into the pane
    // Use -- to prevent command content from being interpreted as tmux flags
    await this.execTmux(['send-keys', '-t', paneId, '--', command, 'Enter'])
  }

  async enablePaneBorderStatus(
    _windowTarget?: string,
    _useSwarmSocket?: boolean,
  ): Promise<void> {
    // Set pane-border-status to show titles
    await this.execTmux(['set-option', '-g', 'pane-border-status', 'top'])
  }

  /**
   * Creates a dashboard pane in the swarm view.
   *
   * Unlike createTeammatePaneInSwarmView, this does NOT increment
   * _globalTeammateCount. It handles the initial horizontal split
   * (leader left 30% | right 70%). The right pane becomes the
   * dashboard — occupying the entire right side initially.
   *
   * When teammates are later created via createTeammatePaneInSwarmView,
   * the -v split pushes the dashboard upward, creating the layout:
   *   Leader(left 30%) | Dashboard(top-right)
   *                    | Teammate1(bottom-right)
   *                    | Teammate2(bottom-right)...
   *
   * If the window was already split (dashboard called twice, or another
   * dashboard existed), just reuse the existing right-side pane without
   * additional splitting.
   */
  async createDashboardPaneInSwarmView(): Promise<{ paneId: string }> {
    const windowKey = await getSplitWindowKey()
    const windowAlreadySplit = _initialSplitWindows.has(windowKey)

    let newPaneId: string | null = null

    if (!windowAlreadySplit) {
      // Create the initial horizontal split: leader left 30%, right side 70%
      // The new right-side pane becomes the dashboard pane.
      newPaneId = await this.execTmux([
        'split-window',
        '-h',
        '-l', '70%',
        '-P',
        '-F', '#{pane_id}',
      ])
      // P12: Validate that split-window actually returned a pane ID before flagging
      if (!newPaneId) {
        throw new Error(
          'Dashboard split-window succeeded but returned no pane ID. ' +
          'The tmux state may be inconsistent — pane was created but not tracked.'
        )
      }
      _initialSplitWindows.add(windowKey)
      // Track the right-side pane for subsequent teammate vertical splits
      _rightSidePaneId = newPaneId
    }
    // If already split, the dashboard reuses the existing right-side pane.
    // No additional split needed — teammate splits will push dashboard upward.

    // Use the captured pane ID from split-window output
    const paneId = newPaneId || await this.execTmux(['display-message', '-p', '#{pane_id}'])

    return { paneId }
  }

  /**
   * Sets the title of a tmux pane.
   * The title appears in the pane border when pane-border-status is 'top'.
   */
  async setPaneTitle(paneId: string, title: string): Promise<void> {
    await this.execTmux(['select-pane', '-T', title, '-t', paneId])
  }

  async killPane(paneId: string, _useExternalSession?: boolean): Promise<boolean> {
    try {
      await this.execTmux(['kill-pane', '-t', paneId])
      _globalTeammateCount = Math.max(0, _globalTeammateCount - 1)
      return true
    } catch {
      return false
    }
  }
}
