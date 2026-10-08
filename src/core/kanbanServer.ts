/**
 * Kanban Board Server
 *
 * Standalone HTTP server that aggregates team state from the cloud sync server
 * and serves a real-time Kanban board via browser polling.
 *
 * Architecture:
 * - HTTP Server on localhost:8090 (configurable)
 * - Data sources: Sync Server KV (team_state, members/*), events API
 * - Browser polls /api/state every 3s
 * - Read-only aggregation — no writes to cloud state
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { SyncServerAdapter, SyncServerError } from './syncServerAdapter.js'
import { getConfiguredSyncUrl, getConfiguredApiKey } from './cloudConfig.js'
import { projectAllAgentTaskStates, type AgentTaskProjection } from './taskProjection.js'
import type { TeamTask } from './types.js'

// ============================================================
// Embedded HTML Page
// ============================================================

const __dirname = dirname(fileURLToPath(import.meta.url))
const KANBAN_HTML_PATH = join(__dirname, 'kanbanPage.html')

let _htmlCache: string | null = null

function getKanbanHtml(): string {
  if (_htmlCache) return _htmlCache
  _htmlCache = readFileSync(KANBAN_HTML_PATH, 'utf-8')
  return _htmlCache
}

// ============================================================
// Types
// ============================================================

export interface KanbanMember {
  name: string
  agentId: string
  role: string          // agentType: coordinator, coder, reviewer, etc.
  machine: string
  status: 'online' | 'idle' | 'offline'
  mode: string
  task: string
  workState?: AgentTaskProjection['workState']
  currentTaskId?: string
  taskStatus?: string
}

export interface KanbanState {
  teamName: string
  teamDescription: string
  leadName: string
  members: KanbanMember[]
  teamTasks: Array<{ member: string; task: string }>
  cloudStatus: 'healthy' | 'degraded' | 'offline' | 'unknown'
  timestamp: string
  onlineCount: number
  totalMembers: number
}

export interface TeamListItem {
  name: string
  description: string
  memberCount: number
}

// ============================================================
// Cloud State Aggregation
// ============================================================

/**
 * Build a SyncServerAdapter from environment variables.
 * Falls back to defaults matching teamFile.ts behavior.
 */
function createAdapter(teamName: string): SyncServerAdapter {
  const syncUrl = getConfiguredSyncUrl()
  if (!syncUrl) {
    throw new Error(
      'TEAM_MEMORY_SYNC_URL is not set (or enable TEAM_COLLAB_DEMO_MODE=1). ' +
      'Kanban server requires cloud sync configuration.',
    )
  }

  const apiKey = getConfiguredApiKey()

  return new SyncServerAdapter({
    apiUrl: syncUrl,
    apiKey,
    repo: teamName,
    developerId: process.env.CLAUDE_CODE_AGENT_ID || 'kanban-server',
  })
}

function createTaskAdapter(teamName: string): SyncServerAdapter {
  const syncUrl = getConfiguredSyncUrl()
  if (!syncUrl) {
    throw new Error(
      'TEAM_MEMORY_SYNC_URL is not set (or enable TEAM_COLLAB_DEMO_MODE=1). ' +
      'Kanban server requires cloud sync configuration.',
    )
  }

  return new SyncServerAdapter({
    apiUrl: syncUrl,
    apiKey: getConfiguredApiKey(),
    repo: `${teamName}__tasks`,
    developerId: process.env.CLAUDE_CODE_AGENT_ID || 'kanban-server',
  })
}

interface TeamDataResult {
  members: Array<{ name: string; agentId: string; role: string; mode?: string; hostname?: string; task?: string }>
  description: string
  leadName: string
}

function extractTeamData(entries: Record<string, string>): TeamDataResult {
  const empty: TeamDataResult = { members: [], description: '', leadName: '' }

  if (Object.keys(entries).length === 0) return empty

  const teamStateRaw = entries['team_state']
  if (teamStateRaw) {
    try {
      const teamFile = JSON.parse(teamStateRaw)
      const leadMember = teamFile.members?.find((m: { agentId: string }) => m.agentId === teamFile.leadAgentId)

      const members = (teamFile.members || [])
        .map((m: { name: string; agentId: string; agentType?: string; mode?: string; prompt?: string; hostname?: string }) => ({
          name: m.name,
          agentId: m.agentId,
          role: m.agentType || 'member',
          mode: m.mode || 'auto',
          hostname: m.hostname || 'unknown',
          task: m.prompt ? m.prompt.substring(0, 60) : '',
        }))

      return {
        members,
        description: teamFile.description || '',
        leadName: leadMember?.name || 'Leader',
      }
    } catch {
      // Fall through to members/* reconstruction
    }
  }

  const members: TeamDataResult['members'] = []
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith('members/')) continue
    try {
      const m = JSON.parse(value)
      members.push({
        name: m.name,
        agentId: m.agentId,
        role: m.agentType || 'member',
        mode: m.mode || 'auto',
        hostname: m.hostname || 'unknown',
      })
    } catch {
      // Skip malformed entries
    }
  }
  return { members, description: '', leadName: '' }
}

function extractOnlineAgentIds(entries: Record<string, string>): Set<string> {
  const onlineIds = new Set<string>()

  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith('presence/') || !value) continue
    try {
      const presence = JSON.parse(value)
      if (presence.isActive === true) {
        onlineIds.add(presence.agentId)
      }
    } catch {
      // Skip malformed entries
    }
  }

  if (onlineIds.size === 0) {
    for (const [key, value] of Object.entries(entries)) {
      if (!key.startsWith('members/') || !value) continue
      try {
        const member = JSON.parse(value)
        if (member.isActive === true) {
          onlineIds.add(member.agentId)
        }
      } catch {
        // Skip malformed entries
      }
    }
  }

  return onlineIds
}

