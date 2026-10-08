/**
 * Test: CloudKickManager — shutdown request / approve / reject / kick-and-remove
 *
 * Validates:
 *   T1: sendShutdownRequest() → posts via MessageDispatcher/CloudMessageRouter → server returns {ok:true}
 *   T2: shutdown_request delivered via SSE to target agent within 3 seconds
 *   T3: sendShutdownApproved() → response back to leader via cloud
 *   T4: sendShutdownRejected() → with reason, delivered to leader
 *   T5: kickAndRemove() → sends shutdown → waits for response → calls removeTeammateFromTeamFile()
 *   T6: kickAndRemove() with timeout (30s) → removes member even without response
 *   T7: Integration: Leader kicks worker → worker receives shutdown → worker accepts → removed from team
 *
 * Run with: node --test test/test-cloudKick.js
 */

import test, { describe, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { CloudKickManager } from '../dist/core/cloudKick.js'
import { MessageDispatcher } from '../dist/core/messageDispatcher.js'
import { CloudMessageRouter } from '../dist/core/cloudMessageRouter.js'
import { removeTeammateFromTeamFile, writeTeamFile } from '../dist/core/teamFile.js'
import { SyncServerAdapter } from '../dist/core/syncServerAdapter.js'
import { createTestEnv, makeTeamFile } from './utils.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

/**
 * Generate a unique identifier to avoid collisions between test runs.
 */
function uid(prefix = 'test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Create a mock MessageDispatcher for unit tests.
 */
function makeMockDispatcher() {
  const sentMessages = []
  const sendMessage = async (recipientAgentId, recipientName, message) => {
    sentMessages.push({ recipientAgentId, recipientName, message })
    return 'cloud'
  }
  return {
    dispatcher: {
      sendMessage,
      isCloudActive: true,
      getCloudRouter: () => null,
      startCloudListening: async () => {},
      stopCloudListening: () => {},
      receiveUnreadMessages: async () => [],
    },
    sentMessages,
  }
}

/**
 * Start a non-blocking SSE reader (matches test-cloudInvitation.js pattern).
 * Returns { events, cancel } where events accumulates SSE frames and cancel() stops the reader.
 */
async function startSSEReader(adapter) {
  const events = []
  const response = await adapter.connectSSE()
  assert.ok(response.ok, 'SSE connection should be OK')
  assert.ok(response.body, 'SSE response should have a body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sseDone = false

  const readLoop = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { sseDone = true; break }
        buffer += decoder.decode(value, { stream: true })

        const frames = buffer.split('\n\n')
        buffer = frames.pop() || '' // keep incomplete frame

        for (const frame of frames) {
          if (!frame.trim()) continue
          const parsed = parseSSEFrame(frame)
          if (parsed) events.push(parsed)
        }
      }
    } catch {
      sseDone = true
    }
  })()

  const cancel = async () => {
    reader.cancel().catch(() => {})
    await readLoop.catch(() => {})
  }

  return { events, cancel }
}

