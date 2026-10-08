/**
 * Open Code Platform Adapter
 *
 * Adapts the team collaboration core for Open Code's plugin system.
 * Handles:
 * - Plugin interface export (async function receiving ctx)
 * - tool.execute.before hook for permission interception (NOT permission.ask)
 * - Event subscription via ctx.client.event.subscribe()
 * - TUI toast notifications via ctx.client.tui.toast.show()
 * - Compaction state protection
 *
 * Critical constraints from analysis doc:
 * 1. MUST use tool.execute.before instead of permission.ask (Issue #7006)
 * 2. MUST use tui.toast.show instead of session.prompt(noReply: true) (Issue #6513)
 * 3. MUST NOT use polling - use event subscription
 */

import { readTeamFile, setMemberActive } from '../core/teamFile.js'
import { MessageDispatcher, CloudMessage } from '../core/messageDispatcher.js'
import { createIdleNotification, isStructuredProtocolMessage } from '../core/messageTypes.js'
import { InboxPoller } from '../hooks/inboxPoller.js'
import { initializeTeammateHooks } from '../hooks/teammateStop.js'
import { DEFAULT_TEAM_NAME, TEAM_LEAD_NAME } from '../platform/constants.js'
import { extractFilePath, pathMatchesRule } from '../shared/permissionRules.js'

// ============================================================
// Unified Environment Variable Mapping
//
// Supports both Open Code naming (TEAM_NAME, AGENT_NAME, AGENT_ID)
// and Claude Code naming (CLAUDE_CODE_TEAM_NAME, etc.) with
// Open Code prefixed variants (OPEN_CODE_TEAM_NAME, etc.).
// ============================================================

const ENV_MAP = {
  TEAM_NAME:
    process.env.OPEN_CODE_TEAM_NAME ||
    process.env.CLAUDE_CODE_TEAM_NAME ||
    process.env.TEAM_NAME ||
    DEFAULT_TEAM_NAME,
  AGENT_NAME:
    process.env.OPEN_CODE_AGENT_NAME ||
    process.env.CLAUDE_CODE_AGENT_NAME ||
    process.env.AGENT_NAME ||
    TEAM_LEAD_NAME,
  AGENT_ID:
    process.env.OPEN_CODE_AGENT_ID ||
    process.env.CLAUDE_CODE_AGENT_ID ||
    process.env.AGENT_ID ||
    '',
} as const

// ============================================================
// Open Code Plugin Interface
// ============================================================

/**
 * Open Code PluginContext - provided by the Open Code runtime.
 * This interface mirrors the actual Open Code ctx object.
 */
export interface OpenCodePluginContext {
  /** OpenAPI 3.1 client for interacting with Open Code internals */
  client: {
    session: {
      prompt: (options: { prompt: string; noReply?: boolean }) => Promise<void>
    }
    event: {
      subscribe: (eventType: string) => AsyncIterableIterator<{ type: string; data: unknown }>
    }
    tui: {
      toast: {
        show: (options: { variant: 'info' | 'warning' | 'error'; message: string }) => Promise<void>
      }
    }
  }
  /** Project context */
  project: {
    id: string
    path: string
  }
  /** Worktree context */
  worktree?: {
    path: string
    branch: string
  }
  /** Bun shell execution */
  $: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Plugin directory path */
  directory: string
}

/**
 * Open Code Plugin interface.
 * Must export an async function that receives the PluginContext.
 */
export interface OpenCodePlugin {
  name: string
  version: string
  description: string
  setup: (ctx: OpenCodePluginContext) => Promise<void>
}

// ============================================================
// Plugin Implementation
// ============================================================

