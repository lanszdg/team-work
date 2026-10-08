/**
 * Agent Identity Module
 *
 * Provides a stable agent ID that persists across Claude Code sessions.
 * Without this, each new session gets a different CLAUDE_CODE_AGENT_ID,
 * breaking invitation targeting and task assignment.
 *
 * Resolution order:
 * 1. CLAUDE_CODE_AGENT_ID env var (if manually set to a stable value)
 * 2. Persisted identity from ~/.claude/agent-identity.json
 * 3. Generated from hostname (first time), persisted for future sessions
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { hostname } from 'os'

interface AgentIdentityFile {
  agentId: string
  agentName: string
  createdAt: string
  hostname: string
}

function getIdentityPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '~'
  return join(home, '.claude', 'agent-identity.json')
}

function loadPersistedIdentity(): AgentIdentityFile | null {
  const path = getIdentityPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function persistIdentity(identity: AgentIdentityFile): void {
  const path = getIdentityPath()
  const dir = join(path, '..')
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(identity, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[agentIdentity] Failed to persist identity:', err instanceof Error ? err.message : String(err))
  }
}

function generateAgentName(host: string, shortId: string): string {
  // Sanitize hostname for use in agent names
  const sanitized = host.replace(/[^a-zA-Z0-9-_]/g, '').toLowerCase()
  return `worker-${sanitized}-${shortId}`
}

/**
 * Get a stable agent ID that persists across sessions.
 *
 * - If CLAUDE_CODE_AGENT_ID is set AND matches persisted identity, use it.
 * - If persisted identity exists, return it (ignoring session-specific CLAUDE_CODE_AGENT_ID).
 * - If nothing persisted, generate from hostname + short UUID, persist it.
 */
export function getStableAgentId(): string {
  // Check for persisted identity first
  const persisted = loadPersistedIdentity()
  if (persisted?.agentId) {
    // Also set the env var so downstream code can use it
    process.env.CLAUDE_CODE_AGENT_ID = persisted.agentId
    return persisted.agentId
  }

  // No persisted identity — generate one
  const host = hostname()
  const uuid = randomUUID()
  const shortId = uuid.slice(0, 8)
  const agentId = `worker-${host.toLowerCase()}-${shortId}`
  const agentName = generateAgentName(host, shortId)

  const identity: AgentIdentityFile = {
    agentId,
    agentName,
    createdAt: new Date().toISOString(),
    hostname: host,
  }

  persistIdentity(identity)
  process.env.CLAUDE_CODE_AGENT_ID = agentId

  console.log(`[agentIdentity] Generated stable identity: ${agentId} (persisted to ${getIdentityPath()})`)
  return agentId
}

/**
 * Get the stable agent name. Uses persisted identity or generates one.
 */
export function getStableAgentName(): string {
  const persisted = loadPersistedIdentity()
  if (persisted?.agentName) return persisted.agentName

  // Trigger identity generation
  getStableAgentId()
  const refreshed = loadPersistedIdentity()
  return refreshed?.agentName ?? `worker-${hostname().toLowerCase()}`
}

/**
 * Check if a stable identity has been established.
 */
export function hasStableIdentity(): boolean {
  return loadPersistedIdentity() !== null
}

/**
 * Get the identity file path (for diagnostics).
 */
export function getIdentityFilePath(): string {
  return getIdentityPath()
}
