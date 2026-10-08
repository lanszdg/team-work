import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv } from './utils.js'
import {
  InProcessBackend,
  runInTeammateContext,
  getCurrentTeammateContext,
  teammateContextStorage,
} from '../dist/backends/inProcess.js'

await test('InProcessBackend', async (t) => {
  const env = createTestEnv()
  t.after(() => env.cleanup())

  await t.test('isAvailable() always returns true', async () => {
    const backend = new InProcessBackend()
    const result = await backend.isAvailable()
    assert.strictEqual(result, true)
  })

  await t.test('createTeammatePaneInSwarmView() returns paneId starting with "inprocess-"', async () => {
    const backend = new InProcessBackend()
    const result = await backend.createTeammatePaneInSwarmView('alice', 'red')
    assert.ok(result.paneId.startsWith('inprocess-'), `paneId "${result.paneId}" should start with "inprocess-"`)
  })

  await t.test('createTeammatePaneInSwarmView() isFirstTeammate is true for first call, false for second', async () => {
    const backend = new InProcessBackend()
    const first = await backend.createTeammatePaneInSwarmView('alice', 'red')
    assert.strictEqual(first.isFirstTeammate, true)

    const second = await backend.createTeammatePaneInSwarmView('bob', 'blue')
    assert.strictEqual(second.isFirstTeammate, false)
  })

  await t.test('createTeammatePaneInSwarmView() sets correct agentId format (name@team)', async () => {
    process.env.CLAUDE_CODE_TEAM_NAME = 'test-team'
    const backend = new InProcessBackend()
    const result = await backend.createTeammatePaneInSwarmView('alice', 'green')
    const context = backend.getPaneContext(result.paneId)
    assert.ok(context, 'context should exist')
    assert.strictEqual(context.agentId, 'alice@test-team')
    assert.strictEqual(context.agentName, 'alice')
    assert.strictEqual(context.teamName, 'test-team')
  })

  await t.test('sendCommandToPane() throws when paneId not found', async () => {
    const backend = new InProcessBackend()
    await assert.rejects(
      () => backend.sendCommandToPane('nonexistent-pane', 'echo hello'),
      /\[InProcessBackend\] Pane nonexistent-pane not found/
    )
  })

  await t.test('enablePaneBorderStatus() no-op resolves successfully', async () => {
    const backend = new InProcessBackend()
    await assert.doesNotReject(() => backend.enablePaneBorderStatus())
  })

  await t.test('killPane() returns true for existing pane, false for non-existing', async () => {
    const backend = new InProcessBackend()
    const { paneId } = await backend.createTeammatePaneInSwarmView('charlie', 'yellow')

    const killedExisting = await backend.killPane(paneId)
    assert.strictEqual(killedExisting, true)

    const killedNonExisting = await backend.killPane(paneId)
    assert.strictEqual(killedNonExisting, false)
  })

  await t.test('getPaneContext() returns correct context for a pane', async () => {
    process.env.CLAUDE_CODE_TEAM_NAME = ''
    const backend = new InProcessBackend()
    const { paneId } = await backend.createTeammatePaneInSwarmView('dave', 'cyan')

    const context = backend.getPaneContext(paneId)
    assert.ok(context, 'context should exist')
    assert.strictEqual(context.agentId, 'dave@default')
    assert.strictEqual(context.agentName, 'dave')
    assert.strictEqual(context.teamName, 'default')
    assert.strictEqual(context.color, 'cyan')
    assert.strictEqual(context.cwd, process.cwd())

    assert.strictEqual(backend.getPaneContext('fake-id'), undefined)
  })

  await t.test('listActiveTeammates() returns map with all created panes', async () => {
    const backend = new InProcessBackend()
    const p1 = await backend.createTeammatePaneInSwarmView('eve', 'purple')
    const p2 = await backend.createTeammatePaneInSwarmView('frank', 'orange')
    const p3 = await backend.createTeammatePaneInSwarmView('grace', 'magenta')

    const teammates = backend.listActiveTeammates()
    assert.ok(teammates instanceof Map)
    assert.strictEqual(teammates.size, 3)
    assert.ok(teammates.has(p1.paneId))
    assert.ok(teammates.has(p2.paneId))
    assert.ok(teammates.has(p3.paneId))
  })

  await t.test('runInTeammateContext() runs function with AsyncLocalStorage context', async () => {
    const ctx = {
      agentId: 'alice@test-team',
      agentName: 'alice',
      teamName: 'test-team',
      color: 'red',
      cwd: process.cwd(),
    }

    let captured = null
    await runInTeammateContext(ctx, async () => {
      captured = getCurrentTeammateContext()
    })

    assert.deepStrictEqual(captured, ctx)
  })

  await t.test('getCurrentTeammateContext() returns null outside context, returns context inside', async () => {
    // Outside any context
    const outside = getCurrentTeammateContext()
    assert.strictEqual(outside, null)

    // Inside context
    const ctx = {
      agentId: 'bob@test-team',
      agentName: 'bob',
      teamName: 'test-team',
      color: 'blue',
      cwd: process.cwd(),
    }

    let inside = 'not-set'
    await runInTeammateContext(ctx, async () => {
      inside = getCurrentTeammateContext()
    })

    assert.deepStrictEqual(inside, ctx)
  })
})
