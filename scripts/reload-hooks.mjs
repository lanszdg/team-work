#!/usr/bin/env node
/**
 * Hook reload script — L2 fix.
 *
 * Called by hooks.json "reload-plugins" command.
 * Re-initializes team-collab without restarting Claude Code.
 * Outputs system-reminder confirming reload status.
 */

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
if (!pluginRoot) {
  console.log('<system-reminder>\n[TeamCollab] CLAUDE_PLUGIN_ROOT not set — cannot reload plugin.\n</system-reminder>')
  process.exit(0)
}

try {
  const { initTeamCollab } = await import(`${pluginRoot}/dist/init.js`)
  const ok = await initTeamCollab()
  const msg = ok
    ? '[TeamCollab] ✅ Plugin reloaded — discovery, heartbeat, SSE, tasks: all reactivated.'
    : '[TeamCollab] Plugin already active — no reload needed.'
  console.log(`<system-reminder>\n${msg}\n</system-reminder>`)
} catch (err) {
  console.log(`<system-reminder>\n[TeamCollab] ❌ Reload failed: ${err.message}\n</system-reminder>`)
}
