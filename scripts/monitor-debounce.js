#!/usr/bin/env node
/**
 * Team Collaboration Monitor with Debouncing
 *
 * Background monitor script that connects to the team collaboration system
 * and outputs events to stdout to trigger Claude Code model rewake.
 *
 * CRITICAL: This script implements strict debouncing and threshold filtering
 * to prevent token-consuming wake storms. Only "critical" events pass through.
 *
 * Environment Variables:
 *   TEAM_NAME               - Team name to monitor
 *   DEBOUNCE_MS             - Debounce window in ms (default: 5000)
 *   MAX_EVENTS_PER_WINDOW   - Max events before triggering (default: 3)
 *   CLAUDE_PLUGIN_DATA      - Plugin data directory for team files
 *
 * Exit Codes:
 *   0 - Normal exit (monitoring stopped)
 *   1 - Fatal error
 */

'use strict'

// ============================================================
// Configuration
// ============================================================

const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '5000', 10)
const MAX_EVENTS_PER_WINDOW = parseInt(process.env.MAX_EVENTS_PER_WINDOW || '3', 10)
const TEAM_NAME = process.env.TEAM_NAME || 'default'
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || process.env.HOME + '/.claude/plugins/data/team-collab'
const TEAMS_DIR = PLUGIN_DATA + '/teams'
const CONFIG_FILE = `${TEAMS_DIR}/${sanitizeName(TEAM_NAME)}/config.json`
const INBOXES_DIR = `${TEAMS_DIR}/${sanitizeName(TEAM_NAME)}/inboxes`

// ============================================================
// State
// ============================================================

let eventBuffer = []
let lastOutputTime = 0
let isDebouncing = false
let shutdownRequested = false
let lastKnownMemberStates = new Map()
let lastKnownConfigHash = ''

// ============================================================
// Utility Functions
// ============================================================

function sanitizeName(name) {
  // Preserve Unicode letters (including CJK, Cyrillic, Arabic)
  return name.replace(/[^\p{L}\p{N}]/gu, '-').toLowerCase()
}

function log(message) {
  const timestamp = new Date().toISOString()
  // Write to stderr for debugging (doesn't trigger rewake)
  process.stderr.write(`[Monitor] ${timestamp} ${message}\n`)
}

function outputCritical(message) {
  // Write to stdout to trigger Claude Code rewake
  const timestamp = new Date().toISOString()
  const structured = JSON.stringify({
    type: 'team-collab-critical',
    timestamp,
    team: TEAM_NAME,
    message,
  })
  process.stdout.write(structured + '\n')
  process.stdout.flush?.()
  log(`Output critical: ${message}`)
}

// ============================================================
// Debouncing Logic
// ============================================================

/**
 * Aggregates events within the debounce window.
 * Only outputs when:
 * 1. Debounce window expires AND buffer has events, OR
 * 2. Buffer exceeds MAX_EVENTS_PER_WINDOW threshold, OR
 * 3. A "fatal" event is detected (immediate output, no debounce)
 */
function bufferEvent(event) {
  eventBuffer.push({
    ...event,
    receivedAt: Date.now(),
  })

  log(`Event buffered: ${event.type} from ${event.source} (${eventBuffer.length} in buffer)`)

  // Check for fatal events that bypass debouncing
  if (event.severity === 'fatal') {
    flushBuffer('Fatal event detected')
    return
  }

  // Check if buffer exceeds threshold
  if (eventBuffer.length >= MAX_EVENTS_PER_WINDOW) {
    flushBuffer(`Threshold exceeded (${eventBuffer.length} events)`)
    return
  }

  // Start debounce timer if not already running
  if (!isDebouncing) {
    isDebouncing = true
    setTimeout(() => {
      flushBuffer('Debounce window expired')
    }, DEBOUNCE_MS)
  }
}

/**
 * Flushes the event buffer as a single aggregated message.
 */
function flushBuffer(reason) {
  if (eventBuffer.length === 0) {
    isDebouncing = false
    return
  }

  const events = [...eventBuffer]
  eventBuffer = []
  isDebouncing = false

  // Aggregate events into a single critical message
  const eventSummary = aggregateEvents(events)
  outputCritical(`${reason}: ${eventSummary}`)

  lastOutputTime = Date.now()
}

/**
 * Aggregates multiple events into a concise summary.
 */
function aggregateEvents(events) {
  // Group by type
  const byType = {}
  for (const e of events) {
    byType[e.type] = byType[e.type] || []
    byType[e.type].push(e)
  }

  const parts = []
  for (const [type, group] of Object.entries(byType)) {
    const sources = [...new Set(group.map(e => e.source))]
    if (sources.length > 1) {
      parts.push(`${type}: ${sources.length} teammates affected`)
    } else {
      parts.push(`${type}: ${sources[0]}`)
    }
  }

  return parts.join('; ')
}

// ============================================================
// Monitoring Logic
// ============================================================

/**
 * Monitors the team config file for member state changes.
 */
