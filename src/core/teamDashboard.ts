/**
 * Team Status Dashboard TUI
 *
 * A lightweight terminal dashboard that renders team status in real-time.
 * Equivalent to zelliz.md's team_dashboard.py but in TypeScript/Node.js.
 *
 * Usage:
 *   node dist/core/teamDashboard.js [teamName]
 *
 * Or integrated as a pane in the swarm view.
 *
 * Renders:
 * ┌─────────────────────────────────────────────┐
 * │  Team: auth-refactor    Status: In Progress │
 * ├──────────┬──────────┬───────────┬──────────┤
 * │ Name     │ Role     │ Status    │ Task     │
 * ├──────────┼──────────┼───────────┼──────────┤
 * │ team-lead│ Lead     │ ● Active  │ -        │
 * │ dev-1    │ Backend  │ ● Running │ Migrate  │
 * │ dev-2    │ Frontend │ ○ Idle    │ Review   │
 * └──────────┴──────────┴───────────┴──────────┘
 */

import { readTeamFile, pullTeamFromCloud } from './teamFile.js'
import type { TeamFile } from './types.js'
import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'

// ============================================================
// Message helpers (inline to avoid external dependency in dashboard)
// ============================================================

/**
 * Reads an agent's inbox file and returns the latest message.
 * Uses plain readFileSync — no locking needed for read-only access.
 */
function readLatestInboxMessage(agentName: string, teamName: string): { type?: string; summary?: string; text?: string } | null {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~'
  const safeTeam = teamName.replace(/[^\p{L}\p{N}._-]/gu, '-').toLowerCase()
  const safeAgent = agentName.replace(/[^\p{L}\p{N}._-]/gu, '-').toLowerCase()
  const inboxPath = join(homeDir, '.claude', 'teams', safeTeam, 'inboxes', `${safeAgent}.json`)

  try {
    if (!existsSync(inboxPath)) return null
    const content = readFileSync(inboxPath, 'utf-8')
    const messages = JSON.parse(content) as Array<{ type?: string; summary?: string; text?: string }>
    if (!Array.isArray(messages) || messages.length === 0) return null
    // Return the latest message
    return messages[messages.length - 1]
  } catch {
    return null
  }
}

// ============================================================
// Types
// ============================================================

export interface DashboardTeamState {
  name: string
  status: 'In Progress' | 'Idle' | 'Completed' | 'Setup Required'
  members: DashboardMember[]
  lastUpdated: string
  /** FIX(P6/P7): Cloud connection status for visibility */
  cloudStatus?: { state: string; since: string }
  /** FIX(P7): Remote members from cloud (merged with local) */
  remoteMemberCount?: number
}

export interface DashboardMember {
  name: string
  role: string
  status: 'running' | 'idle' | 'unknown'
  task: string
  idleSince?: string
  color?: string
}

// ============================================================
// Dashboard Renderer
// ============================================================

/**
 * Renders the team dashboard as a string for terminal output.
 */
export function renderDashboard(state: DashboardTeamState): string {
  const width = Math.max(60, getTerminalWidth())

  // Header
  const header = `╔${'═'.repeat(width - 2)}╗`
  const cloudLine = state.cloudStatus
    ? `║  Cloud: ${state.cloudStatus.state.padEnd(width - 12)}║`
    : ''
  const titleLine = `║  Team: ${state.name.padEnd(width - 11)}║`
  const statusLine = `║  Status: ${state.status.padEnd(width - 12)}║`
  const updatedLine = `║  Updated: ${state.lastUpdated.padEnd(width - 13)}║`
  const separator = `╠${'═'.repeat(width - 2)}╣`

  // Table header
  const colName = 14
  const colRole = 14
  const colStatus = 14
  const colTask = width - colName - colRole - colStatus - 7

  const hdr = `║ ${'Name'.padEnd(colName)}│ ${'Role'.padEnd(colRole)}│ ${'Status'.padEnd(colStatus)}│ ${'Task'.padEnd(Math.max(colTask, 10))} ║`
  const hdrSep = `╟${'─'.repeat(colName + 2)}┼${'─'.repeat(colRole + 2)}┼${'─'.repeat(colStatus + 2)}┼${'─'.repeat(Math.max(colTask, 10) + 3)}╢`

  // Member rows
  const rows = state.members.map(m => {
    const statusIcon = m.status === 'running' ? '● Running' : m.status === 'idle' ? '○ Idle' : '? Unknown'
    const taskPreview = m.task.length > Math.max(colTask, 10) ? m.task.slice(0, Math.max(colTask, 10) - 3) + '...' : m.task
    return `║ ${m.name.padEnd(colName)}│ ${m.role.padEnd(colRole)}│ ${statusIcon.padEnd(colStatus)}│ ${taskPreview.padEnd(Math.max(colTask, 10))} ║`
  })

  const footer = `╚${'═'.repeat(width - 2)}╝`

  return [
    header,
    ...(cloudLine ? [cloudLine] : []),
    titleLine,
    statusLine,
    updatedLine,
    separator,
    hdr,
    hdrSep,
    ...rows,
    footer,
  ].join('\n')
}

