import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SyncServerError,
  TaskOwnershipError,
  TaskPermissionError,
  TaskStore,
  TaskWorkerLoop,
  completeTaskReview,
  returnTaskForRevision,
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
    title: 'Implement worker loop',
    description: 'Run task through claim/start/review',
    createdByAgentId: 'lead-1',
    createdByAgentName: 'Lead',
    ...overrides,
  })
}

function makeDispatcherCapture() {
  const sent = []
  return {
    sent,
    dispatcher: {
      getSenderAgentId: () => 'worker-1',
      getSenderAgentName: () => 'Worker 1',
      sendMessage: async (toAgentId, toAgentName, payload) => {
        sent.push({ toAgentId, toAgentName, payload })
        return true
      },
    },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('TaskWorkerLoop', () => {
  test('worker claims, starts, executes, and submits for review instead of done', async () => {
    const store = makeStore()
    const task = await createTask(store)
    const { dispatcher, sent } = makeDispatcherCapture()

    const loop = new TaskWorkerLoop({
      taskStore: store,
      agentId: 'worker-1',
      agentName: 'Worker 1',
      agentRole: 'developer',
      dispatcher,
      reviewerAgentId: 'lead-1',
      reviewerAgentName: 'Lead',
      executeTask: async ({ task: runningTask, signal }) => {
        assert.equal(runningTask.taskId, task.taskId)
        assert.equal(signal.aborted, false)
        return [{ type: 'file', value: 'src/core/taskWorkerLoop.ts' }]
      },
    })

    const result = await loop.runOnce()
    assert.equal(result.status, 'submitted_for_review')
    assert.equal(result.task?.status, 'review')
    assert.equal(result.task?.artifacts[0].value, 'src/core/taskWorkerLoop.ts')

    const persisted = await store.getTask(task.taskId)
    assert.equal(persisted?.status, 'review')
    assert.equal(persisted?.completedAt, undefined)

    assert.deepEqual(
      sent.map(item => item.payload.type),
      ['task_claimed', 'task_status_update', 'task_submitted_for_review'],
    )
  })

  test('lease renewal failure aborts execution and does not submit review', async () => {
    const store = makeStore()
    const task = await createTask(store)
    let renewCalls = 0
    const taskStore = {
      listReadyTasks: store.listReadyTasks.bind(store),
      claimTask: store.claimTask.bind(store),
      startTask: store.startTask.bind(store),
      submitForReview: store.submitForReview.bind(store),
      failTask: store.failTask.bind(store),
      renewLease: async () => {
        renewCalls += 1
        throw new TaskOwnershipError(task.taskId, 'worker-1')
      },
    }

    const loop = new TaskWorkerLoop({
      taskStore,
      agentId: 'worker-1',
      agentName: 'Worker 1',
      agentRole: 'developer',
      leaseTtlMs: 100,
      renewIntervalMs: 10,
      executeTask: async ({ signal }) => {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        assert.equal(signal.aborted, true)
        return [{ type: 'file', value: 'should-not-submit.ts' }]
      },
    })

    const result = await loop.runOnce()
    assert.equal(result.status, 'aborted')
    assert.equal(renewCalls, 1)

    const persisted = await store.getTask(task.taskId)
    assert.equal(persisted?.status, 'in_progress')
    assert.equal(persisted?.artifacts.length, 0)
  })

  test('old worker cannot submit or fail after another worker reclaims the task', async () => {
    const store = makeStore()
    const task = await createTask(store)
    const canReturn = deferred()
    let executionStarted = false

    const loop = new TaskWorkerLoop({
      taskStore: store,
      agentId: 'worker-1',
      agentName: 'Worker 1',
      agentRole: 'developer',
      leaseTtlMs: -1,
      renewIntervalMs: 10_000,
      executeTask: async () => {
        executionStarted = true
        await canReturn.promise
        return [{ type: 'file', value: 'stale.ts' }]
      },
    })

    const runPromise = loop.runOnce()
    while (!executionStarted) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }

    const released = await store.releaseExpiredLeases()
    assert.deepEqual(released, [task.taskId])
    await store.claimTask(task.taskId, 'worker-2', 'Worker 2', 'developer')

    canReturn.resolve()
    const result = await runPromise
    assert.equal(result.status, 'aborted')
    assert.ok(result.error instanceof TaskOwnershipError)

    const persisted = await store.getTask(task.taskId)
    assert.equal(persisted?.status, 'claimed')
    assert.equal(persisted?.claimedByAgentId, 'worker-2')
    assert.equal(persisted?.artifacts.length, 0)
  })

  test('execution failure writes failed only while worker still owns the task', async () => {
    const store = makeStore()
    const task = await createTask(store)
    const loop = new TaskWorkerLoop({
      taskStore: store,
      agentId: 'worker-1',
      agentName: 'Worker 1',
      agentRole: 'developer',
      executeTask: async () => {
        throw new Error('implementation failed')
      },
    })

    const result = await loop.runOnce()
    assert.equal(result.status, 'failed')
    assert.equal(result.task?.status, 'failed')
    assert.equal(result.task?.failureReason, 'implementation failed')

    const persisted = await store.getTask(task.taskId)
    assert.equal(persisted?.status, 'failed')
  })

  test('notification failure after TaskStore submit does not rewrite task to failed', async () => {
    const store = makeStore()
    const task = await createTask(store)
    const dispatcher = {
      getSenderAgentId: () => 'worker-1',
      getSenderAgentName: () => 'Worker 1',
      sendMessage: async () => {
        throw new Error('notification unavailable')
      },
    }

    const loop = new TaskWorkerLoop({
      taskStore: store,
      agentId: 'worker-1',
      agentName: 'Worker 1',
      agentRole: 'developer',
      dispatcher,
      reviewerAgentId: 'lead-1',
      executeTask: async () => [{ type: 'file', value: 'review.ts' }],
    })

    const result = await loop.runOnce()
    assert.equal(result.status, 'submitted_for_review')
    assert.equal(result.task?.status, 'review')
    assert.ok(result.notificationErrors?.length >= 1)

    const persisted = await store.getTask(task.taskId)
    assert.equal(persisted?.status, 'review')
    assert.equal(persisted?.failureReason, undefined)
  })
})

describe('reviewer task flow helpers', () => {
  test('reviewer completes a review task and notifies the worker after TaskStore success', async () => {
    const store = makeStore()
    const task = await createTask(store)
    await store.claimTask(task.taskId, 'worker-1', 'Worker 1', 'developer')
    await store.startTask(task.taskId, 'worker-1')
    await store.submitForReview(task.taskId, [{ type: 'file', value: 'done.ts' }], 'worker-1')
    const { dispatcher, sent } = makeDispatcherCapture()

    const completed = await completeTaskReview({
      taskStore: store,
      taskId: task.taskId,
      reviewerId: 'lead-1',
      reviewerName: 'Lead',
      reviewerRole: 'tech-lead',
      dispatcher,
      workerAgentId: 'worker-1',
      workerAgentName: 'Worker 1',
    })

    assert.equal(completed.status, 'done')
    assert.equal(completed.completedByAgentId, 'lead-1')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.type, 'task_completed')
  })

  test('developer cannot complete review task because canCompleteTask is required', async () => {
    const store = makeStore()
    const task = await createTask(store)
    await store.claimTask(task.taskId, 'worker-1', 'Worker 1', 'developer')
    await store.startTask(task.taskId, 'worker-1')
    await store.submitForReview(task.taskId, [{ type: 'file', value: 'done.ts' }], 'worker-1')
    const { dispatcher, sent } = makeDispatcherCapture()

    await assert.rejects(
      () => completeTaskReview({
        taskStore: store,
        taskId: task.taskId,
        reviewerId: 'worker-2',
        reviewerName: 'Worker 2',
        reviewerRole: 'developer',
        dispatcher,
        workerAgentId: 'worker-1',
      }),
      TaskPermissionError,
    )
    assert.equal(sent.length, 0)
  })

  test('reviewer returns task for revision and it can be re-claimed by the worker', async () => {
    const store = makeStore()
    const task = await createTask(store)
    await store.claimTask(task.taskId, 'worker-1', 'Worker 1', 'developer')
    await store.startTask(task.taskId, 'worker-1')
    await store.submitForReview(task.taskId, [{ type: 'file', value: 'needs-tests.ts' }], 'worker-1')
    const { dispatcher, sent } = makeDispatcherCapture()

    const returned = await returnTaskForRevision({
      taskStore: store,
      taskId: task.taskId,
      reviewerId: 'lead-1',
      reviewerName: 'Lead',
      reviewerRole: 'tech-lead',
      reason: 'needs tests',
      dispatcher,
      workerAgentId: 'worker-1',
      workerAgentName: 'Worker 1',
    })

    assert.equal(returned.status, 'pending')
    assert.equal(returned.assignedToAgentId, 'worker-1')
    assert.equal(returned.revisionReason, 'needs tests')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.type, 'task_status_update')

    const reclaimed = await store.claimTask(task.taskId, 'worker-1', 'Worker 1', 'developer')
    assert.equal(reclaimed.status, 'claimed')
    assert.equal(reclaimed.claimedByAgentId, 'worker-1')
  })
})
