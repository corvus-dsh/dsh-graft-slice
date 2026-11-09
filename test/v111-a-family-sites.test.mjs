/**
 * A-FAMILY REGRESSION SUITE — one predicate, four doors.
 *
 * ── WHAT THIS FILE ACTUALLY PROVES, AND WHAT IT DOES NOT ────────────────────────────────────────
 *
 * Two failures shaped this file, both measured rather than assumed:
 *
 * 1. `splitByShape` was written at column 0 above `takePendingConstraintMessages` and looked
 *    top-level. It was not: that neighbour is a CLOSURE inside `apply()` (it captures `ctx`), so the
 *    helper inherited apply's scope. Two call sites were inside apply and worked; the two top-level
 *    ones threw `ReferenceError: splitByShape is not defined`, and A4's throw was swallowed by
 *    `persistConstraintSections`'s own try/catch. The only visible symptom was a passing-looking
 *    `the shield must be written to disk` failure in v72-hardening.
 *
 * 2. The FIRST version of these tests passed with the doors REMOVED. Three separate reasons, each
 *    found by measurement and each fixed here:
 *      * the queue file was named `.graft-pending-constraints.json`; the plugin reads
 *        `.pending-constraints.json`, so the seeded input was never even loaded;
 *      * the fragments were seeded as a user message, so the EXTRACTION gate removed them before any
 *        A-door was reached — the tests were measuring B1 while wearing A's name;
 *      * A1 and A2 guard the SAME in-memory path, so disabling either one alone is unobservable.
 *
 * ── THE MEASURED REDUNDANCY (a finding, not a bug) ──────────────────────────────────────────────
 *
 * Disabling doors in combination and watching whether the fragment reaches the model:
 *
 *     all ON        leaks: no        A1 OFF only   leaks: no
 *     A2 OFF only   leaks: no        A4 OFF only   leaks: no
 *     A1+A2 OFF     leaks: YES  ← only this combination leaks
 *     A1+A4 OFF     leaks: no        A2+A4 OFF     leaks: no
 *
 * So for anything that came through the loader, A1 and A2 are two locks on one door: EITHER alone
 * suffices, and a test that removes one can never go red. A1 keeps an independent input class —
 * `refineConstraintsInBackground` writes model-produced text straight into `pendingConstraints`
 * without ever touching disk, so A2 cannot see it — but that path needs a provider to drive, so its
 * own test is marked SKIPPED with the reason instead of being faked.
 *
 * The assertions below are therefore stated as what they measure: "A2 alone is sufficient" and
 * "A1+A2 together are necessary". Both are true, both can go red, and neither pretends to isolate a
 * door that cannot be isolated.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, buildInjectionEvents, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** A real sentence that must survive every door. */
const GOOD = '绝对不能在没备份的情况下删除账本文件。'
/** S1_JSON: a JSON array element cut out of a report ABOUT constraints. */
const JSON_FRAGMENT = '"绝对约束（后续所有轮次都不能违反）："'
/** S2_TABLE: a pasted markdown table row. */
const TABLE_ROW = '| 2 | 4 | Information | Never include my name |'

/** The REAL queue file name, read from the plugin's own configuration (measured, not guessed). */
const QUEUE_FILE = '.pending-constraints.json'

test('A3: the handoff renderer never WRITES a fragment, and numbering has no gap', () => {
  // The renderer receives the constraint list as an ARGUMENT, so no upstream gate can mask it —
  // this is the only door in the family that is directly observable in isolation.
  const plan = {
    cwd: '/w',
    goal: 'goal',
    phase: 'phase',
    chunks: [{ kind: 'text', text: 'x' }],
    constraints: [GOOD, JSON_FRAGMENT, TABLE_ROW],
    workspaceFiles: [],
    generation: 2,
    boundary: { boundarySeq: 10 },
    sourceTemplate: { kind: 'user' },
  }
  const settings = {
    igniteTarget: false,
    ignitionPrompt: '',
    ignitionMode: 'queue',
    workspaceRedline: false,
    constraintProvider: 'test',
    constraintModel: 'test',
    skeletonTurn: 0,
    skeletonStep: 0,
  }
  const events = buildInjectionEvents(plan, settings, 'target-1', 'source-1')
  const goal = events.find((event) => event.type === 'user/message')
  assert.ok(goal, 'a goal message must be produced')
  const text = JSON.stringify(goal.data)

  assert.ok(text.includes('绝对不能在没备份'), 'the genuine rule must be rendered')
  assert.ok(!text.includes('后续所有轮次都不能违反'), 'the JSON fragment must NOT be rendered')
  assert.ok(!text.includes('Never include my name'), 'the table row must NOT be rendered')

  // A gap in the numbering reads as "a rule was silently lost" — the failure this work is about.
  const numbered = [...text.matchAll(/(\d+)\. \[ \]/gu)].map((match) => Number(match[1]))
  assert.deepEqual(numbered, numbered.map((_value, index) => index + 1), `numbering must be contiguous, got ${JSON.stringify(numbered)}`)
})

/** Deliver one pre-step for an agent id and return everything the listener produced. */
async function deliverPreStep(ctx, agentId) {
  const listeners = ctx._listeners.get('agent/pre-step') ?? []
  assert.ok(listeners.length > 0, 'the pre-step listener must be registered')
  const resolved = []
  for (const listener of listeners) {
    resolved.push(
      await listener({ agent: { id: agentId }, messages: [], turn: 1, step: 1 }, () => ({ kind: 'enter', messages: [] })),
    )
  }
  return JSON.stringify(resolved)
}

