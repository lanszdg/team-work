/**
 * Team File Management Module
 *
 * Handles CRUD operations for team configuration files stored in
 * ~/.claude/teams/{team-name}/config.json
 *
 * Extracted from open-claude-code src/utils/swarm/teamHelpers.ts
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import os from 'os'
import type { TeamFile, TeamMember, TeamAllowedPath, PermissionMode, TeamRole, TeamMemberProfile } from '../core/types.js'
import { TEAM_CONFIG_FILE, DEFAULT_TEAM_NAME, TEAM_SUBDIRS, TEAM_LEAD_NAME } from '../platform/constants.js'
import { TeamProfileService, CreateTeamError, DuplicateTeamError } from './teamProfileService.js'
import { SyncServerAdapter } from './syncServerAdapter.js'
import { getConfiguredSyncUrl, getConfiguredApiKey } from './cloudConfig.js'

// ============================================================
// V5-4: Optimistic locking — ETag cache for cloud state push
// ============================================================

let _lastCloudEtag: string | undefined

// ============================================================
// V4: TeamProfileService singleton factory
// ============================================================

const _profileServiceCache = new Map<string, TeamProfileService>()

/**
 * Get or create a TeamProfileService instance for a team.
 * Returns null if TEAM_MEMORY_SYNC_URL is not configured.
 */
export function getProfileService(teamName: string): TeamProfileService | null {
  const syncUrl = getConfiguredSyncUrl()
  if (!syncUrl) return null

  const cached = _profileServiceCache.get(teamName)
  if (cached) return cached

  const apiKey = getConfiguredApiKey()
  const developerId = process.env.CLAUDE_CODE_AGENT_ID || 'unknown-agent'

  const teamAdapter = new SyncServerAdapter({
    apiUrl: syncUrl, apiKey, repo: teamName, developerId,
  })
  const teamsAdapter = new SyncServerAdapter({
    apiUrl: syncUrl, apiKey, repo: '__teams__', developerId,
  })
  const cachePath = join(getTeamDir(teamName), 'cloud-state-cache.json')

  const service = new TeamProfileService({ teamAdapter, teamsAdapter, cachePath })
  _profileServiceCache.set(teamName, service)
  return service
}

/** Clear cached profile service instances (for testing). */
export function clearProfileServiceCache(): void {
  _profileServiceCache.clear()
}

// ============================================================
// C6: Cloud storage key pattern constants
// ============================================================

/** Cloud storage key for the full team state JSON blob */
export const CLOUD_TEAM_STATE_KEY = 'team_state'
/** Cloud storage key prefix for individual member entries */
export const CLOUD_MEMBER_KEY_PREFIX = 'members/'
/** Build a cloud storage key for a specific member */
export function cloudMemberKey(agentId: string): string {
  return `${CLOUD_MEMBER_KEY_PREFIX}${agentId}`
}

// ============================================================
// C1: Push team state to cloud sync server
// ============================================================

/**
 * Push full team state to the cloud sync server.
 * Keys: team_state -> JSON TeamFile, members/{agentId} -> member JSON
 * Fire-and-forget: failures are logged but do not block local creation.
 */
async function pushTeamStateToCloud(teamName: string, teamFile: TeamFile): Promise<void> {
  const syncUrl = getConfiguredSyncUrl()
  if (!syncUrl) return

  try {
    const { SyncServerAdapter } = await import('./syncServerAdapter.js')
    const adapter = new SyncServerAdapter({
      apiUrl: syncUrl,
      apiKey: getConfiguredApiKey(),
      repo: teamName,
      developerId: teamFile.leadAgentId,
    })

    const cleanMembers = teamFile.members.map(toCloudMember)

    const entries: Record<string, string> = {
      [CLOUD_TEAM_STATE_KEY]: JSON.stringify({ ...teamFile, members: cleanMembers }),
    }

    for (const member of cleanMembers) {
      entries[cloudMemberKey(member.agentId)] = JSON.stringify({
        ...member,
        _teamName: teamName,
        _syncedAt: new Date().toISOString(),
      })
    }

    // V5-4: Pass ETag for optimistic locking
    await adapter.push(entries, _lastCloudEtag)
    console.log(`[TeamFile:C1] Pushed team state to cloud "${teamName}" (${Object.keys(entries).length} keys)`)
  } catch (err) {
    console.warn(`[TeamFile:C1] Failed to push team state (non-fatal):`,
      err instanceof Error ? err.message : String(err))
  }
}

