/**
 * Test: CloudMessageRouter against the REAL deployed sync server.
 *
 * CloudMessageRouter routes mailbox messages through cloud events
 * (type='task') for cross-machine communication. Uses polling, not SSE.
 *
 * Run with: node --test test/test-cloudMessageRouter.js
 */

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { SyncServerAdapter } from '../dist/core/syncServerAdapter.js'
import { CloudMessageRouter } from '../dist/core/cloudMessageRouter.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

/**
 * Create a fresh adapter + router pair with a unique repo per test.
 * Returns sender + receiver routers sharing the same repo (separate dedup sets).
 */
function makeRouter(testName) {
  const repo = `tdd-router-${testName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const adapter = new SyncServerAdapter({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    repo,
    developerId: 'test-runner',
  })
  const router = new CloudMessageRouter({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    repo,
    developerId: 'test-runner',
  })
  const receiver = new CloudMessageRouter({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    repo,
    developerId: 'test-receiver',
  })
  return { adapter, router, receiver, repo }
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

describe('CloudMessageRouter (real server)', () => {

  describe('sendMessage', () => {
    test('posts event successfully, verified by pollMessages finding it', async () => {
      const { router, receiver } = makeRouter('send-and-poll')

      const msg = makeMessage({ type: 'idle_notification' })
      const result = await router.sendMessage(msg)
      assert.strictEqual(result, true, 'sendMessage should return true for first send')

      // Small delay so the server indexes the event
      await new Promise(r => setTimeout(r, 500))

      const polled = await receiver.pollMessages()
      assert.ok(polled.length >= 1, 'Should find at least one message')

      const found = polled.find(m => m.messageId === msg.messageId)
      assert.ok(found, 'Polled messages should contain the sent message')
      assert.strictEqual(found.type, 'idle_notification')
      assert.strictEqual(found.from, 'agent-alpha')
      assert.strictEqual(found.to, 'agent-beta')
    })
  })

  describe('message types round-trip', () => {
    test('idle_notification round-trips correctly', async () => {
      const { router, receiver } = makeRouter('type-idle')
      const msg = makeMessage({ type: 'idle_notification', text: JSON.stringify({ cpu: 0.1 }) })
      await router.sendMessage(msg)
      await new Promise(r => setTimeout(r, 500))

      const polled = await receiver.pollMessages()
      const found = polled.find(m => m.messageId === msg.messageId)
      assert.ok(found)
      assert.strictEqual(found.type, 'idle_notification')
    })

    test('permission_request round-trips correctly', async () => {
      const { router, receiver } = makeRouter('type-permission')
      const msg = makeMessage({ type: 'permission_request', text: JSON.stringify({ resource: 'deploy', action: 'approve' }) })
      await router.sendMessage(msg)
      await new Promise(r => setTimeout(r, 500))

      const polled = await receiver.pollMessages()
      const found = polled.find(m => m.messageId === msg.messageId)
      assert.ok(found)
      assert.strictEqual(found.type, 'permission_request')
    })

    test('task_assignment round-trips correctly', async () => {
      const { router, receiver } = makeRouter('type-task-assignment')
      const msg = makeMessage({ type: 'task_assignment', text: JSON.stringify({ taskId: 't-42', priority: 'high' }) })
      await router.sendMessage(msg)
      await new Promise(r => setTimeout(r, 500))

      const polled = await receiver.pollMessages()
      const found = polled.find(m => m.messageId === msg.messageId)
      assert.ok(found)
      assert.strictEqual(found.type, 'task_assignment')
    })
  })

  describe('dedup', () => {
    test('calling sendMessage twice with same messageId returns false on second call', async () => {
      const { router, receiver } = makeRouter('dedup')

      const msg = makeMessage({ messageId: 'dedup-msg-001' })
      const first = await router.sendMessage(msg)
      assert.strictEqual(first, true, 'First send should return true')

      const second = await router.sendMessage(msg)
      assert.strictEqual(second, false, 'Second send with same messageId should return false (dedup)')

      // Only one event should have been posted
      await new Promise(r => setTimeout(r, 500))
      const polled = await receiver.pollMessages()
      const matches = polled.filter(m => m.messageId === 'dedup-msg-001')
      assert.strictEqual(matches.length, 1, 'Should find exactly one event on server')
    })
  })

  describe('pollMessages', () => {
    test('returns empty array when no new events', async () => {
      const { router } = makeRouter('poll-empty')
      const polled = await router.pollMessages()
      assert.ok(Array.isArray(polled), 'pollMessages should return an array')
      assert.strictEqual(polled.length, 0, 'Should return empty array for fresh repo')
    })

    test('filters only task type events (ignores presence, invite, memory)', async () => {
      const { adapter, router, receiver } = makeRouter('poll-filter')

      // Post non-task events directly via adapter (these go to SSE events only, not KV)
      await adapter.postEvent('presence', { developerId: 'test', active: true })
      await adapter.postEvent('invite', { invited: 'agent-gamma' })
      await adapter.postEvent('memory', { key: 'note', value: 'something' })

      // Post one task event via the router (goes to KV + SSE)
      const msg = makeMessage({ type: 'idle_notification' })
      await router.sendMessage(msg)

      await new Promise(r => setTimeout(r, 500))

      // Receiver polls KV — only task messages (from sendMessage) are in KV
      const polled = await receiver.pollMessages()

      const found = polled.find(m => m.messageId === msg.messageId)
      assert.ok(found, 'Should find the task event we sent')

      // Non-task events (presence, invite, memory) are NOT stored in KV,
      // so they naturally don't appear in pollMessages results
      assert.strictEqual(polled.length, 1, 'Should only contain the task message from KV')
    })
  })

  describe('message content preserved round-trip', () => {
    test('JSON text field is intact after round-trip', async () => {
      const { router, receiver } = makeRouter('content-roundtrip')

      const payload = {
        files: ['src/index.ts', 'lib/util.ts'],
        reason: 'refactor',
        reviewer: 'agent-charlie',
        nested: { level: { deep: true, count: 42 } },
      }
      const msg = makeMessage({ text: JSON.stringify(payload) })
      await router.sendMessage(msg)
      await new Promise(r => setTimeout(r, 500))

      const polled = await receiver.pollMessages()
      const found = polled.find(m => m.messageId === msg.messageId)
      assert.ok(found, 'Message should be found')

      // The text field should be the exact JSON string we sent
      assert.strictEqual(found.text, JSON.stringify(payload), 'text field should be preserved as JSON string')

      // And it should parse back correctly
      const parsed = JSON.parse(found.text)
      assert.deepStrictEqual(parsed, payload, 'Parsed text should match original payload')
    })

    test('all CloudMessage fields survive round-trip', async () => {
      const { router, receiver } = makeRouter('fields-roundtrip')

      const original = {
        messageId: 'roundtrip-001',
        type: 'task_assignment',
        from: 'sender-01',
        to: 'receiver-01',
        text: '{"taskId":"abc"}',
        timestamp: '2026-04-24T10:00:00.000Z',
        teamName: 'alpha-squad',
      }
      await router.sendMessage(original)
      await new Promise(r => setTimeout(r, 500))

      const polled = await receiver.pollMessages()
      const found = polled.find(m => m.messageId === original.messageId)
      assert.ok(found)

      assert.strictEqual(found.messageId, original.messageId)
      assert.strictEqual(found.type, original.type)
      assert.strictEqual(found.from, original.from)
      assert.strictEqual(found.to, original.to)
      assert.strictEqual(found.text, original.text)
      assert.strictEqual(found.timestamp, original.timestamp)
      assert.strictEqual(found.teamName, original.teamName)
    })
  })
})
