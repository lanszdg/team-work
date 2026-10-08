/**
 * Claude Code Platform Adapter
 *
 * Adapts the team collaboration core for Claude Code's plugin system.
 * Handles:
 * - PreToolUse hooks for permission interception
 * - Monitor scripts with debouncing for token-efficient wake-ups
 * - Skill registration (Markdown-based)
 * - Environment variable injection
 *
 * Architecture notes from open-claude-code:
 * - Hooks are registered via hooks.json (declarative)
 * - Monitors run as background processes, output to stdout triggers rewake
 * - Skills are Markdown files at the plugin root level (NOT inside .claude-plugin/)
 */

import { readTeamFile, listTeams } from '../core/teamFile.js'
import { isStructuredProtocolMessage } from '../core/messageTypes.js'
import { TEAM_LEAD_NAME } from './constants.js'
import { InboxPoller } from '../hooks/inboxPoller.js'
import { initializeTeammateHooks } from '../hooks/teammateStop.js'
import type { TeamFile } from '../core/types.js'
import { extractFilePath, pathMatchesRule } from '../shared/permissionRules.js'
import { getConfiguredSyncUrl, getConfiguredApiKey, isAutoJoinEnabled } from '../core/cloudConfig.js'

// ============================================================
// Environment Detection
// ============================================================

/**
 * Checks if running inside Claude Code.
 */
export function isClaudeCode(): boolean {
  return !!process.env.CLAUDE_CODE_AGENT_ID ||
         !!process.env.CLAUDE_CODE_TEAM_NAME ||
         !!process.env.CLAUDE_PLUGIN_ROOT
}

/**
 * Checks if running in coordinator mode.
 */
export function isCoordinatorMode(): boolean {
  return process.env.CLAUDE_CODE_COORDINATOR_MODE === '1'
}

/**
 * Checks if running as a teammate (not the leader).
 */
export function isTeammate(): boolean {
  const agentName = process.env.CLAUDE_CODE_AGENT_NAME
  const teamName = process.env.CLAUDE_CODE_TEAM_NAME
  return !!teamName && agentName !== TEAM_LEAD_NAME && agentName !== undefined
}

// ============================================================
// PreToolUse Hook Handler
//
// This script is called by hooks/hooks.json when PreToolUse fires.
// It checks file locks and team permissions before allowing tool execution.
// ============================================================

/**
 * Permission check handler for PreToolUse hook.
 * Called by the hooks.json script for Bash, Write, and Edit tools.
 *
 * Returns exit code 0 to allow, exit code 1 to block.
 */