// ============================================================
// C2: Cloud-based team sync (push + pull + merge)
// ============================================================

/**
 * Sync local team state to cloud. Wraps pushTeamStateToCloud for external callers.
 * Returns true if sync succeeded, false if no cloud config or push failed.
 */
export async function syncTeamToCloud(teamName: string): Promise<boolean> {
  const syncUrl = getConfiguredSyncUrl()
  if (!syncUrl) return false
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    console.warn(`[TeamFile:C2] No local team file for "${teamName}"`)
    return false
  }
  try {
    await pushTeamStateToCloud(teamName, teamFile)
    console.log(`[TeamFile:C2] Synced "${teamName}" (${teamFile.members.length} members)`)
    return true
  } catch (err) {
    console.error(`[TeamFile:C2] syncTeamToCloud failed:`, err)
    return false
  }
}

/**
 * Pull team state from cloud and merge with local.
 * Returns merged TeamFile or null if no cloud data available.
 * Local pane/worktree info is preserved during merge.
 */
export async function pullTeamFromCloud(teamName: string): Promise<TeamFile | null> {
  const syncUrl = getConfiguredSyncUrl()
  if (!syncUrl) return null

  try {
    const { SyncServerAdapter } = await import('./syncServerAdapter.js')
    const adapter = new SyncServerAdapter({
      apiUrl: syncUrl,
      apiKey: getConfiguredApiKey(),
      repo: teamName,
      developerId: process.env.CLAUDE_CODE_AGENT_ID || 'pull-worker',
    })

    const result = await adapter.pull()
    if (!result) {
      console.warn(`[TeamFile:C2] No data in cloud for "${teamName}"`)
      return null
    }

    // V5-4: Save ETag from pull for subsequent push optimistic locking
    if (result.etag) {
      _lastCloudEtag = result.etag
    }

    // Try team_state key → fallback to reconstruct from members/*
    const teamStateRaw = result.entries[CLOUD_TEAM_STATE_KEY]
    let cloudTeamFile: TeamFile | null = null

    if (teamStateRaw) {
      cloudTeamFile = JSON.parse(teamStateRaw) as TeamFile
    } else {
      const members: TeamFile['members'] = []
      for (const [key, value] of Object.entries(result.entries)) {
        if (!key.startsWith(CLOUD_MEMBER_KEY_PREFIX)) continue
        try {
          const m = JSON.parse(value)
          delete m._teamName
          delete m._syncedAt
          members.push(m)
        } catch { /* skip malformed entries */ }
      }
      if (members.length === 0) {
        console.warn(`[TeamFile:C2] No members in cloud for "${teamName}"`)
        return null
      }
      cloudTeamFile = {
        name: teamName,
        description: 'Reconstructed from cloud',
        createdAt: Date.now(),
        leadAgentId: members[0]?.agentId || '',
        members,
      }
    }

    const localTeamFile = readTeamFile(teamName)
    const merged = mergeTeamFiles(localTeamFile, cloudTeamFile, teamName)
    writeTeamFile(teamName, merged)
    console.log(`[TeamFile:C2] Pulled "${teamName}" from cloud (${merged.members.length} members)`)
    return merged
  } catch (err) {
    console.error(`[TeamFile:C2] pullTeamFromCloud failed:`, err)
    return null
  }
}

/**
 * Merge cloud team data into local. Cloud members are added; local pane/worktree/session
 * info is preserved for existing members to avoid overwriting runtime-only state.
 */
