/**
 * Git Sync Module (Feature 4)
 *
 * Enables multi-machine code sharing by synchronizing git state
 * (branches, commits, diff summaries) through the cloud sync server.
 *
 * Architecture:
 * - Uses SyncServerAdapter to push/pull git metadata to a dedicated
 *   `__git__` repo on the server.
 * - Uses CloudMessageRouter via MessageDispatcher for real-time SSE
 *   notifications when git state changes.
 * - Works alongside existing modules without modifying them.
 *
 * Storage convention:
 *   Key:  state/{branch}/{agentId}
 *   Value: JSON string of GitState
 */

import { MessageDispatcher } from './messageDispatcher.js'
import { SyncServerAdapter } from './syncServerAdapter.js'

// ============================================================
// Types
// ============================================================

export interface GitState {
  /** Git branch name */
  branch: string
  /** Full commit hash */
  commitHash: string
  /** Commit message */
  message: string
  /** Optional diff summary (e.g. "3 files changed, 15 insertions, 5 deletions") */
  diffSummary?: string
  /** ISO timestamp when the state was pushed */
  timestamp: string
  /** Agent name who pushed this state */
  pushedBy: string
}

export interface SyncRequest {
  /** Unique request ID */
  requestId: string
  /** Branch being requested */
  branch: string
  /** Agent ID requesting the sync */
  from: string
  /** ISO timestamp of the request */
  timestamp: string
}

// ============================================================
// Message type constants
// ============================================================

const GIT_SYNC_REQUEST_TYPE = 'git_sync_request'
const GIT_SYNC_RESPONSE_TYPE = 'git_sync_response'

// ============================================================
// GitSync
// ============================================================

export class GitSync {
  private dispatcher: MessageDispatcher
  private teamName: string
  private agentId: string
  private agentName: string

  // Dedicated adapter for the __git__ repo
  private gitAdapter: SyncServerAdapter | null = null

  // Local cache of git states: key is `state/{branch}/{agentId}`
  private cache = new Map<string, GitState>()

  // Callback for incoming sync requests
  private onSyncRequestCallback: ((req: SyncRequest) => Promise<void>) | null = null

  constructor(config: {
    dispatcher: MessageDispatcher
    teamName: string
    agentId: string
    agentName: string
  }) {
    this.dispatcher = config.dispatcher
    this.teamName = config.teamName
    this.agentId = config.agentId
    this.agentName = config.agentName

    // Build the __git__ adapter from dispatcher's cloud config if available
    const cloudRouter = this.dispatcher.getCloudRouter()
    if (cloudRouter) {
      this.gitAdapter = new SyncServerAdapter({
        apiUrl: cloudRouter.getApiUrl(),
        apiKey: cloudRouter.getApiKey(),
        repo: '__git__',
        developerId: config.agentId,
      })
    }
  }

  // ============================================================
  // Push local git state to cloud and return GitState
  // ============================================================

  /**
   * Push the current git state (branch, commit hash, message, diff summary)
   * to the cloud __git__ repo AND broadcast via SSE.
   */
  async pushGitState(
    branch: string,
    commitHash: string,
    message: string,
    diffSummary?: string,
  ): Promise<GitState> {
    const state: GitState = {
      branch,
      commitHash,
      message,
      diffSummary,
      timestamp: new Date().toISOString(),
      pushedBy: this.agentName,
    }

    const key = `state/${branch}/${this.agentId}`

    // Push to cloud storage
    if (this.gitAdapter) {
      try {
        await this.gitAdapter.push({ [key]: JSON.stringify(state) })
      } catch (err) {
        console.warn('[GitSync] pushGitState failed:',
          err instanceof Error ? err.message : String(err))
        // Continue — local cache still updated, broadcast still attempted
      }
    }

    // Update local cache
    this.cache.set(key, state)

    // Broadcast via SSE so other agents know about the update
    await this.broadcastGitState(state)

    return state
  }

  // ============================================================
  // Pull remote git state from cloud
  // ============================================================

