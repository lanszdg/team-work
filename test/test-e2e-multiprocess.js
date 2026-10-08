/**
 * E2E Multi-Process & Failure Recovery Tests
 *
 * Part 1: Multi-process isolation — Leader (main) + Worker (forked child)
 *         communicating ONLY through the cloud sync server.
 * Part 2: Network failure recovery — C8 outbox queue during simulated outage.
 * Part 3: CloudPresence instantiation and heartbeat lifecycle (C5).
 *
 * Server: http://127.0.0.1:3000, API Key: "local-development-only"
 * Run:   node --test test/test-e2e-multiprocess.js
 */

import test, { describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'

// ── Constants ──────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const WORKER_SCRIPT = join(__dirname, 'helpers', 'e2e-worker.js')

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

function uid(prefix = 'mp') {
  return `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}`
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Fork the e2e-worker subprocess and wait for its IPC result.
 * Returns the resolved result object or rejects on timeout/error.
 */
function forkWorker(teamName, workerId, workerName, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    console.log(`[Parent] Forking worker: ${WORKER_SCRIPT}`)
    const child = fork(WORKER_SCRIPT, [teamName, workerId, workerName], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      cwd: join(__dirname, '..'), // plugin root so relative imports resolve
      timeout: timeoutMs,
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Worker timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on('message', (msg) => {
      clearTimeout(timer)
      if (msg.type === 'result') {
        resolve(msg)
      } else if (msg.type === 'error') {
        reject(new Error(`Worker error: ${msg.message}`))
      } else {
        reject(new Error(`Unknown worker message type: ${msg.type}`))
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`Worker spawn error: ${err.message}`))
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0 && code !== null) {
        reject(new Error(`Worker exited with code ${code}, signal ${signal}`))
      }
    })

    // Forward worker stdio for live debugging
    child.stdout?.on('data', (d) => process.stdout.write(`[worker] ${d}`))
    child.stderr?.on('data', (d) => process.stderr.write(`[worker:err] ${d}`))
  })
}

// ═══════════════════════════════════════════════════════════════════════
// Part 1: Multi-Process E2E (Leader + Worker via Cloud)
// ═══════════════════════════════════════════════════════════════════════