function monitorTeamConfig() {
  const fs = require('fs')
  const crypto = require('crypto')

  function checkConfig() {
    if (shutdownRequested) return

    try {
      if (!fs.existsSync(CONFIG_FILE)) {
        setTimeout(checkConfig, 2000)
        return
      }

      const content = fs.readFileSync(CONFIG_FILE, 'utf-8')
      const currentHash = crypto.createHash('sha256').update(content).digest('hex')

      if (currentHash !== lastKnownConfigHash && lastKnownConfigHash !== '') {
        const config = JSON.parse(content)
        detectMemberChanges(config)
      }

      lastKnownConfigHash = currentHash
    } catch (e) {
      log(`Error reading config: ${e.message}`)
    }

    setTimeout(checkConfig, 1000)
  }

  // Initial read
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8')
      lastKnownConfigHash = crypto.createHash('sha256').update(content).digest('hex')
      const config = JSON.parse(content)
      for (const member of config.members || []) {
        lastKnownMemberStates.set(member.name, member.isActive !== false)
      }
    }
  } catch (e) {
    log(`Initial config read failed: ${e.message}`)
  }

  checkConfig()
}

/**
 * Detects changes in member active states.
 */
function detectMemberChanges(config) {
  const currentStates = new Map()
  for (const member of config.members || []) {
    currentStates.set(member.name, member.isActive !== false)
  }

  for (const [name, wasActive] of lastKnownMemberStates) {
    const isActive = currentStates.get(name)
    if (isActive === undefined) continue // Member removed

    if (wasActive && isActive === false) {
      // Member went idle - NOT critical, just buffer
      bufferEvent({
        type: 'member-idle',
        source: name,
        severity: 'info',
      })
    } else if (wasActive === false && isActive === true) {
      // Member became active again - NOT critical
      bufferEvent({
        type: 'member-active',
        source: name,
        severity: 'info',
      })
    }
  }

  // Check for new members
  for (const [name, isActive] of currentStates) {
    if (!lastKnownMemberStates.has(name) && name !== 'team-lead') {
      // New member joined - potentially critical (new task delegation)
      bufferEvent({
        type: 'member-joined',
        source: name,
        severity: 'warning',
      })
    }
  }

  lastKnownMemberStates = currentStates
}

/**
 * Monitors inbox directories for new messages.
 */
function monitorInboxes() {
  const fs = require('fs')
  const path = require('path')

  if (!fs.existsSync(INBOXES_DIR)) {
    setTimeout(monitorInboxes, 2000)
    return
  }

  const inboxFiles = new Map()

  function checkInboxes() {
    if (shutdownRequested) return

    try {
      const files = fs.readdirSync(INBOXES_DIR).filter(f => f.endsWith('.json'))

      for (const file of files) {
        const filePath = path.join(INBOXES_DIR, file)
        const stat = fs.statSync(filePath)
        const lastModified = stat.mtimeMs
        const lastKnown = inboxFiles.get(file)

        if (lastKnown === undefined || lastModified > lastKnown) {
          inboxFiles.set(file, lastModified)

          // Read the inbox to check for structured messages
          try {
            const content = fs.readFileSync(filePath, 'utf-8')
            const messages = JSON.parse(content)
            const unread = messages.filter(m => !m.read)

            for (const msg of unread) {
              // Check for critical message types
              if (isCriticalMessage(msg.text)) {
                bufferEvent({
                  type: 'critical-message',
                  source: msg.from,
                  severity: 'fatal',
                })
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    } catch (e) {
      log(`Error checking inboxes: ${e.message}`)
    }

    setTimeout(checkInboxes, 1000)
  }

  checkInboxes()
}

/**
 * Checks if a message text is critical (requires immediate attention).
 */
function isCriticalMessage(text) {
  try {
    const parsed = JSON.parse(text)
    return (
      parsed.type === 'shutdown_request' ||
      parsed.type === 'permission_request' ||
      parsed.type === 'plan_approval_request' ||
      parsed.type === 'sandbox_permission_request'
    )
  } catch {
    return false
  }
}

// ============================================================
// Signal Handling
// ============================================================

process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully')
  shutdownRequested = true
  if (eventBuffer.length > 0) {
    flushBuffer('Shutdown requested')
  }
  process.exit(0)
})

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down gracefully')
  shutdownRequested = true
  if (eventBuffer.length > 0) {
    flushBuffer('Shutdown requested')
  }
  process.exit(0)
})

// ============================================================
// Main
// ============================================================

function main() {
  log(`Starting team collaboration monitor for team "${TEAM_NAME}"`)
  log(`Debounce: ${DEBOUNCE_MS}ms, Max events per window: ${MAX_EVENTS_PER_WINDOW}`)

  // Start monitoring
  monitorTeamConfig()
  monitorInboxes()

  // Heartbeat (stderr only, doesn't trigger rewake)
  setInterval(() => {
    log(`Heartbeat - buffer size: ${eventBuffer.length}`)
  }, 30000)
}

main()
