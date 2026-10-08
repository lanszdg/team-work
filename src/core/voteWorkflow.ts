/**
 * Vote Workflow — Voting triggers, pass/reject actions, notifications (v3.6 Phase 3.5)
 *
 * Connects CloudVoting to the rest of the system:
 * - VOTE_PASS_ACTIONS: what happens when a vote passes
 * - VOTE_REJECT_ACTIONS: what happens when a vote is rejected/rolled back
 * - notifyByRole / notifyAgent: send notifications to team members
 * - system-reminder format for Agent awareness
 */

import type { Vote, VoteType } from './cloudVotingTypes.js'
import type { TeamRole } from './types.js'
import type { MessageDispatcher } from './messageDispatcher.js'

// ============================================================
// Notification helpers
// ============================================================

async function notifyByRole(
  roles: TeamRole[],
  message: string,
  dispatcher: MessageDispatcher,
  getTeamMembers: () => Array<{ agentId: string; name: string; role: TeamRole }>,
): Promise<void> {
  const members = getTeamMembers()
  const targets = members.filter(m => roles.includes(m.role))
  for (const target of targets) {
    try {
      await dispatcher.sendMessage(target.agentId, target.name, {
        type: 'vote_notification',
        text: message,
      })
    } catch {
      // Notification is best-effort
    }
  }
}

async function notifyAgent(
  agentId: string,
  message: string,
  dispatcher: MessageDispatcher,
  getTeamMembers: () => Array<{ agentId: string; name: string; role: TeamRole }>,
): Promise<void> {
  const members = getTeamMembers()
  const target = members.find(m => m.agentId === agentId)
  if (!target) return
  try {
    await dispatcher.sendMessage(target.agentId, target.name, {
      type: 'vote_notification',
      text: message,
    })
  } catch {
    // Best-effort
  }
}

// ============================================================
// Vote pass actions
// ============================================================

export const VOTE_PASS_ACTIONS: Record<VoteType, (
  vote: Vote,
  ctx: VoteWorkflowContext,
) => Promise<void>> = {
  'task_decomposition': async (vote, ctx) => {
    // Parse subtasks from context
    let subtasks: { id: string }[]
    try {
      subtasks = JSON.parse(vote.context ?? '[]')
    } catch {
      console.warn(`[VoteWorkflow] Cannot parse vote context: ${vote.voteId}`)
      return
    }
    // Update kanban task statuses
    for (const task of subtasks) {
      try {
        ctx.updateTaskStatus?.(task.id, 'ready')
      } catch { /* best-effort */ }
    }
    await notifyByRole(
      ['developer', 'designer'],
      '任务分解已通过，请认领子任务',
      ctx.dispatcher,
      ctx.getTeamMembers,
    )
  },

  'release_approval': async (_vote, ctx) => {
    await notifyByRole(
      ['ops-engineer', 'tech-lead'],
      '上线审批已通过，请执行部署',
      ctx.dispatcher,
      ctx.getTeamMembers,
    )
  },

  'architecture_review': async (_vote, ctx) => {
    await notifyByRole(
      ['developer'],
      '架构方案已通过，可以开始编码',
      ctx.dispatcher,
      ctx.getTeamMembers,
    )
  },

  'hotfix_emergency': async (_vote, ctx) => {
    await notifyByRole(
      ['developer'],
      '紧急修复已授权，请立即处理',
      ctx.dispatcher,
      ctx.getTeamMembers,
    )
  },

  'custom': async () => {},
}

// ============================================================
// Vote reject / rollback actions
// ============================================================

export const VOTE_REJECT_ACTIONS: Record<VoteType, (
  vote: Vote,
  ctx: VoteWorkflowContext,
) => Promise<void>> = {
  'task_decomposition': async (vote, ctx) => {
    await notifyAgent(
      vote.initiator,
      `任务分解被打回: ${vote.rollbackInfo?.reason ?? '投票未通过'}`,
      ctx.dispatcher,
      ctx.getTeamMembers,
    )
  },

  'release_approval': async (vote, ctx) => {
    await notifyByRole(
      ['developer', 'qa-engineer'],
      `上线被打回: ${vote.rollbackInfo?.reason ?? '投票未通过'}. 请修复后重新提交.`,
      ctx.dispatcher,
      ctx.getTeamMembers,
    )
  },

  'architecture_review': async (vote, ctx) => {
    await notifyAgent(
      vote.initiator,
      `架构方案被打回: ${vote.rollbackInfo?.reason ?? '投票未通过'}`,
      ctx.dispatcher,
      ctx.getTeamMembers,
    )
  },

  'hotfix_emergency': async () => {},
  'custom': async () => {},
}

// ============================================================
// Context & system-reminder format
// ============================================================

export interface VoteWorkflowContext {
  dispatcher: MessageDispatcher
  getTeamMembers: () => Array<{ agentId: string; name: string; role: TeamRole }>
  updateTaskStatus?: (taskId: string, status: string) => void
}

/**
 * Formats a vote_request into a system-reminder string for Agent awareness.
 *
 * Path: Sync Server → SSE → CloudMessageRouter → InboxPoller → system-reminder
 */
export function formatVoteReminder(vote: Vote): string {
  return [
    `🗳️ 新投票: ${vote.topic}`,
    `  类型: ${vote.type}`,
    `  发起人: ${vote.initiator} (${vote.initiatorRole})`,
    `  截止: ${vote.expiresAt}`,
    `  使用 /vote cast ${vote.voteId} approve|reject 进行投票`,
  ].join('\n')
}

/**
 * Executes the appropriate action when a vote resolves.
 * Called by CloudVoting SSE listener or InboxPoller.
 */
export async function onVoteResolved(vote: Vote, ctx: VoteWorkflowContext): Promise<void> {
  if (vote.result === 'approved') {
    const action = VOTE_PASS_ACTIONS[vote.type]
    await action(vote, ctx)
  } else if (vote.result === 'rejected') {
    const action = VOTE_REJECT_ACTIONS[vote.type]
    await action(vote, ctx)
  }
}
