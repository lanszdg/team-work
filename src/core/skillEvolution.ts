/**
 * Skill Auto-Evolution Module (Feature 7)
 *
 * Enables team members to share learned patterns, successful approaches,
 * and skill improvements through the cloud sync server.
 *
 * Architecture:
 * - Uses SyncServerAdapter (via a dedicated `__skills__` repo) to push/pull skill knowledge
 * - Uses CloudMessageRouter via MessageDispatcher for real-time SSE notifications
 * - Works alongside existing modules without modifying them
 *
 * This is a NEW module — it does NOT modify any existing source files.
 */

import { randomUUID } from 'crypto'
import type { MessageDispatcher } from './messageDispatcher.js'

// ============================================================
// Types
// ============================================================

export interface SkillEntry {
  id: string
  name: string
  category: string
  description: string
  metadata: Record<string, unknown>
  learnedBy: string
  sharedAt?: string
  version: number
  createdAt: string
}

export interface SkillSyncRequest {
  requestId: string
  from: string
  category?: string
  timestamp: string
}

// ============================================================
// Skill Evolution
// ============================================================

const SKILLS_REPO_PREFIX = '__skills__'

export class SkillEvolution {
  private dispatcher: MessageDispatcher
  private teamName: string
  private agentId: string
  private agentName: string

  // Local learned skills
  private localSkills: Map<string, SkillEntry> = new Map()

  // Callback for incoming skill shares via SSE
  private onSkillSharedCallback: ((skill: SkillEntry) => Promise<void>) | null = null

  constructor(config: {
    dispatcher: MessageDispatcher
    teamName: string
    agentId: string
    agentName: string
  }) {
    this.dispatcher = config.dispatcher
    this.teamName = config.teamName
    this.agentId = config.agentId
    this.agentName = config.agentName
  }

  // -- storage key helpers -----------------------------------------

  /**
   * Build the storage key for a skill entry in the __skills__ repo.
   * Format: skill/{id}
   */
  private skillKey(id: string): string {
    return `skill/${id}`
  }

  /**
   * Build the repo name for skill storage.
   */
  private skillsRepo(): string {
    return `${this.teamName}_${SKILLS_REPO_PREFIX}`
  }

  // ================================================================
  // Learn a pattern from current work
  // ================================================================

  /**
   * Create a new local skill entry from a learned pattern.
   * The skill is stored locally and can later be shared to the cloud.
   */
  async learn(
    pattern: string,
    description: string,
    metadata?: Record<string, unknown>,
  ): Promise<SkillEntry> {
    const id = randomUUID()
    const entry: SkillEntry = {
      id,
      name: pattern,
      category: metadata?.category ? String(metadata.category) : 'general',
      description,
      metadata: metadata ?? {},
      learnedBy: this.agentId,
      version: 1,
      createdAt: new Date().toISOString(),
    }
    this.localSkills.set(id, entry)
    return entry
  }

  // ================================================================
  // Share a learned skill to the cloud
  // ================================================================

