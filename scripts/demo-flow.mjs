#!/usr/bin/env node
/**
 * End-to-End Integration Demo
 *
 * Simulates the full team-collab flow:
 *   1. Register Runtime
 *   2. Create Task (via control plane)
 *   3. Assign Task to Runtime member
 *   4. Plugin polls and starts Session
 *   5. Report Execution result
 *   6. Publish Artifact
 *
 * Prerequisites:
 *   - team-collab-control running on CONTROL_PLANE_URL
 *   - CONTROL_PLANE_TOKEN / ORG_ID set in .env or environment
 *
 * Usage:
 *   node scripts/demo-flow.mjs
 */

import os from 'os';

const BASE = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100';
const TOKEN = process.env.CONTROL_PLANE_TOKEN ?? 'demo-token-12345678';
const ORG = process.env.ORG_ID ?? 'demo-org';
const MEMBER = process.env.MEMBER_ID ?? os.userInfo().username;
const TEAM = process.env.TEAM_ID ?? 'demo-team';

const H = {
  'Content-Type': 'application/json',
  'x-plugin-token': TOKEN,
  'x-org-id': ORG,
};

async function post(path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(data.error)}`);
  return data;
}

async function get(path) {
  const res = await fetch(`${BASE}/api/v1${path}`, { headers: H });
  const data = await res.json();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${JSON.stringify(data.error)}`);
  return data;
}

function step(n, msg) {
  console.log(`\n[${n}/6] ${msg}`);
}

async function main() {
  console.log('='.repeat(50));
  console.log('  team-collab End-to-End Demo');
  console.log(`  Control Plane: ${BASE}`);
  console.log('='.repeat(50));

  // 1. Register Runtime
  step(1, 'Registering Runtime...');
  const reg = await post('/runtimes/register', {
    member_id: MEMBER,
    team_id: TEAM,
    runtime_type: 'local_agent',
    host_name: os.hostname(),
    platform: process.platform,
    plugin_version: '1.0.0',
    capability_snapshot: ['code_generation', 'test_generation', 'code_review'],
  });
  console.log(`  ✓ runtime_id = ${reg.runtime_id}`);
  console.log(`  ✓ heartbeat_interval = ${reg.heartbeat_interval_seconds}s`);

  // 2. Create Task
  step(2, 'Creating Task...');
  const task = await post('/tasks', {
    project_id: 'demo-project',
    owner_team_id: TEAM,
    title: 'Implement user authentication module',
    description: 'Add JWT-based auth to the REST API',
    priority: 'high',
    responsible_role: 'developer',
    source_type: 'manual',
  });
  console.log(`  ✓ task_id = ${task.task_id}, status = ${task.status}`);

  // 3. Assign Task to member
  step(3, 'Assigning Task to member...');
  const assign = await post(`/tasks/${task.task_id}/assign`, {
    to_member_id: MEMBER,
    assignment_type: 'team_internal',
  });
  console.log(`  ✓ assignment_id = ${assign.assignment_id}, status = ${assign.status}`);

  // 4. Start Session (simulates plugin polling → accepting → session start)
  step(4, 'Starting Session (simulates plugin poll)...');
  // Accept task first
  await post(`/tasks/${task.task_id}/status`, { status: 'accepted' });
  const session = await post('/sessions/start', {
    task_id: task.task_id,
    runtime_id: reg.runtime_id,
    session_type: 'task_execution',
    role_context_ref: `role:${MEMBER}`,
  });
  console.log(`  ✓ session_id = ${session.session_id}, status = ${session.status}`);

  // 5. Report Execution
  step(5, 'Reporting Execution result (simulates Stop hook)...');
  const exec = await post('/executions/report', {
    session_id: session.session_id,
    task_id: task.task_id,
    capability_id: 'code_generation',
    executor_type: 'agent',
    result_status: 'success',
    summary: 'Implemented JWT auth: login, refresh, logout endpoints with middleware.',
  });
  console.log(`  ✓ execution_id = ${exec.execution_id}, status = ${exec.status}`);

  // 6. Publish Artifact
  step(6, 'Publishing Artifact...');
  const artifact = await post('/artifacts/publish', {
    task_id: task.task_id,
    artifact_type: 'code_diff',
    title: 'feat: JWT authentication module',
    storage_ref: `git://demo-repo/commit/abc123-${Date.now()}`,
    version: 1,
    visibility_scope: 'team',
  });
  console.log(`  ✓ artifact_id = ${artifact.artifact_id}`);

  console.log('\n' + '='.repeat(50));
  console.log('  Demo complete! Full flow executed successfully.');
  console.log('='.repeat(50));
}

main().catch(err => {
  console.error(`\n[demo] FAILED: ${err.message}`);
  process.exit(1);
});
