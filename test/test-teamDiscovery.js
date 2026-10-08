/**
 * Tests for dist/core/teamDiscovery.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, makeMember, makeTeamFile } from './utils.js'
import { createTeam, addMember, writeTeamFile, readTeamFile } from '../dist/core/teamFile.js'
import {
  getTeammateStatuses,
  getTeamSummary,
  isTeammate,
  isTeamLeader,
} from '../dist/core/teamDiscovery.js'

describe('getTeammateStatuses', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('returns teammates excluding team-lead', async () => {
    await createTeam({ teamName: 'status-test', leadAgentId: 'lead@st' })
    await addMember('status-test', makeMember({
      agentId: 'w1@st',
      name: 'worker-1',
      tmuxPaneId: '%1',
    }))
    await addMember('status-test', makeMember({
      agentId: 'w2@st',
      name: 'worker-2',
      tmuxPaneId: '%2',
    }))

    const statuses = getTeammateStatuses('status-test')
    assert.equal(statuses.length, 2)
    assert.ok(!statuses.some(s => s.name === 'team-lead'))
    assert.ok(statuses.some(s => s.name === 'worker-1'))
    assert.ok(statuses.some(s => s.name === 'worker-2'))
  })

  it('correctly maps isActive to status (running vs idle)', async () => {
    await createTeam({ teamName: 'active-test', leadAgentId: 'lead@at' })
    await addMember('active-test', makeMember({
      agentId: 'active@at',
      name: 'active-worker',
      isActive: true,
    }))
    await addMember('active-test', makeMember({
      agentId: 'idle@at',
      name: 'idle-worker',
      isActive: false,
    }))
    await addMember('active-test', makeMember({
      agentId: 'unknown@at',
      name: 'unknown-worker',
    }))

    const statuses = getTeammateStatuses('active-test')
    const active = statuses.find(s => s.name === 'active-worker')
    const idle = statuses.find(s => s.name === 'idle-worker')
    const unknown = statuses.find(s => s.name === 'unknown-worker')

    assert.equal(active.status, 'running')
    assert.equal(idle.status, 'idle')
    assert.equal(unknown.status, 'running') // isActive undefined defaults to running
  })

  it('returns empty array for non-existent team', () => {
    const statuses = getTeammateStatuses('nonexistent')
    assert.deepStrictEqual(statuses, [])
  })
})

describe('getTeamSummary', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('returns correct memberCount, runningCount, idleCount', async () => {
    await createTeam({ teamName: 'summary-test', leadAgentId: 'lead@st' })
    await addMember('summary-test', makeMember({
      agentId: 'r1@st', name: 'running-1', isActive: true,
    }))
    await addMember('summary-test', makeMember({
      agentId: 'r2@st', name: 'running-2', isActive: true,
    }))
    await addMember('summary-test', makeMember({
      agentId: 'i1@st', name: 'idle-1', isActive: false,
    }))

    const summary = getTeamSummary('summary-test')
    assert.ok(summary !== null)
    assert.equal(summary.memberCount, 3)
    assert.equal(summary.runningCount, 2)
    assert.equal(summary.idleCount, 1)
  })

  it('returns null for non-existent team', () => {
    const summary = getTeamSummary('no-team')
    assert.equal(summary, null)
  })
})

describe('isTeammate', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('returns true when CLAUDE_CODE_TEAM_NAME set and agent != team-lead', () => {
    process.env.CLAUDE_CODE_TEAM_NAME = 'some-team'
    process.env.CLAUDE_CODE_AGENT_NAME = 'worker-1'
    assert.equal(isTeammate(), true)
  })

  it('returns false when agent == team-lead', () => {
    process.env.CLAUDE_CODE_TEAM_NAME = 'some-team'
    process.env.CLAUDE_CODE_AGENT_NAME = 'team-lead'
    assert.equal(isTeammate(), false)
  })

  it('returns false when CLAUDE_CODE_TEAM_NAME not set', () => {
    process.env.CLAUDE_CODE_TEAM_NAME = ''
    process.env.CLAUDE_CODE_AGENT_NAME = 'worker-1'
    assert.equal(isTeammate(), false)
  })
})

describe('isTeamLeader', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('returns true when agent == team-lead and team name set', () => {
    process.env.CLAUDE_CODE_TEAM_NAME = 'my-team'
    process.env.CLAUDE_CODE_AGENT_NAME = 'team-lead'
    assert.equal(isTeamLeader(), true)
  })

  it('returns false when agent != team-lead', () => {
    process.env.CLAUDE_CODE_TEAM_NAME = 'my-team'
    process.env.CLAUDE_CODE_AGENT_NAME = 'worker-1'
    assert.equal(isTeamLeader(), false)
  })

  it('returns false when team name not set', () => {
    process.env.CLAUDE_CODE_TEAM_NAME = ''
    process.env.CLAUDE_CODE_AGENT_NAME = 'team-lead'
    assert.equal(isTeamLeader(), false)
  })
})
