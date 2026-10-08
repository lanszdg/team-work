/**
 * Test: CloudInvitation against the REAL deployed sync server.
 *
 * Validates:
 *   - registerTeam() — pushes team metadata to __teams__ repo
 *   - sendInvitation() — pushes invitation + broadcasts event
 *   - getInvitations() — pulls pending invitations for a given agentId
 *   - acceptInvitation() — updates invitation status on cloud
 *   - declineInvitation() — updates invitation status on cloud
 *   - discoverCloudTeams() — pulls __teams__ repo, returns team list
 *   - Integration: Leader sends invitation → SSE listener on Worker receives it within 5s
 *
 * Run with: node --test test/test-cloudInvitation.js
 */

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { CloudInvitation } from '../dist/core/cloudInvitation.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

/**
 * Create a fresh CloudInvitation instance.
 */
function makeCloudInvitation(agentId, agentName, teamName) {
  return new CloudInvitation({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    teamName,
    agentId,
    agentName,
  })
}

/**
 * Generate a unique identifier to avoid collisions between test runs.
 * Every test gets fresh agent IDs to prevent stale invitation pollution
 * in the shared __invitations__ repo.
 */
function uid(prefix = 'test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ============================================================
// registerTeam
// ============================================================

describe('registerTeam', () => {

  test('registers a team and it appears on cloud discovery', async () => {
    const teamName = uid('team-reg')
    const leadId = uid('lead-reg')
    const ci = makeCloudInvitation(leadId, 'team-lead', teamName)

    await ci.registerTeam({
      name: teamName,
      description: 'A test team for registration',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    const teams = await CloudInvitation.discoverCloudTeams(SERVER_URL, API_KEY)
    const found = teams.find(t => t.name === teamName)
    assert.ok(found, 'Registered team should appear in cloud discovery')
    assert.strictEqual(found.leadAgentId, leadId)
    assert.strictEqual(found.memberCount, 1)
  })

  test('registerTeam is idempotent — re-registering overwrites', async () => {
    const teamName = uid('team-idem')
    const leadId = uid('lead-idem')
    const ci = makeCloudInvitation(leadId, 'team-lead', teamName)

    await ci.registerTeam({
      name: teamName,
      description: 'First registration',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    await ci.registerTeam({
      name: teamName,
      description: 'Second registration',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 5,
      createdAt: new Date().toISOString(),
    })

    const teams = await CloudInvitation.discoverCloudTeams(SERVER_URL, API_KEY)
    const found = teams.find(t => t.name === teamName)
    assert.ok(found, 'Team should still exist')
    assert.strictEqual(found.memberCount, 5, 'Should reflect latest registration')
  })
})

// ============================================================
// discoverCloudTeams
// ============================================================

describe('discoverCloudTeams (static)', () => {

  test('returns an array of CloudTeamInfo', async () => {
    const teams = await CloudInvitation.discoverCloudTeams(SERVER_URL, API_KEY)
    assert.ok(Array.isArray(teams), 'Should return an array')
    for (const t of teams) {
      assert.ok(typeof t.name === 'string', 'Team should have a name')
      assert.ok(typeof t.leadAgentId === 'string', 'Team should have a leadAgentId')
      assert.ok(typeof t.memberCount === 'number', 'Team should have a memberCount')
    }
  })

  test('returns empty array for a nonexistent repo (no teams registered)', async () => {
    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')
    const adapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `__teams__nonexistent-${Date.now()}`,
      developerId: 'test-runner',
    })
    const result = await adapter.pull()
    assert.strictEqual(result, null, 'Brand-new __teams__ repo should return null')
  })
})

// ============================================================
// sendInvitation
// ============================================================

describe('sendInvitation', () => {

  test('sendInvitation returns an Invitation with ok state', async () => {
    const teamName = uid('team-send')
    const leadId = uid('lead-send')
    const workerId = uid('worker-send')
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)

    await leader.registerTeam({
      name: teamName,
      description: 'Team for send test',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    const invitation = await leader.sendInvitation(workerId, 'worker-1', 'Please join my team!')

    assert.ok(invitation.id, 'Should have a generated id')
    assert.strictEqual(invitation.fromAgentId, leadId)
    assert.strictEqual(invitation.fromAgentName, 'team-lead')
    assert.strictEqual(invitation.toAgentId, workerId)
    assert.strictEqual(invitation.toAgentName, 'worker-1')
    assert.strictEqual(invitation.teamName, teamName)
    assert.strictEqual(invitation.message, 'Please join my team!')
    assert.strictEqual(invitation.status, 'pending')
    assert.ok(invitation.createdAt, 'Should have createdAt')
  })

  test('sendInvitation stores invitation in cloud (verifiable via pull)', async () => {
    const teamName = uid('team-send2')
    const leadId = uid('lead-send2')
    const workerId = uid('worker-send2')
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)

    await leader.registerTeam({
      name: teamName,
      description: 'Team for send2 test',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    const invitation = await leader.sendInvitation(workerId, 'worker-2')

    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')
    const adapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `__invitations__/${teamName}`,
      developerId: 'test-runner',
    })
    const result = await adapter.pull()
    assert.ok(result !== null, 'Should have data after sending invitation')

    const key = `inv/${invitation.id}`
    assert.ok(result.entries[key], `Invitation should be stored at key ${key}`)

    const stored = JSON.parse(result.entries[key])
    assert.strictEqual(stored.status, 'pending')
    assert.strictEqual(stored.toAgentId, workerId)
  })

  test('sendInvitation without message defaults to empty string', async () => {
    const teamName = uid('team-send3')
    const leadId = uid('lead-send3')
    const workerId = uid('worker-send3')
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)

    await leader.registerTeam({
      name: teamName,
      description: 'Team for send3 test',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    const invitation = await leader.sendInvitation(workerId, 'worker-3')
    assert.strictEqual(invitation.message, '')
  })
})

// ============================================================
// getInvitations
// ============================================================

describe('getInvitations', () => {

  test('returns pending invitations for the current agentId', async () => {
    const teamName = uid('team-get')
    const leadId = uid('lead-get')
    const workerId = uid('worker-get')
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)

    await leader.registerTeam({
      name: teamName,
      description: 'Team for get test',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    await leader.sendInvitation(workerId, 'worker-1', 'Join team get')

    const worker = makeCloudInvitation(workerId, 'worker-1', teamName)
    const invitations = await worker.getInvitations()

    assert.ok(Array.isArray(invitations), 'Should return an array')
    const found = invitations.find(i => i.toAgentId === workerId)
    assert.ok(found, 'Should find invitation for this agent')
    assert.strictEqual(found.status, 'pending')
    assert.strictEqual(found.teamName, teamName)
  })

  test('does NOT return invitations for a different agentId', async () => {
    const teamName = uid('team-get2')
    const leadId = uid('lead-get2')
    const workerA = uid('workerA-get2')
    const workerB = uid('workerB-get2')
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)

    await leader.registerTeam({
      name: teamName,
      description: 'Team for get2 test',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    await leader.sendInvitation(workerA, 'worker-A', 'For A only')

    const workerBInstance = makeCloudInvitation(workerB, 'worker-B', teamName)
    const invitations = await workerBInstance.getInvitations()

    const forA = invitations.find(i => i.toAgentId === workerA)
    assert.strictEqual(forA, undefined, 'Worker B should not see Worker A invitation')
  })

  test('returns empty array when no invitations exist', async () => {
    const teamName = uid('team-get3')
    const workerId = uid('worker-get3')
    const worker = makeCloudInvitation(workerId, 'worker-3', teamName)

    const invitations = await worker.getInvitations()
    assert.deepStrictEqual(invitations, [], 'Should return empty array for no invitations')
  })
})

// ============================================================
// acceptInvitation
// ============================================================

describe('acceptInvitation', () => {

  test('acceptInvitation changes status to accepted on cloud', async () => {
    const teamName = uid('team-accept')
    const leadId = uid('lead-accept')
    const workerId = uid('worker-accept')
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)

    await leader.registerTeam({
      name: teamName,
      description: 'Team for accept test',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    const invitation = await leader.sendInvitation(workerId, 'worker-1')

    const worker = makeCloudInvitation(workerId, 'worker-1', teamName)
    await worker.acceptInvitation(invitation.id)

    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')
    const adapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `__invitations__/${teamName}`,
      developerId: 'test-runner',
    })
    const result = await adapter.pull()
    assert.ok(result !== null)

    const stored = JSON.parse(result.entries[`inv/${invitation.id}`])
    assert.strictEqual(stored.status, 'accepted', 'Status should be accepted')
    assert.ok(stored.respondedAt, 'Should have respondedAt timestamp')

    const teamAdapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: teamName,
      developerId: 'test-runner',
    })
    const teamResult = await teamAdapter.pull()
    assert.ok(teamResult?.entries?.team_state, 'Accepting should write cloud team_state')
    const teamState = JSON.parse(teamResult.entries.team_state)
    assert.ok(
      teamState.members.some(m => m.agentId === workerId),
      'Accepted worker should be present in cloud team_state.members',
    )
  })

  test('acceptInvitation throws if invitation not found', async () => {
    const teamName = uid('team-accept2')
    const workerId = uid('worker-accept2')
    const worker = makeCloudInvitation(workerId, 'worker-2', teamName)

    try {
      await worker.acceptInvitation('nonexistent-invitation-id')
      assert.fail('Expected an error for nonexistent invitation')
    } catch (err) {
      assert.ok(err instanceof Error, 'Should throw an Error')
    }
  })
})

// ============================================================
// declineInvitation
// ============================================================

describe('declineInvitation', () => {

  test('declineInvitation changes status to declined on cloud', async () => {
    const teamName = uid('team-decline')
    const leadId = uid('lead-decline')
    const workerId = uid('worker-decline')
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)

    await leader.registerTeam({
      name: teamName,
      description: 'Team for decline test',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    const invitation = await leader.sendInvitation(workerId, 'worker-1')

    const worker = makeCloudInvitation(workerId, 'worker-1', teamName)
    await worker.declineInvitation(invitation.id, 'Not interested')

    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')
    const adapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `__invitations__/${teamName}`,
      developerId: 'test-runner',
    })
    const result = await adapter.pull()
    assert.ok(result !== null)

    const stored = JSON.parse(result.entries[`inv/${invitation.id}`])
    assert.strictEqual(stored.status, 'declined', 'Status should be declined')
    assert.ok(stored.respondedAt, 'Should have respondedAt timestamp')
  })

  test('declineInvitation works without reason', async () => {
    const teamName = uid('team-decline2')
    const leadId = uid('lead-decline2')
    const workerId = uid('worker-decline2')
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)

    await leader.registerTeam({
      name: teamName,
      description: 'Team for decline2 test',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    const invitation = await leader.sendInvitation(workerId, 'worker-1')

    const worker = makeCloudInvitation(workerId, 'worker-1', teamName)
    await worker.declineInvitation(invitation.id)

    const invitations = await worker.getInvitations()
    const found = invitations.find(i => i.id === invitation.id)
    assert.ok(found, 'Should still be retrievable')
    assert.strictEqual(found.status, 'declined')
  })
})

// ============================================================
// Integration: send invitation → SSE listener receives it
// ============================================================

describe('Integration: sendInvitation → SSE delivery', () => {

  test('SSE listener receives invitation event within 5 seconds', async () => {
    const teamName = uid('team-sse')
    const leadId = uid('lead-sse')
    const workerId = uid('worker-sse')

    // Create leader
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)
    await leader.registerTeam({
      name: teamName,
      description: 'Team for SSE integration test',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    // SSE listener on the __invitations__ repo
    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')
    const adapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `__invitations__/${teamName}`,
      developerId: 'sse-worker',
    })

    // Start SSE listener
    const sseEvents = []
    const response = await adapter.connectSSE()
    assert.ok(response.ok, 'SSE connection should be OK')
    assert.ok(response.body, 'SSE response should have a body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const readLoop = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // Process complete SSE frames
          const frames = buffer.split('\n\n')
          buffer = frames.pop() || ''

          for (const frame of frames) {
            if (!frame.trim()) continue
            const event = parseSSEFrame(frame)
            if (event) sseEvents.push(event)
          }
        }
      } catch {
        // connection closed
      }
    })()

    // Wait for SSE to fully establish
    await new Promise(r => setTimeout(r, 2000))

    // Leader sends invitation (broadcasts event)
    const invitation = await leader.sendInvitation(workerId, 'worker-sse', 'Join via SSE!')

    // Wait for SSE delivery (5 seconds)
    const deadline = Date.now() + 5000
    let found = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500))
      // Server may nest data differently — check both paths
      found = sseEvents.some(e => {
        const d = e.data
        const inner = (d && typeof d === 'object' && 'data' in d) ? d.data : d
        return e.event === 'invite' && inner && inner.invitationId === invitation.id
      })
      if (found) break
    }

    reader.cancel().catch(() => {})
    await readLoop.catch(() => {})

    assert.ok(found, 'SSE listener should have received the invitation event within 5 seconds')
  })

  test('end-to-end: leader sends, worker accepts, leader verifies', async () => {
    const teamName = uid('team-e2e')
    const leadId = uid('lead-e2e')
    const workerId = uid('worker-e2e')

    // Leader registers team and sends invitation
    const leader = makeCloudInvitation(leadId, 'team-lead', teamName)
    await leader.registerTeam({
      name: teamName,
      description: 'E2E test team',
      leadAgentId: leadId,
      leadAgentName: 'team-lead',
      memberCount: 1,
      createdAt: new Date().toISOString(),
    })

    const invitation = await leader.sendInvitation(workerId, 'worker-e2e', 'Come join!')
    assert.strictEqual(invitation.status, 'pending')

    // Worker sees and accepts
    const worker = makeCloudInvitation(workerId, 'worker-e2e', teamName)
    const pending = await worker.getInvitations()
    assert.ok(pending.length > 0, 'Worker should see pending invitation')

    await worker.acceptInvitation(invitation.id)

    // Worker's getInvitations should now show accepted
    const after = await worker.getInvitations()
    const accepted = after.find(i => i.id === invitation.id)
    assert.ok(accepted, 'Invitation should still exist')
    assert.strictEqual(accepted.status, 'accepted', 'Status should be accepted after acceptance')

    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')
    const teamAdapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: teamName,
      developerId: 'test-runner',
    })
    const teamResult = await teamAdapter.pull()
    assert.ok(teamResult?.entries?.team_state, 'E2E accept should create/read cloud team_state')
    const teamState = JSON.parse(teamResult.entries.team_state)
    assert.ok(
      teamState.members.some(m => m.agentId === leadId),
      'Leader should remain in cloud team_state.members',
    )
    assert.ok(
      teamState.members.some(m => m.agentId === workerId),
      'Worker should be added to cloud team_state.members',
    )
  })
})

// ============================================================
// Helper: Parse a single SSE frame
// ============================================================

function parseSSEFrame(frame) {
  const lines = frame.split('\n').map(l => l.replace('\r', ''))
  let event = 'message'
  let id = ''
  let dataStr = ''

  for (const line of lines) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('id:')) id = line.slice(3).trim()
    else if (line.startsWith('data:')) dataStr = line.slice(5).trim()
  }

  if (!dataStr) return null

  try {
    return { event, id, data: JSON.parse(dataStr) }
  } catch {
    return { event, id, data: dataStr }
  }
}
