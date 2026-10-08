/**
 * Idle Notification Message Types
 *
 * Extracted from messageTypes.ts to keep file under 500 lines.
 */

import { z } from 'zod'

/**
 * Sent when a teammate becomes idle (via Stop hook).
 * Notifies the team leader that the agent is available for new tasks.
 */
export interface IdleNotificationMessage {
  type: 'idle_notification'
  from: string
  timestamp: string
  /** Why the agent went idle */
  idleReason?: 'available' | 'interrupted' | 'failed'
  /** Brief summary of the last DM sent this turn */
  summary?: string
  completedTaskId?: string
  completedStatus?: 'resolved' | 'blocked' | 'failed'
  failureReason?: string
}

export const IdleNotificationSchema = z.object({
  type: z.literal('idle_notification'),
  from: z.string(),
  timestamp: z.string(),
  idleReason: z.enum(['available', 'interrupted', 'failed']).optional(),
  summary: z.string().optional(),
  completedTaskId: z.string().optional(),
  completedStatus: z.enum(['resolved', 'blocked', 'failed']).optional(),
  failureReason: z.string().optional(),
})

export function createIdleNotification(
  agentName: string,
  options?: {
    idleReason?: IdleNotificationMessage['idleReason']
    summary?: string
    completedTaskId?: string
    completedStatus?: IdleNotificationMessage['completedStatus']
    failureReason?: string
  },
): IdleNotificationMessage {
  return {
    type: 'idle_notification',
    from: agentName,
    timestamp: new Date().toISOString(),
    idleReason: options?.idleReason,
    summary: options?.summary,
    completedTaskId: options?.completedTaskId,
    completedStatus: options?.completedStatus,
    failureReason: options?.failureReason,
  }
}
