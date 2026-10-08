/**
 * Team Discovery Module
 *
 * Scans the teams directory to discover teams and teammate status.
 * Used by the Teams UI to show team status.
 *
 * Extracted from open-claude-code src/utils/teamDiscovery.ts
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { readTeamFile } from './teamFile.js'
import * as runtimeRegistry from './runtimeRegistry.js'
import type { TeamSummary, TeammateStatus, TeamFile, CloudDiscoveryResult, DiscoveredTeam, InvitationInfo } from '../core/types.js'
import { TEAM_CONFIG_FILE, TEAM_LEAD_NAME } from '../platform/constants.js'
import { SyncServerAdapter } from './syncServerAdapter.js'
import { getConfiguredSyncUrl, getConfiguredApiKey } from './cloudConfig.js'

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '~'
}

function getTeamsDir(): string {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA
  if (pluginData) return join(pluginData, 'teams')
  return join(getHomeDir(), '.claude', 'teams')
}

/**
 * Get detailed teammate statuses for a team.
 * Reads isActive from config to determine status.
 */
export function getTeammateStatuses(teamName: string): TeammateStatus[] {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return []

  const hiddenPaneIds = new Set(teamFile.hiddenPaneIds ?? [])
  const statuses: TeammateStatus[] = []

  for (const member of teamFile.members) {
    // Exclude team-lead from the list
    if (member.name === TEAM_LEAD_NAME) continue

    // V4: Prefer runtimeRegistry for runtime fields (more accurate than stale file)
    const rt = runtimeRegistry.getRuntime(member.agentId)
    const paneId = rt?.tmuxPaneId || member.tmuxPaneId || ''
    const cwd = rt?.cwd || member.cwd || ''
    const worktreePath = rt?.worktreePath || member.worktreePath
    const backendType = rt?.backendType || member.backendType

    // Active if runtimeRegistry has entry, or fallback to file field
    const isActive = rt ? true : (member.isActive !== false)
    const status: 'running' | 'idle' = isActive ? 'running' : 'idle'

    statuses.push({
      name: member.name,
      agentId: member.agentId,
      agentType: member.agentType,
      role: member.role,
      model: member.model,
      prompt: member.prompt,
      status,
      color: member.color,
      tmuxPaneId: paneId,
      cwd,
      worktreePath,
      isHidden: hiddenPaneIds.has(paneId),
      backendType,
      mode: member.mode as any,
    })
  }

  return statuses
}

/**
 * Gets a summary of a team's overall status.
 */
export function getTeamSummary(teamName: string): TeamSummary | null {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return null

  const members = teamFile.members.filter(m => m.name !== TEAM_LEAD_NAME)
  const runningCount = members.filter(m => m.isActive !== false).length
  const idleCount = members.filter(m => m.isActive === false).length

  return {
    name: teamFile.name,
    memberCount: members.length,
    runningCount,
    idleCount,
  }
}

/**
 * Lists all discovered teams with their summaries.
 */
export function listAllTeams(): TeamSummary[] {
  const teamsDir = getTeamsDir()
  if (!existsSync(teamsDir)) return []

  const teamNames = readdirSync(teamsDir).filter(name => {
    const configPath = join(teamsDir, name, TEAM_CONFIG_FILE)
    return existsSync(configPath)
  })

  return teamNames
    .map(name => getTeamSummary(name))
    .filter((s): s is TeamSummary => s !== null)
}

/**
 * Finds a team by the current session's environment variable.
 */
export function getCurrentTeam(): TeamFile | null {
  const teamName = process.env.CLAUDE_CODE_TEAM_NAME
  if (!teamName) return null
  return readTeamFile(teamName)
}

/**
 * Checks if the current session is running as a teammate.
 */
export function isTeammate(): boolean {
  return !!process.env.CLAUDE_CODE_TEAM_NAME &&
         process.env.CLAUDE_CODE_AGENT_NAME !== TEAM_LEAD_NAME
}

/**
 * Checks if the current session is the team leader.
 */
export function isTeamLeader(): boolean {
  return process.env.CLAUDE_CODE_AGENT_NAME === TEAM_LEAD_NAME &&
         !!process.env.CLAUDE_CODE_TEAM_NAME
}

/**
 * Scan cloud for teams and invitations relevant to the current agent.
 *
 * Multi-machine discovery:
 * 1. Pulls __teams__ repo → lists all registered teams
 * 2. For each team, pulls __invitations__/{team} → filters by current agentId
 * 3. Returns discovered teams + pending invitations
 *
 * Falls back gracefully if cloud is unreachable — returns empty arrays.
 */
export async function scanCloud(): Promise<CloudDiscoveryResult> {
  const syncUrl = getConfiguredSyncUrl()
  const apiKey = getConfiguredApiKey()
  const agentId = process.env.CLAUDE_CODE_AGENT_ID

  // Cannot scan without cloud config or agent identity
  if (!syncUrl || !agentId) {
    return { discovered: [], invited: [] }
  }

  const discovered: DiscoveredTeam[] = []
  const invited: InvitationInfo[] = []

  try {
    // Step 1: Pull __teams__ registry
    const teamsAdapter = new SyncServerAdapter({
      apiUrl: syncUrl,
      apiKey,
      repo: '__teams__',
      developerId: agentId,
    })

    const teamsResult = await teamsAdapter.pull()
    if (teamsResult?.entries) {
      for (const [key, value] of Object.entries(teamsResult.entries)) {
        if (!key.startsWith('team/') || !value) continue
        try {
          const entry = JSON.parse(value)
          const info = entry.info || entry
          if (info.name) {
            discovered.push({
              name: info.name,
              description: info.description || '',
              leadAgentId: info.leadAgentId || '',
              leadAgentName: info.leadAgentName || '',
              memberCount: info.memberCount || 0,
              createdAt: info.createdAt || '',
            })
          }
        } catch {
          // Skip malformed entries
        }
      }
    }

    // Step 2: For each discovered team, check invitations
    for (const team of discovered) {
      try {
        const invAdapter = new SyncServerAdapter({
          apiUrl: syncUrl,
          apiKey,
          repo: `__invitations__/${team.name}`,
          developerId: agentId,
        })

        const invResult = await invAdapter.pull()
        if (invResult?.entries) {
          for (const [key, value] of Object.entries(invResult.entries)) {
            if (!key.startsWith('inv/') || !value) continue
            try {
              const inv = JSON.parse(value)
              if (inv.toAgentId === agentId) {
                invited.push({
                  id: inv.id,
                  teamName: inv.teamName || team.name,
                  fromAgentId: inv.fromAgentId,
                  fromAgentName: inv.fromAgentName,
                  toAgentId: inv.toAgentId,
                  toAgentName: inv.toAgentName,
                  message: inv.message || '',
                  status: inv.status || 'pending',
                  createdAt: inv.createdAt || '',
                })
              }
            } catch {
              // Skip malformed entries
            }
          }
        }
      } catch {
        // Skip teams whose invitation repos are unreachable
      }
    }
  } catch (err) {
    // Cloud unreachable — return what we have (empty is fine)
    console.warn('[teamDiscovery] Cloud scan failed:', err instanceof Error ? err.message : String(err))
  }

  return { discovered, invited }
}
