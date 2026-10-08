import { SyncServerAdapter } from './syncServerAdapter.js'

export interface CloudMessage {
  messageId: string
  type: string
  from: string
  fromAgentId?: string
  to: string
  toAgentId?: string
  text: string
  timestamp: string
  teamName: string
}

export interface SSEFrame {
  event: string
  id: string
  data: Record<string, unknown>
}

export interface StartListeningOptions {
  onMessage?: (msg: CloudMessage) => void
}

// Maximum number of seen message IDs to keep in memory
const MAX_SEEN_MESSAGES = 10_000

export class CloudMessageRouter {
  private adapter: SyncServerAdapter
  private developerId: string
  private seenMessages: Set<string> = new Set()
  private lastEventId: number = 0

  // SSE state
  private sseAbortController: AbortController | null = null
  private listening = false
  private _reconnectScheduled = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private onMessageCallback: ((msg: CloudMessage) => void) | null = null

  // Exponential backoff config
  private reconnectDelay = 1000
  private readonly maxReconnectDelay = 30_000
  private readonly backoffMultiplier = 2

  public readonly repo: string

  constructor(config: {
    apiUrl: string
    apiKey: string
    repo: string
    developerId: string
  }) {
    this.repo = config.repo
    this.developerId = config.developerId
    this.adapter = new SyncServerAdapter({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      repo: config.repo,
      developerId: config.developerId,
    })
  }

  // ============================================================
  // Static SSE frame parser (pure function, testable)
  // ============================================================

  /**
   * Parse raw SSE text into an array of SSEFrame objects.
   * Handles \n and \r\n line endings. Only emits frames terminated
   * by a blank line (per SSE spec). Skips comment lines starting with ':'.
   */
  static parseSSEFrames(raw: string): SSEFrame[] {
    const frames: SSEFrame[] = []
    // Normalize \r\n to \n
    const normalized = raw.replace(/\r\n/g, '\n')
    const chunks = normalized.split('\n\n')

    for (const chunk of chunks) {
      const trimmed = chunk.trim()
      if (!trimmed) continue

      let event = ''
      let id = ''
      let dataStr = ''
      let hasData = false

      const lines = trimmed.split('\n')
      for (const line of lines) {
        // Skip comment lines
        if (line.startsWith(':')) continue

        const colonIndex = line.indexOf(':')
        if (colonIndex === -1) continue

        const field = line.slice(0, colonIndex)
        const value = line.slice(colonIndex + 1).trim()

        if (field === 'event') {
          event = value
        } else if (field === 'id') {
          id = value
        } else if (field === 'data') {
          hasData = true
          dataStr = dataStr ? dataStr + '\n' + value : value
        }
      }

      // Only emit if we have at least an event or data field
      if (!event && !hasData) continue

      let data: Record<string, unknown> = {}
      if (dataStr) {
        try {
          data = JSON.parse(dataStr) as Record<string, unknown>
        } catch {
          // If JSON parse fails, still emit the frame with raw data
          data = { raw: dataStr }
        }
      }

      frames.push({ event, id, data })
    }

    return frames
  }

  // ============================================================
  // Core: sendMessage (with dedup)
  // ============================================================

  /**
   * Post a message via dual-channel: SSE event (real-time) + KV push (persistent).
   * Returns false if messageId already seen (dedup).
   */
  async sendMessage(msg: CloudMessage): Promise<boolean> {
    if (this.seenMessages.has(msg.messageId)) return false

    try {
      // Dual-channel: KV persistence (offline-safe) + SSE event (real-time)
      await Promise.all([
        // Channel 1: KV persistent storage — worker can pull even if offline
        this.adapter.push({
          [`tasks/${msg.messageId}`]: JSON.stringify({
            messageId: msg.messageId,
            type: msg.type,
            from: msg.from,
            fromAgentId: msg.fromAgentId,
            to: msg.to,
            toAgentId: msg.toAgentId,
            text: msg.text,
            timestamp: msg.timestamp,
            teamName: msg.teamName,
            status: 'assigned',
          }),
        }),
        // Channel 2: SSE real-time push — worker receives instantly if online
        this.adapter.postEvent('task', {
          messageId: msg.messageId,
          type: msg.type,
          from: msg.from,
          fromAgentId: msg.fromAgentId,
          to: msg.to,
          toAgentId: msg.toAgentId,
          text: msg.text,
          timestamp: msg.timestamp,
          teamName: msg.teamName,
        }),
      ])

      // Mark as seen AFTER successful send so failed sends can be retried
      this.recordSeen(msg.messageId)
      return true
    } catch (err) {
      console.warn('[CloudMessageRouter] sendMessage failed:',
        err instanceof Error ? err.message : String(err))
      return false
    }
  }