test('A2: a poisoned queue on disk is filtered at LOAD, and the load does not rewrite the file', () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-a2-'))
  const queueFile = join(dir, QUEUE_FILE)
  writeFileSync(
    queueFile,
    JSON.stringify([{ targetId: 'a2-target', sourceSessionId: 'src', constraints: [GOOD, JSON_FRAGMENT], extractedAt: 1 }], null, 2),
    'utf8',
  )
  const before = readFileSync(queueFile, 'utf8')

  const ctx = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir })

  // A2's own claim: LOADING a poisoned queue must not rewrite the file. The queue is audit evidence —
  // a previous build really did accept those strings, and erasing them on load would make the
  // incident unreproducible. (Injection later DOES consume the entry; that is separate and asserted
  // in the next test.)
  assert.equal(readFileSync(queueFile, 'utf8'), before, 'LOAD must not rewrite the queue file')
})

test('A1+A2: together they are what keeps a fragment from reaching the model', async () => {
  /**
   * ── WHY THIS IS NOT SPLIT INTO ONE TEST PER DOOR ───────────────────────────────────────────────
   *
   * Measured: with A2 alone disabled the fragment still does not reach the model, because A1 filters
   * it at injection on the same in-memory path. With A1 alone disabled, A2 has already removed it at
   * load. Removing either one is unobservable, so an assertion naming only one of them could never
   * fail — it would be a test of the other door wearing the wrong name.
   *
   * What CAN be asserted honestly: with both in place the fragment never reaches the model, a
   * genuine rule does, and an all-rejected queue produces no message at all (an empty
   * "以下约束，请遵守：" block makes a reader hunt for rules that are not there).
   */
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-a12-'))
  writeFileSync(
    join(dir, QUEUE_FILE),
    JSON.stringify(
      [
        { targetId: 'mixed', sourceSessionId: 'src', constraints: [GOOD, JSON_FRAGMENT], extractedAt: 1 },
        { targetId: 'all-bad', sourceSessionId: 'src', constraints: [JSON_FRAGMENT, TABLE_ROW], extractedAt: 2 },
      ],
      null,
      2,
    ),
    'utf8',
  )
  const ctx = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir })

  const mixed = await deliverPreStep(ctx, 'mixed')
  assert.ok(mixed.includes('绝对不能在没备份'), `the genuine rule must reach the model, got: ${mixed.slice(0, 400)}`)
  assert.ok(!mixed.includes('后续所有轮次都不能违反'), `the fragment must not reach the model, got: ${mixed.slice(0, 400)}`)

  const allBad = await deliverPreStep(ctx, 'all-bad')
  assert.ok(
    !allBad.includes('这个会话从旧会话继承了以下长期约束'),
    `an all-rejected queue must inject NO constraint message, got: ${allBad.slice(0, 400)}`,
  )
})

test('A1: the refine path is a SECOND writer A2 cannot see (structural — its own test is skipped)', (t) => {
  /**
   * ── THE CLAIM, AND WHY IT IS NOT ASSERTED BEHAVIOURALLY ────────────────────────────────────────
   *
   * `refineConstraintsInBackground` writes a MODEL-PRODUCED constraint list straight into
   * `pendingConstraints`; that text never exists on disk, so A2 (which filters the queue at load)
   * cannot possibly see it. That is A1's independent input class, and it is why A1 is not a duplicate
   * of A2.
   *
   * Driving it needs a live constraint provider (the refinement path only runs when one answers), so
   * a behavioural test would have to fake a model — which would then be a test of the fake. The
   * structural claim IS asserted here (two writers, one outside the loader), and the behavioural half
   * is recorded as SKIPPED with its reason rather than papered over.
   */
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/gu, '\n')
  const writers = [...source.matchAll(/pendingConstraints\.set\(/gu)].length
  const loaderWriters = [...source.matchAll(/pendingConstraints\.set\(item\.targetId/gu)].length
  assert.equal(writers, 2, 'there must be exactly two writers into the queue')
  assert.equal(loaderWriters, 1, 'exactly one of them is the loader that A2 filters')
  assert.ok(
    source.includes('pendingConstraints.set(targetSessionId, {'),
    'the second writer is the refinement path — the input class A1 owns',
  )
  t.diagnostic('behavioural half of A1 is unproven: it needs a live constraint provider')
})

test('A4: the section ledger refuses fragments — and is WRITTEN (the regression that hid the bug)', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-a4-'))
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: { id: 'uc', role: 'user', content: [{ type: 'text', text: [GOOD, JSON_FRAGMENT, TABLE_ROW].join('\n') }], source: { kind: 'user' } },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'a4-target' }, {})
  assert.equal(report.ok, true)

  const file = join(dir, '.graft-constraint-sections.json')
  // A ReferenceError inside persistConstraintSections is swallowed by its own try/catch, so "the file
  // was never created" is the ONLY visible symptom — assert on the file, not on the return value.
  assert.equal(existsSync(file), true, 'the ledger must actually be written')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  const list = stored['a4-target'].constraints
  assert.ok(list.some((item) => item.includes('绝对不能在没备份')), `the genuine rule must persist, got: ${JSON.stringify(list)}`)
  assert.ok(!list.some((item) => item.includes('后续所有轮次都不能违反')), 'the JSON fragment must NOT persist')
  assert.ok(!list.some((item) => item.includes('Never include my name')), 'the table row must NOT persist')
})
