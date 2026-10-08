/**
 * RuntimeRegistry — Local Runtime State (v4 Architecture, Layer 4a)
 *
 * In-memory registry for local execution state (paneId, cwd, backend, etc.).
 * Never persisted to cloud. Never written to team config file.
 *
 * On process restart, state is recovered by scanning live panes
 * via recoverFromBackend() rather than reading stale files.
 */

import type { LocalRuntime, BackendType } from './types.js'

// ============================================================
// Module-level singleton Map
// ============================================================

const runtimes = new Map<string, LocalRuntime>()

// ============================================================
// Write Operations
// ============================================================

export function setRuntime(agentId: string, rt: LocalRuntime): void {
  runtimes.set(agentId, rt)
}

export function removeRuntime(agentId: string): void {
  runtimes.delete(agentId)
}

export function clearAll(): void {
  runtimes.clear()
}

/**
 * Update a single field of an existing runtime entry.
 * No-op if the agent has no runtime entry.
 */
export function updateRuntime(
  agentId: string,
  patch: Partial<LocalRuntime>,
): void {
  const existing = runtimes.get(agentId)
  if (!existing) return
  runtimes.set(agentId, { ...existing, ...patch })
}

// ============================================================
// Read Operations
// ============================================================

export function getRuntime(agentId: string): LocalRuntime | undefined {
  return runtimes.get(agentId)
}

export function getAllRuntimes(): ReadonlyMap<string, LocalRuntime> {
  return runtimes
}

/**
 * Reverse lookup: find agentId by tmuxPaneId.
 * Used by removeMemberByPaneId → find agentId → profileService.removeMember().
 */
export function findByPaneId(paneId: string): string | undefined {
  for (const [agentId, rt] of runtimes) {
    if (rt.tmuxPaneId === paneId) return agentId
  }
  return undefined
}

/**
 * Get all agent IDs that have active runtimes.
 */
export function getActiveAgentIds(): string[] {
  return Array.from(runtimes.keys())
}

// ============================================================
// Recovery (P1 — startup pane scan)
// ============================================================

/**
 * Recover runtime state by scanning live panes from the backend.
 * More reliable than file persistence — files may record dead panes
 * after kill -9, but scanning finds only truly alive panes.
 *
 * @param agentIds - Known member agentIds to look for
 * @param scanPanes - Backend-specific function that returns live pane info
 */
export async function recoverFromBackend(
  agentIds: string[],
  scanPanes: () => Promise<Array<{ paneId: string; title: string; cwd: string }>>,
): Promise<number> {
  const livePanes = await scanPanes()
  let recovered = 0

  for (const pane of livePanes) {
    // Match pane title to agentId (convention: pane title contains agentId)
    const matched = agentIds.find(id => pane.title.includes(id))
    if (matched && !runtimes.has(matched)) {
      runtimes.set(matched, {
        tmuxPaneId: pane.paneId,
        cwd: pane.cwd,
        backendType: 'tmux' as BackendType,
      })
      recovered++
    }
  }

  return recovered
}