  // ============================================================
  // Core: pollMessages (backward compatible)
  // ============================================================

  /**
   * Poll for new messages via KV storage.
   * The server's /events endpoint is SSE-only (no JSON mode), so polling
   * uses the reliable KV channel where sendMessage persists tasks/*.
   */
  async pollMessages(_sinceEventId?: number): Promise<CloudMessage[]> {
    return this.pollTasksFromKV()
  }

  /**
   * Poll tasks from KV storage (persistent, offline-safe).
   * Does NOT depend on SSE events — reads tasks/* keys from the team repo.
   * Filters tasks addressed to this agent or to all team members.
   */
  async pollTasksFromKV(): Promise<CloudMessage[]> {
    const messages: CloudMessage[] = []
    try {
      const result = await this.adapter.pull()
      if (!result?.entries) return messages

      for (const [key, value] of Object.entries(result.entries)) {
        if (!key.startsWith('tasks/') || !value) continue
        try {
          const task = JSON.parse(value)
          // Dedup: skip already seen
          if (this.seenMessages.has(task.messageId)) continue
          // Filter: tasks addressed to this agent or broadcast
          if (task.toAgentId && task.toAgentId !== this.developerId) continue

          this.recordSeen(task.messageId)
          messages.push({
            messageId: task.messageId,
            type: task.type || 'task_assignment',
            from: task.from || 'unknown',
            fromAgentId: task.fromAgentId,
            to: task.to || '',
            toAgentId: task.toAgentId,
            text: task.text || '',
            timestamp: task.timestamp || '',
            teamName: task.teamName || '',
          })
        } catch {
          // Skip malformed entries
        }
      }
    } catch (err) {
      console.warn('[CloudMessageRouter] KV poll failed:',
        err instanceof Error ? err.message : String(err))
    }
    return messages
  }

  // ============================================================
  // SSE: startListening / stopListening (disconnectSSE)
  // ============================================================

  /**
   * Connect to the SSE stream for real-time task events.
   * Fires onMessage callback for each new task event received.
   * Auto-reconnects with exponential backoff on disconnect.
   */
  async startListening(options?: StartListeningOptions): Promise<void> {
    if (this.listening) return

    this.listening = true
    this.onMessageCallback = options?.onMessage ?? null
    this.resetBackoff()

    // Fire-and-forget: SSE read loop runs in the background so
    // startListening() returns immediately after initiating the connection.
    // connectSSE() handles its own errors internally (including reconnect).
    void this.connectSSE()
  }

