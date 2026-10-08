/**
 * Tests for dist/hooks/teammateStop.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, makeMember, makeTeamFile } from './utils.js'
import { initializeTeammateHooks } from '../dist/hooks/teammateStop.js'
import { writeTeamFile, readTeamFile, setMemberActive } from '../dist/core/teamFile.js'
import { readMailbox } from '../dist/core/mailbox.js'

describe('initializeTeammateHooks — team file not found', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
    // Reset global stop hook
    delete globalThis.__TEAM_COLLAB_STOP_HOOK__
  })

  it('returns early and logs error when team file does not exist', () => {
    let logged = null
    const origError = console.error
    console.error = (msg) => { logged = msg }

    const setAppState = () => {}
    initializeTeammateHooks(setAppState, 'sess-1', {
      teamName: 'nonexistent-team',
      agentId: 'worker@nonexistent-team',
      agentName: 'worker',
    })

    console.error = origError
    assert.ok(logged !== null, 'Expected error to be logged')
    assert.ok(logged.includes('Team file not found'), 'Expected team-not-found message')
    assert.strictEqual(globalThis.__TEAM_COLLAB_STOP_HOOK__, undefined)
  })
})

describe('initializeTeammateHooks — non-leader agent', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
    process.env.CLAUDE_CODE_TEAM_NAME = 'test-team'
    process.env.CLAUDE_CODE_AGENT_NAME = 'worker'
    process.env.CLAUDE_CODE_AGENT_ID = 'worker@test-team'
  })

  afterEach(() => {
    env.cleanup()
    delete globalThis.__TEAM_COLLAB_STOP_HOOK__
  })

  it('registers stop hook on globalThis.__TEAM_COLLAB_STOP_HOOK__ when agent is NOT leader', () => {
    const teamFile = makeTeamFile({
      name: 'test-team',
      leadAgentId: 'team-lead@test-team',
      members: [
        makeMember({ agentId: 'team-lead@test-team', name: 'team-lead' }),
        makeMember({ agentId: 'worker@test-team', name: 'worker' }),
      ],
    })
    writeTeamFile('test-team', teamFile)

    const setAppState = () => {}
    initializeTeammateHooks(setAppState, 'sess-1', {
      teamName: 'test-team',
      agentId: 'worker@test-team',
      agentName: 'worker',
    })

    assert.ok(
      typeof globalThis.__TEAM_COLLAB_STOP_HOOK__ === 'function',
      'Stop hook should be registered on globalThis',
    )
  })

  it('does NOT register stop hook when agent IS the leader', () => {
    const teamFile = makeTeamFile({
      name: 'test-team',
      leadAgentId: 'team-lead@test-team',
      members: [
        makeMember({ agentId: 'team-lead@test-team', name: 'team-lead' }),
      ],
    })
    writeTeamFile('test-team', teamFile)

    let logged = null
    const origLog = console.log
    console.log = (msg) => { logged = msg }

    const setAppState = () => {}
    initializeTeammateHooks(setAppState, 'sess-lead', {
      teamName: 'test-team',
      agentId: 'team-lead@test-team',
      agentName: 'team-lead',
    })

    console.log = origLog
    assert.strictEqual(globalThis.__TEAM_COLLAB_STOP_HOOK__, undefined)
    assert.ok(logged !== null, 'Expected log message about being leader')
    assert.ok(logged.includes('team leader'), 'Expected "team leader" in log message')
  })
})

describe('initializeTeammateHooks — team-wide allowed paths', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
    process.env.CLAUDE_CODE_TEAM_NAME = 'path-team'
    process.env.CLAUDE_CODE_AGENT_NAME = 'worker'
    process.env.CLAUDE_CODE_AGENT_ID = 'worker@path-team'
  })

  afterEach(() => {
    env.cleanup()
    delete globalThis.__TEAM_COLLAB_STOP_HOOK__
  })

  it('applies team-wide allowed paths via setAppState when they exist', () => {
    const teamFile = makeTeamFile({
      name: 'path-team',
      leadAgentId: 'team-lead@path-team',
      members: [
        makeMember({ agentId: 'team-lead@path-team', name: 'team-lead' }),
        makeMember({ agentId: 'worker@path-team', name: 'worker' }),
      ],
      teamAllowedPaths: [
        { path: 'src', toolName: 'Edit', addedBy: 'team-lead', addedAt: Date.now() },
      ],
    })
    writeTeamFile('path-team', teamFile)

    const stateUpdates = []
    const setAppState = (updater) => {
      const prev = stateUpdates.length > 0
        ? stateUpdates[stateUpdates.length - 1]
        : {}
      const next = updater(prev)
      stateUpdates.push(next)
    }

    initializeTeammateHooks(setAppState, 'sess-1', {
      teamName: 'path-team',
      agentId: 'worker@path-team',
      agentName: 'worker',
    })

    assert.ok(stateUpdates.length > 0, 'setAppState should have been called')
    const lastState = stateUpdates[stateUpdates.length - 1]
    assert.ok(Array.isArray(lastState.teamAllowedPaths))
    assert.equal(lastState.teamAllowedPaths.length, 1)
    const rule = lastState.teamAllowedPaths[0]
    assert.equal(rule.toolName, 'Edit')
    assert.equal(rule.ruleContent, 'src/**')
    assert.equal(rule.behavior, 'allow')
  })

  it('prepending absolute paths with / to create //path/** pattern', () => {
    const teamFile = makeTeamFile({
      name: 'abs-path-team',
      leadAgentId: 'team-lead@abs-path-team',
      members: [
        makeMember({ agentId: 'team-lead@abs-path-team', name: 'team-lead' }),
        makeMember({ agentId: 'worker@abs-path-team', name: 'worker' }),
      ],
      teamAllowedPaths: [
        { path: '/tmp/work', toolName: 'Write', addedBy: 'team-lead', addedAt: Date.now() },
      ],
    })
    writeTeamFile('abs-path-team', teamFile)

    const stateUpdates = []
    const setAppState = (updater) => {
      const prev = stateUpdates.length > 0
        ? stateUpdates[stateUpdates.length - 1]
        : {}
      stateUpdates.push(updater(prev))
    }

    initializeTeammateHooks(setAppState, 'sess-1', {
      teamName: 'abs-path-team',
      agentId: 'worker@abs-path-team',
      agentName: 'worker',
    })

    const lastState = stateUpdates[stateUpdates.length - 1]
    const rule = lastState.teamAllowedPaths[0]
    assert.equal(rule.ruleContent, '//tmp/work/**')
  })

  it('applies multiple allowed paths', () => {
    const teamFile = makeTeamFile({
      name: 'multi-path-team',
      leadAgentId: 'team-lead@multi-path-team',
      members: [
        makeMember({ agentId: 'team-lead@multi-path-team', name: 'team-lead' }),
        makeMember({ agentId: 'worker@multi-path-team', name: 'worker' }),
      ],
      teamAllowedPaths: [
        { path: '/home/user/docs', toolName: 'Read', addedBy: 'lead', addedAt: Date.now() },
        { path: 'lib', toolName: 'Edit', addedBy: 'lead', addedAt: Date.now() },
      ],
    })
    writeTeamFile('multi-path-team', teamFile)

    const stateUpdates = []
    const setAppState = (updater) => {
      const prev = stateUpdates.length > 0
        ? stateUpdates[stateUpdates.length - 1]
        : {}
      stateUpdates.push(updater(prev))
    }

    initializeTeammateHooks(setAppState, 'sess-1', {
      teamName: 'multi-path-team',
      agentId: 'worker@multi-path-team',
      agentName: 'worker',
    })

    const lastState = stateUpdates[stateUpdates.length - 1]
    assert.equal(lastState.teamAllowedPaths.length, 2)
    assert.equal(lastState.teamAllowedPaths[0].ruleContent, '//home/user/docs/**')
    assert.equal(lastState.teamAllowedPaths[1].ruleContent, 'lib/**')
  })
})

describe('registered stop handler behavior', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
    process.env.CLAUDE_CODE_TEAM_NAME = 'stop-test'
    process.env.CLAUDE_CODE_AGENT_NAME = 'worker'
    process.env.CLAUDE_CODE_AGENT_ID = 'worker@stop-test'
  })

  afterEach(() => {
    env.cleanup()
    delete globalThis.__TEAM_COLLAB_STOP_HOOK__
  })

  it('when called, sets member active to false, sends idle notification, writes to leader inbox', async () => {
    const teamFile = makeTeamFile({
      name: 'stop-test',
      leadAgentId: 'team-lead@stop-test',
      members: [
        makeMember({ agentId: 'team-lead@stop-test', name: 'team-lead', isActive: true }),
        makeMember({ agentId: 'worker@stop-test', name: 'worker', isActive: true }),
      ],
    })
    writeTeamFile('stop-test', teamFile)

    const setAppState = () => {}
    initializeTeammateHooks(setAppState, 'sess-1', {
      teamName: 'stop-test',
      agentId: 'worker@stop-test',
      agentName: 'worker',
    })

    const stopHandler = globalThis.__TEAM_COLLAB_STOP_HOOK__
    assert.ok(typeof stopHandler === 'function', 'Stop hook should be a function')

    // Invoke the stop handler
    const result = await stopHandler([])

    // Should return true (don't block the Stop)
    assert.strictEqual(result, true)

    // Verify member active was set to false
    const updatedTeam = readTeamFile('stop-test')
    assert.ok(updatedTeam !== null)
    const workerMember = updatedTeam.members.find(m => m.name === 'worker')
    assert.ok(workerMember !== undefined)
    assert.strictEqual(workerMember.isActive, false)

    // Verify leader received idle notification in inbox
    const leaderInbox = await readMailbox('team-lead', 'stop-test')
    assert.ok(leaderInbox.length >= 1, 'Leader should have at least one message')

    const msg = leaderInbox[leaderInbox.length - 1]
    assert.strictEqual(msg.from, 'worker')
    // Parse the text as JSON to check it's an idle notification
    const notification = JSON.parse(msg.text)
    assert.strictEqual(notification.type, 'idle_notification')
    assert.strictEqual(notification.from, 'worker')
    assert.strictEqual(notification.idleReason, 'available')
  })

  it('stop handler returns true and does not throw', async () => {
    const teamFile = makeTeamFile({
      name: 'stop-test-2',
      leadAgentId: 'team-lead@stop-test-2',
      members: [
        makeMember({ agentId: 'team-lead@stop-test-2', name: 'team-lead' }),
        makeMember({ agentId: 'worker@stop-test-2', name: 'worker' }),
      ],
    })
    writeTeamFile('stop-test-2', teamFile)

    const setAppState = () => {}
    initializeTeammateHooks(setAppState, 'sess-2', {
      teamName: 'stop-test-2',
      agentId: 'worker@stop-test-2',
      agentName: 'worker',
    })

    const stopHandler = globalThis.__TEAM_COLLAB_STOP_HOOK__
    // Should not throw
    await assert.doesNotReject(stopHandler([]))

    // Verify result independently since doesNotReject returns undefined
    const handler2 = globalThis.__TEAM_COLLAB_STOP_HOOK__
    const result = await handler2([])
    assert.strictEqual(result, true)
  })
})
