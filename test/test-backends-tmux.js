import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv } from './utils.js'
import { TmuxBackend } from '../dist/backends/tmux.js'

await test('TmuxBackend (no tmux available)', async (t) => {
  const env = createTestEnv()
  t.after(() => env.cleanup())

  await t.test('isAvailable() returns false when tmux not present', async () => {
    // Ensure no TMUX env var is set
    const origTmux = process.env.TMUX
    delete process.env.TMUX

    const backend = new TmuxBackend()
    const result = await backend.isAvailable()
    assert.strictEqual(result, false)

    // Restore
    if (origTmux !== undefined) process.env.TMUX = origTmux
  })

  await t.test('type equals "tmux"', async () => {
    const backend = new TmuxBackend()
    assert.strictEqual(backend.type, 'tmux')
  })

  await t.test('constructor accepts optional socketName', async () => {
    const defaultBackend = new TmuxBackend()
    assert.strictEqual(defaultBackend._socketName, null)

    const customBackend = new TmuxBackend('my-socket')
    assert.strictEqual(customBackend._socketName, 'my-socket')
  })

  await t.test('getSocketName() uses "claude-swarm" when not inside tmux', async () => {
    const origTmux = process.env.TMUX
    delete process.env.TMUX

    const backend = new TmuxBackend()
    // getSocketName is private, but we can verify via tmuxArgs
    const args = backend.tmuxArgs()
    // When not inside tmux and no custom socket, should use 'claude-swarm'
    assert.deepStrictEqual(args, ['-L', 'claude-swarm'])

    // Restore
    if (origTmux !== undefined) process.env.TMUX = origTmux
  })

  await t.test('tmuxArgs() returns ["-L", "claude-swarm"] when not inside tmux', async () => {
    const origTmux = process.env.TMUX
    delete process.env.TMUX

    const backend = new TmuxBackend()
    const args = backend.tmuxArgs()
    assert.deepStrictEqual(args, ['-L', 'claude-swarm'])

    // With a custom socket name
    const customBackend = new TmuxBackend('custom-socket')
    const customArgs = customBackend.tmuxArgs()
    assert.deepStrictEqual(customArgs, ['-L', 'custom-socket'])

    // Restore
    if (origTmux !== undefined) process.env.TMUX = origTmux
  })
})
