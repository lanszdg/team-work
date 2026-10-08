/**
 * Cloud Kick/Remove Member system for multi-machine team collaboration.
 *
 * Handles shutdown protocol messages (shutdown_request, shutdown_approved,
 * shutdown_rejected) and the full kick-and-remove workflow.
 */

import { randomUUID } from 'crypto'
import { MessageDispatcher } from './messageDispatcher.js'
import { removeTeammateFromTeamFile } from './teamFile.js'
import { TEAM_LEAD_NAME } from '../platform/constants.js'

export interface ShutdownRequestPayload {
  type: 'shutdown_request'
  requestId: string
  from: string
  reason?: string
  timestamp: string
}

export interface ShutdownResponsePayload {
  type: 'shutdown_approved' | 'shutdown_rejected'
  requestId: string
  from: string
  reason?: string
  timestamp: string
}

export class CloudKickManager {
  private dispatcher: MessageDispatcher
  private teamName: string
  private agentId: string
  private agentName: string

  // Shared listener registry: multiple modules share one SSE stream
  private static _listeners: Set<(event: any) => void> = new Set()
  private static _listeningStarted = false

  static addCloudListener(cb: (event: any) => void): void {
    CloudKickManager._listeners.add(cb)
  }

  static removeCloudListener(cb: (event: any) => void): void {
    CloudKickManager._listeners.delete(cb)
  }

  private static broadcastToListeners(event: any): void {
    for (const listener of CloudKickManager._listeners) {
      try { listener(event) } catch { /* swallow per-listener errors */ }
    }
  }

  constructor(dispatcher: MessageDispatcher, teamName: string, agentId: string, agentName: string) {
    this.dispatcher = dispatcher
    this.teamName = teamName
    this.agentId = agentId
    this.agentName = agentName
  }

  // ============================================================
  // Leader kicks a teammate: sends shutdown_request, waits for response
  // ============================================================

  /**
   * Leader sends a shutdown request to a target teammate.
   * Constructs a shutdown_request message and routes it via the dispatcher.
   */
  async sendShutdownRequest(
    targetAgentId: string,
    targetName: string,
    reason?: string,
  ): Promise<ShutdownRequestPayload> {
    const requestId = randomUUID()
    const timestamp = new Date().toISOString()

    const payload: ShutdownRequestPayload = {
      type: 'shutdown_request',
      requestId,
      from: this.agentName,
      reason,
      timestamp,
    }

    await this.dispatcher.sendMessage(targetAgentId, targetName, payload)

    return payload
  }

  // ============================================================
  // Teammate responds to shutdown
  // ============================================================

  /**
   * Teammate accepts the shutdown request.
   * Sends a shutdown_approved response back to the leader via cloud.
   */
  async sendShutdownApproved(
    requestId: string,
    leaderAgentId: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString()

    const payload: ShutdownResponsePayload = {
      type: 'shutdown_approved',
      requestId,
      from: this.agentName,
      timestamp,
    }

    await this.dispatcher.sendMessage(leaderAgentId, TEAM_LEAD_NAME, payload)
  }

  /**
   * Teammate rejects the shutdown request with an optional reason.
   * Sends a shutdown_rejected response back to the leader via cloud.
   */
  async sendShutdownRejected(
    requestId: string,
    leaderAgentId: string,
    reason?: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString()

    const payload: ShutdownResponsePayload = {
      type: 'shutdown_rejected',
      requestId,
      from: this.agentName,
      reason: reason ?? '',
      timestamp,
    }

    await this.dispatcher.sendMessage(leaderAgentId, TEAM_LEAD_NAME, payload)
  }

  // ============================================================
  // Full kick workflow: send shutdown → wait for response → remove from team file
  // ============================================================

  /**
   * Full kick-and-remove workflow:
   * 1. Sends a shutdown_request to the target
   * 2. Waits for shutdown_approved or shutdown_rejected response (up to timeoutMs)
   * 3. If accepted: removes the member from the team file
   * 4. If rejected or timeout: still removes the member (forced removal)
   *
   * Returns { success, accepted } indicating the outcome.
   */
  async kickAndRemove(
    targetAgentId: string,
    targetName: string,
    reason?: string,
    timeoutMs: number = 30_000,
  ): Promise<{ success: boolean; accepted: boolean }> {
    // Step 1: Send shutdown request
    const shutdownRequest = await this.sendShutdownRequest(
      targetAgentId,
      targetName,
      reason,
    )

    // Step 2: Wait for response with timeout
    let accepted = false
    let rejected = false
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const messages = await this.dispatcher.receiveUnreadMessages(this.agentName)

      for (const entry of messages) {
        try {
          const payload = typeof entry.message.text === 'string'
            ? JSON.parse(entry.message.text)
            : entry.message

          if (payload.requestId === shutdownRequest.requestId) {
            if (payload.type === 'shutdown_approved') {
              accepted = true
              break
            } else if (payload.type === 'shutdown_rejected') {
              rejected = true
              break
            }
          }
        } catch {
          // Not a valid JSON payload, skip
        }
      }

      if (accepted || rejected) break

      // Brief sleep before polling again
      await new Promise((r) => setTimeout(r, 200))
    }

    // Step 3: Remove from team file (always, regardless of response)
    const removed = await removeTeammateFromTeamFile(this.teamName, {
      agentId: targetAgentId,
      name: targetName,
    })

    // V5-13: Explicitly sync kick to cloud
    if (removed) {
      try {
        const { syncTeamToCloud } = await import('./teamFile.js')
        await syncTeamToCloud(this.teamName)
        console.log(`[CloudKick:V5-13] Synced kick of "${targetName}" to cloud`)
      } catch (err) {
        console.warn('[CloudKick:V5-13] Failed to sync kick to cloud:', err)
      }
    }

    return {
      success: removed || accepted,
      accepted,
    }
  }

  // ============================================================
  // Listen for incoming shutdown requests (for teammates)
  // ============================================================

  /**
   * Register a callback to handle incoming shutdown requests.
   * The callback receives the parsed ShutdownRequestPayload.
   * This wraps the dispatcher's cloud listening to filter shutdown_request messages.
   */
  onShutdownRequest(
    callback: (payload: ShutdownRequestPayload) => Promise<void>,
  ): void {
    const listener = async (msg: any) => {
      try {
        const payload = typeof msg.text === 'string' ? JSON.parse(msg.text) : msg.text
        if (payload.type === 'shutdown_request') {
          await callback(payload as ShutdownRequestPayload)
        }
      } catch {
        // Ignore non-JSON messages
      }
    }

    CloudKickManager.addCloudListener(listener)

    // Start the shared SSE connection only once
    if (!CloudKickManager._listeningStarted) {
      CloudKickManager._listeningStarted = true
      this.dispatcher.startCloudListening(async (msg) => {
        CloudKickManager.broadcastToListeners(msg)
      }).catch(() => {
        // Cloud listening may not be available
        CloudKickManager._listeningStarted = false
      })
    }
  }
}
