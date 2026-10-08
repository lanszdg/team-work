/**
 * Permission Request / Response Message Types
 *
 * Extracted from messageTypes.ts to keep file under 500 lines.
 */

import { z } from 'zod'

/**
 * Sent from worker to leader when a tool use requires permission approval.
 * Field names align with SDK `can_use_tool` (snake_case).
 */
export interface PermissionRequestMessage {
  type: 'permission_request'
  /** Unique identifier for this request */
  request_id: string
  /** Worker's agent ID */
  agent_id: string
  /** Tool being requested */
  tool_name: string
  /** Tool use invocation ID */
  tool_use_id: string
  /** Human-readable description of what the tool will do */
  description: string
  /** Tool input parameters */
  input: Record<string, unknown>
  /** Suggested permission rules */
  permission_suggestions: unknown[]
}

export const PermissionRequestSchema = z.object({
  type: z.literal('permission_request'),
  request_id: z.string(),
  agent_id: z.string(),
  tool_name: z.string(),
  tool_use_id: z.string(),
  description: z.string(),
  input: z.record(z.string(), z.unknown()),
  permission_suggestions: z.array(z.unknown()),
})

/**
 * Response from leader to worker for a permission request.
 * Either success (with optional input updates) or error (denied).
 */
export type PermissionResponseMessage =
  | {
      type: 'permission_response'
      request_id: string
      subtype: 'success'
      response?: {
        updated_input?: Record<string, unknown>
        permission_updates?: unknown[]
      }
    }
  | {
      type: 'permission_response'
      request_id: string
      subtype: 'error'
      error: string
    }

export const PermissionResponseSchema = z.discriminatedUnion('subtype', [
  z.object({
    type: z.literal('permission_response'),
    request_id: z.string(),
    subtype: z.literal('success'),
    response: z
      .object({
        updated_input: z.record(z.string(), z.unknown()).optional(),
        permission_updates: z.array(z.unknown()).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('permission_response'),
    request_id: z.string(),
    subtype: z.literal('error'),
    error: z.string(),
  }),
])

export function createPermissionResponse(params: {
  request_id: string
  subtype: 'success' | 'error'
  error?: string
  updated_input?: Record<string, unknown>
  permission_updates?: unknown[]
}): PermissionResponseMessage {
  if (params.subtype === 'error') {
    return {
      type: 'permission_response',
      request_id: params.request_id,
      subtype: 'error',
      error: params.error || 'Permission denied',
    }
  }
  return {
    type: 'permission_response',
    request_id: params.request_id,
    subtype: 'success',
    response: {
      updated_input: params.updated_input,
      permission_updates: params.permission_updates,
    },
  }
}
