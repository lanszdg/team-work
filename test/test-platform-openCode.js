/**
 * Tests for platform/open-code.js
 *
 * Tests plugin metadata, setup flow, and file-path utilities
 * for the Open Code platform adapter.
 *
 * Note: setup() starts a setInterval via InboxPoller, so tests use
 * --test-force-exit (or clear intervals) to avoid hanging.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, makeTeamFile, makeMember } from './utils.js'
import { writeTeamFile } from '../dist/core/teamFile.js'
import { teamCollabPlugin } from '../dist/platform/open-code.js'

/**
 * Creates a mock Open Code PluginContext.
 * The event subscribe iterator yields once then completes so that
 * subscribeToEvents() returns (instead of hanging on for-await forever).
 */
function createMockCtx(options = {}) {
  const logs = options.logs || []
  return {
    client: {
      session: {
        prompt: async () => {},
      },
      event: {
        subscribe: (eventType) => {
          logs.push(`subscribe:${eventType}`)
          // Return an async iterable that yields one event then completes
          // so the for-await loop in subscribeToEvents() exits.
          const items = [
            { type: 'file.edited', data: { filePath: '/test/a.ts', editedBy: 'test-agent' } },
          ]
          let index = 0
          return {
            async next() {
              if (index < items.length) {
                return { done: false, value: items[index++] }
              }
              // After yielding items, throw to exit the for-await cleanly
              // (caught by the try/catch inside subscribeToEvents)
              throw new Error('stream closed')
            },
            [Symbol.asyncIterator]() {
              return this
            },
          }
        },
      },
      tui: {
        toast: {
          show: async (options) => {
            logs.push(`toast:${options.variant}:${options.message}`)
          },
        },
      },
    },
    project: { id: 'test-project', path: '/test/project' },
    directory: '/test/plugin-dir',
  }
}

/**
 * Clear all intervals/setTimers to let the test process exit cleanly.
 * InboxPoller.start() calls setInterval internally and we don't have
 * access to the interval IDs. We override setInterval/setTimeout to track them.
 */
const _trackedTimers = []
const _origSetInterval = globalThis.setInterval
const _origSetTimeout = globalThis.setTimeout
globalThis.setInterval = (...args) => {
  const id = _origSetInterval(...args)
  _trackedTimers.push(id)
  return id
}
globalThis.setTimeout = (...args) => {
  const id = _origSetTimeout(...args)
  _trackedTimers.push(id)
  return id
}

function clearAllTimers() {
  for (const id of _trackedTimers) {
    clearInterval(id)
    clearTimeout(id)
  }
  _trackedTimers.length = 0
}

