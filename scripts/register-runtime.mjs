#!/usr/bin/env node
/**
 * Register this machine as a Runtime with team-collab-control.
 *
 * Run once at plugin startup:
 *   node scripts/register-runtime.mjs
 *
 * Writes runtime_id + session stub to .claude-plugin/current-session.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100';
const CONTROL_PLANE_TOKEN = process.env.CONTROL_PLANE_TOKEN ?? '';
const ORG_ID = process.env.ORG_ID ?? 'default';
const MEMBER_ID = process.env.MEMBER_ID ?? os.userInfo().username;
const TEAM_ID = process.env.TEAM_ID ?? 'default-team';
const PLUGIN_VERSION = '1.0.0';
const STATE_DIR = join(process.cwd(), '.claude-plugin');
const STATE_FILE = join(STATE_DIR, 'current-session.json');

async function main() {
  if (!CONTROL_PLANE_TOKEN) {
    console.error('[register] CONTROL_PLANE_TOKEN not set — skipping registration');
    process.exit(0);
  }

  const payload = {
    member_id: MEMBER_ID,
    team_id: TEAM_ID,
    runtime_type: 'local_agent',
    host_name: os.hostname(),
    platform: process.platform,
    plugin_version: PLUGIN_VERSION,
    capability_snapshot: ['code_generation', 'code_review', 'test_generation', 'documentation'],
  };

  const res = await fetch(`${CONTROL_PLANE_URL}/api/v1/runtimes/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-plugin-token': CONTROL_PLANE_TOKEN,
      'x-org-id': ORG_ID,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[register] failed (${res.status}): ${body}`);
    process.exit(1);
  }

  const { runtime_id, heartbeat_interval_seconds } = await res.json();
  console.log(`[register] runtime_id = ${runtime_id}`);

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({
    runtime_id,
    heartbeat_interval_seconds,
    registered_at: new Date().toISOString(),
    session_id: null,
    task_id: null,
  }, null, 2));

  console.log(`[register] state written to ${STATE_FILE}`);
}

main().catch(err => {
  console.error(`[register] error: ${err.message}`);
  process.exit(1);
});
