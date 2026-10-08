/**
 * Tests for dist/hooks/permissionBridge.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv } from './utils.js'
import {
  sendPermissionRequest,
  sendPermissionResponse,
  findPendingPermissionRequests,
  autoRespondToPermissionRequests,
} from '../dist/hooks/permissionBridge.js'
import { readMailbox, readUnreadMessages } from '../dist/core/mailbox.js'
import { createTeam, addMember } from '../dist/core/teamFile.js'

function makeContext() {
  const ctx = {
    teamName: 'perm-team',
    leaderName: 'team-lead',
    workerName: 'worker-1',
  }
  // sendPermissionRequest/Response don't pass teamName to writeToMailbox,
  // so they fall back to CLAUDE_CODE_TEAM_NAME env var.
  process.env.CLAUDE_CODE_TEAM_NAME = ctx.teamName
  return ctx
}

describe('sendPermissionRequest', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('writes permission request to leader inbox', async () => {
    const ctx = makeContext()
    await sendPermissionRequest(ctx, {
      request_id: 'req-1',
      agent_id: 'worker-1@perm-team',
      tool_name: 'Bash',
      tool_use_id: 'use-1',
      description: 'Run tests',
      input: { command: 'npm test' },
      permission_suggestions: [],
    })

    const messages = await readMailbox(ctx.leaderName, ctx.teamName)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].from, 'worker-1')
    assert.equal(messages[0].read, false)

    const parsed = JSON.parse(messages[0].text)
    assert.equal(parsed.type, 'permission_request')
    assert.equal(parsed.request_id, 'req-1')
    assert.equal(parsed.tool_name, 'Bash')
    assert.equal(parsed.tool_use_id, 'use-1')
    assert.equal(parsed.description, 'Run tests')
    assert.deepStrictEqual(parsed.input, { command: 'npm test' })
    assert.deepStrictEqual(parsed.permission_suggestions, [])
  })
})

describe('sendPermissionResponse', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('writes success response to worker inbox', async () => {
    const ctx = makeContext()
    await sendPermissionResponse(ctx, {
      request_id: 'req-1',
      subtype: 'success',
      updated_input: { command: 'npm run test' },
    })

    const messages = await readMailbox(ctx.workerName, ctx.teamName)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].from, 'team-lead')

    const parsed = JSON.parse(messages[0].text)
    assert.equal(parsed.type, 'permission_response')
    assert.equal(parsed.subtype, 'success')
    assert.equal(parsed.request_id, 'req-1')
    assert.deepStrictEqual(parsed.response.updated_input, { command: 'npm run test' })
  })

  it('writes error response to worker inbox', async () => {
    const ctx = makeContext()
    await sendPermissionResponse(ctx, {
      request_id: 'req-2',
      subtype: 'error',
      error: 'Tool Bash not permitted',
    })

    const messages = await readMailbox(ctx.workerName, ctx.teamName)
    assert.equal(messages.length, 1)

    const parsed = JSON.parse(messages[0].text)
    assert.equal(parsed.subtype, 'error')
    assert.equal(parsed.error, 'Tool Bash not permitted')
  })
})

describe('findPendingPermissionRequests', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('finds pending permission requests in leader inbox', async () => {
    const ctx = makeContext()

    // Write a permission request
    await sendPermissionRequest(ctx, {
      request_id: 'req-find',
      agent_id: 'w1@perm',
      tool_name: 'Read',
      tool_use_id: 'u1',
      description: 'Read file',
      input: { path: '/etc/hosts' },
    })

    // Write a non-permission message (should be ignored)
    const { writeToMailbox } = await import('../dist/core/mailbox.js')
    await writeToMailbox(ctx.leaderName, {
      from: 'w1',
      text: 'Just a regular message',
      timestamp: new Date().toISOString(),
    }, ctx.teamName)

    const requests = await findPendingPermissionRequests(ctx)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].request.request_id, 'req-find')
    assert.equal(requests[0].request.tool_name, 'Read')
  })

  it('returns empty array when no pending requests', async () => {
    const ctx = makeContext()
    const requests = await findPendingPermissionRequests(ctx)
    assert.deepStrictEqual(requests, [])
  })
})

describe('autoRespondToPermissionRequests', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('auto-approves allowed tools', async () => {
    const ctx = makeContext()

    await sendPermissionRequest(ctx, {
      request_id: 'req-allow',
      agent_id: 'w1@ar',
      tool_name: 'Read',
      tool_use_id: 'u1',
      description: 'Read file',
      input: { path: '/tmp/test' },
    })

    const responded = await autoRespondToPermissionRequests(ctx, {
      alwaysAllow: ['Read'],
    })

    assert.equal(responded, 1)

    // Verify the response was written to worker inbox
    const responses = await readMailbox(ctx.workerName, ctx.teamName)
    assert.equal(responses.length, 1)
    const parsed = JSON.parse(responses[0].text)
    assert.equal(parsed.subtype, 'success')
    assert.equal(parsed.request_id, 'req-allow')
  })

  it('auto-denies denied tools', async () => {
    const ctx = makeContext()

    await sendPermissionRequest(ctx, {
      request_id: 'req-deny',
      agent_id: 'w1@ar',
      tool_name: 'Bash',
      tool_use_id: 'u2',
      description: 'Execute command',
      input: { command: 'rm -rf /' },
    })

    const responded = await autoRespondToPermissionRequests(ctx, {
      alwaysDeny: ['Bash'],
    })

    assert.equal(responded, 1)

    const responses = await readMailbox(ctx.workerName, ctx.teamName)
    assert.equal(responses.length, 1)
    const parsed = JSON.parse(responses[0].text)
    assert.equal(parsed.subtype, 'error')
    assert.ok(parsed.error.includes('Bash'))
  })

  it('uses defaultAction for unlisted tools', async () => {
    const ctx = makeContext()

    // Write two requests with different tools
    await sendPermissionRequest(ctx, {
      request_id: 'req-unlisted-1',
      agent_id: 'w1@ar',
      tool_name: 'Edit',
      tool_use_id: 'u3',
      description: 'Edit file',
      input: { path: '/tmp/test' },
    })

    // Default action is allow
    const respondedAllow = await autoRespondToPermissionRequests(ctx, {
      defaultAction: 'allow',
    })
    assert.equal(respondedAllow, 1)

    const responses = await readMailbox(ctx.workerName, ctx.teamName)
    const parsed = JSON.parse(responses[0].text)
    assert.equal(parsed.subtype, 'success')
  })

  it('uses defaultAction deny for unlisted tools', async () => {
    const ctx = makeContext()

    await sendPermissionRequest(ctx, {
      request_id: 'req-unlisted-2',
      agent_id: 'w1@ar',
      tool_name: 'Write',
      tool_use_id: 'u4',
      description: 'Write file',
      input: { path: '/tmp/test' },
    })

    const responded = await autoRespondToPermissionRequests(ctx, {
      defaultAction: 'deny',
    })

    assert.equal(responded, 1)
    const responses = await readMailbox(ctx.workerName, ctx.teamName)
    const parsed = JSON.parse(responses[0].text)
    assert.equal(parsed.subtype, 'error')
  })

  it('returns 0 when no pending requests', async () => {
    const ctx = makeContext()
    const responded = await autoRespondToPermissionRequests(ctx, {
      alwaysAllow: ['Read'],
    })
    assert.equal(responded, 0)
  })
})
