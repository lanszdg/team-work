/**
 * CloudVoting — Team decision voting (v3.6 Phase 3)
 *
 * Votes flow: Draft → Open → Resolved (approved/rejected) | Expired | Cancelled
 * Storage: votes/{voteId} + ballots/{voteId} in cloud KV
 */

import { randomUUID } from 'crypto'
import { SyncServerAdapter } from './syncServerAdapter.js'
import type { TeamRole } from './types.js'
import type {
  Vote, VoteType, VoteStatus, VoteThreshold,
  Ballot, RollbackInfo,
} from './cloudVotingTypes.js'
import { VOTE_TYPE_RULES } from './cloudVotingTypes.js'

// ============================================================
// Voting result logic
// ============================================================

function isVoteApproved(vote: Vote, ballots: Ballot[]): boolean {
  const { threshold } = vote

  switch (threshold.type) {
    case 'single':
      return ballots.some(b => b.decision === 'approve')

    case 'unanimous':
      return ballots.length === vote.voters.length &&
             ballots.every(b => b.decision === 'approve')

    case 'supermajority':
    case 'majority': {
      const approveCount = ballots.filter(b => b.decision === 'approve').length
      const totalCount = vote.voters.length
      const required = threshold.type === 'supermajority'
        ? Math.ceil(totalCount * (threshold.percentage ?? 66) / 100)
        : Math.floor(totalCount / 2) + 1
      return approveCount >= required
    }
  }
}

function checkEarlyTermination(vote: Vote, ballots: Ballot[]): 'approved' | 'rejected' | null {
  const { threshold } = vote
  const approveCount = ballots.filter(b => b.decision === 'approve').length
  const totalCount = vote.voters.length
  const remaining = totalCount - ballots.length

  const required = getRequiredApproves(threshold, totalCount)

  if (approveCount >= required) return 'approved'
  if (approveCount + remaining < required) return 'rejected'
  return null
}

function getRequiredApproves(threshold: VoteThreshold, totalVoters: number): number {
  switch (threshold.type) {
    case 'single': return 1
    case 'unanimous': return totalVoters
    case 'supermajority':
      return Math.ceil(totalVoters * (threshold.percentage ?? 66) / 100)
    case 'majority':
      return Math.floor(totalVoters / 2) + 1
  }
}

// ============================================================
// Vote event callbacks
// ============================================================

type VoteEventCallbacks = {
  onVoteResolved?: (vote: Vote) => void | Promise<void>
  onVoteCancelled?: (vote: Vote) => void | Promise<void>
  onVoteRolledBack?: (vote: Vote) => void | Promise<void>
  onVoteExpired?: (vote: Vote) => void | Promise<void>
  onVoteRequest?: (vote: Vote) => void | Promise<void>
}

// ============================================================
// CloudVoting class
// ============================================================

export class CloudVoting {
  private adapter: SyncServerAdapter
  private teamName: string
  private agentId: string
  private agentRole: TeamRole
  private getTeamMembers: (() => Array<{ agentId: string; role: TeamRole }>) | undefined
  private callbacks: VoteEventCallbacks = {}
  private stopSSE: (() => void) | null = null

  constructor(config: {
    apiUrl: string
    apiKey: string
    teamName: string
    agentId: string
    agentRole: TeamRole
    getTeamMembers?: () => Array<{ agentId: string; role: TeamRole }>
  }) {
    this.adapter = new SyncServerAdapter({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      repo: config.teamName,
      developerId: config.agentId,
    })
    this.teamName = config.teamName
    this.agentId = config.agentId
    this.agentRole = config.agentRole
    this.getTeamMembers = config.getTeamMembers
  }

  // ============================================================
  // Create & Launch
  // ============================================================

