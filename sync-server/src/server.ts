/**
 * Local Team Memory Sync Server
 *
 * Drop-in replacement for Anthropic Cloud API's team memory sync endpoints.
 * Designed for teams who cannot access the Anthropic Cloud API.
 *
 * Compatible with Claude Code's TeamMemorySync client (src/services/teamMemorySync/index.ts):
 *   - GET  /api/claude_code/team_memory?repo={slug}           → TeamMemoryData
 *   - GET  /api/claude_code/team_memory?repo={slug}&view=hashes → hash metadata
 *   - PUT  /api/claude_code/team_memory?repo={slug}           → upload entries
 *   - GET  /api/team_memory?repo={slug}                        → (alias)
 *   - PUT  /api/team_memory?repo={slug}                        → (alias)
 *   - GET  /api/team_memory/events?repo={slug}                 → SSE event stream
 *
 * Features:
 *   - ETag-based conditional GET (304 Not Modified)
 *   - If-Match optimistic locking (412 Conflict)
 *   - Delta upload (upsert semantics — keys not in PUT are preserved)
 *   - Structured 413 for entry-count limits (compatible with TeamMemorySync client)
 *   - Optional X-API-Key authentication (timing-safe comparison)
 *   - 2MB request body limit
 *   - SQLite WAL mode for concurrent read/write
 *   - Dual API path support (/api/claude_code/team_memory and /api/team_memory)
 *   - SSE real-time event push (memory/presence/task/invite events)
 *   - POST /api/team_memory/events for client-side event broadcasting
 */

import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import Database from 'better-sqlite3'
import { createHash, timingSafeEqual } from 'crypto'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

// ─── Configuration ──────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '0.0.0.0'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'
const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'team-sync.db')
const MAX_ENTRIES = parseInt(process.env.MAX_ENTRIES || '1000', 10)
const MAX_ENTRY_SIZE = parseInt(process.env.MAX_ENTRY_SIZE || '250000', 10)
const SSE_PING_INTERVAL_MS = parseInt(process.env.SSE_PING_INTERVAL || '30000', 10)
const SSE_MAX_CLIENTS = parseInt(process.env.SSE_MAX_CLIENTS || '100', 10)

// ─── Database Setup ─────────────────────────────────────────

mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS team_memory (
    repo       TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, key)
  );
  CREATE INDEX IF NOT EXISTS idx_repo ON team_memory(repo);

  CREATE TABLE IF NOT EXISTS sse_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    repo       TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_id   TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sse_events_repo ON sse_events(repo, id);