function mergeTeamFiles(
  local: TeamFile | null,
  cloud: TeamFile,
  teamName: string,
): TeamFile {
  if (!local) {
    return {
      ...cloud,
      hiddenPaneIds: cloud.hiddenPaneIds || [],
      teamAllowedPaths: cloud.teamAllowedPaths || [],
      members: cloud.members.map(m => ({
        ...m,
        tmuxPaneId: m.tmuxPaneId || '',
        cwd: m.cwd || process.cwd(),
        subscriptions: m.subscriptions || [],
        isActive: m.isActive ?? false,
      })),
    }
  }

  // V5-3: Union both local and cloud member sets to avoid dropping unsynced local members
  const localMemberMap = new Map(local.members.map(m => [m.agentId, m]))
  const cloudMemberMap = new Map(cloud.members.map(m => [m.agentId, m]))

  // Union: include ALL members from both sets
  const allAgentIds = new Set([
    ...local.members.map(m => m.agentId),
    ...cloud.members.map(m => m.agentId),
  ])

  const mergedMembers = [...allAgentIds].map(agentId => {
    const lm = localMemberMap.get(agentId)
    const cm = cloudMemberMap.get(agentId)
    if (lm && cm) {
      // Both local and cloud have this member — preserve local runtime state
      return {
        ...cm,
        tmuxPaneId: lm.tmuxPaneId || cm.tmuxPaneId || '',
        cwd: lm.cwd || cm.cwd || process.cwd(),
        worktreePath: lm.worktreePath || cm.worktreePath,
        sessionId: lm.sessionId || cm.sessionId,
      }
    }
    if (lm && !cm) {
      // Local-only member — KEEP (was being silently dropped before V5-3 fix)
      return lm
    }
    // Cloud-only member (new, cm guaranteed to exist since allAgentIds is union of both sets)
    // Explicit cm branch for TypeScript control-flow narrowing
    if (!lm && cm) {
      return {
        ...cm,
        tmuxPaneId: cm.tmuxPaneId || '',
        cwd: cm.cwd || process.cwd(),
        subscriptions: cm.subscriptions || [],
        isActive: cm.isActive ?? false,
        joinedAt: cm.joinedAt || Date.now(),
      }
    }
    // Unreachable: allAgentIds is constructed from the union of both member maps
    throw new Error(`Inconsistent state: agentId ${agentId} not found in either local or cloud members`)
  })

  return {
    name: cloud.name || local.name || teamName,
    description: cloud.description || local.description,
    createdAt: cloud.createdAt || local.createdAt,
    leadAgentId: cloud.leadAgentId || local.leadAgentId,
    leadSessionId: cloud.leadSessionId || local.leadSessionId,
    hiddenPaneIds: local.hiddenPaneIds || [],
    // A-V5-6: Merge both local and cloud teamAllowedPaths
    teamAllowedPaths: [...(local.teamAllowedPaths || []), ...(cloud.teamAllowedPaths || [])],
    members: mergedMembers,
  }
}

// ============================================================
// Path Resolution
// ============================================================

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

function getTeamsDir(): string {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA
  if (pluginData) {
    return join(pluginData, 'teams')
  }
  return join(getHomeDir(), '.claude', 'teams')
}

/**
 * Sanitizes a name for use in file paths and tmux window names.
 * Replaces all non-alphanumeric characters with hyphens and lowercases.
 */
export function sanitizeName(name: string): string {
  if (!name) {
    console.error('[TeamFile] sanitizeName called with empty/undefined name')
    return 'unknown'
  }
  // Preserve Unicode letters (including CJK, Cyrillic, Arabic, etc.)
  // Also preserve safe path chars (._-) for cross-module path consistency
  // with mailbox.ts:sanitizePathComponent and teamDashboard.ts.
  return name.replace(/[^\p{L}\p{N}._-]/gu, '-').toLowerCase()
}

/**
 * Sanitizes an agent name for use in deterministic agent IDs.
 * Replaces @ with - to prevent ambiguity in agentName@teamName format.
 */
