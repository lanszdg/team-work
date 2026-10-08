/**
 * LocalPreferenceStore — Local UI Preferences (v4 Architecture, Layer 4b)
 *
 * Persisted locally in ~/.claude/teams/{team}/local-prefs.json.
 * Never pushed to cloud. Survives process restarts.
 *
 * Currently manages: hiddenPaneIds (which panes are hidden from swarm view).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { LocalPreference } from './types.js'

export class LocalPreferenceStore {
  private prefs: LocalPreference = { hiddenPaneIds: [] }
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      this.prefs = {
        hiddenPaneIds: Array.isArray(parsed.hiddenPaneIds) ? parsed.hiddenPaneIds : [],
      }
    } catch {
      this.prefs = { hiddenPaneIds: [] }
    }
  }

  // ============================================================
  // Hidden Panes
  // ============================================================

  addHiddenPaneId(paneId: string): void {
    if (!this.prefs.hiddenPaneIds.includes(paneId)) {
      this.prefs.hiddenPaneIds.push(paneId)
      this.save()
    }
  }

  removeHiddenPaneId(paneId: string): void {
    const idx = this.prefs.hiddenPaneIds.indexOf(paneId)
    if (idx !== -1) {
      this.prefs.hiddenPaneIds.splice(idx, 1)
      this.save()
    }
  }

  getHiddenPaneIds(): string[] {
    return [...this.prefs.hiddenPaneIds]
  }

  isHidden(paneId: string): boolean {
    return this.prefs.hiddenPaneIds.includes(paneId)
  }

  // ============================================================
  // Internal
  // ============================================================

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.prefs, null, 2))
    } catch { /* non-fatal */ }
  }
}
