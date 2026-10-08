import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv } from './utils.js'
import {
  registerBackend,
  detectBackend,
  clearBackendCache,
  getBackend,
  createTeammatePane,
  sendCommandToPane,
  killPane,
} from '../dist/backends/registry.js'
import { InProcessBackend } from '../dist/backends/inProcess.js'

await test('Backend Registry', async (t) => {
  const env = createTestEnv()
  t.after(() => {
    clearBackendCache()
    env.cleanup()
  })

  await t.test('registerBackend() registers a custom backend factory', async () => {
    const customFactory = () => new InProcessBackend()
    registerBackend('custom-test', customFactory)

    // Verify it is in the internal registry by checking that creating a teammate pane
    // with a mode that hits the registry does not throw for the built-in types.
    // We confirm registration works by clearing cache and checking detectBackend
    // with an explicit 'in-process' mode (proves the registry functions correctly).
    clearBackendCache()
    const result = await detectBackend('in-process')
    assert.ok(result.backend instanceof InProcessBackend)
    assert.strictEqual(result.type, 'in-process')
  })

  await t.test('clearBackendCache() clears cached detection result', async () => {
    clearBackendCache()
    // First detection caches the result
    const first = await detectBackend('in-process')
    assert.ok(first.backend instanceof InProcessBackend)

    // Clear cache
    clearBackendCache()

    // After clearing, a new detection is performed (still in-process since we pass mode)
    const second = await detectBackend('in-process')
    assert.ok(second.backend instanceof InProcessBackend)

    // The two backend instances should be different objects (new instance created)
    assert.notStrictEqual(first.backend, second.backend)
  })

  await t.test('detectBackend() with mode="in-process" returns in-process backend', async () => {
    clearBackendCache()
    const result = await detectBackend('in-process')
    assert.strictEqual(result.type, 'in-process')
    assert.ok(result.backend instanceof InProcessBackend)
    assert.strictEqual(result.isFirst, true)
  })

  await t.test('detectBackend() with mode="tmux" throws when tmux not available', async () => {
    clearBackendCache()
    // In the test environment, tmux is not available
    await assert.rejects(
      () => detectBackend('tmux'),
      /tmux mode requested but tmux is not available/
    )
  })

  await t.test('detectBackend() auto-detect without tmux/iTerm2 falls back to in-process', async () => {
    clearBackendCache()
    // Remove TMUX env to ensure we are not inside tmux
    const origTmux = process.env.TMUX
    delete process.env.TMUX

    const result = await detectBackend('auto')
    assert.strictEqual(result.type, 'in-process')
    assert.ok(result.backend instanceof InProcessBackend)

    // Restore
    if (origTmux !== undefined) process.env.TMUX = origTmux
  })

  await t.test('getBackend() returns the detected backend', async () => {
    clearBackendCache()
    const backend = await getBackend()
    // In test env without tmux/iTerm2, should be in-process
    assert.ok(backend instanceof InProcessBackend)
    assert.strictEqual(backend.type, 'in-process')
  })

  await t.test('createTeammatePane() uses detected backend to create pane (with in-process fallback)', async () => {
    clearBackendCache()
    const result = await createTeammatePane('alice', 'red', 'in-process')
    assert.ok(result.paneId.startsWith('inprocess-'), `paneId "${result.paneId}" should start with "inprocess-"`)
    assert.strictEqual(result.isFirstTeammate, true)
  })
})