export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-')
}

/**
 * Gets the path to a team's directory.
 */
export function getTeamDir(teamName: string): string {
  return join(getTeamsDir(), sanitizeName(teamName))
}

/**
 * Gets the path to a team's config.json file.
 */
export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), TEAM_CONFIG_FILE)
}

// ============================================================
// Read Operations
// ============================================================

/**
 * Reads a team file synchronously.
 * @returns TeamFile or null if not found / parse error
 */
export function readTeamFile(teamName: string): TeamFile | null {
  try {
    const content = readFileSync(getTeamFilePath(teamName), 'utf-8')
    return JSON.parse(content) as TeamFile
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error(`[TeamFile] Failed to read team file for ${teamName}:`, e)
    return null
  }
}

/**
 * Reads a team file asynchronously.
 */
export async function readTeamFileAsync(teamName: string): Promise<TeamFile | null> {
  try {
    const content = await readFile(getTeamFilePath(teamName), 'utf-8')
    return JSON.parse(content) as TeamFile
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error(`[TeamFile] Failed to read team file for ${teamName}:`, e)
    return null
  }
}

/**
 * Lists all teams by scanning the teams directory.
 */
export function listTeams(): string[] {
  const teamsDir = getTeamsDir()
  if (!existsSync(teamsDir)) return []

  return readdirSync(teamsDir)
    .filter((name: string) => {
      const configPath = join(teamsDir, name, TEAM_CONFIG_FILE)
      return existsSync(configPath)
    })
}

// ============================================================
// Write Operations
// ============================================================

/**
 * Writes a team file synchronously.
 */
export function writeTeamFile(teamName: string, teamFile: TeamFile): void {
  const teamDir = getTeamDir(teamName)
  try {
    mkdirSync(teamDir, { recursive: true })
    writeFileSync(getTeamFilePath(teamName), JSON.stringify(teamFile, null, 2), 'utf-8')
  } catch (error) {
    console.error(`[TeamFile] Failed to write team file for ${teamName}:`, error)
    throw error
  }
}

/**
 * Writes a team file asynchronously.
 */
export async function writeTeamFileAsync(teamName: string, teamFile: TeamFile): Promise<void> {
  const teamDir = getTeamDir(teamName)
  try {
    await mkdir(teamDir, { recursive: true })
    await writeFile(getTeamFilePath(teamName), JSON.stringify(teamFile, null, 2), 'utf-8')
  } catch (error) {
    console.error(`[TeamFile] Failed to write team file for ${teamName}:`, error)
    throw error
  }
}

// ============================================================
// Team Creation
// ============================================================

/**
 * Creates a new team with the leader as the sole member.
 *
 * V4: Cloud-first — writes to cloud via TeamProfileService first,
 * then persists local cache. If cloud is unavailable, falls back to local-only.
 */
