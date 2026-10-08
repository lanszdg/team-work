/**
 * Test: CloudPlanApproval against the REAL deployed sync server.
 *
 * Validates:
 *   T1: submitPlan() - sends plan_approval_request via cloud - {ok:true}
 *   T2: Plan request delivered via SSE to leader within 3s
 *   T3: approvePlan() - sends plan_approval_response(approved=true) - delivered to teammate
 *   T4: rejectPlan() - sends plan_approval_response(approved=false, feedback) - delivered
 *   T5: Plan state tracking: pending to approved/rejected
 *   T6: Integration: Teammate submits - Leader receives - approves - Teammate receives confirmation
 *
 * Run with: node --test test/test-cloudPlanApproval.js
 */

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { CloudPlanApproval } from '../dist/core/cloudPlanApproval.js'
import { SyncServerAdapter } from '../dist/core/syncServerAdapter.js'
import { MessageDispatcher } from '../dist/core/messageDispatcher.js'

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

// ============================================================
// Test helpers
// ============================================================

/** Generate a unique identifier to avoid collisions between test runs. */
function uid(prefix = 'test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/** Create a MessageDispatcher with cloud config. */
function makeDispatcher(teamName, agentId, agentName) {
  const dispatcher = new MessageDispatcher({
    teamName,
    agentName,
    cloudConfig: {
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      developerId: agentId,
    },
  })
  return { dispatcher }
}

/** Create a CloudPlanApproval instance with a fresh dispatcher. */
function makePlanApproval(teamName, agentId, agentName) {
  const { dispatcher } = makeDispatcher(teamName, agentId, agentName)
  return new CloudPlanApproval({
    dispatcher,
    teamName,
    agentId,
    agentName,
  })
}

// ============================================================
// T1: submitPlan - sends plan_approval_request via cloud
// ============================================================

describe('submitPlan', () => {

  test('submits a plan and returns the request payload with ok:true', async () => {
    const teamName = uid('team-submit')
    const teammate = makePlanApproval(teamName, 'teammate@submit', 'teammate-1')

    const result = await teammate.submitPlan(
      'leader@submit',
      '## Implementation Plan\n- Step 1: Create module\n- Step 2: Write tests',
      '/path/to/plan.md',
    )

    assert.ok(result, 'submitPlan should return a result')
    assert.strictEqual(result.type, 'plan_approval_request')
    assert.strictEqual(result.from, 'teammate-1')
    assert.strictEqual(result.to, 'leader@submit')
    assert.strictEqual(result.planContent, '## Implementation Plan\n- Step 1: Create module\n- Step 2: Write tests')
    assert.strictEqual(result.planFilePath, '/path/to/plan.md')
    assert.ok(result.requestId, 'Should have a generated requestId')
    assert.ok(result.timestamp, 'Should have a timestamp')
  })

  test('submitPlan works without planFilePath (optional)', async () => {
    const teamName = uid('team-submit2')
    const teammate = makePlanApproval(teamName, 'teammate@submit2', 'teammate-2')

    const result = await teammate.submitPlan('leader@submit2', 'Simple plan content')

    assert.strictEqual(result.planContent, 'Simple plan content')
    assert.strictEqual(result.planFilePath, undefined)
  })

  test('submitPlan via cloud returns "cloud" transport', async () => {
    const teamName = uid('team-submit3')
    const teammate = makePlanApproval(teamName, 'teammate@submit3', 'teammate-3')

    const transport = await teammate.submitPlanWithTransport(
      'leader@submit3',
      'Cloud plan',
    )

    assert.strictEqual(transport, 'cloud', 'Should use cloud transport when available')
  })
})

// ============================================================
// T2: Plan request delivered via SSE to leader within 3s
// ============================================================

describe('SSE delivery of plan request', () => {

  test('plan request delivered via SSE to leader within 3 seconds', async () => {
    const teamName = uid('team-sse-plan')

    // Leader sets up SSE listener for plan submissions
    const { dispatcher: leaderDispatcher } = makeDispatcher(teamName, 'leader@sse', 'leader-sse')
    const leader = new CloudPlanApproval({
      dispatcher: leaderDispatcher,
      teamName,
      agentId: 'leader@sse',
      agentName: 'leader-sse',
    })

    const receivedPlans = []
    leader.onPlanSubmitted(async (plan) => {
      receivedPlans.push(plan)
    })

    // Wait for SSE to establish
    await new Promise(r => setTimeout(r, 1000))

    // Teammate submits plan
    const teammate = makePlanApproval(teamName, 'teammate@sse', 'teammate-sse')
    await teammate.submitPlan('leader@sse', 'SSE test plan', '/test/plan.md')

    // Wait for SSE delivery (max 3 seconds)
    const deadline = Date.now() + 3000
    let found = false
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      if (receivedPlans.length > 0) {
        found = true
        break
      }
    }

    assert.ok(found, 'Leader should receive plan submission via SSE within 3 seconds')
    assert.strictEqual(receivedPlans[0].planContent, 'SSE test plan')
    assert.strictEqual(receivedPlans[0].planFilePath, '/test/plan.md')

    // Cleanup
    leader.stopListening()
  })
})

