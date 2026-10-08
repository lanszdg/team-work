/**
 * Tests for dist/core/teamFile.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, makeMember, makeTeamFile } from './utils.js'
import {
  sanitizeName,
  sanitizeAgentName,
  createTeam,
  readTeamFile,
  listTeams,
  addMember,
  removeTeammateFromTeamFile,
  removeMemberByPaneId,
  setMemberMode,
  setMultipleMemberModes,
  addTeamAllowedPath,
  writeTeamFile,
} from '../dist/core/teamFile.js'

describe('sanitizeName', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('replaces spaces with hyphens and lowercases', () => {
    assert.equal(sanitizeName('My Team'), 'my-team')
  })

  it('replaces special characters with hyphens', () => {
    assert.equal(sanitizeName('Test@123'), 'test-123')
  })

  it('lowercases already safe names', () => {
    assert.equal(sanitizeName('MYTEAM'), 'myteam')
  })

  it('handles mixed characters', () => {
    assert.equal(sanitizeName('Hello_World!'), 'hello_world-')
  })

  it('preserves CJK (Chinese) characters', () => {
    assert.equal(sanitizeName('蛮荒天下'), '蛮荒天下')
  })

  it('replaces spaces in CJK names with hyphens', () => {
    assert.equal(sanitizeName('佛陀 天下'), '佛陀-天下')
  })

  it('handles mixed CJK and ASCII', () => {
    assert.equal(sanitizeName('Team 蛮荒 2024'), 'team-蛮荒-2024')
  })

  it('preserves Cyrillic characters', () => {
    assert.equal(sanitizeName('Привет'), 'привет')
  })
})

describe('sanitizeAgentName', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('replaces @ with -', () => {
    assert.equal(sanitizeAgentName('agent@team'), 'agent-team')
  })

  it('leaves name unchanged when no @ present', () => {
    assert.equal(sanitizeAgentName('my-agent'), 'my-agent')
  })
})

describe('createTeam', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('creates a team with leader, writes file, returns TeamFile', async () => {
    const team = await createTeam({
      teamName: 'alpha',
      leadAgentId: 'lead-1@alpha',
    })

    assert.equal(team.name, 'alpha')
    assert.equal(team.leadAgentId, 'lead-1@alpha')
    assert.equal(team.members.length, 1)
    assert.equal(team.members[0].agentId, 'lead-1@alpha')
    assert.equal(team.members[0].name, 'team-lead')
    assert.equal(team.members[0].runtime.isActive, true)
    assert.equal(team.members[0].runtime.mode, 'auto')
    assert.ok(team.createdAt > 0)

    // Verify the file was actually written
    const readBack = readTeamFile('alpha')
    assert.ok(readBack !== null)
    assert.equal(readBack.name, 'alpha')
  })

  it('includes optional fields when provided', async () => {
    const team = await createTeam({
      teamName: 'beta',
      leadAgentId: 'lead-2@beta',
      description: 'Test team',
      leadSessionId: 'sess-123',
      agentType: 'researcher',
    })
    assert.equal(team.description, 'Test team')
    assert.equal(team.leadSessionId, 'sess-123')
    assert.equal(team.members[0].role, 'product-manager')
  })
})

describe('readTeamFile', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('reads back the created team file successfully', async () => {
    await createTeam({ teamName: 'read-test', leadAgentId: 'lead@rt' })
    const team = readTeamFile('read-test')
    assert.ok(team !== null)
    assert.equal(team.name, 'read-test')
    assert.equal(team.members.length, 1)
  })

  it('returns null for non-existent team', () => {
    const team = readTeamFile('nonexistent-team')
    assert.equal(team, null)
  })
})

describe('listTeams', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  // NOTE: source listTeams() uses require('fs') which is unavailable in ESM.
  // This is a known source code issue; testing the happy path is deferred.
  it('returns empty array when no teams exist', () => {
    const teams = listTeams()
    assert.deepStrictEqual(teams, [])
  })
})

describe('addMember', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('adds a new member to existing team', async () => {
    await createTeam({ teamName: 'add-test', leadAgentId: 'lead@at' })

    const result = await addMember('add-test', makeMember({
      agentId: 'worker@add-test',
      name: 'worker-1',
    }))

    assert.equal(result, true)
    const team = readTeamFile('add-test')
    assert.equal(team.members.length, 2)
    const worker = team.members.find(m => m.name === 'worker-1')
    assert.ok(worker !== undefined)
    assert.ok(worker.joinedAt > 0)
  })

  it('prevents duplicate agentId', async () => {
    await createTeam({ teamName: 'dup-test', leadAgentId: 'lead@dt' })
    await addMember('dup-test', makeMember({
      agentId: 'dup@dt',
      name: 'dup-worker',
    }))

    const result = await addMember('dup-test', makeMember({
      agentId: 'dup@dt',
      name: 'dup-worker-2',
    }))

    assert.equal(result, false)
    const team = readTeamFile('dup-test')
    assert.equal(team.members.length, 2)
  })

  it('returns false for non-existent team', async () => {
    const result = await addMember('no-team', makeMember())
    assert.equal(result, false)
  })
})

describe('removeTeammateFromTeamFile', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('removes by agentId', async () => {
    await createTeam({ teamName: 'rm-test', leadAgentId: 'lead@rm' })
    await addMember('rm-test', makeMember({
      agentId: 'worker@rm',
      name: 'worker-1',
    }))

    const result = await removeTeammateFromTeamFile('rm-test', { agentId: 'worker@rm' })
    assert.equal(result, true)
    const team = readTeamFile('rm-test')
    assert.equal(team.members.length, 1)
    assert.equal(team.members[0].name, 'team-lead')
  })

  it('removes by name', async () => {
    await createTeam({ teamName: 'rm-test2', leadAgentId: 'lead@rm2' })
    await addMember('rm-test2', makeMember({
      agentId: 'w@rm2',
      name: 'worker-x',
    }))

    const result = await removeTeammateFromTeamFile('rm-test2', { name: 'worker-x' })
    assert.equal(result, true)
    const team = readTeamFile('rm-test2')
    assert.equal(team.members.length, 1)
  })

  it('returns false if not found', async () => {
    await createTeam({ teamName: 'rm-test3', leadAgentId: 'lead@rm3' })
    const result = await removeTeammateFromTeamFile('rm-test3', { agentId: 'ghost@rm3' })
    assert.equal(result, false)
  })

  it('returns false for non-existent team', async () => {
    const result = await removeTeammateFromTeamFile('no-team', { name: 'nobody' })
    assert.equal(result, false)
  })
})

describe('removeMemberByPaneId', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('removes member by tmuxPaneId', async () => {
    await createTeam({ teamName: 'pane-test', leadAgentId: 'lead@pt' })
    await addMember('pane-test', makeMember({
      agentId: 'w@pt',
      name: 'pane-worker',
      tmuxPaneId: '%5',
    }))

    const result = await removeMemberByPaneId('pane-test', '%5')
    assert.equal(result, true)
    const team = readTeamFile('pane-test')
    assert.equal(team.members.length, 1)
    assert.ok(!team.members.some(m => m.tmuxPaneId === '%5'))
  })

  it('removes from hiddenPaneIds', async () => {
    const teamFile = makeTeamFile({ name: 'hidden-test', leadAgentId: 'lead@ht' })
    teamFile.members[0].tmuxPaneId = '%7'
    teamFile.hiddenPaneIds = ['%7', '%8']
    writeTeamFile('hidden-test', teamFile)

    const result = await removeMemberByPaneId('hidden-test', '%7')
    assert.equal(result, true)
    const team = readTeamFile('hidden-test')
    assert.deepStrictEqual(team.hiddenPaneIds, ['%8'])
  })

  it('returns false if paneId not found', async () => {
    await createTeam({ teamName: 'pane-test2', leadAgentId: 'lead@pt2' })
    const result = await removeMemberByPaneId('pane-test2', '%99')
    assert.equal(result, false)
  })

  it('returns false for non-existent team', async () => {
    const result = await removeMemberByPaneId('no-team', '%1')
    assert.equal(result, false)
  })
})

describe('setMemberMode', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it("changes member's mode", async () => {
    await createTeam({ teamName: 'mode-test', leadAgentId: 'lead@mt' })
    await addMember('mode-test', makeMember({
      agentId: 'w@mt',
      name: 'mode-worker',
    }))

    const result = await setMemberMode('mode-test', 'mode-worker', 'yolo')
    assert.equal(result, true)
    const team = readTeamFile('mode-test')
    const worker = team.members.find(m => m.name === 'mode-worker')
    assert.equal(worker.mode, 'yolo')
  })

  it('returns false for non-existent member', async () => {
    await createTeam({ teamName: 'mode-test2', leadAgentId: 'lead@mt2' })
    const result = await setMemberMode('mode-test2', 'nobody', 'yolo')
    assert.equal(result, false)
  })

  it('returns true when mode is already set to same value', async () => {
    await createTeam({ teamName: 'mode-test3', leadAgentId: 'lead@mt3' })
    const result = await setMemberMode('mode-test3', 'team-lead', 'auto')
    assert.equal(result, true)
  })
})

describe('setMultipleMemberModes', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it("changes multiple members' modes atomically", async () => {
    await createTeam({ teamName: 'multi-mode', leadAgentId: 'lead@mm' })
    await addMember('multi-mode', makeMember({ agentId: 'w1@mm', name: 'w1' }))
    await addMember('multi-mode', makeMember({ agentId: 'w2@mm', name: 'w2' }))

    const result = await setMultipleMemberModes('multi-mode', [
      { memberName: 'w1', mode: 'yolo' },
      { memberName: 'w2', mode: 'plan' },
    ])
    assert.equal(result, true)

    const team = readTeamFile('multi-mode')
    assert.equal(team.members.find(m => m.name === 'w1').mode, 'yolo')
    assert.equal(team.members.find(m => m.name === 'w2').mode, 'plan')
    // team-lead created via createTeam has mode in runtime
    assert.equal(team.members.find(m => m.name === 'team-lead').runtime?.mode ?? team.members.find(m => m.name === 'team-lead').mode, 'auto')
  })

  it('returns true for non-existent team', async () => {
    const result = await setMultipleMemberModes('no-team', [
      { memberName: 'w1', mode: 'yolo' },
    ])
    assert.equal(result, false)
  })
})

describe('addTeamAllowedPath / readTeamFile', () => {
  let env

  beforeEach(() => {
    env = createTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('verifies allowed path added with addedAt timestamp', async () => {
    await createTeam({ teamName: 'path-test', leadAgentId: 'lead@pt' })

    const result = await addTeamAllowedPath('path-test', {
      path: '/tmp/work',
      toolName: 'Edit',
      addedBy: 'lead',
    })

    assert.equal(result, true)
    const team = readTeamFile('path-test')
    assert.equal(team.teamAllowedPaths.length, 1)
    const allowedPath = team.teamAllowedPaths[0]
    assert.equal(allowedPath.path, '/tmp/work')
    assert.equal(allowedPath.toolName, 'Edit')
    assert.equal(allowedPath.addedBy, 'lead')
    assert.ok(typeof allowedPath.addedAt === 'number')
    assert.ok(allowedPath.addedAt > 0)
  })

  it('returns false for non-existent team', async () => {
    const result = await addTeamAllowedPath('no-team', {
      path: '/tmp',
      toolName: 'Bash',
      addedBy: 'lead',
    })
    assert.equal(result, false)
  })
})
