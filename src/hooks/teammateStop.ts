/**
 * Teammate Stop Hook
 *
 * Registers a hook that fires when a teammate's session stops.
 * Sends an idle notification to the team leader via cloud messaging.
 *
 * Extracted from open-claude-code src/utils/swarm/teammateInit.ts
 */

import { createIdleNotification } from '../core/messageTypes.js'
import { TEAM_LEAD_NAME } from '../platform/constants.js'
import { MessageDispatcher } from '../core/messageDispatcher.js'
import { readTeamFile, setMemberActive } from '../core/teamFile.js'
import { getTeammateColor } from '../platform/constants.js'

interface TeamInfo {
  teamName: string
  agentId: string
  agentName: string
}

/**
 * Initializes hooks for a teammate running in a swarm.
 * Should be called early in session startup.
 *
 * Registers a Stop hook that sends an idle notification to the team leader
 * when this teammate's session stops.
 */
export function initializeTeammateHooks(
  setAppState: (updater: (prev: unknown) => unknown) => void,
  sessionId: string,
  teamInfo: TeamInfo,
): void {
  const { teamName, agentId, agentName } = teamInfo

  // Read team file to get leader ID
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    console.error(`[TeammateInit] Team file not found for team: ${teamName}`)
    return
  }

  const leadAgentId = teamFile.leadAgentId

  // Apply team-wide allowed paths if any exist
  if (teamFile.teamAllowedPaths && teamFile.teamAllowedPaths.length > 0) {
    console.log(
      `[TeammateInit] Found ${teamFile.teamAllowedPaths.length} team-wide allowed path(s)`,
    )

    for (const allowedPath of teamFile.teamAllowedPaths) {
      // For absolute paths, prepend one / to create //path/** pattern
      // For relative paths, just use path/**
      const ruleContent = allowedPath.path.startsWith('/')
        ? `/${allowedPath.path}/**`
        : `${allowedPath.path}/**`

      console.log(
        `[TeammateInit] Applying team permission: ${allowedPath.toolName} allowed in ${allowedPath.path}`,
      )

      // In a real Claude Code hook, this would call applyPermissionUpdate
      // For the plugin, we store the rules for the adapter to apply
      setAppState(prev => {
        const prevObj = (prev || {}) as Record<string, unknown>
        return {
          ...prevObj,
          teamAllowedPaths: [
            ...((prevObj.teamAllowedPaths as unknown[]) || []),
            {
              toolName: allowedPath.toolName,
              ruleContent,
              behavior: 'allow',
            },
          ],
        }
      })
    }
  }

  // Find the leader's name from the members array
  const leadMember = teamFile.members.find(m => m.agentId === leadAgentId)
  const leadAgentName = leadMember?.name || TEAM_LEAD_NAME

  // Don't register hook if this agent is the leader
  if (agentId === leadAgentId) {
    console.log('[TeammateInit] This agent is the team leader - skipping idle notification hook')
    return
  }

  console.log(
    `[TeammateInit] Registering Stop hook for teammate ${agentName} to notify leader ${leadAgentName}`,
  )

  // Register Stop hook
  // In Claude Code: addFunctionHook(setAppState, sessionId, 'Stop', '', handler)
  // In Open Code: ctx.on('session.stop', handler)
  registerStopHook(setAppState, sessionId, async (messages: unknown[]) => {
    // Mark this teammate as idle
    void setMemberActive(teamName, agentName, false)

    // Send idle notification to the team leader
    const notification = createIdleNotification(agentName, {
      idleReason: 'available',
      summary: extractLastPeerDmSummary(messages),
    })

    await new MessageDispatcher({
      teamName,
      agentName,
      cloudConfig: {
        apiUrl: process.env.TEAM_MEMORY_SYNC_URL || '',
        apiKey: process.env.TEAM_MEMORY_SYNC_API_KEY || '',
        developerId: process.env.CLAUDE_CODE_AGENT_ID || agentId,
      },
    }).sendMessage(leadAgentId, leadAgentName, {
      from: agentName,
      text: JSON.stringify(notification),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(agentName),
      type: 'idle_notification',
    })

    console.log(`[TeammateInit] Sent idle notification to leader ${leadAgentName}`)
    return true // Don't block the Stop
  })
}

/**
 * Platform-agnostic stop hook registration.
 */
function registerStopHook(
  _setAppState: (updater: (prev: unknown) => unknown) => void,
  _sessionId: string,
  handler: (messages: unknown[]) => Promise<boolean>,
): void {
  // Claude Code: addFunctionHook(setAppState, sessionId, 'Stop', '', handler)
  // Open Code: ctx.on('session.stop', () => handler([]))

  // Store handler for the platform adapter to register
  globalThis.__TEAM_COLLAB_STOP_HOOK__ = handler
}

/**
 * Extracts a summary from the last assistant message's SendMessage tool use.
 */
function extractLastPeerDmSummary(messages: unknown[]): string | undefined {
  // Simplified version - real implementation would parse message structure
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any
    if (!msg || msg.type !== 'assistant') continue

    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'SendMessage') {
        const to = block.input?.to
        const summary = block.input?.summary || block.input?.message?.slice(0, 80)
        if (to && to !== '*' && to.toLowerCase() !== TEAM_LEAD_NAME.toLowerCase()) {
          return `[to ${to}] ${summary}`
        }
      }
    }
  }
  return undefined
}

// Global storage for the registered stop hook
declare global {
  var __TEAM_COLLAB_STOP_HOOK__: ((messages: unknown[]) => Promise<boolean>) | undefined
}
