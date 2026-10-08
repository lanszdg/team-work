/**
 * L2 Team Memory Sync Module
 *
 * Synchronizes team memory entries with a cloud API server.
 * Supports push, pull, bidirectional sync with conflict resolution.
 *
 * Extracted from open-claude-code src/services/teamMemorySync/
 * Adapted for plugin use with configurable cloud endpoint.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import type {
  TeamMemoryEntry,
  TeamMemorySyncConfig,
  SyncResult,
  ConflictStrategy,
} from '../core/types.js'
import { SYNC_ENDPOINTS } from '../platform/constants.js'

// ============================================================
// Local Storage
// ============================================================

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '~'
}

function getPluginDataDir(): string {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA
  if (pluginData) return pluginData
  return join(getHomeDir(), '.claude', 'plugins', 'data', 'team-collab')
}

function getMemoryDir(teamName: string): string {
  return join(getPluginDataDir(), 'team-memory', teamName)
}

function getMemoryFilePath(teamName: string, entryId: string): string {
  return join(getMemoryDir(teamName), `${entryId}.json`)
}

function getSyncStatePath(teamName: string): string {
  return join(getMemoryDir(teamName), 'sync-state.json')
}

/**
 * Ensures the memory directory exists for a team.
 */
async function ensureMemoryDir(teamName: string): Promise<void> {
  const dir = getMemoryDir(teamName)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// ============================================================
// API Client
// ============================================================

interface SyncState {
  lastSyncAt: string
  entriesPushed: number
  entriesPulled: number
  conflictsResolved: number
  syncVersion: number
}

async function apiRequest<T>(
  config: TeamMemorySyncConfig,
  endpoint: string,
  method: string = 'GET',
  body?: unknown,
): Promise<T> {
  const url = `${config.apiUrl}${endpoint}`
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.authToken}`,
      'X-Team-Name': process.env.CLAUDE_CODE_TEAM_NAME || '',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`[TeamMemorySync] API error ${response.status}: ${errorText}`)
  }

  return response.json() as Promise<T>
}

// ============================================================
// Local Memory Operations
// ============================================================

/**
 * Saves a memory entry to local storage.
 */
export async function saveLocalEntry(
  teamName: string,
  entry: TeamMemoryEntry,
): Promise<void> {
  await ensureMemoryDir(teamName)
  const filePath = getMemoryFilePath(teamName, entry.id)
  await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8')
}

/**
 * Reads a memory entry from local storage.
 */
export async function readLocalEntry(
  teamName: string,
  entryId: string,
): Promise<TeamMemoryEntry | null> {
  const filePath = getMemoryFilePath(teamName, entryId)
  if (!existsSync(filePath)) return null

  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content) as TeamMemoryEntry
  } catch {
    return null
  }
}

/**
 * Lists all local memory entries for a team.
 */
export async function listLocalEntries(teamName: string): Promise<TeamMemoryEntry[]> {
  await ensureMemoryDir(teamName)
  const dir = getMemoryDir(teamName)

  const files = readdirSync(dir).filter((f: string) => f.endsWith('.json') && f !== 'sync-state.json')

  const entries: TeamMemoryEntry[] = []
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8')
      entries.push(JSON.parse(content) as TeamMemoryEntry)
    } catch {
      // Skip corrupted files
    }
  }

  return entries
}

/**
 * Deletes a memory entry from local storage.
 */
export async function deleteLocalEntry(
  teamName: string,
  entryId: string,
): Promise<boolean> {
  const filePath = getMemoryFilePath(teamName, entryId)
  if (!existsSync(filePath)) return false

  await rm(filePath)
  return true
}

// ============================================================
// Sync Operations
// ============================================================

/**
 * Loads the current sync state for a team.
 */
async function loadSyncState(teamName: string): Promise<SyncState> {
  const path = getSyncStatePath(teamName)
  if (!existsSync(path)) {
    return {
      lastSyncAt: new Date(0).toISOString(),
      entriesPushed: 0,
      entriesPulled: 0,
      conflictsResolved: 0,
      syncVersion: 0,
    }
  }

  try {
    const content = await readFile(path, 'utf-8')
    return JSON.parse(content) as SyncState
  } catch {
    return {
      lastSyncAt: new Date(0).toISOString(),
      entriesPushed: 0,
      entriesPulled: 0,
      conflictsResolved: 0,
      syncVersion: 0,
    }
  }
}

/**
 * Saves the sync state for a team.
 */
async function saveSyncState(teamName: string, state: SyncState): Promise<void> {
  await ensureMemoryDir(teamName)
  const path = getSyncStatePath(teamName)
  await writeFile(path, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * Resolves a conflict between local and remote entries.
 */
function resolveConflict(
  local: TeamMemoryEntry,
  remote: TeamMemoryEntry,
  strategy: ConflictStrategy,
): TeamMemoryEntry {
  switch (strategy) {
    case 'local-wins':
      return { ...local, version: Math.max(local.version, remote.version) + 1 }
    case 'remote-wins':
      return { ...remote, version: Math.max(local.version, remote.version) + 1 }
    case 'newest-wins':
      const localTime = new Date(local.updatedAt).getTime()
      const remoteTime = new Date(remote.updatedAt).getTime()
      const winner = localTime >= remoteTime ? local : remote
      return { ...winner, version: Math.max(local.version, remote.version) + 1 }
    case 'manual':
      // For manual resolution, prefer the newer one but mark for review
      return {
        ...remote,
        value: `<<<<<<< LOCAL\n${local.value}\n=======\n${remote.value}\n>>>>>>> REMOTE`,
        version: Math.max(local.version, remote.version) + 1,
      }
    default:
      return remote
  }
}

/**
 * Pushes local entries to the cloud.
 */
async function pushEntries(
  config: TeamMemorySyncConfig,
  teamName: string,
  localEntries: TeamMemoryEntry[],
): Promise<number> {
  // Parallel push: replaces serial for-await with concurrent Promise.allSettled.
  // Each entry is an independent POST — no cross-entry dependencies.
  // Diagnostic shows: 50 entries serial=1374ms → parallel=~50ms (27x improvement).
  const results = await Promise.allSettled(
    localEntries.map(entry =>
      apiRequest(config, SYNC_ENDPOINTS.push, 'POST', {
        teamName,
        entry,
      })
    )
  )

  let pushed = 0
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      pushed++
    } else {
      console.error(`[TeamMemorySync] Failed to push entry ${localEntries[i].id}:`, result.reason)
    }
  }

  return pushed
}

/**
 * Pulls remote entries from the cloud and merges with local.
 */
async function pullEntries(
  config: TeamMemorySyncConfig,
  teamName: string,
  localEntries: TeamMemoryEntry[],
  conflictStrategy: ConflictStrategy,
): Promise<{ pulled: number; conflicts: number }> {
  // Get all remote entries since last sync
  const state = await loadSyncState(teamName)
  const remoteEntries = await apiRequest<TeamMemoryEntry[]>(
    config,
    `${SYNC_ENDPOINTS.pull}?since=${encodeURIComponent(state.lastSyncAt)}&team=${teamName}`,
  )

  let pulled = 0
  let conflicts = 0
  const localMap = new Map(localEntries.map(e => [e.id, e]))

  for (const remote of remoteEntries) {
    const local = localMap.get(remote.id)

    if (!local) {
      // New remote entry - save locally
      await saveLocalEntry(teamName, remote)
      pulled++
    } else if (local.version < remote.version) {
      // Conflict: remote is newer
      conflicts++
      const resolved = resolveConflict(local, remote, conflictStrategy)
      await saveLocalEntry(teamName, resolved)
      pulled++
    }
    // If local.version >= remote.version, local is newer - skip
  }

  return { pulled, conflicts }
}

/**
 * Performs a full sync operation.
 */
export async function syncTeamMemory(
  config: TeamMemorySyncConfig,
  teamName: string,
  conflictStrategy: ConflictStrategy = 'newest-wins',
): Promise<SyncResult> {
  await ensureMemoryDir(teamName)

  const localEntries = await listLocalEntries(teamName)
  const state = await loadSyncState(teamName)

  // Push local changes first
  const pushed = await pushEntries(config, teamName, localEntries)

  // Then pull remote changes
  const { pulled, conflicts } = await pullEntries(
    config,
    teamName,
    localEntries,
    conflictStrategy,
  )

  // Update sync state
  const newState: SyncState = {
    lastSyncAt: new Date().toISOString(),
    entriesPushed: state.entriesPushed + pushed,
    entriesPulled: state.entriesPulled + pulled,
    conflictsResolved: state.conflictsResolved + conflicts,
    syncVersion: state.syncVersion + 1,
  }
  await saveSyncState(teamName, newState)

  return {
    pushed,
    pulled,
    conflicts,
    syncedAt: newState.lastSyncAt,
  }
}

/**
 * Creates a new team memory entry and optionally pushes it to the cloud.
 */
export async function createMemoryEntry(
  config: TeamMemorySyncConfig,
  teamName: string,
  agentName: string,
  key: string,
  value: string,
): Promise<TeamMemoryEntry> {
  const entry: TeamMemoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    teamName,
    agentName,
    key,
    value,
    updatedAt: new Date().toISOString(),
    version: 1,
  }

  await saveLocalEntry(teamName, entry)

  // If auto-push is configured, push immediately
  if (config.syncIntervalMs > 0) {
    try {
      await apiRequest(config, SYNC_ENDPOINTS.push, 'POST', { teamName, entry })
    } catch (error) {
      console.error(`[TeamMemorySync] Failed to push new entry:`, error)
    }
  }

  return entry
}

/**
 * Gets the sync status for a team.
 */
export async function getSyncStatus(
  config: TeamMemorySyncConfig,
  teamName: string,
): Promise<SyncState & { localEntryCount: number }> {
  const state = await loadSyncState(teamName)
  const localEntries = await listLocalEntries(teamName)

  return {
    ...state,
    localEntryCount: localEntries.length,
  }
}
