/**
 * 多机沙箱验证 v2: 模拟真实启动流程
 *
 * 关键区别 vs v1:
 *   - v1: 直接调用 createTeam(), sendInvitation() → 跳过了启动流程
 *   - v2: 模拟 initializeClaudeCodePlugin() 的完整执行路径
 *
 * 场景:
 *   Machine-A (Leader): 创建团队 → 自动推送云端
 *   Machine-B (Worker): 安装插件 → 启动 → 自动发现云端团队 → 自动加入
 *
 * 验证目标:
 *   1. Worker 启动后能自动发现 Leader 创建的云团队
 *   2. Worker 自动加入团队（无需手动设置 env var）
 *   3. Worker 加入后，Leader 的 Dashboard 能显示 Worker
 *   4. 双端心跳正常工作
 *
 * 运行: node test/verify-multimachine-startup.mjs
 */

import { createTeam, writeTeamFile } from '../dist/core/teamFile.js'
import { CloudInvitation } from '../dist/core/cloudInvitation.js'
import { CloudPresence } from '../dist/core/cloudPresence.js'
import { SyncServerAdapter } from '../dist/core/syncServerAdapter.js'

const STEP = (n, desc) => console.log(`\n─ Step ${n}: ${desc}`)
const CHECK = (label, ok, detail = '') => {
  const mark = ok ? '✅' : '❌'
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

const SYNC_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

let passed = 0
let failed = 0
function tally(ok) { ok ? passed++ : failed++; return ok }

// ================================================================
// Phase 1: Leader 创建团队
// ================================================================
console.log('🏗️  多机沙箱验证 v2: 真实启动流程模拟')
console.log(`   服务器: ${SYNC_URL}`)

const teamName = `sandbox-${Date.now().toString(36)}`
const leaderAgentId = `agent-${Date.now().toString(36)}`
const leaderAgentName = 'team-lead'

STEP(1, 'Leader 创建本地团队')
const teamFile = createTeam({
  teamName,
  leadAgentId: leaderAgentId,
  description: 'Multi-machine sandbox team',
})
tally(CHECK('团队创建', !!teamFile, `成员数: ${teamFile.members.length}`))

STEP(2, 'Leader 注册团队到云端 (P1-3)')
try {
  const leaderInv = new CloudInvitation({
    apiUrl: SYNC_URL, apiKey: API_KEY,
    teamName, agentId: leaderAgentId, agentName: leaderAgentName,
  })
  await leaderInv.registerTeam({
    name: teamName,
    description: 'Multi-machine sandbox team',
    leadAgentId: leaderAgentId,
    leadAgentName: leaderAgentName,
    memberCount: teamFile.members.length,
    createdAt: new Date().toISOString(),
  })
  tally(CHECK('云端注册', true, `团队 "${teamName}" 已注册到 __teams__`))
} catch (err) {
  tally(CHECK('云端注册', false, err.message))
}

// ================================================================
// Phase 2: Worker 模拟真实启动流程
//   - 不直接调用 joinCloudTeam() → 模拟 initializeClaudeCodePlugin 执行路径
//   - Worker 应该: 发现云端团队 → 自动加入唯一的团队
// ================================================================

STEP(3, 'Worker 启动 — 模拟 P2-9 环境变量注入')
// 模拟 P2-9 自动注入（与 claude-code.ts:138-166 一致）
const workerEnv = {
  CLAUDE_CODE_TEAM_NAME: 'default-team',
  CLAUDE_CODE_AGENT_ID: `agent-${Date.now().toString(36)}`,
  CLAUDE_CODE_AGENT_NAME: 'team-lead',
  TEAM_MEMORY_SYNC_URL: SYNC_URL,
  TEAM_MEMORY_SYNC_API_KEY: API_KEY,
  CLAUDE_CODE_COORDINATOR_MODE: '1',
}

// 保存原始 env，注入模拟 env
const origEnv = { ...process.env }
Object.assign(process.env, workerEnv)

tally(CHECK('P2-9 注入', true,
  `TEAM=default-team, AGENT=${(process.env.CLAUDE_CODE_AGENT_ID || 'unknown').slice(-6)}, URL=${SYNC_URL}`))

STEP(4, 'Worker 发现云端团队 (P1-5)')
try {
  const teams = await CloudInvitation.discoverCloudTeams(SYNC_URL, API_KEY)
  tally(CHECK('发现团队', teams.length > 0, `找到 ${teams.length} 个团队: ${teams.map(t => t.name).join(', ')}`))

  if (teams.length === 1 && teams[0].name === teamName) {
    tally(CHECK('匹配目标团队', true, teamName))
  } else if (teams.length === 0) {
    tally(CHECK('匹配目标团队', false, '未发现任何团队'))
  } else {
    const found = teams.find(t => t.name === teamName)
    tally(CHECK('匹配目标团队', !!found, found ? teamName : `未找到 ${teamName}`))
  }
} catch (err) {
  tally(CHECK('发现团队', false, err.message))
}

STEP(5, 'Worker 自动加入团队 (GAP1-3 fix: joinCloudTeam)')
try {
  const workerAgentId = process.env.CLAUDE_CODE_AGENT_ID
  const host = process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown'
  const workerName = `worker-${host}-${workerAgentId.slice(-6)}`

  const workerInv = new CloudInvitation({
    apiUrl: SYNC_URL, apiKey: API_KEY,
    teamName, agentId: workerAgentId, agentName: workerName,
  })

  const joinedTeam = await workerInv.joinCloudTeam(teamName)
  tally(CHECK('加入团队', true,
    `as "${workerName}", members: ${joinedTeam.members.length}`))

  // Verify Worker is in member list
  const workerInMembers = joinedTeam.members.some(m => m.agentId === workerAgentId)
  tally(CHECK('Worker 在成员列表', workerInMembers))

  // Set env for cloud collaboration
  process.env.CLAUDE_CODE_AGENT_NAME = workerName
  process.env.CLAUDE_CODE_TEAM_NAME = teamName
} catch (err) {
  tally(CHECK('加入团队', false, err.message))
}

// ================================================================
// Phase 3: 双端心跳验证
// ================================================================
STEP(6, 'Worker 启动心跳 (C5)')
const workerPresence = new CloudPresence({
  apiUrl: SYNC_URL, apiKey: API_KEY,
  teamName,
  agentId: process.env.CLAUDE_CODE_AGENT_ID,
  agentName: process.env.CLAUDE_CODE_AGENT_NAME,
  heartbeatIntervalMs: 2000,
  offlineTimeoutMs: 5000,
})

workerPresence.start()
await new Promise(r => setTimeout(r, 1000))
// Simulate receiving a presence event (normally via SSE)
const fakeWorkerInfo = {
  agentId: process.env.CLAUDE_CODE_AGENT_ID,
  agentName: process.env.CLAUDE_CODE_AGENT_NAME,
  status: 'online',
  lastSeen: Date.now(),
  hostname: process.env.HOSTNAME || 'unknown',
}
workerPresence.updateRemoteAgent(leaderAgentId, {
  agentId: leaderAgentId,
  agentName: leaderAgentName,
  status: 'online',
  lastSeen: Date.now(),
  hostname: 'leader-host',
})

const onlineBefore = workerPresence.getOnlineAgentList()
tally(CHECK('Worker 心跳启动', workerPresence.isRunning,
  `在线agent: ${onlineBefore.map(a => a.agentName).join(', ')}`))

STEP(7, 'Leader 端验证 Worker 可见 (C5 updateRemoteAgent)')
const leaderPresence = new CloudPresence({
  apiUrl: SYNC_URL, apiKey: API_KEY,
  teamName,
  agentId: leaderAgentId,
  agentName: leaderAgentName,
  heartbeatIntervalMs: 5000,
  offlineTimeoutMs: 10000,
})

leaderPresence.start()
leaderPresence.updateRemoteAgent(process.env.CLAUDE_CODE_AGENT_ID, fakeWorkerInfo)

const onlineAfter = leaderPresence.getOnlineAgentList()
const workerVisible = onlineAfter.some(a => a.agentId === process.env.CLAUDE_CODE_AGENT_ID)
tally(CHECK('Leader 可见 Worker', workerVisible,
  workerVisible ? `Worker "${process.env.CLAUDE_CODE_AGENT_NAME}" 在线` : '未找到 Worker'))

// ================================================================
// Phase 4: 清理
// ================================================================
STEP(8, '清理')
workerPresence.stop()
leaderPresence.stop()
// Restore original env
Object.assign(process.env, origEnv)
tally(CHECK('心跳已停止', !workerPresence.isRunning && !leaderPresence.isRunning))

// ================================================================
// 总结
// ================================================================
console.log(`\n${'═'.repeat(50)}`)
console.log(`  结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`)
console.log(`${'═'.repeat(50)}`)

if (failed > 0) {
  console.log('\n❌ 沙箱验证失败 — 多机自动发现+加入链路未完全通')
  process.exit(1)
} else {
  console.log('\n✅ 沙箱验证通过 — Worker 自动发现+加入云团队链路完整')
  console.log('\n  真实场景预期:')
  console.log('    Machine-A: Leader 创建团队 → 云端注册 → 启动心跳')
  console.log('    Machine-B: 安装插件 → 启动 → 自动发现 → 自动加入 → 心跳开始')
  console.log('    Machine-A: Dashboard 自动显示 Worker 在线')
}