export function extractTaskProjectionFromEntries(entries: Record<string, string>): Map<string, AgentTaskProjection> {
  const tasks: TeamTask[] = []
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith('task_store/') || !value) continue
    try {
      tasks.push(JSON.parse(value) as TeamTask)
    } catch {
      // Skip malformed task entries; dashboard is a read-only projection.
    }
  }
  return projectAllAgentTaskStates(tasks)
}

async function buildKanbanState(teamName: string): Promise<KanbanState> {
  const adapter = createAdapter(teamName)

  let entries: Record<string, string> = {}
  let cloudStatus: 'healthy' | 'degraded' | 'offline' = 'offline'

  try {
    const result = await Promise.race([
      adapter.pull(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ])

    if (result === null) {
      cloudStatus = 'degraded'
    } else {
      cloudStatus = 'healthy'
      entries = result.entries
    }
  } catch (err) {
    if (err instanceof SyncServerError && err.status === 404) {
      cloudStatus = 'degraded'
    }
    console.warn('[KanbanServer] Cloud pull failed:',
      err instanceof Error ? err.message : String(err))
  }

  const teamData = extractTeamData(entries)
  const onlineIds = extractOnlineAgentIds(entries)
  let taskProjection = new Map<string, AgentTaskProjection>()

  try {
    const taskResult = await createTaskAdapter(teamName).pull()
    taskProjection = extractTaskProjectionFromEntries(taskResult?.entries ?? {})
  } catch (err) {
    if (!(err instanceof SyncServerError && err.status === 404)) {
      console.warn('[KanbanServer] TaskStore projection pull failed:',
        err instanceof Error ? err.message : String(err))
    }
  }

  const kanbanMembers: KanbanMember[] = teamData.members.map((m) => {
    const projection = taskProjection.get(m.agentId)
    return {
      name: m.name,
      agentId: m.agentId,
      role: m.role,
      machine: m.hostname || 'unknown',
      status: onlineIds.size > 0
        ? (onlineIds.has(m.agentId) ? 'online' : 'offline')
        : 'idle',
      mode: m.mode || 'auto',
      task: projection?.currentTaskTitle || m.task || '-',
      workState: projection?.workState,
      currentTaskId: projection?.currentTaskId,
      taskStatus: projection?.taskStatus,
    }
  })

  const onlineCount = onlineIds.size > 0
    ? kanbanMembers.filter(m => m.status === 'online').length
    : -1

  // Extract team-level tasks from members who have tasks
  const teamTasks = teamData.members
    .map(m => {
      const projection = taskProjection.get(m.agentId)
      return projection?.currentTaskTitle
        ? { member: m.name, task: projection.currentTaskTitle }
        : (m.task ? { member: m.name, task: m.task } : null)
    })
    .filter((item): item is { member: string; task: string } => Boolean(item))

  return {
    teamName,
    teamDescription: teamData.description,
    leadName: teamData.leadName,
    members: kanbanMembers,
    teamTasks,
    cloudStatus,
    timestamp: new Date().toISOString(),
    onlineCount,
    totalMembers: kanbanMembers.length,
  }
}

// ============================================================
// Team Registry (in-memory list of accessed teams)
// ============================================================

const knownTeams = new Map<string, { description: string; memberCount: number }>()

function registerTeam(name: string, description: string, memberCount: number): void {
  knownTeams.set(name, { description, memberCount })
}

// ============================================================
// HTTP Server
// ============================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'application/javascript',
}

/**
 * Start the Kanban board HTTP server.
 *
 * @param teamName - The default team name to display
 * @param port - Port number (default: 8090)
 * @returns The HTTP server instance
 */
export function startKanbanServer(
  teamName: string,
  port: number = 8090,
): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // Route: GET / → serve HTML (supports ?team=X for switching)
    if (url.pathname === '/' && req.method === 'GET') {
      try {
        const html = getKanbanHtml()
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] })
        res.end(html)
      } catch (err) {
        console.error('[KanbanServer] Failed to read HTML:', err)
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal server error: HTML template not found')
      }
      return
    }

    // Route: GET /api/state → return JSON kanban state (?team=X supported)
    if (url.pathname === '/api/state' && req.method === 'GET') {
      try {
        const targetTeam = url.searchParams.get('team') || teamName
        const state = await buildKanbanState(targetTeam)
        // Register this team so it shows in the list
        registerTeam(targetTeam, state.teamDescription, state.totalMembers)
        res.writeHead(200, {
          'Content-Type': MIME_TYPES['.json'],
          'Cache-Control': 'no-cache',
        })
        res.end(JSON.stringify(state))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(500, { 'Content-Type': MIME_TYPES['.json'] })
        res.end(JSON.stringify({ error: message }))
      }
      return
    }

    // Route: GET /api/teams → list known teams
    if (url.pathname === '/api/teams' && req.method === 'GET') {
      const teams: TeamListItem[] = Array.from(knownTeams.entries()).map(([name, info]) => ({
        name,
        description: info.description,
        memberCount: info.memberCount,
      }))
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] })
      res.end(JSON.stringify({ teams, current: teamName }))
      return
    }

    // Route: GET /health → server health check
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.json'] })
      res.end(JSON.stringify({
        status: 'ok',
        teamName,
        port,
        uptime: process.uptime(),
      }))
      return
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  })

  server.listen(port, () => {
    console.log(
      `[KanbanServer] Serving "${teamName}" board at http://localhost:${port}`,
    )
  })

  server.on('error', (err: Error) => {
    console.error('[KanbanServer] Server error:', err.message)
  })

  return server
}
