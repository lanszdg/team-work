/**
 * iTerm2 Backend Implementation
 *
 * Uses iTerm2's native AppleScript API for split pane management on macOS.
 * Requires the `it2` CLI tool to be installed.
 *
 * Extracted from open-claude-code src/utils/swarm/backends/ITermBackend.ts
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PaneBackend, CreatePaneResult } from './types.js'
import type { AgentColorName } from '../platform/constants.js'
import type { BackendType } from '../core/types.js'

const execAsync = promisify(execFile)

/**
 * ITermBackend manages teammate panes using iTerm2 native split panes.
 */
export class ITermBackend implements PaneBackend {
  readonly type: BackendType = 'iterm2'

  private _teammateCount = 0

  /**
   * P14: Tracks the right-side session ID from the first vertical split.
   * Subsequent splits target this session to create side-by-side layout
   * instead of nested splits inside teammate1's session.
   */
  private _rightSessionId: string | null = null

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('which', ['it2'])
      // Also check if iTerm2 is running
      await execAsync('osascript', [
        '-e', 'tell application "iTerm2" to return running'
      ])
      return true
    } catch {
      return false
    }
  }

  async createTeammatePaneInSwarmView(
    _teammateName: string,
    _teammateColor: AgentColorName,
  ): Promise<CreatePaneResult> {
    this._teammateCount++
    const isFirst = this._teammateCount === 1

    if (isFirst) {
      // First call: split vertically from current session (creates right-side area)
      const appleScript = `
        tell application "iTerm2"
          tell current window
            tell current session
              split vertically with default profile
            end tell
          end tell
        end tell
      `
      await execAsync('osascript', ['-e', appleScript])

      // Get the newly created session ID and track it as the right-side anchor
      const sessionIdResult = await execAsync('osascript', [
        '-e', `
          tell application "iTerm2"
            tell current window
              tell current session
                return unique ID
              end tell
            end tell
          end tell
        `
      ])
      const paneId = sessionIdResult.stdout.trim()
      this._rightSessionId = paneId

      return { paneId, isFirstTeammate: isFirst }
    } else {
      // P14: Subsequent calls — split the right-side session horizontally
      // This creates side-by-side layout instead of nested splits
      if (!this._rightSessionId) {
        throw new Error(
          'Cannot create teammate pane: no right-side session available for split. ' +
          'Ensure the first teammate pane was created successfully.'
        )
      }
      const appleScript = `
        tell application "iTerm2"
          tell current window
            repeat with aSession in sessions
              if unique ID of aSession is "${this._rightSessionId}" then
                tell aSession
                  split horizontally with default profile
                end tell
              end if
            end repeat
          end tell
        end tell
      `
      await execAsync('osascript', ['-e', appleScript])

      // Get the newly created session ID and update the right-side tracker
      const sessionIdResult = await execAsync('osascript', [
        '-e', `
          tell application "iTerm2"
            tell current window
              tell current session
                return unique ID
              end tell
            end tell
          end tell
        `
      ])
      const paneId = sessionIdResult.stdout.trim()
      this._rightSessionId = paneId

      return { paneId, isFirstTeammate: isFirst }
    }
  }

  async sendCommandToPane(paneId: string, command: string): Promise<void> {
    // P13: Target the specific session by unique ID instead of sending to current session
    const escapedCommand = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const appleScript = `
      tell application "iTerm2"
        tell current window
          repeat with aSession in sessions
            if unique ID of aSession is "${paneId}" then
              tell aSession to write text "${escapedCommand}"
            end if
          end repeat
        end tell
      end tell
    `
    await execAsync('osascript', ['-e', appleScript])
  }

  async enablePaneBorderStatus(): Promise<void> {
    // iTerm2 shows tab/session titles natively
    // No additional configuration needed
  }

  async killPane(paneId: string): Promise<boolean> {
    try {
      const appleScript = `
        tell application "iTerm2"
          tell current window
            repeat with aSession in sessions
              if unique ID of aSession is "${paneId}" then
                tell aSession to close
              end if
            end repeat
          end tell
        end tell
      `
      await execAsync('osascript', ['-e', appleScript])
      return true
    } catch {
      return false
    }
  }
}
