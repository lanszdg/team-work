#!/usr/bin/env node
/**
 * UserPromptSubmit hook handler.
 * Intercepts user input to handle team-collab commands:
 *   "加入 <team>"      → accept invitation + start heartbeat
 *   "忽略"             → dismiss pending notifications
 *   "我的任务"          → list ready tasks for this agent
 *   "我的邀请" / "查询邀请" → show pending invitations
 *   "查看 <team>"       → show team details
 *   "任务状态"          → show all tasks for current team
 *   "my tasks"         → alias for 我的任务
 *   "my invitations"   → alias for 我的邀请
 */

import { handleJoinCommand } from '../dist/platform/claude-code.js'

const userInput = (process.argv[2] || '').trim()

if (!userInput) process.exit(0)

// ── Join command ──
const joinResult = await handleJoinCommand(userInput)
if (joinResult) {
  console.log(`<system-reminder>\n${joinResult}\n</system-reminder>`)
  process.exit(0)
}

// ── Task query commands ──
const taskPatterns = [
  /^(我的任务|my\s+tasks?)$/i,
  /^(查询任务|list\s+tasks?)$/i,
]

if (taskPatterns.some(p => p.test(userInput))) {
  try {
    const { getStableAgentId } = await import('../dist/core/agentIdentity.js')
    const agentId = getStableAgentId()
    const teamName = process.env.TEAM_NAME || process.env.CLAUDE_CODE_TEAM_NAME

    if (!teamName) {
      console.log(`<system-reminder>\n[TaskQuery] 未加入任何团队。请先使用 "加入 <团队名>" 加入团队。\n</system-reminder>`)
      process.exit(0)
    }

    const syncUrl = process.env.TEAM_MEMORY_SYNC_URL
    if (!syncUrl) {
      console.log(`<system-reminder>\n[TaskQuery] TEAM_MEMORY_SYNC_URL 未配置。\n</system-reminder>`)
      process.exit(0)
    }

    const { TaskStore } = await import('../dist/core/taskStore.js')
    const { getConfiguredApiKey } = await import('../dist/core/cloudConfig.js')
    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')

    const apiKey = getConfiguredApiKey()
    const adapter = new SyncServerAdapter({
      apiUrl: syncUrl,
      apiKey,
      repo: `${teamName}__tasks`,
      developerId: agentId,
    })

    const taskStore = new TaskStore({ adapter, teamName })

    // Get role from env or default to developer
    const agentRole = process.env.AGENT_ROLE || 'developer'
    const tasks = await taskStore.listReadyTasks(agentRole, agentId)

    if (tasks.length === 0) {
      console.log(`<system-reminder>\n[TaskQuery] 当前没有可认领的任务。\n  团队: ${teamName}\n  身份: ${agentId}\n  角色: ${agentRole}\n</system-reminder>`)
    } else {
      const lines = [`[TaskQuery] 可认领任务 (${tasks.length}):`]
      for (const t of tasks) {
        const assigned = t.assignedToAgentId ? ` [指派给: ${t.assignedToAgentId}]` : ''
        const role = t.requiredRole ? ` [需要角色: ${t.requiredRole}]` : ''
        lines.push(`  - [${t.status}] ${t.title} (${t.taskId})${assigned}${role}`)
        if (t.description) lines.push(`    ${t.description.slice(0, 100)}`)
      }
      lines.push(`\n  团队: ${teamName} | 身份: ${agentId} | 角色: ${agentRole}`)
      console.log(`<system-reminder>\n${lines.join('\n')}\n</system-reminder>`)
    }
  } catch (err) {
    console.log(`<system-reminder>\n[TaskQuery] 查询失败: ${err instanceof Error ? err.message : String(err)}\n</system-reminder>`)
  }
  process.exit(0)
}

// ── Invitation query commands ──
const invPatterns = [
  /^(我的邀请|查询邀请|my\s+invitations?)$/i,
  /^(查询给我的邀请)$/i,
]

if (invPatterns.some(p => p.test(userInput))) {
  try {
    const { getStableAgentId } = await import('../dist/core/agentIdentity.js')
    const agentId = getStableAgentId()
    process.env.CLAUDE_CODE_AGENT_ID = agentId

    const { scanCloud } = await import('../dist/core/teamDiscovery.js')
    const discovery = await scanCloud()

    if (discovery.invited.length === 0) {
      console.log(`<system-reminder>\n[InvitationQuery] 没有待处理的邀请。\n  身份: ${agentId}\n</system-reminder>`)
    } else {
      const lines = [`[InvitationQuery] 待处理邀请 (${discovery.invited.length}):`]
      for (const inv of discovery.invited) {
        lines.push(`  - ${inv.teamName} ← ${inv.fromAgentName}: "${inv.message}" [${inv.status}]`)
      }
      lines.push(`\n  身份: ${agentId}`)
      lines.push('输入 "加入 <团队名>" 接受邀请。')
      console.log(`<system-reminder>\n${lines.join('\n')}\n</system-reminder>`)
    }
  } catch (err) {
    console.log(`<system-reminder>\n[InvitationQuery] 查询失败: ${err instanceof Error ? err.message : String(err)}\n</system-reminder>`)
  }
  process.exit(0)
}

