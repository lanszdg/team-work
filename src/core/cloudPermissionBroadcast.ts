/**
 * Cloud Permission Broadcast — Real-time permission change propagation
 * for multi-machine teams.
 *
 * Leader broadcasts permission updates via the sync server SSE stream.
 * All teammates receive updates in real-time and apply them to local state.
 *
 * Uses a dedicated `__permissions__` repo for event broadcasting,
 * separate from task/invitation repos.
 */

import { v4 as uuidv4 } from 'uuid'
import { SyncServerAdapter } from './syncServerAdapter.js'
import { CloudMessageRouter } from './cloudMessageRouter.js'
import { MessageDispatcher } from './messageDispatcher.js'
import type { TeamAllowedPath } from './types.js'

// Shared repo for all permission broadcast events
const PERMISSIONS_REPO = '__permissions__'

// ============================================================
// Types
// ============================================================

export interface PermissionUpdatePayload {
  type: 'team_permission_update'
  requestId: string
  rules: TeamAllowedPath[]
  behavior: 'allow' | 'deny' | 'ask'
  from: string
  timestamp: string
}

export interface CloudPermissionBroadcastConfig {
  dispatcher: MessageDispatcher
  teamName: string
  agentId: string
  agentName: string
  initialRules?: TeamAllowedPath[]
}

// ============================================================
// CloudPermissionBroadcast
// ============================================================

export class CloudPermissionBroadcast {
  private dispatcher: MessageDispatcher
  private teamName: string
  private agentId: string
  private agentName: string
  private activeRules: TeamAllowedPath[]
  private onUpdateCallback: ((update: PermissionUpdatePayload) => void) | null

  // SSE state — CloudMessageRouter handles connection, parsing, reconnect
  private router: CloudMessageRouter
  private postAdapter: SyncServerAdapter

  constructor(config: CloudPermissionBroadcastConfig) {
    this.dispatcher = config.dispatcher
    this.teamName = config.teamName
    this.agentId = config.agentId
    this.agentName = config.agentName
    this.activeRules = config.initialRules ? [...config.initialRules] : []
    this.onUpdateCallback = null

    // Derive apiUrl/apiKey from the dispatcher's cloud router
    const cloudRouter = config.dispatcher.getCloudRouter()
    const apiUrl = cloudRouter?.getApiUrl() ?? process.env.TEAM_MEMORY_SYNC_URL ?? ''
    const apiKey = cloudRouter?.getApiKey() ?? process.env.TEAM_MEMORY_SYNC_API_KEY ?? ''

    // CloudMessageRouter for SSE on the permissions repo
    this.router = new CloudMessageRouter({
      apiUrl,
      apiKey,
      repo: PERMISSIONS_REPO,
      developerId: config.agentId,
    })

    // Dedicated adapter for posting events
    this.postAdapter = new SyncServerAdapter({
      apiUrl,
      apiKey,
      repo: PERMISSIONS_REPO,
      developerId: config.agentId,
    })
  }

  // ============================================================
  // Leader: Broadcast permission update to all teammates
  // ============================================================

  /**
   * Leader broadcasts a permission update to all teammates via cloud SSE.
   * Posts a `task` event with `type: 'team_permission_update'` payload.
   */
  async broadcastPermissionUpdate(
    rules: TeamAllowedPath[],
    behavior: 'allow' | 'deny' | 'ask' = 'allow',
  ): Promise<PermissionUpdatePayload> {
    const payload: PermissionUpdatePayload = {
      type: 'team_permission_update',
      requestId: uuidv4(),
      rules,
      behavior,
      from: this.agentName,
      timestamp: new Date().toISOString(),
    }

    // Wrap the payload in a CloudMessage-compatible shape so
    // CloudMessageRouter's SSE handler can pick it up (requires messageId).
    try {
      await this.postAdapter.postEvent('task', {
        messageId: payload.requestId,
        type: payload.type,
        from: payload.from,
        to: '',
        text: JSON.stringify(payload),
        timestamp: payload.timestamp,
        teamName: this.teamName,
      })
    } catch (err) {
      console.warn('[CloudPermissionBroadcast] broadcast failed:',
        err instanceof Error ? err.message : String(err))
    }

    // Also update local activeRules for the leader (always, even if broadcast fails)
    this.applyRulesToLocal(rules)

    return payload
  }

  // ============================================================
  // Worker: Apply incoming permission update
  // ============================================================

