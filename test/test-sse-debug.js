/**
 * Debug: SSE delivery with direct CloudMessageRouter instances.
 */

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { CloudMessageRouter } from '../dist/core/cloudMessageRouter.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

function makeRouterPair(testName) {
  const repo = `sse-debug-${testName}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
  const listener = new CloudMessageRouter({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    repo,
    developerId: 'dev-listener',
  })
  const sender = new CloudMessageRouter({
    apiUrl: SERVER_URL,
    apiKey: API_KEY,
    repo,
    developerId: 'dev-sender',
  })
  return { listener, sender, repo }
}

function makeMessage(overrides = {}) {
  const ts = Date.now()
  return {
    messageId: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'idle_notification',
    from: 'sender',
    to: 'receiver',
    text: JSON.stringify({ test: true }),
    timestamp: new Date(ts).toISOString(),
    teamName: 'test-team',
    ...overrides,
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

describe('SSE debug', () => {
  test('SSE delivers events across two router instances on same repo', async () => {
    const { listener, sender, repo } = makeRouterPair('basic')

    const received = []

    console.error(`[DEBUG] Starting SSE listener on repo=${repo}`)

    // Start listening
    await Promise.race([
      listener.startListening({
        onMessage: (msg) => {
          console.error(`[DEBUG] SSE callback fired: type=${msg.type}, id=${msg.messageId}`)
          received.push(msg)
        },
      }),
      new Promise(r => setTimeout(r, 10000)),
    ])

    console.error(`[DEBUG] Listener started, waiting 1s...`)
    await sleep(1000)

    // Send message
    const msg = makeMessage({ type: 'code_review_submission', text: JSON.stringify({ requestId: 'test-1', branchName: 'feature/x' }) })
    console.error(`[DEBUG] Sending message id=${msg.messageId}`)
    const sendResult = await sender.sendMessage(msg)
    console.error(`[DEBUG] Send result: ${sendResult}`)

    // Wait for SSE delivery
    await sleep(3000)

    console.error(`[DEBUG] Received ${received.length} messages`)

    listener.disconnectSSE()

    assert.strictEqual(received.length, 1, 'Should receive 1 message via SSE')
    assert.strictEqual(received[0].messageId, msg.messageId)
  })
})
