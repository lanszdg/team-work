#!/usr/bin/env node
/**
 * Claude Code Stop Hook → team-collab-control
 *
 * Called when Claude Code finishes a task session.
 * Reads session context from env/state file, reports result to control plane.
 *
 * Claude Code passes hook data via stdin as JSON.
 * See: docs/claude-code-integration.md
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100';
const CONTROL_PLANE_TOKEN = process.env.CONTROL_PLANE_TOKEN ?? '';
const ORG_ID = process.env.ORG_ID ?? 'default';
const SESSION_STATE_FILE = join(process.cwd(), '.claude-plugin', 'current-session.json');

async function main() {
  if (!CONTROL_PLANE_TOKEN) {
    process.exit(0);
  }

  let hookData = {};
  try {
    const raw = readFileSync('/dev/stdin', 'utf8');
    hookData = JSON.parse(raw);
  } catch {
    // stdin may be empty in some Claude Code versions
  }

  if (!existsSync(SESSION_STATE_FILE)) {
    process.exit(0);
  }

  let sessionState;
  try {
    sessionState = JSON.parse(readFileSync(SESSION_STATE_FILE, 'utf8'));
  } catch {
    process.exit(0);
  }

  const { session_id, task_id } = sessionState;
  if (!session_id || !task_id) {
    process.exit(0);
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-plugin-token': CONTROL_PLANE_TOKEN,
    'x-org-id': ORG_ID,
  };

  const execPayload = {
    session_id,
    task_id,
    capability_id: 'code_generation',
    executor_type: 'agent',
    result_status: hookData.stop_reason === 'error' ? 'retryable_failure' : 'success',
    summary: hookData.result ?? 'Claude Code session completed',
  };

  try {
    await fetch(`${CONTROL_PLANE_URL}/api/v1/executions/report`, {
      method: 'POST',
      headers,
      body: JSON.stringify(execPayload),
    });
  } catch (err) {
    process.stderr.write(`[on-stop] execution report failed: ${err.message}\n`);
  }
}

main().catch(err => {
  process.stderr.write(`[on-stop] unexpected error: ${err.message}\n`);
  process.exit(0);
});