// ── Team details command ──
const viewMatch = userInput.match(/^(查看|view)\s+(.+)$/i)
if (viewMatch) {
  try {
    const targetTeam = viewMatch[2].trim()
    const { getStableAgentId } = await import('../dist/core/agentIdentity.js')
    const agentId = getStableAgentId()
    process.env.CLAUDE_CODE_AGENT_ID = agentId

    const { scanCloud } = await import('../dist/core/teamDiscovery.js')
    const discovery = await scanCloud()

    const team = discovery.discovered.find(t => t.name === targetTeam)
    if (!team) {
      console.log(`<system-reminder>\n[TeamView] 未找到团队 "${targetTeam}"。\n可用团队: ${discovery.discovered.map(t => t.name).join(', ') || '无'}\n</system-reminder>`)
    } else {
      const lines = [
        `[TeamView] 团队详情: ${team.name}`,
        `  描述: ${team.description || '无'}`,
        `  Leader: ${team.leadAgentName} (${team.leadAgentId})`,
        `  成员数: ${team.memberCount}`,
        `  创建时间: ${team.createdAt}`,
      ]
      const myInvites = discovery.invited.filter(i => i.teamName === targetTeam)
      if (myInvites.length > 0) {
        lines.push(`  待处理邀请: ${myInvites.length}`)
        for (const inv of myInvites) {
          lines.push(`    - 来自 ${inv.fromAgentName}: "${inv.message}"`)
        }
        lines.push('输入 "加入 ' + targetTeam + '" 接受邀请。')
      }
      console.log(`<system-reminder>\n${lines.join('\n')}\n</system-reminder>`)
    }
  } catch (err) {
    console.log(`<system-reminder>\n[TeamView] 查询失败: ${err instanceof Error ? err.message : String(err)}\n</system-reminder>`)
  }
  process.exit(0)
}

// ── Task status command ──
const statusPatterns = [
  /^(任务状态|task\s+status)$/i,
]

if (statusPatterns.some(p => p.test(userInput))) {
  try {
    const { getStableAgentId } = await import('../dist/core/agentIdentity.js')
    const agentId = getStableAgentId()
    const teamName = process.env.TEAM_NAME || process.env.CLAUDE_CODE_TEAM_NAME

    if (!teamName) {
      console.log(`<system-reminder>\n[TaskStatus] 未加入任何团队。\n</system-reminder>`)
      process.exit(0)
    }

    const syncUrl = process.env.TEAM_MEMORY_SYNC_URL
    if (!syncUrl) {
      console.log(`<system-reminder>\n[TaskStatus] TEAM_MEMORY_SYNC_URL 未配置。\n</system-reminder>`)
      process.exit(0)
    }

    const { TaskStore } = await import('../dist/core/taskStore.js')
    const { getConfiguredApiKey } = await import('../dist/core/cloudConfig.js')
    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')

    const apiKey = getConfiguredApiKey()
    const adapter = new SyncServerAdapter({
      apiUrl: syncUrl,
      apiKey,
      repo: `${teamName}__tasks`,
      developerId: agentId,
    })

    const taskStore = new TaskStore({ adapter, teamName })
    const allTasks = await taskStore.listTasks()

    if (allTasks.length === 0) {
      console.log(`<system-reminder>\n[TaskStatus] 团队 "${teamName}" 暂无任务。\n</system-reminder>`)
    } else {
      const myTasks = allTasks.filter(t => t.claimedByAgentId === agentId || t.assignedToAgentId === agentId)
      const lines = [`[TaskStatus] 团队 "${teamName}" 任务概览:`]
      lines.push(`  总任务: ${allTasks.length} | 我的任务: ${myTasks.length}`)
      lines.push('')

      const byStatus = {}
      for (const t of allTasks) {
        if (!byStatus[t.status]) byStatus[t.status] = []
        byStatus[t.status].push(t)
      }

      for (const [status, tasks] of Object.entries(byStatus)) {
        lines.push(`  [${status}] (${tasks.length}):`)
        for (const t of tasks) {
          const mine = (t.claimedByAgentId === agentId || t.assignedToAgentId === agentId) ? ' ★' : ''
          lines.push(`    - ${t.title} (${t.taskId.slice(0, 8)})${mine}`)
        }
      }

      lines.push(`\n  ★ = 我的任务 | 身份: ${agentId}`)
      console.log(`<system-reminder>\n${lines.join('\n')}\n</system-reminder>`)
    }
  } catch (err) {
    console.log(`<system-reminder>\n[TaskStatus] 查询失败: ${err instanceof Error ? err.message : String(err)}\n</system-reminder>`)
  }
  process.exit(0)
}
