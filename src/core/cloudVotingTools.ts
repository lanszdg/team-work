/**
 * Cloud Voting MCP Tools (v3.6 Phase 3.5)
 *
 * Exposes voting operations as callable tool functions.
 * Integrates with CloudVoting and ROLE_PERMISSIONS for access control.
 *
 * Tools: vote_create, vote_launch, vote_cast, vote_list, vote_detail,
 *        vote_cancel, vote_rollback, team_members, my_permissions
 */

import { CloudVoting } from './cloudVoting.js'
import type { VoteType } from './cloudVotingTypes.js'
import { ROLE_PERMISSIONS } from './types.js'
import type { TeamRole } from './types.js'

// ============================================================
// Tool parameter types
// ============================================================

export interface VoteCreateParams {
  type: VoteType
  topic: string
  description: string
  context?: string
}

export interface VoteLaunchParams {
  voteId: string
}

export interface VoteCastParams {
  voteId: string
  decision: 'approve' | 'reject' | 'abstain'
  comment?: string
}

export interface VoteListParams {
  status?: 'open' | 'resolved' | 'expired' | 'cancelled'
}

export interface VoteDetailParams {
  voteId: string
}

export interface VoteCancelParams {
  voteId: string
  reason?: string
}

export interface VoteRollbackParams {
  voteId: string
  reason: string
  rollbackTo: string
}

// ============================================================
// Tool implementations
// ============================================================

export class VotingTools {
  private voting: CloudVoting
  private agentRole: TeamRole
  private getTeamMembers: (() => Array<{ agentId: string; name: string; role: TeamRole }>) | undefined

  constructor(
    voting: CloudVoting,
    agentRole: TeamRole,
    getTeamMembers?: () => Array<{ agentId: string; name: string; role: TeamRole }>,
  ) {
    this.voting = voting
    this.agentRole = agentRole
    this.getTeamMembers = getTeamMembers
  }

  private get perms() {
    return ROLE_PERMISSIONS[this.agentRole]
  }

  // --- vote_create ---
  async voteCreate(params: VoteCreateParams): Promise<string> {
    if (!this.perms.canInitiateVote) {
      throw new Error(`[VotingTools] Role "${this.agentRole}" cannot initiate votes`)
    }
    const vote = await this.voting.createVote(params)
    return `投票已创建: ${vote.voteId}\n类型: ${vote.type}\n主题: ${vote.topic}`
  }

  // --- vote_launch ---
  async voteLaunch(params: VoteLaunchParams): Promise<string> {
    if (!this.perms.canInitiateVote) {
      throw new Error(`[VotingTools] Role "${this.agentRole}" cannot launch votes`)
    }
    const vote = await this.voting.launchVote(params.voteId)
    return `投票已发起，等待 ${vote.voters.length} 人投票`
  }

  // --- vote_cast ---
  async voteCast(params: VoteCastParams): Promise<string> {
    const vote = await this.voting.castVote(params.voteId, params.decision, params.comment)
    if (vote.status === 'resolved') {
      return `已投票: ${params.decision}\n投票已结束，结果: ${vote.result}`
    }
    return `已投票: ${params.decision}`
  }

  // --- vote_list ---
  async voteList(params: VoteListParams = {}): Promise<string> {
    const votes = params.status
      ? await this.voting.listVotesByStatus(params.status)
      : await this.voting.listPendingVotes()

    if (votes.length === 0) return '无匹配投票'

    return votes
      .map(v =>
        `- [${v.status}] ${v.topic} (${v.ballotCount ?? 0}/${v.voters.length} 已投) — ${v.voteId.slice(0, 8)}`
      )
      .join('\n')
  }

  // --- vote_detail ---
  async voteDetail(params: VoteDetailParams): Promise<string> {
    const vote = await this.voting.getVote(params.voteId)
    if (!vote) return '投票不存在'

    return [
      `投票: ${vote.topic}`,
      `ID: ${vote.voteId}`,
      `类型: ${vote.type}`,
      `状态: ${vote.status}`,
      `发起人: ${vote.initiator} (${vote.initiatorRole})`,
      `描述: ${vote.description}`,
      `投票人: ${vote.voters.join(', ')}`,
      `阈值: ${vote.threshold.type}${vote.threshold.percentage ? ` (${vote.threshold.percentage}%)` : ''}`,
      `创建时间: ${vote.createdAt}`,
      `截止时间: ${vote.expiresAt}`,
      vote.resolvedAt ? `决议时间: ${vote.resolvedAt}` : '',
      vote.result ? `结果: ${vote.result}` : '',
      `已投票数: ${vote.ballotCount ?? 0}/${vote.voters.length}`,
    ].filter(Boolean).join('\n')
  }

  // --- vote_cancel ---
  async voteCancel(params: VoteCancelParams): Promise<string> {
    const vote = await this.voting.cancelVote(params.voteId, params.reason)
    return `投票已取消: ${vote.voteId}`
  }

  // --- vote_rollback ---
  async voteRollback(params: VoteRollbackParams): Promise<string> {
    if (!this.perms.canInitiateVote) {
      throw new Error(`[VotingTools] Role "${this.agentRole}" cannot rollback votes`)
    }
    const vote = await this.voting.rollbackVote(params.voteId, {
      reason: params.reason,
      rollbackTo: params.rollbackTo,
    })
    return `投票已打回: ${vote.voteId} → ${params.rollbackTo}`
  }

  // --- team_members ---
  async teamMembers(): Promise<string> {
    const members = this.getTeamMembers?.() ?? []
    if (members.length === 0) return '暂无团队成员'
    return members
      .map(m => `- ${m.name} (${m.agentId}) — ${m.role}`)
      .join('\n')
  }

  // --- my_permissions ---
  myPermissions(): string {
    const p = this.perms
    return [
      `角色: ${this.agentRole}`,
      `创建任务: ${p.canCreateTask ? '✅' : '❌'}`,
      `分解任务: ${p.canDecomposeTask ? '✅' : '❌'}`,
      `发起投票: ${p.canInitiateVote ? '✅' : '❌'}`,
      `执行任务: ${p.canExecuteTask ? '✅' : '❌'}`,
      `代码评审: ${p.canReviewCode ? '✅' : '❌'}`,
      `审批上线: ${p.canApproveRelease ? '✅' : '❌'}`,
      `管理团队: ${p.canManageTeam ? '✅' : '❌'}`,
    ].join('\n')
  }
}
