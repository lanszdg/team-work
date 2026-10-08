/**
 * Cloud Invitation System
 *
 * Multi-machine team collaboration via the sync server.
 * - Leader creates team → pushes metadata to __teams__ repo for cloud discovery
 * - Leader sends invitation → pushes entry to __invitations__/{teamName} repo + broadcasts SSE event
 * - Worker accepts/declines → updates entry in __invitations__/{teamName} repo
 * - All communication flows through the sync server with SSE for real-time delivery
 *
 * Invitation entries are stored as:  inv/{invitationId} → JSON string
 * Team entries are stored as:        team/{teamName} → JSON string
 */

import { SyncServerAdapter } from './syncServerAdapter.js'
import { CloudMessageRouter } from './cloudMessageRouter.js'
import { writeTeamFile, getProfileService, getTeamDir } from './teamFile.js'
import { TeamProfileService } from './teamProfileService.js'
import { randomUUID } from 'crypto'
import { join } from 'path'
import type { CloudTeamState, TeamFile, TeamMemberProfile } from './types.js'

// ============================================================
// Types
// ============================================================

export interface Invitation {
  id: string
  fromAgentId: string
  fromAgentName: string
  toAgentId: string
  toAgentName: string
  teamName: string
  message: string
  status: 'pending' | 'accepted' | 'declined'
  createdAt: string
  respondedAt?: string
  responseReason?: string
}

export interface CloudTeamInfo {
  name: string
  description: string
  leadAgentId: string
  leadAgentName: string
  memberCount: number
  createdAt: string
}

// Internal helper type for cloud-stored team info (includes meta)
interface CloudTeamEntry {
  info: CloudTeamInfo
  updatedAt: string
}

/** Payload delivered to the startListening callback when an invite arrives via SSE */
export interface InvitationData {
  invitationId: string
  fromAgentId: string
  fromAgentName: string
  toAgentId: string
  toAgentName: string
  teamName: string
  message: string
  createdAt: string
}

// ============================================================
// Cloud Invitation class
// ============================================================

export class CloudInvitation {
  private adapter: SyncServerAdapter
  private teamName: string
  private agentId: string
  private agentName: string
  private readonly _apiUrl: string
  private readonly _apiKey: string

  // SSE listening state
  private _sseAbort: AbortController | null = null
  private _sseListening = false

  /** Repo names for the sync server */
  private static readonly TEAMS_REPO = '__teams__'
  private static readonly INVITATIONS_REPO_PREFIX = '__invitations__'

  /** C14: Per-team invitations repo to avoid cross-team data leakage */
  private get invitationsRepo(): string {
    return `${CloudInvitation.INVITATIONS_REPO_PREFIX}/${this.teamName}`
  }

  constructor(config: {
    apiUrl: string
    apiKey: string
    teamName: string
    agentId: string
    agentName: string
  }) {
    this._apiUrl = config.apiUrl
    this._apiKey = config.apiKey
    this.teamName = config.teamName
    this.agentId = config.agentId
    this.agentName = config.agentName
    this.adapter = new SyncServerAdapter({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      repo: `${CloudInvitation.INVITATIONS_REPO_PREFIX}/${this.teamName}`,
      developerId: config.agentId,
    })
  }

  private getProfileServiceFor(teamName: string, teamAdapter: SyncServerAdapter): TeamProfileService {
    const existing = getProfileService(teamName)
    if (existing) return existing

    const teamsAdapter = new SyncServerAdapter({
      apiUrl: this._apiUrl,
      apiKey: this._apiKey,
      repo: CloudInvitation.TEAMS_REPO,
      developerId: this.agentId,
    })

    return new TeamProfileService({
      teamAdapter,
      teamsAdapter,
      cachePath: join(getTeamDir(teamName), 'cloud-state-cache.json'),
    })
  }