export async function createTeam(options: {
  teamName: string
  leadAgentId: string
  leadSessionId?: string
  description?: string
  role?: TeamRole
  /** @deprecated Use role instead */
  agentType?: string
}): Promise<TeamFile> {
  const { teamName, leadAgentId, leadSessionId, description, role, agentType } = options
  const effectiveRole: TeamRole = role ?? migrateRole({ agentType }) ?? 'tech-lead'

  // V4: Try cloud-first via TeamProfileService
  const profileService = getProfileService(teamName)
  if (profileService) {
    const cloudState = await profileService.createTeam({
      name: teamName,
      leadAgentId,
      role: effectiveRole,
      description,
    })

    // Build local TeamFile from cloud state (for backward compat)
    const teamFile: TeamFile = {
      name: cloudState.name,
      description: cloudState.description,
      createdAt: cloudState.createdAt,
      leadAgentId: cloudState.leadAgentId,
      leadSessionId,
      hiddenPaneIds: [],
      teamAllowedPaths: cloudState.policy.allowedPaths,
      members: cloudState.members.map(p => ({
        ...p,
        tmuxPaneId: '',
        cwd: process.cwd(),
        sessionId: p.agentId === leadAgentId ? leadSessionId : undefined,
        subscriptions: p.subscriptions || [],
        runtime: p.agentId === leadAgentId ? { isActive: true, mode: 'auto' as const } : undefined,
      })),
      version: cloudState.version,
    }

    writeTeamFile(teamName, teamFile)
    console.log(`[TeamFile:V4] Team created (cloud-first): "${teamName}" → ${sanitizeName(teamName)}`)
    return teamFile
  }

  // Fallback: no cloud URL configured — local-only (legacy behavior)
  const teamFile: TeamFile = {
    name: teamName,
    description,
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId,
    hiddenPaneIds: [],
    teamAllowedPaths: [],
    members: [
      {
        agentId: leadAgentId,
        name: TEAM_LEAD_NAME,
        role: effectiveRole,
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: process.cwd(),
        sessionId: leadSessionId,
        subscriptions: [],
        runtime: { isActive: true, mode: 'auto' },
      },
    ],
  }

  writeTeamFile(teamName, teamFile)
  console.log(`[TeamFile] Team created (local-only): "${teamName}" → ${sanitizeName(teamName)}`)
  return teamFile
}

// ============================================================
// Role Migration (v3.6 Phase 2)
// ============================================================

/** Legacy agentType → new TeamRole mapping. */
const LEGACY_ROLE_MAP: Record<string, TeamRole> = {
  'coder': 'developer',
  'worker': 'developer',
  'researcher': 'product-manager',
  'tester': 'qa-engineer',
  'leader': 'tech-lead',
  'team-lead': 'tech-lead',
  'designer': 'designer',
  'ops': 'ops-engineer',
  'pm': 'product-manager',
}

/** Migrates an old agentType to the new role system. */
function migrateRole(member: { agentType?: string }): TeamRole {
  if (!member.agentType) return 'developer'
  return LEGACY_ROLE_MAP[member.agentType] || 'developer'
}

/** Filters runtime and local-only fields before pushing to cloud. */
function toCloudMember(m: TeamMember): Omit<TeamMember,
  'runtime' | 'tmuxPaneId' | 'cwd' | 'worktreePath' |
  'sessionId' | 'isActive' | 'backendType' | 'mode'
> {
  const {
    runtime: _r, tmuxPaneId: _t, cwd: _c, worktreePath: _w,
    sessionId: _s, isActive: _a, backendType: _b, mode: _m,
    ...rest
  } = m
  return rest
}

// ============================================================
// Member Management
// ============================================================

/**
 * Adds a member to an existing team.
 *
 * V4: Cloud-first — delegates to TeamProfileService when cloud is configured.
 */
export async function addMember(teamName: string, member: Omit<TeamMember, 'joinedAt'>): Promise<boolean> {
  const profileService = getProfileService(teamName)
  if (profileService) {
    try {
      const profile: TeamMemberProfile = {
        agentId: member.agentId,
        name: member.name,
        role: member.role,
        model: member.model,
        prompt: member.prompt,
        color: member.color,
        joinedAt: Date.now(),
        subscriptions: member.subscriptions || [],
        agentType: member.agentType,
      }
      await profileService.addMember(profile)

      // Update local cache for backward compat
      const teamFile = readTeamFile(teamName)
      if (teamFile) {
        if (!teamFile.members.some(m => m.agentId === member.agentId)) {
          teamFile.members.push({ ...member, joinedAt: profile.joinedAt })
          writeTeamFile(teamName, teamFile)
        }
      }
      return true
    } catch (err) {
      console.error(`[TeamFile:V4] addMember cloud-first failed:`, err)
      return false
    }
  }

  // Fallback: local-only
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return false

  if (teamFile.members.some(m => m.agentId === member.agentId)) {
    console.error(`[TeamFile] Member ${member.agentId} already exists in team ${teamName}`)
    return false
  }

  teamFile.members.push({ ...member, joinedAt: Date.now() })
  writeTeamFile(teamName, teamFile)
  pushTeamStateToCloud(teamName, teamFile)
  return true
}