  /**
   * Worker applies an incoming permission update to local state.
   * Merges new rules into activeRules, deduplicating by path+toolName.
   * Newer rules replace older ones for the same path+toolName.
   */
  applyPermissionUpdate(payload: PermissionUpdatePayload): TeamAllowedPath[] {
    this.applyRulesToLocal(payload.rules)
    return [...this.activeRules]
  }

  // ============================================================
  // Change a member's mode and broadcast
  // ============================================================

  /**
   * Changes a team member's permission mode and broadcasts the change.
   * Updates local state and posts a cloud event.
   */
  async setMemberModeCloud(memberName: string, mode: string): Promise<void> {
    const payload: PermissionUpdatePayload = {
      type: 'team_permission_update',
      requestId: uuidv4(),
      rules: [],
      behavior: 'allow',
      from: this.agentName,
      timestamp: new Date().toISOString(),
    }

    // Include mode change metadata in the broadcast
    try {
      await this.postAdapter.postEvent('task', {
        messageId: payload.requestId,
        type: payload.type,
        from: payload.from,
        to: '',
        text: JSON.stringify({ ...payload, memberName, mode }),
        timestamp: payload.timestamp,
        teamName: this.teamName,
      })
    } catch (err) {
      console.warn('[CloudPermissionBroadcast] setMemberModeCloud broadcast failed:',
        err instanceof Error ? err.message : String(err))
    }
  }

  // ============================================================
  // Add a team-allowed path and broadcast
  // ============================================================

  /**
   * Adds a team-allowed path, updates local rules, and broadcasts
   * the update so all teammates receive it in real-time.
   */
  async addTeamAllowedPathCloud(path: string, toolName?: string): Promise<void> {
    const newRule: TeamAllowedPath = {
      path,
      toolName: toolName ?? 'Edit',
      addedBy: this.agentName,
      addedAt: Date.now(),
    }

    // Broadcast then apply locally (broadcast also applies locally)
    await this.broadcastPermissionUpdate([newRule], 'allow')
  }

  // ============================================================
  // Listen for incoming permission updates (for teammates)
  // ============================================================

  /**
   * Register a callback for incoming permission updates.
   * The callback fires each time a `team_permission_update` event
   * is received via SSE.
   */
  onPermissionUpdate(callback: (update: PermissionUpdatePayload) => void): void {
    this.onUpdateCallback = callback
  }

  // ============================================================
  // Get current active rules
  // ============================================================

  /**
   * Returns the current set of active permission rules in memory.
   */
  getActiveRules(): TeamAllowedPath[] {
    return [...this.activeRules]
  }

  // ============================================================
  // SSE lifecycle — delegates to CloudMessageRouter
  // ============================================================

  /**
   * Start listening for permission updates via SSE.
   * Uses CloudMessageRouter for connection management and auto-reconnect.
   */
  async startListening(): Promise<void> {
    await this.router.startListening({
      onMessage: (msg) => {
        // CloudMessageRouter only fires for 'task' events
        // Check if this is a team_permission_update
        try {
          const parsed = JSON.parse(msg.text)
          if (parsed && parsed.type === 'team_permission_update') {
            const update: PermissionUpdatePayload = {
              type: 'team_permission_update',
              requestId: String(parsed.requestId ?? ''),
              rules: Array.isArray(parsed.rules) ? parsed.rules : [],
              behavior: parsed.behavior ?? 'allow',
              from: String(parsed.from ?? ''),
              timestamp: String(parsed.timestamp ?? new Date().toISOString()),
            }
            this.onUpdateCallback?.(update)
          }
        } catch {
          // Not JSON or not a permission update — ignore
        }
      },
    })
  }

  /**
   * Stop SSE listening.
   */
  async stopListening(): Promise<void> {
    this.router.stopListening()
  }

  /** Whether currently listening via SSE */
  isListening(): boolean {
    return this.router.isListening()
  }

  // ============================================================
  // Private helpers
  // ============================================================

  /**
   * Merge new rules into activeRules, deduplicating by path+toolName.
   * Newer rules replace older ones.
   */
  private applyRulesToLocal(newRules: TeamAllowedPath[]): void {
    for (const newRule of newRules) {
      const existingIndex = this.activeRules.findIndex(
        r => r.path === newRule.path && r.toolName === newRule.toolName,
      )

      if (existingIndex !== -1) {
        // Replace if the new rule is newer
        if (newRule.addedAt > this.activeRules[existingIndex].addedAt) {
          this.activeRules[existingIndex] = newRule
        }
      } else {
        this.activeRules.push(newRule)
      }
    }
  }
}
