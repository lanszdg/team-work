/**
 * Sync Server Adapter
 *
 * Bridges the plugin's internal team-memory format with the ACTUAL deployed
 * sync server. The server uses a flat key-value entry model with API-key
 * authentication, ETag-based caching, and optimistic locking.
 *
 * Server API (reverse-engineered from source):
 *   GET  /api/team_memory?repo=X          → pull entries
 *   PUT  /api/team_memory?repo=X          → push entries (upsert)
 *   GET  /api/team_memory/events?repo=X   → SSE stream
 *   POST /api/team_memory/events?repo=X   → post event
 *
 * Auth: X-API-Key header (timing-safe comparison)
 *
 * This is a NEW module — it does NOT modify teamMemorySync.ts.
 */

// ============================================================
// Types
// ============================================================

export interface SyncServerConfig {
  /** Server base URL, e.g. "http://127.0.0.1:3000" */
  apiUrl: string
  /** API key for X-API-Key header */
  apiKey: string
  /** Repository identifier (query param) */
  repo: string
  /** Developer identifier for X-Developer-ID header */
  developerId: string
}

export interface PullResult {
  /** Flat entries from the server: { key: value } */
  entries: Record<string, string>
  /** Server checksum for the current state */
  checksum: string
  /** ETag value for conditional requests (may be empty) */
  etag?: string
}

export interface PushResult {
  /** New checksum after the write */
  checksum: string
  /** Number of files/diff entries uploaded */
  filesUploaded: number
  /** Server last-modified timestamp */
  lastModified: string
}

export interface SyncResult {
  /** Number of local keys pushed (new or updated on server) */
  pushed: number
  /** Number of remote keys pulled (new on local) */
  pulled: number
  /** Keys that differed between local and remote (both sides had the key with different values) */
  conflicts: number
  /** Merged entries after sync */
  entries: Record<string, string>
}

export interface ServerEvent {
  type: string
  id: number
  data: string
}

export interface PushResponse {
  checksum: string
  lastModified: string
  filesUploaded: number
}

export interface ServerContent {
  entries: Record<string, string>
  entryChecksums?: Record<string, string>
}

export interface ServerResponse {
  repo: string
  version: number
  checksum: string
  content: ServerContent
}

export interface HashesResponse {
  repo: string
  version: number
  checksum: string
  entryChecksums: Record<string, string>
}

// ============================================================
// Errors
// ============================================================

export class SyncServerError extends Error {
  constructor(
    message: string,
    public status?: number,
    public detail?: string,
  ) {
    super(message)
    this.name = 'SyncServerError'
  }
}

// ============================================================
// SyncServerAdapter
// ============================================================

export class SyncServerAdapter {
  private readonly apiUrl: string
  private readonly apiKey: string
  private readonly repo: string
  private readonly developerId: string

  /** Cached ETag from the last successful pull */
  private cachedEtag?: string

  constructor(config: SyncServerConfig) {
    // Normalize URL: strip trailing slash AND any accidental API path suffix.
    // Users may set TEAM_MEMORY_SYNC_URL with or without /api/team_memory suffix;
    // this adapter always appends its own /api/team_memory paths internally.
    let url = config.apiUrl.replace(/\/+$/, '')
    const hadSuffix = /\/api\/team_memory/.test(url)
    url = url.replace(/\/api\/team_memory\/?$/, '')
    url = url.replace(/\/api\/claude_code\/team_memory\/?$/, '')
    if (hadSuffix) {
      console.warn(`[SyncServerAdapter] Stripped /api/team_memory suffix from URL. ` +
        `Set TEAM_MEMORY_SYNC_URL to the base server URL (e.g. http://host:3000) to avoid this warning.`)
    }
    this.apiUrl = url
    this.apiKey = config.apiKey
    this.repo = config.repo
    this.developerId = config.developerId
  }

  // -- helpers -------------------------------------------------------