/**
 * Removes a teammate from the team file by agent ID or name.
 *
 * V4: Cloud-first via TeamProfileService when configured.
 */
export async function removeTeammateFromTeamFile(
  teamName: string,
  identifier: { agentId?: string; name?: string },
): Promise<boolean> {
  const identifierStr = identifier.agentId || identifier.name
  if (!identifierStr) return false

  const teamFile = readTeamFile(teamName)
  if (!teamFile) return false

  // Resolve agentId from name if needed
  const memberToRemove = teamFile.members.find(m => {
    if (identifier.agentId && m.agentId === identifier.agentId) return true
    if (identifier.name && m.name === identifier.name) return true
    return false
  })

  if (!memberToRemove) return false

  if (memberToRemove.agentId === teamFile.leadAgentId) {
    console.error(
      `[TeamFile] Cannot remove team lead (agentId: ${memberToRemove.agentId}) from team ${teamName}`,
    )
    return false
  }

  const profileService = getProfileService(teamName)
  if (profileService) {
    try {
      await profileService.removeMember(memberToRemove.agentId)
    } catch (err) {
      console.error(`[TeamFile:V4] removeMember cloud-first failed:`, err)
      return false
    }
  }

  // Update local
  teamFile.members = teamFile.members.filter(m => m.agentId !== memberToRemove.agentId)
  writeTeamFile(teamName, teamFile)
  if (!profileService) pushTeamStateToCloud(teamName, teamFile)
  return true
}

/**
 * Removes a member by tmux pane ID. Also removes from hiddenPaneIds.
 *
 * V4: Cloud-first via TeamProfileService when configured.
 */
export async function removeMemberByPaneId(teamName: string, tmuxPaneId: string): Promise<boolean> {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return false

  const member = teamFile.members.find(m => m.tmuxPaneId === tmuxPaneId)
  if (!member) return false

  const profileService = getProfileService(teamName)
  if (profileService) {
    try {
      await profileService.removeMember(member.agentId)
    } catch (err) {
      console.error(`[TeamFile:V4] removeMemberByPaneId cloud-first failed:`, err)
      return false
    }
  }

  teamFile.members = teamFile.members.filter(m => m.tmuxPaneId !== tmuxPaneId)
  if (teamFile.hiddenPaneIds) {
    const hiddenIndex = teamFile.hiddenPaneIds.indexOf(tmuxPaneId)
    if (hiddenIndex !== -1) teamFile.hiddenPaneIds.splice(hiddenIndex, 1)
  }
  writeTeamFile(teamName, teamFile)
  if (!profileService) pushTeamStateToCloud(teamName, teamFile)
  return true
}

/**
 * Sets a team member's permission mode.
 *
 * V4: Cloud-first — mode is stored in TeamPolicy.memberModes.
 */
export async function setMemberMode(teamName: string, memberName: string, mode: PermissionMode): Promise<boolean> {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return false

  const member = teamFile.members.find(m => m.name === memberName)
  if (!member) return false

  if (member.mode === mode) return true

  const profileService = getProfileService(teamName)
  if (profileService) {
    try {
      await profileService.setMemberMode(member.agentId, mode)
    } catch (err) {
      console.error(`[TeamFile:V4] setMemberMode cloud-first failed:`, err)
      return false
    }
  }

  // Update local for backward compat
  teamFile.members = teamFile.members.map(m =>
    m.name === memberName ? { ...m, mode } : m,
  )
  writeTeamFile(teamName, teamFile)
  if (!profileService) pushTeamStateToCloud(teamName, teamFile)
  return true
}

/**
 * Sets multiple team members' permission modes atomically.
 *
 * V4: Cloud-first via TeamProfileService.setMultipleMemberModes.
 */
