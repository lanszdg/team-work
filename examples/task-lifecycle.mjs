// Run from the repository root after building and starting your own sync server.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TaskStore } from '../dist/core/taskStore.js';
import { TaskWorkerLoop } from '../dist/core/taskWorkerLoop.js';

const apiUrl = process.env.TEAM_MEMORY_SYNC_URL;
const apiKey = process.env.TEAM_MEMORY_SYNC_API_KEY;
if (!apiUrl || !apiKey) {
  throw new Error('Set TEAM_MEMORY_SYNC_URL and TEAM_MEMORY_SYNC_API_KEY first.');
}
const suffix = randomUUID();
const workerId = 'example-worker-' + suffix;
const leadId = 'example-lead-' + suffix;
const taskStore = new TaskStore({
  apiUrl, apiKey,
  teamName: process.env.CLAUDE_CODE_TEAM_NAME || 'demo-team',
  developerId: leadId,
});
const task = await taskStore.createTask({
  title: 'Read the collaboration README (SDK demonstration)',
  description: 'Exercise task state transitions; this is not an AI coding or quality-review run.',
  createdByAgentId: leadId,
  requiredRole: 'developer',
  assignedToAgentId: workerId,
  expectedOutput: 'A reference to the existing README.md',
  acceptanceCriteria: ['The demonstration execution can read a non-empty README.md'],
});
const loop = new TaskWorkerLoop({
  taskStore,
  agentId: workerId,
  agentRole: 'developer',
  executeTask: async ({ signal }) => {
    const content = await readFile(new URL('../README.md', import.meta.url), { encoding: 'utf8', signal });
    if (!content.trim()) throw new Error('README.md is empty');
    return [{ type: 'file', value: 'README.md', description: 'Existing documentation read by the SDK demonstration' }];
  },
});
const outcome = await loop.runOnce();
if (outcome.status !== 'submitted_for_review') {
  throw new Error('Unexpected execution outcome: ' + outcome.status);
}
// Demonstration acceptance only. Real development tasks require actual review.
const done = await taskStore.completeTask(task.taskId, leadId, 'Example lead', 'tech-lead');
console.log(JSON.stringify({ taskId: done.taskId, status: done.status, artifacts: done.artifacts }, null, 2));