  private async ensureTeamStateFromDiscovery(
    teamAdapter: SyncServerAdapter,
    teamName: string,
    cloudTeamInfo: CloudTeamInfo | null,
  ): Promise<void> {
    teamAdapter.setEtag(undefined)
    const current = await teamAdapter.pull()
    const raw = current?.entries?.team_state
    if (raw && raw !== '__DELETED__') return

    if (!cloudTeamInfo) {
      throw new Error(`[CloudInvitation] Cannot join "${teamName}": team_state missing and discovery metadata unavailable`)
    }

    const createdAtMs = Date.parse(cloudTeamInfo.createdAt) || Date.now()
    const initialState: CloudTeamState = {
      name: cloudTeamInfo.name,
      description: cloudTeamInfo.description,
      createdAt: createdAtMs,
      leadAgentId: cloudTeamInfo.leadAgentId,
      members: [{
        agentId: cloudTeamInfo.leadAgentId,
        name: cloudTeamInfo.leadAgentName || 'team-lead',
        role: 'tech-lead',
        joinedAt: createdAtMs,
        subscriptions: [],
      }],
      policy: { memberModes: {}, allowedPaths: [], joinPolicy: 'invite-only' },
      version: 1,
    }

    await teamAdapter.push({ team_state: JSON.stringify(initialState) }, current?.etag)
  }

  // -- team registration -------------------------------------------

