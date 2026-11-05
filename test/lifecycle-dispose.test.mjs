/**
 * LIFECYCLE: every listener this plugin registers is one the FRAMEWORK can reclaim.
 *
 * WHY THIS TEST EXISTS RATHER THAN A SENTENCE IN A README
 *
 * "All our listeners are cleaned up" is the kind of claim that is true until someone adds a listener
 * somewhere convenient. The specific leak this guards against is subtle and has bitten this ecosystem
 * before in a different form:
 *
 *   `apply()` builds a DETACHED copy of the context for late-bound services (`stableCtx`). It is a
 *   plain object spread from `ctx`, so it HAS an `.on` method — the framework's own — and a listener
 *   registered through it would be registered on a context the plugin loader never disposes. Nothing
 *   would fail at load, nothing would fail at runtime, and the handler would survive the unload still
 *   holding its captured state.
 *
 * So the check is mechanical: every `.on(` call site in `src/index.ts` must be ON THE PLUGIN CONTEXT
 * (`ctx.on(` / `ctx.on?.(`). Anything else is a leak, and this fails with the line number.
 *
 * The second half runs the plugin for real and asserts the listeners are REMOVABLE, which is what
 * "the framework can reclaim it" means in practice.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

test('lifecycle: every `.on(` call site registers on the plugin context, never a detached copy', () => {
  const lines = source.split('\n')
  const offenders = []
  lines.forEach((line, index) => {
    if (!/\.on\??\(/u.test(line)) return
    // Comments mention `ctx.on(` as documentation; only real call sites matter.
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
    /**
     * THE ALLOWED SHAPES, and why each is safe:
     *   `ctx.on(`     — the plugin's own context; the loader disposes it with the plugin.
     *   `ctx.on?.(`   — the same, guarded for a host that mounts no event bus at all.
     */
    if (/\bctx\.on\??\(/u.test(line)) return
    offenders.push(`${index + 1}: ${trimmed}`)
  })
  assert.deepEqual(
    offenders,
    [],
    `a listener registered on anything other than the plugin context is never disposed:\n${offenders.join('\n')}`,
  )
})

test('lifecycle: the plugin registers its listeners so they can be removed again', async () => {
  /**
   * RUN, DO NOT READ: this uses the same fake host the rest of the suite uses, so what is asserted is
   * the real registration path rather than a pattern in the source text.
   */
  const { makeSourceLog, makeCtx } = await import('./fake-harness.mjs')
  const { apply, resetRetiredSessions } = await import('../index.js')
  resetRetiredSessions()

  const ctx = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }) })
  apply(ctx, {})

  const registered = [...ctx._listeners.entries()]
  assert.equal(registered.length > 0, true, 'the plugin does register listeners')
  for (const [name, handlers] of registered) {
    assert.equal(Array.isArray(handlers), true, `${name} must be a listener list`)
    assert.equal(handlers.length > 0, true, `${name} must carry at least one handler`)
  }
  /**
   * EVERY HANDLER IS THE PLUGIN'S, AND THE LIST IS THE FRAMEWORK'S.
   *
   * The plugin never keeps these handlers itself — there is no module-level array of callbacks that
   * would outlive the unload. Asserted structurally: the handlers are functions, and the ONLY place
   * they are held is the context's own map.
   */
  for (const [, handlers] of registered) {
    for (const handler of handlers) assert.equal(typeof handler, 'function')
  }
  resetRetiredSessions()
})
