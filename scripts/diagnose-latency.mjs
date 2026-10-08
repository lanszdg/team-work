#!/usr/bin/env node
/**
 * Superpowers Phase 1: Diagnostic Instrumentation
 *
 * Measures real latency at each layer of the cloud sync pipeline.
 * Run: node scripts/diagnose-latency.mjs
 *
 * This is evidence gathering — NO fixes, only measurements.
 */

// ============================================================
// Config
// ============================================================
const SYNC_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'
const TEST_REPO = 'latency-diag-' + Date.now().toString(36)
const DEV_ID = 'diag-agent'

// ============================================================
// Helpers
// ============================================================

const results = []

function record(test, metric, value, unit = 'ms') {
  results.push({ test, metric, value, unit })
  const bar = '█'.repeat(Math.min(80, Math.round(value / 10)))
  console.log(`  ${metric.padEnd(40)} ${String(value).padStart(6)}${unit} ${bar}`)
}

async function time(name, fn) {
  const start = performance.now()
  try {
    const result = await fn()
    const elapsed = Math.round(performance.now() - start)
    record('latency', name, elapsed)
    return { result, elapsed, error: null }
  } catch (err) {
    const elapsed = Math.round(performance.now() - start)
    record('latency', `${name} (FAILED)`, elapsed)
    return { result: null, elapsed, error: err.message }
  }
}

async function fetchWithTimer(url, opts = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    return res
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================
// Phase 1.1: Network Baseline
// ============================================================

console.log('\n═══ Phase 1.1: Network Baseline ═══\n')

// DNS resolution
const { elapsed: dnsMs } = await time('DNS resolution (health endpoint)', async () => {
  const url = new URL(SYNC_URL)
  return fetchWithTimer(`${url.origin}/health`)
})

// TCP connect (approximate via first request)
const { elapsed: connectMs } = await time('TCP connect + TLS + HTTP (first GET /health)', async () => {
  const url = new URL(SYNC_URL)
  const res = await fetchWithTimer(`${url.origin}/health`)
  const data = await res.json()
  return data
})

// ============================================================
// Phase 1.2: SyncServerAdapter Single Operations
// ============================================================

console.log('\n═══ Phase 1.2: Single HTTP Operations ═══\n')

// Pull (cold — no ETag cached)
const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
  'X-Developer-ID': DEV_ID,
}

const { elapsed: pullColdMs, result: pullData } = await time('GET pull (cold, no ETag)', async () => {
  const res = await fetchWithTimer(`${SYNC_URL}/api/team_memory?repo=${TEST_REPO}&t=${Date.now()}`, {
    method: 'GET', headers,
  })
  return res.status
})

// Push (single entry)
const testEntry = { entries: { 'test/key': JSON.stringify({ value: 'hello', ts: Date.now() }) } }
const { elapsed: pushSingleMs } = await time('PUT push (single entry)', async () => {
  const res = await fetchWithTimer(`${SYNC_URL}/api/team_memory?repo=${TEST_REPO}`, {
    method: 'PUT', headers, body: JSON.stringify(testEntry),
  })
  return res.status
})

// Pull (warm — after push)
const { elapsed: pullWarmMs } = await time('GET pull (warm, data exists)', async () => {
  const res = await fetchWithTimer(`${SYNC_URL}/api/team_memory?repo=${TEST_REPO}`, {
    method: 'GET', headers,
  })
  return res.status
})

// Post event
const { elapsed: postEventMs } = await time('POST event', async () => {
  const res = await fetchWithTimer(`${SYNC_URL}/api/team_memory/events?repo=${TEST_REPO}`, {
    method: 'POST', headers,
    body: JSON.stringify({ type: 'presence', data: { agentId: DEV_ID, status: 'online', timestamp: Date.now() } }),
  })
  return res.status
})

// Get events
const { elapsed: getEventsMs } = await time('GET events', async () => {
  const res = await fetchWithTimer(`${SYNC_URL}/api/team_memory/events?repo=${TEST_REPO}`, {
    method: 'GET', headers, headers: { ...headers, Accept: 'application/json' },
  })
  return res.status
})

// ============================================================
// Phase 1.3: Serial vs Batch Push (N+1 Problem)
// ============================================================

console.log('\n═══ Phase 1.3: N+1 Serial Push Test ═══\n')

const ENTRY_COUNTS = [1, 5, 10, 20, 50]
const batchRepo = 'latency-batch-' + Date.now().toString(36)

