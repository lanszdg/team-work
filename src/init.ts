/**
 * Unified Plugin Initialization — T1.5
 *
 * Single entry point that activates all team-collab modules.
 * Call once from SessionStart hook. Eliminates the 4-attempt loading chaos.
 *
 * User perspective: Start Claude Code → team-collab auto-activates.
 * Zero manual steps for Worker. Discovery, heartbeat, task polling: all automatic.
 */

import { initializeClaudeCodePlugin } from './platform/claude-code.js'

let _initialized = false

/**
 * Initialize team-collab plugin. Idempotent — safe to call multiple times.
 * Returns true on first init, false on subsequent calls.
 */
export async function initTeamCollab(): Promise<boolean> {
  if (_initialized) {
    console.log('[TeamCollab] Already initialized — skipping')
    return false
  }

  console.log('[TeamCollab] Unified initialization starting...')
  try {
    await initializeClaudeCodePlugin()
    _initialized = true
    console.log('[TeamCollab] ✅ All modules activated (discovery, heartbeat, tasks, SSE)')
    return true
  } catch (err) {
    console.error('[TeamCollab] ❌ Initialization failed:',
      err instanceof Error ? err.message : String(err))
    return false
  }
}

/** Check if plugin has been initialized */
export function isInitialized(): boolean {
  return _initialized
}
