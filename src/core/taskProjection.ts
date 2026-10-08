import type { TeamTask, TaskStatus } from './types.js'

export type AgentWorkState = 'idle' | 'claimed' | 'in_progress' | 'review'

export interface AgentTaskProjection {
  agentId: string
  workState: AgentWorkState
  currentTaskId?: string
  currentTaskTitle?: string
  taskStatus?: TaskStatus
}

const ACTIVE_STATUS_PRIORITY: TaskStatus[] = ['in_progress', 'claimed', 'review']

export function projectAgentTaskState(
  tasks: TeamTask[],
  agentId: string,
): AgentTaskProjection {
  const active = [...tasks]
    .filter(task => task.claimedByAgentId === agentId)
    .filter(task => ACTIVE_STATUS_PRIORITY.includes(task.status))
    .sort((a, b) => {
      const byStatus = ACTIVE_STATUS_PRIORITY.indexOf(a.status) - ACTIVE_STATUS_PRIORITY.indexOf(b.status)
      if (byStatus !== 0) return byStatus
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    })[0]

  if (!active) {
    return { agentId, workState: 'idle' }
  }

  return {
    agentId,
    workState: active.status as AgentWorkState,
    currentTaskId: active.taskId,
    currentTaskTitle: active.title,
    taskStatus: active.status,
  }
}

export function projectAllAgentTaskStates(tasks: TeamTask[]): Map<string, AgentTaskProjection> {
  const agentIds = new Set(
    tasks
      .map(task => task.claimedByAgentId)
      .filter((agentId): agentId is string => Boolean(agentId)),
  )

  return new Map(
    Array.from(agentIds).map(agentId => [agentId, projectAgentTaskState(tasks, agentId)]),
  )
}
