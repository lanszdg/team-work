/**
 * MessageDispatcher — Cloud message dispatch.
 *
 * Requires cloudConfig; throws if cloud is unreachable.
 * SSE listening is managed externally by InboxPoller / CloudMessageRouter.
 */

import { randomUUID } from 'crypto'
import { CloudMessageRouter, CloudMessage } from './cloudMessageRouter.js'
import { checkMessagePermission } from './messagePermissions.js'
import type { TeamRole } from './types.js'

// Re-export CloudMessage for consumers
export type { CloudMessage }

export interface DispatcherConfig {
  teamName: string
  agentName: string
  agentId?: string
  senderRole?: TeamRole
  cloudConfig: {
    apiUrl: string
    apiKey: string
    developerId: string
  }
}

export class MessageDispatcher {
  private cloudRouter: CloudMessageRouter | null = null
  private cloudConnected = false
  private dispatchedMessages: Set<string> = new Set()
  private teamName: string
  private agentName: string
  private agentId: string
  private senderRole: TeamRole | undefined

  constructor(config: DispatcherConfig) {
    this.teamName = config.teamName
    this.agentName = config.agentName
    this.agentId = config.agentId ?? config.cloudConfig.developerId
    this.senderRole = config.senderRole

    if (config.cloudConfig) {
      this.cloudRouter = new CloudMessageRouter({
        apiUrl: config.cloudConfig.apiUrl,
        apiKey: config.cloudConfig.apiKey,
        repo: `messages/${config.teamName}`,
        developerId: config.cloudConfig.developerId,
      })
    }
  }

  // ============================================================
  // Connection lifecycle
  // ============================================================

  /**
   * Wait for cloud connectivity. Retries every 5 s up to timeoutMs.
   * Throws immediately if cloudRouter is null (no cloudConfig provided).
   * Throws after timeout if the cloud remains unreachable.
   */
  async waitForConnection(timeoutMs = 30_000): Promise<void> {
    if (this.cloudConnected) return

    if (!this.cloudRouter) {
      throw new Error(
        '[MessageDispatcher] cloudConfig is required. Set TEAM_MEMORY_SYNC_URL to the sync server base URL.',
      )
    }

    const deadline = Date.now() + timeoutMs
    const retryInterval = Math.min(5_000, timeoutMs)

    while (Date.now() < deadline) {
      try {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await Promise.race([
          this.cloudRouter.pollTasksFromKV(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('probe timeout')), Math.min(remaining, 8_000)),
          ),
        ])
        this.cloudConnected = true
        console.log('[MessageDispatcher] Cloud connected')
        return
      } catch {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        console.warn('[MessageDispatcher] Cloud unreachable, retrying...')
        await new Promise(r => setTimeout(r, Math.min(retryInterval, remaining)))
      }
    }

    throw new Error(
      `[MessageDispatcher] Cloud unreachable after ${timeoutMs}ms. Set TEAM_MEMORY_SYNC_URL to the sync server base URL.`,
    )
  }

  // ============================================================
  // Send — pure cloud, no local fallback
  // ============================================================

  /**
   * Send a message via cloud. Returns true if sent, false if dedup.
   * Throws if cloudRouter is null (R9: no silent L2 failures).
   */
  async sendMessage(
    recipientAgentId: string,
    recipientName: string,
    message: any,
  ): Promise<boolean> {
    const messageId = message.messageId ?? randomUUID()
    const messageType = message.type ?? 'task'
    const rawText =
      typeof message.text === 'string'
        ? message.text
        : JSON.stringify(message)

    if (this.senderRole) {
      const check = checkMessagePermission(this.senderRole, messageType, rawText)
      if (!check.allowed) {
        throw new Error(
          `[MessageDispatcher] Role "${this.senderRole}" cannot send message type "${messageType}"` +
            (check.requiredPermission ? `; missing permission "${check.requiredPermission}"` : '') +
            (check.denyReason ? `; ${check.denyReason}` : ''),
        )
      }
    }

    if (this.dispatchedMessages.has(messageId)) return false

    if (!this.cloudRouter) {
      throw new Error('[MessageDispatcher] Cloud not connected')
    }

    const cloudMsg: CloudMessage = {
      messageId,
      type: message.type ?? 'task',
      from: this.agentName,
      fromAgentId: message.fromAgentId ?? this.agentId,
      to: recipientName,
      toAgentId: message.toAgentId ?? recipientAgentId,
      text: rawText,
      timestamp: message.timestamp ?? new Date().toISOString(),
      teamName: this.teamName,
    }

    const sent = await this.cloudRouter.sendMessage(cloudMsg)
    if (sent) {
      this.dispatchedMessages.add(messageId)
      this.capDispatchedMessages()
    }

    return sent
  }

  // ============================================================
  // Receive — pure cloud
  // ============================================================

  /**
   * Poll for incoming cloud messages.
   * Throws if cloudRouter is null (R9: no silent L2 failures).
   */
  async receiveMessages(): Promise<CloudMessage[]> {
    if (!this.cloudRouter) {
      throw new Error(
        '[MessageDispatcher] Cloud not connected. Call waitForConnection() first.',
      )
    }

    return this.cloudRouter.pollMessages()
  }

  // ============================================================
  // Backward-compatible accessors (used by other core modules)
  // ============================================================

  /** Whether cloud router is available (backward compat). */
  get isCloudActive(): boolean {
    return this.cloudRouter !== null
  }

  /** Legacy: returns cloud listening state. SSE is now managed externally. */
  get isCloudListening(): boolean {
    return this.cloudConnected
  }

  /**
   * Legacy: start SSE listening. Delegates to CloudMessageRouter.
   * @deprecated SSE is now managed by InboxPoller. Use CloudMessageRouter directly.
   */
  async startCloudListening(onMessage?: (msg: any) => void): Promise<void> {
    if (!this.cloudRouter) return
    await this.cloudRouter.startListening({
      onMessage: (msg) => onMessage?.(msg),
    })
    this.cloudConnected = true
  }

  /**
   * Legacy: stop SSE listening.
   * @deprecated SSE is now managed externally.
   */
  stopCloudListening(): void {
    if (this.cloudRouter) {
      this.cloudRouter.stopListening()
    }
  }

  /**
   * Access the underlying CloudMessageRouter for advanced operations.
   */
  getCloudRouter(): CloudMessageRouter | null {
    return this.cloudRouter
  }

  getSenderAgentId(): string {
    return this.agentId
  }

  getSenderAgentName(): string {
    return this.agentName
  }

  /**
   * Legacy: receive unread messages (alias for receiveMessages).
   * @deprecated Use receiveMessages() instead.
   */
  async receiveUnreadMessages(_agentName: string): Promise<Array<{ source: string; message: any }>> {
    const messages = await this.receiveMessages()
    return messages.map(m => ({ source: 'cloud', message: m }))
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  private capDispatchedMessages(): void {
    const MAX = 20_000
    if (this.dispatchedMessages.size > MAX) {
      const iter = this.dispatchedMessages.values()
      for (let i = 0; i < 1000; i++) {
        const entry = iter.next()
        if (entry.done) break
        this.dispatchedMessages.delete(entry.value)
      }
    }
  }
}
