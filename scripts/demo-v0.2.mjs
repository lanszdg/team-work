/**
 * demo-v0.2.mjs — End-to-end v0.2 flow validation
 *
 * Tests: Org setup → Team/Member creation → Runtime registration
 *        → Task creation → AI decompose → PM confirm
 *        → Route subtask → Approve start → Report execution
 *        → Approve result → Next subtask auto-activated
 *
 * Run: node scripts/demo-v0.2.mjs
 */

import { readFileSync } from 'fs';

const BASE = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100';
const TOKEN = process.env.CONTROL_PLANE_TOKEN ?? 'dev-plugin-token';

const h = { 'Content-Type': 'application/json', 'x-plugin-token': TOKEN };

let passed = 0;
let failed = 0;

async function step(label, fn) {
  try {
    const result = await fn();
    console.log(`  ✅ ${label}`);
    passed++;
    return result;
  } catch (err) {
    console.error(`  ❌ ${label}: ${err.message}`);
    failed++;
    return null;
  }
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data)}`);
  return data;
}

console.log('\n=== Team Collab v0.2 Demo ===\n');

// ── 1. Create Org ────────────────────────────────────────────────────────────
console.log('【1】 Org Structure Setup');
const org = await step('Create org', () =>
  api('POST', '/orgs', { org_name: 'Demo Corp' })
);

const team = await step('Create team with capability_tags', () =>
  api('POST', `/orgs/${org.org_id}/teams`, {
    team_name: 'Platform Team',
    capability_tags: ['code_implement', 'test_generate', 'design_solution'],
  })
);

const pmMember = await step('Create PM member', () =>
  api('POST', `/orgs/${org.org_id}/members`, { display_name: 'Alice (PM)', email: 'alice@demo.com' })
);
const devMember = await step('Create Developer member', () =>
  api('POST', `/orgs/${org.org_id}/members`, { display_name: 'Bob (Dev)', email: 'bob@demo.com' })
);
const testerMember = await step('Create Tester member', () =>
  api('POST', `/orgs/${org.org_id}/members`, { display_name: 'Carol (Tester)', email: 'carol@demo.com' })
);

await step('Assign PM role to Alice', () =>
  api('POST', `/orgs/${org.org_id}/teams/${team.team_id}/members`, {
    member_id: pmMember.member_id, role: 'pm',
  })
);
await step('Assign Developer role to Bob', () =>
  api('POST', `/orgs/${org.org_id}/teams/${team.team_id}/members`, {
    member_id: devMember.member_id, role: 'developer',
  })
);
await step('Assign Tester role to Carol', () =>
  api('POST', `/orgs/${org.org_id}/teams/${team.team_id}/members`, {
    member_id: testerMember.member_id, role: 'tester',
  })
);

// ── 2. Register Runtimes ─────────────────────────────────────────────────────
console.log('\n【2】 Runtime Registration');
const pmRuntime = await step('Register PM runtime (Alice)', () =>
  api('POST', '/runtimes/register', {
    member_id: pmMember.member_id,
    team_id: team.team_id,
    runtime_type: 'local_agent',
    host_name: 'alice-machine',
    platform: 'windows',
    plugin_version: '0.2.0',
    capability_snapshot: ['clarify_requirement', 'task_breakdown'],
    tool_profile: { cli: ['claude-code'], shell: ['powershell'], ide: ['vscode'] },
  })
);
const devRuntime = await step('Register Developer runtime (Bob)', () =>
  api('POST', '/runtimes/register', {
    member_id: devMember.member_id,
    team_id: team.team_id,
    runtime_type: 'local_agent',
    host_name: 'bob-machine',
    platform: 'windows',
    plugin_version: '0.2.0',
    capability_snapshot: ['code_implement', 'code_review'],
    tool_profile: { cli: ['claude-code'], shell: ['powershell'], ide: ['vscode'] },
  })
);

await step('Heartbeat with load data', () =>
  api('POST', '/runtimes/heartbeat', {
    runtime_id: devRuntime.runtime_id,
    connectivity_state: 'online',
    active_session_count: 1,
    queue_depth: 0,
  })
);

// ── 3. Create Task & Decompose ───────────────────────────────────────────────
console.log('\n【3】 Task Creation & AI Decomposition');
const task = await step('Create top-level task', () =>
  api('POST', '/tasks', {
    project_id: 'proj-demo',
    owner_team_id: team.team_id,
    title: '实现用户登录功能',
    description: '支持账号密码登录，返回 JWT token，错误处理完整',
    priority: 'high',
    responsible_role: 'pm',
    source_type: 'manual',
  })
);

const decomposed = await step('AI decompose into SubTask DAG', () =>
  api('POST', `/tasks/${task.task_id}/decompose`, {
    subtasks: [
      { title: 'PM: 需求澄清与用例确认', responsible_role: 'pm', depends_on_indexes: [] },
      { title: 'Developer: 实现登录 API', responsible_role: 'developer', depends_on_indexes: [0] },
      { title: 'Tester: 接口测试验证', responsible_role: 'tester', depends_on_indexes: [1] },
    ],
  })
);
console.log(`     → Draft SubTasks: ${decomposed?.subtask_ids?.join(', ')}`);

const confirmed = await step('PM confirms SubTask plan', () =>
  api('POST', `/tasks/${task.task_id}/decompose/confirm`)
);
console.log(`     → Activated SubTasks: ${confirmed?.activated_subtask_ids?.join(', ')}`);

// ── 4. Route & Approval Gate (full cycle) ────────────────────────────────────
console.log('\n【4】 Routing & Approval Gate');
const pmSubtaskId = decomposed?.subtask_ids?.[0];
const devSubtaskId = decomposed?.subtask_ids?.[1];

const routed = await step('Route PM subtask by role', () =>
  api('POST', `/tasks/${pmSubtaskId}/route`)
);
console.log(`     → Routed to: ${routed?.routed_to?.member_id} (${routed?.routed_to?.role})`);

await step('Manager approves start of PM subtask', () =>
  api('POST', `/tasks/${pmSubtaskId}/approve-start`)
);
// status is now 'accepted' → move to in_progress so execution can be reported
await step('PM starts working (accepted → in_progress)', () =>
  api('POST', `/tasks/${pmSubtaskId}/status`, { status: 'in_progress' })
);

const session = await step('Start session for PM subtask', () =>
  api('POST', '/sessions/start', {
    task_id: pmSubtaskId,
    runtime_id: pmRuntime.runtime_id,
    session_type: 'task_execution',
  })
);

await step('PM reports execution success → auto-sets in_review + pending_approval_type=result', () =>
  api('POST', '/executions/report', {
    session_id: session?.session_id,
    task_id: pmSubtaskId,
    capability_id: 'clarify_requirement',
    executor_type: 'agent',
    result_status: 'success',
    summary: '需求澄清完成：登录使用 JWT，token 有效期 24h，错误码标准化',
  })
);

const approveResult = await step('Manager approves PM result → dev subtask auto-activated', () =>
  api('POST', `/tasks/${pmSubtaskId}/approve-result`)
);
console.log(`     → ${approveResult?.message}`);

// ── 5. Summary ───────────────────────────────────────────────────────────────
console.log('\n=== Summary ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

const finalSubtasks = await api('GET', `/tasks/${task.task_id}/subtasks`);
console.log('\n  SubTask state:');
finalSubtasks.subtasks.forEach(st => {
  console.log(`    [${st.responsible_role.padEnd(9)}] ${st.title.slice(0, 40).padEnd(40)} status=${st.status} approval=${st.pending_approval_type ?? 'none'}`);
});

if (failed === 0) {
  console.log('\n  🎉 All v0.2 demo steps passed!');
} else {
  console.log('\n  ⚠️  Some steps failed. Check control plane is running on port 3100.');
  process.exit(1);
}