  /**
   * Pull git states from the cloud __git__ repo.
   * If `branch` is specified, only pull states for that branch.
   * Returns an array of GitState objects.
   */
  async pullGitState(branch?: string): Promise<GitState[]> {
    if (!this.gitAdapter) return []

    // Always fetch fresh data — clear ETag cache to bypass 304
    this.gitAdapter.setEtag(undefined)

    const result = await this.gitAdapter.pull()
    if (!result) return []

    const entries = result.entries
    const states: GitState[] = []
    const prefix = 'state/'

    for (const [key, value] of Object.entries(entries)) {
      if (!key.startsWith(prefix)) continue

      // If branch filter is specified, skip non-matching keys
      if (branch) {
        const branchPrefix = `${prefix}${branch}/`
        if (!key.startsWith(branchPrefix)) continue
      }

      try {
        const parsed = JSON.parse(value) as GitState
        states.push(parsed)
        // Update local cache
        this.cache.set(key, parsed)
      } catch {
        // Skip malformed entries
      }
    }

    return states
  }

  // ============================================================
  // Request git sync from a specific agent
  // ============================================================

  /**
   * Send a sync request to a specific agent asking them to share
   * their git state for the given branch.
   */
  async requestSync(branch: string, fromAgentId: string): Promise<void> {
    const requestId = `git-sync-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const req: SyncRequest = {
      requestId,
      branch,
      from: this.agentId,
      timestamp: new Date().toISOString(),
    }

    // Also broadcast as a task event for SSE delivery
    await this.dispatcher.sendMessage(
      fromAgentId,
      this.agentId,
      {
        messageId: requestId,
        type: GIT_SYNC_REQUEST_TYPE,
        text: JSON.stringify(req),
        timestamp: req.timestamp,
      },
    )
  }

  // ============================================================
  // Respond to a sync request with git state
  // ============================================================

  /**
   * Send a sync response to a requesting agent with the current
   * git state for the specified branch.
   */
  async respondToSync(
    branch: string,
    toAgentId: string,
    state: GitState,
  ): Promise<void> {
    const messageId = `git-sync-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await this.dispatcher.sendMessage(
      toAgentId,
      this.agentId,
      {
        messageId,
        type: GIT_SYNC_RESPONSE_TYPE,
        text: JSON.stringify({
          branch,
          state,
          requestedBy: toAgentId,
          timestamp: new Date().toISOString(),
        }),
        timestamp: new Date().toISOString(),
      },
    )
  }

  // ============================================================
  // Listen for incoming sync requests
  // ============================================================

  /**
   * Register a callback to handle incoming git sync requests.
   * The callback receives a SyncRequest and should respond
   * appropriately (typically by calling respondToSync).
   */
  onRequestSync(callback: (req: SyncRequest) => Promise<void>): void {
    this.onSyncRequestCallback = callback
  }

  // ============================================================
  // Get cached git states
  // ============================================================

  /**
   * Return the local cache of git states.
   */
  getGitStates(): Map<string, GitState> {
    return this.cache
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  /**
   * Broadcast the git state update as a task event via the dispatcher
   * so other agents receive real-time notification via SSE.
   */
  private async broadcastGitState(state: GitState): Promise<void> {
    const messageId = `git-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await this.dispatcher.sendMessage(
      '__broadcast__',
      '__team__',
      {
        messageId,
        type: 'git_state_update',
        text: JSON.stringify(state),
        timestamp: state.timestamp,
      },
    )
  }

  /**
   * Process an incoming cloud message and dispatch to callbacks.
   * Call this when receiving SSE messages to handle git sync requests.
   */
  processCloudMessage(msg: any): void {
    const type = msg.type
    if (type === GIT_SYNC_REQUEST_TYPE) {
      try {
        const req = JSON.parse(msg.text) as SyncRequest
        this.onSyncRequestCallback?.(req).catch((err) => {
          console.error('[GitSync] Error handling sync request:', err)
        })
      } catch {
        // Malformed request text — skip
      }
    }
  }
}
