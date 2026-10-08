/**
 * In-Process Backend Implementation
 *
 * Executes teammates within the same Node.js process using
 * AsyncLocalStorage for context isolation. No terminal required.
 *
 * Extracted from open-claude-code src/utils/swarm/backends/InProcessBackend.ts
 */

import { AsyncLocalStorage } from 'async_hooks'
import { v4 as uuidv4 } from 'uuid'
import type { PaneBackend, CreatePaneResult } from './types.js'
import type { AgentColorName } from '../platform/constants.js'
import type { BackendType } from '../core/types.js'

/**
 * Context stored in AsyncLocalStorage for each in-process teammate.
 */
export interface InProcessContext {
  agentId: string
  agentName: string
  teamName: string
  color: AgentColorName
  cwd: string
}

/**
 * Global AsyncLocalStorage instance for teammate context isolation.
 */
export const teammateContextStorage = new AsyncLocalStorage<InProcessContext>()

/**
 * Runs a function within the context of a specific teammate.
 * All async calls within the function can access the teammate's context.
 */
export function runInTeammateContext<T>(
  context: InProcessContext,
  fn: () => Promise<T>,
): Promise<T> {
  return teammateContextStorage.run(context, fn)
}

/**
 * Gets the current teammate context.
 * Returns null if not running within a teammate context.
 */
export function getCurrentTeammateContext(): InProcessContext | null {
  return teammateContextStorage.getStore() || null
}

/**
 * InProcessBackend manages teammates within the same Node.js process.
 * Uses AsyncLocalStorage for context isolation between concurrent teammates.
 */
export class InProcessBackend implements PaneBackend {
  readonly type: BackendType = 'in-process'

  private _teammateCount = 0
  private _panes = new Map<string, InProcessContext>()

  async isAvailable(): Promise<boolean> {
    // In-process backend is always available
    return true
  }

  async createTeammatePaneInSwarmView(
    teammateName: string,
    teammateColor: AgentColorName,
  ): Promise<CreatePaneResult> {
    this._teammateCount++
    const isFirst = this._teammateCount === 1

    const agentId = `${teammateName}@${process.env.CLAUDE_CODE_TEAM_NAME || 'default'}`
    const context: InProcessContext = {
      agentId,
      agentName: teammateName,
      teamName: process.env.CLAUDE_CODE_TEAM_NAME || 'default',
      color: teammateColor,
      cwd: process.cwd(),
    }

    // Generate a pseudo-pane ID for tracking
    const paneId = `inprocess-${uuidv4().slice(0, 8)}`
    this._panes.set(paneId, context)

    return { paneId, isFirstTeammate: isFirst }
  }

  async sendCommandToPane(paneId: string, command: string): Promise<void> {
    const context = this._panes.get(paneId)
    if (!context) {
      throw new Error(`[InProcessBackend] Pane ${paneId} not found`)
    }

    // Execute the command within the teammate's context.
    // Use spawn with detached mode for long-running processes (like dashboards)
    // so we don't block waiting for them to finish.
    await runInTeammateContext(context, async () => {
      const { spawn } = await import('child_process')
      const child = spawn(command, {
        cwd: context.cwd,
        shell: true,
        stdio: 'inherit',
        detached: true,
      })
      child.unref()
    })
  }

  async enablePaneBorderStatus(): Promise<void> {
    // No-op for in-process backend (no terminal UI)
  }

  async killPane(paneId: string): Promise<boolean> {
    const existed = this._panes.delete(paneId)
    return existed
  }

  /**
   * Gets the context for a pane ID.
   */
  getPaneContext(paneId: string): InProcessContext | undefined {
    return this._panes.get(paneId)
  }

  /**
   * Lists all active in-process teammates.
   */
  listActiveTeammates(): Map<string, InProcessContext> {
    return new Map(this._panes)
  }
}
