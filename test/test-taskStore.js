import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SyncServerError,
  TaskAssignmentError,
  TaskClaimConflictError,
  TaskOwnershipError,
  TaskPermissionError,
  TaskRoleMismatchError,
  TaskStateError,
  TaskStore,
} from '../dist/index.js'

class MemoryTaskAdapter {
  constructor(shared) {
    this.shared = shared ?? { entries: {}, version: 0 }
    this.cachedEtag = undefined
    this.conflictOnce = false
  }

  setEtag(etag) {
    this.cachedEtag = etag
  }

  async pull() {
    const etag = `v${this.shared.version}`
    this.cachedEtag = etag
    return {
      entries: { ...this.shared.entries },
      etag,
      checksum: etag,
    }
  }

  async push(entries, ifMatch) {
    if (this.conflictOnce) {
      this.conflictOnce = false
      throw new SyncServerError('forced conflict', 412)
    }
    const current = `v${this.shared.version}`
    if (ifMatch && ifMatch !== current) {
      throw new SyncServerError('etag mismatch', 412)
    }
    this.shared.entries = { ...this.shared.entries, ...entries }
    this.shared.version += 1
    this.cachedEtag = undefined
    return {
      checksum: `v${this.shared.version}`,
      filesUploaded: Object.keys(entries).length,
      lastModified: new Date().toISOString(),
    }
  }
}

function makeStore(shared) {
  return new TaskStore(new MemoryTaskAdapter(shared))
}

async function createReadyTask(store, overrides = {}) {
  return store.createTask({
    title: 'Implement TaskStore',
    description: 'Build authoritative task state',
    createdByAgentId: 'leader-1',
    createdByAgentName: 'Leader',
    ...overrides,
  })
}

