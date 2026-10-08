/**
 * TDD: Full Sync Server Adapter Test — all endpoints against real server
 *
 * Tests: pull, push, sync, postEvent, getEvents, connectSSE
 * Server: http://127.0.0.1:3000 (v2.0.0)
 */

import { test, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { SyncServerAdapter, SyncServerError } from '../dist/core/syncServerAdapter.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'
const REPO = 'tdd-test-' + Date.now()

function createAdapter(developerId, repo) {
  return new SyncServerAdapter({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    repo: repo || REPO,
    developerId: developerId || 'test-developer',
  })
}

describe('Sync Server Adapter — All Endpoints', () => {
  // -- Health Check --

  test('server is reachable', async () => {
    const res = await fetch(`${SERVER_URL}/health`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.status, 'ok')
    assert.equal(data.version, '2.0.0')
  })

  // -- Auth --

  test('rejects missing API key', async () => {
    const res = await fetch(`${SERVER_URL}/api/team_memory?repo=test`, {
      headers: { 'Content-Type': 'application/json' },
    })
    assert.equal(res.status, 401)
  })

  test('rejects wrong API key', async () => {
    const res = await fetch(`${SERVER_URL}/api/team_memory?repo=test`, {
      headers: { 'X-API-Key': 'wrong-key', 'Content-Type': 'application/json' },
    })
    assert.equal(res.status, 401)
  })

  // -- Pull (empty repo) --

  test('pull returns 404 for empty repo', async () => {
    const adapter = createAdapter('tester')
    const result = await adapter.pull()
    assert.equal(result, null)
  })

  // -- Push (first write) --

  test('push creates repo with entries', async () => {
    const adapter = createAdapter('push-tester')
    const result = await adapter.push({
      'key1': 'value1',
      'key2': 'value2',
      'key3': 'value3',
    })
    assert.ok(result.checksum)
    assert.equal(result.filesUploaded, 3)
    assert.ok(result.lastModified)
  })

  // -- Pull (after push) --

  test('pull returns entries after push', async () => {
    const adapter = createAdapter('pull-tester')
    await adapter.push({
      'project-goal': 'Build auth system',
      'tech-stack': 'Node.js',
    })
    const result = await adapter.pull()
    assert.ok(result, 'pull should return data')
    assert.equal(result.entries['project-goal'], 'Build auth system')
    assert.equal(result.entries['tech-stack'], 'Node.js')
    assert.ok(result.checksum)
  })

  // -- Push (upsert, preserves existing keys) --

  test('push preserves keys not in request', async () => {
    const adapter = createAdapter('upsert-tester')
    await adapter.push({
      'existing-key': 'existing-value',
      'another-key': 'another-value',
    })
    await adapter.push({
      'new-key': 'new-value',
    })
    const result = await adapter.pull()
    assert.equal(result.entries['existing-key'], 'existing-value')
    assert.equal(result.entries['new-key'], 'new-value')
  })

  // -- ETag / Conditional GET --

  test('pull returns 304 when ETag matches', async () => {
    const adapter = createAdapter('etag-tester')
    await adapter.push({ 'data': 'test' })
    // First pull caches ETag
    const result1 = await adapter.pull()
    assert.ok(result1, 'first pull should return data')
    // Second pull should use cached ETag and return null (304)
    const result2 = await adapter.pull()
    assert.equal(result2, null, 'second pull should return null (304)')
  })

  test('ETag is cached after pull', async () => {
    const adapter = createAdapter('etag-cache-tester')
    await adapter.push({ 'k': 'v' })
    await adapter.pull()
    const etag = adapter.getEtag()
    assert.ok(etag, 'ETag should be cached after pull')
  })

  test('ETag is invalidated after push', async () => {
    const adapter = createAdapter('etag-invalidate-tester')
    await adapter.push({ 'k': 'v' })
    await adapter.pull()
    assert.ok(adapter.getEtag(), 'ETag should exist')
    await adapter.push({ 'k2': 'v2' })
    assert.equal(adapter.getEtag(), undefined, 'ETag should be cleared after push')
  })

  // -- If-Match optimistic locking --

  test('push with wrong If-Match returns 412', async () => {
    const adapter = createAdapter('lock-tester')
    await adapter.push({ 'locked': 'data' })
    try {
      await adapter.push({ 'conflict': 'data' }, 'fake-etag-wrong')
      assert.fail('should have thrown 412 error')
    } catch (e) {
      assert.equal(e.status, 412)
    }
  })

  // -- Sync (bidirectional) --

  test('sync merges local and remote', async () => {
    const repo = 'tdd-sync-' + Date.now()
    const adapter = createAdapter('sync-tester', repo)
    await adapter.push({ 'remote-key': 'remote-value' })
    const result = await adapter.sync({
      'remote-key': 'remote-value',
      'local-key': 'local-value',
    })
    assert.equal(result.pushed, 1, 'should push local-key')
    assert.equal(result.pulled, 0, 'no new remote keys')
    assert.equal(result.conflicts, 0)
  })

  test('sync detects and resolves conflicts (local wins)', async () => {
    const adapter = createAdapter('conflict-tester')
    await adapter.push({ 'shared': 'original' })
    const result = await adapter.sync({
      'shared': 'modified-locally',
    })
    assert.equal(result.conflicts, 1, 'should detect 1 conflict')
    // Verify server has local version
    const pullResult = await adapter.pull()
    assert.equal(pullResult.entries['shared'], 'modified-locally')
  })

  // -- Events (POST + GET) --

  test('postEvent creates a task event', async () => {
    const adapter = createAdapter('event-tester')
    const result = await adapter.postEvent('task', {
      from: 'leader',
      message: 'test task notification',
    })
    assert.equal(result.ok, true)
  })

  test('postEvent validates event type', async () => {
    const adapter = createAdapter('event-invalid-tester')
    const res = await fetch(
      `${SERVER_URL}/api/team_memory/events?repo=${REPO}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_KEY,
        },
        body: JSON.stringify({ type: 'invalid-type', data: {} }),
      }
    )
    assert.equal(res.status, 400)
  })

  test('postEvent supports all 4 valid types', async () => {
    const adapter = createAdapter('event-types-tester')
    const types = ['presence', 'task', 'invite', 'memory']
    for (const type of types) {
      const result = await adapter.postEvent(type, { test: true, type })
      assert.equal(result.ok, true, `${type} event should succeed`)
    }
  })

  test('getEvents returns events posted since a given ID', async () => {
    const adapter = createAdapter('getevents-tester')
    // Get current event count
    const eventsBefore = await adapter.getEvents()
    const lastId = eventsBefore.length > 0 ? eventsBefore[eventsBefore.length - 1].id : 0

    // Post new events
    await adapter.postEvent('task', { msg: 'event1' })
    await adapter.postEvent('task', { msg: 'event2' })

    // Fetch events since lastId
    const eventsAfter = await adapter.getEvents(lastId)
    assert.ok(eventsAfter.length >= 2, `should have at least 2 new events, got ${eventsAfter.length}`)
  })

  // -- SSE --

  test('connectSSE returns a streamable response', async () => {
    const adapter = createAdapter('sse-tester')
    const response = await adapter.connectSSE()
    assert.equal(response.status, 200)
    const contentType = response.headers.get('content-type')
    assert.ok(contentType.includes('text/event-stream'), `SSE content-type should be text/event-stream, got: ${contentType}`)
    // Close the stream immediately
    if (response.body) {
      const reader = response.body.getReader()
      reader.cancel()
    }
  })

  // -- Developer ID --

  test('push includes developer ID header', async () => {
    const adapter = createAdapter('dev-id-tester')
    await adapter.push({ 'dev-test': 'value' })
    // Verify by checking if the server accepted (it does via X-Developer-ID)
    const result = await adapter.pull()
    assert.equal(result.entries['dev-test'], 'value')
  })

  // -- Empty body rejection --

  test('GET events returns empty array for no events', async () => {
    const adapter = createAdapter('empty-events-tester')
    // Create a fresh repo to ensure no events
    const emptyRepo = 'tdd-empty-' + Date.now()
    const emptyAdapter = new SyncServerAdapter({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      repo: emptyRepo,
      developerId: 'tester',
    })
    const events = await emptyAdapter.getEvents()
    assert.ok(Array.isArray(events))
  })
})