export async function preToolUseCheck(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<boolean> {
  const teamName = process.env.CLAUDE_CODE_TEAM_NAME
  if (!teamName) return true // Not in a team context, allow

  const teamFile = readTeamFile(teamName)
  if (!teamFile) return true

  // Check team-wide allowed paths
  if (teamFile.teamAllowedPaths) {
    const filePath = extractFilePath(toolName, toolInput)
    if (filePath) {
      const allowed = teamFile.teamAllowedPaths.some(
        rule => rule.toolName === toolName && pathMatchesRule(filePath, rule.path),
      )
      if (allowed) return true
    }
  }

  // In the full implementation, check cloud-based file locks here
  // const lockStatus = await checkFileLock(filePath)
  // if (lockStatus.locked && lockStatus.lockedBy !== currentAgent) return false

  return true
}

// ============================================================
// Plugin Initialization
// ============================================================

interface ClaudeCodePluginConfig {
  /** Teammate mode: auto, tmux, in-process */
  teammateMode?: 'auto' | 'tmux' | 'in-process'
  /** Debounce time for monitor script (ms) */
  debounceMs?: number
  /** Max events per window before triggering output */
  maxEventsPerWindow?: number
  /** L2 Team Memory Sync config (optional) */
  memorySync?: {
    apiUrl: string
    authToken: string
    syncIntervalMs: number
    enableWatcher: boolean
  }
}

/**
 * FIX(GAP1-3): Cloud Worker Discovery & Auto-Join.
 *
 * When a fresh machine installs the plugin, no local team exists.
 * This function discovers cloud teams and auto-joins the sole team.
 * For multiple teams, it logs them and lets the user choose via a command.
 *
 * Called synchronously during plugin init (awaited before C2/C4).
 */
async function discoverAndJoinCloudTeam(): Promise<void> {
  const syncUrl = getConfiguredSyncUrl()
  if (!syncUrl) return
  const apiKey = getConfiguredApiKey()

  console.log('[TeamCollab:GAP1] Cloud worker mode — discovering teams...')

  try {
    const { CloudInvitation } = await import('../core/cloudInvitation.js')
    const teams = await CloudInvitation.discoverCloudTeams(syncUrl, apiKey)

    if (teams.length === 0) {
      console.log('[TeamCollab:GAP1] No cloud teams found. Running in standalone mode.')
      return
    }

    // Use stable identity instead of session-specific CLAUDE_CODE_AGENT_ID
    const { getStableAgentId, getStableAgentName } = await import('../core/agentIdentity.js')
    const agentId = getStableAgentId()
    const agentName = getStableAgentName()

    if (teams.length === 1) {
      const team = teams[0]!
      if (isAutoJoinEnabled()) {
        console.log(`[TeamCollab:GAP1] TEAM_COLLAB_AUTO_JOIN=1 — auto-joining sole cloud team: "${team.name}"`)

        process.env.CLAUDE_CODE_AGENT_NAME = agentName
        process.env.CLAUDE_CODE_TEAM_NAME = team.name
        ;(globalThis as any).__CLOUD_WORKER__ = true

        const invInstance = new CloudInvitation({
          apiUrl: syncUrl, apiKey, teamName: team.name, agentId, agentName,
        })
        await invInstance.joinCloudTeam(team.name)

        console.log(`[TeamCollab:GAP1] Joined "${team.name}" as "${agentName}"`)
      } else {
        console.log(`[TeamCollab:GAP1] Found cloud team: "${team.name}" (lead: ${team.leadAgentName}, members: ${team.memberCount})`)
        console.log(`[TeamCollab:GAP1] Set TEAM_COLLAB_AUTO_JOIN=1 to auto-join, or use "加入 ${team.name}" command.`)
      }
    } else {
      console.log(`[TeamCollab:GAP1] Found ${teams.length} cloud teams:`)
      for (const t of teams) {
        console.log(`  - "${t.name}" (lead: ${t.leadAgentName}, members: ${t.memberCount})`)
      }
      console.log(`[TeamCollab:GAP1] Multiple teams found. To join a specific team, set:`)
      console.log(`  CLAUDE_CODE_TEAM_NAME=<team-name>`)
    }
  } catch (err) {
    console.warn('[TeamCollab:GAP1] Cloud team discovery failed:',
      err instanceof Error ? err.message : String(err))
  }
}

/**
 * Initializes the Claude Code team collaboration plugin.
 * Called when the plugin is loaded by Claude Code.
 */
export async function initializeClaudeCodePlugin(config: ClaudeCodePluginConfig = {}): Promise<void> {
  if (!isClaudeCode()) {
    console.error('[TeamCollab] Not running in Claude Code environment')
    return
  }

  // P2-9: Auto-inject environment variables BEFORE reading them
  // FIX: When CLAUDE_CODE_TEAM_NAME is unset or 'default-team', scan the filesystem
  // for the most recently created team. This handles the case where createTeam() was
  // called from a child process (SKILL.md → bash → node -e) and the env var couldn't
  // propagate back to the parent Claude Code process.
  if (!process.env.CLAUDE_CODE_TEAM_NAME || process.env.CLAUDE_CODE_TEAM_NAME === 'default-team') {
    const teams = listTeams()
    let latestName: string | null = null
    let latestTime = 0
    for (const dirName of teams) {
      const tf = readTeamFile(dirName)
      if (tf && tf.createdAt > latestTime) {
        latestTime = tf.createdAt
        latestName = tf.name
      }
    }
    if (latestName) {
      process.env.CLAUDE_CODE_TEAM_NAME = latestName
      console.log(`[TeamCollab] P2-9: Auto-set CLAUDE_CODE_TEAM_NAME=${latestName} (from filesystem)`)
    } else {
      process.env.CLAUDE_CODE_TEAM_NAME = 'default-team'
      console.log('[TeamCollab] P2-9: Auto-set CLAUDE_CODE_TEAM_NAME=default-team')
    }
  }
  if (!process.env.CLAUDE_CODE_AGENT_ID) {
    process.env.CLAUDE_CODE_AGENT_ID = `agent-${Date.now().toString(36)}`
  }
  if (!process.env.CLAUDE_CODE_AGENT_NAME) {
    process.env.CLAUDE_CODE_AGENT_NAME = TEAM_LEAD_NAME
  }
  if (!process.env.CLAUDE_CODE_SESSION_ID) {
    process.env.CLAUDE_CODE_SESSION_ID = `session-${Date.now().toString(36)}`
  }
  if (!process.env.CLAUDE_PLUGIN_ROOT) {
    process.env.CLAUDE_PLUGIN_ROOT = process.cwd()
  }
  // Auto-detect coordinator mode: if no teammate context, assume coordinator
  if (!process.env.CLAUDE_CODE_COORDINATOR_MODE && !isTeammate()) {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
    console.log('[TeamCollab] P2-9: Auto-enabled coordinator mode')
  }
  // Cloud config: resolved via cloudConfig.ts (respects DEMO_MODE / explicit env)
  // No longer auto-injects public demo URL — user must set TEAM_MEMORY_SYNC_URL
  // or enable TEAM_COLLAB_DEMO_MODE=1 explicitly.

  // FIX(GAP1-3): Cloud Worker auto-discovery.
  // When a fresh machine installs the plugin, it has no local team and defaults
  // to "default-team". This block discovers cloud teams and auto-joins the sole
  // team, so multi-machine collaboration works without manual env var setup.
  const isFreshInstall = process.env.CLAUDE_CODE_TEAM_NAME === 'default-team' &&
    !readTeamFile('default-team')
  if (getConfiguredSyncUrl() && isFreshInstall) {
    await discoverAndJoinCloudTeam()
  }

  // C2: Pull team from cloud on startup for multi-machine sync
  // FIX(P1/P5): Removed default-team discrimination — all teams participate in cloud sync.
  // P2-9 injects 'default-team' as the fallback; C2 must honor it for first-time users.
  if (getConfiguredSyncUrl() && process.env.CLAUDE_CODE_TEAM_NAME && !(globalThis as any).__CLOUD_WORKER__) {
    void (async () => {
      try {
        const { pullTeamFromCloud } = await import('../core/teamFile.js')
        const cloudTeam = await pullTeamFromCloud(process.env.CLAUDE_CODE_TEAM_NAME!)
        if (cloudTeam) {
          console.log(`[TeamCollab:C2] Pulled team from cloud: ${cloudTeam.members.length} members`)
          // Update team name if cloud has a real team (not default-team)
          if (cloudTeam.name !== 'default-team' && process.env.CLAUDE_CODE_TEAM_NAME === 'default-team') {
            process.env.CLAUDE_CODE_TEAM_NAME = cloudTeam.name
            console.log(`[TeamCollab:C2] Promoted team name from cloud: ${cloudTeam.name}`)
          }
        }
      } catch (err) { console.warn('[TeamCollab:C2] Startup pull failed:', err) }
    })().catch(err => console.error('[TeamCollab] Unhandled startup pull error:', err))
  }

  const teamName = process.env.CLAUDE_CODE_TEAM_NAME
  const agentName = process.env.CLAUDE_CODE_AGENT_NAME || TEAM_LEAD_NAME
  const agentId = process.env.CLAUDE_CODE_AGENT_ID || ''

  if (!teamName) {
    console.log('[TeamCollab] No team context - running in standalone mode')
    return
  }

  console.log(`[TeamCollab] Initializing for team "${teamName}", agent "${agentName}"`)

  // Initialize teammate hooks (Stop hook for idle notification)
  // FIX(GAP1-3): Cloud workers skip tmux-specific teammate hooks
  if (isTeammate() && !(globalThis as any).__CLOUD_WORKER__) {
    const setAppState = (updater: (prev: unknown) => unknown) => {
      // In Claude Code, this would be the actual setState function
      // For the plugin, we store the updates for later application
      globalThis.__TEAM_COLLAB_STATE_UPDATES__ = globalThis.__TEAM_COLLAB_STATE_UPDATES__ || []
      globalThis.__TEAM_COLLAB_STATE_UPDATES__.push(updater)
    }

    initializeTeammateHooks(setAppState, process.env.CLAUDE_CODE_SESSION_ID || '', {
      teamName,
      agentId,
      agentName,
    })

    // P1-5: Auto-discover cloud teams for teammates
    const teammateDiscoverUrl = getConfiguredSyncUrl()
    if (teammateDiscoverUrl) {
      void (async () => {
        try {
          const { CloudInvitation } = await import('../core/cloudInvitation.js')
          const teams = await CloudInvitation.discoverCloudTeams(
            teammateDiscoverUrl,
            getConfiguredApiKey(),
          )
          console.log(`[TeamCollab] Discovered ${teams.length} cloud team(s):`,
            teams.map(t => t.name).join(', '))
          // C4: Auto-join teams with pending invitations
          // Phase 1: Parallel getInvitations() — each team queries its own repo independently
          const { CloudInvitation: CI } = await import('../core/cloudInvitation.js')
          const inviteChecks = await Promise.all(
            teams
              .filter(team => team.leadAgentId !== agentId)
              .map(async (team) => {
                try {
                  const invInstance = new CI({
                    apiUrl: teammateDiscoverUrl,
                    apiKey: getConfiguredApiKey(),
                    teamName: team.name,
                    agentId,
                    agentName,
                  })
                  const invites = await invInstance.getInvitations()
                  const pending = invites.filter(i => i.status === 'pending')
                  return { team, invInstance, pending }
                } catch (err) {
                  console.warn(`[TeamCollab:C4] Invitation check failed for "${team.name}":`, err)
                  return { team, invInstance: null, pending: [] }
                }
              })
          )
          // Phase 2: Serial accept (avoids race conditions on team file writes)
          for (const { team, invInstance, pending } of inviteChecks) {
            if (pending.length > 0 && invInstance) {
              try {
                console.log(`[TeamCollab:C4] Found ${pending.length} pending invitation(s) for "${team.name}" — auto-joining...`)
                await invInstance.acceptInvitation(pending[0].id)
                process.env.CLAUDE_CODE_TEAM_NAME = team.name
                console.log(`[TeamCollab:C4] ✅ Auto-joined team "${team.name}"`)
              } catch (joinErr) {
                console.warn(`[TeamCollab:C4] Auto-join accept failed for "${team.name}":`, joinErr)
              }
            }
          }
        } catch (err) {
          console.warn('[TeamCollab] Failed to discover cloud teams:', err)
        }
      })().catch(err => console.error('[TeamCollab] Unhandled teammate discovery error:', err))
    }
  }

  // Auto-split layout for Leader (create panes for existing teammates)
  // FIX(GAP1-3): Cloud workers skip tmux auto-split
  if (isCoordinatorMode() && !(globalThis as any).__CLOUD_WORKER__) {
    import('../core/autoSplitLayout.js').then(({ autoSplitLayout }) => {
      autoSplitLayout({
        teamName,
        leadAgentId: agentId,
        skipExisting: true,
      }).then((result) => {
        if (result.performed) {
          console.log(`[TeamCollab] Auto-split: created ${result.panesCreated} pane(s) for: ${result.membersWithPanes.join(', ')}`)
        } else if (result.errors.length > 0) {
          console.error(`[TeamCollab] Auto-split errors:`, result.errors)
        } else {
          console.log('[TeamCollab] Auto-split: no teammates configured')
        }
      }).catch((err: Error) => {
        console.error('[TeamCollab] Auto-split failed:', err)
      })
    }).catch((err: Error) => {
      console.error('[TeamCollab] Auto-split import failed:', err)
    })
  }

  // Start inbox poller for receiving messages from leader/teammates
  const cloudRouter = new (await import('../core/cloudMessageRouter.js')).CloudMessageRouter({
    apiUrl: getConfiguredSyncUrl() || '',
    apiKey: getConfiguredApiKey(),
    repo: teamName,
    developerId: process.env.CLAUDE_CODE_AGENT_ID || agentId,
  })
  const poller = new InboxPoller(
    { agentName, teamName, intervalMs: 1000, cloudRouter },
    {
      onProtocolMessage: (message: unknown) => {
        const typed = message as { type?: string }
        console.log(`[TeamCollab] Protocol message received: ${typed?.type}`)
        // Route to appropriate handler based on message type
        handleProtocolMessage(typed, agentName, teamName)
      },
      onVoteEvent: (event) => {
        // Forward vote events to CloudVoting for lifecycle handling
        if (cloudInstances.voting) {
          cloudInstances.voting.handleVoteEvent(event).catch((err: Error) =>
            console.error('[TeamCollab] Vote event handling failed:', err)
          )
        }
      },
      onRegularMessage: (message) => {
        console.log(`[TeamCollab] Regular message from ${message.from}: ${message.text.slice(0, 100)}`)
      },
      onError: (error) => {
        console.error(`[TeamCollab] Inbox poller error:`, error)
      },
    },
  )

  poller.start()

  // C19: Store poller reference for cloud dispatcher wiring
  cloudInstances.poller = poller

  // Initialize cloud collaboration via cloudConfig.ts
  const syncUrl = getConfiguredSyncUrl()
  if (syncUrl) {
    // P1-5: Auto-discover cloud teams for coordinator
    // FIX(GAP1-3): Cloud workers already discovered teams
    if (isCoordinatorMode() && !(globalThis as any).__CLOUD_WORKER__) {
      void (async () => {
        try {
          const { CloudInvitation } = await import('../core/cloudInvitation.js')
          const teams = await CloudInvitation.discoverCloudTeams(
            syncUrl,
            getConfiguredApiKey(),
          )
          console.log(`[TeamCollab] P1-5: Discovered ${teams.length} cloud team(s):`,
            teams.map(t => t.name).join(', ') || '(none)')
        } catch (err) {
          console.warn('[TeamCollab] P1-5: Failed to discover cloud teams:', err)
        }
      })().catch(err => console.error('[TeamCollab] Unhandled coordinator discovery error:', err))
    }
    // V5-6: Check team file for per-team sync URL override
    let effectiveSyncUrl = syncUrl
    if (teamName && teamName !== 'default-team') {
      const teamFile = readTeamFile(teamName)
      if ((teamFile as any)?.syncUrl) {
        effectiveSyncUrl = (teamFile as any).syncUrl
        console.log(`[TeamCollab] V5-6: Using per-team sync URL from team file: ${effectiveSyncUrl}`)
      }
    }
    // Initialize all cloud modules (P1-3: auto-register, P1-4: health check inside)
    initializeCloudCollaboration({ teamName, agentName, agentId, syncUrl: effectiveSyncUrl })
  }

  // P2-8: Optional control plane connection for centralized team management
  if (process.env.CONTROL_PLANE_URL && process.env.CONTROL_PLANE_TOKEN) {
    void (async () => {
      try {
        const { createControlPlaneClient } = await import('./control-plane-client.js')
        const cp = createControlPlaneClient()
        const result = await cp.registerRuntime({
          member_id: process.env.MEMBER_ID || agentId,
          team_id: process.env.TEAM_ID || teamName,
          workspace_id: process.env.WORKSPACE_ID,
          runtime_type: isTeammate() ? 'local_worker' : 'local_agent',
          host_name: process.env.HOSTNAME || 'unknown',
          platform: process.platform,
          plugin_version: '2.0.0',
          capability_snapshot: ['cloud-collab', 'team-sync', 'sse-listener'],
        })
        console.log(`[TeamCollab] P2-8: Control plane registered — runtime_id: ${result.runtime_id}, state: ${result.connectivity_state}`)
      } catch (err) {
        console.warn('[TeamCollab] P2-8: Control plane registration failed (non-fatal):',
          err instanceof Error ? err.message : String(err))
      }
    })().catch(err => console.error('[TeamCollab] Unhandled control plane error:', err))
  }

  // If L2 sync is configured (legacy config), initialize it
  if (config.memorySync) {
    import('../core/teamMemorySync.js').then(({ syncTeamMemory }) => {
      if (config.memorySync!.syncIntervalMs > 0) {
        setInterval(async () => {
          try {
            const result = await syncTeamMemory(
              {
                apiUrl: config.memorySync!.apiUrl,
                authToken: config.memorySync!.authToken,
                syncIntervalMs: config.memorySync!.syncIntervalMs,
                enableWatcher: config.memorySync!.enableWatcher,
                watcherDebounceMs: 5000,
                direction: 'bidirectional',
              },
              teamName,
              'newest-wins',
            )
            console.log(`[TeamCollab] Sync completed: pushed=${result.pushed}, pulled=${result.pulled}, conflicts=${result.conflicts}`)
          } catch (error) {
            console.error(`[TeamCollab] Sync failed:`, error)
          }
        }, config.memorySync!.syncIntervalMs)
      }
    })
  }

  // V5-1: Register graceful shutdown handlers (SIGTERM, SIGINT)
  registerShutdownHandlers()

  console.log('[TeamCollab] Plugin initialized successfully')
}

/**
 * Routes a structured protocol message to the appropriate handler.
 * C18: Complete routing for all supported message types.
 */
function handleProtocolMessage(
  message: { type?: string; from?: string; to?: string; text?: string; [key: string]: any },
  agentName: string,
  teamName: string,
): void {
  // C18: Route to appropriate cloud module based on message type
  switch (message?.type) {
    case 'task': {
      // Parse inner message to determine routing target
      let inner: any = null
      try {
        inner = typeof message.text === 'string' ? JSON.parse(message.text) : (message.text || message)
      } catch { /* keep null */ }
      const innerType = inner?.type || ''

      if (cloudInstances.planApproval && (innerType.startsWith('plan_') || innerType === 'plan_approval_request')) {
        try { cloudInstances.planApproval.processCloudMessage(message) } catch (e) { console.warn('[C18] Plan approval route:', e) }
      } else if (cloudInstances.codeReview && (innerType.startsWith('review_') || innerType === 'code_review_request')) {
        try { cloudInstances.codeReview.processCloudMessage(message) } catch (e) { console.warn('[C18] Code review route:', e) }
      } else if (cloudInstances.gitSync && innerType.startsWith('git_')) {
        try { cloudInstances.gitSync.processCloudMessage(message) } catch (e) { console.warn('[C18] Git sync route:', e) }
      } else if (cloudInstances.skillEvolution && (innerType.startsWith('skill_') || innerType === 'skill_share')) {
        try { cloudInstances.skillEvolution.processCloudMessage(message) } catch (e) { console.warn('[C18] Skill evolution route:', e) }
      } else {
        console.log(`[TeamCollab:C18] Task from ${message.from}: ${(message.text || '').slice(0, 100)}`)
      }
      break
    }
    case 'idle_notification':
      console.log(`[TeamCollab:C18] Idle notification from ${message.from}`)
      break
    case 'permission_request':
      if (cloudInstances.permissionBroadcast) {
        try { cloudInstances.permissionBroadcast.processCloudMessage(message) } catch (e) { console.warn('[C18] Permission route:', e) }
      } else {
        console.log(`[TeamCollab:C18] Permission request from ${message.from} (no handler)`)
      }
      break
    case 'shutdown_request':
      if (cloudInstances.kick) {
        try { cloudInstances.kick.handleShutdownRequest(message) } catch (e) { console.warn('[C18] Kick route:', e) }
      } else {
        console.log(`[TeamCollab:C18] Shutdown request from ${message.from} (no handler)`)
      }
      break
    case 'plan_approval_request':
      if (cloudInstances.planApproval) {
        try { cloudInstances.planApproval.processCloudMessage(message) } catch (e) { console.warn('[C18] Plan route:', e) }
      } else {
        console.log(`[TeamCollab:C18] Plan approval request from ${message.from} (no handler)`)
      }
      break
    case 'presence':
      if (cloudInstances.presence && typeof (cloudInstances.presence as any).updateRemoteAgent === 'function') {
        ;(cloudInstances.presence as any).updateRemoteAgent(message.agentId || message.from, {
          agentId: message.agentId || message.from,
          agentName: message.agentName || message.from || 'unknown',
          status: message.status || 'online',
          lastSeen: Date.now(),
          hostname: message.hostname,
        })
      } else {
        console.log(`[TeamCollab:C18] Presence: ${message.from || message.agentName} is ${message.status || 'unknown'} (receive side not wired)`)
      }
      break
    case 'invite':
      console.log(`[TeamCollab:C18] Invite event from ${message.from || message.fromAgentName}`)
      break
    case 'kick':
      console.log(`[TeamCollab:C18] Kick event: ${(message.text || '').slice(0, 100)}`)
      break
    case 'code-review':
      if (cloudInstances.codeReview) {
        try { cloudInstances.codeReview.processCloudMessage(message) } catch (e) { console.warn('[C18] Code review route:', e) }
      } else {
        console.log(`[TeamCollab:C18] Code review from ${message.from} (no handler)`)
      }
      break
    case 'state-sync':
      console.log(`[TeamCollab:C18] State sync from ${message.from}`)
      break
    default:
      console.log(`[TeamCollab] Unknown protocol message type: ${message?.type}`)
  }
}

// Global state storage
declare global {
  var __TEAM_COLLAB_STATE_UPDATES__: ((prev: unknown) => unknown)[] | undefined
}

// ============================================================
// Cloud Collaboration Initialization (Multi-Machine Support)
// ============================================================

/** FIX(P6): Cloud connection status — visible to Dashboard and CLI queries */
export type CloudStatus = 'healthy' | 'unreachable' | 'disabled' | 'initializing' | 'error'

interface CloudCollabInstances {
  dispatcher?: any
  invitation?: any
  kick?: any
  planApproval?: any
  codeReview?: any
  permissionBroadcast?: any
  gitSync?: any
  skillEvolution?: any
  /** C19: reference to inbox poller for cloud dispatcher wiring */
  poller?: any
  /** C5: Cloud presence/heartbeat manager for online/offline detection */
  presence?: any
  /** CloudVoting — team decision voting system */
  voting?: any
  /** FIX(P6): Cloud connection status — exposed for Dashboard and user queries */
  cloudStatus: CloudStatus
  /** FIX(P6): Last status change timestamp */
  cloudStatusChangedAt: number
}

const cloudInstances: CloudCollabInstances = {
  cloudStatus: 'initializing',
  cloudStatusChangedAt: Date.now(),
}

/**
 * Creates a MessageDispatcher for cloud collaboration.
 */
async function createCloudDispatcher(teamName: string, agentId: string, agentName: string, syncUrl: string) {
  const { MessageDispatcher } = await import('../core/messageDispatcher.js')
  return new MessageDispatcher({
    teamName,
    agentName,
    cloudConfig: {
      apiUrl: syncUrl,
      apiKey: getConfiguredApiKey(),
      developerId: process.env.CLAUDE_CODE_TEAM_DEV_ID || agentId,
    },
  })
}

/**
 * Initialize all cloud collaboration modules when a sync URL is configured.
 * This enables multi-machine team communication via the sync server.
 */
async function initializeCloudCollaboration(params: { teamName: string, agentName: string, agentId: string, syncUrl: string }): Promise<void> {
  const { teamName, agentName, agentId, syncUrl } = params
  const apiKey = getConfiguredApiKey()

  /** FIX(P6): Set cloud status with timestamp for Dashboard visibility */
  function setCloudStatus(status: CloudStatus): void {
    cloudInstances.cloudStatus = status
    cloudInstances.cloudStatusChangedAt = Date.now()
    console.log(`[TeamCollab] Cloud status: ${status}`)
  }

  console.log('[TeamCollab] Initializing cloud collaboration modules...')

  // P1-4: Health check before initializing cloud modules
  try {
    const healthUrl = `${syncUrl}/health`
    const healthResponse = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })
    if (healthResponse.ok) {
      const health = await healthResponse.json() as any
      console.log(`[TeamCollab] Cloud server healthy: ${healthUrl} (uptime: ${health.uptime}s, clients: ${health.sseClients})`)
      setCloudStatus('healthy')
    } else {
      console.warn(`[TeamCollab] Cloud server at ${syncUrl} returned ${healthResponse.status} — running in local-only mode`)
      setCloudStatus('unreachable')
      return // Exit cloud initialization
    }
  } catch (err) {
    console.warn(`[TeamCollab] Cloud server at ${syncUrl} is unreachable — running in local-only mode:`,
      err instanceof Error ? err.message : String(err))
    setCloudStatus('unreachable')
    return // Exit cloud initialization
  }

  const dispatcher = await createCloudDispatcher(teamName, agentId, agentName, syncUrl)
  cloudInstances.dispatcher = dispatcher

  // v3.6: InboxPoller uses CloudMessageRouter directly — no setCloudDispatcher needed

  // Cloud Invitation System
  const { CloudInvitation } = await import('../core/cloudInvitation.js')
  cloudInstances.invitation = new CloudInvitation({
    apiUrl: syncUrl,
    apiKey,
    teamName,
    agentId,
    agentName,
  })
  console.log('[TeamCollab] Cloud Invitation: initialized')

  // C3: Start SSE listening for real-time invitation delivery
  // D1: DO NOT auto-accept. Notify the user via system-reminder so they
  // have agency to choose which teams to join.
  let pendingInviteCount = 0
  const stopInvitationSSE = cloudInstances.invitation.startListening((invite: any) => {
    console.log(`[TeamCollab:C3] 📨 Invitation from ${invite.fromAgentName}: "${invite.message}"`)
    if (invite.toAgentId === agentId || invite.toAgentName === agentName) {
      pendingInviteCount++
      // Store pending invite for UserPromptSubmit hook lookup
      ;(globalThis as any).__teamcollab_pending_invites = (globalThis as any).__teamcollab_pending_invites || []
      ;(globalThis as any).__teamcollab_pending_invites.push({ teamName: invite.teamName, from: invite.fromAgentName, message: invite.message, invitationId: invite.invitationId })
      console.log(`[TeamCollab:C3] Invitation pending — user must explicitly "加入 ${invite.teamName}"`)
      process.stdout.write(`\n<system-reminder>\n[TeamDiscovery] 📨 新邀请! ${invite.fromAgentName} 邀请你加入「${invite.teamName}」: "${invite.message}"\n输入 "加入 ${invite.teamName}" 接受, 或 "忽略" 关闭\n</system-reminder>\n`)
    }
  })
  ;(cloudInstances as any)._stopInvitationSSE = stopInvitationSSE
  console.log('[TeamCollab:C3] SSE listening: started for invitations (notification mode)')

  // D1: Initial cloud scan for already-existing teams and invitations
  try {
    const { scanCloud } = await import('../core/teamDiscovery.js')
    const discovery = await scanCloud()
    if (discovery.invited.length > 0 || discovery.discovered.length > 0) {
      const lines: string[] = []
      if (discovery.invited.length > 0) {
        lines.push(`📨 待处理邀请 (${discovery.invited.length}):`)
        for (const inv of discovery.invited) {
          lines.push(`  • ${inv.teamName} ← ${inv.fromAgentName}: "${inv.message}"`)
          // Store for join command lookup
          ;(globalThis as any).__teamcollab_pending_invites = (globalThis as any).__teamcollab_pending_invites || []
          ;(globalThis as any).__teamcollab_pending_invites.push({ teamName: inv.teamName, from: inv.fromAgentName, message: inv.message, invitationId: inv.id })
        }
      }
      if (discovery.discovered.length > 0) {
        lines.push(`🔍 可发现的团队 (${discovery.discovered.length}):`)
        for (const t of discovery.discovered) {
          lines.push(`  • ${t.name} (${t.memberCount}人, ${t.description || '无描述'})`)
        }
      }
      lines.push('')
      lines.push('输入 "加入 <团队名>" 接受邀请, "查看 <团队名>" 看详情, 或 "忽略" 关闭')
      process.stdout.write(`\n<system-reminder>\n[TeamDiscovery] 发现云端团队:\n${lines.join('\n')}\n</system-reminder>\n`)
      console.log(`[TeamCollab] Discovery: ${discovery.discovered.length} teams, ${discovery.invited.length} invites`)
    }
  } catch (err) {
    console.warn('[TeamCollab] Cloud discovery scan failed:', err instanceof Error ? err.message : String(err))
  }

  // P1-3: Auto-register team to cloud for multi-machine discovery
  if (agentName === TEAM_LEAD_NAME || process.env.CLAUDE_CODE_COORDINATOR_MODE === '1') {
    try {
      // C12: Read actual member count from team file
      let actualMemberCount = 1
      try {
        const tf = readTeamFile(teamName)
        if (tf) actualMemberCount = tf.members.length
      } catch { /* keep default */ }

      await cloudInstances.invitation.registerTeam({
        name: teamName,
        description: 'Multi-machine collaboration team',
        leadAgentId: agentId,
        leadAgentName: agentName,
        memberCount: actualMemberCount,
        createdAt: new Date().toISOString(),
      })
      console.log(`[TeamCollab] Team "${teamName}" registered to cloud for discovery`)
    } catch (err) {
      console.warn('[TeamCollab] Failed to register team to cloud (server may be offline):', err)
    }
  }

  // Cloud Kick Manager
  const { CloudKickManager } = await import('../core/cloudKick.js')
  cloudInstances.kick = new CloudKickManager(dispatcher, teamName, agentId, agentName)
  console.log('[TeamCollab] Cloud Kick: initialized')

  // Cloud Plan Approval
  const { CloudPlanApproval } = await import('../core/cloudPlanApproval.js')
  cloudInstances.planApproval = new CloudPlanApproval({ dispatcher, teamName, agentId, agentName })
  console.log('[TeamCollab] Cloud Plan Approval: initialized')

  // Cloud Code Review
  const { CloudCodeReview } = await import('../core/codeReview.js')
  cloudInstances.codeReview = new CloudCodeReview({ dispatcher, teamName, agentId, agentName })
  console.log('[TeamCollab] Cloud Code Review: initialized')

  // Cloud Permission Broadcast
  const { CloudPermissionBroadcast } = await import('../core/cloudPermissionBroadcast.js')
  cloudInstances.permissionBroadcast = new CloudPermissionBroadcast({
    dispatcher, teamName, agentId, agentName,
    initialRules: [],
  })
  console.log('[TeamCollab] Cloud Permission Broadcast: initialized')

  // C17: Wire permission broadcast listener
  if (cloudInstances.permissionBroadcast) {
    try {
      if (typeof cloudInstances.permissionBroadcast.onPermissionUpdate === 'function') {
        cloudInstances.permissionBroadcast.onPermissionUpdate((update: any) => {
          console.log(`[TeamCollab:C17] Permission update: ${JSON.stringify(update).slice(0, 200)}`)
        })
      }
      if (typeof cloudInstances.permissionBroadcast.startListening === 'function') {
        cloudInstances.permissionBroadcast.startListening()
        console.log('[TeamCollab:C17] Permission broadcast listening: started')
      }
    } catch (err) {
      console.warn('[TeamCollab:C17] Permission broadcast wiring failed:', err)
    }
  }

  // Cloud Voting — team decision voting with role-based permissions
  try {
    const { CloudVoting } = await import('../core/cloudVoting.js')
    const { onVoteResolved } = await import('../core/voteWorkflow.js')
    const { readTeamFile } = await import('../core/teamFile.js')

    const getTeamMembers = () => {
      const tf = readTeamFile(teamName)
      return (tf?.members ?? []).map(m => ({
        agentId: m.agentId,
        role: m.role || 'developer',
      }))
    }

    // Resolve current agent's role from team file, default to 'developer'
    const myMember = getTeamMembers().find(m => m.agentId === agentId)
    const myRole = (myMember?.role || 'developer')

    const voting = new CloudVoting({
      apiUrl: syncUrl,
      apiKey,
      teamName,
      agentId,
      agentRole: myRole,
      getTeamMembers,
    })

    // Wire: CloudVoting.onEvent → voteWorkflow.onVoteResolved()
    const workflowCtx = {
      dispatcher,
      getTeamMembers: () => {
        const tf = readTeamFile(teamName)
        return (tf?.members ?? []).map(m => ({
          agentId: m.agentId, name: m.name, role: m.role || 'developer',
        }))
      },
    }
    voting.onEvent({
      onVoteResolved: (vote) => {
        onVoteResolved(vote, workflowCtx).catch(err =>
          console.error('[TeamCollab] Vote workflow failed:', err))
      },
      onVoteCancelled: (vote) => {
        console.log(`[TeamCollab] Vote cancelled: ${vote.voteId} — ${vote.topic}`)
      },
      onVoteRolledBack: (vote) => {
        console.log(`[TeamCollab] Vote rolled back: ${vote.voteId} — ${vote.topic}`)
      },
      onVoteExpired: (vote) => {
        console.log(`[TeamCollab] Vote expired: ${vote.voteId} — ${vote.topic}`)
      },
      onVoteRequest: (vote) => {
        console.log(`[TeamCollab] 🗳️ New vote requested: ${vote.topic}`)
      },
    })

    cloudInstances.voting = voting
    console.log('[TeamCollab] Cloud Voting: initialized with event bridge')
  } catch (err) {
    console.warn('[TeamCollab] Cloud Voting initialization failed:', err)
  }

  // C5: Presence/heartbeat system for online/offline detection
  try {
    const { CloudPresence } = await import('../core/cloudPresence.js')
    const presence = new CloudPresence({
      apiUrl: syncUrl,
      apiKey,
      teamName,
      agentId,
      agentName,
    })
    presence.start()
    ;(cloudInstances as any).presence = presence
    console.log('[TeamCollab:C5] Presence heartbeat: started (every 30s)')
  } catch (err) {
    console.warn('[TeamCollab:C5] Presence init failed (non-fatal):', err)
  }

  // Git Sync
  const { GitSync } = await import('../core/gitSync.js')
  cloudInstances.gitSync = new GitSync({ dispatcher, teamName, agentId, agentName })
  console.log('[TeamCollab] Git Sync: initialized')

  // Skill Evolution
  const { SkillEvolution } = await import('../core/skillEvolution.js')
  cloudInstances.skillEvolution = new SkillEvolution({ dispatcher, teamName, agentId, agentName })
  console.log('[TeamCollab] Skill Evolution: initialized')

  // Start SSE listening for real-time message delivery
  await dispatcher.startCloudListening((msg: any) => {
    handleProtocolMessage(msg, agentName, teamName)
  })
  console.log('[TeamCollab] Cloud SSE listening: started')

  // C15: Periodic cloud health monitoring (every 60s)
  // FIX(P6): Updates cloudStatus so Dashboard always reflects current state
  const healthInterval = setInterval(async () => {
    try {
      const resp = await fetch(`${syncUrl}/health`, { signal: AbortSignal.timeout(5000) })
      if (!resp.ok) {
        console.warn(`[TeamCollab:C15] Cloud server unhealthy: ${resp.status}`)
        setCloudStatus('unreachable')
      } else {
        if (cloudInstances.cloudStatus !== 'healthy') setCloudStatus('healthy')
      }
    } catch {
      console.warn('[TeamCollab:C15] Cloud server unreachable')
      setCloudStatus('unreachable')
    }
  }, 60_000)
  ;(cloudInstances as any)._healthInterval = healthInterval
}

