/**
 * P1-3 (audit 2026-11-08) — THE `api-session/added` PAYLOAD IS A WIRE CONTRACT, AND THIS LOCKS IT.
 *
 * graft emits this event from TWO places, for two kinds of session the host never announces: a graft
 * target (kept cold so it stays resumable) and an archived fork. Both go through the same predicate
 * in `core/host-shape.ts`, and both are checked here.
 *
 * ── ONE OF THE TWO SITES IS REACHABLE WITH A REAL BAD PAYLOAD, AND THAT IS THE INTERESTING PART ──
 *
 * The target path derives both fields (`newId`, `Date.now()`), so no caller can produce an
 * unresolvable summary there — same situation as `dsh-paradise`.
 *
 * The fork sweep is different: `updatedAt` is taken from `header.createdAt` whenever it is
 * `typeof === 'number'`, and `NaN` passes that test. So a damaged session header produces a summary
 * the client cannot key by, and the sweep is a real, drivable path to it. `test/v74-archived-fork`
 * covers the happy path; the RUNTIME test below drives the damaged one and asserts three things at
 * once: the row is NOT announced, the failure is REPORTED, and THE SWEEP CONTINUES — one bad header
 * must not hide every other archived fork.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertSessionSummary, registerArchivedForks, resetRetiredSessions } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

test('P1-3: a well-formed cold summary is accepted', () => {
  assert.equal(assertSessionSummary({ sessionId: 'session-abc', updatedAt: 1_700_000_000_000 }), true)
  assert.equal(assertSessionSummary({ sessionId: 's', updatedAt: 0 }), true)
})

test('P1-3: a sessionId the client cannot key by is refused', () => {
  for (const sessionId of [undefined, null, '', 0, 42, false, {}, []]) {
    assert.equal(
      assertSessionSummary({ sessionId, updatedAt: 1 }),
      false,
      `sessionId=${JSON.stringify(sessionId)} must be refused`,
    )
  }
})

test('P1-3: a non-finite updatedAt is refused — the case a bare typeof check lets through', () => {
  for (const updatedAt of [undefined, null, '1700000000000', Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
    assert.equal(
      assertSessionSummary({ sessionId: 's', updatedAt }),
      false,
      `updatedAt=${String(updatedAt)} must be refused`,
    )
  }
})

test('P1-3: a non-object payload is refused rather than throwing', () => {
  for (const payload of [undefined, null, 'summary', 7, true]) {
    assert.equal(assertSessionSummary(payload), false)
  }
})

test('P1-3 STATIC: BOTH emit sites are reachable only through the guard, and refusal is reported', () => {
  const marker = "'api-session/added'"
  const sites = []
  for (let at = indexSource.indexOf(marker); at !== -1; at = indexSource.indexOf(marker, at + 1)) sites.push(at)
  /**
   * Exactly two SINGLE-QUOTED occurrences exist, and they are the two call sites: every mention of
   * this event in a comment is in backticks, or in the double-quoted host snippet quoted at length.
   * If that ever stops being true this assertion fails, which is the point — a third emit added
   * without a guard must turn a test red.
   */
  assert.equal(sites.length, 2, 'graft announces from exactly two places — target and archived fork')

  for (const emitAt of sites) {
    const guardAt = indexSource.lastIndexOf('assertSessionSummary(', emitAt)
    assert.notEqual(guardAt, -1, 'every emit must be preceded by assertSessionSummary(summary)')
    assert.ok(guardAt < emitAt)
    const between = indexSource.slice(guardAt, emitAt)
    assert.match(between, /^assertSessionSummary\(summary\)/u, 'the guard must inspect the emitted object')
    assert.match(between, /warnings\.push\(|logger\?\.warn\?\.\(/u, 'a refused announcement must be reported, never silent')
    assert.match(between, /\}\s*else\s*\{|continue/u, 'the refusal branch must SKIP the emit (an else, or a continue)')
    assert.ok(between.length < 900, 'the guard must be the nearest check before the emit, not a distant one')
  }

  // The fork sweep reports through the logger and SKIPS the row (rather than aborting the sweep).
  assert.match(indexSource, /archived fork \$\{JSON\.stringify\(id\)\} not announced/u)
})

test('P1-3 RUNTIME: a NaN header timestamp is skipped, reported, and does not stop the sweep', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog: log })
  const original = ctx.get.bind(ctx)
  ctx.get = (name) => {
    if (name === 'sessionQuery') {
      return {
        listSessions: async () => [
          /** `typeof NaN === 'number'`, which is the whole reason the guard uses isFinite. */
          { header: { id: 'baseline-fork-damaged', cwd: 'D:\\work\\demo', createdAt: Number.NaN }, live: false, persisted: true, formatStatus: 'current' },
          { header: { id: 'baseline-fork-healthy', cwd: 'D:\\work\\demo', createdAt: 1000 }, live: false, persisted: true, formatStatus: 'current' },
        ],
      }
    }
    if (name === 'workspaceRegistry') {
      return { resolveByPath: async () => ({ id: 'ws-1', attachSession: async () => {} }) }
    }
    return original(name)
  }
  const warned = []
  ctx.logger = { info() {}, warn: (message) => warned.push(String(message)), error() {} }

  const before = ctx._emitted.length
  const announced = await registerArchivedForks(ctx, { registerArchivedForks: true })

  const added = ctx._emitted.slice(before).filter((entry) => entry.name === 'api-session/added')
  assert.equal(added.length, 1, 'the damaged row must NOT be announced')
  assert.equal(added[0].args[0].sessionId, 'baseline-fork-healthy')
  assert.equal(announced, 1, 'and it must not be counted as announced')
  assert.ok(
    warned.some((message) => message.includes('baseline-fork-damaged')),
    'the skip must be reported — a silently dropped sidebar row is the failure this guard prevents',
  )
})