  /**
   * Push a local skill to cloud storage and broadcast via SSE.
   * The skill is stored as JSON in the __skills__ repo under `skill/{id}`.
   * A `skill_shared` event is posted for real-time notification.
   */
  async share(skillId: string): Promise<void> {
    const skill = this.localSkills.get(skillId)
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`)
    }

    const sharedSkill: SkillEntry = {
      ...skill,
      sharedAt: new Date().toISOString(),
    }
    this.localSkills.set(skillId, sharedSkill)

    // Push to cloud storage (skills repo)
    const key = this.skillKey(skillId)
    const repo = this.skillsRepo()
    const dispatcher = this.getCloudDispatcher()
    if (dispatcher !== null) {
      const router = dispatcher.getCloudRouter()
      if (router !== null) {
        const skillsAdapter = await this.getSkillsAdapter()
        try {
          await skillsAdapter.push({ [key]: JSON.stringify(sharedSkill) })
        } catch (err) {
          console.warn('[SkillEvolution] share push failed:',
            err instanceof Error ? err.message : String(err))
        }

        // Broadcast skill_shared event via SSE
        const messageId = `skill-shared-${skillId}-${Date.now()}`
        await router.sendMessage({
          messageId,
          type: 'skill_shared',
          from: this.agentName,
          to: 'team',
          text: JSON.stringify({
            skillId: sharedSkill.id,
            skill: sharedSkill,
            sharedBy: this.agentName,
          }),
          timestamp: new Date().toISOString(),
          teamName: repo,
        })
      }
    }
  }

  // ================================================================
  // Pull and apply shared skills from cloud
  // ================================================================

  /**
   * Pull shared skills from cloud and merge into local skills.
   * Optionally filter by category.
   */
  async apply(category?: string): Promise<SkillEntry[]> {
    const skills = await this.pullSkillsFromCloud(category)

    // Merge into local skills
    for (const skill of skills) {
      const existing = this.localSkills.get(skill.id)
      if (!existing || skill.version > existing.version) {
        this.localSkills.set(skill.id, skill)
      }
    }

    return skills
  }

  // ================================================================
  // Discover all shared skills
  // ================================================================

  /**
   * Discover all skills shared to the cloud, optionally filtered by category.
   * Does NOT merge into local skills (read-only discovery).
   */
  async discoverSkills(category?: string): Promise<SkillEntry[]> {
    return this.pullSkillsFromCloud(category)
  }

  // ================================================================
  // Request skill sync from another agent
  // ================================================================

  /**
   * Send a skill sync request to another agent via the dispatcher.
   * The request asks the target agent to share their skills.
   */
  async requestSkillSync(fromAgentId: string, category?: string): Promise<void> {
    const request: SkillSyncRequest = {
      requestId: `skill-sync-${randomUUID()}`,
      from: this.agentId,
      category,
      timestamp: new Date().toISOString(),
    }

    const messageId = request.requestId
    const dispatcher = this.getCloudDispatcher()
    if (dispatcher !== null) {
      const router = dispatcher.getCloudRouter()
      if (router !== null) {
        await router.sendMessage({
          messageId,
          type: 'skill_sync_request',
          from: this.agentName,
          to: fromAgentId,
          text: JSON.stringify(request),
          timestamp: request.timestamp,
          teamName: this.teamName,
        })
      }
    }
  }

  // ================================================================
  // Listen for incoming skill shares
  // ================================================================

  /**
   * Start listening for incoming skill_shared and skill_sync_request
   * events via the dispatcher's SSE connection.
   */
  onSkillShared(callback: (skill: SkillEntry) => Promise<void>): void {
    this.onSkillSharedCallback = callback

    // Start cloud listening if dispatcher has cloud active
    const dispatcher = this.getCloudDispatcher()
    if (dispatcher !== null && dispatcher.isCloudActive) {
      dispatcher.startCloudListening((msg: any) => {
        this.handleIncomingSkillMessage(msg)
      }).catch(() => {
        // SSE connection may fail — handled gracefully
      })
    }
  }

  // ================================================================
  // Get local learned skills
  // ================================================================

  /**
   * Return all locally learned skills.
   */
  getLocalSkills(): SkillEntry[] {
    return Array.from(this.localSkills.values())
  }

  // -- internal helpers ---------------------------------------------

  /**
   * Pull all skills from the cloud skills repo.
   */
  private async pullSkillsFromCloud(category?: string): Promise<SkillEntry[]> {
    const dispatcher = this.getCloudDispatcher()
    if (dispatcher === null) return []

    const router = dispatcher.getCloudRouter()
    if (router === null) return []

    const skillsAdapter = await this.getSkillsAdapter()
    const pullResult = await skillsAdapter.pull()
    if (pullResult === null) return []

    const skills: SkillEntry[] = []
    for (const [key, value] of Object.entries(pullResult.entries)) {
      if (!key.startsWith('skill/')) continue
      try {
        const entry = JSON.parse(value) as SkillEntry
        if (category && entry.category !== category) continue
        skills.push(entry)
      } catch {
        // Skip malformed entries
      }
    }

    return skills
  }

  /**
   * Get the cloud dispatcher, or null if cloud is not active.
   */
  private getCloudDispatcher(): MessageDispatcher | null {
    return this.dispatcher.isCloudActive ? this.dispatcher : null
  }

  /**
   * Create a SyncServerAdapter for the skills repo.
   * Uses the same auth as the cloud router but points to the skills repo.
   */
  private async getSkillsAdapter(): Promise<import('./syncServerAdapter.js').SyncServerAdapter> {
    const { SyncServerAdapter } = await import('./syncServerAdapter.js') as typeof import('./syncServerAdapter.js')
    const dispatcher = this.getCloudDispatcher()
    if (dispatcher === null) {
      throw new Error('Cloud dispatcher not available')
    }
    const router = dispatcher.getCloudRouter()
    if (router === null) {
      throw new Error('Cloud router not available')
    }
    return new SyncServerAdapter({
      apiUrl: router.getApiUrl(),
      apiKey: router.getApiKey(),
      repo: this.skillsRepo(),
      developerId: this.agentId,
    })
  }

  /**
   * Handle an incoming cloud message related to skills.
   */
  private async handleIncomingSkillMessage(msg: any): Promise<void> {
    // The CloudMessageRouter unwraps SSE frames — the outer `type` is 'task',
    // but the inner `type` in the JSON payload tells us the skill event type.
    const type = msg.type
    if (type === 'skill_shared') {
      try {
        const payload = typeof msg.text === 'string' ? JSON.parse(msg.text) : msg.text
        if (payload && payload.skill) {
          const skill = payload.skill as SkillEntry
          // Store in local skills
          this.localSkills.set(skill.id, skill)
          // Notify callback
          if (this.onSkillSharedCallback) {
            await this.onSkillSharedCallback(skill)
          }
        }
      } catch {
        // Malformed skill share — ignore
      }
    } else if (type === 'skill_sync_request') {
      // Another agent is requesting a skill sync — share our skills
      try {
        const payload = typeof msg.text === 'string' ? JSON.parse(msg.text) : msg.text
        if (payload) {
          const category = payload.category as string | undefined
          const skills = this.getLocalSkills()
          const filtered = category ? skills.filter(s => s.category === category) : skills
          // Share each skill via cloud
          for (const skill of filtered) {
            const key = this.skillKey(skill.id)
            const repo = this.skillsRepo()
            const router = this.getCloudDispatcher()?.getCloudRouter()
            if (router) {
              const skillsAdapter = await this.getSkillsAdapter()
              await skillsAdapter.push({ [key]: JSON.stringify(skill) })
            }
          }
        }
      } catch {
        // Malformed sync request — ignore
      }
    }
  }
}