/**
 * P6: Handle user "加入 <team>" command from UserPromptSubmit hook.
 * Accepts the pending invitation, starts heartbeat, and returns the result.
 * User perspective: Worker types "加入 天上天下" → instant join + online.
 */
export async function handleJoinCommand(userInput: string): Promise<string | null> {
  const match = userInput.match(/^加入\s+(.+)$/)
  if (!match) return null

  const targetTeam = match[1].trim()
  const pendingInvites: any[] = (globalThis as any).__teamcollab_pending_invites || []

  const invite = pendingInvites.find((i: any) => i.teamName === targetTeam)
  if (!invite) {
    return `❌ 未找到「${targetTeam}」的待处理邀请。可用: ${pendingInvites.map((i: any) => i.teamName).join(', ') || '无'}`
  }

  if (!cloudInstances.invitation) {
    return '❌ 云端邀请系统未初始化'
  }

  try {
    await cloudInstances.invitation.acceptInvitation(invite.invitationId)
    // Start heartbeat if presence is available
    if (cloudInstances.presence) {
      cloudInstances.presence.start()
    }
    // Remove from pending list
    ;(globalThis as any).__teamcollab_pending_invites = pendingInvites.filter((i: any) => i.teamName !== targetTeam)
    return `✅ 已加入「${targetTeam}」团队! 心跳已启动，你的状态现在对 Leader 可见。`
  } catch (err) {
    return `❌ 加入失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * V5-1: Global shutdown function for clean resource teardown.
 * Stops all SSE connections, clears all timers, and performs graceful cleanup.
 */
export function shutdownTeamPlugin(): void {
  console.log('[TeamCollab] Shutting down...')

  // 1. Stop inbox poller
  if (cloudInstances.poller && typeof cloudInstances.poller.stop === 'function') {
    cloudInstances.poller.stop()
    console.log('[TeamCollab] Inbox poller stopped')
  }

  // 2. Stop cloud SSE listening (MessageDispatcher)
  if (cloudInstances.dispatcher && typeof cloudInstances.dispatcher.stopCloudListening === 'function') {
    try { cloudInstances.dispatcher.stopCloudListening() } catch (e) { /* ignore */ }
    console.log('[TeamCollab] Cloud SSE listening stopped')
  }

  // 3. Stop invitation SSE
  const stopInviteSSE = (cloudInstances as any)._stopInvitationSSE
  if (typeof stopInviteSSE === 'function') {
    try { stopInviteSSE() } catch (e) { /* ignore */ }
    console.log('[TeamCollab] Invitation SSE stopped')
  }

  // 4. Stop permission broadcast listening
  if (cloudInstances.permissionBroadcast && typeof cloudInstances.permissionBroadcast.stopListening === 'function') {
    try { cloudInstances.permissionBroadcast.stopListening() } catch (e) { /* ignore */ }
    console.log('[TeamCollab] Permission broadcast stopped')
  }

  // 5. Stop presence heartbeat
  if ((cloudInstances as any).presence && typeof (cloudInstances as any).presence.stop === 'function') {
    try { (cloudInstances as any).presence.stop() } catch (e) { /* ignore */ }
    console.log('[TeamCollab] Presence heartbeat stopped')
  }

  // 6. Clear health interval
  const healthInterval = (cloudInstances as any)._healthInterval
  if (healthInterval) {
    clearInterval(healthInterval)
    delete (cloudInstances as any)._healthInterval
    console.log('[TeamCollab] Health interval cleared')
  }

  console.log('[TeamCollab] Shutdown complete')
}

// Register signal handlers
let _shutdownRegistered = false
function registerShutdownHandlers(): void {
  if (_shutdownRegistered) return
  _shutdownRegistered = true
  const handler = () => {
    shutdownTeamPlugin()
    process.exit(0)
  }
  process.on('SIGTERM', handler)
  process.on('SIGINT', handler)
}

/**
 * Get a cloud collaboration instance by name.
 */
export function getCloudInstance<T = any>(name: keyof CloudCollabInstances): T | undefined {
  return cloudInstances[name] as T | undefined
}

/**
 * FIX(P6): Get current cloud connection status.
 * Dashboard and CLI tools call this to display connection state to the user.
 */
export function getCloudStatus(): { status: CloudStatus; changedAt: number } {
  return {
    status: cloudInstances.cloudStatus,
    changedAt: cloudInstances.cloudStatusChangedAt,
  }
}

/**
 * FIX(P6): Query online workers from cloud presence system.
 * Returns list of workers with their online/offline status.
 * Aggregates: presence data from SSE + server health info.
 */
export async function queryOnlineWorkers(teamName: string): Promise<{
  workers: Array<{ agentId: string; agentName: string; status: string; hostname?: string; lastSeen?: number }>
  localOnly: boolean
  cloudStatus: CloudStatus
}> {
  const result = {
    workers: [] as Array<{ agentId: string; agentName: string; status: string; hostname?: string; lastSeen?: number }>,
    localOnly: true,
    cloudStatus: cloudInstances.cloudStatus,
  }

  // 1. Get local presence data (from SSE events)
  if ((cloudInstances as any).presence) {
    const presence = (cloudInstances as any).presence
    if (typeof presence.getOnlineAgentList === 'function') {
      const onlineList = presence.getOnlineAgentList()
      result.workers.push(...onlineList.map((a: any) => ({
        agentId: a.agentId,
        agentName: a.agentName,
        status: a.status,
        hostname: a.hostname,
        lastSeen: a.lastSeen,
      })))
      if (onlineList.length > 0) result.localOnly = false
    }
  }

  // 2. Get server health info (connection count)
  const onlineCheckUrl = getConfiguredSyncUrl()
  if (onlineCheckUrl) {
    try {
      const resp = await fetch(`${onlineCheckUrl}/health`, { signal: AbortSignal.timeout(5000) })
      if (resp.ok) {
        const health = await resp.json() as any
        if (health.sseClients) {
          // We know there are connections but can't identify them
          // Dashboard can show: "Server: X SSE connections"
          result.cloudStatus = 'healthy'
        }
      }
    } catch { /* already reflected in cloudStatus */ }
  }

  return result
}
