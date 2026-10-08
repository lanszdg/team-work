/**
 * Backend Type Definitions
 *
 * Abstract interface for teammate pane backends (tmux, iTerm2, in-process).
 * Each backend implements pane creation, command execution, and lifecycle management.
 *
 * Extracted from open-claude-code src/utils/swarm/backends/types.ts
 */

import type { AgentColorName } from '../platform/constants.js'
import type { BackendType } from '../core/types.js'

/**
 * Result of creating a teammate pane.
 */
export interface CreatePaneResult {
  /** The unique pane/session identifier */
  paneId: string
  /** Whether this is the first teammate being created (affects layout) */
  isFirstTeammate: boolean
}

/**
 * Abstract interface for a teammate pane backend.
 *
 * Implementations:
 * - TmuxBackend: Uses tmux split panes for terminal-based teamwork
 * - ITermBackend: Uses iTerm2 native split panes on macOS
 * - InProcessBackend: Uses AsyncLocalStorage for in-process isolation
 */
export interface PaneBackend {
  /** The backend type identifier */
  readonly type: BackendType

  /**
   * Creates a new teammate pane in the swarm view.
   *
   * When running INSIDE tmux:
   * - Splits the current window (leader left 30%, teammates right 70%)
   *
   * When running in iTerm2:
   * - Uses native iTerm2 split panes
   *
   * When running OUTSIDE tmux/iTerm2:
   * - Falls back to tmux with external session
   */
  createTeammatePaneInSwarmView(
    teammateName: string,
    teammateColor: AgentColorName,
  ): Promise<CreatePaneResult>

  /**
   * Sends a command string to a specific pane.
   */
  sendCommandToPane(
    paneId: string,
    command: string,
    useSwarmSocket?: boolean,
  ): Promise<void>

  /**
   * Enables pane border status (shows pane titles at the top).
   */
  enablePaneBorderStatus(
    windowTarget?: string,
    useSwarmSocket?: boolean,
  ): Promise<void>

  /**
   * Kills a pane by its ID.
   */
  killPane(paneId: string, useExternalSession?: boolean): Promise<boolean>

  /**
   * Checks if this backend is available in the current environment.
   */
  isAvailable(): Promise<boolean>

  /**
   * Cleans up any resources used by this backend.
   */
  cleanup?(): Promise<void>
}

/**
 * Backend detection result.
 */
export interface BackendDetectionResult {
  /** The detected backend */
  backend: PaneBackend
  /** The backend type */
  type: BackendType
  /** Whether this is the first time this backend is being used */
  isFirst: boolean
}
