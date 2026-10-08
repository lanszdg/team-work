/**
 * Cloud Presence Manager — C5
 *
 * Multi-machine presence via periodic heartbeat to the cloud sync server.
 * - Broadcasts 'presence' events every 30s with agent status
 * - Tracks remote agents' online/offline state
 * - Marks agents offline after configurable timeout (default 60s)
 */

import { SyncServerAdapter } from './syncServerAdapter.js'
import type { AgentTaskProjection } from './taskProjection.js'

export interface PresenceInfo {
  agentId: string
  agentName: string
  status: 'online' | 'offline'
  lastSeen: number
  hostname?: string
  workState?: AgentTaskProjection['workState']
  currentTaskId?: string
  currentTaskTitle?: string
}

export type PresenceTaskProjectionProvider = () => Promise<Omit<AgentTaskProjection, 'agentId'> | undefined>

export class CloudPresence {
  private adapter: SyncServerAdapter
  private agentId: string
  private agentName: string
  private agentRole: string
  private teamName: string
  private intervalMs: number
  private offlineTimeoutMs: number
  private taskProjectionProvider: PresenceTaskProjectionProvider | undefined
  private timer: ReturnType<typeof setInterval> | null = null
  private remoteAgents: Map<string, PresenceInfo> = new Map()
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: {
    apiUrl: string
    apiKey: string
    teamName: string
    agentId: string
    agentName: string
    heartbeatIntervalMs?: number
    offlineTimeoutMs?: number
    taskProjectionProvider?: PresenceTaskProjectionProvider
  }) {
    this.adapter = new SyncServerAdapter({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      repo: config.teamName,
      developerId: config.agentId,
    })
    this.agentId = config.agentId
    this.agentName = config.agentName
    this.agentRole = (config as any).agentRole || 'developer'
    this.teamName = config.teamName
    this.intervalMs = config.heartbeatIntervalMs ?? 30_000
    this.offlineTimeoutMs = config.offlineTimeoutMs ?? 60_000
    this.taskProjectionProvider = config.taskProjectionProvider
  }

  /** Start broadcasting presence heartbeats */
  start(): void {
    if (this.timer) return
    console.log(`[CloudPresence:C5] Starting heartbeat every ${this.intervalMs}ms`)
    this.heartbeat()
    this.timer = setInterval(() => this.heartbeat(), this.intervalMs)
    // V5-10: Periodic stale agent cleanup
    this._cleanupTimer = setInterval(() => this.cleanupStaleAgents(), this.offlineTimeoutMs)
  }

  /** Stop broadcasting */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }
    console.log('[CloudPresence:C5] Heartbeat stopped')
  }

  /** Send a single heartbeat — SSE event + KV isActive persistence */
  private async heartbeat(): Promise<void> {
    const now = Date.now()
    const isoNow = new Date(now).toISOString()

    try {
      const taskProjection = await this.taskProjectionProvider?.()
      // Double-channel: SSE event (real-time) + KV push (persistent isActive)
      await Promise.all([
        // Channel 1: SSE presence event for real-time online detection
        this.adapter.postEvent('presence', {
          agentId: this.agentId,
          agentName: this.agentName,
          role: this.agentRole,
          status: 'online',
          teamName: this.teamName,
          timestamp: now,
          hostname: process.env.HOSTNAME || 'unknown',
          workState: taskProjection?.workState,
          currentTaskId: taskProjection?.currentTaskId,
          currentTaskTitle: taskProjection?.currentTaskTitle,
        }),
        // Channel 2: KV isActive flag — kanban & task pollers read this
        // V4: Write to presence/{agentId} (not members/{agentId})
        // Boundary: only presence fields (no tmuxPaneId/cwd/sessionId/worktreePath)
        this.adapter.push({
          [`presence/${this.agentId}`]: JSON.stringify({
            agentId: this.agentId,
            name: this.agentName,
            role: this.agentRole,
            isActive: true,
            teamName: this.teamName,
            lastHeartbeat: isoNow,
            hostname: process.env.HOSTNAME || 'unknown',
            workState: taskProjection?.workState,
            currentTaskId: taskProjection?.currentTaskId,
            currentTaskTitle: taskProjection?.currentTaskTitle,
          }),
        }),
      ])
    } catch (err) {
      console.warn('[CloudPresence:C5] Heartbeat failed:',
        err instanceof Error ? err.message : String(err))
    }
  }

  /** V5-10: Update remote agent presence info from incoming SSE events */
  updateRemoteAgent(agentId: string, info: Partial<PresenceInfo>): void {
    if (agentId === this.agentId) return
    const existing = this.remoteAgents.get(agentId)
    this.remoteAgents.set(agentId, {
      agentId,
      agentName: info.agentName || existing?.agentName || 'unknown',
      status: info.status || 'online',
      lastSeen: info.lastSeen || Date.now(),
      hostname: info.hostname || existing?.hostname,
      workState: info.workState || existing?.workState,
      currentTaskId: info.currentTaskId || existing?.currentTaskId,
      currentTaskTitle: info.currentTaskTitle || existing?.currentTaskTitle,
    })
  }

  /** V5-10: Clean up agents that have been offline for too long */
  cleanupStaleAgents(): void {
    const now = Date.now()
    for (const [id, info] of this.remoteAgents) {
      if (now - info.lastSeen > this.offlineTimeoutMs * 2) {
        this.remoteAgents.delete(id)
      }
    }
  }

  /** Get all known online agents (with recent heartbeat within timeout) */
  getOnlineAgents(): Map<string, PresenceInfo> {
    const now = Date.now()
    const online = new Map<string, PresenceInfo>()
    for (const [id, info] of this.remoteAgents) {
      if (now - info.lastSeen < this.offlineTimeoutMs) {
        online.set(id, info)
      }
    }
    return online
  }

  /** FIX(P6): Get online agents as a plain array (for JSON serialization / CLI output) */
  getOnlineAgentList(): PresenceInfo[] {
    const online = this.getOnlineAgents()
    return Array.from(online.values())
  }

  /** FIX(P6): Returns all known agents (online + recently-offline) for debugging */
  getAllKnownAgents(): PresenceInfo[] {
    return Array.from(this.remoteAgents.values())
  }

  /** Check if a specific agent is online */
  isAgentOnline(agentId: string): boolean {
    const info = this.remoteAgents.get(agentId)
    if (!info) return false
    return Date.now() - info.lastSeen < this.offlineTimeoutMs
  }

  get isRunning(): boolean {
    return this.timer !== null
  }
}