export async function setMultipleMemberModes(
  teamName: string,
  modeUpdates: Array<{ memberName: string; mode: PermissionMode }>,
): Promise<boolean> {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return false

  // Resolve memberName → agentId for cloud service
  const modesRecord: Record<string, PermissionMode> = {}
  const updateMap = new Map(modeUpdates.map(u => [u.memberName, u.mode]))

  for (const member of teamFile.members) {
    const newMode = updateMap.get(member.name)
    if (newMode !== undefined && member.mode !== newMode) {
      modesRecord[member.agentId] = newMode
    }
  }

  if (Object.keys(modesRecord).length === 0) return true

  const profileService = getProfileService(teamName)
  if (profileService) {
    try {
      await profileService.setMultipleMemberModes(modesRecord)
    } catch (err) {
      console.error(`[TeamFile:V4] setMultipleMemberModes cloud-first failed:`, err)
      return false
    }
  }

  // Update local
  teamFile.members = teamFile.members.map(member => {
    const newMode = updateMap.get(member.name)
    if (newMode !== undefined && member.mode !== newMode) {
      return { ...member, mode: newMode }
    }
    return member
  })
  writeTeamFile(teamName, teamFile)
  if (!profileService) pushTeamStateToCloud(teamName, teamFile)
  return true
}

/**
 * Sets a team member's active status (idle/running).
 */
export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<void> {
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) return

  const member = teamFile.members.find(m => m.name === memberName)
  if (!member) return

  if (member.isActive === isActive) return

  member.isActive = isActive
  await writeTeamFileAsync(teamName, teamFile)
  pushTeamStateToCloud(teamName, teamFile).catch(err =>
    console.warn('[TeamFile:C2] Failed to sync active state:', err))
}

// ============================================================
// Hidden Panes
// ============================================================

export function addHiddenPaneId(teamName: string, paneId: string): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return false

  if (!teamFile.hiddenPaneIds) teamFile.hiddenPaneIds = []
  if (!teamFile.hiddenPaneIds.includes(paneId)) {
    teamFile.hiddenPaneIds.push(paneId)
    writeTeamFile(teamName, teamFile)
  }
  return true
}

export function removeHiddenPaneId(teamName: string, paneId: string): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return false

  if (!teamFile.hiddenPaneIds) return true
  const index = teamFile.hiddenPaneIds.indexOf(paneId)
  if (index !== -1) {
    teamFile.hiddenPaneIds.splice(index, 1)
    writeTeamFile(teamName, teamFile)
  }
  return true
}

// ============================================================
// Team Allowed Paths
// ============================================================

export async function addTeamAllowedPath(
  teamName: string,
  allowedPath: Omit<TeamAllowedPath, 'addedAt'>,
): Promise<boolean> {
  const fullPath: TeamAllowedPath = { ...allowedPath, addedAt: Date.now() }

  const profileService = getProfileService(teamName)
  if (profileService) {
    try {
      await profileService.addAllowedPath(fullPath)
    } catch (err) {
      console.error(`[TeamFile:V4] addAllowedPath cloud-first failed:`, err)
      return false
    }
  }

  // Update local
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return false
  if (!teamFile.teamAllowedPaths) teamFile.teamAllowedPaths = []
  teamFile.teamAllowedPaths.push(fullPath)
  writeTeamFile(teamName, teamFile)
  return true
}

// ============================================================
// Cleanup
// ============================================================

/**
 * Destroys a git worktree at the given path.
 */
export async function destroyWorktree(worktreePath: string): Promise<void> {
  const execAsync = promisify(execFile)

  // Read the .git file to find the main repo
  let mainRepoPath: string | null = null
  try {
    const gitFileContent = (await readFile(join(worktreePath, '.git'), 'utf-8')).trim()
    const match = gitFileContent.match(/^gitdir:\s*(.+)$/)
    if (match?.[1]) {
      const worktreeGitDir = match[1]
      const mainGitDir = join(worktreeGitDir, '..', '..')
      mainRepoPath = join(mainGitDir, '..')
    }
  } catch {
    // Path doesn't exist or not a worktree
  }

  if (mainRepoPath) {
    try {
      await execAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: mainRepoPath })
      return
    } catch {
      // Fall through to manual removal
    }
  }

  try {
    await rm(worktreePath, { recursive: true, force: true })
  } catch (e) {
    console.error(`[TeamFile] Failed to remove worktree ${worktreePath}:`, e)
  }
}