test('platform/open-code', async (t) => {
  // ============================================================
  // teamCollabPlugin metadata
  // ============================================================

  await t.test('teamCollabPlugin has correct metadata', () => {
    assert.strictEqual(teamCollabPlugin.name, 'team-collab')
    assert.strictEqual(teamCollabPlugin.version, '1.0.0')
    assert.strictEqual(teamCollabPlugin.description, '多智能体团队协作插件 - 支持 Agent Swarm 模式')
  })

  // ============================================================
  // teamCollabPlugin.setup() — logs and registers interceptor, subscribes to events, starts polling
  // ============================================================

  await t.test('teamCollabPlugin.setup() logs and registers interceptor, subscribes to events, starts polling', async () => {
    const env = createTestEnv()

    const logs = []
    const mockCtx = createMockCtx({ logs })

    // Capture console.log
    const originalLog = console.log
    const consoleLogs = []
    console.log = (...args) => consoleLogs.push(args.join(' '))

    try {
      await teamCollabPlugin.setup(mockCtx)

      // Verify the tool interceptor was registered
      assert.ok(
        typeof globalThis.__TEAM_COLLAB_TOOL_INTERCEPTOR__ === 'function',
        'tool interceptor should be registered on globalThis',
      )

      // Verify console logs
      const joined = consoleLogs.join('\n')
      assert.ok(
        joined.includes('Open Code plugin loaded'),
        'should log plugin loaded',
      )
      assert.ok(
        joined.includes('Registered tool.execute.before interceptor'),
        'should log interceptor registration',
      )
      assert.ok(
        joined.includes('Open Code plugin setup complete'),
        'should log setup complete',
      )

      // Verify event subscription was attempted
      assert.ok(
        logs.includes('subscribe:file.edited'),
        'should subscribe to file.edited event',
      )
    } finally {
      console.log = originalLog
      env.cleanup()
      clearAllTimers()
    }
  })

  // ============================================================
  // teamCollabPlugin.setup() — does NOT initialize teammate hooks when agent is team-lead
  // ============================================================

  await t.test('teamCollabPlugin.setup() does NOT initialize teammate hooks when agent is team-lead', async () => {
    const env = createTestEnv()
    process.env.TEAM_NAME = 'test-team'
    process.env.AGENT_NAME = 'team-lead'

    // Create a team file so the plugin can read it
    const teamFile = makeTeamFile()
    writeTeamFile('test-team', teamFile)

    // Clear any previous state
    delete globalThis.__TEAM_COLLAB_STOP_HOOK__

    const mockCtx = createMockCtx()

    const originalLog = console.log
    console.log = () => {}

    try {
      await teamCollabPlugin.setup(mockCtx)

      // Teammate hooks should NOT be set for team-lead
      assert.strictEqual(
        globalThis.__TEAM_COLLAB_STOP_HOOK__,
        undefined,
        'stop hook should not be set for team-lead',
      )
    } finally {
      console.log = originalLog
      env.cleanup()
      clearAllTimers()
    }
  })

  // ============================================================
  // teamCollabPlugin.setup() — DOES initialize teammate hooks when agent is NOT team-lead
  // ============================================================

  await t.test('teamCollabPlugin.setup() DOES initialize teammate hooks when agent is NOT team-lead', async () => {
    const env = createTestEnv()
    process.env.TEAM_NAME = 'test-team'
    process.env.AGENT_NAME = 'worker-1'
    process.env.AGENT_ID = 'worker-1@default'

    // Create a team file with a lead and the teammate
    const teamFile = makeTeamFile({
      members: [
        {
          agentId: 'team-lead@default',
          name: 'team-lead',
          tmuxPaneId: '%0',
          cwd: process.cwd(),
          subscriptions: [],
          isActive: true,
          mode: 'auto',
        },
        makeMember({ agentId: 'worker-1@default', name: 'worker-1' }),
      ],
    })
    writeTeamFile('test-team', teamFile)

    // Clear any previous state
    delete globalThis.__TEAM_COLLAB_STOP_HOOK__

    const mockCtx = createMockCtx()

    const originalLog = console.log
    console.log = () => {}

    try {
      await teamCollabPlugin.setup(mockCtx)

      // Teammate hooks SHOULD be set for non-team-lead
      assert.ok(
        typeof globalThis.__TEAM_COLLAB_STOP_HOOK__ === 'function',
        'stop hook should be set for non-team-lead agent',
      )
    } finally {
      console.log = originalLog
      env.cleanup()
      clearAllTimers()
    }
  })

  // ============================================================
  // extractFilePathOpenCode() — tested via the tool interceptor
  // ============================================================

  await t.test('extractFilePathOpenCode() returns file_path for edit/write tools, null for bash', async () => {
    // We test this by invoking the registered tool interceptor directly,
    // since extractFilePathOpenCode is internal but the interceptor uses it.

    const env = createTestEnv()
    process.env.TEAM_NAME = 'test-team'

    const teamFile = makeTeamFile({
      teamAllowedPaths: [
        { toolName: 'edit', path: '/src' },
        { toolName: 'write', path: '/docs' },
      ],
    })
    writeTeamFile('test-team', teamFile)

    // Register the interceptor by running setup
    const mockCtx = createMockCtx()

    const originalLog = console.log
    console.log = () => {}

    try {
      await teamCollabPlugin.setup(mockCtx)
      const interceptor = globalThis.__TEAM_COLLAB_TOOL_INTERCEPTOR__
      assert.ok(typeof interceptor === 'function')

      // "edit" with a matching file path — should NOT throw
      await interceptor('edit', { file_path: '/src/index.ts' })

      // "write" with a matching file path — should NOT throw
      await interceptor('write', { file_path: '/docs/readme.md' })

      // "bash" — should NOT throw (extractFilePathOpenCode returns null for bash,
      // so the path check is skipped)
      await interceptor('bash', { command: 'ls /src' })

      // "edit" with a non-matching file path — SHOULD throw
      await assert.rejects(
        () => interceptor('edit', { file_path: '/secret/config.json' }),
        /未被团队允许路径覆盖/,
      )
    } finally {
      console.log = originalLog
      env.cleanup()
      clearAllTimers()
    }
  })

  // ============================================================
  // pathMatchesRuleOpenCode() — absolute path matching
  // ============================================================

  await t.test('pathMatchesRuleOpenCode() absolute path matching', async () => {
    const env = createTestEnv()
    process.env.TEAM_NAME = 'test-team'

    const teamFile = makeTeamFile({
      teamAllowedPaths: [
        { toolName: 'edit', path: '/mnt/d/project/src' },
      ],
    })
    writeTeamFile('test-team', teamFile)

    const mockCtx = createMockCtx()

    const originalLog = console.log
    console.log = () => {}

    try {
      await teamCollabPlugin.setup(mockCtx)
      const interceptor = globalThis.__TEAM_COLLAB_TOOL_INTERCEPTOR__

      // Path starting with the absolute rule should be allowed
      await interceptor('edit', { file_path: '/mnt/d/project/src/index.ts' })
      await interceptor('edit', { file_path: '/mnt/d/project/src/utils/helper.js' })

      // Path not starting with the absolute rule should be blocked
      await assert.rejects(
        () => interceptor('edit', { file_path: '/mnt/c/other/index.ts' }),
        /未被团队允许路径覆盖/,
      )
    } finally {
      console.log = originalLog
      env.cleanup()
      clearAllTimers()
    }
  })

  // ============================================================
  // pathMatchesRuleOpenCode() — relative path matching
  // ============================================================

  await t.test('pathMatchesRuleOpenCode() relative path matching', async () => {
    const env = createTestEnv()
    process.env.TEAM_NAME = 'test-team'

    const teamFile = makeTeamFile({
      teamAllowedPaths: [
        { toolName: 'write', path: 'src/index.ts' },
      ],
    })
    writeTeamFile('test-team', teamFile)

    const mockCtx = createMockCtx()

    const originalLog = console.log
    console.log = () => {}

    try {
      await teamCollabPlugin.setup(mockCtx)
      const interceptor = globalThis.__TEAM_COLLAB_TOOL_INTERCEPTOR__

      // Path ending with the relative rule should be allowed
      await interceptor('write', { file_path: '/home/user/project/src/index.ts' })

      // Replace team file with a directory-level relative rule
      const teamFile2 = makeTeamFile({
        teamAllowedPaths: [
          { toolName: 'write', path: 'src' },
        ],
      })
      writeTeamFile('test-team', teamFile2)

      // Path containing the rule as a directory segment should be allowed
      await interceptor('write', { file_path: '/home/user/project/src/utils.ts' })

      // Path not matching should be blocked
      await assert.rejects(
        () => interceptor('write', { file_path: '/home/user/project/lib/utils.ts' }),
        /未被团队允许路径覆盖/,
      )
    } finally {
      console.log = originalLog
      env.cleanup()
      clearAllTimers()
    }
  })
})
