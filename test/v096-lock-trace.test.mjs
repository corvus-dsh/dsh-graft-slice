/**
 * v0.9.6 — the lock counter must be INVISIBLE when it is off.
 *
 * WHY THIS NEEDS A TEST AND NOT JUST A COMMENT
 *
 * `recordAcquisition()` is called on the acquisition path of both locks — the one place in this
 * economy where a stray allocation or a thrown error is most expensive. The claim is "with
 * `DSH_LOCK_TRACE` unset it returns on its first line". A claim about a hot path that nobody asserts
 * is a claim that will be false after someone adds a `JSON.stringify` for debugging.
 *
 * What is asserted:
 *   1. tracing off  ⇒ `enabled === false`, `total === 0`, even after real acquisitions;
 *   2. tracing off  ⇒ locks still work (acquire/release/isLockHeld unchanged);
 *   3. tracing on   ⇒ `total` counts, and `reset()` clears it.
 *
 * A test process cannot flip the env var after module load (`LOCK_TRACE_ENABLED` is evaluated once),
 * which is why the "on" case lives here as a separate process run rather than a second import.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { existsSync } from 'node:fs'

import { acquireFileLock, lockTraceReset, lockTraceSnapshot } from '../index.js'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

test('v0.9.6: with tracing off the counter reports nothing, and locks still work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-traceoff-'))
  /** The path being PROTECTED — `acquireFileLock` appends `.lock` itself. */
  const target = join(dir, 'thing.json')
  try {
    assert.equal(process.env.DSH_LOCK_TRACE, undefined, 'this test requires tracing to be off')

    lockTraceReset()
    const before = lockTraceSnapshot()
    assert.equal(before.enabled, false)
    assert.equal(before.total, 0)

    // Real acquisitions: the instrument must not observe them when it is off.
    for (let i = 0; i < 3; i += 1) {
      const protectedPath = `${target}${i}`
      const release = acquireFileLock(protectedPath, { timeoutMs: 5_000 })
      // graft's lock is a DIRECTORY at `<path>.lock` — presence is the held-state, which is why
      // `existsSync` is enough here and no `isLockHeld` helper is needed (memory has one; this
      // repository does not, and adding an export for a test would be a contract change).
      assert.equal(existsSync(`${protectedPath}.lock`), true, 'the lock itself must be unaffected')
      release()
      assert.equal(existsSync(`${protectedPath}.lock`), false)
    }

    const after = lockTraceSnapshot()
    assert.equal(after.enabled, false)
    assert.equal(after.total, 0, 'a disabled counter must not count, allocate, or accumulate')
    assert.deepEqual(after.byPath, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.9.6: with tracing on the counter counts and resets (separate process)', () => {
  // `LOCK_TRACE_ENABLED` is read once at module load, so flipping the env inside this process would
  // measure nothing. A child process is the honest way to assert the enabled path.
  const script = `
    import { pathToFileURL } from 'node:url'
    const mod = await import(pathToFileURL(${JSON.stringify(join(REPO, 'index.js'))}).href)
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-traceon-'))
    try {
      mod.lockTraceReset()
      for (let i = 0; i < 4; i += 1) {
        const release = mod.acquireFileLock(join(dir, 'x' + i + '.lock'), { timeoutMs: 5000 })
        release()
      }
      const on = mod.lockTraceSnapshot()
      mod.lockTraceReset()
      const cleared = mod.lockTraceSnapshot()
      console.log(JSON.stringify({ enabled: on.enabled, total: on.total, paths: on.byPath.length, cleared: cleared.total }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, DSH_LOCK_TRACE: '1' },
  })
  const result = JSON.parse(out.trim().split('\n').pop())
  assert.equal(result.enabled, true)
  assert.equal(result.total, 4, 'four acquisitions must be counted')
  assert.equal(result.paths, 4, 'four distinct paths')
  assert.equal(result.cleared, 0, 'reset must clear')
})