/**
 * Cleans up team and task directories.
 */
export async function cleanupTeamDirectories(teamName: string): Promise<void> {
  const sanitizedName = sanitizeName(teamName)

  // C13: Clean up cloud entries before local cleanup
  const syncUrl = getConfiguredSyncUrl()
  if (syncUrl) {
    try {
      const { SyncServerAdapter } = await import('./syncServerAdapter.js')
      const apiKey = getConfiguredApiKey()
      // 1. Mark team state as deleted in team repo
      const teamAdapter = new SyncServerAdapter({
        apiUrl: syncUrl, apiKey, repo: teamName, developerId: 'cleanup',
      })
      const result = await teamAdapter.pull()
      const deleteEntries: Record<string, string> = {}
      if (result?.entries) {
        for (const key of Object.keys(result.entries)) {
          if (key === CLOUD_TEAM_STATE_KEY || key.startsWith(CLOUD_MEMBER_KEY_PREFIX)) {
            deleteEntries[key] = '__DELETED__'
          }
        }
        if (Object.keys(deleteEntries).length > 0) {
          await teamAdapter.push(deleteEntries)
          console.log(`[TeamFile:C13] Marked ${Object.keys(deleteEntries).length} cloud entries as deleted for "${teamName}"`)
        }
      }
      // 2. Remove from __teams__ discovery repo
      try {
        const teamsAdapter = new SyncServerAdapter({
          apiUrl: syncUrl, apiKey, repo: '__teams__', developerId: 'cleanup',
        })
        await teamsAdapter.push({ [`team/${teamName}`]: '__DELETED__' })
        console.log(`[TeamFile:C13] Removed team "${teamName}" from cloud discovery`)
      } catch (teamsErr) {
        console.warn(`[TeamFile:C13] Failed to clean __teams__ entry:`, teamsErr)
      }
      // 3. Clean up invitation entries for this team
      try {
        const inviteAdapter = new SyncServerAdapter({
          apiUrl: syncUrl, apiKey, repo: `__invitations__/${teamName}`, developerId: 'cleanup',
        })
        const invResult = await inviteAdapter.pull()
        if (invResult?.entries) {
          const invDeletes: Record<string, string> = {}
          for (const key of Object.keys(invResult.entries)) {
            invDeletes[key] = '__DELETED__'
          }
          if (Object.keys(invDeletes).length > 0) {
            await inviteAdapter.push(invDeletes)
          }
        }
        console.log(`[TeamFile:C13] Cleaned invitation entries for "${teamName}"`)
      } catch (invErr) {
        console.warn(`[TeamFile:C13] Failed to clean invitation entries:`, invErr)
      }
    } catch (err) {
      console.warn(`[TeamFile:C13] Cloud cleanup failed (non-fatal):`,
        err instanceof Error ? err.message : String(err))
    }
  }

  const teamFile = readTeamFile(teamName)

  // Clean up worktrees first
  if (teamFile) {
    for (const member of teamFile.members) {
      if (member.worktreePath) {
        await destroyWorktree(member.worktreePath)
      }
    }
  }

  // Clean up team directory
  const teamDir = getTeamDir(teamName)
  try {
    await rm(teamDir, { recursive: true, force: true })
  } catch (e) {
    console.error(`[TeamFile] Failed to clean up team directory ${teamDir}:`, e)
  }

  // Clean up tasks directory
  const tasksDir = join(getHomeDir(), '.claude', 'tasks', sanitizedName)
  try {
    await rm(tasksDir, { recursive: true, force: true })
  } catch (e) {
    console.error(`[TeamFile] Failed to clean up tasks directory ${tasksDir}:`, e)
  }
}