// ============================================================
// T3: approvePlan - sends plan_approval_response(approved=true)
// ============================================================

describe('approvePlan', () => {

  test('approvePlan sends approved=true response delivered to teammate', async () => {
    const teamName = uid('team-approve')

    // Teammate listens for responses
    const teammate = makePlanApproval(teamName, 'teammate@approve', 'teammate-approve')
    const receivedResponses = []
    teammate.onPlanResponse((response) => {
      receivedResponses.push(response)
    })

    // Wait for SSE to establish
    await new Promise(r => setTimeout(r, 1000))

    // Teammate submits plan first
    const request = await teammate.submitPlan('leader@approve', 'Plan to approve')
    await new Promise(r => setTimeout(r, 500))

    // Leader approves
    const leader = makePlanApproval(teamName, 'leader@approve', 'leader-approve')
    const response = await leader.approvePlan(request.requestId, 'teammate@approve', 'session')

    assert.ok(response, 'approvePlan should return a response')
    assert.strictEqual(response.type, 'plan_approval_response')
    assert.strictEqual(response.requestId, request.requestId)
    assert.strictEqual(response.from, 'leader-approve')
    assert.strictEqual(response.approved, true)
    assert.strictEqual(response.permissionMode, 'session')

    // Wait for SSE delivery
    await new Promise(r => setTimeout(r, 2000))

    const found = receivedResponses.find(r => r.requestId === request.requestId)
    assert.ok(found, 'Teammate should receive approval response via SSE')
    assert.strictEqual(found.approved, true)

    // Cleanup
    teammate.stopListening()
    leader.stopListening()
  })
})

// ============================================================
// T4: rejectPlan - sends plan_approval_response(approved=false, feedback)
// ============================================================

describe('rejectPlan', () => {

  test('rejectPlan sends approved=false with feedback delivered to teammate', async () => {
    const teamName = uid('team-reject')

    // Teammate listens for responses
    const teammate = makePlanApproval(teamName, 'teammate@reject', 'teammate-reject')
    const receivedResponses = []
    teammate.onPlanResponse((response) => {
      receivedResponses.push(response)
    })

    // Wait for SSE to establish
    await new Promise(r => setTimeout(r, 1000))

    // Teammate submits plan
    const request = await teammate.submitPlan('leader@reject', 'Plan to reject')
    await new Promise(r => setTimeout(r, 500))

    // Leader rejects with feedback
    const leader = makePlanApproval(teamName, 'leader@reject', 'leader-reject')
    const response = await leader.rejectPlan(
      request.requestId,
      'teammate@reject',
      'The plan needs more detail on the database schema',
    )

    assert.ok(response, 'rejectPlan should return a response')
    assert.strictEqual(response.type, 'plan_approval_response')
    assert.strictEqual(response.requestId, request.requestId)
    assert.strictEqual(response.from, 'leader-reject')
    assert.strictEqual(response.approved, false)
    assert.strictEqual(response.feedback, 'The plan needs more detail on the database schema')

    // Wait for SSE delivery
    await new Promise(r => setTimeout(r, 2000))

    const found = receivedResponses.find(r => r.requestId === request.requestId)
    assert.ok(found, 'Teammate should receive rejection response via SSE')
    assert.strictEqual(found.approved, false)
    assert.strictEqual(found.feedback, 'The plan needs more detail on the database schema')

    // Cleanup
    teammate.stopListening()
    leader.stopListening()
  })
})