for (const count of ENTRY_COUNTS) {
  const entries = {}
  for (let i = 0; i < count; i++) {
    entries[`batch/key-${i}`] = JSON.stringify({ idx: i, ts: Date.now() })
  }

  const batchRepoN = batchRepo + '-' + count

  // Strategy A: Serial POST (each entry separately — current pushEntries pattern)
  const { elapsed: serialMs } = await time(`Serial push (${count} entries, N POSTs)`, async () => {
    for (const [key, value] of Object.entries(entries)) {
      await fetchWithTimer(`${SYNC_URL}/api/team_memory?repo=${batchRepoN}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ entries: { [key]: value } }),
      })
    }
  })

  // Strategy B: Batch PUT (all entries in one request)
  const { elapsed: batchMs } = await time(`Batch push (${count} entries, 1 PUT)`, async () => {
    await fetchWithTimer(`${SYNC_URL}/api/team_memory?repo=${batchRepoN}-batch`, {
      method: 'PUT', headers,
      body: JSON.stringify({ entries }),
    })
  })

  console.log(`  → ${count} entries: Serial=${serialMs}ms vs Batch=${batchMs}ms (ratio: ${(serialMs / Math.max(1, batchMs)).toFixed(1)}x)\n`)
}

// ============================================================
// Phase 1.4: Full Sync Pipeline (simulate pull→merge→push)
// ============================================================

console.log('\n═══ Phase 1.4: Full Sync Pipeline ═══\n')

const syncRepo = 'latency-sync-' + Date.now().toString(36)

// Pre-seed with remote data
await fetchWithTimer(`${SYNC_URL}/api/team_memory?repo=${syncRepo}`, {
  method: 'PUT', headers,
  body: JSON.stringify({
    entries: {
      'remote/key-1': JSON.stringify({ v: 1 }),
      'remote/key-2': JSON.stringify({ v: 2 }),
      'remote/key-3': JSON.stringify({ v: 3 }),
    },
  }),
})

// Simulate full sync: pull → compute diff → push
const syncLocalEntries = {
  'remote/key-1': JSON.stringify({ v: 1 }),           // same
  'remote/key-2': JSON.stringify({ v: 99 }),           // conflict
  'local/key-a': JSON.stringify({ v: 'new-a' }),       // new local
  'local/key-b': JSON.stringify({ v: 'new-b' }),       // new local
}

const { elapsed: fullSyncMs } = await time('Full sync (pull + diff + push)', async () => {
  // 1. Pull
  const pullRes = await fetchWithTimer(`${SYNC_URL}/api/team_memory?repo=${syncRepo}`, {
    method: 'GET', headers,
  })
  const pullData = await pullRes.json()
  const remoteEntries = pullData?.content?.entries || {}

  // 2. Diff
  const toPush = {}
  for (const [key, localVal] of Object.entries(syncLocalEntries)) {
    const remoteVal = remoteEntries[key]
    if (remoteVal !== localVal) {
      toPush[key] = localVal
    }
  }

  // 3. Push diffs
  if (Object.keys(toPush).length > 0) {
    await fetchWithTimer(`${SYNC_URL}/api/team_memory?repo=${syncRepo}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ entries: toPush }),
    })
  }
})

// ============================================================
// Phase 1.5: SSE Connection Overhead
// ============================================================

console.log('\n═══ Phase 1.5: SSE Connection Setup ═══\n')

const sseRepo = 'latency-sse-' + Date.now().toString(36)

const { elapsed: sseConnectMs } = await time('SSE connection (connect only, no data)', async () => {
  const controller = new AbortController()
  const res = await fetchWithTimer(`${SYNC_URL}/api/team_memory/events?repo=${sseRepo}`, {
    method: 'GET',
    headers: { ...headers, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    signal: controller.signal,
  })
  // Read just first chunk to confirm connection
  const reader = res.body?.getReader()
  if (reader) {
    const { value } = await reader.read()
    if (value) {
      const text = new TextDecoder().decode(value)
      // Got first frame — connection established
    }
    reader.cancel()
  }
  controller.abort()
})

// ============================================================
// Summary
// ============================================================

console.log('\n═══ SUMMARY ═══\n')

const metrics = {}
for (const r of results) {
  if (!metrics[r.metric]) metrics[r.metric] = r
}

console.log('Layer                          Time (ms)  Notes')
console.log('─────                          ─────────  ─────')
console.log(`DNS + HTTP connect             ${String(connectMs || '?').padStart(8)}  Baseline RTT`)
console.log(`GET pull (cold)                ${String(pullColdMs || '?').padStart(8)}  First request, no ETag`)
console.log(`GET pull (warm)                ${String(pullWarmMs || '?').padStart(8)}  After push, data exists`)
console.log(`PUT push (1 entry)             ${String(pushSingleMs || '?').padStart(8)}  Single entry write`)
console.log(`POST event                     ${String(postEventMs || '?').padStart(8)}  Event broadcast`)
console.log(`GET events                     ${String(getEventsMs || '?').padStart(8)}  Event retrieval`)
console.log(`Full sync (4 entries)          ${String(fullSyncMs || '?').padStart(8)}  pull+diff+push pipeline`)
console.log(`SSE connect setup              ${String(sseConnectMs || '?').padStart(8)}  Connection + first frame`)
console.log()

// N+1 projection
const baseLatency = pushSingleMs || 200
console.log('N+1 Projection (per-entry POST):')
console.log(`  10 entries:  ~${baseLatency * 10}ms`)
console.log(`  50 entries:  ~${baseLatency * 50}ms`)
console.log(`  100 entries: ~${baseLatency * 100}ms`)
console.log(`  200 entries: ~${baseLatency * 200}ms`)
console.log()

// Startup projection
console.log('Startup Delay Estimate (sequential init):')
const seqOps = 10 // number of sequential operations in initializeCloudCollaboration
const seqDelay = baseLatency * seqOps + (sseConnectMs || 300) * 3
console.log(`  ~${seqDelay}ms minimum (${seqOps} HTTP ops + 3 SSE connections)`)
console.log()

// Save results
import { writeFileSync } from 'fs'
writeFileSync(
  new URL('../openspec/changes/fix-cloud-sync-latency/diagnostics.json', import.meta.url),
  JSON.stringify({ timestamp: new Date().toISOString(), baseUrl: SYNC_URL, results }, null, 2),
)
console.log('Results saved to openspec/changes/fix-cloud-sync-latency/diagnostics.json')
