/**
 * Cloud Voting Type Definitions (v3.6 Phase 3)
 *
 * All types for the team decision voting system.
 * Votes are stored in cloud KV: votes/{voteId}, ballots/{voteId}
 */

import type { TeamRole } from './types.js'

// ============================================================
// Vote lifecycle types
// ============================================================

export type VoteType =
  | 'task_decomposition'
  | 'release_approval'
  | 'architecture_review'
  | 'hotfix_emergency'
  | 'custom'

export type VoteStatus =
  | 'draft'
  | 'open'
  | 'resolved'
  | 'expired'
  | 'rolled_back'
  | 'cancelled'

// ============================================================
// Core voting interfaces
// ============================================================

export interface VoteThreshold {
  type: 'majority' | 'supermajority' | 'unanimous' | 'single'
  minVotes?: number
  percentage?: number
}

export interface Ballot {
  voterId: string
  voterRole: TeamRole
  decision: 'approve' | 'reject' | 'abstain'
  comment?: string
  timestamp: string
}

export interface RollbackInfo {
  reason: string
  requestedBy: string
  rollbackTo: string
  reopensVoteId?: string
}

export interface Vote {
  voteId: string
  type: VoteType
  topic: string
  description: string
  context?: string
  initiator: string
  initiatorRole: TeamRole
  voters: string[]
  threshold: VoteThreshold
  status: VoteStatus
  createdAt: string
  expiresAt: string
  resolvedAt?: string
  result?: 'approved' | 'rejected'
  ballotCount?: number
  ballots?: Ballot[]
  rollbackInfo?: RollbackInfo
}

// ============================================================
// Vote type rules
// ============================================================

export const VOTE_TYPE_RULES: Record<VoteType, {
  defaultThreshold: VoteThreshold
  allowedInitiators: TeamRole[]
  requiredRoles: TeamRole[]
  defaultTimeoutMs: number
  minTeamSize?: number
}> = {
  'task_decomposition': {
    defaultThreshold: { type: 'supermajority', percentage: 66 },
    allowedInitiators: ['tech-lead', 'product-manager', 'architect'],
    requiredRoles: ['tech-lead', 'product-manager', 'architect', 'developer', 'qa-engineer'],
    defaultTimeoutMs: 24 * 60 * 60 * 1000,
    minTeamSize: 2,
  },
  'release_approval': {
    defaultThreshold: { type: 'unanimous' },
    allowedInitiators: ['tech-lead', 'ops-engineer'],
    requiredRoles: ['tech-lead', 'qa-engineer', 'ops-engineer'],
    defaultTimeoutMs: 48 * 60 * 60 * 1000,
    minTeamSize: 3,
  },
  'architecture_review': {
    defaultThreshold: { type: 'unanimous' },
    allowedInitiators: ['architect', 'tech-lead'],
    requiredRoles: ['architect', 'tech-lead'],
    defaultTimeoutMs: 24 * 60 * 60 * 1000,
    minTeamSize: 2,
  },
  'hotfix_emergency': {
    defaultThreshold: { type: 'single', minVotes: 1 },
    allowedInitiators: ['tech-lead'],
    requiredRoles: ['tech-lead'],
    defaultTimeoutMs: 1 * 60 * 60 * 1000,
    minTeamSize: 1,
  },
  'custom': {
    defaultThreshold: { type: 'majority' },
    allowedInitiators: ['tech-lead', 'product-manager', 'architect'],
    requiredRoles: [],
    defaultTimeoutMs: 24 * 60 * 60 * 1000,
    minTeamSize: 1,
  },
}
