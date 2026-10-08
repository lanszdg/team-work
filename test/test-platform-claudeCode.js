/**
 * Tests for platform/claude-code.js
 *
 * Tests environment detection, PreToolUse hook handling, and plugin initialization
 * for the Claude Code platform adapter.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, makeMember, makeTeamFile } from './utils.js'
import { writeTeamFile } from '../dist/core/teamFile.js'

test('platform/claude-code', async (t) => {
  const { isClaudeCode, isCoordinatorMode, isTeammate, preToolUseCheck, initializeClaudeCodePlugin } =
    await import('../dist/platform/claude-code.js')

  // ============================================================
  // isClaudeCode()
  // ============================================================

  await t.test('isClaudeCode() returns true when CLAUDE_CODE_AGENT_ID is set', () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_AGENT_ID = 'test-agent'
    assert.strictEqual(isClaudeCode(), true)
    env.cleanup()
  })

  await t.test('isClaudeCode() returns true when CLAUDE_CODE_TEAM_NAME is set', () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_TEAM_NAME = 'my-team'
    assert.strictEqual(isClaudeCode(), true)
    env.cleanup()
  })

  await t.test('isClaudeCode() returns true when CLAUDE_PLUGIN_ROOT is set', () => {
    const env = createTestEnv()
    process.env.CLAUDE_PLUGIN_ROOT = '/some/path'
    assert.strictEqual(isClaudeCode(), true)
    env.cleanup()
  })

  await t.test('isClaudeCode() returns false when none of the env vars are set', () => {
    const env = createTestEnv()
    // createTestEnv already clears these; make sure they are truly empty
    delete process.env.CLAUDE_CODE_AGENT_ID
    delete process.env.CLAUDE_CODE_TEAM_NAME
    delete process.env.CLAUDE_PLUGIN_ROOT
    assert.strictEqual(isClaudeCode(), false)
    env.cleanup()
  })

  // ============================================================
  // isCoordinatorMode()
  // ============================================================

  await t.test('isCoordinatorMode() returns true when CLAUDE_CODE_COORDINATOR_MODE === "1"', () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
    assert.strictEqual(isCoordinatorMode(), true)
    env.cleanup()
  })

  await t.test('isCoordinatorMode() returns false otherwise', () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '0'
    assert.strictEqual(isCoordinatorMode(), false)
    process.env.CLAUDE_CODE_COORDINATOR_MODE = ''
    assert.strictEqual(isCoordinatorMode(), false)
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    assert.strictEqual(isCoordinatorMode(), false)
    env.cleanup()
  })

  // ============================================================
  // isTeammate()
  // ============================================================

  await t.test('isTeammate() returns true when team name set and agent != "team-lead"', () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_TEAM_NAME = 'my-team'
    process.env.CLAUDE_CODE_AGENT_NAME = 'worker-1'
    assert.strictEqual(isTeammate(), true)
    env.cleanup()
  })

  await t.test('isTeammate() returns false when agent === "team-lead"', () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_TEAM_NAME = 'my-team'
    process.env.CLAUDE_CODE_AGENT_NAME = 'team-lead'
    assert.strictEqual(isTeammate(), false)
    env.cleanup()
  })

  await t.test('isTeammate() returns false when team name not set', () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_AGENT_NAME = 'worker-1'
    assert.strictEqual(isTeammate(), false)
    env.cleanup()
  })

  // ============================================================
  // preToolUseCheck()
  // ============================================================

  await t.test('preToolUseCheck() returns true when not in team context', async () => {
    const env = createTestEnv()
    // No CLAUDE_CODE_TEAM_NAME set
    const result = await preToolUseCheck('Write', { file_path: '/src/index.ts' })
    assert.strictEqual(result, true)
    env.cleanup()
  })

  await t.test('preToolUseCheck() returns true when team file not found', async () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_TEAM_NAME = 'nonexistent-team'
    const result = await preToolUseCheck('Write', { file_path: '/src/index.ts' })
    assert.strictEqual(result, true)
    env.cleanup()
  })

  await t.test('preToolUseCheck() returns true when file path matches an allowed path rule', async () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_TEAM_NAME = 'test-team'
    const teamFile = makeTeamFile({
      teamAllowedPaths: [
        { toolName: 'Write', path: '/src' },
      ],
    })
    writeTeamFile('test-team', teamFile)
    const result = await preToolUseCheck('Write', { file_path: '/src/index.ts' })
    assert.strictEqual(result, true)
    env.cleanup()
  })

  await t.test('preToolUseCheck() returns true when no allowed paths configured', async () => {
    const env = createTestEnv()
    process.env.CLAUDE_CODE_TEAM_NAME = 'test-team'
    const teamFile = makeTeamFile({
      teamAllowedPaths: [],
    })
    writeTeamFile('test-team', teamFile)
    const result = await preToolUseCheck('Write', { file_path: '/src/index.ts' })
    assert.strictEqual(result, true)
    env.cleanup()
  })

  // ============================================================
  // initializeClaudeCodePlugin() — standalone mode (early return)
  // ============================================================

  await t.test('initializeClaudeCodePlugin() handles being called without team context (early return)', async () => {
    const env = createTestEnv()
    // Ensure not in Claude Code environment and no team name
    delete process.env.CLAUDE_CODE_AGENT_ID
    delete process.env.CLAUDE_CODE_TEAM_NAME
    delete process.env.CLAUDE_PLUGIN_ROOT

    // Should return early without throwing
    await initializeClaudeCodePlugin()

    // No globals should be set
    assert.strictEqual(globalThis.__TEAM_COLLAB_STATE_UPDATES__, undefined)

    env.cleanup()
  })
})
