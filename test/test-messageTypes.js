/**
 * Tests for dist/core/messageTypes.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv } from './utils.js'
import {
  createIdleNotification,
  createPermissionResponse,
  isStructuredProtocolMessage,
  looksLikeProtocolMessage,
  createTaskAcknowledged,
  createTaskClaimed,
  createTaskStatusUpdate,
  createTaskSubmittedForReview,
  createTaskCompleted,
  createTaskFailed,
} from '../dist/core/messageTypes.js'

describe('createIdleNotification', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('returns correct type, from, timestamp', () => {
    const msg = createIdleNotification('worker-1')
    assert.equal(msg.type, 'idle_notification')
    assert.equal(msg.from, 'worker-1')
    assert.ok(typeof msg.timestamp === 'string')
    assert.ok(!Number.isNaN(Date.parse(msg.timestamp)))
  })

  it('populates all optional fields when provided', () => {
    const msg = createIdleNotification('worker-1', {
      idleReason: 'interrupted',
      summary: 'Finished task xyz',
      completedTaskId: 'task-42',
      completedStatus: 'resolved',
      failureReason: undefined,
    })
    assert.equal(msg.idleReason, 'interrupted')
    assert.equal(msg.summary, 'Finished task xyz')
    assert.equal(msg.completedTaskId, 'task-42')
    assert.equal(msg.completedStatus, 'resolved')
    assert.equal(msg.failureReason, undefined)
  })

  it('sets failureReason when provided', () => {
    const msg = createIdleNotification('worker-1', {
      idleReason: 'failed',
      failureReason: 'Out of memory',
    })
    assert.equal(msg.idleReason, 'failed')
    assert.equal(msg.failureReason, 'Out of memory')
  })
})

describe('createPermissionResponse', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('returns success subtype with response', () => {
    const msg = createPermissionResponse({
      request_id: 'req-1',
      subtype: 'success',
      updated_input: { path: '/tmp' },
      permission_updates: [{ toolName: 'Edit' }],
    })
    assert.equal(msg.type, 'permission_response')
    assert.equal(msg.request_id, 'req-1')
    assert.equal(msg.subtype, 'success')
    assert.deepStrictEqual(msg.response, {
      updated_input: { path: '/tmp' },
      permission_updates: [{ toolName: 'Edit' }],
    })
  })

  it('returns success subtype without optional params', () => {
    const msg = createPermissionResponse({
      request_id: 'req-2',
      subtype: 'success',
    })
    assert.equal(msg.type, 'permission_response')
    assert.equal(msg.subtype, 'success')
    assert.deepStrictEqual(msg.response, {
      updated_input: undefined,
      permission_updates: undefined,
    })
  })

  it('returns error subtype with error message', () => {
    const msg = createPermissionResponse({
      request_id: 'req-3',
      subtype: 'error',
      error: 'Tool not allowed',
    })
    assert.equal(msg.type, 'permission_response')
    assert.equal(msg.subtype, 'error')
    assert.equal(msg.error, 'Tool not allowed')
  })

  it('uses default error message when none provided', () => {
    const msg = createPermissionResponse({
      request_id: 'req-4',
      subtype: 'error',
    })
    assert.equal(msg.error, 'Permission denied')
  })
})

describe('isStructuredProtocolMessage', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('returns true for permission_request', () => {
    const msg = JSON.stringify({
      type: 'permission_request',
      request_id: 'req-1',
      agent_id: 'w1',
      tool_name: 'Bash',
      tool_use_id: 'u1',
      description: 'run cmd',
      input: {},
      permission_suggestions: [],
    })
    assert.equal(isStructuredProtocolMessage(msg), true)
  })

  it('returns true for sandbox_permission_request', () => {
    const msg = JSON.stringify({
      type: 'sandbox_permission_request',
      requestId: 'req-2',
      workerId: 'w1',
      workerName: 'worker',
      hostPattern: { host: 'example.com' },
      createdAt: Date.now(),
    })
    assert.equal(isStructuredProtocolMessage(msg), true)
  })

  it('returns true for shutdown_request', () => {
    const msg = JSON.stringify({
      type: 'shutdown_request',
      requestId: 'req-3',
      from: 'lead',
      timestamp: new Date().toISOString(),
    })
    assert.equal(isStructuredProtocolMessage(msg), true)
  })

  it('returns true for other structured types', () => {
    const types = [
      'permission_response',
      'sandbox_permission_response',
      'shutdown_approved',
      'shutdown_rejected',
      'team_permission_update',
      'mode_set_request',
      'plan_approval_request',
      'plan_approval_response',
    ]
    for (const t of types) {
      const msg = JSON.stringify({ type: t })
      assert.equal(isStructuredProtocolMessage(msg), true, `Expected true for type: ${t}`)
    }
  })

  it('returns false for plain text', () => {
    assert.equal(isStructuredProtocolMessage('Hello world'), false)
  })

  it('returns false for empty string', () => {
    assert.equal(isStructuredProtocolMessage(''), false)
  })

  it('returns false for invalid JSON', () => {
    assert.equal(isStructuredProtocolMessage('{not valid json'), false)
  })

  it('returns false for messages without type field', () => {
    const msg = JSON.stringify({ from: 'worker', text: 'hello' })
    assert.equal(isStructuredProtocolMessage(msg), false)
  })

  it('returns true for idle_notification (in STRUCTURED_PROTOCOL_TYPES)', () => {
    const msg = JSON.stringify({
      type: 'idle_notification',
      from: 'worker',
      timestamp: new Date().toISOString(),
    })
    assert.equal(isStructuredProtocolMessage(msg), true)
  })

  it('returns true for task lifecycle protocol messages', () => {
    const messages = [
      createTaskAcknowledged({ taskId: 'task-1', fromAgentId: 'worker-1', fromAgentName: 'Worker 1' }),
      createTaskClaimed({
        taskId: 'task-1',
        fromAgentId: 'worker-1',
        agentRole: 'developer',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      createTaskStatusUpdate({
        taskId: 'task-1',
        fromAgentId: 'worker-1',
        oldStatus: 'claimed',
        newStatus: 'in_progress',
      }),
      createTaskSubmittedForReview({
        taskId: 'task-1',
        fromAgentId: 'worker-1',
        artifacts: [{ type: 'file', value: 'src/core/taskStore.ts' }],
      }),
      createTaskCompleted({ taskId: 'task-1', fromAgentId: 'lead-1' }),
      createTaskFailed({ taskId: 'task-1', fromAgentId: 'worker-1', reason: 'tests failed' }),
    ]

    for (const message of messages) {
      assert.equal(isStructuredProtocolMessage(JSON.stringify(message)), true, message.type)
      assert.ok(typeof message.timestamp === 'string')
    }
  })
})

describe('looksLikeProtocolMessage', () => {
  it('returns true for any JSON object with a string type', () => {
    assert.equal(
      looksLikeProtocolMessage(JSON.stringify({ type: 'unknown_protocol', payload: true })),
      true,
    )
  })

  it('returns false for plain text and non-protocol JSON', () => {
    assert.equal(looksLikeProtocolMessage('hello'), false)
    assert.equal(looksLikeProtocolMessage(JSON.stringify({ hello: 'world' })), false)
    assert.equal(looksLikeProtocolMessage(JSON.stringify({ type: 42 })), false)
  })
})