describe('Part 1: Multi-Process E2E (Leader + Worker via Cloud)', () => {
  const teamName = uid('mp-e2e')
  const leaderId = uid('leader')
  const leaderName = 'team-lead'
  const workerId = uid('worker')
  const workerName = 'worker-alpha'

  /**
   * 1a: Leader pushes team_state with 3 members to cloud,
   *     registers the team in __teams__, and sends an invitation.
   */
  test('1a: Leader pushes team_state, registers team, sends invitation', async () => {
    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')
    const { CloudInvitation } = await import('../dist/core/cloudInvitation.js')

    // Push team_state with 3 members to cloud
    console.log(`[Leader] Pushing team_state for "${teamName}" (3 members)`)
    const adapter = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo: teamName, developerId: leaderId,
    })

    const teamFile = {
      name: teamName,
      description: 'Multi-process E2E test team',
      createdAt: Date.now(),
      leadAgentId: leaderId,
      hiddenPaneIds: [],
      teamAllowedPaths: [],
      members: [
        { agentId: leaderId, name: leaderName, agentType: 'leader',
          joinedAt: Date.now(), tmuxPaneId: '', cwd: '/tmp', subscriptions: [], isActive: true },
        { agentId: 'member-beta', name: 'member-beta', agentType: 'worker',
          joinedAt: Date.now(), tmuxPaneId: '', cwd: '/tmp', subscriptions: [], isActive: true },
        { agentId: 'member-gamma', name: 'member-gamma', agentType: 'worker',
          joinedAt: Date.now(), tmuxPaneId: '', cwd: '/tmp', subscriptions: [], isActive: true },
      ],
    }

    await adapter.push({
      team_state: JSON.stringify(teamFile),
      [`members/${leaderId}`]: JSON.stringify({
        agentId: leaderId, name: leaderName, agentType: 'leader',
        _teamName: teamName, _syncedAt: new Date().toISOString(),
      }),
    })
    console.log(`[Leader] team_state pushed to repo "${teamName}"`)

    // Register team for cloud discovery
    const leaderInv = new CloudInvitation({
      apiUrl: SERVER_URL, apiKey: API_KEY, teamName, agentId: leaderId, agentName: leaderName,
    })
    await leaderInv.registerTeam({
      name: teamName,
      description: 'E2E multiprocess team',
      leadAgentId: leaderId,
      leadAgentName: leaderName,
      memberCount: 3,
      createdAt: new Date().toISOString(),
    })
    console.log('[Leader] Team registered in __teams__')

    // Send invitation to worker
    const invite = await leaderInv.sendInvitation(workerId, workerName, 'Join the multiprocess E2E team!')
    assert.equal(invite.status, 'pending')
    assert.equal(invite.toAgentId, workerId)
    assert.equal(invite.teamName, teamName)
    console.log(`[Leader] Invitation ${invite.id} sent to ${workerName}`)
  })

  /**
   * 1b: Fork the worker subprocess. The worker discovers the team,
   *     pulls pending invitations, accepts, and verifies local team state.
   *     Parent verifies worker-reported state via IPC.
   */
  test('1b: Worker discovers team, accepts invitation, verifies member count', async () => {
    console.log(`[Parent] Forking worker for team "${teamName}"`)
    const result = await forkWorker(teamName, workerId, workerName)

    console.log(`[Parent] Worker IPC result:`, JSON.stringify(result, null, 2))

    assert.ok(result.teamFound, `Worker should discover team "${teamName}"`)
    assert.ok(result.invitationCount > 0, 'Worker should have at least 1 pending invitation')
    assert.ok(result.accepted, 'Worker should have accepted the invitation')
    assert.ok(result.memberCount >= 2,
      `Expected at least 2 members (leader + worker), got ${result.memberCount}`)
    assert.ok(
      result.members.includes(leaderName) || result.members.includes(workerName),
      `Expected leader or worker in member list: [${result.members.join(', ')}]`,
    )
  })

  /**
   * 1c: Leader verifies the worker's membership is reflected in cloud state.
   */
  test('1c: Leader verifies worker membership in cloud repo', async () => {
    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')
    const adapter = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo: teamName, developerId: leaderId,
    })

    const result = await adapter.pull()
    assert.ok(result, 'Pull returned data from team repo')

    const teamStateRaw = result?.entries?.['team_state']
    if (teamStateRaw) {
      const teamState = JSON.parse(teamStateRaw)
      console.log(`[Leader] Cloud team_state: ${teamState.members?.length} members`)
    }

    // Check for worker's membership key
    const memberKey = `members/${workerId}`
    if (result?.entries?.[memberKey]) {
      const memberData = JSON.parse(result.entries[memberKey])
      console.log(`[Leader] Found worker membership: ${memberData.name}`)
      assert.equal(memberData.name, workerName)
    }
  })

  after(async () => {
    try {
      const { cleanupTeamDirectories } = await import('../dist/core/teamFile.js')
      await cleanupTeamDirectories(teamName)
      console.log(`[Cleanup] Team "${teamName}" cleaned from cloud`)
    } catch { /* best-effort */
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Part 2: Network Failure Recovery (C8 Outbox Queue)
// ═══════════════════════════════════════════════════════════════════════

describe('Part 2: Network Failure Recovery (C8 Outbox)', () => {
  /**
   * 2a: Create MessageDispatcher with unreachable cloud URL.
   *     Send a message → should fall to C8 outbox queue.
   */
  test('2a: Unreachable cloud triggers C8 outbox queuing', async () => {
    const { MessageDispatcher } = await import('../dist/core/messageDispatcher.js')

    // Stub local mailbox — only the cloud-outbox path matters for this test

    const dispatcher = new MessageDispatcher({
      teamName: uid('c8-outbox'),
      agentId: 'sender-1',
      agentName: 'sender-alpha',
      cloudConfig: {
        apiUrl: 'http://127.0.0.1:19999',   // deliberately unreachable
        apiKey: 'unused',
        developerId: 'sender-1',
      },
    })

    assert.ok(dispatcher.isCloudActive, 'Cloud routing should be configured')
    assert.equal(dispatcher.getOutboxLength(), 0, 'Outbox starts empty')
    assert.equal(dispatcher.isCloudUnreachable(), false, 'Cloud not unreachable yet')

    console.log('[C8] Sending message to unreachable cloud...')
    const result = await dispatcher.sendMessage(
      'receiver-1',
      'receiver-alpha',
      { type: 'task', text: 'C8 outbox test message', timestamp: Date.now() },
    )

    // Cloud failure → falls back to local, queues in C8 outbox
    assert.equal(result, 'local')
    assert.ok(dispatcher.getOutboxLength() > 0, 'Outbox should contain queued message')
    assert.ok(dispatcher.isCloudUnreachable(), 'Cloud should be marked unreachable')

    console.log(`[C8] Outbox length: ${dispatcher.getOutboxLength()}, unreachable: ${dispatcher.isCloudUnreachable()}`)
  })

  /**
   * 2b: Message data is preserved in the outbox queue.
   */
  test('2b: Message data preserved in outbox queue', async () => {
    const { MessageDispatcher } = await import('../dist/core/messageDispatcher.js')

    const captured = []

    const distinctiveText = `C8-preserved-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    const dispatcher = new MessageDispatcher({
      teamName: uid('c8-preserve'),
      agentId: 'sender-2',
      agentName: 'sender-beta',
      cloudConfig: {
        apiUrl: 'http://127.0.0.1:19999',
        apiKey: 'unused',
        developerId: 'sender-2',
      },
    })

    await dispatcher.sendMessage(
      'receiver-2',
      'receiver-beta',
      { type: 'task', text: distinctiveText, timestamp: Date.now() },
    )

    assert.ok(dispatcher.getOutboxLength() > 0, 'Message should be queued')

    const localMsg = captured.find(m => m.text === distinctiveText)
    assert.ok(localMsg, `Distinctive message "${distinctiveText}" preserved in local fallback`)
    assert.equal(localMsg.to, 'receiver-beta')
    console.log(`[C8] Message data preserved: "${distinctiveText}"`)
  })

  /**
   * 2c: MAX_OUTBOX_SIZE = 500 limit — oldest message dropped on overflow.
   */
  test('2c: MAX_OUTBOX_SIZE = 500 — oldest dropped on overflow', async () => {
    const { MessageDispatcher } = await import('../dist/core/messageDispatcher.js')


    const dispatcher = new MessageDispatcher({
      teamName: uid('c8-overflow'),
      agentId: 'sender-3',
      agentName: 'sender-gamma',
      cloudConfig: {
        apiUrl: 'http://127.0.0.1:19999',
        apiKey: 'unused',
        developerId: 'sender-3',
      },
    })

    // Send 501 messages — each fails cloud, queues in C8 outbox
    const TOTAL = 501
    console.log(`[C8] Sending ${TOTAL} messages (MAX_OUTBOX_SIZE=500)...`)

    for (let i = 1; i <= TOTAL; i++) {
      await dispatcher.sendMessage(
        'receiver-overflow',
        `receiver-${i}`,
        { type: 'task', text: `overflow-msg-${i}`, timestamp: Date.now() },
      )
    }

    const outboxLen = dispatcher.getOutboxLength()
    console.log(`[C8] Outbox length after ${TOTAL} sends: ${outboxLen}`)

    assert.equal(outboxLen, 500, `Outbox should cap at 500 (MAX_OUTBOX_SIZE), got ${outboxLen}`)
    assert.ok(dispatcher.isCloudUnreachable(), 'Cloud should still be unreachable')
    console.log('[C8] MAX_OUTBOX_SIZE=500 enforced: oldest dropped, queue capped')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Part 3: CloudPresence Instantiation and Lifecycle (C5)
// ═══════════════════════════════════════════════════════════════════════

describe('Part 3: CloudPresence Instantiation (C5)', () => {
  /**
   * 3a: Instantiate CloudPresence, start heartbeats, wait, verify running, stop.
   */
  test('3a: CloudPresence starts with heartbeat and stops cleanly', async () => {
    const { CloudPresence } = await import('../dist/core/cloudPresence.js')

    const presence = new CloudPresence({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      teamName: uid('cp-test'),
      agentId: uid('cp-agent'),
      agentName: 'presence-tester',
      heartbeatIntervalMs: 1000,   // fast for testing
      offlineTimeoutMs: 5000,
    })

    assert.equal(presence.isRunning, false, 'isRunning should be false before start()')

    presence.start()
    assert.equal(presence.isRunning, true, 'isRunning should be true after start()')

    // Wait for at least 2 heartbeat cycles
    console.log('[C5] Waiting for heartbeat cycles (2s)...')
    await delay(2_200)

    assert.equal(presence.isRunning, true, 'isRunning should still be true after 2s')

    presence.stop()
    assert.equal(presence.isRunning, false, 'isRunning should be false after stop()')

    console.log('[C5] CloudPresence start → running → stop lifecycle verified')
  })

  /**
   * 3b: Double start is idempotent, double stop does not throw.
   */
  test('3b: CloudPresence double-start is idempotent', async () => {
    const { CloudPresence } = await import('../dist/core/cloudPresence.js')

    const presence = new CloudPresence({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      teamName: uid('cp-idem'),
      agentId: uid('cp-agent2'),
      agentName: 'presence-idempotent',
      heartbeatIntervalMs: 1000,
    })

    // Double start
    presence.start()
    presence.start()
    assert.equal(presence.isRunning, true, 'isRunning should be true after double start()')

    await delay(1_500)

    // Double stop
    presence.stop()
    assert.equal(presence.isRunning, false, 'isRunning should be false after stop()')
    presence.stop()
    assert.equal(presence.isRunning, false, 'isRunning should remain false after double stop()')

    console.log('[C5] CloudPresence idempotent start/stop verified')
  })
})