  /**
   * Leader: register team for cloud discovery.
   * Pushes team metadata to the __teams__ repo so remote workers
   * can discover it via discoverCloudTeams().
   */
  async registerTeam(info: CloudTeamInfo): Promise<void> {
    const teamsAdapter = new SyncServerAdapter({
      apiUrl: this._apiUrl,
      apiKey: this._apiKey,
      repo: CloudInvitation.TEAMS_REPO,
      developerId: this.agentId,
    })

    const entry: CloudTeamEntry = {
      info,
      updatedAt: new Date().toISOString(),
    }

    try {
      await teamsAdapter.push({
        [`team/${info.name}`]: JSON.stringify(entry),
      })
    } catch (err) {
      console.warn('[CloudInvitation] registerTeam push failed:',
        err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  // -- invitation lifecycle ----------------------------------------

  /**
   * Leader: send an invitation to a remote worker.
   *
   * 1. Creates an Invitation object with pending status
   * 2. Stores it in the __invitations__/{teamName} repo
   * 3. Broadcasts an SSE event so the worker receives it in real-time
   */
  async sendInvitation(
    toAgentId: string,
    toAgentName: string,
    message: string = '',
  ): Promise<Invitation> {
    const invitation: Invitation = {
      id: randomUUID(),
      fromAgentId: this.agentId,
      fromAgentName: this.agentName,
      toAgentId,
      toAgentName,
      teamName: this.teamName,
      message,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }

    await this.adapter.push({
      [`inv/${invitation.id}`]: JSON.stringify(invitation),
    })

    await this.adapter.postEvent('invite', {
      invitationId: invitation.id,
      fromAgentId: this.agentId,
      fromAgentName: this.agentName,
      toAgentId,
      toAgentName,
      teamName: this.teamName,
      message,
      createdAt: invitation.createdAt,
    })

    return invitation
  }

  /**
   * Worker: list pending invitations for this agent.
   * Pulls all invitations from the __invitations__/{teamName} repo and filters
   * to those addressed to this agentId.
   */
  async getInvitations(): Promise<Invitation[]> {
    const result = await this.adapter.pull()
    if (!result) return []

    const invitations: Invitation[] = []

    for (const [key, value] of Object.entries(result.entries)) {
      if (!key.startsWith('inv/')) continue
      try {
        const inv = JSON.parse(value) as Invitation
        if (inv.toAgentId === this.agentId) {
          invitations.push(inv)
        }
      } catch {
        // Skip malformed entries
      }
    }

    return invitations
  }

  /**
   * Start listening for real-time invitation events via SSE.
   *
   * Workers should call this to receive invitations without polling.
   * Uses the sync server's SSE events stream, filtering for 'invite' events
   * addressed to this agent.
   *
   * @param onInvitationReceived Callback invoked when an invitation arrives
   * @returns A stop function that tears down the SSE connection
   */
  startListening(
    onInvitationReceived: (invite: InvitationData) => void,
  ): () => void {
    if (this._sseListening) {
      // Already listening — caller should stop previous listener first
      throw new Error('[CloudInvitation] Already listening for invitations')
    }

    this._sseListening = true
    this._sseAbort = new AbortController()

    // V5-9: Reconnect state
    let reconnectAttempt = 0
    const maxBackoff = 30_000
    let _reconnectTimeout: ReturnType<typeof setTimeout> | null = null

    const scheduleReconnect = () => {
      if (!this._sseListening) return
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), maxBackoff)
      reconnectAttempt++
      console.log(`[CloudInvitation] SSE reconnect in ${delay}ms (attempt ${reconnectAttempt})`)
      _reconnectTimeout = setTimeout(() => {
        if (this._sseListening) {
          void run().catch(() => { /* handled internally */ })
        }
      }, delay)
    }

    const run = async () => {
      try {
        const response = await this.adapter.connectSSE()

        if (!this._sseListening || this._sseAbort!.signal.aborted) return

        if (!response.ok) {
          console.error(
            `[CloudInvitation] SSE connect failed: ${response.status} ${response.statusText}`,
          )
          scheduleReconnect()
          return
        }

        // V5-9: Successful connection — reset backoff
        reconnectAttempt = 0

        const reader = response.body?.getReader()
        if (!reader) {
          console.error('[CloudInvitation] SSE response has no readable body')
          scheduleReconnect()
          return
        }

        let buffer = ''

        while (this._sseListening && !this._sseAbort!.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += new TextDecoder().decode(value)

          const frames = CloudMessageRouter.parseSSEFrames(buffer + '\n\n')

          const lastBoundary = buffer.lastIndexOf('\n\n')
          if (lastBoundary !== -1) {
            buffer = buffer.slice(lastBoundary + 2)
          }

          for (const frame of frames) {
            // Only process invite events addressed to this agent
            if (frame.event !== 'invite') continue

            const data = frame.data
            if (!data || typeof data !== 'object') continue

            // Check if invitation is for this agent
            if (
              data.toAgentId !== this.agentId &&
              data.toAgentName !== this.agentName
            ) {
              continue
            }

            const invite: InvitationData = {
              invitationId: data.invitationId as string,
              fromAgentId: data.fromAgentId as string,
              fromAgentName: data.fromAgentName as string,
              toAgentId: data.toAgentId as string,
              toAgentName: data.toAgentName as string,
              teamName: data.teamName as string,
              message: (data.message as string) || '',
              createdAt: data.createdAt as string,
            }

            onInvitationReceived(invite)
          }
        }

        // Stream ended normally — reconnect
        scheduleReconnect()
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return
        console.error('[CloudInvitation] SSE read error:', err)
        scheduleReconnect()
      }
    }

    // Fire-and-forget: run the read loop in the background
    void run()

    return () => {
      this._sseListening = false
      if (this._sseAbort) {
        this._sseAbort.abort()
        this._sseAbort = null
      }
      if (_reconnectTimeout) {
        clearTimeout(_reconnectTimeout)
        _reconnectTimeout = null
      }
    }
  }

  /**
   * Worker: accept an invitation.
   * Updates the invitation status to 'accepted', sets respondedAt,
   * and syncs team data from the cloud.
   */
  async acceptInvitation(invitationId: string): Promise<void> {
    const invitation = await this._updateInvitationStatus(invitationId, 'accepted')
    await this._syncTeamDataAfterAccept(invitation.teamName)
  }

  /**
   * Worker: decline an invitation.
   * Updates the invitation status to 'declined' and sets respondedAt.
   */
  async declineInvitation(invitationId: string, reason: string = ''): Promise<void> {
    await this._updateInvitationStatus(invitationId, 'declined', reason)
  }

  // -- C10: join cloud team from discovery --------------------------

  /**
   * C10: Join a cloud team discovered via discoverCloudTeams.
   * Pulls full team state, creates local team file, and pushes membership.
   */
  async joinCloudTeam(targetTeamName: string): Promise<TeamFile> {
    console.log(`[CloudInvitation:C10] Joining "${targetTeamName}" as ${this.agentName}`)

    const teamAdapter = new SyncServerAdapter({
      apiUrl: this._apiUrl, apiKey: this._apiKey,
      repo: targetTeamName, developerId: this.agentId,
    })
    const teamResult = await teamAdapter.pull()

    const teamsAdapter = new SyncServerAdapter({
      apiUrl: this._apiUrl, apiKey: this._apiKey,
      repo: CloudInvitation.TEAMS_REPO, developerId: this.agentId,
    })
    const teamsResult = await teamsAdapter.pull()
    let cloudTeamInfo: CloudTeamInfo | null = null
    const rawDiscovery = teamsResult?.entries?.[`team/${targetTeamName}`]
    if (rawDiscovery) {
      try {
        const entry = JSON.parse(rawDiscovery) as CloudTeamEntry | CloudTeamInfo
        cloudTeamInfo = 'info' in entry ? entry.info : entry
      } catch { /* skip */ }
    }

    // Create join-request invitation for leader awareness
    const invitationId = randomUUID()
    const inviteAdapter = new SyncServerAdapter({
      apiUrl: this._apiUrl, apiKey: this._apiKey,
      repo: `${CloudInvitation.INVITATIONS_REPO_PREFIX}/${targetTeamName}`, developerId: this.agentId,
    })
    await inviteAdapter.push({
      [`inv/${invitationId}`]: JSON.stringify({
        id: invitationId, fromAgentId: this.agentId, fromAgentName: this.agentName,
        toAgentId: '', toAgentName: '', teamName: targetTeamName,
        message: `${this.agentName} requests to join "${targetTeamName}"`,
        status: 'pending', createdAt: new Date().toISOString(),
      }),
    })
    await inviteAdapter.postEvent('invite', {
      invitationId, fromAgentId: this.agentId, fromAgentName: this.agentName,
      toAgentId: '', toAgentName: '', teamName: targetTeamName,
      message: `${this.agentName} requests to join`, createdAt: new Date().toISOString(),
    })

    // V4: Cloud-first — add self to team_state via TeamProfileService
    const now = Date.now()
    const selfProfile: TeamMemberProfile = {
      agentId: this.agentId, name: this.agentName, role: 'developer',
      joinedAt: now, subscriptions: [], agentType: 'worker',
    }

    const profileService = this.getProfileServiceFor(targetTeamName, teamAdapter)
    await this.ensureTeamStateFromDiscovery(teamAdapter, targetTeamName, cloudTeamInfo)
    await profileService.refresh()
    await profileService.addMember(selfProfile)
    console.log(`[CloudInvitation:C10:V4] Added self to cloud team_state`)

    const refreshed = await teamAdapter.pull()

    // Build local team file from cloud data for backward compat
    let members: TeamFile['members'] = []
    if (refreshed?.entries['team_state']) {
      members = (JSON.parse(refreshed.entries['team_state']) as TeamFile).members || []
    }
    if (!members.some(m => m.agentId === this.agentId)) {
      members.push({
        agentId: this.agentId, name: this.agentName, role: 'developer',
        agentType: 'worker',
        joinedAt: now, tmuxPaneId: '', cwd: process.cwd(),
        subscriptions: [], isActive: true,
      })
    }
    const teamFile: TeamFile = {
      name: targetTeamName, description: 'Joined via cloud discovery',
      createdAt: now, leadAgentId: members[0]?.agentId || '',
      hiddenPaneIds: [], teamAllowedPaths: [], members,
    }
    writeTeamFile(targetTeamName, teamFile)

    console.log(`[CloudInvitation:C10] Joined "${targetTeamName}" (${members.length} members)`)
    return teamFile
  }

  // -- team discovery (static) -------------------------------------

  /**
   * Discover all teams available on the cloud.
   * Pulls the __teams__ repo and parses all team/ entries.
   */
  static async discoverCloudTeams(apiUrl: string, apiKey: string): Promise<CloudTeamInfo[]> {
    const adapter = new SyncServerAdapter({
      apiUrl,
      apiKey,
      repo: CloudInvitation.TEAMS_REPO,
      developerId: 'discoverer',
    })

    const result = await adapter.pull()
    if (!result) return []

    const teams: CloudTeamInfo[] = []

    for (const [key, value] of Object.entries(result.entries)) {
      if (!key.startsWith('team/')) continue
      try {
        const entry = JSON.parse(value) as CloudTeamEntry | CloudTeamInfo
        const info = 'info' in entry ? entry.info : entry
        if (info?.name) {
          teams.push(info)
        }
      } catch {
        // Skip malformed entries
      }
    }

    return teams
  }

  // -- private helpers ----------------------------------------------

  /**
   * After accepting an invitation, pull the latest team data from the
   * __teams__ cloud repo and persist it as a local team file so the
   * worker has immediate access to team configuration.
   */
  private async _syncTeamDataAfterAccept(targetTeamName: string): Promise<void> {
    try {
      // Step 1: Pull metadata from __teams__ repo
      const teamsAdapter = new SyncServerAdapter({
        apiUrl: this._apiUrl, apiKey: this._apiKey,
        repo: CloudInvitation.TEAMS_REPO, developerId: this.agentId,
      })
      const teamsResult = await teamsAdapter.pull()
      let cloudTeamInfo: CloudTeamInfo | null = null
      if (teamsResult) {
        const raw = teamsResult.entries[`team/${targetTeamName}`]
        if (raw) {
          try {
            const entry = JSON.parse(raw) as CloudTeamEntry | CloudTeamInfo
            cloudTeamInfo = 'info' in entry ? entry.info : entry
          } catch { /* skip */ }
        }
      }

      const teamAdapter = new SyncServerAdapter({
        apiUrl: this._apiUrl, apiKey: this._apiKey,
        repo: targetTeamName, developerId: this.agentId,
      })

      const now = Date.now()
      const selfProfile: TeamMemberProfile = {
        agentId: this.agentId, name: this.agentName, role: 'developer',
        joinedAt: now, subscriptions: [], agentType: 'worker',
      }

      const profileService = this.getProfileServiceFor(targetTeamName, teamAdapter)
      await this.ensureTeamStateFromDiscovery(teamAdapter, targetTeamName, cloudTeamInfo)
      await profileService.addMember(selfProfile)
      console.log('[CloudInvitation:C9:V4] Added self to cloud team_state')

      teamAdapter.setEtag(undefined)
      const teamResult = await teamAdapter.pull()
      const teamStateRaw = teamResult?.entries?.team_state
      if (!teamStateRaw || teamStateRaw === '__DELETED__') {
        throw new Error(`[CloudInvitation] Cannot sync "${targetTeamName}": cloud team_state missing after accept`)
      }
      const cloudState = JSON.parse(teamStateRaw) as CloudTeamState
      const fullMemberList = cloudState.members

      // Step 4: Build and persist local TeamFile (backward compat cache)
      const teamFile: TeamFile = {
        name: cloudState.name || targetTeamName,
        description: cloudState.description || cloudTeamInfo?.description || 'Joined via cloud invitation',
        createdAt: cloudState.createdAt || (cloudTeamInfo ? new Date(cloudTeamInfo.createdAt).getTime() : now),
        leadAgentId: cloudState.leadAgentId || cloudTeamInfo?.leadAgentId || fullMemberList[0]?.agentId || '',
        hiddenPaneIds: [],
        teamAllowedPaths: cloudState.policy.allowedPaths,
        members: fullMemberList.map(member => ({
          ...member,
          tmuxPaneId: '',
          cwd: process.cwd(),
          isActive: member.agentId === this.agentId,
        })),
      }

      writeTeamFile(targetTeamName, teamFile)
      console.log(`[CloudInvitation:C9] Synced "${targetTeamName}" (${fullMemberList.length} members)`)
    } catch (err) {
      console.error('[CloudInvitation:C9] Sync failed:', err)
      throw err
    }
  }

  /**
   * Update an invitation's status in the cloud.
   * Uses read-modify-write: pulls current state, finds the invitation,
   * updates its status, and pushes back.
   */
  private async _updateInvitationStatus(
    invitationId: string,
    newStatus: 'accepted' | 'declined',
    reason: string = '',
  ): Promise<Invitation> {
    try {
      // Force a fresh pull by clearing cached ETag — otherwise a recent pull
      // may return 304 Not Modified, giving us null here.
      this.adapter.setEtag(undefined)

      // Pull current state
      const result = await this.adapter.pull()
      if (!result) {
        throw new Error(`Invitation ${invitationId} not found (server unreachable or no data)`)
      }

      const key = `inv/${invitationId}`
      const currentValue = result.entries[key]
      if (!currentValue) {
        throw new Error(`Invitation ${invitationId} not found`)
      }

      // Parse and update
      const invitation = JSON.parse(currentValue) as Invitation
      invitation.status = newStatus
      invitation.respondedAt = new Date().toISOString()
      invitation.responseReason = reason || undefined

      // Push updated entry only (upsert semantics preserve other keys)
      await this.adapter.push({
        [key]: JSON.stringify(invitation),
      })

      return invitation
    } catch (err) {
      console.warn(`[CloudInvitation] _updateInvitationStatus failed for "${invitationId}":`,
        err instanceof Error ? err.message : String(err))
      throw err
    }
  }
}