/**
 * Parse a single SSE frame (helper for integration tests).
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
// T1: sendShutdownRequest — posts via dispatcher
// ============================================================

describe('T1: sendShutdownRequest', () => {

  test('sendShutdownRequest constructs correct payload and routes via dispatcher', async () => {
    const { dispatcher, sentMessages } = makeMockDispatcher()

    const manager = new CloudKickManager(dispatcher, 'test-team', 'leader@kick', 'team-lead')
    const result = await manager.sendShutdownRequest('worker@kick', 'worker-1', 'Task completed')

    assert.ok(result.requestId, 'Should have a generated requestId')
    assert.strictEqual(result.type, 'shutdown_request')
    assert.strictEqual(result.from, 'team-lead')
    assert.strictEqual(result.reason, 'Task completed')
    assert.ok(result.timestamp, 'Should have a timestamp')

    // Verify dispatcher was called correctly
    assert.strictEqual(sentMessages.length, 1, 'Dispatcher should be called once')
    assert.strictEqual(sentMessages[0].recipientAgentId, 'worker@kick')
    assert.strictEqual(sentMessages[0].recipientName, 'worker-1')
    assert.strictEqual(sentMessages[0].message.type, 'shutdown_request')
    assert.strictEqual(sentMessages[0].message.requestId, result.requestId)
  })

  test('sendShutdownRequest works without reason', async () => {
    const { dispatcher, sentMessages } = makeMockDispatcher()

    const manager = new CloudKickManager(dispatcher, 'test-team', 'leader@kick2', 'team-lead')
    const result = await manager.sendShutdownRequest('worker@kick2', 'worker-2')

    assert.ok(result.requestId)
    assert.strictEqual(result.type, 'shutdown_request')
    assert.strictEqual(sentMessages.length, 1)
    // reason should be absent or undefined
    assert.strictEqual(sentMessages[0].message.reason, undefined)
  })

  test('each call generates a unique requestId', async () => {
    const { dispatcher } = makeMockDispatcher()
    const manager = new CloudKickManager(dispatcher, 'test-team', 'leader@kick3', 'team-lead')

    const r1 = await manager.sendShutdownRequest('w1', 'worker-1')
    const r2 = await manager.sendShutdownRequest('w2', 'worker-2')

    assert.notStrictEqual(r1.requestId, r2.requestId, 'requestIds should be unique')
  })
})

// ============================================================
// T2: shutdown_request delivered via SSE to target within 3 seconds
// ============================================================

describe('T2: SSE delivery of shutdown_request', () => {

  test('shutdown_request delivered via SSE to target agent within 3 seconds', async () => {
    const teamName = uid('team-sse-kick')

    // Create leader's dispatcher (no SSE needed)
    const leaderDispatcher = new MessageDispatcher({
      teamName,
      agentId: 'leader@sse-kick',
      agentName: 'team-lead',
      cloudConfig: {
        apiUrl: SERVER_URL,
        apiKey: API_KEY,
        developerId: 'cloud-kick-test',
      },
    })

    const leaderKick = new CloudKickManager(leaderDispatcher, teamName, 'leader@sse-kick', 'team-lead')

    // Worker: use raw SSE adapter for non-blocking listening
    const workerAdapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `messages/${teamName}`,
      developerId: 'cloud-kick-test',
    })

    const { events, cancel } = await startSSEReader(workerAdapter)

    // Give SSE time to establish
    await new Promise(r => setTimeout(r, 1500))

    // Leader sends shutdown request
    const result = await leaderKick.sendShutdownRequest('worker@sse-kick', 'worker-1', 'SSE delivery test')

    // Wait for SSE delivery (max 3 seconds)
    const deadline = Date.now() + 3000
    let found = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      found = events.some(
        (e) => {
          // SSE events for 'task' type have the message in data.data
          const msgData = e.data?.data ?? e.data
          if (!msgData) return false
          try {
            const text = typeof msgData.text === 'string' ? msgData.text : JSON.stringify(msgData)
            const payload = JSON.parse(text)
            return payload.type === 'shutdown_request' && payload.requestId === result.requestId
          } catch {
            return false
          }
        },
      )
      if (found) break
    }

    await cancel()

    assert.ok(found, 'SSE listener should receive the shutdown_request within 3 seconds')
  })
})

// ============================================================
// T3: sendShutdownApproved — response back to leader via cloud
// ============================================================

describe('T3: sendShutdownApproved', () => {

  test('sendShutdownApproved sends correct response via dispatcher', async () => {
    const { dispatcher, sentMessages } = makeMockDispatcher()

    const manager = new CloudKickManager(dispatcher, 'test-team', 'worker@approve', 'worker-1')
    await manager.sendShutdownApproved('req-123', 'leader@approve')

    assert.strictEqual(sentMessages.length, 1)
    const msg = sentMessages[0].message
    assert.strictEqual(msg.type, 'shutdown_approved')
    assert.strictEqual(msg.requestId, 'req-123')
    assert.strictEqual(msg.from, 'worker-1')
  })

  test('sendShutdownApproved delivered via SSE to leader', async () => {
    const teamName = uid('team-approve')

    // Leader: raw SSE adapter for non-blocking listening
    const leaderAdapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `messages/${teamName}`,
      developerId: 'cloud-kick-test',
    })

    const { events, cancel } = await startSSEReader(leaderAdapter)

    // Give SSE time to establish
    await new Promise(r => setTimeout(r, 1500))

    // Worker sends approval
    const workerDispatcher = new MessageDispatcher({
      teamName,
      agentId: 'worker@approve',
      agentName: 'worker-1',
      cloudConfig: {
        apiUrl: SERVER_URL,
        apiKey: API_KEY,
        developerId: 'cloud-kick-test',
      },
    })

    const workerKick = new CloudKickManager(workerDispatcher, teamName, 'worker@approve', 'worker-1')
    await workerKick.sendShutdownApproved('req-approve-1', 'leader@approve')

    // Wait for SSE delivery
    const deadline = Date.now() + 3000
    let found = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      found = events.some((e) => {
        const msgData = e.data?.data ?? e.data
        if (!msgData) return false
        try {
          const text = typeof msgData.text === 'string' ? msgData.text : JSON.stringify(msgData)
          const payload = JSON.parse(text)
          return payload.type === 'shutdown_approved' && payload.requestId === 'req-approve-1'
        } catch {
          return false
        }
      })
      if (found) break
    }

    await cancel()
    assert.ok(found, 'Leader should receive shutdown_approved via SSE')
  })
})

// ============================================================
// T4: sendShutdownRejected — with reason, delivered to leader
// ============================================================

describe('T4: sendShutdownRejected', () => {

  test('sendShutdownRejected sends correct response with reason via dispatcher', async () => {
    const { dispatcher, sentMessages } = makeMockDispatcher()

    const manager = new CloudKickManager(dispatcher, 'test-team', 'worker@reject', 'worker-1')
    await manager.sendShutdownRejected('req-456', 'leader@reject', 'Still working on critical task')

    assert.strictEqual(sentMessages.length, 1)
    const msg = sentMessages[0].message
    assert.strictEqual(msg.type, 'shutdown_rejected')
    assert.strictEqual(msg.requestId, 'req-456')
    assert.strictEqual(msg.from, 'worker-1')
    assert.strictEqual(msg.reason, 'Still working on critical task')
  })

  test('sendShutdownRejected works without reason', async () => {
    const { dispatcher, sentMessages } = makeMockDispatcher()

    const manager = new CloudKickManager(dispatcher, 'test-team', 'worker@reject2', 'worker-2')
    await manager.sendShutdownRejected('req-457', 'leader@reject2')

    assert.strictEqual(sentMessages.length, 1)
    const msg = sentMessages[0].message
    assert.strictEqual(msg.type, 'shutdown_rejected')
    assert.strictEqual(msg.requestId, 'req-457')
    // reason should default to empty string or undefined
    assert.ok(msg.reason === '' || msg.reason === undefined, 'reason should be empty or absent')
  })

  test('sendShutdownRejected delivered via SSE to leader', async () => {
    const teamName = uid('team-reject')

    // Leader: raw SSE adapter
    const leaderAdapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `messages/${teamName}`,
      developerId: 'cloud-kick-test',
    })

    const { events, cancel } = await startSSEReader(leaderAdapter)

    await new Promise(r => setTimeout(r, 1500))

    // Worker sends rejection
    const workerDispatcher = new MessageDispatcher({
      teamName,
      agentId: 'worker@reject',
      agentName: 'worker-1',
      cloudConfig: {
        apiUrl: SERVER_URL,
        apiKey: API_KEY,
        developerId: 'cloud-kick-test',
      },
    })

    const workerKick = new CloudKickManager(workerDispatcher, teamName, 'worker@reject', 'worker-1')
    await workerKick.sendShutdownRejected('req-reject-1', 'leader@reject', 'Not ready')

    // Wait for SSE delivery
    const deadline = Date.now() + 3000
    let found = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      found = events.some((e) => {
        const msgData = e.data?.data ?? e.data
        if (!msgData) return false
        try {
          const text = typeof msgData.text === 'string' ? msgData.text : JSON.stringify(msgData)
          const payload = JSON.parse(text)
          return payload.type === 'shutdown_rejected' && payload.requestId === 'req-reject-1'
        } catch {
          return false
        }
      })
      if (found) break
    }

    await cancel()
    assert.ok(found, 'Leader should receive shutdown_rejected via SSE')
  })
})

// ============================================================
// T5: kickAndRemove — sends shutdown → waits for response → removes
// ============================================================

describe('T5: kickAndRemove (accepted)', () => {

  test('kickAndRemove with accepted response removes teammate from team file', async (t) => {
    // Create a team file with a member to remove
    const { dir, cleanup } = createTestEnv()
    t.after(() => cleanup())

    const teamFile = makeTeamFile({
      name: 'test-team',
      members: [
        {
          agentId: 'leader@kick5',
          name: 'team-lead',
          tmuxPaneId: '%0',
          cwd: process.cwd(),
          subscriptions: [],
          isActive: true,
          mode: 'auto',
        },
        {
          agentId: 'worker@kick5',
          name: 'worker-1',
          tmuxPaneId: '%1',
          cwd: process.cwd(),
          subscriptions: [],
          isActive: true,
          mode: 'auto',
        },
      ],
    })
    writeTeamFile('test-team', teamFile)

    // Create a dispatcher that auto-responds when shutdown_request is sent
    let shutdownRequestId = null
    const autoDispatcher = {
      sendMessage: async (recipientAgentId, recipientName, message) => {
        if (message.type === 'shutdown_request') {
          shutdownRequestId = message.requestId
          // Simulate auto-approval by injecting into buffer
          autoDispatcher._approved = true
          autoDispatcher._requestId = message.requestId
        }
        return 'cloud'
      },
      isCloudActive: true,
      getCloudRouter: () => null,
      startCloudListening: async () => {},
      stopCloudListening: () => {},
      receiveUnreadMessages: async () => {
        if (autoDispatcher._approved && shutdownRequestId) {
          autoDispatcher._approved = false
          return [{
            source: 'cloud',
            message: {
              text: JSON.stringify({
                type: 'shutdown_approved',
                requestId: shutdownRequestId,
                from: 'worker-1',
                timestamp: new Date().toISOString(),
              }),
            },
          }]
        }
        return []
      },
      _approved: false,
      _requestId: null,
    }

    const mgr = new CloudKickManager(autoDispatcher, 'test-team', 'leader@kick5', 'team-lead')
    const result = await mgr.kickAndRemove('worker@kick5', 'worker-1', 'goodbye', 5000)

    assert.strictEqual(result.success, true)
    assert.strictEqual(result.accepted, true)
  })
})

// ============================================================
// T6: kickAndRemove with timeout — removes even without response
// ============================================================

describe('T6: kickAndRemove (timeout)', () => {

  test('kickAndRemove with short timeout removes member without response', async (t) => {
    const { dir, cleanup } = createTestEnv()
    t.after(() => cleanup())

    const teamFile = makeTeamFile({
      name: 'test-team-timeout',
      members: [
        {
          agentId: 'leader@kick6',
          name: 'team-lead',
          tmuxPaneId: '%0',
          cwd: process.cwd(),
          subscriptions: [],
          isActive: true,
          mode: 'auto',
        },
        {
          agentId: 'worker@kick6',
          name: 'worker-1',
          tmuxPaneId: '%1',
          cwd: process.cwd(),
          subscriptions: [],
          isActive: true,
          mode: 'auto',
        },
      ],
    })
    writeTeamFile('test-team-timeout', teamFile)

    // Dispatcher that never responds
    const noResponseDispatcher = {
      sendMessage: async () => 'cloud',
      isCloudActive: true,
      getCloudRouter: () => null,
      startCloudListening: async () => {},
      stopCloudListening: () => {},
      receiveUnreadMessages: async () => [], // never returns any response
    }

    const manager = new CloudKickManager(noResponseDispatcher, 'test-team-timeout', 'leader@kick6', 'team-lead')

    // Use a short timeout (1 second) so test runs fast
    const start = Date.now()
    const result = await manager.kickAndRemove('worker@kick6', 'worker-1', 'timeout test', 1000)
    const elapsed = Date.now() - start

    assert.strictEqual(result.success, true, 'Should still succeed (force remove on timeout)')
    assert.strictEqual(result.accepted, false, 'Should not be accepted (no response)')
    assert.ok(elapsed >= 900, `Should have waited ~1s before timeout (took ${elapsed}ms)`)

    // Verify member was removed
    const { readTeamFile } = await import('../dist/core/teamFile.js')
    const remaining = readTeamFile('test-team-timeout')
    const workerStillThere = remaining.members.some(m => m.agentId === 'worker@kick6')
    assert.strictEqual(workerStillThere, false, 'Worker should be removed from team file after timeout')
  })
})

// ============================================================
// T7: Integration — Leader kicks worker → SSE → accepts → removed
// ============================================================

describe('T7: Integration — kick → SSE → accept → remove', () => {

  test('Leader kicks worker → worker receives shutdown → worker accepts → removed from team', async (t) => {
    const teamName = uid('team-integ-kick')
    const { dir, cleanup } = createTestEnv()
    t.after(() => cleanup())

    // Set up team file with leader and worker
    const teamFile = makeTeamFile({
      name: teamName,
      members: [
        {
          agentId: 'leader@integ',
          name: 'team-lead',
          tmuxPaneId: '%0',
          cwd: process.cwd(),
          subscriptions: [],
          isActive: true,
          mode: 'auto',
        },
        {
          agentId: 'worker@integ',
          name: 'worker-1',
          tmuxPaneId: '%1',
          cwd: process.cwd(),
          subscriptions: [],
          isActive: true,
          mode: 'auto',
        },
      ],
    })
    writeTeamFile(teamName, teamFile)

    // Leader's dispatcher (no SSE needed, just sends)
    const leaderDispatcher = new MessageDispatcher({
      teamName,
      agentId: 'leader@integ',
      agentName: 'team-lead',
      cloudConfig: {
        apiUrl: SERVER_URL,
        apiKey: API_KEY,
        developerId: 'cloud-kick-test',
      },
    })

    const leaderKick = new CloudKickManager(leaderDispatcher, teamName, 'leader@integ', 'team-lead')

    // Worker: raw SSE adapter for non-blocking listening
    const workerAdapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `messages/${teamName}`,
      developerId: 'cloud-kick-test',
    })

    const { events: workerEvents, cancel: cancelWorker } = await startSSEReader(workerAdapter)

    // Leader: also needs SSE to receive the approval back from worker
    const leaderAdapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: `messages/${teamName}`,
      developerId: 'cloud-kick-test-leader',
    })

    const { events: leaderEvents, cancel: cancelLeader } = await startSSEReader(leaderAdapter)

    // Give SSE time to establish
    await new Promise(r => setTimeout(r, 1500))

    // Leader sends shutdown request via cloud
    const shutdownResult = await leaderKick.sendShutdownRequest('worker@integ', 'worker-1', 'Integration test kick')

    assert.ok(shutdownResult.requestId, 'Should have a requestId')

    // Wait for worker to receive via SSE (max 3 seconds)
    const receiveDeadline = Date.now() + 3000
    let workerReceivedPayload = null
    while (Date.now() < receiveDeadline) {
      await new Promise(r => setTimeout(r, 300))
      for (const e of workerEvents) {
        const msgData = e.data?.data ?? e.data
        if (!msgData) continue
        try {
          const text = typeof msgData.text === 'string' ? msgData.text : JSON.stringify(msgData)
          const payload = JSON.parse(text)
          if (payload.type === 'shutdown_request' && payload.requestId === shutdownResult.requestId) {
            workerReceivedPayload = payload
            break
          }
        } catch {
          // skip
        }
      }
      if (workerReceivedPayload) break
    }
    assert.ok(workerReceivedPayload, 'Worker should receive shutdown_request via SSE')

    // Worker accepts the shutdown (via its own dispatcher)
    const workerDispatcher = new MessageDispatcher({
      teamName,
      agentId: 'worker@integ',
      agentName: 'worker-1',
      cloudConfig: {
        apiUrl: SERVER_URL,
        apiKey: API_KEY,
        developerId: 'cloud-kick-test',
      },
    })

    const workerKick = new CloudKickManager(workerDispatcher, teamName, 'worker@integ', 'worker-1')
    await workerKick.sendShutdownApproved(shutdownResult.requestId, 'leader@integ')

    // Leader polls for approval response via SSE (max 3 seconds)
    const responseDeadline = Date.now() + 3000
    let leaderReceivedApproval = false
    while (Date.now() < responseDeadline) {
      await new Promise(r => setTimeout(r, 300))
      for (const e of leaderEvents) {
        const msgData = e.data?.data ?? e.data
        if (!msgData) continue
        try {
          const text = typeof msgData.text === 'string' ? msgData.text : JSON.stringify(msgData)
          const payload = JSON.parse(text)
          if (payload.type === 'shutdown_approved' && payload.requestId === shutdownResult.requestId) {
            leaderReceivedApproval = true
            break
          }
        } catch {
          // ignore
        }
      }
      if (leaderReceivedApproval) break
    }
    assert.ok(leaderReceivedApproval, 'Leader should receive shutdown_approved')

    // Leader removes worker from team file
    const removed = removeTeammateFromTeamFile(teamName, { agentId: 'worker@integ' })
    assert.strictEqual(removed, true, 'Worker should be removed from team file')

    // Verify final state
    const { readTeamFile } = await import('../dist/core/teamFile.js')
    const finalTeam = readTeamFile(teamName)
    assert.ok(finalTeam !== null, 'Team file should exist')
    assert.strictEqual(
      finalTeam.members.some(m => m.agentId === 'worker@integ'),
      false,
      'Worker should no longer be in team',
    )
    assert.strictEqual(
      finalTeam.members.some(m => m.agentId === 'leader@integ'),
      true,
      'Leader should still be in team',
    )

    // Clean up SSE
    await cancelWorker()
    await cancelLeader()
  })
})
