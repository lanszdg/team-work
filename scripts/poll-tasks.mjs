#!/usr/bin/env node
/**
 * Task Poller — team-collab-plugin
 *
 * Polls team-collab-control for tasks assigned to this runtime.
 * When a new task is found (status=assigned), creates a session
 * and writes state to .claude-plugin/current-session.json for
 * downstream hook scripts.
 *
 * Usage:
 *   node scripts/poll-tasks.mjs [--interval 10]
 *
 * Runs until Ctrl-C.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100';
const CONTROL_PLANE_TOKEN = process.env.CONTROL_PLANE_TOKEN ?? '';
const ORG_ID = process.env.ORG_ID ?? 'default';
const INTERVAL_MS = (parseInt(process.argv[3] ?? '10', 10)) * 1000;
const STATE_FILE = join(process.cwd(), '.claude-plugin', 'current-session.json');

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function writeState(data) {
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

const HEADERS = {
  'Content-Type': 'application/json',
  'x-plugin-token': CONTROL_PLANE_TOKEN,
  'x-org-id': ORG_ID,
};

async function fetchAssignedTasks(runtimeId) {
  const url = `${CONTROL_PLANE_URL}/api/v1/tasks?runtime_id=${encodeURIComponent(runtimeId)}&status=assigned&limit=5`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return [];
  const { tasks } = await res.json();
  return tasks ?? [];
}

async function startSession(taskId, runtimeId) {
  const res = await fetch(`${CONTROL_PLANE_URL}/api/v1/sessions/start`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      task_id: taskId,
      runtime_id: runtimeId,
      session_type: 'task_execution',
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function acceptTask(taskId) {
  await fetch(`${CONTROL_PLANE_URL}/api/v1/tasks/${encodeURIComponent(taskId)}/status`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ status: 'accepted' }),
  });
}

async function poll() {
  const state = readState();
  if (!state?.runtime_id) {
    console.error('[poll] No runtime_id in state. Run register-runtime.mjs first.');
    return;
  }

  if (state.session_id && state.task_id) {
    console.log(`[poll] Session active: task=${state.task_id} — skipping`);
    return;
  }

  const tasks = await fetchAssignedTasks(state.runtime_id).catch(err => {
    console.error(`[poll] fetch error: ${err.message}`);
    return [];
  });

  if (tasks.length === 0) {
    process.stdout.write('.');
    return;
  }

  const task = tasks[0];
  console.log(`\n[poll] New task: ${task.task_id} — "${task.title}"`);

  await acceptTask(task.task_id).catch(() => {});

  const session = await startSession(task.task_id, state.runtime_id);
  if (!session?.session_id) {
    console.error('[poll] Failed to start session');
    return;
  }

  writeState({ ...state, session_id: session.session_id, task_id: task.task_id });
  console.log(`[poll] Session started: ${session.session_id}`);
  console.log(`[poll] → Context written to .claude-plugin/current-session.json`);
  console.log(`[poll] → Task ready. Start Claude Code in this workspace.`);
}

if (!CONTROL_PLANE_TOKEN) {
  console.error('[poll] CONTROL_PLANE_TOKEN not set');
  process.exit(1);
}

console.log(`[poll] Polling ${CONTROL_PLANE_URL} every ${INTERVAL_MS / 1000}s …`);
poll();
const timer = setInterval(poll, INTERVAL_MS);

process.on('SIGINT', () => {
  clearInterval(timer);
  console.log('\n[poll] stopped');
  process.exit(0);
});
