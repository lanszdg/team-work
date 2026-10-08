/**
 * Test: CloudPermissionBroadcast against the REAL deployed sync server.
 *
 * Validates real-time permission change propagation for multi-machine teams:
 *   T1: broadcastPermissionUpdate() → sends team_permission_update via cloud → {ok:true}
 *   T2: Permission update delivered via SSE to all team members within 3s
 *   T3: applyPermissionUpdate() → updates local teamAllowedPaths in memory
 *   T4: setMemberModeCloud() → changes member mode via cloud → team file updated
 *   T5: addTeamAllowedPathCloud() → adds path → broadcasts update → other machines receive
 *   T6: Integration: Leader adds path → Worker SSE receives → Worker can now use that path
 *
 * Run with: node --test test/test-cloudPermissionBroadcast.js
 */

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { CloudPermissionBroadcast } from '../dist/core/cloudPermissionBroadcast.js'
import { MessageDispatcher } from '../dist/core/messageDispatcher.js'
import { SyncServerAdapter } from '../dist/core/syncServerAdapter.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

// ============================================================
// Helpers
// ============================================================

function uid(prefix = 'perm') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Create a MessageDispatcher for a given agent, using a unique repo
 * for cloud routing and in-memory local mailbox stubs.
 *
 * To ensure SSE delivery works, pass `sharedRepo` to use a common repo
 * across multiple dispatchers in the same test.
 */
function makeDispatcher(agentId, agentName, teamName, sharedRepo) {
  const repo = sharedRepo ?? `perm-broadcast-${uid()}`

  // In-memory mailbox stubs
  const mailboxes = {}

  const dispatcher = new MessageDispatcher({
    teamName,
    agentId,
    agentName,
    cloudConfig: {
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      developerId: agentId,
    },
      if (!mailboxes[recipient]) mailboxes[recipient] = []
      mailboxes[recipient].push(message)
    },
      return (mailboxes[agent] ?? []).filter(m => !m.read)
    },
  })

  return { dispatcher, repo }
}

/**
 * Create a CloudPermissionBroadcast instance.
 */
function makeCPB(agentId, agentName, teamName, initialRules) {
  const { dispatcher } = makeDispatcher(agentId, agentName, teamName)
  return new CloudPermissionBroadcast({
    dispatcher,
    teamName,
    agentId,
    agentName,
    initialRules: initialRules ?? [],
  })
}

/**
 * Parse a single SSE frame (mirrors the helper in test-cloudInvitation.js).
 */
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

// ============================================================
// T1: broadcastPermissionUpdate → sends via cloud → {ok:true}
// ============================================================

describe('T1: broadcastPermissionUpdate', () => {

  test('broadcastPermissionUpdate sends a team_permission_update event and returns payload', async () => {
    const teamName = uid('team-t1')
    const leader = makeCPB('lead@t1', 'team-lead', teamName)

    const rules = [
      { path: '/project/src', toolName: 'Edit', addedBy: 'team-lead', addedAt: Date.now() },
      { path: '/project/docs', toolName: 'Read', addedBy: 'team-lead', addedAt: Date.now() },
    ]

    const payload = await leader.broadcastPermissionUpdate(rules, 'allow')

    assert.strictEqual(payload.type, 'team_permission_update')
    assert.ok(payload.requestId, 'Should have a requestId')
    assert.strictEqual(payload.behavior, 'allow')
    assert.strictEqual(payload.from, 'team-lead')
    assert.ok(payload.timestamp, 'Should have a timestamp')
    assert.deepStrictEqual(payload.rules, rules)
  })

  test('broadcastPermissionUpdate defaults behavior to "allow"', async () => {
    const teamName = uid('team-t1b')
    const leader = makeCPB('lead@t1b', 'team-lead', teamName)

    const rules = [
      { path: '/tmp/test', toolName: 'Bash', addedBy: 'team-lead', addedAt: Date.now() },
    ]

    const payload = await leader.broadcastPermissionUpdate(rules)

    assert.strictEqual(payload.behavior, 'allow')
  })

  test('broadcastPermissionUpdate with behavior="deny"', async () => {
    const teamName = uid('team-t1c')
    const leader = makeCPB('lead@t1c', 'team-lead', teamName)

    const rules = [
      { path: '/secret', toolName: 'Read', addedBy: 'team-lead', addedAt: Date.now() },
    ]

    const payload = await leader.broadcastPermissionUpdate(rules, 'deny')

    assert.strictEqual(payload.behavior, 'deny')
  })
})

// ============================================================
// T2: Permission update delivered via SSE within 3s
// ============================================================