// ============================================================
// T5: Plan state tracking: pending to approved/rejected
// ============================================================

describe('Plan state tracking', () => {

  test('plan state is pending after submitPlan', async () => {
    const teamName = uid('team-state-pending')
    const teammate = makePlanApproval(teamName, 'teammate@state', 'teammate-state')

    const request = await teammate.submitPlan('leader@state', 'State test plan')

    const state = teammate.getPlanState(request.requestId)
    assert.strictEqual(state, 'pending', 'Plan state should be pending after submission')
  })

  test('plan state transitions to approved after approvePlan', async () => {
    const teamName = uid('team-state-approved')

    const teammate = makePlanApproval(teamName, 'teammate@state2', 'teammate-state2')
    const request = await teammate.submitPlan('leader@state2', 'State test plan 2')

    // Initially pending
    assert.strictEqual(teammate.getPlanState(request.requestId), 'pending')

    // Teammate needs to listen for the approval response via SSE
    teammate.onPlanResponse(() => {})

    // Wait for SSE to establish
    await new Promise(r => setTimeout(r, 2000))

    const leader = makePlanApproval(teamName, 'leader@state2', 'leader-state2')
    await leader.approvePlan(request.requestId, 'teammate@state2')

    // Wait for SSE delivery
    await new Promise(r => setTimeout(r, 3000))

    // State should transition to approved
    const state = teammate.getPlanState(request.requestId)
    assert.strictEqual(state, 'approved', 'Plan state should be approved after approval')
  })

  test('plan state transitions to rejected after rejectPlan', async () => {
    const teamName = uid('team-state-rejected')

    const teammate = makePlanApproval(teamName, 'teammate@state3', 'teammate-state3')
    const request = await teammate.submitPlan('leader@state3', 'State test plan 3')

    // Teammate needs to listen for the rejection response via SSE
    teammate.onPlanResponse(() => {})

    // Wait for SSE to establish
    await new Promise(r => setTimeout(r, 2000))

    const leader = makePlanApproval(teamName, 'leader@state3', 'leader-state3')
    await leader.rejectPlan(request.requestId, 'teammate@state3', 'Not enough detail')

    // Wait for SSE delivery
    await new Promise(r => setTimeout(r, 3000))

    const state = teammate.getPlanState(request.requestId)
    assert.strictEqual(state, 'rejected', 'Plan state should be rejected after rejection')
  })

  test('getPlanState returns undefined for unknown requestId', () => {
    const teamName = uid('team-state-unknown')
    const pa = makePlanApproval(teamName, 'agent@state4', 'agent-state4')

    const state = pa.getPlanState('nonexistent-request-id')
    assert.strictEqual(state, undefined, 'Unknown request should return undefined')
  })
})

// ============================================================
// T6: Integration: full lifecycle - submit, receive, approve, confirm
// ============================================================