  /** Common headers for every request */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
      'X-Developer-ID': this.developerId,
      ...extra,
    }
  }

  /** Build the team_memory URL with repo query param */
  private teamMemoryUrl(params?: Record<string, string>): string {
    const qs = new URLSearchParams({ repo: this.repo, ...params }).toString()
    return `${this.apiUrl}/api/team_memory?${qs}`
  }

  /** Build the events URL with repo query param */
  private eventsUrl(params?: Record<string, string>): string {
    const qs = new URLSearchParams({ repo: this.repo, ...params }).toString()
    return `${this.apiUrl}/api/team_memory/events?${qs}`
  }

  /** Throw a typed error for non-OK responses */
  private async assertOk(res: Response, context: string): Promise<void> {
    if (res.ok) return
    const body = await res.text().catch(() => '')
    throw new SyncServerError(
      `[SyncServerAdapter] ${context}: ${res.status} ${res.statusText}`,
      res.status,
      body,
    )
  }

  /**
   * T4: Timeout-protected fetch wrapper.
   * All adapter HTTP calls go through this — guarantees no request hangs > timeoutMs.
   * @throws SyncServerError('TIMEOUT') if the request times out
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = 10_000,
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      return res
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SyncServerError(
          `[SyncServerAdapter] Request timed out after ${timeoutMs}ms: ${url}`,
          408,
          'Timeout',
        )
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  // -- pull ----------------------------------------------------------

  /**
   * GET /api/team_memory?repo=X
   *
   * Supports conditional GET via cached ETag (returns null on 304).
   * Use `view=hashes` via options for hash-only response.
   */
  async pull(options?: {
    /** Force a specific ETag; omit to use the cached one */
    ifNoneMatch?: string
    /** Request hash-only view */
    view?: 'hashes'
  }): Promise<PullResult | null> {
    const params: Record<string, string> = {}
    if (options?.view === 'hashes') params.view = 'hashes'

    const extraHeaders: Record<string, string> = {}
    const ifNoneMatch = options?.ifNoneMatch ?? this.cachedEtag
    if (ifNoneMatch) {
      extraHeaders['If-None-Match'] = ifNoneMatch
    }

    try {
      const res = await this.fetchWithTimeout(this.teamMemoryUrl(params), {
        method: 'GET',
        headers: this.headers(extraHeaders),
      })

      // 304 Not Modified → nothing new
      if (res.status === 304) {
        return null
      }

      // 404 No data for this repo → not an error
      if (res.status === 404) {
        return null
      }

      await this.assertOk(res, 'pull')

      const etag = res.headers.get('etag') ?? undefined
      if (etag) this.cachedEtag = etag

      if (options?.view === 'hashes') {
        const data = (await res.json()) as HashesResponse
        return {
          entries: {},
          checksum: data.checksum,
          etag,
        }
      }

      const data = (await res.json()) as ServerResponse
      return {
        entries: data.content.entries ?? {},
        checksum: data.checksum,
        etag,
      }
    } catch (err) {
      if (err instanceof SyncServerError && err.status === 408) {
        // Timeout — return null, caller treats as "no data available"
        return null
      }
      throw err
    }
  }

  // -- push ----------------------------------------------------------

  /**
   * PUT /api/team_memory?repo=X
   *
   * Upsert semantics: keys NOT in `entries` are preserved on the server.
   * Pass `ifMatch` for optimistic locking (412 on conflict).
   */
  async push(
    entries: Record<string, string>,
    ifMatch?: string,
  ): Promise<PushResult> {
    const extraHeaders: Record<string, string> = {}
    if (ifMatch) {
      extraHeaders['If-Match'] = ifMatch
    }

    const res = await this.fetchWithTimeout(this.teamMemoryUrl(), {
      method: 'PUT',
      headers: this.headers(extraHeaders),
      body: JSON.stringify({ entries }),
    })

    if (res.status === 412) {
      throw new SyncServerError(
        '[SyncServerAdapter] push: precondition failed (If-Match conflict)',
        412,
        'ETag mismatch — remote was modified since last read',
      )
    }

    if (res.status === 413) {
      const body = await res.text().catch(() => '')
      throw new SyncServerError(
        '[SyncServerAdapter] push: payload too large',
        413,
        body,
      )
    }

    await this.assertOk(res, 'push')

    const data = (await res.json()) as PushResponse

    // Invalidate cached ETag after a write
    this.cachedEtag = undefined

    return {
      checksum: data.checksum,
      filesUploaded: data.filesUploaded,
      lastModified: data.lastModified,
    }
  }

  // -- sync ----------------------------------------------------------

  /**
   * Bidirectional sync: pull remote, merge with local, push differences.
   *
   * Conflict = key exists in both local and remote with different values.
   * Local wins on conflict (can be customized later).
   */
  async sync(
    localEntries: Record<string, string>,
  ): Promise<SyncResult> {
    // Step 1: Pull current remote state
    const remote = await this.pull()
    const remoteEntries = remote?.entries ?? {}

    const merged: Record<string, string> = { ...remoteEntries }
    let pushed = 0
    let pulled = 0
    let conflicts = 0

    // Step 2: Detect conflicts and merge
    const toPush: Record<string, string> = {}

    for (const [key, localVal] of Object.entries(localEntries)) {
      const remoteVal = remoteEntries[key]
      if (remoteVal !== undefined && remoteVal !== localVal) {
        // Conflict — local wins (simple strategy)
        conflicts++
        merged[key] = localVal
        toPush[key] = localVal
      } else if (remoteVal === undefined) {
        // New local key — push it
        toPush[key] = localVal
        merged[key] = localVal
      } else {
        // Same value — no action
        merged[key] = localVal
      }
    }

    // Count keys only on remote as "pulled"
    const localKeys = new Set(Object.keys(localEntries))
    for (const key of Object.keys(remoteEntries)) {
      if (!localKeys.has(key)) {
        pulled++
      }
    }

    // Step 3: Push differences (if any)
    if (Object.keys(toPush).length > 0) {
      const pushResult = await this.push(toPush, remote?.checksum)
      // filesUploaded tells us how many were actually new/changed on server
      pushed = pushResult.filesUploaded
    }

    return { pushed, pulled, conflicts, entries: merged }
  }

  // -- events --------------------------------------------------------

  /**
   * GET /api/team_memory/events?repo=X
   *
   * Returns events as JSON array. The server may return SSE in browser
   * context; with `Accept: application/json` we get JSON.
   */
  async getEvents(sinceEventId?: number): Promise<ServerEvent[]> {
    const params: Record<string, string> = {}
    if (sinceEventId !== undefined) {
      params.since = String(sinceEventId)
    }

    try {
      const res = await this.fetchWithTimeout(this.eventsUrl(params), {
        method: 'GET',
        headers: this.headers({ Accept: 'application/json' }),
      }, 5_000)

      await this.assertOk(res, 'getEvents')

      const data = (await res.json()) as Record<string, unknown> | unknown[]
      // Server may return { events: [...] } or [...] directly
      if (Array.isArray(data)) return data as ServerEvent[]
      if (typeof data === 'object' && data !== null && 'events' in data && Array.isArray(data.events)) {
        return data.events as ServerEvent[]
      }
      return []
    } catch (err) {
      if (err instanceof SyncServerError && err.status === 408) {
        // Timeout — return empty, caller treats as "no events"
        return []
      }
      throw err
    }
  }

  /**
   * POST /api/team_memory/events?repo=X
   *
   * Posts an event. Valid types: presence, task, invite, memory, vote_*.
   */
  async postEvent(
    type: 'presence' | 'task' | 'invite' | 'memory' | 'vote_request' | 'vote_resolved' | 'vote_cancelled' | 'vote_rollback' | 'vote_expired' | 'team_state_changed',
    data: Record<string, unknown>,
  ): Promise<{ ok: boolean }> {
    const res = await this.fetchWithTimeout(this.eventsUrl(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ type, data }),
    })

    await this.assertOk(res, 'postEvent')

    return (await res.json()) as { ok: boolean }
  }

  // -- SSE -----------------------------------------------------------

  /**
   * Connect to the SSE stream for real-time events.
   *
   * Returns a description of how to connect since EventSource is a
   * browser API. In Node.js 20+ you can use the `eventsource` polyfill
   * or construct a streaming fetch manually.
   *
   * Usage with fetch-based streaming:
   * ```ts
   * const response = await adapter.connectSSE()
   * const reader = response.body.getReader()
   * // Parse SSE frames from the stream
   * ```
   */
  async connectSSE(lastEventId?: number): Promise<Response> {
    const params: Record<string, string> = {}
    if (lastEventId !== undefined) {
      params.last_event_id = String(lastEventId)
    }

    return this.fetchWithTimeout(this.eventsUrl(params), {
      method: 'GET',
      headers: this.headers({
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      }),
    }, 15_000)
  }

  // -- state ---------------------------------------------------------

  /** Get the current cached ETag (for external optimistic locking) */
  getEtag(): string | undefined {
    return this.cachedEtag
  }

  /** Manually set the ETag (e.g. from an external source) */
  setEtag(etag: string | undefined): void {
    this.cachedEtag = etag
  }

  /** Get the configured API base URL */
  getApiUrl(): string {
    return this.apiUrl
  }

  /** Get the configured API key */
  getApiKey(): string {
    return this.apiKey
  }
}
