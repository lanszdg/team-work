/**
 * Tests for dist/hooks/inboxPoller.js (v3.6 — Pure Cloud)
 *
 * Rewritten to use CloudMessageRouter mock instead of deleted mailbox.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InboxPoller } from '../dist/hooks/inboxPoller.js'

/**
 * Creates a fake CloudMessageRouter for testing.
 */
function createMockRouter(messages = []) {
  return {
    pollMessages: async () => messages,
    pollTasksFromKV: async () => [],
  }
}

describe('InboxPoller', () => {
  it('initializes with default interval', () => {
    const poller = new InboxPoller(
      { agentName: 'test-agent', teamName: 'test-team', cloudRouter: createMockRouter() },
      {},
    )
    poller.stop()
    assert.equal(poller.running, false)
  })

  it('start / stop / running getter', () => {
    const poller = new InboxPoller(
      { agentName: 'test-agent', teamName: 'test-team', intervalMs: 999999, cloudRouter: createMockRouter() },
      {},
    )
    assert.equal(poller.running, false)
    poller.start()
    assert.equal(poller.running, true)
    poller.stop()
    assert.equal(poller.running, false)
  })

  it('start is idempotent', () => {
    const poller = new InboxPoller(
      { agentName: 'test-agent', teamName: 'test-team', intervalMs: 999999, cloudRouter: createMockRouter() },
      {},
    )
    poller.start()
    poller.start()
    assert.equal(poller.running, true)
    poller.stop()
  })
})

describe('InboxPoller.pollOnce (cloud)', () => {
  it('reads SSE messages and calls onRegularMessage callback', async () => {
    const regularMessages = []

    const mockRouter = createMockRouter([
      {
        messageId: 'msg-1',
        type: 'task',
        from: 'sender',
        to: 'poll-target',
        text: 'Hello world',
        timestamp: new Date().toISOString(),
        teamName: 'poll-team',
      },
    ])

    const poller = new InboxPoller(
      { agentName: 'poll-target', teamName: 'poll-team', intervalMs: 999999, cloudRouter: mockRouter },
      {
        onRegularMessage: (msg) => regularMessages.push(msg),
        onProtocolMessage: () => assert.fail('Should not call onProtocolMessage for plain text'),
      },
    )

    await poller.pollOnce()
    assert.equal(regularMessages.length, 1)
    assert.equal(regularMessages[0].text, 'Hello world')
    assert.equal(regularMessages[0].from, 'sender')

    poller.stop()
  })

  it('routes structured protocol messages to onProtocolMessage callback', async () => {
    const protocolMessages = []
    const regularMessages = []

    const mockRouter = createMockRouter([
      {
        messageId: 'msg-2',
        type: 'task',
        from: 'sender',
        to: 'poll-target2',
        text: JSON.stringify({
          type: 'permission_request',
          request_id: 'req-1',
          agent_id: 'w1',
          tool_name: 'Bash',
          tool_use_id: 'u1',
          description: 'test',
          input: {},
          permission_suggestions: [],
        }),
        timestamp: new Date().toISOString(),
        teamName: 'poll-team2',
      },
    ])

    const poller = new InboxPoller(
      { agentName: 'poll-target2', teamName: 'poll-team2', intervalMs: 999999, cloudRouter: mockRouter },
      {
        onProtocolMessage: (parsed, raw) => protocolMessages.push({ parsed, raw }),
        onRegularMessage: (msg) => regularMessages.push(msg),
      },
    )

    await poller.pollOnce()
    assert.equal(protocolMessages.length, 1)
    assert.equal(protocolMessages[0].parsed.type, 'permission_request')
    assert.equal(protocolMessages[0].parsed.request_id, 'req-1')
    assert.equal(regularMessages.length, 0)

    poller.stop()
  })

  it('calls onError callback when handler throws', async () => {
    const errors = []

    const mockRouter = createMockRouter([
      {
        messageId: 'msg-3',
        type: 'task',
        from: 'sender',
        to: 'poll-target3',
        text: 'Trigger error',
        timestamp: new Date().toISOString(),
        teamName: 'poll-team3',
      },
    ])

    const poller = new InboxPoller(
      { agentName: 'poll-target3', teamName: 'poll-team3', intervalMs: 999999, cloudRouter: mockRouter },
      {
        onRegularMessage: () => {
          throw new Error('Handler error')
        },
        onError: (err) => errors.push(err),
      },
    )

    await poller.pollOnce()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, 'Handler error')

    poller.stop()
  })

  it('handles empty poll gracefully', async () => {
    const regularMessages = []

    const poller = new InboxPoller(
      { agentName: 'poll-target4', teamName: 'poll-team4', intervalMs: 999999, cloudRouter: createMockRouter([]) },
      {
        onRegularMessage: (msg) => regularMessages.push(msg),
      },
    )

    await poller.pollOnce()
    assert.equal(regularMessages.length, 0)

    poller.stop()
  })

  it('routes vote events to onVoteEvent callback', async () => {
    const voteEvents = []

    const mockRouter = createMockRouter([
      {
        messageId: 'vote-msg-1',
        type: 'vote_resolved',
        from: 'initiator',
        to: 'poll-target5',
        text: JSON.stringify({
          voteId: 'abc-123',
          vote: { voteId: 'abc-123', topic: 'Test vote', status: 'resolved' },
        }),
        timestamp: new Date().toISOString(),
        teamName: 'poll-team5',
      },
    ])

    const poller = new InboxPoller(
      { agentName: 'poll-target5', teamName: 'poll-team5', intervalMs: 999999, cloudRouter: mockRouter },
      {
        onVoteEvent: (event) => voteEvents.push(event),
      },
    )

    await poller.pollOnce()
    assert.equal(voteEvents.length, 1)
    assert.equal(voteEvents[0].type, 'vote_resolved')
    assert.equal(voteEvents[0].voteId, 'abc-123')

    poller.stop()
  })

  it('reports error for vote event with missing voteId payload', async () => {
    const errors = []

    const mockRouter = createMockRouter([
      {
        messageId: 'vote-msg-2',
        type: 'vote_resolved',
        from: 'initiator',
        to: 'poll-target6',
        text: 'not-json',
        timestamp: new Date().toISOString(),
        teamName: 'poll-team6',
      },
    ])

    const poller = new InboxPoller(
      { agentName: 'poll-target6', teamName: 'poll-team6', intervalMs: 999999, cloudRouter: mockRouter },
      {
        onVoteEvent: () => assert.fail('Should not call onVoteEvent without valid voteId'),
        onError: (err) => errors.push(err),
      },
    )

    await poller.pollOnce()
    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('no valid voteId'))

    poller.stop()
  })
})
