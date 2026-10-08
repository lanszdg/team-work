/**
 * TeamProfileService �?Cloud-First Team State Management (v4)
 *
 * The single entry point for all team profile and policy mutations.
 * Enforces cloud-first consistency: all writes go to cloud first,
 * local cache is only updated after cloud confirms success.
 *
 * Uses ETag-based CAS (Compare-And-Swap) for concurrent write safety.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { SyncServerAdapter, SyncServerError } from './syncServerAdapter.js'
import type {
  CloudTeamState,
  TeamMemberProfile,
  TeamPolicy,
  TeamAllowedPath,
  TeamRole,
  PermissionMode,
} from './types.js'

// ============================================================
// Error Types
// ============================================================

export class DuplicateTeamError extends Error {
  override name = 'DuplicateTeamError'
}

export class CreateTeamError extends Error {
  override name = 'CreateTeamError'
}

// ============================================================
// Service
// ============================================================

export class TeamProfileService {
  private teamAdapter: SyncServerAdapter
  private teamsAdapter: SyncServerAdapter | null
  private state: CloudTeamState | null = null
  private cachePath: string

  constructor(options: {
    teamAdapter: SyncServerAdapter
    teamsAdapter?: SyncServerAdapter | null
    cachePath: string
  }) {
    this.teamAdapter = options.teamAdapter
    this.teamsAdapter = options.teamsAdapter ?? null
    this.cachePath = options.cachePath
  }

  // ============================================================
  // Write Operations �?Cloud-First + ETag CAS
  // ============================================================

  /**
   * Atomic read-modify-write with ETag optimistic locking.
   * Pull latest �?apply mutation �?push with If-Match �?412 then retry.
   */
  private async mutate(
    fn: (state: CloudTeamState) => CloudTeamState,
    options?: { requireExisting?: boolean; maxRetries?: number },
  ): Promise<CloudTeamState> {
    const maxRetries = options?.maxRetries ?? 3
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Mutations need the actual current body, not a 304 from the adapter cache.
      this.teamAdapter.setEtag(undefined)
      const result = await this.teamAdapter.pull()
      const etag = result?.etag
      const existing = result?.entries?.team_state

      if (options?.requireExisting && !existing) {
        throw new Error('[TeamProfileService] team_state not found �?team does not exist')
      }

      const current: CloudTeamState = existing
        ? JSON.parse(existing)
        : this.newEmptyState()

      const next = fn({ ...current, version: (current.version || 0) + 1 })

      try {
        await this.teamAdapter.push(
          { team_state: JSON.stringify(next) },
          etag,
        )
        // Cloud success �?publish SSE notification + update local cache
        this.postEvent('team_state_changed', { version: next.version })
        this.state = next
        this.persistCache()
        return next
      } catch (err) {
        if (err instanceof SyncServerError && err.status === 412) {
          continue
        }
        throw err
      }
    }
    throw new Error('[TeamProfileService] CAS failed after max retries')
  }

  /**
   * Create a team �?cross-repo transaction:
   * 1. Register in __teams__ discovery index (create lock / duplicate check)
   * 2. Write team_state to team repo
   * 3. Either step fails �?best-effort cleanup, throw, no local success
   */
  async createTeam(params: {
    name: string
    leadAgentId: string
    role?: TeamRole
    description?: string
  }): Promise<CloudTeamState> {
    const teamName = params.name
    const role: TeamRole = params.role ?? 'tech-lead'

    const existingTeam = await this.teamAdapter.pull()
    const existingTeamState = existingTeam?.entries?.team_state
    if (existingTeamState && existingTeamState !== '__DELETED__') {
      throw new DuplicateTeamError(`Team "${teamName}" already has a team_state`)
    }

    // Step 1: Discovery index �?check duplicate + register
    if (this.teamsAdapter) {
      const teamsResult = await this.teamsAdapter.pull()
      const discoveryKey = `team/${teamName}`
      if (
        teamsResult?.entries?.[discoveryKey] &&
        teamsResult.entries[discoveryKey] !== '__DELETED__'
      ) {
        throw new DuplicateTeamError(`Team "${teamName}" already exists in discovery index`)
      }
      try {
        const nowIso = new Date().toISOString()
        await this.teamsAdapter.push({
          [discoveryKey]: JSON.stringify({
            info: {
              name: teamName,
              description: params.description || '',
              leadAgentId: params.leadAgentId,
              leadAgentName: 'team-lead',
              memberCount: 1,
              createdAt: nowIso,
            },
            updatedAt: nowIso,
          }),
        })
      } catch (err) {
        throw new CreateTeamError('Failed to register team in discovery index', { cause: err })
      }
    }

    // Step 2: Write team_state
    try {
      const state = await this.mutate(() => ({
        name: teamName,
        description: params.description,
        createdAt: Date.now(),
        leadAgentId: params.leadAgentId,
        members: [
            {
              agentId: params.leadAgentId,
              name: 'team-lead',
            role,
            joinedAt: Date.now(),
            subscriptions: [],
          },
        ],
        policy: { memberModes: {}, allowedPaths: [], joinPolicy: 'open' as const },
        version: 1,
      }))
      return state
    } catch (err) {
      // Step 2 failed �?best-effort cleanup discovery
      if (this.teamsAdapter) {
        try {
          await this.teamsAdapter.push({ [`team/${teamName}`]: '__DELETED__' })
        } catch { /* orphan �?non-fatal */ }
      }
      throw new CreateTeamError(
        'Team state creation failed after discovery registration',
        { cause: err },
      )
    }
  }

  /**
   * Destroy a team �?cross-repo: delete team_state, then remove from __teams__.
   */
  async destroyTeam(): Promise<void> {
    const teamName = this.state?.name
    if (!teamName) throw new Error('[TeamProfileService] No team loaded')

    await this.teamAdapter.push({ team_state: '__DELETED__' })

    if (this.teamsAdapter) {
      try {
        await this.teamsAdapter.push({ [`team/${teamName}`]: '__DELETED__' })
      } catch {
        console.warn(`[TeamProfileService] discovery cleanup failed for "${teamName}"`)
      }
    }

    this.state = null
    this.persistCache()
  }

  async addMember(profile: TeamMemberProfile): Promise<void> {
    await this.mutate(state => {
      if (state.members.some(m => m.agentId === profile.agentId)) return state
      return { ...state, members: [...state.members, profile] }
    }, { requireExisting: true })
  }

  async removeMember(agentId: string): Promise<void> {
    await this.mutate(state => ({
      ...state,
      members: state.members.filter(m => m.agentId !== agentId),
    }), { requireExisting: true })
  }

  async setMemberMode(agentId: string, mode: PermissionMode): Promise<void> {
    await this.mutate(state => ({
      ...state,
      policy: {
        ...state.policy,
        memberModes: { ...state.policy.memberModes, [agentId]: mode },
      },
    }), { requireExisting: true })
  }

  async setMultipleMemberModes(modes: Record<string, PermissionMode>): Promise<void> {
    await this.mutate(state => ({
      ...state,
      policy: {
        ...state.policy,
        memberModes: { ...state.policy.memberModes, ...modes },
      },
    }), { requireExisting: true })
  }

  async addAllowedPath(path: TeamAllowedPath): Promise<void> {
    await this.mutate(state => ({
      ...state,
      policy: {
        ...state.policy,
        allowedPaths: [...state.policy.allowedPaths, path],
      },
    }), { requireExisting: true })
  }

  // ============================================================
  // Read Operations �?Local Cache
  // ============================================================

  getState(): CloudTeamState | null {
    return this.state
  }

  getMembers(): TeamMemberProfile[] {
    return this.state?.members ?? []
  }

  getPolicy(): TeamPolicy | null {
    return this.state?.policy ?? null
  }

  getMemberMode(agentId: string): PermissionMode | undefined {
    return this.state?.policy?.memberModes?.[agentId]
  }

  // ============================================================
  // Cache Refresh
  // ============================================================

  /**
   * Pull latest state from cloud. Called on startup, SSE events, or periodic timer.
   */
  async refresh(): Promise<void> {
    const result = await this.teamAdapter.pull()
    if (!result?.entries?.team_state) return
    const raw = result.entries.team_state
    if (raw === '__DELETED__') {
      this.state = null
      this.persistCache()
      return
    }
    this.state = JSON.parse(raw)
    this.persistCache()
  }

  /**
   * Load from local cache file (fallback when cloud is unreachable on startup).
   */
  loadFromCache(): boolean {
    try {
      const raw = readFileSync(this.cachePath, 'utf-8')
      this.state = JSON.parse(raw)
      return true
    } catch {
      return false
    }
  }

  // ============================================================
  // Internal
  // ============================================================

  private newEmptyState(): CloudTeamState {
    return {
      name: '',
      createdAt: 0,
      leadAgentId: '',
      members: [],
      policy: { memberModes: {}, allowedPaths: [], joinPolicy: 'open' },
      version: 0,
    }
  }

  private persistCache(): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true })
      if (this.state) {
        writeFileSync(this.cachePath, JSON.stringify(this.state, null, 2))
      } else {
        // Team destroyed �?write empty marker
        writeFileSync(this.cachePath, '{}')
      }
    } catch { /* cache write failure is non-fatal */ }
  }

  /** SSE event notification - failure does not roll back team_state. */
  private postEvent(type: string, data: Record<string, unknown>): void {
    // The deployed sync server only accepts a fixed event enum. Preserve the
    // domain event in payload instead of posting an unsupported event type.
    const serverType: Parameters<SyncServerAdapter['postEvent']>[0] =
      type === 'team_state_changed'
        ? 'memory'
        : type as Parameters<SyncServerAdapter['postEvent']>[0]
    this.teamAdapter
      .postEvent(serverType, { ...data, domainEvent: type })
      .catch(err => {
        console.warn(`[TeamProfileService] postEvent(${type}) failed (non-fatal):`, err)
      })
  }
}
