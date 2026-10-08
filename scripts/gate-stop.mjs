#!/usr/bin/env node
/**
 * gate-stop.mjs
 *
 * Stop hook: pushes a lightweight GATE 5 summary to team cloud
 * so teammates can see what changed in the next SessionStart.
 *
 * Part of team-collab-plugin's code-triple-guard integration.
 */

const TEAM_NAME = process.env.TEAM_NAME;
const AGENT_ID = process.env.AGENT_ID;
const AGENT_NAME = process.env.AGENT_NAME;
const SYNC_URL = process.env.TEAM_MEMORY_SYNC_URL;
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY;

// Skip if not in a team or no cloud sync configured
if (!TEAM_NAME || !SYNC_URL || !API_KEY) {
  process.exit(0);
}

async function main() {
  try {
    // Collect lightweight gate summary
    let changedFiles = '';
    let testResult = 'unknown';
    let gate5Report = '';

    // Try to get git diff summary
    try {
      const { execSync } = await import('child_process');
      changedFiles = execSync('git diff --name-only HEAD~1 2>/dev/null || git diff --name-only --cached 2>/dev/null || echo ""', {
        encoding: 'utf-8',
        timeout: 3000
      }).trim();
    } catch {
      changedFiles = '';
    }

    // Try to read gate 5 report if it exists
    try {
      const fs = await import('fs');
      if (fs.existsSync('/tmp/.ctg-gate5-report.md')) {
        gate5Report = fs.readFileSync('/tmp/.ctg-gate5-report.md', 'utf-8').substring(0, 2000);
      }
    } catch {
      gate5Report = '';
    }

    // Try to get last test result
    try {
      if (require('fs').existsSync('/tmp/.ctg-test-result.json')) {
        const result = JSON.parse(require('fs').readFileSync('/tmp/.ctg-test-result.json', 'utf-8'));
        testResult = (result.failures || result.numFailedTests || 0) === 0 ? 'passed' : 'failed';
      }
    } catch {
      testResult = 'unknown';
    }

    // Push summary to team cloud
    const repo = 'team-gates';
    const key = `gate5/${AGENT_ID}/${Math.floor(Date.now() / 1000)}`;
    const timestamp = new Date().toISOString();

    const payload = {
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      timestamp,
      changedFiles: changedFiles.split('\n').filter(Boolean).slice(0, 20),
      testResult,
      hasReport: gate5Report.length > 0,
      report: gate5Report.substring(0, 500) // Truncate for KV storage
    };

    const response = await fetch(
      `${SYNC_URL}/api/team_memory?repo=${encodeURIComponent(repo)}`,
      {
        method: 'PUT',
        headers: {
          'X-API-Key': API_KEY,
          'X-Developer-ID': AGENT_ID || 'unknown',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          entries: {
            [key]: JSON.stringify(payload)
          }
        }),
        signal: AbortSignal.timeout(5000)
      }
    );

    if (response.ok) {
      console.log(`[TeamGuard] GATE 5 summary pushed to team cloud (${testResult})`);
    }

  } catch (_err) {
    // Silently skip — gate push is best-effort
    process.exit(0);
  }
}

main();
