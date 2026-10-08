/**
 * Test: SyncServerAdapter against the REAL deployed sync server.
 *
 * Run with: node --test test/test-syncServerAdapter.js
 */

import test, { describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { SyncServerAdapter, SyncServerError } from '../dist/core/syncServerAdapter.js'
import { createTestEnv } from './utils.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

function makeAdapter(repoSuffix) {
  return new SyncServerAdapter({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    repo: `test-adapter-${repoSuffix}-${Date.now()}`,
    developerId: 'test-runner',
  })
}

describe('SyncServerAdapter (real server)', () => {
  let env

  before(() => {
    env = createTestEnv()
  })

  after(() => {
    env.cleanup()
  })

  describe('pull', () => {
    test('returns null for a brand-new repo (404 → no data)', async () => {
      const adapter = makeAdapter('basic')
      const result = await adapter.pull()
      assert.strictEqual(result, null, 'Expected null for empty repo')
    })

    test('returns entries after push', async () => {
      const a = makeAdapter('pull-test')
      await a.push({ greeting: 'hello', farewell: 'goodbye' })

      const result = await a.pull()
      assert.ok(result !== null, 'Expected non-null after push')
      assert.strictEqual(result.entries.greeting, 'hello')
      assert.strictEqual(result.entries.farewell, 'goodbye')
      assert.ok(result.checksum, 'Expected checksum')
    })
  })

  describe('push', () => {
    test('pushes entries and returns checksum + filesUploaded', async () => {
      const a = makeAdapter('push-test')
      const result = await a.push({ key1: 'value1', key2: 'value2' })

      assert.ok(result.checksum, 'Expected checksum')
      assert.ok(typeof result.filesUploaded === 'number', 'Expected filesUploaded as number')
      assert.ok(result.lastModified, 'Expected lastModified')
    })

    test('upsert semantics: existing keys not in PUT are preserved', async () => {
      const a = makeAdapter('upsert-test')
      await a.push({ preserved: 'original', updated: 'v1' })
      await a.push({ updated: 'v2' })

      const pulled = await a.pull()
      assert.ok(pulled !== null)
      assert.strictEqual(pulled.entries.preserved, 'original', 'Preserved key should survive upsert')
      assert.strictEqual(pulled.entries.updated, 'v2', 'Updated key should be v2')
    })
  })

  describe('ETag / conditional GET', () => {
    test('304 when If-None-Match matches server checksum', async () => {
      const a = makeAdapter('if-none-match-test')
      await a.push({ test: 'data' })
      const first = await a.pull()
      assert.ok(first !== null)
      assert.ok(first.etag, 'Got ETag')

      const second = await a.pull()
      assert.strictEqual(second, null, 'Expected 304 → null with matching ETag')
    })
  })

  describe('If-Match / optimistic locking', () => {
    test('412 when If-Match does not match', async () => {
      const a = makeAdapter('if-match-test')
      await a.push({ locked: 'v1' })
      const pulled = await a.pull()
      assert.ok(pulled !== null)

      try {
        await a.push({ locked: 'v2' }, 'wrong-checksum-12345')
        assert.fail('Expected 412 SyncServerError')
      } catch (err) {
        assert.ok(err instanceof SyncServerError, 'Expected SyncServerError')
        assert.strictEqual(err.status, 412, 'Expected 412 status')
      }
    })

    test('succeeds when If-Match matches', async () => {
      const a = makeAdapter('if-match-ok-test')
      await a.push({ locked2: 'v1' })
      const pulled = await a.pull()
      assert.ok(pulled !== null)

      const result = await a.push({ locked2: 'v2' }, pulled.checksum)
      assert.ok(result.checksum, 'Push should succeed with correct checksum')
    })
  })

  describe('sync', () => {
    test('bidirectional sync with no conflicts', async () => {
      const a = makeAdapter('sync-no-conflict')
      await a.push({ 'remote-only': 'from-server' })

      const local = { 'local-only': 'from-client' }
      const result = await a.sync(local)

      assert.strictEqual(result.pushed, 1, 'Should push 1 new key')
      assert.strictEqual(result.pulled, 1, 'Should pull 1 remote key')
      assert.strictEqual(result.conflicts, 0, 'No conflicts expected')
      assert.ok(result.entries['remote-only'] === 'from-server', 'Remote key preserved')
      assert.ok(result.entries['local-only'] === 'from-client', 'Local key pushed')
    })

    test('sync detects and resolves conflicts (local wins)', async () => {
      const a = makeAdapter('sync-conflict')
      await a.push({ 'shared-key': 'remote-value' })

      const local = { 'shared-key': 'local-value' }
      const result = await a.sync(local)

      assert.strictEqual(result.conflicts, 1, 'Should detect 1 conflict')
      assert.strictEqual(result.entries['shared-key'], 'local-value', 'Local should win')
    })

    test('sync with empty remote (first-time push)', async () => {
      const a = makeAdapter('sync-empty-remote')
      const local = { first: 'entry', second: 'entry' }
      const result = await a.sync(local)

      assert.strictEqual(result.conflicts, 0)
      assert.ok(result.pushed >= 1, 'Should push at least 1 entry')
    })
  })

  describe('postEvent', () => {
    test('posts a memory event successfully', async () => {
      const a = makeAdapter('event-test')
      const result = await a.postEvent('memory', { key: 'test', value: 'data' })
      assert.ok(result.ok, 'Expected ok: true')
    })

    test('posts a presence event', async () => {
      const a = makeAdapter('presence-event')
      const result = await a.postEvent('presence', { developerId: 'test', active: true })
      assert.ok(result.ok, 'Expected ok: true')
    })
  })

  describe('getEvents', () => {
    test('returns events array', async () => {
      const a = makeAdapter('get-events-test')
      await a.postEvent('memory', { key: 'test' })

      const events = await a.getEvents()
      assert.ok(Array.isArray(events), 'Expected array response')
    })
  })

  describe('connectSSE', () => {
    test('returns a Response object for SSE stream', async () => {
      const a = makeAdapter('sse-test')
      const response = await a.connectSSE()
      assert.ok(response instanceof Response, 'Expected Response object')
      assert.ok(response.ok, 'SSE connection should be OK')
    })
  })

  describe('error handling', () => {
    test('graceful handling of network errors', async () => {
      const offlineAdapter = new SyncServerAdapter({
        apiUrl: 'http://127.0.0.1:19999',
        apiKey: 'test',
        repo: 'test',
        developerId: 'test',
      })

      try {
        await offlineAdapter.pull()
        assert.fail('Expected network error')
      } catch (err) {
        assert.ok(err instanceof Error, 'Expected Error instance')
      }
    })
  })

  describe('state accessors', () => {
    test('getEtag / setEtag work correctly', async () => {
      const a = makeAdapter('state-test')
      assert.strictEqual(a.getEtag(), undefined, 'Initial ETag should be undefined')
      a.setEtag('"abc123"')
      assert.strictEqual(a.getEtag(), '"abc123"', 'setEtag should store value')
      a.setEtag(undefined)
      assert.strictEqual(a.getEtag(), undefined, 'clear should work')
    })
  })
})