/**
 * Reads the current team state and converts to DashboardTeamState.
 * Supports merging cloud team data for multi-machine visibility.
 * Returns a guide state when no team is configured (never returns null).
 */
export function readTeamState(teamName: string, cloudTeam?: TeamFile | null): DashboardTeamState {
  // Start with local team file
  let teamFile = readTeamFile(teamName)

  // If no local file but cloud has data, use cloud data
  if (!teamFile) {
    if (!cloudTeam) {
      return {
        name: '未配置团队',
        status: 'Setup Required',
        members: [{
          name: '—',
          role: '—',
          status: 'idle',
          task: '在 Leader 中输入: 创建团队 <名称>',
          idleSince: undefined,
          color: undefined,
        }],
        lastUpdated: new Date().toISOString().slice(0, 19).replace('T', ' '),
      }
    }
    // Use cloud team as the source
    teamFile = cloudTeam
  }

  // FIX(multi-machine): Merge cloud members into the team file
  // If cloud team has more members (or different ones), union them
  if (cloudTeam && cloudTeam.members) {
    const localMemberMap = new Map(teamFile.members.map(m => [m.agentId, m]))
    for (const cloudMember of cloudTeam.members) {
      if (!localMemberMap.has(cloudMember.agentId)) {
        // Add cloud-only member with default runtime fields
        teamFile = {
          ...teamFile,
          members: [
            ...teamFile.members,
            {
              ...cloudMember,
              tmuxPaneId: cloudMember.tmuxPaneId || '',
              cwd: cloudMember.cwd || '',
              subscriptions: cloudMember.subscriptions || [],
              isActive: cloudMember.isActive ?? false,
              mode: cloudMember.mode || 'auto',
            },
          ],
        }
      }
    }
  }

  const activeMembers = teamFile.members.filter(m => m.agentId !== teamFile.leadAgentId)
  const runningCount = activeMembers.filter(m => m.isActive).length

  const members: DashboardMember[] = teamFile.members.map(m => {
    const isLead = m.agentId === teamFile.leadAgentId
    let task = '—'

    // Try to extract task info from inbox for non-lead members
    if (!isLead) {
      const latestMsg = readLatestInboxMessage(m.name, teamFile!.name)
      if (latestMsg) {
        const msgType = latestMsg.type || ''
        if (msgType.includes('idle') || msgType.includes('completed')) {
          task = 'Idle'
        } else if (msgType.includes('task') || msgType.includes('assign')) {
          task = latestMsg.summary || (latestMsg.text ? latestMsg.text.slice(0, 40) : 'Working')
        } else if (latestMsg.text) {
          task = latestMsg.text.slice(0, 40)
        }
      }
    }

    return {
      name: m.name,
      role: m.agentType || (isLead ? 'Lead' : 'Teammate'),
      status: m.isActive ? 'running' : 'idle',
      task,
      idleSince: m.isActive ? undefined : undefined,
      color: m.color,
    }
  })

  // FIX(P6/P7): Cloud status and remote members checked asynchronously
  // The caller can augment the result with cloudStatus after the fact.
  // This function stays synchronous to support the render loop.

  return {
    name: teamFile.name,
    status: runningCount > 0 ? 'In Progress' : 'Idle',
    members,
    lastUpdated: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }
}

/**
 * FIX(P6/P7): Reads cloud connection status asynchronously.
 * Called by the watch loop to augment the Dashboard state.
 */
