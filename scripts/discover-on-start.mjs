#!/usr/bin/env node
/**
 * SessionStart hook — team discovery + invitation scan.
 * Runs on every Claude Code session start.
 * Outputs system-reminder if teams/invitations are found.
 */

const syncUrl = process.env.TEAM_MEMORY_SYNC_URL

if (!syncUrl) process.exit(0)

try {
  // Use stable identity instead of session-specific CLAUDE_CODE_AGENT_ID
  const { getStableAgentId } = await import('../dist/core/agentIdentity.js')
  const agentId = getStableAgentId()
  // Ensure env var is set for downstream scanCloud()
  process.env.CLAUDE_CODE_AGENT_ID = agentId

  const { scanCloud } = await import('../dist/core/teamDiscovery.js')
  const discovery = await scanCloud()

  if (discovery.invited.length === 0 && discovery.discovered.length === 0) {
    process.exit(0)
  }

  const lines = []
  if (discovery.invited.length > 0) {
    lines.push(`📨 待处理邀请 (${discovery.invited.length}):`)
    for (const inv of discovery.invited) {
      lines.push(`  • ${inv.teamName} ← ${inv.fromAgentName}: "${inv.message}"`)
    }
  }
  if (discovery.discovered.length > 0) {
    lines.push(`🔍 可发现的团队 (${discovery.discovered.length}):`)
    for (const t of discovery.discovered) {
      lines.push(`  • ${t.name} (${t.memberCount}人, ${t.description || '无描述'})`)
    }
  }
  lines.push('')
  lines.push('输入 "加入 <团队名>" 接受邀请, "查看 <团队名>" 看详情, 或 "忽略" 关闭')

  console.log(`<system-reminder>\n[TeamDiscovery] 发现云端团队:\n${lines.join('\n')}\n</system-reminder>`)
} catch (err) {
  // Silent fail — discovery is non-critical
}
