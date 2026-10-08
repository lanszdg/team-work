import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { CloudMessageRouter } from '../dist/core/cloudMessageRouter.js'
import { MessageDispatcher } from '../dist/core/messageDispatcher.js'
import { sendLifecycleNotification } from '../dist/core/lifecycleNotification.js'
import { createTaskStatusUpdate } from '../dist/core/messageTypes.js'

function makeRouter(developerId = 'receiver-1') {
  return new CloudMessageRouter({
    apiUrl: 'http://mock-sync-adapter.invalid',
    apiKey: 'mock-sync-adapter',
    repo: 'mock-sync-adapter-phase3',
    developerId,
  })
}

function makeDispatcher(overrides = {}) {
  return new MessageDispatcher({
    teamName: 'mock-sync-team',
    agentName: 'worker',
    agentId: 'worker-1',
    cloudConfig: {
      apiUrl: 'http://mock-sync-adapter.invalid',
      apiKey: 'mock-sync-adapter',
      developerId: 'worker-runtime',
    },
    ...overrides,
  })
}

describe('Phase 3 mock sync adapter boundary: CloudMessage envelope', () => {
  test('sendMessage persists fromAgentId/toAgentId into KV and SSE payloads', async () => {
    const router = makeRouter('sender-1')
    const pushed = []
    const events = []
    router.adapter = {
      push: async entries => {
        pushed.push(entries)
      },
      postEvent: async (event, payload) => {
        events.push({ event, payload })
      },
    }

    const sent = await router.sendMessage({
      messageId: 'm-envelope-send',
      type: 'task_status_update',
      from: 'worker',
      fromAgentId: 'worker-1',
      to: 'lead',
      toAgentId: 'lead-1',
      text: '{"type":"task_status_update"}',
      timestamp: '2026-01-01T00:00:00.000Z',
      teamName: 'mock-sync-team',
    })

    assert.strictEqual(sent, true)
    const kvValue = JSON.parse(pushed[0]['tasks/m-envelope-send'])
    assert.strictEqual(kvValue.fromAgentId, 'worker-1')
    assert.strictEqual(kvValue.toAgentId, 'lead-1')
    assert.strictEqual(events[0].event, 'task')
    assert.strictEqual(events[0].payload.fromAgentId, 'worker-1')
    assert.strictEqual(events[0].payload.toAgentId, 'lead-1')
  })

  test('pollTasksFromKV preserves envelope fields and filters by toAgentId', async () => {
    const router = makeRouter('lead-1')
    router.adapter = {
      pull: async () => ({
        entries: {
          'tasks/for-lead': JSON.stringify({
            messageId: 'for-lead',
            type: 'task_status_update',
            from: 'worker',
            fromAgentId: 'worker-1',
            to: 'lead',
            toAgentId: 'lead-1',
            text: '{"type":"task_status_update"}',
            timestamp: '2026-01-01T00:00:00.000Z',
            teamName: 'mock-sync-team',
          }),
          'tasks/for-other': JSON.stringify({
            messageId: 'for-other',
            type: 'task_status_update',
            from: 'worker',
            fromAgentId: 'worker-1',
            to: 'other',
            toAgentId: 'other-1',
            text: '{"type":"task_status_update"}',
            timestamp: '2026-01-01T00:00:00.000Z',
            teamName: 'mock-sync-team',
          }),
        },
      }),
    }

    const messages = await router.pollTasksFromKV()
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].messageId, 'for-lead')
    assert.strictEqual(messages[0].fromAgentId, 'worker-1')
    assert.strictEqual(messages[0].toAgentId, 'lead-1')
  })

  test('SSE callback preserves envelope fields from nested task event payload', async () => {
    const router = makeRouter('lead-1')
    const received = []
    const response = new Response(
      new ReadableStream({
        start(controller) {
          const frame =
            'event: task\nid: 7\ndata: {"data":{"messageId":"m-envelope-sse","type":"task_status_update","from":"worker","fromAgentId":"worker-1","to":"lead","toAgentId":"lead-1","text":"{\\"type\\":\\"task_status_update\\"}","timestamp":"2026-01-01T00:00:00Z","teamName":"mock-sync-team"}}\n\n'
          controller.enqueue(new TextEncoder().encode(frame))
          controller.close()
        },
      }),
      { status: 200 },
    )
    router.adapter = {
      connectSSE: async () => response,
    }

    await router.startListening({ onMessage: msg => received.push(msg) })
    await new Promise(r => setTimeout(r, 50))
    router.stopListening()

    assert.strictEqual(received.length, 1)
    assert.strictEqual(received[0].fromAgentId, 'worker-1')
    assert.strictEqual(received[0].toAgentId, 'lead-1')
  })
})

describe('Phase 3 mock sync adapter boundary: dispatcher and lifecycle helper', () => {
  test('dispatcher includes sender/recipient agent IDs in CloudMessage', async () => {
    const dispatcher = makeDispatcher()
    let captured = null
    dispatcher.cloudRouter = {
      sendMessage: async msg => {
        captured = msg
        return true
      },
    }

    await dispatcher.sendMessage('lead-1', 'lead', {
      messageId: 'dispatcher-envelope',
      type: 'task_status_update',
      text: JSON.stringify({ type: 'task_status_update', taskId: 'task-1' }),
    })

    assert.strictEqual(captured.from, 'worker')
    assert.strictEqual(captured.fromAgentId, 'worker-1')
    assert.strictEqual(captured.to, 'lead')
    assert.strictEqual(captured.toAgentId, 'lead-1')
  })

  test('dispatcher default-denies unregistered protocol JSON using raw text', async () => {
    const dispatcher = makeDispatcher({ senderRole: 'developer' })
    dispatcher.cloudRouter = {
      sendMessage: async () => true,
    }

    await assert.rejects(
      () => dispatcher.sendMessage('lead-1', 'lead', {
        messageId: 'unknown-protocol',
        type: 'unknown_protocol',
        text: JSON.stringify({ type: 'unknown_protocol', taskId: 'task-1' }),
      }),
      /unregistered protocol message type/,
    )
  })

  test('lifecycle helper sends typed JSON payload through dispatcher envelope', async () => {
    const dispatcher = makeDispatcher()
    let captured = null
    dispatcher.cloudRouter = {
      sendMessage: async msg => {
        captured = msg
        return true
      },
    }

    const sent = await sendLifecycleNotification(dispatcher, {
      toAgentId: 'lead-1',
      toAgentName: 'lead',
      payload: createTaskStatusUpdate({
        taskId: 'task-1',
        fromAgentId: 'worker-1',
        oldStatus: 'claimed',
        newStatus: 'in_progress',
      }),
    })

    assert.strictEqual(sent, true)
    assert.strictEqual(captured.type, 'task_status_update')
    assert.strictEqual(captured.toAgentId, 'lead-1')
    const parsed = JSON.parse(captured.text)
    assert.strictEqual(parsed.type, 'task_status_update')
    assert.strictEqual(parsed.taskId, 'task-1')
    assert.strictEqual(parsed.fromAgentId, 'worker-1')
    assert.strictEqual(parsed.fromAgentName, 'worker')
  })
})
