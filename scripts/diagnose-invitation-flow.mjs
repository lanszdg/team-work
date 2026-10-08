#!/usr/bin/env node
/**
 * Superpowers Phase 1: Invitation Flow Latency Diagnostic
 *
 * Measures EVERY serial HTTP call in the invitation/accept flow.
 * Run: node scripts/diagnose-invitation-flow.mjs
 */

const SYNC_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'
const H = { 'Content-Type': 'application/json', 'X-API-Key': API_KEY, 'X-Developer-ID': 'diag' }

async function t(name, fn) {
  const s = performance.now()
  try {
    const r = await fn()
    return { name, ms: Math.round(performance.now() - s), ok: true }
  } catch (e) {
    return { name, ms: Math.round(performance.now() - s), ok: false, err: e.message }
  }
}

async function main() {
  const results = []
  const NOW = Date.now()

  // ===============================================================
  // Scenario: User creates project → queries invitations → accepts
  // ===============================================================

  // Step 1: discoverCloudTeams (pulls __teams__ repo)
  results.push(await t('1. discoverCloudTeams (pull __teams__)', async () => {
    const r = await fetch(SYNC_URL + '/api/team_memory?repo=__teams__&_=' + NOW, { headers: H })
    return r.status
  }))

  // Step 2: getInvitations for 5 discovered teams (each is an HTTP pull)
  for (let i = 1; i <= 5; i++) {
    results.push(await t('2.' + i + ' getInvitations team-' + i + ' (pull inv repo)', async () => {
      const r = await fetch(SYNC_URL + '/api/team_memory?repo=__invitations__/t' + i + '&_=' + NOW, { headers: H })
      return r.status
    }))
  }

  // Step 3: acceptInvitation — full chain
  const testKey = 'inv/test-' + NOW

  // 3a: _updateInvitationStatus — force pull (setEtag undefined)
  results.push(await t('3a. accept: _updateInvitationStatus → pull', async () => {
    const r = await fetch(SYNC_URL + '/api/team_memory?repo=__invitations__/diag&_=' + NOW, { headers: H })
    return r.status
  }))

  // 3b: _updateInvitationStatus — push updated status
  results.push(await t('3b. accept: _updateInvitationStatus → push', async () => {
    const r = await fetch(SYNC_URL + '/api/team_memory?repo=__invitations__/diag', {
      method: 'PUT', headers: H,
      body: JSON.stringify({
        entries: {
          [testKey]: JSON.stringify({ id: 'inv1', status: 'accepted', respondedAt: new Date().toISOString() })
        }
      })
    })
    return r.status
  }))

  // 3c: _syncTeamDataAfterAccept → pull __teams__ for team metadata
  results.push(await t('3c. accept: syncTeamData → pull __teams__', async () => {
    const r = await fetch(SYNC_URL + '/api/team_memory?repo=__teams__&_=' + NOW, { headers: H })
    return r.status
  }))

  // 3d: _syncTeamDataAfterAccept → pull team state repo
  results.push(await t('3d. accept: syncTeamData → pull team repo', async () => {
    const r = await fetch(SYNC_URL + '/api/team_memory?repo=diag-team&_=' + NOW, { headers: H })
    return r.status
  }))

  // 3e: _syncTeamDataAfterAccept → push own membership
  results.push(await t('3e. accept: syncTeamData → push membership', async () => {
    const r = await fetch(SYNC_URL + '/api/team_memory?repo=diag-team', {
      method: 'PUT', headers: H,
      body: JSON.stringify({
        entries: { 'members/diag': JSON.stringify({ agentId: 'diag', name: 'me', agentType: 'worker', joinedAt: NOW, isActive: true }) }
      })
    })
    return r.status
  }))

  // Step 4: sendInvitation (leader side)
  const invKey = 'inv/send-' + NOW
  results.push(await t('4a. sendInvitation → push to inv repo', async () => {
    const r = await fetch(SYNC_URL + '/api/team_memory?repo=__invitations__/diag', {
      method: 'PUT', headers: H,
      body: JSON.stringify({
        entries: {
          [invKey]: JSON.stringify({ id: 'inv2', fromAgentId: 'a1', fromAgentName: 'leader', toAgentId: 'diag', toAgentName: 'me', teamName: 'diag', message: 'join us', status: 'pending', createdAt: new Date().toISOString() })
        }
      })
    })
    return r.status
  }))

  results.push(await t('4b. sendInvitation → postEvent (SSE broadcast)', async () => {
    const r = await fetch(SYNC_URL + '/api/team_memory/events?repo=__invitations__/diag', {
      method: 'POST', headers: H,
      body: JSON.stringify({ type: 'invite', data: { invitationId: 'inv2', fromAgentId: 'a1', fromAgentName: 'leader', teamName: 'diag' } })
    })
    return r.status
  }))

  // ===============================================================
  // Report
  // ===============================================================
  console.log('')
  console.log('═══ Invitation Flow: Serial HTTP Call Chain ═══')
  console.log('')
  console.log('操作'.padEnd(52) + '耗时    累计')
  console.log('─'.repeat(52) + '────   ────')
  let total = 0
  const groups = { discover: [], getInvites: [], updateStatus: [], syncData: [], sendInv: [] }

  for (const r of results) {
    total += r.ms
    const bar = '▓'.repeat(Math.min(40, Math.round(r.ms / 2)))
    console.log(r.name.padEnd(52) + String(r.ms).padStart(4) + 'ms ' + String(total).padStart(5) + 'ms ' + bar)

    if (r.name.includes('discoverCloudTeams')) groups.discover.push(r)
    else if (r.name.includes('getInvitations')) groups.getInvites.push(r)
    else if (r.name.includes('updateInvitationStatus')) groups.updateStatus.push(r)
    else if (r.name.includes('syncTeamData')) groups.syncData.push(r)
    else if (r.name.includes('sendInvitation')) groups.sendInv.push(r)
  }

  console.log('')
  console.log('═══ 分析 ═══')
  console.log('')
  console.log('总 HTTP 请求数: ' + results.length)
  console.log('总串行耗时:     ' + total + 'ms (' + (total / 1000).toFixed(2) + 's)')
  console.log('')

  // Parallel potential
  console.log('如果改成并行执行:')
  const groupNames = [
    ['发现云团队 (discoverCloudTeams)', groups.discover],
    ['查询邀请 (getInvitations ×5)', groups.getInvites],
    ['更新邀请状态 (pull+push)', groups.updateStatus],
    ['同步团队数据 (pull×2+push)', groups.syncData],
    ['发送邀请 (push+postEvent)', groups.sendInv],
  ]
  let parallelTotal = 0
  for (const [name, group] of groupNames) {
    if (group.length === 0) continue
    const serial = group.reduce((a, b) => a + b.ms, 0)
    const parallel = Math.max(...group.map(r => r.ms))
    parallelTotal += parallel
    const savings = serial - parallel
    console.log('  ' + name.padEnd(35) + ' 串行:' + String(serial).padStart(4) + 'ms → 并行:' + String(parallel).padStart(4) + 'ms (省' + savings + 'ms)')
  }
  console.log('')
  console.log('  并行化后预估总耗时: ~' + parallelTotal + 'ms (当前 ' + total + 'ms, 提升 ' + (total / Math.max(1, parallelTotal)).toFixed(1) + 'x)')
  console.log('')
}

main().catch(e => { console.error(e); process.exit(1) })