`)

// ─── SSE Event Bus ──────────────────────────────────────────

type SSEClient = {
  id: string
  repo: string
  developerId: string
  reply: FastifyReply
  connectedAt: number
  lastEventId: number
}

type SSEEventType = 'memory' | 'presence' | 'task' | 'invite' | 'ping'

type SSEEventPayload = {
  type: SSEEventType
  id: string
  data: Record<string, unknown>
  timestamp: string
}

const sseClients: Map<string, SSEClient> = new Map()
let eventCounter = 0

function addSSEClient(client: SSEClient): void {
  if (sseClients.size >= SSE_MAX_CLIENTS) {
    const oldest = [...sseClients.entries()]
      .sort((a, b) => a[1].connectedAt - b[1].connectedAt)[0]
    if (oldest) {
      try {
        oldest[1].reply.raw.end()
      } catch { /* ignore */ }
      sseClients.delete(oldest[0])
    }
  }
  sseClients.set(client.id, client)
}

function removeSSEClient(clientId: string): void {
  sseClients.delete(clientId)
}

function broadcastSSEEvent(
  repo: string,
  type: SSEEventType,
  data: Record<string, unknown>,
  sourceClientId?: string,
): void {
  eventCounter++
  const eventId = eventCounter
  const eventPayload: SSEEventPayload = {
    type,
    id: `evt-${eventId}`,
    data,
    timestamp: new Date().toISOString(),
  }

  const insertStmt = db.prepare(
    'INSERT INTO sse_events (repo, event_type, event_id, data, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  insertStmt.run(repo, type, eventPayload.id, JSON.stringify(data), eventPayload.timestamp)

  const serialized = JSON.stringify(eventPayload)

  for (const [clientId, client] of sseClients) {
    if (client.repo !== repo) continue
    if (clientId === sourceClientId) continue
    if (client.lastEventId >= eventId) continue

    try {
      client.reply.raw.write(`event: ${type}\nid: ${eventId}\ndata: ${serialized}\n\n`)
      client.lastEventId = eventId
    } catch {
      removeSSEClient(clientId)
    }
  }

  cleanupOldEvents()
}

function cleanupOldEvents(): void {
  const maxRows = parseInt(process.env.SSE_EVENT_MAX_ROWS || '10000', 10)
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM sse_events').get() as { cnt: number }).cnt
  if (count > maxRows) {
    const cutoff = count - Math.floor(maxRows * 0.8)
    db.prepare('DELETE FROM sse_events WHERE rowid IN (SELECT rowid FROM sse_events ORDER BY rowid LIMIT ?)').run(cutoff)
  }
}

function getEventsSince(repo: string, afterEventId: number): Array<{ type: string; id: number; data: string }> {
  return db.prepare(
    'SELECT event_type as type, id, data FROM sse_events WHERE repo = ? AND id > ? ORDER BY id ASC',
  ).all(repo, afterEventId) as Array<{ type: string; id: number; data: string }>
}

// ─── Utility Functions ──────────────────────────────────────

function sha256(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex')
}

function computeVersion(repo: string): string {
  const rows = db.prepare(
    'SELECT checksum FROM team_memory WHERE repo = ? ORDER BY key',
  ).all(repo) as Array<{ checksum: string }>
  if (rows.length === 0) return sha256('')
  return sha256(rows.map(r => r.checksum).join('\n'))
}

function countEntries(repo: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM team_memory WHERE repo = ?',
  ).get(repo) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

function keyExists(repo: string, key: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM team_memory WHERE repo = ? AND key = ?',
  ).get(repo, key)
  return row !== undefined
}

// ─── Shared Route Handlers ──────────────────────────────────

async function handleGetTeamMemory(request: FastifyRequest, reply: FastifyReply) {
  const query = request.query as Record<string, string | undefined>
  const repo = query.repo
  if (!repo) {
    await reply.code(400).send({ error: 'repo parameter is required' })
    return
  }

  const view = query.view
  const ifNoneMatch = request.headers['if-none-match'] as string | undefined

  if (view === 'hashes') {
    const rows = db.prepare(
      'SELECT key, checksum FROM team_memory WHERE repo = ? ORDER BY key',
    ).all(repo) as Array<{ key: string; checksum: string }>

    const version = computeVersion(repo)

    await reply.send({
      version: 0,
      checksum: version,
      entryChecksums: Object.fromEntries(rows.map(r => [r.key, r.checksum])),
    })
    return
  }

  const rows = db.prepare(
    'SELECT key, value, checksum, updated_at FROM team_memory WHERE repo = ? ORDER BY key',
  ).all(repo) as Array<{ key: string; value: string; checksum: string; updated_at: string }>

  const version = computeVersion(repo)

  if (ifNoneMatch) {
    const clientETag = ifNoneMatch.replace(/"/g, '')
    if (clientETag === version) {
      await reply
        .header('ETag', `"${version}"`)
        .code(304)
        .send()
      return
    }
  }

  if (rows.length === 0) {
    await reply.code(404).send({
      error: 'No data exists for this repo',
      repo,
    })
    return
  }

  await reply
    .header('ETag', `"${version}"`)
    .send({
      organizationId: 'local',
      repo,
      version: 0,
      lastModified: rows.reduce((latest, r) =>
        r.updated_at > latest ? r.updated_at : latest,
      rows[0]!.updated_at),
      checksum: version,
      content: {
        entries: Object.fromEntries(rows.map(r => [r.key, r.value])),
        entryChecksums: Object.fromEntries(rows.map(r => [r.key, r.checksum])),
      },
    })
}

async function handlePutTeamMemory(request: FastifyRequest, reply: FastifyReply) {
  const query = request.query as Record<string, string | undefined>
  const repo = query.repo
  if (!repo) {
    await reply.code(400).send({ error: 'repo parameter is required' })
    return
  }

  const ifMatch = request.headers['if-match'] as string | undefined
  const body = request.body as { entries?: Record<string, string> } | undefined

  if (!body || typeof body !== 'object' || !body.entries || typeof body.entries !== 'object') {
    await reply.code(400).send({ error: 'Request body must contain an "entries" object' })
    return
  }

  const entries = body.entries

  if (ifMatch) {
    const currentVersion = computeVersion(repo)
    const expectedVersion = ifMatch.replace(/"/g, '')
    if (currentVersion !== expectedVersion) {
      await reply.code(412).send({
        error: 'Conflict',
        currentVersion,
        message: 'Server state has changed since your last read. Please pull and retry.',
      })
      return
    }
  }

  const currentCount = countEntries(repo)
  const newKeys = Object.keys(entries).filter(k => !keyExists(repo, k))

  if (currentCount + newKeys.length > MAX_ENTRIES) {
    await reply.code(413).send({
      error: {
        details: {
          error_code: 'team_memory_too_many_entries',
          max_entries: MAX_ENTRIES,
          received_entries: currentCount + newKeys.length,
        },
      },
    })
    return
  }

  const upsert = db.prepare(`
    INSERT INTO team_memory (repo, key, value, checksum, updated_at, size)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo, key) DO UPDATE SET
      value = excluded.value,
      checksum = excluded.checksum,
      updated_at = excluded.updated_at,
      size = excluded.size
  `)

  const transaction = db.transaction(() => {
    let uploadedCount = 0
    for (const [key, value] of Object.entries(entries)) {
      const entrySize = Buffer.byteLength(value, 'utf8')
      if (entrySize > MAX_ENTRY_SIZE) {
        request.log.warn(
          `Skipping oversized entry "${key}": ${entrySize} bytes > ${MAX_ENTRY_SIZE} limit`,
        )
        continue
      }

      const checksum = sha256(value)
      const now = new Date().toISOString()
      upsert.run(repo, key, value, checksum, now, entrySize)
      uploadedCount++
    }
    return uploadedCount
  })

  const filesUploaded = transaction()
  const newVersion = computeVersion(repo)

  const sseClientId = request.headers['x-sse-client-id'] as string | undefined
  broadcastSSEEvent(repo, 'memory', {
    keys: Object.keys(entries),
    checksum: newVersion,
    updatedBy: request.headers['x-developer-id'] as string || 'unknown',
  }, sseClientId)

  await reply
    .header('ETag', `"${newVersion}"`)
    .send({
      checksum: newVersion,
      lastModified: new Date().toISOString(),
      filesUploaded,
    })
}

// ─── SSE Endpoint ───────────────────────────────────────────

async function handleSSEConnect(request: FastifyRequest, reply: FastifyReply) {
  const query = request.query as Record<string, string | undefined>
  const repo = query.repo
  if (!repo) {
    await reply.code(400).send({ error: 'repo parameter is required' })
    return
  }

  const developerId = query.developerId || request.headers['x-developer-id'] as string || 'unknown'
  const lastEventIdStr = query.last_event_id || request.headers['last-event-id'] as string
  const lastEventId = lastEventIdStr ? parseInt(lastEventIdStr, 10) : 0

  const clientId = randomUUID()

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  })

  reply.raw.write(`event: connected\ndata: {"clientId":"${clientId}","timestamp":"${new Date().toISOString()}"}\n\n`)

  if (lastEventId > 0) {
    const missed = getEventsSince(repo, lastEventId)
    for (const evt of missed) {
      reply.raw.write(`event: ${evt.type}\nid: ${evt.id}\ndata: ${evt.data}\n\n`)
    }
  }

  const client: SSEClient = {
    id: clientId,
    repo,
    developerId,
    reply,
    connectedAt: Date.now(),
    lastEventId: lastEventId > 0 ? lastEventId : eventCounter,
  }
  addSSEClient(client)

  const pingTimer = setInterval(() => {
    try {
      reply.raw.write(`event: ping\ndata: {"ts":"${new Date().toISOString()}"}\n\n`)
    } catch {
      clearInterval(pingTimer)
      removeSSEClient(clientId)
    }
  }, SSE_PING_INTERVAL_MS)

  request.raw.on('close', () => {
    clearInterval(pingTimer)
    removeSSEClient(clientId)
  })
}

// ─── Event Broadcast Endpoint ───────────────────────────────

async function handlePostEvent(request: FastifyRequest, reply: FastifyReply) {
  const query = request.query as Record<string, string | undefined>
  const repo = query.repo
  if (!repo) {
    await reply.code(400).send({ error: 'repo parameter is required' })
    return
  }

  const body = request.body as {
    type?: string
    data?: Record<string, unknown>
  } | undefined

  if (!body || !body.type || !body.data) {
    await reply.code(400).send({ error: 'Request body must contain "type" and "data" fields' })
    return
  }

  const validTypes = ['presence', 'task', 'invite', 'memory']
  if (!validTypes.includes(body.type)) {
    await reply.code(400).send({ error: `Invalid event type "${body.type}". Must be one of: ${validTypes.join(', ')}` })
    return
  }

  const sseClientId = request.headers['x-sse-client-id'] as string | undefined

  broadcastSSEEvent(repo, body.type as SSEEventType, {
    ...body.data,
    sourceDeveloperId: request.headers['x-developer-id'] as string || 'unknown',
  }, sseClientId)

  await reply.send({ ok: true, event_type: body.type })
}

// ─── Fastify Application ────────────────────────────────────

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
  bodyLimit: parseInt(process.env.BODY_LIMIT || '2097152', 10),
})

// ─── Auth Middleware ─────────────────────────────────────────

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(Buffer.from(a), Buffer.from(a))
    return false
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return
  if (!API_KEY) return

  const provided = request.headers['x-api-key'] as string | undefined

  if (!provided || !safeEqual(provided, API_KEY)) {
    return reply.code(401).send({ error: 'Invalid or missing API key' })
  }
})

// ─── Dashboard (read-only web UI) ────────────────────────────

import { readFileSync, existsSync } from 'fs'

const DASHBOARD_PATH = join(dirname(fileURLToPath(import.meta.url)), 'static', 'dashboard.html')

app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
  if (existsSync(DASHBOARD_PATH)) {
    const html = readFileSync(DASHBOARD_PATH, 'utf-8')
    return reply.type('text/html').send(html)
  }
  return reply.redirect('/health')
})

app.get('/dashboard', async (_req: FastifyRequest, reply: FastifyReply) => {
  if (existsSync(DASHBOARD_PATH)) {
    const html = readFileSync(DASHBOARD_PATH, 'utf-8')
    return reply.type('text/html').send(html)
  }
  return reply.status(404).send({ error: 'dashboard not found' })
})

// ─── Health Check ───────────────────────────────────────────

app.get('/health', async () => {
  return {
    status: 'ok',
    uptime: process.uptime(),
    version: '2.0.0',
    auth: API_KEY ? 'enabled' : 'disabled',
    db: DB_PATH,
    sseClients: sseClients.size,
    sseEvents: eventCounter,
  }
})

// ─── Primary route: /api/claude_code/team_memory ────────────

app.get('/api/claude_code/team_memory', handleGetTeamMemory)
app.put('/api/claude_code/team_memory', handlePutTeamMemory)

// ─── Alias route: /api/team_memory ──────────────────────────

app.get('/api/team_memory', handleGetTeamMemory)
app.put('/api/team_memory', handlePutTeamMemory)

// ─── SSE route ──────────────────────────────────────────────

app.get('/api/team_memory/events', handleSSEConnect)
app.get('/api/claude_code/team_memory/events', handleSSEConnect)

// ─── Event broadcast route ─────────────────────────────────

app.post('/api/team_memory/events', handlePostEvent)
app.post('/api/claude_code/team_memory/events', handlePostEvent)

// ─── Start Server ───────────────────────────────────────────

try {
  await app.listen({ port: PORT, host: HOST })
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Local Team Memory Sync Server v2.0.0                        ║
║  Running on http://${HOST}:${PORT.toString().padEnd(25)}║
║  Database: ${DB_PATH.padEnd(47)}║
║  Auth: ${(API_KEY ? 'enabled (X-API-Key)' : 'disabled (open access)').padEnd(47)}║
║  Max entries: ${MAX_ENTRIES.toString().padEnd(42)}║
║  SSE: enabled (max ${SSE_MAX_CLIENTS} clients, ping ${SSE_PING_INTERVAL_MS}ms)       ║
║  API paths: /api/claude_code/team_memory, /api/team_memory   ║
║  SSE path:  /api/team_memory/events?repo={slug}              ║
║  Events:    POST /api/team_memory/events?repo={slug}         ║
╚══════════════════════════════════════════════════════════════╝

Set these environment variables on each developer's machine:
  # IMPORTANT: Use the BASE URL only (no /api/team_memory suffix).
  # The plugin adapter appends API paths automatically.
  TEAM_MEMORY_SYNC_URL=http://${HOST}:${PORT}
  ${API_KEY ? 'TEAM_MEMORY_SYNC_API_KEY=<your-key>' : '# TEAM_MEMORY_SYNC_API_KEY=<optional>'}
  CLAUDE_TEAM_DEV_ID=<your-unique-developer-id>
`)
} catch (err) {
  console.error('Failed to start server:', err)
  process.exit(1)
}
