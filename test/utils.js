/**
 * Shared test utilities.
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, existsSync } from 'fs'

/**
 * Creates an isolated test environment directory under OS temp.
 * Sets CLAUDE_PLUGIN_DATA so all plugin modules write there.
 */
export function createTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'team-collab-test-'))
  const origEnv = { ...process.env }
  process.env.CLAUDE_PLUGIN_DATA = dir
  process.env.CLAUDE_CODE_TEAM_NAME = ''
  process.env.CLAUDE_CODE_AGENT_NAME = ''
  process.env.CLAUDE_CODE_AGENT_ID = ''
  // Force local-only mode for unit tests — cloud routing is tested separately
  delete process.env.TEAM_MEMORY_SYNC_URL
  return { dir, cleanup: () => cleanupEnv(dir, origEnv) }
}

function cleanupEnv(dir, origEnv) {
  process.env.CLAUDE_PLUGIN_DATA = origEnv.CLAUDE_PLUGIN_DATA || ''
  process.env.CLAUDE_CODE_TEAM_NAME = origEnv.CLAUDE_CODE_TEAM_NAME || ''
  process.env.CLAUDE_CODE_AGENT_NAME = origEnv.CLAUDE_CODE_AGENT_NAME || ''
  process.env.CLAUDE_CODE_AGENT_ID = origEnv.CLAUDE_CODE_AGENT_ID || ''
  if (origEnv.TEAM_MEMORY_SYNC_URL) process.env.TEAM_MEMORY_SYNC_URL = origEnv.TEAM_MEMORY_SYNC_URL
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Returns a proper team member object (fills required fields).
 */
export function makeMember(overrides = {}) {
  return {
    agentId: 'test-agent@default',
    name: 'test-agent',
    tmuxPaneId: '%1',
    cwd: process.cwd(),
    subscriptions: [],
    ...overrides,
  }
}

/**
 * Returns a complete team file for testing.
 */
export function makeTeamFile(overrides = {}) {
  return {
    name: 'test-team',
    createdAt: Date.now(),
    leadAgentId: 'team-lead@default',
    members: [
      {
        agentId: 'team-lead@default',
        name: 'team-lead',
        tmuxPaneId: '%0',
        cwd: process.cwd(),
        subscriptions: [],
        isActive: true,
        mode: 'auto',
        ...overrides.lead,
      },
    ],
    hiddenPaneIds: [],
    teamAllowedPaths: [],
    ...overrides,
  }
}