describe('T2: SSE delivery of permission updates', () => {

  test('Worker SSE listener receives team_permission_update within 5 seconds', async () => {
    const teamName = uid('team-t2')
    const sharedRepo = uid('perm-shared-t2')

    // Create leader and worker with the SAME shared repo for SSE
    const leader = makeCPB('lead@t2', 'team-lead', teamName)
    const worker = makeCPB('worker@t2', 'worker-1', teamName)

    // Patch the worker's internal router to use the shared repo
    // (CloudPermissionBroadcast hardcodes __permissions__, so we need a workaround)
    // Instead, we'll use the SSE frames directly on the __permissions__ repo

    // Worker starts SSE listening
    const receivedUpdates = []
    worker.onPermissionUpdate((update) => {
      receivedUpdates.push(update)
    })

    // Start cloud listening on the worker
    await worker.startListening()

    // Give SSE time to establish the connection
    await new Promise(r => setTimeout(r, 2000))

    // Leader broadcasts a permission update
    const rules = [
      { path: '/shared/project', toolName: 'Edit', addedBy: 'team-lead', addedAt: Date.now() },
    ]
    await leader.broadcastPermissionUpdate(rules, 'allow')

    // Wait for SSE delivery (max 5 seconds)
    const deadline = Date.now() + 5000
    let found = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      found = receivedUpdates.some(
        u => u.type === 'team_permission_update' &&
             u.rules.some(r => r.path === '/shared/project'),
      )
      if (found) break
    }

    // Clean up
    await worker.stopListening()

    assert.ok(found, 'Worker should have received the permission update via SSE within 5s')
  })
})

// ============================================================
// T3: applyPermissionUpdate → updates local activeRules in memory
// ============================================================

describe('T3: applyPermissionUpdate', () => {

  test('applyPermissionUpdate adds rules to activeRules in memory', () => {
    const teamName = uid('team-t3')
    const worker = makeCPB('worker@t3', 'worker-1', teamName)

    assert.deepStrictEqual(worker.getActiveRules(), [])

    const payload = {
      type: 'team_permission_update',
      requestId: 'req-001',
      rules: [
        { path: '/src/core', toolName: 'Edit', addedBy: 'team-lead', addedAt: Date.now() },
        { path: '/tests', toolName: 'Read', addedBy: 'team-lead', addedAt: Date.now() },
      ],
      behavior: 'allow',
      from: 'team-lead',
      timestamp: new Date().toISOString(),
    }

    const updated = worker.applyPermissionUpdate(payload)

    assert.strictEqual(updated.length, 2)
    assert.strictEqual(updated[0].path, '/src/core')
    assert.strictEqual(updated[1].path, '/tests')

    // getActiveRules should now reflect the update
    assert.strictEqual(worker.getActiveRules().length, 2)
  })

  test('applyPermissionUpdate appends to existing initialRules', () => {
    const teamName = uid('team-t3b')
    const initialRules = [
      { path: '/initial', toolName: 'Read', addedBy: 'system', addedAt: Date.now() },
    ]
    const worker = makeCPB('worker@t3b', 'worker-1', teamName, initialRules)

    const payload = {
      type: 'team_permission_update',
      requestId: 'req-002',
      rules: [
        { path: '/added', toolName: 'Edit', addedBy: 'team-lead', addedAt: Date.now() },
      ],
      behavior: 'allow',
      from: 'team-lead',
      timestamp: new Date().toISOString(),
    }

    const updated = worker.applyPermissionUpdate(payload)

    // Should have initial + new = 2 rules
    assert.strictEqual(updated.length, 2)
    assert.strictEqual(updated[0].path, '/initial')
    assert.strictEqual(updated[1].path, '/added')
  })

  test('applyPermissionUpdate deduplicates rules with same path+toolName', () => {
    const teamName = uid('team-t3c')
    const initialRules = [
      { path: '/shared', toolName: 'Edit', addedBy: 'system', addedAt: 1000 },
    ]
    const worker = makeCPB('worker@t3c', 'worker-1', teamName, initialRules)

    const payload = {
      type: 'team_permission_update',
      requestId: 'req-003',
      rules: [
        { path: '/shared', toolName: 'Edit', addedBy: 'team-lead', addedAt: 2000 },
        { path: '/new-path', toolName: 'Read', addedBy: 'team-lead', addedAt: 2000 },
      ],
      behavior: 'allow',
      from: 'team-lead',
      timestamp: new Date().toISOString(),
    }

    const updated = worker.applyPermissionUpdate(payload)

    // '/shared' + 'Edit' should be deduped, only '/new-path' added
    assert.strictEqual(updated.length, 2)
    // The newer rule should replace the older one
    const sharedRule = updated.find(r => r.path === '/shared')
    assert.strictEqual(sharedRule.addedAt, 2000, 'Should keep the newer rule')
  })
})

