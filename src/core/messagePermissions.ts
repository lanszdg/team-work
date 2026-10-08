import type { TeamRole, RolePermissions } from './types.js'
import { ROLE_PERMISSIONS } from './types.js'
import { looksLikeProtocolMessage } from './messageTypes.js'

type PermissionKey = keyof RolePermissions

const MESSAGE_TYPE_PERMISSIONS: Record<string, PermissionKey> = {
  task_assignment: 'canCreateTask',
  plan_approval_response: 'canApproveRelease',
  code_review_response: 'canReviewCode',
  code_review_submission: 'canReviewCode',
  shutdown_request: 'canManageTeam',
  team_permission_update: 'canManageTeam',
  mode_set_request: 'canManageTeam',
  merge_request: 'canReviewCode',
  merge_response: 'canApproveRelease',
  task_acknowledged: 'canExecuteTask',
  task_claimed: 'canExecuteTask',
  task_status_update: 'canExecuteTask',
  task_submitted_for_review: 'canExecuteTask',
  task_completed: 'canCompleteTask',
  task_failed: 'canExecuteTask',
}

export interface PermissionCheckResult {
  allowed: boolean
  requiredPermission?: PermissionKey
  role: TeamRole
  messageType: string
  denyReason?: string
}

export function checkMessagePermission(
  role: TeamRole,
  messageType: string,
  rawMessageText?: string,
): PermissionCheckResult {
  const requiredPermission = MESSAGE_TYPE_PERMISSIONS[messageType]

  if (!requiredPermission) {
    if (rawMessageText && looksLikeProtocolMessage(rawMessageText)) {
      return {
        allowed: false,
        role,
        messageType,
        denyReason: 'unregistered protocol message type',
      }
    }
    return { allowed: true, role, messageType }
  }

  const permissions = ROLE_PERMISSIONS[role]
  if (!permissions) {
    return { allowed: false, requiredPermission, role, messageType }
  }

  return {
    allowed: permissions[requiredPermission],
    requiredPermission,
    role,
    messageType,
  }
}

export function getRequiredPermission(messageType: string): PermissionKey | undefined {
  return MESSAGE_TYPE_PERMISSIONS[messageType]
}
