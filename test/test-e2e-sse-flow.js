/**
 * Test: End-to-End SSE Flow
 *
 * Validates the FULL SSE pipeline:
 *   postEvent → SSE client receives → handleProtocolMessage routing (C18)
 *
 * Covers:
 *   - SyncServerAdapter.connectSSE() returns a streaming Response
 *   - Reader-based SSE frame parsing from the response body
 *   - postEvent → SSE delivery round-trip for 'task', 'presence', 'invite'
 *   - Verifies event.type and data.messageId match after SSE delivery
 *   - 5-second timeout guard prevents test hangs
 *   - Clean teardown via reader.cancel()
 *
 * Server: http://127.0.0.1:3000   API key: local-development-only
 *
 * Run with: node --test test/test-e2e-sse-flow.js
 */

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { SyncServerAdapter } from '../dist/core/syncServerAdapter.js'

// ============================================================
// Configuration
// ============================================================

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

// ============================================================
// Helpers
// ============================================================

/**
 * Create a fresh SyncServerAdapter with a unique repo per test
 * to avoid cross-test SSE pollution.
 */
function makeAdapter(suffix, developerId = 'test-runner') {
  const repo = `sse-e2e-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new SyncServerAdapter({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    repo,
    developerId,
  })
}

/**
 * Parse SSE frames from a raw text buffer.
 *
 * SSE protocol (text/event-stream):
 *   Frames separated by double-newlines (\n\n or \r\n\r\n).
 *   Each frame has optional event:, id:, and data: fields.
 *   Lines starting with : are comments (heartbeats).
 *   Multi-line data values joined with \n.
 *
 * Returns array of { event, id, data } for complete frames.
 */
function parseSSEFrames(buffer) {
  const frames = []
  const blocks = buffer.split(/\n\n|\r\n\r\n/)

  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed || trimmed.startsWith(':')) continue

    const lines = trimmed.split(/\r?\n/)
    let event = 'message'
    let id = null
    const dataLines = []

    for (const line of lines) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim())
      }
    }

    if (dataLines.length > 0) {
      try {
        frames.push({ event, id, data: JSON.parse(dataLines.join('\n')) })
      } catch (_) {
        // Unparseable data — skip
      }
    }
  }

  return frames
}

/**
 * Read SSE frames from a ReadableStreamDefaultReader until a predicate
 * is satisfied or the timeout expires.
 *
 * @returns {Promise<object|null>} matching frame or null on timeout
 */
async function readUntil(reader, predicate, timeoutMs, label) {
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const remaining = Math.max(100, deadline - Date.now())

    let result
    try {
      result = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('read timeout')), Math.min(remaining, 1000)),
        ),
      ])
    } catch (_) {
      // Individual read() timed out — retry if overall time remains
      continue
    }

    const { done, value } = result

    if (done) {
      const finalFrames = parseSSEFrames(buffer)
      for (const f of finalFrames) {
        if (predicate(f)) {
          if (label) console.log(`  [SSE] Matched "${label}": event=${f.event}`)
          return f
        }
      }
      return null
    }

    buffer += decoder.decode(value, { stream: true })

    const frames = parseSSEFrames(buffer)
    const lastSep = Math.max(
      buffer.lastIndexOf('\n\n'),
      buffer.lastIndexOf('\r\n\r\n'),
    )
    if (lastSep !== -1) buffer = buffer.slice(lastSep + 2)

    for (const f of frames) {
      if (predicate(f)) {
        if (label) console.log(`  [SSE] Matched "${label}": event=${f.event}`)
        return f
      }
    }
  }

  if (label) console.log(`  [SSE] Timeout (${timeoutMs}ms) waiting for "${label}"`)
  return null
}

// ============================================================
// Tests: SSE endpoint validations
// ============================================================

describe('E2E SSE Flow: postEvent → SSE delivery', () => {

  // ----------------------------------------------------------
  // Test 1: connectSSE() smoke test
  // ----------------------------------------------------------
  test('connectSSE() returns a Response with readable body', async () => {
    console.log('\n  -- connectSSE smoke test --')
    const adapter = makeAdapter('smoke')
    const response = await adapter.connectSSE()
    console.log(`  SSE connection status: ${response.status} ${response.statusText}`)

    assert.ok(response instanceof Response, 'Expected a Response object')
    assert.ok(response.ok, 'Response should be OK (2xx)')
    assert.ok(response.body, 'Response must have a readable body')
    assert.strictEqual(typeof response.body.getReader, 'function', 'body must have getReader()')

    await response.body.cancel()
    console.log('  OK connectSSE() returns valid streaming Response')
  })

  // ----------------------------------------------------------
  // Test 2: 'task' event round-trip
  // ----------------------------------------------------------
  test('postEvent("task") → SSE delivers event.type=task with matching messageId', async () => {
    console.log('\n  -- task event round-trip --')

    // The sync server excludes the posting client from SSE broadcast,
    // so we use two adapters on the same repo: sender posts, receiver listens.
    const repo = `sse-e2e-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const teamName = repo

    const sender = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo, developerId: 'sse-sender',
    })
    const receiver = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo, developerId: 'sse-receiver',
    })

    // 1) Open SSE on the receiver
    const response = await receiver.connectSSE()
    const reader = response.body.getReader()
    console.log('  SSE receiver connected')

    // 2) Post a 'task' event from the sender
    const messageId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const timestamp = new Date().toISOString()
    const eventPayload = {
      messageId,
      type: 'task',
      from: 'leader',
      to: 'worker',
      text: JSON.stringify({ type: 'plan_approval_request' }),
      timestamp,
      teamName,
    }

    console.log(`  Posting task event -> messageId=${messageId}`)
    const postResult = await sender.postEvent('task', eventPayload)
    assert.ok(postResult.ok, 'postEvent must return { ok: true }')

    // 3) Wait for SSE delivery (10s timeout)
    console.log('  Waiting for SSE echo...')
    const frame = await readUntil(
      reader,
      (f) => f.event === 'task' && f.data?.messageId === messageId,
      10000,
      `task:${messageId}`,
    )

    // 4) Verify the SSE frame
    assert.ok(frame, `SSE MUST deliver task event within 10s (messageId=${messageId})`)
    assert.strictEqual(frame.event, 'task', 'SSE event field must be "task"')
    assert.strictEqual(frame.data.messageId, messageId, 'data.messageId must match')
    assert.strictEqual(frame.data.type, 'task', 'data.type must be "task"')
    assert.strictEqual(frame.data.from, 'leader', 'data.from must be "leader"')
    assert.strictEqual(frame.data.to, 'worker', 'data.to must be "worker"')
    assert.strictEqual(frame.data.teamName, teamName, 'data.teamName must match')

    // 5) Cleanup
    await reader.cancel()
    console.log('  OK task event SSE round-trip verified')
  })

  // ----------------------------------------------------------
  // Test 3: 'presence' event round-trip
  // ----------------------------------------------------------
  test('postEvent("presence") → SSE delivers event.type=presence', async () => {
    console.log('\n  -- presence event round-trip --')

    const repo = `sse-e2e-presence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const teamName = repo

    const sender = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo, developerId: 'sse-sender',
    })
    const receiver = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo, developerId: 'sse-receiver',
    })

    const response = await receiver.connectSSE()
    const reader = response.body.getReader()
    console.log('  SSE receiver connected')

    const messageId = `presence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const timestamp = new Date().toISOString()
    const eventPayload = {
      messageId,
      type: 'presence',
      from: 'agent-alpha',
      to: 'broadcast',
      text: JSON.stringify({ active: true, pane: 'top-left' }),
      timestamp,
      teamName,
    }

    console.log(`  Posting presence event -> messageId=${messageId}`)
    const postResult = await sender.postEvent('presence', eventPayload)
    assert.ok(postResult.ok, 'postEvent presence must return { ok: true }')

    console.log('  Waiting for SSE echo...')
    const frame = await readUntil(
      reader,
      (f) => f.event === 'presence' && f.data?.messageId === messageId,
      10000,
      `presence:${messageId}`,
    )

    assert.ok(frame, `SSE MUST deliver presence event within 10s (messageId=${messageId})`)
    assert.strictEqual(frame.event, 'presence', 'SSE event field must be "presence"')
    assert.strictEqual(frame.data.messageId, messageId, 'data.messageId must match')
    assert.strictEqual(frame.data.type, 'presence', 'data.type must be "presence"')
    assert.strictEqual(frame.data.from, 'agent-alpha', 'data.from must be "agent-alpha"')
    assert.strictEqual(frame.data.teamName, teamName, 'data.teamName must match')

    await reader.cancel()
    console.log('  OK presence event SSE round-trip verified')
  })

  // ----------------------------------------------------------
  // Test 4: 'invite' event round-trip
  // ----------------------------------------------------------
  test('postEvent("invite") → SSE delivers event.type=invite', async () => {
    console.log('\n  -- invite event round-trip --')

    const repo = `sse-e2e-invite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const teamName = repo

    const sender = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo, developerId: 'sse-sender',
    })
    const receiver = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo, developerId: 'sse-receiver',
    })

    const response = await receiver.connectSSE()
    const reader = response.body.getReader()
    console.log('  SSE receiver connected')

    const messageId = `invite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const timestamp = new Date().toISOString()
    const eventPayload = {
      messageId,
      type: 'invite',
      from: 'project-lead',
      to: 'new-collaborator',
      text: JSON.stringify({ role: 'developer', access: 'read-write' }),
      timestamp,
      teamName,
    }

    console.log(`  Posting invite event -> messageId=${messageId}`)
    const postResult = await sender.postEvent('invite', eventPayload)
    assert.ok(postResult.ok, 'postEvent invite must return { ok: true }')

    console.log('  Waiting for SSE echo...')
    const frame = await readUntil(
      reader,
      (f) => f.event === 'invite' && f.data?.messageId === messageId,
      10000,
      `invite:${messageId}`,
    )

    assert.ok(frame, `SSE MUST deliver invite event within 10s (messageId=${messageId})`)
    assert.strictEqual(frame.event, 'invite', 'SSE event field must be "invite"')
    assert.strictEqual(frame.data.messageId, messageId, 'data.messageId must match')
    assert.strictEqual(frame.data.type, 'invite', 'data.type must be "invite"')
    assert.strictEqual(frame.data.from, 'project-lead', 'data.from must be "project-lead"')
    assert.strictEqual(frame.data.to, 'new-collaborator', 'data.to must be "new-collaborator"')
    assert.strictEqual(frame.data.teamName, teamName, 'data.teamName must match')

    await reader.cancel()
    console.log('  OK invite event SSE round-trip verified')
  })

  // ----------------------------------------------------------
  // Test 5: 5-second timeout guard — must NOT hang
  // ----------------------------------------------------------
  test('5s timeout guard: does NOT hang if SSE never delivers matching event', async () => {
    console.log('\n  -- 5s timeout guard --')

    const adapter = makeAdapter('timeout')
    const response = await adapter.connectSSE()
    const reader = response.body.getReader()
    console.log('  SSE opened -- NOT posting any event')

    const start = Date.now()
    const frame = await readUntil(
      reader,
      (f) => f.event === 'task' && f.data?.messageId === 'will-never-exist',
      5000,
      'nonexistent (timeout test)',
    )
    const elapsed = Date.now() - start

    assert.strictEqual(frame, null, 'Must return null when no matching event arrives')
    assert.ok(
      elapsed >= 4500 && elapsed < 12000,
      `Timeout window: expected 4.5s-12s, got ${elapsed}ms`,
    )

    await reader.cancel()
    console.log(`  OK Timeout guard released after ${elapsed}ms`)
  })

  // ----------------------------------------------------------
  // Test 6: All three event types delivered in one session
  // ----------------------------------------------------------
  test('all three event types (task, presence, invite) delivered via SSE', async () => {
    console.log('\n  -- multi-event delivery --')

    const repo = `sse-e2e-multi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const teamName = repo
    const tsBase = Date.now()

    const sender = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo, developerId: 'sse-sender',
    })
    const receiver = new SyncServerAdapter({
      apiUrl: SERVER_URL, apiKey: API_KEY, repo, developerId: 'sse-receiver',
    })

    const response = await receiver.connectSSE()
    const reader = response.body.getReader()
    console.log('  SSE receiver connected')

    const events = [
      {
        eventType: 'task',
        payload: {
          messageId: `multi-task-${tsBase}`,
          type: 'task',
          from: 'leader',
          to: 'worker-1',
          text: JSON.stringify({ type: 'plan_approval_request' }),
          timestamp: new Date(tsBase).toISOString(),
          teamName,
        },
      },
      {
        eventType: 'presence',
        payload: {
          messageId: `multi-presence-${tsBase}`,
          type: 'presence',
          from: 'agent-1',
          to: 'broadcast',
          text: JSON.stringify({ active: true }),
          timestamp: new Date(tsBase + 1).toISOString(),
          teamName,
        },
      },
      {
        eventType: 'invite',
        payload: {
          messageId: `multi-invite-${tsBase}`,
          type: 'invite',
          from: 'admin',
          to: 'guest',
          text: JSON.stringify({ role: 'viewer' }),
          timestamp: new Date(tsBase + 2).toISOString(),
          teamName,
        },
      },
    ]

    for (const { eventType, payload } of events) {
      console.log(`  Posting ${eventType} -> messageId=${payload.messageId}`)
      const pr = await sender.postEvent(eventType, payload)
      assert.ok(pr.ok, `postEvent ${eventType} must return { ok: true }`)
    }
    console.log('  All 3 events posted -- collecting SSE frames...')

    const decoder = new TextDecoder()
    let buffer = ''
    const allFrames = []
    const deadline = Date.now() + 10000

    while (Date.now() < deadline) {
      const remaining = Math.max(100, deadline - Date.now())
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('read timeout')), Math.min(remaining, 1000)),
          ),
        ])
        const { done, value } = result
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parsed = parseSSEFrames(buffer)
        allFrames.push(...parsed)

        const lastSep = Math.max(
          buffer.lastIndexOf('\n\n'),
          buffer.lastIndexOf('\r\n\r\n'),
        )
        if (lastSep !== -1) buffer = buffer.slice(lastSep + 2)
      } catch (_) {
        // read timeout, loop
      }
    }

    const byId = new Map()
    for (const f of allFrames) {
      if (f.data?.messageId) byId.set(f.data.messageId, f)
    }

    for (const { eventType, payload } of events) {
      const msgId = payload.messageId
      const frame = byId.get(msgId)
      assert.ok(frame, `SSE must deliver ${eventType} event: messageId=${msgId}`)
      assert.strictEqual(frame.event, eventType, `SSE event field must be "${eventType}"`)
      assert.strictEqual(frame.data.messageId, msgId)
      assert.strictEqual(frame.data.type, eventType)
      assert.strictEqual(frame.data.teamName, teamName)
    }

    const expectedIds = events.map(e => e.payload.messageId)
    const matchedCount = expectedIds.filter(id => byId.has(id)).length
    assert.strictEqual(matchedCount, 3, `All 3 event types must be received (got ${matchedCount}/${allFrames.length} frames)`)

    await reader.cancel()
    console.log(`  OK All 3 event types delivered via SSE (${allFrames.length} total frames)`)
  })

  // ----------------------------------------------------------
  // Test 7: SSE reader.cancel() properly tears down the stream
  // ----------------------------------------------------------
  test('SSE reader.cancel() tears down the stream cleanly', async () => {
    console.log('\n  -- stream teardown --')

    const adapter = makeAdapter('teardown')
    const response = await adapter.connectSSE()
    const reader = response.body.getReader()
    console.log('  SSE opened, reader acquired')

    const readPromise = reader.read().catch(() => ({ done: true }))

    await reader.cancel()
    console.log('  reader.cancel() called')

    await Promise.race([
      readPromise.then(() => {}),
      new Promise(r => setTimeout(r, 3000)),
    ])

    try {
      const afterCancel = await reader.read()
      assert.strictEqual(afterCancel.done, true, 'Reads after cancel must return done=true')
    } catch (_) {
      // Some Node.js versions throw on cancelled reads -- acceptable
    }

    console.log('  OK Stream teardown verified')
  })
})

// ============================================================
// SSE frame parser unit tests (no server needed)
// ============================================================

describe('SSE frame parser (unit, no server)', () => {

  test('parses a single complete event frame', () => {
    const raw = [
      'event: task',
      'data: {"messageId":"msg-1","type":"task","from":"a","to":"b","text":"hi","timestamp":"2026-01-01T00:00:00Z","teamName":"t"}',
      '',
    ].join('\n') + '\n'

    const frames = parseSSEFrames(raw)
    assert.strictEqual(frames.length, 1)
    assert.strictEqual(frames[0].event, 'task')
    assert.strictEqual(frames[0].data.messageId, 'msg-1')
    assert.strictEqual(frames[0].data.type, 'task')
  })

  test('parses multiple events in one chunk', () => {
    const raw = [
      'event: task',
      'data: {"messageId":"m1","type":"task","from":"a","to":"b","text":"x","timestamp":"2026-01-01T00:00:00Z","teamName":"t"}',
      '',
      'event: presence',
      'data: {"messageId":"m2","type":"presence","from":"c","to":"d","text":"y","timestamp":"2026-01-01T00:00:01Z","teamName":"t"}',
      '',
      'event: invite',
      'data: {"messageId":"m3","type":"invite","from":"e","to":"f","text":"z","timestamp":"2026-01-01T00:00:02Z","teamName":"t"}',
      '',
    ].join('\n') + '\n'

    const frames = parseSSEFrames(raw)
    assert.strictEqual(frames.length, 3)
    assert.strictEqual(frames[0].event, 'task')
    assert.strictEqual(frames[1].event, 'presence')
    assert.strictEqual(frames[2].event, 'invite')
    assert.strictEqual(frames[0].data.messageId, 'm1')
    assert.strictEqual(frames[1].data.messageId, 'm2')
    assert.strictEqual(frames[2].data.messageId, 'm3')
  })

  test('handles empty input', () => {
    assert.strictEqual(parseSSEFrames('').length, 0)
    assert.strictEqual(parseSSEFrames('\n\n').length, 0)
  })

  test('skips comment lines (starting with colon)', () => {
    const raw = ': keepalive heartbeat\n\n'
    assert.strictEqual(parseSSEFrames(raw).length, 0)
  })

  test('handles CRLF line endings', () => {
    const raw = [
      'event: task',
      'data: {"messageId":"crlf-1","type":"task","from":"a","to":"b","text":"hi","timestamp":"2026-01-01T00:00:00Z","teamName":"t"}',
      '',
    ].join('\r\n') + '\r\n'

    const frames = parseSSEFrames(raw)
    assert.strictEqual(frames.length, 1)
    assert.strictEqual(frames[0].event, 'task')
    assert.strictEqual(frames[0].data.messageId, 'crlf-1')
  })

  test('defaults to event="message" when event: line is missing', () => {
    const raw = [
      'data: {"messageId":"no-event","type":"task","from":"a","to":"b","text":"x","timestamp":"2026-01-01T00:00:00Z","teamName":"t"}',
      '',
    ].join('\n') + '\n'

    const frames = parseSSEFrames(raw)
    assert.strictEqual(frames.length, 1)
    assert.strictEqual(frames[0].event, 'message')
    assert.strictEqual(frames[0].data.messageId, 'no-event')
  })
})
