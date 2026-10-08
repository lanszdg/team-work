import type { MessageDispatcher } from './messageDispatcher.js'
import type {
  TaskAcknowledgedMessage,
  TaskClaimedMessage,
  TaskCompletedMessage,
  TaskFailedMessage,
  TaskStatusUpdateMessage,
  TaskSubmittedForReviewMessage,
} from './messageTypes.js'

export type TaskLifecycleNotificationPayload =
  | TaskAcknowledgedMessage
  | TaskClaimedMessage
  | TaskStatusUpdateMessage
  | TaskSubmittedForReviewMessage
  | TaskCompletedMessage
  | TaskFailedMessage

export interface SendLifecycleNotificationParams {
  toAgentId: string
  toAgentName?: string
  payload: TaskLifecycleNotificationPayload
}

export async function sendLifecycleNotification(
  dispatcher: MessageDispatcher,
  params: SendLifecycleNotificationParams,
): Promise<boolean> {
  const payload = {
    fromAgentName: dispatcher.getSenderAgentName(),
    ...params.payload,
    fromAgentId: params.payload.fromAgentId || dispatcher.getSenderAgentId(),
  }

  return dispatcher.sendMessage(
    params.toAgentId,
    params.toAgentName ?? params.toAgentId,
    payload,
  )
}