describe('TaskStore', () => {
  test('creates a pending task in the authoritative task store', async () => {
    const store = makeStore()
    const task = await createReadyTask(store, {
      expectedOutput: 'A working TaskStore module',
      acceptanceCriteria: ['concurrent claim succeeds once'],
    })

    assert.equal(task.status, 'pending')
    assert.equal(task.createdByAgentId, 'leader-1')
    assert.equal(task.expectedOutput, 'A working TaskStore module')
    assert.deepEqual(task.acceptanceCriteria, ['concurrent claim succeeds once'])

    const fetched = await store.getTask(task.taskId)
    assert.equal(fetched?.taskId, task.taskId)
  })

  test('claims a task atomically and rejects a second claimant', async () => {
    const store = makeStore()
    const task = await createReadyTask(store)

    const claimed = await store.claimTask(task.taskId, 'dev-1', 'Developer 1', 'developer')
    assert.equal(claimed.status, 'claimed')
    assert.equal(claimed.claimedByAgentId, 'dev-1')
    assert.ok(claimed.leaseExpiresAt)

    await assert.rejects(
      () => store.claimTask(task.taskId, 'dev-2', 'Developer 2', 'developer'),
      TaskClaimConflictError,
    )
  })

  test('retries createTask after a CAS conflict', async () => {
    const shared = { entries: {}, version: 0 }
    const adapter = new MemoryTaskAdapter(shared)
    adapter.conflictOnce = true
    const store = new TaskStore(adapter)

    const task = await createReadyTask(store)
    assert.equal(task.status, 'pending')
    assert.equal(Object.keys(shared.entries).length, 1)
  })

  test('rejects role and assignment mismatch during claim', async () => {
    const store = makeStore()
    const architectTask = await createReadyTask(store, { requiredRole: 'architect' })
    await assert.rejects(
      () => store.claimTask(architectTask.taskId, 'dev-1', 'Developer', 'developer'),
      TaskRoleMismatchError,
    )

    const assignedTask = await createReadyTask(store, { assignedToAgentId: 'dev-1' })
    await assert.rejects(
      () => store.claimTask(assignedTask.taskId, 'dev-2', 'Developer 2', 'developer'),
      TaskAssignmentError,
    )
  })

  test('supports claimed -> in_progress -> review -> done lifecycle', async () => {
    const store = makeStore()
    const task = await createReadyTask(store)

    await store.claimTask(task.taskId, 'dev-1', 'Developer 1', 'developer')
    const started = await store.startTask(task.taskId, 'dev-1')
    assert.equal(started.status, 'in_progress')

    const review = await store.submitForReview(
      task.taskId,
      [
        { type: 'file', value: 'src/core/taskStore.ts' },
        { type: 'commit', value: 'abc123', description: 'TaskStore implementation' },
      ],
      'dev-1',
    )
    assert.equal(review.status, 'review')
    assert.equal(review.artifacts.length, 2)
    assert.equal(review.leaseExpiresAt, undefined)

    await assert.rejects(
      () => store.completeTask(task.taskId, 'dev-1', 'Developer 1', 'developer'),
      TaskPermissionError,
    )

    const done = await store.completeTask(task.taskId, 'lead-1', 'Tech Lead', 'tech-lead')
    assert.equal(done.status, 'done')
    assert.equal(done.completedByAgentId, 'lead-1')
  })

  test('returnForRevision moves review task back to pending for re-claim', async () => {
    const store = makeStore()
    const task = await createReadyTask(store)
    await store.claimTask(task.taskId, 'dev-1', 'Developer 1', 'developer')
    await store.startTask(task.taskId, 'dev-1')
    await store.submitForReview(task.taskId, [{ type: 'file', value: 'x.ts' }], 'dev-1')

    const returned = await store.returnForRevision(task.taskId, 'lead-1', 'tech-lead', 'needs tests')
    assert.equal(returned.status, 'pending')
    assert.equal(returned.assignedToAgentId, 'dev-1')
    assert.equal(returned.claimedByAgentId, undefined)
    assert.equal(returned.revisionReason, 'needs tests')

    const ready = await store.listReadyTasks('developer', 'dev-1')
    assert.equal(ready.length, 1)
    assert.equal(ready[0].taskId, task.taskId)
  })

  test('releaseExpiredLeases requeues claimed and in_progress tasks', async () => {
    const store = makeStore()
    const claimedTask = await createReadyTask(store, { title: 'claimed' })
    const runningTask = await createReadyTask(store, { title: 'running' })

    await store.claimTask(claimedTask.taskId, 'dev-1', 'Developer 1', 'developer', -1)
    await store.claimTask(runningTask.taskId, 'dev-2', 'Developer 2', 'developer', 1)
    await store.startTask(runningTask.taskId, 'dev-2', -1)

    const released = await store.releaseExpiredLeases()
    assert.deepEqual(new Set(released), new Set([claimedTask.taskId, runningTask.taskId]))

    const claimed = await store.getTask(claimedTask.taskId)
    const running = await store.getTask(runningTask.taskId)
    assert.equal(claimed?.status, 'pending')
    assert.equal(running?.status, 'pending')
    assert.equal(claimed?.claimedByAgentId, undefined)
    assert.equal(running?.claimedByAgentId, undefined)
  })

  test('unblocks dependent tasks after upstream completion', async () => {
    const store = makeStore()
    const upstream = await createReadyTask(store, { title: 'upstream' })
    const downstream = await createReadyTask(store, {
      title: 'downstream',
      dependencies: [upstream.taskId],
    })

    assert.equal(downstream.status, 'blocked')

    await store.claimTask(upstream.taskId, 'dev-1', 'Developer 1', 'developer')
    await store.startTask(upstream.taskId, 'dev-1')
    await store.submitForReview(upstream.taskId, [{ type: 'file', value: 'upstream.ts' }], 'dev-1')
    await store.completeTask(upstream.taskId, 'lead-1', 'Tech Lead', 'tech-lead')

    const unblocked = await store.getTask(downstream.taskId)
    assert.equal(unblocked?.status, 'pending')
  })

  test('ownership prevents non-owner mutation', async () => {
    const store = makeStore()
    const task = await createReadyTask(store)
    await store.claimTask(task.taskId, 'dev-1', 'Developer 1', 'developer')

    await assert.rejects(
      () => store.startTask(task.taskId, 'dev-2'),
      TaskOwnershipError,
    )
  })

  test('invalid transitions are rejected', async () => {
    const store = makeStore()
    const task = await createReadyTask(store)

    await assert.rejects(
      () => store.submitForReview(task.taskId, [], 'dev-1'),
      TaskStateError,
    )
  })
})