  async createVote(params: {
    type: VoteType
    topic: string
    description: string
    context?: string
    voters?: string[]
    threshold?: VoteThreshold
    timeoutMs?: number
  }): Promise<Vote> {
    const rules = VOTE_TYPE_RULES[params.type]

    // Role check: only allowed initiators can create
    if (!rules.allowedInitiators.includes(this.agentRole)) {
      throw new Error(
        `[CloudVoting] Role "${this.agentRole}" cannot initiate ${params.type} votes. ` +
        `Allowed: [${rules.allowedInitiators.join(', ')}]`
      )
    }

    // Determine voter list
    let voterIds: string[]
    if (params.voters) {
      // Custom voters → validate against team members
      const members = this.getTeamMembers?.() ?? []
      const validIds = new Set(members.map(m => m.agentId))
      const invalid = params.voters.filter(id => !validIds.has(id))
      if (invalid.length > 0) {
        throw new Error(
          `[CloudVoting] Invalid voter IDs: [${invalid.join(', ')}]`
        )
      }
      voterIds = [...new Set(params.voters)]
    } else {
      // Resolve roles to real agentIds via getTeamMembers provider
      const members = this.getTeamMembers?.() ?? []
      voterIds = members
        .filter(m => rules.requiredRoles.includes(m.role))
        .map(m => m.agentId)
      voterIds = [...new Set(voterIds)]
    }

    if (rules.minTeamSize && voterIds.length < rules.minTeamSize) {
      throw new Error(
        `[CloudVoting] ${params.type} requires at least ${rules.minTeamSize} voters, ` +
        `got ${voterIds.length}`
      )
    }

    const voteId = randomUUID()
    const now = new Date().toISOString()
    const timeoutMs = params.timeoutMs ?? rules.defaultTimeoutMs

    const vote: Vote = {
      voteId,
      type: params.type,
      topic: params.topic,
      description: params.description,
      context: params.context,
      initiator: this.agentId,
      initiatorRole: this.agentRole,
      voters: voterIds,
      threshold: params.threshold ?? rules.defaultThreshold,
      status: 'draft',
      createdAt: now,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    }

    await this.adapter.push({
      [`votes/${voteId}`]: JSON.stringify(vote),
    })

    return vote
  }

  async launchVote(voteId: string): Promise<Vote> {
    const vote = await this.getVote(voteId)
    if (!vote) throw new Error(`[CloudVoting] Vote ${voteId} not found`)
    if (vote.status !== 'draft') throw new Error(`[CloudVoting] Vote ${voteId} is not in draft status`)

    vote.status = 'open'
    await this.adapter.push({
      [`votes/${voteId}`]: JSON.stringify(vote),
    })

    // SSE: notify voters
    await this.adapter.postEvent('vote_request', { voteId, vote }).catch(() => {})

    return vote
  }

  // ============================================================
  // Vote casting
  // ============================================================

  async castVote(
    voteId: string,
    decision: 'approve' | 'reject' | 'abstain',
    comment?: string,
  ): Promise<Vote> {
    const vote = await this.getVote(voteId)
    if (!vote) throw new Error(`[CloudVoting] Vote ${voteId} not found`)
    if (vote.status !== 'open') throw new Error(`[CloudVoting] Vote ${voteId} is not open`)

    // Eligibility check: only designated voters can cast
    if (!vote.voters.includes(this.agentId)) {
      throw new Error(
        `[CloudVoting] Agent ${this.agentId} is not eligible to vote on ${voteId}`
      )
    }

    // Load existing ballots
    const ballots = await this.getBallots(voteId)

    // Immutable: same voter cannot re-vote
    const existing = ballots.find(b => b.voterId === this.agentId)
    if (existing) {
      throw new Error(`[CloudVoting] Agent ${this.agentId} already voted on ${voteId}. Votes are immutable.`)
    }

    const ballot: Ballot = {
      voterId: this.agentId,
      voterRole: this.agentRole,
      decision,
      comment,
      timestamp: new Date().toISOString(),
    }

    ballots.push(ballot)
    vote.ballotCount = ballots.length

    await this.adapter.push({
      [`ballots/${voteId}`]: JSON.stringify(ballots),
    })

    // Check early termination
    const early = checkEarlyTermination(vote, ballots)
    if (early) {
      vote.status = 'resolved'
      vote.result = early
      vote.resolvedAt = new Date().toISOString()
      vote.ballots = ballots
      await this.adapter.push({ [`votes/${voteId}`]: JSON.stringify(vote) })
      await this.adapter.postEvent('vote_resolved', { voteId, vote }).catch(() => {})
    } else {
      // Update ballot count
      await this.adapter.push({ [`votes/${voteId}`]: JSON.stringify(vote) })
    }

    return vote
  }

  // ============================================================
  // Query
  // ============================================================

  async getVote(voteId: string): Promise<Vote | null> {
    try {
      const result = await this.adapter.pull()
      const entry = result?.entries?.[`votes/${voteId}`]
      if (!entry) return null
      return JSON.parse(entry) as Vote
    } catch {
      return null
    }
  }