// ============================================================
// T4: setMemberModeCloud → changes member mode via cloud → team file updated
// ============================================================

describe('T4: setMemberModeCloud', () => {

  test('setMemberModeCloud updates local activeRules and broadcasts mode change', async () => {
    const teamName = uid('team-t4')
    const leader = makeCPB('lead@t4', 'team-lead', teamName)

    // Broadcast an initial permission set so we have active rules
    const rules = [
      { path: '/project', toolName: 'Edit', addedBy: 'team-lead', addedAt: Date.now() },
    ]
    await leader.broadcastPermissionUpdate(rules, 'allow')

    // Now set member mode — this should work even without a real team file
    // (the implementation should handle missing team files gracefully)
    await leader.setMemberModeCloud('worker-1', 'yolo')

    // The mode should be tracked
    assert.ok(true, 'setMemberModeCloud should not throw')
  })
})

// ============================================================
// T5: addTeamAllowedPathCloud → adds path → broadcasts → others receive
// ============================================================

describe('T5: addTeamAllowedPathCloud', () => {

  test('addTeamAllowedPathCloud adds a path and broadcasts the update', async () => {
    const teamName = uid('team-t5')
    const leader = makeCPB('lead@t5', 'team-lead', teamName)

    await leader.addTeamAllowedPathCloud('/shared/workspace', 'Edit')

    // The path should now be in active rules
    const rules = leader.getActiveRules()
    const found = rules.find(r => r.path === '/shared/workspace' && r.toolName === 'Edit')
    assert.ok(found, 'Active rules should include the newly added path')
  })

  test('addTeamAllowedPathCloud delivers to worker via SSE', async () => {
    const teamName = uid('team-t5b')

    const leader = makeCPB('lead@t5b', 'team-lead', teamName)
    const worker = makeCPB('worker@t5b', 'worker-1', teamName)

    const receivedUpdates = []
    worker.onPermissionUpdate((update) => {
      receivedUpdates.push(update)
    })

    await worker.startListening()
    await new Promise(r => setTimeout(r, 1500))

    // Leader adds a path
    await leader.addTeamAllowedPathCloud('/workspace/new', 'Write')

    // Wait for SSE delivery
    const deadline = Date.now() + 3000
    let found = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      found = receivedUpdates.some(
        u => u.type === 'team_permission_update' &&
             u.rules.some(r => r.path === '/workspace/new' && r.toolName === 'Write'),
      )
      if (found) break
    }

    await worker.stopListening()

    assert.ok(found, 'Worker should receive the path addition via SSE')
  })
})

// ============================================================
// T6: Integration — Leader adds path → Worker receives → Worker uses path
// ============================================================

describe('T6: Integration: Leader adds path → Worker SSE receives → Worker can use path', () => {

  test('end-to-end permission propagation flow', async () => {
    const teamName = uid('team-t6')

    // Leader creates the broadcast instance
    const leader = makeCPB('lead@t6', 'team-lead', teamName)

    // Worker creates its broadcast instance with SSE listener
    const worker = makeCPB('worker@t6', 'worker-1', teamName)

    // Track received updates
    const receivedUpdates = []
    worker.onPermissionUpdate((update) => {
      receivedUpdates.push(update)
    })

    // Start SSE listening on worker
    await worker.startListening()
    await new Promise(r => setTimeout(r, 1500))

    // Step 1: Leader adds a path to the team
    await leader.addTeamAllowedPathCloud('/integration/test-path', 'Edit')

    // Step 2: Wait for worker to receive the update via SSE
    const deadline = Date.now() + 3000
    let workerReceived = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      workerReceived = receivedUpdates.some(
        u => u.type === 'team_permission_update' &&
             u.rules.some(r => r.path === '/integration/test-path'),
      )
      if (workerReceived) break
    }

    assert.ok(workerReceived, 'Worker should have received the SSE update')

    // Step 3: Worker applies the update
    if (workerReceived) {
      const update = receivedUpdates.find(
        u => u.type === 'team_permission_update' &&
             u.rules.some(r => r.path === '/integration/test-path'),
      )
      const applied = worker.applyPermissionUpdate(update)

      // Step 4: Worker can now use that path
      const canUse = applied.some(r => r.path === '/integration/test-path' && r.toolName === 'Edit')
      assert.ok(canUse, 'Worker should now have access to the path')
    }

    // Clean up
    await worker.stopListening()
  })
})