  /**
   * Close the SSE connection and stop auto-reconnect.
   */
  disconnectSSE(): void {
    this.listening = false
    this._reconnectScheduled = false
    this.onMessageCallback = null

    if (this.sseAbortController) {
      this.sseAbortController.abort()
      this.sseAbortController = null
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** Alias for disconnectSSE (stopListening) */
  stopListening(): void {
    this.disconnectSSE()
  }

  /** Whether currently listening to SSE events */
  isListening(): boolean {
    return this.listening
  }

  // ============================================================
  // SSE internal: connect and read stream
  // ============================================================

  private async connectSSE(): Promise<void> {
    if (!this.listening) return

    this.sseAbortController = new AbortController()

    try {
      const response = await this.adapter.connectSSE(this.lastEventId || undefined)

      // Check if we were cancelled while awaiting the fetch
      if (!this.listening || this.sseAbortController.signal.aborted) return

      if (!response.ok) {
        console.error(`[CloudMessageRouter] SSE connection failed: ${response.status} ${response.statusText}`)
        this.scheduleReconnect()
        return
      }

      // Reset backoff on successful connection
      this.resetBackoff()

      // P2-7: SSE reconnection state recovery — notify of reconnect
      console.log(`[CloudMessageRouter] SSE reconnected successfully (repo: ${this.repo})`)

      const reader = response.body?.getReader()
      if (!reader) {
        console.error('[CloudMessageRouter] SSE response has no readable body')
        this.scheduleReconnect()
        return
      }

      let buffer = ''

      // Read loop — runs until abort or stream ends
      while (this.listening && !this.sseAbortController.signal.aborted) {
        const { done, value } = await reader.read()

        if (done) break

        // Decode chunk
        const chunk = new TextDecoder().decode(value)
        buffer += chunk

        // Parse complete frames from the buffer
        const frames = CloudMessageRouter.parseSSEFrames(buffer + '\n\n')

        // Find the last double-newline boundary to know how much to keep
        const lastBoundary = buffer.lastIndexOf('\n\n')
        if (lastBoundary !== -1) {
          // Keep only the incomplete trailing portion
          buffer = buffer.slice(lastBoundary + 2)
        } else {
          // No complete frames — keep entire buffer for next iteration
          // But we got frames above because we appended \n\n for parsing
          // So the original buffer had no \n\n
          buffer = buffer
        }

        for (const frame of frames) {
          // Process task events AND vote events
          if (frame.event !== 'task' && !frame.event.startsWith('vote_')) continue

          // The server wraps the user payload in SSEEventPayload:
          //   { type, id, data: { messageId / voteId, from, to, text, ... }, timestamp }
          // The "data" field of the SSE frame is the SSEEventPayload,
          // and the actual user payload is nested one level deeper.
          const outer = frame.data
          if (!outer) continue

          // Unwrap: prefer inner data (real payload) over outer (SSEEventPayload)
          const data = (outer && typeof outer === 'object' && 'data' in outer && typeof outer.data === 'object' && outer.data !== null)
            ? outer.data as Record<string, unknown>
            : outer

          // For vote events, voteId is the key; for task events, messageId
          const eventId = (data.voteId as string) ?? (data.messageId as string)
          if (!eventId) continue

          // Dedup
          if (this.seenMessages.has(eventId)) continue
          this.recordSeen(eventId)

          // Update lastEventId
          const numericId = parseInt(frame.id, 10)
          if (!isNaN(numericId) && numericId > this.lastEventId) {
            this.lastEventId = numericId
          }

          // Build CloudMessage and fire callback
          const msg: CloudMessage = {
            messageId: eventId,
            type: frame.event,
            from: (data.from as string) || '',
            fromAgentId: data.fromAgentId as string | undefined,
            to: (data.to as string) || '',
            toAgentId: data.toAgentId as string | undefined,
            text: ((data.text as string) || JSON.stringify(data)),
            timestamp: (data.timestamp as string) || new Date().toISOString(),
            teamName: (data.teamName as string) || this.repo,
          }

          this.onMessageCallback?.(msg)
        }
      }

      // Stream ended — try to reconnect if still listening
      if (this.listening) {
        this.scheduleReconnect()
      }
    } catch (err: unknown) {
      // Fetch was aborted or network error
      if (err instanceof Error && err.name === 'AbortError') return
      if (this.listening) {
        console.error('[CloudMessageRouter] SSE connection error:', err)
        this.scheduleReconnect()
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.listening) return
    // Re-entrancy guard: prevent doubled backoff from multiple error paths
    if (this._reconnectScheduled) return
    this._reconnectScheduled = true

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(
      this.reconnectDelay * this.backoffMultiplier,
      this.maxReconnectDelay,
    )

    this.reconnectTimer = setTimeout(() => {
      this._reconnectScheduled = false
      if (this.listening) {
        this.connectSSE()
      }
    }, delay)
  }

  private resetBackoff(): void {
    this.reconnectDelay = 1000
    this._reconnectScheduled = false
  }

  // ============================================================
  // seenMessages: LRU capped set
  // ============================================================

  /**
   * Record a message ID as seen. Evicts oldest entries when at capacity.
   * Uses insertion-order Set iteration for O(1) LRU eviction.
   */
  recordSeen(messageId: string): void {
    // If already present, delete and re-add to refresh LRU position
    if (this.seenMessages.has(messageId)) {
      this.seenMessages.delete(messageId)
    } else if (this.seenMessages.size >= MAX_SEEN_MESSAGES) {
      // Evict the oldest entry (first in iteration order)
      const oldest = this.seenMessages.values().next().value
      if (oldest !== undefined) {
        this.seenMessages.delete(oldest)
      }
    }
    this.seenMessages.add(messageId)
  }

  /** Return the current number of seen message IDs */
  seenCount(): number {
    return this.seenMessages.size
  }

  /** Check if a message ID has been seen */
  hasSeenMessage(messageId: string): boolean {
    return this.seenMessages.has(messageId)
  }

  // ============================================================
  // Public accessors (used by CloudPermissionBroadcast)
  // ============================================================

  /** Expose the adapter's base URL for derived instances */
  getApiUrl(): string {
    return this.adapter.getApiUrl()
  }

  /** Expose the adapter's API key for derived instances */
  getApiKey(): string {
    return this.adapter.getApiKey()
  }
}
