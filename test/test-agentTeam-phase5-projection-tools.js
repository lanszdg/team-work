import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CloudPresence,
  SyncServerError,
  TaskPermissionError,
  TaskStore,
  TaskTools,
  extractTaskProjectionFromEntries,
  projectAgentTaskState,
} from '../dist/index.js'

class MemoryTaskAdapter {
  constructor(shared) {
    this.shared = shared ?? { entries: {}, version: 0 }
  }

  setEtag(_etag) {}

  async pull() {
    const etag = `v${this.shared.version}`
    return {
      entries: { ...this.shared.entries },
      etag,
      checksum: etag,
    }
  }

  async push(entries, ifMatch) {
    const current = `v${this.shared.version}`
    if (ifMatch && ifMatch !== current) {
      throw new SyncServerError('etag mismatch', 412)
    }
    this.shared.entries = { ...this.shared.entries, ...entries }
    this.shared.version += 1
    return { checksum: `v${this.shared.version}` }
  }
}

function makeStore(shared) {
  return new TaskStore(new MemoryTaskAdapter(shared))
}

async function createTask(store, overrides = {}) {
  return store.createTask({
    title: 'Projection task',
    description: 'Task for projection tests',
    createdByAgentId: 'lead-1',
    createdByAgentName: 'Lead',
    ...overrides,
  })
}

describe('task projection', () => {
  test('projects current worker state from TaskStore tasks', async () => {
    const store = makeStore()
    const task = await createTask(store)
    await store.claimTask(task.taskId, 'worker-1', 'Worker 1', 'developer')
    const running = await store.startTask(task.taskId, 'worker-1')

    const projection = projectAgentTaskState([running], 'worker-1')
    assert.equal(projection.workState, 'in_progress')
    assert.equal(projection.currentTaskId, task.taskId)
    assert.equal(projection.currentTaskTitle, 'Projection task')
  })

  test('dashboard task projection reads task_store entries without writing', async () => {
    const store = makeStore()
    const task = await createTask(store)
    await store.claimTask(task.taskId, 'worker-1', 'Worker 1', 'developer')
    const running = await store.startTask(task.taskId, 'worker-1')
    const entries = {
      [`task_store/${task.taskId}`]: JSON.stringify(running),
    }

    const projection = extractTaskProjectionFromEntries(entries)
    assert.equal(projection.get('worker-1')?.workState, 'in_progress')
    assert.equal(projection.get('worker-1')?.currentTaskId, task.taskId)
  })
})

describe('CloudPresence task projection', () => {
  test('heartbeat writes projected workState/currentTaskId to presence only', async () => {
    const pushed = []
    const events = []
    const presence = new CloudPresence({
      apiUrl: 'http://mock-sync-adapter.invalid',
      apiKey: 'mock',
      teamName: 'projection-team',
      agentId: 'worker-1',
      agentName: 'Worker 1',
      taskProjectionProvider: async () => ({
        workState: 'in_progress',
        currentTaskId: 'task-1',
        currentTaskTitle: 'Projection task',
      }),
    })
    presence.adapter = {
      push: async entries => pushed.push(entries),
      postEvent: async (event, payload) => events.push({ event, payload }),
    }

    await presence.heartbeat()

    assert.equal(events[0].event, 'presence')
    assert.equal(events[0].payload.workState, 'in_progress')
    assert.equal(events[0].payload.currentTaskId, 'task-1')
    assert.equal(Object.keys(pushed[0])[0], 'presence/worker-1')
    const value = JSON.parse(pushed[0]['presence/worker-1'])
    assert.equal(value.workState, 'in_progress')
    assert.equal(value.currentTaskId, 'task-1')
  })
})

describe('TaskTools', () => {
  test('taskCreate and taskListReady use TaskStore semantic methods', async () => {
    const store = makeStore()
    const tools = new TaskTools({
      taskStore: store,
      agentId: 'lead-1',
      agentName: 'Lead',
      agentRole: 'tech-lead',
    })

    const created = await tools.taskCreate({
      title: 'Build projection',
      description: 'Expose projection safely',
      assignedToAgentId: 'worker-1',
      expectedOutput: 'Projection works',
    })
    assert.match(created, /Task created:/)

    const workerTools = new TaskTools({
      taskStore: store,
      agentId: 'worker-1',
      agentName: 'Worker 1',
      agentRole: 'developer',
    })
    const ready = await workerTools.taskListReady()
    assert.match(ready, /Build projection/)
  })

  test('developer cannot complete task through tools', async () => {
    const store = makeStore()
    const task = await createTask(store)
    await store.claimTask(task.taskId, 'worker-1', 'Worker 1', 'developer')
    await store.startTask(task.taskId, 'worker-1')
    await store.submitForReview(task.taskId, [{ type: 'file', value: 'x.ts' }], 'worker-1')

    const tools = new TaskTools({
      taskStore: store,
      agentId: 'worker-2',
      agentName: 'Worker 2',
      agentRole: 'developer',
    })

    await assert.rejects(
      () => tools.taskComplete({ taskId: task.taskId }),
      /cannot complete tasks/,
    )

    await assert.rejects(
      () => store.completeTask(task.taskId, 'worker-2', 'Worker 2', 'developer'),
      TaskPermissionError,
    )
  })
})