async function readCloudStatus(): Promise<{ state: string; since: string } | undefined> {
  try {
    const syncUrl = process.env.TEAM_MEMORY_SYNC_URL
    if (!syncUrl) return undefined
    // Try dynamic import of getCloudStatus from plugin platform layer
    try {
      const mod = await import('../platform/claude-code.js')
      if (mod.getCloudStatus) {
        const cs = mod.getCloudStatus()
        return {
          state: cs.status,
          since: new Date(cs.changedAt).toISOString().slice(0, 19).replace('T', ' '),
        }
      }
    } catch { /* not running inside plugin — fallback to health check */ }
    // Fallback: direct health check
    const resp = await fetch(`${syncUrl}/health`, { signal: AbortSignal.timeout(3000) })
    return resp.ok
      ? { state: 'healthy', since: '' }
      : { state: 'unreachable', since: '' }
  } catch {
    return { state: 'unreachable', since: '' }
  }
}

/**
 * FIX(multi-machine): Pulls full cloud team state (not just member count).
 * Returns the merged TeamFile so the dashboard can show remote members
 * with their details, not just a count.
 */
async function pullCloudTeamFile(teamName: string): Promise<TeamFile | null> {
  try {
    const syncUrl = process.env.TEAM_MEMORY_SYNC_URL
    if (!syncUrl) return null
    const cloudTeam = await pullTeamFromCloud(teamName)
    return cloudTeam
  } catch {
    return null
  }
}

/**
 * Watches the team config file and re-renders the dashboard on changes.
 * FIX(P6/P7): Includes cloud status and cloud team merge for multi-machine visibility.
 */
export function watchAndRenderDashboard(teamName: string, intervalMs = 2000): void {
  const teamFilePath = join(process.env.CLAUDE_PLUGIN_DATA || process.env.HOME || '~', '.claude', 'teams', teamName, 'config.json')

  let lastMtime = 0
  let cacheCloudStatus: { state: string; since: string } | undefined
  let cacheCloudTeam: TeamFile | null = null
  let cloudCheckInterval = 0 // tick counter for 30s cloud refresh

  async function render() {
    // FIX(multi-machine): Pull full cloud team data, not just count
    cloudCheckInterval++
    if (cloudCheckInterval >= 15) {
      cloudCheckInterval = 0
      cacheCloudStatus = await readCloudStatus()
      cacheCloudTeam = await pullCloudTeamFile(teamName)
    }

    const state = readTeamState(teamName, cacheCloudTeam)
    if (state) {
      if (cacheCloudStatus) state.cloudStatus = cacheCloudStatus
      if (cacheCloudTeam) {
        const remoteMembers = cacheCloudTeam.members.filter(cm =>
          !state.members.some(m => m.name === cm.name),
        )
        if (remoteMembers.length > 0) {
          state.remoteMemberCount = cacheCloudTeam.members.length
        }
      }
      console.log('\x1Bc') // Clear screen
      console.log(renderDashboard(state))
    }
  }

  // Initial render (with cloud check)
  void (async () => {
    cacheCloudStatus = await readCloudStatus()
    cacheCloudTeam = await pullCloudTeamFile(teamName)
    await render()
  })()

  // Poll-based update (more reliable than fs.watch)
  const timer = setInterval(() => {
    if (existsSync(teamFilePath)) {
      try {
        const stat = statSync(teamFilePath)
        if (stat.mtimeMs !== lastMtime) {
          lastMtime = stat.mtimeMs
        }
      } catch {
        // Ignore stat errors
      }
    }
    void render()
  }, intervalMs)

  // Allow process to exit cleanly
  process.on('SIGINT', () => {
    clearInterval(timer)
    process.exit(0)
  })
}

/**
 * Gets terminal width (fallback to 80).
 */
function getTerminalWidth(): number {
  if (process.stdout.isTTY) {
    return process.stdout.columns || 80
  }
  return 80
}

// ============================================================
// CLI Entry Point
// ============================================================

if (process.argv[1]?.endsWith('teamDashboard.js')) {
  const teamName = process.argv[2] || process.env.CLAUDE_CODE_TEAM_NAME
  if (!teamName) {
    console.error('Usage: node teamDashboard.js <team-name>')
    console.error('   or: CLAUDE_CODE_TEAM_NAME=myteam node teamDashboard.js')
    process.exit(1)
  }

  console.log(`Team Dashboard: ${teamName}`)
  console.log('Press Ctrl+C to exit\n')
  watchAndRenderDashboard(teamName)
}