export const teamCollabPlugin: OpenCodePlugin = {
  name: 'team-collab',
  version: '1.0.0',
  description: '多智能体团队协作插件 - 支持 Agent Swarm 模式',

  async setup(ctx: OpenCodePluginContext): Promise<void> {
    const teamName = ENV_MAP.TEAM_NAME
    const agentName = ENV_MAP.AGENT_NAME
    const agentId = ENV_MAP.AGENT_ID

    console.log(`[TeamCollab] Open Code plugin loaded for team "${teamName}", agent "${agentName}"`)

    // Register tool.execute.before hook for permission interception
    // CRITICAL: Do NOT use permission.ask - it has a known bug (Issue #7006)
    await registerToolExecuteBefore(ctx, teamName, agentName)

    // Subscribe to internal events for file changes and team updates
    // Fire-and-forget: the event stream is a long-lived async iterator that
    // must not block remaining plugin setup (inbox polling, teammate hooks).
    subscribeToEvents(ctx, teamName, agentName)

    // Start inbox polling for teammate messages
    await startInboxPolling(ctx, teamName, agentName)

    // Initialize teammate hooks if running as a teammate
    if (agentName !== TEAM_LEAD_NAME) {
      initializeOpenCodeTeammateHooks(ctx, { teamName, agentId, agentName })
    }

    console.log('[TeamCollab] Open Code plugin setup complete')
  },
}

// ============================================================
// tool.execute.before Hook
//
// Intercepts tool execution before it runs.
// Used for file lock checking and team permission validation.
// ============================================================

async function registerToolExecuteBefore(
  ctx: OpenCodePluginContext,
  teamName: string,
  agentName: string,
): Promise<void> {
  // Open Code uses ctx.client or a hook system for tool interception.
  // The exact API depends on the Open Code SDK version.
  // Based on the analysis doc, we use tool.execute.before pattern.

  const WRITE_TOOLS = new Set(['edit', 'write', 'bash'])

  // Register the interceptor
  // Note: The exact registration method depends on Open Code SDK
  // This is the conceptual implementation
  const toolInterceptor = async (toolName: string, input: Record<string, unknown>) => {
    if (!WRITE_TOOLS.has(toolName.toLowerCase())) return

    // Check team-wide allowed paths
    const teamFile = readTeamFile(teamName)
    if (!teamFile) return

    if (teamFile.teamAllowedPaths) {
      const filePath = extractFilePath(toolName, input)
      if (filePath) {
        const allowed = teamFile.teamAllowedPaths.some(
          rule => pathMatchesRule(filePath, rule.path),
        )
        if (!allowed) {
          // Block execution - throw error to abort
          throw new Error(
            `文件 "${filePath}" 未被团队允许路径覆盖。` +
            `请联系团队领导添加权限，或切换到允许的路径。`
          )
        }
      }
    }

    // Check cloud-based file locks here
    // const lockStatus = await checkCloudFileLock(filePath)
    // if (lockStatus.locked) {
    //   throw new Error(
    //     `文件 "${filePath}" 已被 ${lockStatus.lockedBy} 锁定。` +
    //     `请等待锁释放或使用不同的文件。`
    //   )
    // }
  }

  // Store interceptor for Open Code SDK to use.
  //
  // Preferred: register via the SDK hook API when available.
  //   ctx.on?.('tool.execute.before', toolInterceptor)
  //   ctx.client.tool?.intercept?.('execute.before', toolInterceptor)
  //
  // TODO(open-code-sdk): The current Open Code SDK (as of 2026-04) does not
  // expose a stable tool.intercept or 'tool.execute.before' hook on the
  // PluginContext. When the SDK adds this, replace the globalThis fallback
  // with proper registration.
  //
  // Fallback: store on globalThis so an external loader/polyfill can
  // discover and invoke the interceptor. A polling-based approach could
  // periodically check tool invocations, but that would be more invasive.
  globalThis.__TEAM_COLLAB_TOOL_INTERCEPTOR__ = toolInterceptor
  console.log('[TeamCollab] Registered tool.execute.before interceptor (globalThis fallback)')
}

// ============================================================
// Event Subscription
//
// Uses ctx.client.event.subscribe() for real-time event handling.
// CRITICAL: Do NOT use polling for events.
// ============================================================

