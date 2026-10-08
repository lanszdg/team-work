/**
 * End-to-End Integration Test — Multi-Machine Team Workflow
 *
 * Simulates a complete multi-machine team collaboration across all 7 features
 * using the real sync server at http://127.0.0.1:3000.
 *
 * Single process, two agents (Leader + Worker) with isolated dispatchers,
 * shared SSE infrastructure, and sequential feature testing.
 *
 * Test flow:
 *   1. Team Formation  →  Leader registers team, sends invitation; Worker accepts
 *   2. Permission      →  Leader broadcasts, Worker receives via SSE
 *   3. Plan Approval   →  Worker submits plan, Leader approves via SSE
 *   4. Code Review     →  Worker submits CR, Leader approves via SSE
 *   5. Git Sync        →  Worker pushes git state, Leader pulls it
 *   6. Skill Sharing   →  Leader learns + shares skill, Worker discovers & applies
 *   7. Member Kick     →  Leader kicks Worker, Worker accepts shutdown
 *   8. Cleanup         →  Stop all listeners, verify clean state
 *
 * Each step is a subtest that depends on the previous step's output.
 */

import test, { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Import all modules from dist
import { CloudInvitation } from '../dist/core/cloudInvitation.js'
import { CloudKickManager } from '../dist/core/cloudKick.js'
import { CloudPlanApproval } from '../dist/core/cloudPlanApproval.js'
import { CloudCodeReview } from '../dist/core/codeReview.js'
import { CloudPermissionBroadcast } from '../dist/core/cloudPermissionBroadcast.js'
import { GitSync } from '../dist/core/gitSync.js'
import { SkillEvolution } from '../dist/core/skillEvolution.js'
import { MessageDispatcher } from '../dist/core/messageDispatcher.js'
import { createTeam, addMember } from '../dist/core/teamFile.js'
import { readTeamFile } from '../dist/core/teamFile.js'

// -- test config -------------------------------------------------------

const SERVER_URL = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

const TEAM_NAME = `e2e-mm-${Date.now()}`
const LEADER_AGENT_ID = `leader-${Date.now()}`
const WORKER_AGENT_ID = `worker-${Date.now()}`
const LEADER_NAME = 'leader-agent'
const WORKER_NAME = 'worker-agent'

// -- shared state -------------------------------------------------------

const sharedState = {
  invitationId: null,
  permissionUpdate: null,
  planRequestId: null,
  crRequestId: null,
  crSubmission: null,
  gitState: null,
  skillEntry: null,
  sharedSkillId: null,
  shutdownRequestId: null,
  leaderDispatcher: null,
  workerDispatcher: null,
}

// -- SSE wait helper ----------------------------------------------------

const SSE_WAIT_MS = 2000

async function waitForSSE() {
  await new Promise(resolve => setTimeout(resolve, SSE_WAIT_MS))
}

// -- dispatcher factory ------------------------------------------------

function makeDispatcher(teamName, agentId, agentName) {
  const mailboxes = {}
  return new MessageDispatcher({
    teamName,
    agentId,
    agentName,
    cloudConfig: {
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      developerId: agentId,
    },
      if (!mailboxes[r]) mailboxes[r] = []
      mailboxes[r].push(m)
    },
  })
}

// -- describe block -----------------------------------------------------

