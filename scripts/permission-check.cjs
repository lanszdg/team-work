#!/usr/bin/env node
/**
 * Permission Check Script for PreToolUse Hook
 *
 * Called by hooks/hooks.json when PreToolUse fires for Bash, Write, or Edit tools.
 * Checks team-wide allowed paths and file locks before allowing tool execution.
 *
 * Exit Codes:
 *   0 - Permission granted, tool can execute
 *   1 - Permission denied, tool execution blocked
 *
 * Environment Variables (injected by hooks.json):
 *   TEAM_NAME    - Current team name (CLAUDE_CODE_TEAM_NAME)
 *   AGENT_NAME   - Current agent name (CLAUDE_CODE_AGENT_NAME)
 *   CLAUDE_PLUGIN_DATA - Plugin data directory
 *
 * Input:
 *   Reads tool name and input from stdin as JSON:
 *   {"tool": "Edit", "input": {"file_path": "/path/to/file.ts", "old_string": "...", "new_string": "..."}}
 */

'use strict'

// ============================================================
// Configuration
// ============================================================

const TEAM_NAME = process.env.TEAM_NAME || process.env.CLAUDE_CODE_TEAM_NAME
const AGENT_NAME = process.env.AGENT_NAME || process.env.CLAUDE_CODE_AGENT_NAME || 'team-lead'
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || process.env.HOME + '/.claude/plugins/data/team-collab'
const TEAMS_DIR = PLUGIN_DATA + '/teams'

// ============================================================
// Path Resolution
// ============================================================

function sanitizeName(name) {
  // Preserve Unicode letters (including CJK, Cyrillic, Arabic)
  return name.replace(/[^\p{L}\p{N}]/gu, '-').toLowerCase()
}

function getConfigPath() {
  if (!TEAM_NAME) return null
  return `${TEAMS_DIR}/${sanitizeName(TEAM_NAME)}/config.json`
}

// ============================================================
// Permission Checking
// ============================================================

/**
 * Checks if a file path is allowed based on team configuration.
 */
function checkFilePermission(filePath, toolName) {
  if (!TEAM_NAME) {
    // Not in a team context - allow
    return { allowed: true, reason: 'Not in team context' }
  }

  const fs = require('fs')
  const configPath = getConfigPath()

  if (!configPath || !fs.existsSync(configPath)) {
    return { allowed: true, reason: 'Team config not found' }
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content)

    // Check team-wide allowed paths
    if (config.teamAllowedPaths && config.teamAllowedPaths.length > 0) {
      for (const rule of config.teamAllowedPaths) {
        if (rule.toolName !== toolName) continue

        const rulePath = rule.path.startsWith('/') ? rule.path : '/' + rule.path
        if (filePath.startsWith(rulePath) || filePath.startsWith(rulePath.slice(1))) {
          return { allowed: true, reason: `Allowed by team rule: ${rulePath}` }
        }
      }
    }

    // Check if the file is in the current working directory (implicit allow)
    const cwd = process.cwd()
    if (filePath.startsWith(cwd)) {
      return { allowed: true, reason: 'File in current working directory' }
    }

    // Check if the agent is the team leader (leaders have implicit permission)
    if (AGENT_NAME === 'team-lead') {
      return { allowed: true, reason: 'Team leader has implicit permission' }
    }

    // No matching rule found
    return {
      allowed: false,
      reason: `No team permission rule allows ${toolName} for "${filePath}". Add a team-allowed path or contact the team leader.`,
    }
  } catch (e) {
    // If config is unreadable, default to allow (fail open)
    return { allowed: true, reason: `Config read error: ${e.message}` }
  }
}

// ============================================================
// Cloud File Lock Check (Optional)
// ============================================================

/**
 * Checks if a file is locked by another teammate via the cloud sync server.
 * This is optional and requires the L2 sync server to be configured.
 */
async function checkCloudFileLock(filePath) {
  const syncApiUrl = process.env.TEAM_COLLAB_SYNC_URL
  const syncAuthToken = process.env.TEAM_COLLAB_SYNC_TOKEN

  if (!syncApiUrl || !syncAuthToken) {
    return { locked: false, reason: 'No sync server configured' }
  }

  try {
    const response = await fetch(`${syncApiUrl}/api/locks/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${syncAuthToken}`,
      },
      body: JSON.stringify({
        filePath,
        agentName: AGENT_NAME,
        teamName: TEAM_NAME,
      }),
    })

    if (!response.ok) {
      return { locked: false, reason: `Lock check API error: ${response.status}` }
    }

    const result = await response.json()
    return result
  } catch (e) {
    return { locked: false, reason: `Lock check failed: ${e.message}` }
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  // Read tool info from stdin or command line args
  let toolName, toolInput

  // Try reading from stdin first
  const stdinData = await new Promise((resolve) => {
    let data = ''
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    // Timeout after 100ms (stdin might be empty)
    setTimeout(() => resolve(''), 100)
  })

  if (stdinData) {
    try {
      const parsed = JSON.parse(stdinData)
      toolName = parsed.tool
      toolInput = parsed.input
    } catch {
      // Not valid JSON, try command line args
    }
  }

  // Fallback to environment variables
  toolName = toolName || process.env.CLAUDE_TOOL_NAME || ''
  toolInput = toolInput || JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}')

  if (!toolName) {
    // No tool info available - allow by default
    process.exit(0)
  }

  // Extract file path from tool input
  let filePath = null
  if (toolInput.file_path) {
    filePath = toolInput.file_path
  } else if (toolInput.command) {
    // Extract file path from bash command (simplified)
    const match = toolInput.command.match(/[\/\w.-]+\.\w+/)
    if (match) filePath = match[0]
  }

  if (!filePath) {
    // No file path involved - allow
    process.exit(0)
  }

  // Check permissions
  const result = checkFilePermission(filePath, toolName)

  if (!result.allowed) {
    // Output denial message to stderr for debugging
    process.stderr.write(`[PermissionCheck] DENIED: ${result.reason}\n`)
    process.exit(1)
  }

  // Check cloud file lock (async, but we wait for it)
  try {
    const lockResult = await checkCloudFileLock(filePath)
    if (lockResult.locked) {
      process.stderr.write(
        `[PermissionCheck] DENIED: File locked by ${lockResult.lockedBy} since ${lockResult.lockedAt}\n`
      )
      process.exit(1)
    }
  } catch {
    // Lock check failed - allow by default (fail open)
  }

  // All checks passed
  process.exit(0)
}

main().catch(e => {
  process.stderr.write(`[PermissionCheck] Error: ${e.message}\n`)
  process.exit(0) // Fail open on errors
})