describe('Integration: full plan approval lifecycle', () => {

  test('teammate submits then leader receives then approves then teammate receives confirmation', async () => {
    const teamName = uid('team-e2e')

    // -- Leader sets up listener for plan submissions --
    const { dispatcher: leaderDispatcher } = makeDispatcher(teamName, 'leader@e2e', 'leader-e2e')
    const leader = new CloudPlanApproval({
      dispatcher: leaderDispatcher,
      teamName,
      agentId: 'leader@e2e',
      agentName: 'leader-e2e',
    })

    const leaderReceivedPlans = []
    leader.onPlanSubmitted(async (plan) => {
      leaderReceivedPlans.push(plan)
    })

    // -- Teammate sets up listener for plan responses --
    const teammate = makePlanApproval(teamName, 'teammate@e2e', 'teammate-e2e')
    const teammateReceivedResponses = []
    teammate.onPlanResponse((response) => {
      teammateReceivedResponses.push(response)
    })

    // Wait for both SSE connections to establish
    await new Promise(r => setTimeout(r, 1500))

    // Step 1: Teammate submits plan
    const planRequest = await teammate.submitPlan(
      'leader@e2e',
      '## Full Lifecycle Test Plan\n\n1. Create CloudPlanApproval class\n2. Write tests\n3. Implement',
      '/plans/lifecycle-test.md',
    )

    // Step 2: Leader receives the plan (via SSE)
    let leaderGotPlan = false
    const planDeadline = Date.now() + 3000
    while (Date.now() < planDeadline) {
      await new Promise(r => setTimeout(r, 300))
      if (leaderReceivedPlans.length > 0) {
        leaderGotPlan = true
        break
      }
    }
    assert.ok(leaderGotPlan, 'Leader should receive the plan submission')
    assert.strictEqual(leaderReceivedPlans[0].planContent, planRequest.planContent)
    assert.strictEqual(leaderReceivedPlans[0].planFilePath, '/plans/lifecycle-test.md')

    // Step 3: Leader approves the plan
    await leader.approvePlan(planRequest.requestId, 'teammate@e2e', 'session')

    // Step 4: Teammate receives confirmation (via SSE)
    let teammateGotResponse = false
    const responseDeadline = Date.now() + 3000
    while (Date.now() < responseDeadline) {
      await new Promise(r => setTimeout(r, 300))
      if (teammateReceivedResponses.length > 0) {
        teammateGotResponse = true
        break
      }
    }
    assert.ok(teammateGotResponse, 'Teammate should receive the approval confirmation')
    assert.strictEqual(teammateReceivedResponses[0].approved, true)
    assert.strictEqual(teammateReceivedResponses[0].requestId, planRequest.requestId)

    // Step 5: Verify state tracking
    assert.strictEqual(teammate.getPlanState(planRequest.requestId), 'approved')

    // Cleanup
    leader.stopListening()
    teammate.stopListening()
  })

  test('teammate submits then leader receives then rejects with feedback then teammate receives', async () => {
    const teamName = uid('team-e2e-reject')

    // Leader
    const { dispatcher: leaderDispatcher } = makeDispatcher(teamName, 'leader@e2e2', 'leader-e2e2')
    const leader = new CloudPlanApproval({
      dispatcher: leaderDispatcher,
      teamName,
      agentId: 'leader@e2e2',
      agentName: 'leader-e2e2',
    })

    const leaderReceivedPlans = []
    leader.onPlanSubmitted(async (plan) => {
      leaderReceivedPlans.push(plan)
    })

    // Teammate
    const teammate = makePlanApproval(teamName, 'teammate@e2e2', 'teammate-e2e2')
    const teammateReceivedResponses = []
    teammate.onPlanResponse((response) => {
      teammateReceivedResponses.push(response)
    })

    // Wait for SSE
    await new Promise(r => setTimeout(r, 1500))

    // Submit
    const planRequest = await teammate.submitPlan(
      'leader@e2e2',
      'Plan to be rejected',
    )

    // Leader receives
    let leaderGotPlan = false
    const planDeadline = Date.now() + 3000
    while (Date.now() < planDeadline) {
      await new Promise(r => setTimeout(r, 300))
      if (leaderReceivedPlans.length > 0) {
        leaderGotPlan = true
        break
      }
    }
    assert.ok(leaderGotPlan, 'Leader should receive plan')

    // Leader rejects
    const feedback = 'Missing error handling section'
    await leader.rejectPlan(planRequest.requestId, 'teammate@e2e2', feedback)

    // Teammate receives rejection
    let teammateGotResponse = false
    const responseDeadline = Date.now() + 3000
    while (Date.now() < responseDeadline) {
      await new Promise(r => setTimeout(r, 300))
      if (teammateReceivedResponses.length > 0) {
        teammateGotResponse = true
        break
      }
    }
    assert.ok(teammateGotResponse, 'Teammate should receive rejection')
    assert.strictEqual(teammateReceivedResponses[0].approved, false)
    assert.strictEqual(teammateReceivedResponses[0].feedback, feedback)
    assert.strictEqual(teammate.getPlanState(planRequest.requestId), 'rejected')

    // Cleanup
    leader.stopListening()
    teammate.stopListening()
  })
})