describe('E2E Multi-Machine Team Workflow', () => {

  // ---- 1a. Leader registers team ----------------------------------------

  it('1a. Leader registers team and it is discoverable', async () => {
    const leaderDisp = makeDispatcher(TEAM_NAME, LEADER_AGENT_ID, LEADER_NAME)
    const workerDisp = makeDispatcher(TEAM_NAME, WORKER_AGENT_ID, WORKER_NAME)
    sharedState.leaderDispatcher = leaderDisp
    sharedState.workerDispatcher = workerDisp

    const cloudInv = new CloudInvitation({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      teamName: TEAM_NAME,
      agentId: LEADER_AGENT_ID,
      agentName: LEADER_NAME,
    })

    await cloudInv.registerTeam({
      name: TEAM_NAME,
      description: 'E2E Multi-Machine Test Team',
      leadAgentId: LEADER_AGENT_ID,
      leadAgentName: LEADER_NAME,
      memberCount: 2,
      createdAt: new Date().toISOString(),
    })

    // Verify team is discoverable
    const teams = await CloudInvitation.discoverCloudTeams(SERVER_URL, API_KEY)
    const found = teams.find(t => t.name === TEAM_NAME)
    assert.ok(found, 'Team should be discoverable after registration')
    assert.equal(found.leadAgentId, LEADER_AGENT_ID)

    // Create local team file for kick/cleanup operations
    createTeam({
      teamName: TEAM_NAME,
      leadAgentId: LEADER_AGENT_ID,
      description: 'E2E Test Team',
    })
    addMember(TEAM_NAME, {
      agentId: WORKER_AGENT_ID,
      name: WORKER_NAME,
      tmuxPaneId: '',
      cwd: process.cwd(),
      subscriptions: [],
      isActive: true,
      mode: 'auto',
    })
  })

  // ---- 1b. Leader sends invitation ---------------------------------------

  it('1b. Leader sends invitation to Worker', async () => {
    const cloudInv = new CloudInvitation({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      teamName: TEAM_NAME,
      agentId: LEADER_AGENT_ID,
      agentName: LEADER_NAME,
    })

    const invitation = await cloudInv.sendInvitation(
      WORKER_AGENT_ID,
      WORKER_NAME,
      'Join our multi-machine team!',
    )

    assert.ok(invitation.id, 'Invitation should have an ID')
    assert.equal(invitation.status, 'pending')
    assert.equal(invitation.toAgentId, WORKER_AGENT_ID)
    sharedState.invitationId = invitation.id
  })

  // ---- 1c. Worker discovers and accepts invitation -----------------------

  it('1c. Worker discovers and accepts invitation', async () => {
    const cloudInv = new CloudInvitation({
      apiUrl: SERVER_URL,
      apiKey: API_KEY,
      teamName: TEAM_NAME,
      agentId: WORKER_AGENT_ID,
      agentName: WORKER_NAME,
    })

    // Poll for the invitation (brief retry loop)
    let invitations = []
    for (let i = 0; i < 5; i++) {
      invitations = await cloudInv.getInvitations()
      if (invitations.length > 0) break
      await new Promise(r => setTimeout(r, 500))
    }

    assert.ok(invitations.length > 0, 'Worker should find at least one invitation')
    const inv = invitations.find(i => i.id === sharedState.invitationId)
    assert.ok(inv, 'Worker should find the specific invitation')
    assert.equal(inv.status, 'pending')

    await cloudInv.acceptInvitation(inv.id)

    // Verify status was updated
    const updated = await cloudInv.getInvitations()
    const accepted = updated.find(i => i.id === inv.id)
    assert.equal(accepted.status, 'accepted', 'Invitation should be accepted')
  })

  // ---- 2. Permission Broadcast ------------------------------------------

  it('2. Permission Broadcast: Leader broadcasts, Worker receives via SSE', async () => {
    let receivedUpdate = null

    // Worker starts listening for permission updates
    const permBroadcast = new CloudPermissionBroadcast({
      dispatcher: sharedState.workerDispatcher,
      teamName: TEAM_NAME,
      agentId: WORKER_AGENT_ID,
      agentName: WORKER_NAME,
    })

    permBroadcast.onPermissionUpdate((update) => {
      receivedUpdate = update
    })

    await permBroadcast.startListening()
    await waitForSSE()

    // Leader broadcasts a permission update
    const leaderPerm = new CloudPermissionBroadcast({
      dispatcher: sharedState.leaderDispatcher,
      teamName: TEAM_NAME,
      agentId: LEADER_AGENT_ID,
      agentName: LEADER_NAME,
    })

    const payload = await leaderPerm.broadcastPermissionUpdate(
      [{ path: '/project/src', toolName: 'Edit', addedBy: LEADER_NAME, addedAt: Date.now() }],
      'allow',
    )

    assert.ok(payload.requestId, 'Permission update should have a request ID')
    assert.equal(payload.behavior, 'allow')
    assert.equal(payload.rules.length, 1)

    // Wait for SSE delivery
    await waitForSSE()

    // Worker should have received the update
    assert.ok(receivedUpdate, 'Worker should have received permission update via SSE')
    assert.equal(receivedUpdate.type, 'team_permission_update')
    assert.equal(receivedUpdate.behavior, 'allow')
    assert.equal(receivedUpdate.rules.length, 1)
    assert.equal(receivedUpdate.rules[0].path, '/project/src')

    sharedState.permissionUpdate = receivedUpdate

    await permBroadcast.stopListening()
  })

  // ---- 3. Plan Approval -------------------------------------------------

  it('3. Plan Approval: Worker submits plan, Leader approves via SSE', async () => {
    let submittedPlan = null
    let planResponse = null

    // Leader registers callback for plan submissions
    const leaderPlan = new CloudPlanApproval({
      dispatcher: sharedState.leaderDispatcher,
      teamName: TEAM_NAME,
      agentId: LEADER_AGENT_ID,
      agentName: LEADER_NAME,
    })

    leaderPlan.onPlanSubmitted(async (plan) => {
      submittedPlan = plan
      // Leader approves the plan
      const response = await leaderPlan.approvePlan(plan.requestId, WORKER_AGENT_ID)
      planResponse = response
    })

    // Worker registers callback for plan responses
    const workerPlan = new CloudPlanApproval({
      dispatcher: sharedState.workerDispatcher,
      teamName: TEAM_NAME,
      agentId: WORKER_AGENT_ID,
      agentName: WORKER_NAME,
    })

    let workerReceivedResponse = false
    workerPlan.onPlanResponse((response) => {
      workerReceivedResponse = true
      planResponse = response
    })

    // Wait for SSE to establish
    await waitForSSE()

    // Worker submits a plan for approval
    const plan = await workerPlan.submitPlan(
      LEADER_AGENT_ID,
      'Implement user authentication with JWT tokens and refresh mechanism',
      '/project/docs/plan-auth.md',
    )

    assert.ok(plan.requestId, 'Plan should have a request ID')
    assert.equal(plan.planContent.includes('authentication'), true)
    sharedState.planRequestId = plan.requestId

    // Wait for SSE delivery and leader callback to fire
    await waitForSSE()

    // Leader should have received the plan submission
    assert.ok(submittedPlan, 'Leader should have received the plan submission via SSE')
    assert.equal(submittedPlan.requestId, plan.requestId)
    assert.equal(submittedPlan.from, WORKER_NAME)

    // Leader should have approved the plan
    assert.ok(planResponse, 'Leader should have approved the plan')
    assert.equal(planResponse.approved, true)

    // Worker should have received the approval response
    assert.ok(workerReceivedResponse, 'Worker should have received the approval response via SSE')
    assert.equal(planResponse.approved, true)

    // Verify plan state on both sides
    const leaderState = leaderPlan.getPlanState(plan.requestId)
    assert.equal(leaderState, 'approved')

    const workerState = workerPlan.getPlanState(plan.requestId)
    assert.equal(workerState, 'approved')

    leaderPlan.stopListening()
    workerPlan.stopListening()
  })

  // ---- 4. Code Review ---------------------------------------------------

  it('4. Code Review: Worker submits code review, Leader approves via SSE', async () => {
    let submittedCR = null
    let crResponse = null
    let workerReceivedResponse = false

    // Leader creates CloudCodeReview and starts listening
    const leaderCR = new CloudCodeReview({
      dispatcher: sharedState.leaderDispatcher,
      teamName: TEAM_NAME,
      agentId: LEADER_AGENT_ID,
      agentName: LEADER_NAME,
    })

    // Worker creates CloudCodeReview for receiving responses
    const workerCR = new CloudCodeReview({
      dispatcher: sharedState.workerDispatcher,
      teamName: TEAM_NAME,
      agentId: WORKER_AGENT_ID,
      agentName: WORKER_NAME,
    })

    // Set up leader callback for incoming code review submissions
    leaderCR.onCodeReviewSubmitted(async (cr) => {
      submittedCR = cr
      // Leader approves the code review
      const response = await leaderCR.approveCodeReview(cr.requestId, WORKER_AGENT_ID, ['LGTM'])
      crResponse = response
    })

    // Set up worker callback for code review responses
    workerCR.onCodeReviewResponse((response) => {
      workerReceivedResponse = true
      crResponse = response
    })

    // Start leader SSE listening — hook into CloudCodeReview's internal handler
    const leaderRouter = sharedState.leaderDispatcher.getCloudRouter()
    if (leaderRouter) {
      await sharedState.leaderDispatcher.startCloudListening((msg) => {
        leaderCR['handleIncomingMessage'](msg)
      })
    }

    // Start worker SSE listening
    const workerRouter = sharedState.workerDispatcher.getCloudRouter()
    if (workerRouter) {
      await sharedState.workerDispatcher.startCloudListening((msg) => {
        workerCR['handleIncomingMessage'](msg)
      })
    }

    await waitForSSE()

    // Worker submits code review
    const submission = await workerCR.submitCodeReview(
      LEADER_AGENT_ID,
      'feature/auth-module',
      ['src/auth.ts', 'src/middleware.ts', 'tests/auth.test.ts'],
      'Implemented JWT authentication with refresh tokens',
      '3 files changed, 150 insertions, 20 deletions',
    )

    assert.ok(submission.requestId, 'Code review should have a request ID')
    assert.equal(submission.from, WORKER_NAME)
    assert.equal(submission.branchName, 'feature/auth-module')
    assert.equal(submission.filesChanged.length, 3)
    sharedState.crRequestId = submission.requestId
    sharedState.crSubmission = submission

    // Wait for SSE delivery and leader callback to fire
    await waitForSSE()

    // Leader should have received the code review submission
    assert.ok(submittedCR, 'Leader should have received the code review submission via SSE')
    assert.equal(submittedCR.requestId, submission.requestId)
    assert.equal(submittedCR.from, WORKER_NAME)
    assert.equal(submittedCR.branchName, 'feature/auth-module')

    // Leader should have approved
    assert.ok(crResponse, 'Leader should have approved the code review')
    assert.equal(crResponse.approved, true)
    assert.ok(crResponse.comments?.includes('LGTM'))

    // Worker should have received the approval response
    assert.ok(workerReceivedResponse, 'Worker should have received the approval response via SSE')
    assert.equal(crResponse.approved, true)

    // Verify review state
    const leaderState = leaderCR.getReviewState(submission.requestId)
    assert.equal(leaderState, 'approved')

    const workerState = workerCR.getReviewState(submission.requestId)
    assert.equal(workerState, 'approved')

    sharedState.leaderDispatcher.stopCloudListening()
    sharedState.workerDispatcher.stopCloudListening()
  })

  // ---- 5. Git Sync ------------------------------------------------------

  it('5. Git Sync: Worker pushes git state, Leader pulls it', async () => {
    const leaderGit = new GitSync({
      dispatcher: sharedState.leaderDispatcher,
      teamName: TEAM_NAME,
      agentId: LEADER_AGENT_ID,
      agentName: LEADER_NAME,
    })

    const workerGit = new GitSync({
      dispatcher: sharedState.workerDispatcher,
      teamName: TEAM_NAME,
      agentId: WORKER_AGENT_ID,
      agentName: WORKER_NAME,
    })

    // Worker pushes git state
    const gitState = await workerGit.pushGitState(
      'feature/auth-module',
      'abc123def456',
      'Implement JWT authentication with refresh tokens',
      '3 files changed, 150 insertions, 20 deletions',
    )

    assert.ok(gitState, 'Git state should be returned')
    assert.equal(gitState.branch, 'feature/auth-module')
    assert.equal(gitState.commitHash, 'abc123def456')
    assert.equal(gitState.pushedBy, WORKER_NAME)
    assert.ok(gitState.timestamp)

    // Leader pulls git state
    const states = await leaderGit.pullGitState()
    const found = states.find(s => s.commitHash === 'abc123def456')

    assert.ok(found, 'Leader should find the worker\'s git state after pulling')
    assert.equal(found.branch, 'feature/auth-module')
    assert.equal(found.commitHash, 'abc123def456')
    assert.equal(found.message, 'Implement JWT authentication with refresh tokens')
    assert.equal(found.pushedBy, WORKER_NAME)

    sharedState.gitState = gitState

    // Verify local cache
    const leaderCache = leaderGit.getGitStates()
    assert.ok(leaderCache.size > 0, 'Leader should have cached git states')
  })

  // ---- 6. Skill Sharing -------------------------------------------------

  it('6. Skill Sharing: Leader learns a skill, shares it; Worker discovers and applies', async () => {
    const leaderSkill = new SkillEvolution({
      dispatcher: sharedState.leaderDispatcher,
      teamName: TEAM_NAME,
      agentId: LEADER_AGENT_ID,
      agentName: LEADER_NAME,
    })

    const workerSkill = new SkillEvolution({
      dispatcher: sharedState.workerDispatcher,
      teamName: TEAM_NAME,
      agentId: WORKER_AGENT_ID,
      agentName: WORKER_NAME,
    })

    // Leader learns a skill
    const skill = await leaderSkill.learn(
      'jwt-auth-pattern',
      'JWT authentication with refresh tokens and secure cookie storage',
      { category: 'security', technique: 'JWT' },
    )

    assert.ok(skill.id, 'Skill should have an ID')
    assert.equal(skill.name, 'jwt-auth-pattern')
    assert.equal(skill.category, 'security')
    assert.equal(skill.version, 1)
    sharedState.skillEntry = skill

    // Leader shares the skill to cloud
    await leaderSkill.share(skill.id)

    // Worker discovers skills from cloud
    const discovered = await workerSkill.discoverSkills()
    const found = discovered.find(s => s.id === skill.id)

    assert.ok(found, 'Worker should discover the shared skill from cloud')
    assert.equal(found.name, 'jwt-auth-pattern')
    assert.equal(found.category, 'security')
    assert.equal(found.description, skill.description)

    // Worker applies (merges into local skills)
    const applied = await workerSkill.apply()
    assert.ok(applied.length > 0, 'Worker should have applied at least one skill')
    assert.ok(applied.some(s => s.id === skill.id), 'Applied skills should include the shared skill')

    // Verify worker's local skills now include the shared skill
    const workerLocalSkills = workerSkill.getLocalSkills()
    assert.ok(
      workerLocalSkills.some(s => s.id === skill.id),
      'Worker local skills should include the shared skill',
    )

    sharedState.sharedSkillId = skill.id
  })

  // ---- 7. Member Kick ---------------------------------------------------

  it('7. Member Kick: Leader kicks Worker, Worker accepts shutdown', async () => {
    const leaderKick = new CloudKickManager(
      sharedState.leaderDispatcher,
      TEAM_NAME,
      LEADER_AGENT_ID,
      LEADER_NAME,
    )

    const workerKick = new CloudKickManager(
      sharedState.workerDispatcher,
      TEAM_NAME,
      WORKER_AGENT_ID,
      WORKER_NAME,
    )

    // Set up worker to auto-accept shutdown requests via cloud listening
    let receivedShutdownRequest = null
    await sharedState.workerDispatcher.startCloudListening((msg) => {
      try {
        const parsed = typeof msg.text === 'string' ? JSON.parse(msg.text) : msg.text
        if (parsed && parsed.type === 'shutdown_request') {
          receivedShutdownRequest = parsed
          workerKick.sendShutdownApproved(parsed.requestId, LEADER_AGENT_ID).catch(() => {})
        }
      } catch { /* skip non-JSON */ }
    })

    // Leader also needs SSE listening so the worker's shutdown_approved response
    // gets buffered into the leader's cloudBuffer for kickAndRemove to read
    await sharedState.leaderDispatcher.startCloudListening(() => {})

    await waitForSSE()

    // Leader kicks the worker
    const result = await leaderKick.kickAndRemove(
      WORKER_AGENT_ID,
      WORKER_NAME,
      'E2E test completed',
      10_000, // 10 second timeout
    )

    assert.ok(result.success, 'Kick should succeed')
    assert.ok(result.accepted, 'Worker should have accepted the shutdown')

    // Verify shutdown request was received by worker
    assert.ok(receivedShutdownRequest, 'Worker should have received the shutdown request')
    assert.equal(receivedShutdownRequest.from, LEADER_NAME)

    // Verify the member was removed from team file
    const teamFile = readTeamFile(TEAM_NAME)
    assert.ok(teamFile, 'Team file should still exist')
    const workerStillMember = teamFile.members.some(m => m.agentId === WORKER_AGENT_ID)
    assert.equal(workerStillMember, false, 'Worker should be removed from team file')

    sharedState.shutdownRequestId = receivedShutdownRequest.requestId

    sharedState.workerDispatcher.stopCloudListening()
    sharedState.leaderDispatcher.stopCloudListening()
  })

  // ---- 8. Cleanup -------------------------------------------------------

  it('8. Cleanup: Stop all listeners, verify clean state', async () => {
    // Stop all dispatchers
    sharedState.leaderDispatcher.stopCloudListening()
    sharedState.workerDispatcher.stopCloudListening()

    // Verify all state was captured across all steps
    assert.ok(sharedState.invitationId, 'Invitation ID should be recorded')
    assert.ok(sharedState.permissionUpdate, 'Permission update should be recorded')
    assert.ok(sharedState.planRequestId, 'Plan request ID should be recorded')
    assert.ok(sharedState.crRequestId, 'Code review request ID should be recorded')
    assert.ok(sharedState.gitState, 'Git state should be recorded')
    assert.ok(sharedState.sharedSkillId, 'Shared skill ID should be recorded')
    assert.ok(sharedState.shutdownRequestId, 'Shutdown request ID should be recorded')
  })
})