  async listPendingVotes(): Promise<Vote[]> {
    return this.listVotesByStatus('open')
  }

  async listVotesByStatus(status: VoteStatus): Promise<Vote[]> {
    try {
      const result = await this.adapter.pull()
      if (!result?.entries) return []

      const votes: Vote[] = []
      for (const [key, value] of Object.entries(result.entries)) {
        if (!key.startsWith('votes/') || !value) continue
        try {
          const vote = JSON.parse(value) as Vote
          if (vote.status === status) votes.push(vote)
        } catch { /* skip malformed */ }
      }
      return votes
    } catch {
      return []
    }
  }

  // ============================================================
  // Cancel & Rollback
  // ============================================================

  async cancelVote(voteId: string, reason?: string): Promise<Vote> {
    const vote = await this.getVote(voteId)
    if (!vote) throw new Error(`[CloudVoting] Vote ${voteId} not found`)
    if (vote.status === 'resolved' || vote.status === 'cancelled') {
      throw new Error(`[CloudVoting] Cannot cancel vote in ${vote.status} status`)
    }
    // Only initiator or tech-lead can cancel
    if (vote.initiator !== this.agentId && this.agentRole !== 'tech-lead') {
      throw new Error(`[CloudVoting] Only initiator or tech-lead can cancel votes`)
    }

    vote.status = 'cancelled'
    await this.adapter.push({ [`votes/${voteId}`]: JSON.stringify(vote) })
    await this.adapter.postEvent('vote_cancelled', { voteId, vote, reason }).catch(() => {})

    return vote
  }

  async rollbackVote(voteId: string, info: { reason: string; rollbackTo: string }): Promise<Vote> {
    const vote = await this.getVote(voteId)
    if (!vote) throw new Error(`[CloudVoting] Vote ${voteId} not found`)
    if (vote.status !== 'resolved' || vote.result !== 'approved') {
      throw new Error(`[CloudVoting] Can only rollback approved resolved votes`)
    }

    vote.status = 'rolled_back'
    vote.rollbackInfo = {
      reason: info.reason,
      requestedBy: this.agentId,
      rollbackTo: info.rollbackTo,
    }

    await this.adapter.push({ [`votes/${voteId}`]: JSON.stringify(vote) })
    await this.adapter.postEvent('vote_rollback', { voteId, vote }).catch(() => {})

    return vote
  }

  // ============================================================
  // Event callbacks registration
  // ============================================================

  /** Register callbacks for vote lifecycle events. Called by platform layer. */
  onEvent(callbacks: VoteEventCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks }
  }

  /**
   * Handle incoming vote event from SSE/InboxPoller.
   * Routes vote_* events to registered callbacks.
   *
   * @param event Must contain voteId or full vote payload. voteId ≠ message.messageId.
   */
  async handleVoteEvent(event: { type: string; voteId?: string; vote?: Vote }): Promise<void> {
    const vote = event.vote ?? (event.voteId ? await this.getVote(event.voteId) : null)
    if (!vote) {
      throw new Error(`[CloudVoting] Vote event missing payload for type "${event.type}"`)
    }

    switch (event.type) {
      case 'vote_resolved':  await this.callbacks.onVoteResolved?.(vote); break
      case 'vote_cancelled': await this.callbacks.onVoteCancelled?.(vote); break
      case 'vote_rollback':  await this.callbacks.onVoteRolledBack?.(vote); break
      case 'vote_expired':   await this.callbacks.onVoteExpired?.(vote); break
      case 'vote_request':   await this.callbacks.onVoteRequest?.(vote); break
      default:
        console.warn(`[CloudVoting] Unhandled vote event type: ${event.type}`)
    }
  }

  // ============================================================
  // SSE cleanup (placeholder — actual SSE handled by CloudMessageRouter)
  // ============================================================

  stopListening(): void {
    if (this.stopSSE) {
      this.stopSSE()
      this.stopSSE = null
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async getBallots(voteId: string): Promise<Ballot[]> {
    try {
      const result = await this.adapter.pull()
      const entry = result?.entries?.[`ballots/${voteId}`]
      if (!entry) return []
      return JSON.parse(entry) as Ballot[]
    } catch {
      return []
    }
  }
}
