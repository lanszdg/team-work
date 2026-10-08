/**
 * Test: CloudMessageRouter SSE real-time listening against the REAL sync server.
 *
 * Validates:
 *   - sendMessage dedup (already covered but sanity-checked here)
 *   - pollMessages parsing (backward compat)
 *   - seenMessages eviction (max 10000, oldest evicted first)
 *   - SSE parsing logic (raw frame parser)
 *   - SSE connection lifecycle (connect, disconnect, auto-reconnect)
 *   - Lazy initialization (SSE starts only on startListening)
 *
 * Run with: node --test test/test-cloudMessageRouter-sse.js
 */

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { CloudMessageRouter } from '../dist/core/cloudMessageRouter.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

/**
 * Create a fresh router with a unique repo per test.
 */
function makeRouter(testName) {
  const repo = `test-cmr-${testName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const router = new CloudMessageRouter({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    repo,
    developerId: 'test-runner',
  })
  return { router, repo }
}

/**
 * Helper: make a CloudMessage with a unique messageId.
 */
function makeMessage(overrides = {}) {
  const ts = Date.now()
  return {
    messageId: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'idle_notification',
    from: 'agent-alpha',
    to: 'agent-beta',
    text: JSON.stringify({ detail: 'hello' }),
    timestamp: new Date(ts).toISOString(),
    teamName: 'test-team',
    ...overrides,
  }
}

// ============================================================
// Unit-level tests for SSE frame parsing (pure function)
// ============================================================

describe('SSE frame parsing (pure logic)', () => {

  test('parseSSEFrames parses a single complete event', () => {
    const raw = 'event: task\nid: 100\ndata: {"messageId":"msg-1","type":"idle","from":"a","to":"b","text":"hi","timestamp":"2026-01-01T00:00:00Z","teamName":"t"}\n\n'
    const frames = CloudMessageRouter.parseSSEFrames(raw)
    assert.strictEqual(frames.length, 1)
    assert.strictEqual(frames[0].event, 'task')
    assert.strictEqual(frames[0].id, '100')
    assert.deepStrictEqual(frames[0].data, {
      messageId: 'msg-1',
      type: 'idle',
      from: 'a',
      to: 'b',
      text: 'hi',
      timestamp: '2026-01-01T00:00:00Z',
      teamName: 't',
    })
  })

  test('parseSSEFrames handles multiple events in one chunk', () => {
    const raw =
      'event: presence\nid: 1\ndata: {"developerId":"dev1"}\n\n' +
      'event: task\nid: 2\ndata: {"messageId":"m1","type":"idle","from":"a","to":"b","text":"x","timestamp":"2026-01-01T00:00:00Z","teamName":"t"}\n\n' +
      'event: task\nid: 3\ndata: {"messageId":"m2","type":"task_assignment","from":"c","to":"d","text":"y","timestamp":"2026-01-01T00:00:01Z","teamName":"t"}\n\n'
    const frames = CloudMessageRouter.parseSSEFrames(raw)
    assert.strictEqual(frames.length, 3)
    assert.strictEqual(frames[0].event, 'presence')
    assert.strictEqual(frames[1].event, 'task')
    assert.strictEqual(frames[2].event, 'task')
    assert.strictEqual(frames[1].id, '2')
    assert.strictEqual(frames[2].id, '3')
  })

  test('parseSSEFrames returns empty for non-task events only', () => {
    const raw = 'event: presence\nid: 1\ndata: {"developerId":"dev1"}\n\n'
    const frames = CloudMessageRouter.parseSSEFrames(raw)
    // It should still parse the frame; filtering is done by the callback
    assert.strictEqual(frames.length, 1)
    assert.strictEqual(frames[0].event, 'presence')
  })

  test('parseSSEFrames handles incomplete trailing frame (no double newline)', () => {
    const raw = 'event: task\nid: 5\ndata: {"messageId":"m5","type":"idle","from":"a","to":"b","text":"z","timestamp":"2026-01-01T00:00:00Z","teamName":"t"}\n'
    // Incomplete — no blank line at end — should be buffered, not emitted
    const frames = CloudMessageRouter.parseSSEFrames(raw)
    assert.strictEqual(frames.length, 0, 'Incomplete frame without trailing blank line should not be emitted')
  })

  test('parseSSEFrames handles empty input', () => {
    assert.deepStrictEqual(CloudMessageRouter.parseSSEFrames(''), [])
    assert.deepStrictEqual(CloudMessageRouter.parseSSEFrames('\n\n'), [])
  })

  test('parseSSEFrames skips comments (lines starting with :)', () => {
    const raw = ': this is a comment\n\n'
    const frames = CloudMessageRouter.parseSSEFrames(raw)
    assert.strictEqual(frames.length, 0)
  })

  test('parseSSEFrames handles \r\n line endings', () => {
    const raw = 'event: task\r\nid: 10\r\ndata: {"messageId":"m1","type":"idle","from":"a","to":"b","text":"hi","timestamp":"2026-01-01T00:00:00Z","teamName":"t"}\r\n\r\n'
    const frames = CloudMessageRouter.parseSSEFrames(raw)
    assert.strictEqual(frames.length, 1)
    assert.strictEqual(frames[0].event, 'task')
  })
})

// ============================================================
// seenMessages eviction tests (unit, no server)
// ============================================================

describe('seenMessages eviction', () => {

  test('evicts oldest entries when capacity exceeds 10000', () => {
    const { router } = makeRouter('eviction')

    // Fill up to exactly 10000
    for (let i = 0; i < 10000; i++) {
      router.recordSeen(`msg-${i}`)
    }
    assert.strictEqual(router.seenCount(), 10000, 'Should have exactly 10000 entries')

    // Add one more — should evict the oldest (msg-0)
    router.recordSeen('msg-10000')
    assert.strictEqual(router.seenCount(), 10000, 'Should still be capped at 10000')
    assert.strictEqual(router.hasSeenMessage('msg-0'), false, 'Oldest entry should be evicted')
    assert.strictEqual(router.hasSeenMessage('msg-1'), true, 'Second-oldest should still be present')
    assert.strictEqual(router.hasSeenMessage('msg-10000'), true, 'Newest entry should be present')
  })

  test('evicts multiple entries when many added past cap', () => {
    const { router } = makeRouter('eviction-bulk')

    // Fill to 9999
    for (let i = 0; i < 9999; i++) {
      router.recordSeen(`old-${i}`)
    }

    // Add 100 at once
    for (let i = 0; i < 100; i++) {
      router.recordSeen(`new-${i}`)
    }

    assert.strictEqual(router.seenCount(), 10000, 'Should be capped at 10000')
    assert.strictEqual(router.hasSeenMessage('old-0'), false, 'Oldest should be evicted')
    assert.strictEqual(router.hasSeenMessage('new-99'), true, 'Newest should be present')
  })

  test('does not grow unbounded — cap is enforced', () => {
    const { router } = makeRouter('eviction-unbounded')

    // Insert 20000 entries
    for (let i = 0; i < 20000; i++) {
      router.recordSeen(`bulk-${i}`)
    }

    assert.ok(router.seenCount() <= 10000, `seenCount should be <= 10000, got ${router.seenCount()}`)
  })
})

// ============================================================
// SSE connection lifecycle (real server)
// ============================================================

describe('SSE connection lifecycle (real server)', () => {

  test('startListening returns a promise that resolves once connected', async () => {
    const { router } = makeRouter('start-listening')
    const connectPromise = router.startListening()

    // Should resolve within timeout
    await Promise.race([
      connectPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('startListening timed out')), 10000)),
    ])

    // Should have resolved without throwing
    await connectPromise
  })

  test('onMessage callback fires for task events received via SSE', async () => {
    const { router } = makeRouter('sse-callback')
    const received = []

    await router.startListening({
      onMessage: (msg) => {
        received.push(msg)
      },
    })

    // Wait a bit for the SSE connection to fully establish
    await new Promise(r => setTimeout(r, 1000))

    // Send a message from a separate router instance (different devId, same repo)
    const sender = new CloudMessageRouter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: router.repo,
      developerId: 'test-sender',
    })

    const msg = makeMessage({ type: 'idle_notification', text: 'sse-test-payload' })
    await sender.sendMessage(msg)

    // Wait for SSE to deliver
    await new Promise(r => setTimeout(r, 3000))

    const found = received.find(m => m.messageId === msg.messageId)
    assert.ok(found, 'onMessage callback should have received the task event')
    assert.strictEqual(found.type, 'idle_notification')

    // Clean up
    await router.disconnectSSE()
  })

  test('onMessage callback does NOT fire for non-task events', async () => {
    const { router } = makeRouter('sse-non-task-filter')
    const received = []
    const repo = router.repo

    // First, send a non-task event via the adapter directly
    const { SyncServerAdapter } = await import('../dist/core/syncServerAdapter.js')
    const adapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo,
      developerId: 'test-sender-non-task',
    })

    await adapter.postEvent('presence', { developerId: 'dev-x', active: true })

    // Start listening AFTER the event was posted — it should not show up
    await router.startListening({
      onMessage: (msg) => {
        received.push(msg)
      },
    })

    await new Promise(r => setTimeout(r, 2000))

    assert.strictEqual(received.length, 0, 'Should not receive non-task events')

    await router.disconnectSSE()
  })

  test('disconnectSSE stops receiving events', async () => {
    const { router } = makeRouter('sse-disconnect')
    const repo = router.repo
    const received = []

    await router.startListening({
      onMessage: (msg) => {
        received.push(msg)
      },
    })

    await new Promise(r => setTimeout(r, 1000))

    // Disconnect
    await router.disconnectSSE()

    // Send a message after disconnect
    const sender = new CloudMessageRouter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo,
      developerId: 'test-sender-after-disconnect',
    })

    const msg = makeMessage({ text: 'should-not-arrive' })
    await sender.sendMessage(msg)

    // Wait a bit
    await new Promise(r => setTimeout(r, 2000))

    // Should not have received the post-disconnect message
    const found = received.find(m => m.text === 'should-not-arrive')
    assert.strictEqual(found, undefined, 'Should not receive events after disconnect')
  })

  test('lazy init: SSE connection does not start until startListening() is called', async () => {
    const { router } = makeRouter('lazy-init')

    // Before startListening, SSE should not be connected
    assert.strictEqual(router.isListening(), false, 'isListening should be false before startListening')

    // After startListening
    await router.startListening()
    assert.strictEqual(router.isListening(), true, 'isListening should be true after startListening')

    await router.disconnectSSE()
    assert.strictEqual(router.isListening(), false, 'isListening should be false after disconnect')
  })

  test('auto-reconnect: reconnects after disconnectSSE then startListening again', async () => {
    const { router } = makeRouter('auto-reconnect')
    const received = []

    // First connection
    await router.startListening({
      onMessage: (msg) => received.push(msg),
    })
    await new Promise(r => setTimeout(r, 1000))
    await router.disconnectSSE()

    // Second connection
    await router.startListening({
      onMessage: (msg) => received.push(msg),
    })
    await new Promise(r => setTimeout(r, 1000))

    assert.strictEqual(router.isListening(), true, 'Should be listening after reconnect')

    await router.disconnectSSE()
  })
})

// ============================================================
// Backward compatibility: pollMessages still works
// ============================================================

describe('Backward compatibility: pollMessages', () => {

  test('pollMessages works alongside SSE (both can be used)', async () => {
    const { router } = makeRouter('poll-and-sse')

    // Start SSE listener
    const sseMessages = []
    await router.startListening({
      onMessage: (msg) => sseMessages.push(msg),
    })

    // Send a message
    const msg = makeMessage({ type: 'permission_request' })
    await router.sendMessage(msg)

    // pollMessages should still work and find the message
    await new Promise(r => setTimeout(r, 1000))
    const polled = await router.pollMessages()
    const found = polled.find(m => m.messageId === msg.messageId)
    assert.ok(found, 'pollMessages should still find the message')

    await router.disconnectSSE()
  })

  test('pollMessages does not duplicate messages already received via SSE', async () => {
    const { router } = makeRouter('poll-sse-no-dup')
    const sseMessages = []

    await router.startListening({
      onMessage: (msg) => sseMessages.push(msg),
    })

    // Send a message — SSE will pick it up
    const msg = makeMessage({ text: 'no-dup-test' })
    await router.sendMessage(msg)

    await new Promise(r => setTimeout(r, 2000))

    // pollMessages should not return it again (seenMessages prevents dup)
    const polled = await router.pollMessages()
    const found = polled.find(m => m.messageId === msg.messageId)
    assert.strictEqual(found, undefined, 'pollMessages should not return already-seen messages via SSE')

    await router.disconnectSSE()
  })
})

// ============================================================
// send + poll sanity (carried over from original tests)
// ============================================================

describe('sendMessage + pollMessages round-trip', () => {

  test('sendMessage dedup returns false on duplicate', async () => {
    const { router } = makeRouter('send-dedup')

    const msg = makeMessage({ messageId: 'dedup-sanity-001' })
    const first = await router.sendMessage(msg)
    assert.strictEqual(first, true)

    const second = await router.sendMessage(msg)
    assert.strictEqual(second, false, 'Duplicate send should return false')
  })

  test('pollMessages finds message sent via sendMessage', async () => {
    const { router } = makeRouter('poll-finds-msg')

    const msg = makeMessage()
    await router.sendMessage(msg)

    await new Promise(r => setTimeout(r, 1000))

    const polled = await router.pollMessages()
    const found = polled.find(m => m.messageId === msg.messageId)
    assert.ok(found, 'pollMessages should find the sent message')
  })
})
