export const DEMO_SYNC_URL = 'http://127.0.0.1:3000'
export const DEMO_API_KEY = 'local-development-only'

let warnedDemoKey = false
let warnedImplicitDemo = false
let warnedNoConfig = false

export function isDemoCloudEnabled(): boolean {
  return process.env.TEAM_COLLAB_DEMO_MODE === '1'
}

export function isAutoJoinEnabled(): boolean {
  return process.env.TEAM_COLLAB_AUTO_JOIN === '1'
}

export function getConfiguredSyncUrl(): string | undefined {
  const explicit = process.env.TEAM_MEMORY_SYNC_URL?.trim()
  if (explicit) return explicit

  if (isDemoCloudEnabled()) {
    if (!warnedImplicitDemo) {
      console.warn(`[TeamCollab] TEAM_COLLAB_DEMO_MODE=1: using demo sync server ${DEMO_SYNC_URL}`)
      warnedImplicitDemo = true
    }
    return DEMO_SYNC_URL
  }

  if (!warnedNoConfig) {
    console.warn('[TeamCollab] TEAM_MEMORY_SYNC_URL not set and TEAM_COLLAB_DEMO_MODE!=1 — cloud sync disabled. Set TEAM_MEMORY_SYNC_URL or TEAM_COLLAB_DEMO_MODE=1 to enable.')
    warnedNoConfig = true
  }
  return undefined
}

export function getConfiguredApiKey(): string {
  const explicit = process.env.TEAM_MEMORY_SYNC_API_KEY?.trim()
  if (explicit) return explicit

  if (isDemoCloudEnabled()) {
    if (!warnedDemoKey) {
      console.warn('[TeamCollab] TEAM_COLLAB_DEMO_MODE=1: using demo API key. Set TEAM_MEMORY_SYNC_API_KEY for production.')
      warnedDemoKey = true
    }
    return DEMO_API_KEY
  }

  if (!warnedDemoKey) {
    console.warn('[TeamCollab] TEAM_MEMORY_SYNC_API_KEY not set — using empty key. Cloud operations may fail.')
    warnedDemoKey = true
  }
  return ''
}
