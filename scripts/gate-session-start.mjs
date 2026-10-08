#!/usr/bin/env node
/**
 * gate-session-start.mjs
 *
 * SessionStart hook: checks for pending cross-machine gate verification
 * tasks from team cloud. If found, emits a system-reminder for the user.
 *
 * Part of team-collab-plugin's code-triple-guard integration.
 */

const TEAM_NAME = process.env.TEAM_NAME;
const AGENT_ID = process.env.AGENT_ID;
const SYNC_URL = process.env.TEAM_MEMORY_SYNC_URL;
const API_KEY = process.env.TEAM_MEMORY_SYNC_API_KEY;

// Skip if not in a team or no cloud sync configured
if (!TEAM_NAME || !SYNC_URL || !API_KEY) {
  process.exit(0);
}

async function main() {
  try {
    const repo = 'team-gates';
    const url = `${SYNC_URL}/api/team_memory?repo=${encodeURIComponent(repo)}`;

    const response = await fetch(url, {
      headers: {
        'X-API-Key': API_KEY,
        'X-Developer-ID': AGENT_ID || 'unknown',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      process.exit(0); // Server unreachable, skip
    }

    const data = await response.json();
    const entries = data?.entries || {};
    const myOS = process.platform;

    // Collect pending tasks targeting this OS
    const pendingTasks = [];
    const lastGateReports = [];

    for (const [key, value] of Object.entries(entries)) {
      const entry = typeof value === 'string' ? JSON.parse(value) : value;

      // Pending verification tasks
      if (key.startsWith('verify/') && entry?.status === 'pending') {
        const targetOS = entry?.targetOS || 'any';
        if (targetOS === 'any' || targetOS === myOS) {
          pendingTasks.push({
            boundary: key.split('/').pop(),
            testCommand: entry?.testCommand || 'npm test',
            requestedBy: entry?.requestedBy || 'unknown',
            targetOS
          });
        }
      }

      // Recent gate reports from teammates
      if (key.startsWith('gate5/') && entry?.timestamp) {
        lastGateReports.push({
          agentName: entry?.agentName || 'unknown',
          timestamp: entry?.timestamp,
          hasReport: !!entry?.report
        });
      }
    }

    // Output: pending cross-machine verification tasks
    if (pendingTasks.length > 0) {
      const lines = [];
      lines.push('');
      lines.push('╔══════════════════════════════════════════════╗');
      lines.push('║  🔬 Team GATE 4 — 跨机边界验证任务            ║');
      lines.push('╠══════════════════════════════════════════════╣');
      lines.push(`║  你的 OS: ${myOS.padEnd(33)}║`);
      lines.push('╠══════════════════════════════════════════════╣');
      for (const task of pendingTasks) {
        lines.push(`║  • ${task.boundary.padEnd(37)}║`);
        lines.push(`║    请求者: ${task.requestedBy.padEnd(30)}║`);
        lines.push(`║    目标 OS: ${task.targetOS.padEnd(30)}║`);
        lines.push(`║    命令: ${task.testCommand.substring(0, 36).padEnd(36)}║`);
      }
      lines.push('╠══════════════════════════════════════════════╣');
      lines.push('║  输入 "执行边界检查" 运行这些验证任务          ║');
      lines.push('╚══════════════════════════════════════════════╝');
      lines.push('');

      process.stdout.write(`\n<system-reminder>\n${lines.join('\n')}\n</system-reminder>\n`);
    }

    // Output: recent teammate gate reports
    if (lastGateReports.length > 0) {
      const sorted = lastGateReports.sort((a, b) =>
        new Date(b.timestamp) - new Date(a.timestamp)
      );
      const latest = sorted[0];

      const lines = [];
      lines.push('');
      lines.push('┌──────────────────────────────────────────┐');
      lines.push('│  📋 Team GATE 5 — 队友变更记录             │');
      lines.push('├──────────────────────────────────────────┤');
      lines.push(`│  ${latest.agentName} 最近完成了质量门检查              │`);
      lines.push(`│  时间: ${latest.timestamp}  │`);
      lines.push('│  输入 "查看队友变更" 了解详情               │');
      lines.push('└──────────────────────────────────────────┘');
      lines.push('');

      process.stdout.write(`\n<system-reminder>\n${lines.join('\n')}\n</system-reminder>\n`);
    }

  } catch (_err) {
    // Silently skip on any error — gate checking is non-blocking
    process.exit(0);
  }
}

main();
