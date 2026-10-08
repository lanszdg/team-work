/**
 * Inbox Poller Hook (v3.6 — Pure Cloud)
 *
 * Polls for new messages via CloudMessageRouter (SSE buffer + KV poll).
 * Local file mailbox has been removed — all message access goes through the cloud.
 */

import { CloudMessageRouter, CloudMessage } from '../core/cloudMessageRouter.js'
import { isStructuredProtocolMessage } from '../core/messageTypes.js'

interface PollerConfig {
  /** Agent name for logging / context */
  agentName: string
  /** Team name (optional, for context) */
  teamName?: string
  /** Poll interval in milliseconds */
  intervalMs?: number
  /** Cloud router for SSE + KV message access */
  cloudRouter: CloudMessageRouter
}

interface PollerCallbacks {
  /** Called when a structured protocol message is received */
  onProtocolMessage?: (message: unknown, rawMessage: CloudMessage) => void
  /** Called when a regular message is received */
  onRegularMessage?: (message: CloudMessage) => void
  /** Called when a vote event is received (vote_* SSE events) */
  onVoteEvent?: (event: { type: string; voteId?: string; vote?: any }) => void
  /** Called when an error occurs */
  onError?: (error: Error) => void
}

/**
 * Inbox poller — pure cloud. Polls CloudMessageRouter for new messages
 * via SSE buffered messages + KV tasks/* catch-up.
 */
export class InboxPoller {
  private config: PollerConfig
  private callbacks: PollerCallbacks
  private timeoutId: NodeJS.Timeout | null = null
  private isRunning = false
  private processedMessageIds: Set<string> = new Set()
  private maxProcessedIds = 1000

  constructor(config: PollerConfig, callbacks: PollerCallbacks) {
    this.config = {
      intervalMs: 1000,
      ...config,
    }
    this.callbacks = callbacks
  }

  /**
   * Starts polling.
   */
  start(): void {
    if (this.isRunning) return
    this.isRunning = true
    this.scheduleNext()
  }

  /**
   * Schedules the next poll cycle sequentially to prevent stacking.
   */
  private scheduleNext(): void {
    this.pollOnce().then(() => {
      if (this.isRunning) {
        this.timeoutId = setTimeout(
          () => this.scheduleNext(),
          this.config.intervalMs,
        )
        this.timeoutId.unref()
      }
    })
  }

  /**
   * Stops polling.
   */
  stop(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }
    this.isRunning = false
    this.processedMessageIds.clear()
  }

  /**
   * Performs a single poll cycle.
   *
   * Data flow (v3.6 §5.13.1):
   *   1. SSE events → CloudMessageRouter.pollMessages()
   *   2. KV tasks/* → CloudMessageRouter.pollTasksFromKV()
   *   3. Dedup via processedMessageIds Set
   *
   * CloudMessageRouter internally handles dedup via seenMessages,
   * so we get uniquely new messages each poll.
   */
  async pollOnce(): Promise<void> {
    try {
      const cloudRouter = this.config.cloudRouter

      // Data flow 1: SSE events (real-time delivery)
      const sseMessages = await cloudRouter.pollMessages()
      for (const msg of sseMessages) {
        if (this.processedMessageIds.has(msg.messageId)) continue
        this.processedMessageIds.add(msg.messageId)
        await this.processMessage(msg)
      }

      // Data flow 2: KV tasks/* (offline catch-up)
      const kvMessages = await cloudRouter.pollTasksFromKV()
      for (const msg of kvMessages) {
        if (this.processedMessageIds.has(msg.messageId)) continue
        this.processedMessageIds.add(msg.messageId)
        await this.processMessage(msg)
      }

      // Trim dedup set if it grows too large
      if (this.processedMessageIds.size > this.maxProcessedIds) {
        const entries = [...this.processedMessageIds]
        this.processedMessageIds = new Set(entries.slice(-500))
      }
    } catch (error) {
      if (this.callbacks.onError) {
        this.callbacks.onError(error as Error)
      }
    }
  }

  /**
   * Processes a single cloud message, routing it based on type.
   */
  private async processMessage(message: CloudMessage): Promise<void> {
    // Vote events priority routing: vote_* events go to onVoteEvent callback
    if (message.type?.startsWith?.('vote_')) {
      // Hard constraint: voteId ≠ message.messageId — extract from text JSON ONLY
      let voteId: string | undefined
      let vote: any
      try {
        const parsed = JSON.parse(message.text)
        voteId = parsed.voteId ?? parsed.vote?.voteId
        vote = parsed.vote
      } catch {
        // JSON parse failed — cannot route vote event without valid payload
      }
      if (voteId) {
        this.callbacks.onVoteEvent?.({ type: message.type, voteId, vote })
      } else {
        // No valid vote payload — fail explicitly, do not silently drop
        const err = new Error(
          `[InboxPoller] Vote event "${message.type}" has no valid voteId in payload`
        )
        this.callbacks.onError?.(err)
      }
      return
    }

    // Check if this is a structured protocol message
    if (isStructuredProtocolMessage(message.text)) {
      try {
        const parsed = JSON.parse(message.text)
        if (this.callbacks.onProtocolMessage) {
          this.callbacks.onProtocolMessage(parsed, message)
        }
      } catch {
        // If parsing fails, treat as regular message
        if (this.callbacks.onRegularMessage) {
          this.callbacks.onRegularMessage(message)
        }
      }
    } else {
      // Regular message
      if (this.callbacks.onRegularMessage) {
        this.callbacks.onRegularMessage(message)
      }
    }
  }

  /**
   * Checks if the poller is currently running.
   */
  get running(): boolean {
    return this.isRunning
  }
}

/**
 * Creates and starts an inbox poller for the current agent.
 */
export function startInboxPoller(
  agentName: string,
  callbacks: PollerCallbacks,
  cloudRouter: CloudMessageRouter,
  teamName?: string,
): InboxPoller {
  const poller = new InboxPoller(
    { agentName, teamName, intervalMs: 1000, cloudRouter },
    callbacks,
  )
  poller.start()
  return poller
}
