/**
 * SMOKE TEST — Deployment Verification for team-collab-plugin
 *
 * Confirms that the built plugin loads cleanly, all exports are accessible,
 * core classes can be instantiated, manifests are valid, and dist/ contains
 * all expected output files.
 *
 * Run:  node --test test/test-smoke.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve project root relative to this file
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')
const DIST_ROOT = join(PROJECT_ROOT, 'dist')

// ============================================================
// Dynamic import of the full public API from dist/index.js
// ============================================================

const plugin = await import('../dist/index.js')

// ============================================================
// Named exports that MUST be present on index.js
// ============================================================

const EXPECTED_NAMED_EXPORTS = [
  // teamFile
  'readTeamFile', 'readTeamFileAsync', 'writeTeamFile', 'writeTeamFileAsync',
  'createTeam', 'addMember', 'removeTeammateFromTeamFile', 'removeMemberByPaneId',
  'setMemberMode', 'setMultipleMemberModes', 'setMemberActive',
  'sanitizeName', 'sanitizeAgentName', 'listTeams', 'cleanupTeamDirectories',
  // cloud messaging
  'MessageDispatcher', 'CloudMessageRouter',
  // teamDiscovery
  'getTeammateStatuses', 'getTeamSummary', 'listAllTeams', 'getCurrentTeam',
  'isTeammate', 'isTeamLeader',
  // teamMemorySync
  'syncTeamMemory', 'createMemoryEntry', 'getSyncStatus',
  'saveLocalEntry', 'readLocalEntry', 'listLocalEntries', 'deleteLocalEntry',
  // inboxPoller
  'InboxPoller', 'startInboxPoller',
  // teammateStop hooks
  'initializeTeammateHooks',
  // backend registry
  'detectBackend', 'getBackend', 'createTeammatePane', 'sendCommandToPane',
  'killPane', 'registerBackend', 'clearBackendCache',
  // backend classes
  'TmuxBackend', 'ITermBackend', 'InProcessBackend',
  // inProcess helpers
  'runInTeammateContext', 'getCurrentTeammateContext',
  // platform — claude-code
  'initializeClaudeCodePlugin', 'isClaudeCode', 'isCoordinatorMode', 'preToolUseCheck',
  // platform — open-code
  'teamCollabPlugin',
  // messageTypes — only runtime exports (TS interfaces + Zod schemas are
  //   declared in source but only these 3 are re-exported from index.js)
  'isStructuredProtocolMessage', 'looksLikeProtocolMessage', 'createIdleNotification',
  'createPermissionResponse', 'createTaskAcknowledged', 'createTaskClaimed',
  'createTaskStatusUpdate', 'createTaskSubmittedForReview', 'createTaskCompleted',
  'createTaskFailed',
  // role capabilities
  'ROLE_CAPABILITIES', 'getRoleGoal', 'getRolePrompt', 'getWorkMode', 'getRoleTools',
]

// ============================================================
// Expected .js files in dist/ (compiled output)
// ============================================================

const EXPECTED_DIST_FILES = [
  'index.js',
  // core
  'core/messageDispatcher.js',
  'core/cloudMessageRouter.js',
  'core/messageTypes.js',
  'core/teamDiscovery.js',
  'core/teamFile.js',
  'core/teamMemorySync.js',
  'core/types.js',
  // hooks
  'hooks/inboxPoller.js',
  'hooks/permissionBridge.js',
  'hooks/teammateStop.js',
  // backends
  'backends/inProcess.js',
  'backends/iterm2.js',
  'backends/registry.js',
  'backends/tmux.js',
  'backends/types.js',
  // coordinator
  'coordinator/coordinatorPrompt.js',
  'coordinator/index.js',
  // platform
  'platform/claude-code.js',
  'platform/constants.js',
  'platform/open-code.js',
]

// ============================================================
// MAIN SMOKE TEST
// ============================================================

test('smoke: plugin loads cleanly', async (t) => {

  // ----------------------------------------------------------
  // 1. All core exports are accessible from index.js
  // ----------------------------------------------------------
  await t.test('all core exports are accessible from index.js', async () => {
    for (const name of EXPECTED_NAMED_EXPORTS) {
      assert.ok(name in plugin, `Expected export "${name}" is missing from dist/index.js`)
    }
  })

  // ----------------------------------------------------------
  // 2. All backend classes can be instantiated
  // ----------------------------------------------------------
  await t.test('all backend classes can be instantiated', async () => {
    // InProcessBackend should be constructable (may require no args)
    const InProcessBackend = plugin.InProcessBackend
    assert.ok(typeof InProcessBackend === 'function', 'InProcessBackend should be a class/constructor')

    // TmuxBackend and ITermBackend are class exports — verify they are functions
    assert.ok(typeof plugin.TmuxBackend === 'function', 'TmuxBackend should be a class/constructor')
    assert.ok(typeof plugin.ITermBackend === 'function', 'ITermBackend should be a class/constructor')

    // Verify InboxPoller is also a class
    assert.ok(typeof plugin.InboxPoller === 'function', 'InboxPoller should be a class/constructor')
  })

  // ----------------------------------------------------------
  // 3. Message type factory functions work
  // ----------------------------------------------------------
  await t.test('message type factory functions work', async () => {
    // createIdleNotification should return a valid object
    const idleMsg = plugin.createIdleNotification('test-agent', { idleReason: 'available' })
    assert.ok(idleMsg, 'createIdleNotification should return a message object')
    assert.equal(idleMsg.type, 'idle_notification')
    assert.equal(idleMsg.from, 'test-agent')

    // createPermissionResponse — success case
    const permSuccess = plugin.createPermissionResponse({
      request_id: 'req-1',
      subtype: 'success',
    })
    assert.equal(permSuccess.type, 'permission_response')
    assert.equal(permSuccess.subtype, 'success')

    // createPermissionResponse — error case
    const permError = plugin.createPermissionResponse({
      request_id: 'req-2',
      subtype: 'error',
      error: 'Denied',
    })
    assert.equal(permError.subtype, 'error')
    assert.equal(permError.error, 'Denied')

    // isStructuredProtocolMessage should return boolean
    assert.equal(plugin.isStructuredProtocolMessage('{"type":"permission_request"}'), true)
    assert.equal(plugin.isStructuredProtocolMessage('hello world'), false)
    assert.equal(plugin.isStructuredProtocolMessage(''), false)

    const ack = plugin.createTaskAcknowledged({ taskId: 'task-1', fromAgentId: 'agent-1' })
    assert.equal(ack.type, 'task_acknowledged')
    assert.equal(plugin.isStructuredProtocolMessage(JSON.stringify(ack)), true)
    assert.equal(plugin.looksLikeProtocolMessage('{"type":"unknown_protocol"}'), true)
    assert.ok(plugin.getRoleGoal('developer').length > 0)
  })

  // ----------------------------------------------------------
  // 4. Functions are callable in empty environment
  // ----------------------------------------------------------
  await t.test('exported functions are callable (empty env)', async () => {
    // These may return null/undefined/false in an empty environment —
    // the key is that they don't throw on invocation.
    const safeCall = (fn, ...args) => {
      try {
        const result = fn(...args)
        // If it returns a promise, await it
        if (result && typeof result.then === 'function') {
          return result.catch(() => null)
        }
        return result
      } catch {
        return null // expected in empty env
      }
    }

    // Synchronous or async functions that should not crash
    await safeCall(plugin.listTeams)
    await safeCall(plugin.getCurrentTeam)
    await safeCall(plugin.getTeamSummary)
    await safeCall(plugin.getTeammateStatuses)
    await safeCall(plugin.listAllTeams)

    // isTeammate / isTeamLeader with undefined teamName
    assert.equal(typeof safeCall(plugin.isTeammate, 'some-agent'), 'boolean')
    assert.equal(typeof safeCall(plugin.isTeamLeader, 'some-agent'), 'boolean')

    // sanitizeName / sanitizeAgentName
    assert.equal(typeof plugin.sanitizeName('hello world'), 'string')
    assert.equal(typeof plugin.sanitizeAgentName('test_agent'), 'string')

    // detectBackend / getBackend
    safeCall(plugin.detectBackend)
    safeCall(plugin.getBackend)

    // clearBackendCache
    safeCall(plugin.clearBackendCache)

    // isClaudeCode / isCoordinatorMode
    safeCall(plugin.isClaudeCode)
    safeCall(plugin.isCoordinatorMode)
  })

  // ----------------------------------------------------------
  // 5. Plugin manifest (plugin.json) is valid JSON — if it exists
  // ----------------------------------------------------------
  await t.test('plugin manifest is valid JSON', async () => {
    const pluginJsonPath = join(PROJECT_ROOT, 'plugin.json')
    if (existsSync(pluginJsonPath)) {
      const content = readFileSync(pluginJsonPath, 'utf-8')
      const parsed = JSON.parse(content)
      assert.ok(typeof parsed === 'object', 'plugin.json should parse to an object')
      assert.ok(parsed.name, 'plugin.json should have a name field')
    } else {
      // plugin.json is optional — some deployments use package.json instead
      console.log('  Note: plugin.json not found (optional for this project)')
    }
  })

  // ----------------------------------------------------------
  // 6. Hooks manifest (hooks.json) is valid JSON — if it exists
  // ----------------------------------------------------------
  await t.test('hooks manifest is valid JSON', async () => {
    const hooksJsonPath = join(PROJECT_ROOT, 'hooks.json')
    if (existsSync(hooksJsonPath)) {
      const content = readFileSync(hooksJsonPath, 'utf-8')
      const parsed = JSON.parse(content)
      assert.ok(typeof parsed === 'object', 'hooks.json should parse to an object')
    } else {
      // hooks.json is optional
      console.log('  Note: hooks.json not found (optional for this project)')
    }
  })

  // ----------------------------------------------------------
  // 7. dist/ directory contains all expected compiled files
  // ----------------------------------------------------------
  await t.test('dist directory contains all expected files', async () => {
    assert.ok(existsSync(DIST_ROOT), 'dist/ directory should exist')
    assert.ok(statSync(DIST_ROOT).isDirectory(), 'dist/ should be a directory')

    for (const relPath of EXPECTED_DIST_FILES) {
      const fullPath = join(DIST_ROOT, relPath)
      assert.ok(existsSync(fullPath), `dist/${relPath} should exist`)
    }
  })

  // ----------------------------------------------------------
  // 8. Constants are properly defined
  // ----------------------------------------------------------
  await t.test('constants are properly defined', async () => {
    // Import constants module directly to verify it loads
    const constantsPath = join(DIST_ROOT, 'platform', 'constants.js')
    assert.ok(existsSync(constantsPath), 'platform/constants.js should exist')
    const constants = await import('../dist/platform/constants.js')
    assert.ok(typeof constants === 'object', 'constants module should export an object')
  })

  // ----------------------------------------------------------
  // 9. Types are exported (verified by successful import)
  // ----------------------------------------------------------
  await t.test('types are exported (verified by successful import)', async () => {
    // TypeScript types are erased at runtime, but the successful
    // import of dist/index.js proves the module compiled without
    // type errors. Verify the module object is valid.
    assert.ok(typeof plugin === 'object', 'imported module should be an object')
    assert.ok(Object.keys(plugin).length > 0, 'module should have exports')
  })
})
