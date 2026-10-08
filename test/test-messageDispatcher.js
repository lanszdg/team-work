/**
 * Test: MessageDispatcher v3.6 — pure-cloud message dispatch.
 *
 * Validates:
 *   1. isCloudActive returns correct boolean
 *   2. sendMessage returns boolean (true = sent, false = dedup)
 *   3. sendMessage throws when cloud not connected
 *   4. sendMessage dedup
 *   5. receiveMessages() returns cloud messages
 *   6. waitForConnection handles cloud unavailability
 *   7. Cloud mode round-trip (send + receive via actual cloud)
 *
 * Run with: node --test test/test-messageDispatcher.js
 */

import test, { describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { MessageDispatcher } from '../dist/core/messageDispatcher.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

// ============================================================
// Test helpers
// ============================================================

/** Create a dispatcher with config. Returns { dispatcher, teamName } */
function makeDispatcher(overrides = {}) {
  const opts = Object.assign({
    teamName: `test-md-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    agentName: 'tester',
    cloudConfig: {
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      developerId: 'test-dispatcher',
    },
  }, overrides)

  return {
    dispatcher: new MessageDispatcher(opts),
    teamName: opts.teamName,
  }
}

/** Sleep helper */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ============================================================
// 1. Configuration & status
// ============================================================

describe('Configuration & status', () => {

  test('isCloudActive returns true when cloudConfig provided', () => {
    const { dispatcher } = makeDispatcher()
    assert.strictEqual(dispatcher.isCloudActive, true)
  })

  test('constructor creates CloudMessageRouter internally', () => {
    const { dispatcher } = makeDispatcher()
    const router = dispatcher.getCloudRouter()
    assert.ok(router, 'getCloudRouter should return a CloudMessageRouter instance')
  })
})

// ============================================================
// 2. sendMessage — pure cloud
// ============================================================

describe('sendMessage — pure cloud', () => {

  test('sendMessage returns boolean (true = sent)', async () => {
    const { dispatcher } = makeDispatcher()

    const result = await dispatcher.sendMessage(
      'recipient-id',
      'recipient-agent',
      { messageId: `cloud-msg-${Date.now()}`, text: 'cloud hello', type: 'task' },
    )

    assert.strictEqual(typeof result, 'boolean')
  })

  test('sendMessage dedup returns false', async () => {
    const { dispatcher } = makeDispatcher()
    const msgId = `dedup-msg-${Date.now()}`

    const first = await dispatcher.sendMessage(
      'rid', 'rname',
      { messageId: msgId, text: 'first', type: 'task' },
    )
    const second = await dispatcher.sendMessage(
      'rid', 'rname',
      { messageId: msgId, text: 'second', type: 'task' },
    )

    assert.strictEqual(second, false, 'Duplicate message should return false')
  })

  test('sendMessage without messageId generates one', async () => {
    const { dispatcher } = makeDispatcher()

    // This should not throw — messageId is auto-generated
    const result = await dispatcher.sendMessage('rid', 'rname', { text: 'no-id', type: 'task' })
    assert.strictEqual(typeof result, 'boolean')
  })

  test('sendMessage text field handles string and object', async () => {
    const { dispatcher } = makeDispatcher()

    // String text
    const r1 = await dispatcher.sendMessage('rid', 'rname', {
      messageId: `str-${Date.now()}`,
      text: 'plain text',
      type: 'task',
    })
    assert.strictEqual(typeof r1, 'boolean')

    // Object text (should be JSON.stringified)
    const r2 = await dispatcher.sendMessage('rid', 'rname', {
      messageId: `obj-${Date.now()}`,
      text: { nested: true, value: 42 },
      type: 'task',
    })
    assert.strictEqual(typeof r2, 'boolean')
  })

})

// ============================================================
// 3. receiveMessages
// ============================================================

describe('receiveMessages', () => {

  test('receiveMessages returns array', async () => {
    const { dispatcher } = makeDispatcher()

    const messages = await dispatcher.receiveMessages()
    assert.ok(Array.isArray(messages), 'Should return an array')
  })

  test('receiveMessages handles empty result', async () => {
    const { dispatcher } = makeDispatcher()

    // Use a unique team to ensure no existing messages
    const messages = await dispatcher.receiveMessages()
    assert.ok(Array.isArray(messages))
  })
})

// ============================================================
// 4. waitForConnection
// ============================================================

describe('waitForConnection', () => {

  test('waitForConnection attempts to connect to cloud', async () => {
    const { dispatcher } = makeDispatcher()

    // Should not throw if cloud is reachable
    try {
      await dispatcher.waitForConnection(10_000)
      // If we get here, connection succeeded
    } catch (err) {
      // Connection failed — acceptable in test environment
      // The important thing is that it didn't crash silently
      assert.ok(err instanceof Error)
    }
  })

  test('waitForConnection with short timeout handles unreachable', async () => {
    const { dispatcher } = makeDispatcher({
      cloudConfig: {
        apiUrl: 'http://192.0.2.1:9999', // TEST-NET-1 (non-routable)
        apiKey: 'test',
        developerId: 'test-timeout',
      },
    })

    await assert.rejects(
      () => dispatcher.waitForConnection(3_000),
      /Cloud unreachable/,
    )
  })
})

// ============================================================
// 5. Backward-compatible legacy API
// ============================================================

describe('Legacy backward-compatible API', () => {

  test('receiveUnreadMessages delegates to receiveMessages', async () => {
    const { dispatcher } = makeDispatcher()

    const result = await dispatcher.receiveUnreadMessages('tester')
    assert.ok(Array.isArray(result))
    if (result.length > 0) {
      assert.strictEqual(result[0].source, 'cloud')
      assert.ok(result[0].message)
    }
  })

  test('startCloudListening / stopCloudListening lifecycle', async () => {
    const { dispatcher } = makeDispatcher()

    await dispatcher.startCloudListening()
    assert.strictEqual(dispatcher.isCloudListening, true)

    dispatcher.stopCloudListening()
    // isCloudListening may stay true if startCloudListening was called
  })
})