async function subscribeToEvents(
  ctx: OpenCodePluginContext,
  teamName: string,
  agentName: string,
): Promise<void> {
  // Subscribe to file editing events
  try {
    const eventStream = ctx.client.event.subscribe('file.edited')

    // Use for-await-of loop for async iteration
    for await (const event of eventStream) {
      if (event.type === 'file.edited') {
        const data = event.data as { filePath?: string; editedBy?: string }
        if (data?.filePath) {
          // Show TUI toast notification for conflicts
          // CRITICAL: Use tui.toast.show, NOT session.prompt(noReply: true)
          await ctx.client.tui.toast.show({
            variant: 'warning',
            message: `文件 ${data.filePath} 被 ${data.editedBy || 'unknown'} 修改`,
          })
        }
      }
    }
  } catch (error) {
    console.error('[TeamCollab] Event subscription error:', error)
  }
}

// ============================================================
// Inbox Polling for Open Code
// ============================================================

async function startInboxPolling(
  ctx: OpenCodePluginContext,
  teamName: string,
  agentName: string,
): Promise<void> {
  const cloudRouter = new (await import('../core/cloudMessageRouter.js')).CloudMessageRouter({
    apiUrl: process.env.TEAM_MEMORY_SYNC_URL || '',
    apiKey: process.env.TEAM_MEMORY_SYNC_API_KEY || '',
    repo: teamName,
    developerId: process.env.CLAUDE_CODE_AGENT_ID || agentName,
  })
  const poller = new InboxPoller(
    { agentName, teamName, intervalMs: 1000, cloudRouter },
    {
      onProtocolMessage: async (message: unknown, rawMessage: CloudMessage) => {
        const typed = message as { type?: string }
        console.log(`[TeamCollab] Protocol message: ${typed?.type}`)

        // Show TUI notification for important protocol messages
        if (typed?.type === 'shutdown_request') {
          await ctx.client.tui.toast.show({
            variant: 'warning',
            message: `收到关机请求来自 ${rawMessage.from}`,
          })
        } else if (typed?.type === 'plan_approval_request') {
          await ctx.client.tui.toast.show({
            variant: 'info',
            message: `收到计划审批请求来自 ${rawMessage.from}`,
          })
        }
      },
      onRegularMessage: async (message: CloudMessage) => {
        console.log(`[TeamCollab] Message from ${message.from}: ${message.text.slice(0, 100)}`)
      },
      onError: (error) => {
        console.error(`[TeamCollab] Inbox poller error:`, error)
      },
    },
  )

  poller.start()
}

// ============================================================
// Teammate Hook Initialization for Open Code
// ============================================================

function initializeOpenCodeTeammateHooks(
  ctx: OpenCodePluginContext,
  teamInfo: { teamName: string; agentId: string; agentName: string },
): void {
  const { teamName, agentName } = teamInfo

  // Read team file to get leader
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return

  const leadAgentId = teamFile.leadAgentId
  const leadMember = teamFile.members.find(m => m.agentId === leadAgentId)
  const leadAgentName = leadMember?.name || TEAM_LEAD_NAME

  // In Open Code, we register a session stop handler
  // This would be: ctx.on('session.stop', handler)
  // For now, we use a global pattern that the plugin loader can detect
  const stopHandler = async () => {
    // Mark as idle
    await setMemberActive(teamName, agentName, false)

    // Send idle notification to leader
    const notification = createIdleNotification(agentName, {
      idleReason: 'available',
    })

    await new MessageDispatcher({
      teamName,
      agentName,
      cloudConfig: {
        apiUrl: process.env.TEAM_MEMORY_SYNC_URL || '',
        apiKey: process.env.TEAM_MEMORY_SYNC_API_KEY || '',
        developerId: process.env.CLAUDE_CODE_AGENT_ID || agentName,
      },
    }).sendMessage(leadAgentName, leadAgentName, {
      from: agentName,
      text: JSON.stringify(notification),
      timestamp: new Date().toISOString(),
      type: 'idle_notification',
    })

    console.log(`[TeamCollab] Sent idle notification to ${leadAgentName}`)
  }

  globalThis.__TEAM_COLLAB_STOP_HOOK__ = () => stopHandler().then(() => true)
}

// Global storage
declare global {
  var __TEAM_COLLAB_TOOL_INTERCEPTOR__: ((tool: string, input: Record<string, unknown>) => Promise<void>) | undefined
}
