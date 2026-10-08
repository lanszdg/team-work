/**
 * Permission Bridge Module
 *
 * Handles permission request/response flow between workers and team leader.
 * Workers send permission requests via cloud, leader responds via cloud.
 *
 * Extracted from open-claude-code permission bridge logic.
 */

import { MessageDispatcher } from '../core/messageDispatcher.js'
import {
  createPermissionResponse,
  PermissionRequestMessage,
  PermissionResponseMessage,
} from '../core/messageTypes.js'

import type { CloudMessage } from '../core/messageDispatcher.js'

interface PermissionContext {
  /** Team name */
  teamName: string
  /** Leader's agent name (recipient of requests) */
  leaderName: string
  /** Worker's agent name (sender of requests) */
  workerName: string
}

/**
 * Sends a permission request from worker to team leader.
 */
export async function sendPermissionRequest(
  context: PermissionContext,
  params: {
    request_id: string
    agent_id: string
    tool_name: string
    tool_use_id: string
    description: string
    input: Record<string, unknown>
    permission_suggestions?: unknown[]
  },
): Promise<void> {
  const request: PermissionRequestMessage = {
    type: 'permission_request',
    request_id: params.request_id,
    agent_id: params.agent_id,
    tool_name: params.tool_name,
    tool_use_id: params.tool_use_id,
    description: params.description,
    input: params.input,
    permission_suggestions: params.permission_suggestions || [],
  }

  await new MessageDispatcher({
    teamName: context.teamName,
    agentName: context.workerName,
    cloudConfig: {
      apiUrl: process.env.TEAM_MEMORY_SYNC_URL || '',
      apiKey: process.env.TEAM_MEMORY_SYNC_API_KEY || '',
      developerId: process.env.CLAUDE_CODE_AGENT_ID || context.workerName,
    },
  }).sendMessage(context.leaderName, context.leaderName, {
    from: context.workerName,
    text: JSON.stringify(request),
    timestamp: new Date().toISOString(),
    type: 'permission_request',
  })
}

/**
 * Sends a permission response from leader to worker.
 */
export async function sendPermissionResponse(
  context: PermissionContext,
  params: {
    request_id: string
    subtype: 'success' | 'error'
    error?: string
    updated_input?: Record<string, unknown>
    permission_updates?: unknown[]
  },
): Promise<void> {
  const response = createPermissionResponse(params)

  await new MessageDispatcher({
    teamName: context.teamName,
    agentName: context.leaderName,
    cloudConfig: {
      apiUrl: process.env.TEAM_MEMORY_SYNC_URL || '',
      apiKey: process.env.TEAM_MEMORY_SYNC_API_KEY || '',
      developerId: process.env.CLAUDE_CODE_AGENT_ID || context.leaderName,
    },
  }).sendMessage(context.workerName, context.workerName, {
    from: context.leaderName,
    text: JSON.stringify(response),
    timestamp: new Date().toISOString(),
    type: 'permission_response',
  })
}

/**
 * Scans the leader's inbox for pending permission requests.
 * Returns parsed requests with their message index for response routing.
 */
export async function findPendingPermissionRequests(
  context: PermissionContext,
): Promise<Array<{ request: PermissionRequestMessage; message: CloudMessage }>> {
  const dispatcher = new MessageDispatcher({
    teamName: context.teamName,
    agentName: context.leaderName,
    cloudConfig: {
      apiUrl: process.env.TEAM_MEMORY_SYNC_URL || '',
      apiKey: process.env.TEAM_MEMORY_SYNC_API_KEY || '',
      developerId: process.env.CLAUDE_CODE_AGENT_ID || context.leaderName,
    },
  })
  const messages = await dispatcher.receiveMessages()

  const requests: Array<{ request: PermissionRequestMessage; message: CloudMessage }> = []

  for (const msg of messages) {
    if (!msg) continue

    try {
      const parsed = JSON.parse(msg.text) as PermissionRequestMessage
      if (parsed.type === 'permission_request') {
        requests.push({ request: parsed, message: msg })
      }
    } catch {
      // Not a permission request
    }
  }

  return requests
}

/**
 * Auto-responds to permission requests based on a rule set.
 * This is a simple auto-approval handler that can be extended.
 */
export async function autoRespondToPermissionRequests(
  context: PermissionContext,
  rules: {
    /** Tools that are always allowed */
    alwaysAllow?: string[]
    /** Tools that are always denied */
    alwaysDeny?: string[]
    /** Default behavior for unlisted tools */
    defaultAction?: 'allow' | 'deny'
  } = {},
): Promise<number> {
  const requests = await findPendingPermissionRequests(context)
  let responded = 0

  for (const { request } of requests) {
    let shouldAllow = false

    if (rules.alwaysAllow?.includes(request.tool_name)) {
      shouldAllow = true
    } else if (rules.alwaysDeny?.includes(request.tool_name)) {
      shouldAllow = false
    } else {
      shouldAllow = rules.defaultAction === 'allow'
    }

    if (shouldAllow) {
      await sendPermissionResponse(context, {
        request_id: request.request_id,
        subtype: 'success',
      })
    } else {
      await sendPermissionResponse(context, {
        request_id: request.request_id,
        subtype: 'error',
        error: `Tool "${request.tool_name}" is not permitted for this worker.`,
      })
    }

    // Mark all messages as read after processing
    // (In production, use message IDs for selective marking)

    responded++
  }

  return responded
}
