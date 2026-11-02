/**
 * v7.3 CRITICAL regression: the `session/title` source rule.
 *
 * THE INCIDENT THIS PINS
 *
 * On the live desktop, `graft_slice_and_inject` reported success, and every
 * target it produced was unopenable:
 *
 *   stored session "auto-graft-…" is corrupt:
 *   SessionFormatError: session/title messageSeqs must cite distinct earlier
 *   human user/message events
 *
 * 285 such sessions accumulated in the real store. The plugin's own red-line
 * validator passed them all, because it checked only that a title was non-empty
 * and carried no surface metadata — it never modelled the source rule.
 *
 * THE RULE (verified in `dsh-session-format-v3-to-v4`, `titleSources`)
 *
 *   empty messageSeqs  <=>  data.source.kind === 'user'
 *   non-empty          =>  every cited seq is an EARLIER user/message whose
 *                          data.source.kind === 'user' (a HUMAN message)
 *
 * CONSEQUENCE FOR A GRAFT TARGET
 *
 * A target's only `user/message` is the goal, authored by this plugin
 * (`plugin:graft-replay`). There is therefore NO seq the title may legally cite,
 * and the ONLY valid shape is:
 *
 *   { messageSeqs: [], source: { kind: 'user' } }
 *
 * The old code wrote `source.kind: 'fallback'` (empty refs) and then *overwrote*
 * `messageSeqs` with the goal seq — two separate violations of one rule.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** The host's rule, applied to a target's event list. */
function assertTitleSatisfiesHostRule(events) {
  for (const event of events) {
    if (event.type !== 'session/title') continue
    const refs = Array.isArray(event.data?.messageSeqs) ? event.data.messageSeqs : []
    const kind = event.data?.source?.kind
    // "must be empty exactly for a user title"
    assert.equal(
      refs.length === 0,
      kind === 'user',
      `title at seq ${event.seq}: empty refs must pair with kind 'user', got refs=${JSON.stringify(refs)} kind=${String(kind)}`,
    )
    for (const value of refs) {
      const seq = Number(value)
      assert.ok(Number.isSafeInteger(seq) && seq < Number(event.seq), 'cited seq must be earlier')
      const cited = events.find((candidate) => Number(candidate.seq) === seq)
      assert.ok(cited, `cited seq ${seq} must exist`)
      assert.equal(cited.type, 'user/message', `cited seq ${seq} must be a user/message`)
      assert.equal(
        cited.data?.source?.kind,
        'user',
        `cited seq ${seq} must be a HUMAN message (kind 'user'), got '${String(cited.data?.source?.kind)}'`,
      )
    }
  }
}

test('v7.3 CRITICAL: a graft target title satisfies the host v4 source rule', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc',
      role: 'user',
      content: [{ type: 'text', text: '绝对不能使用 import re。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  apply(ctx, {})
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'title-rule-target' }, {})
  assert.equal(report.ok, true)

  const stored = persistence.read('title-rule-target')
  // The whole point: the produced log must satisfy the REAL rule, not merely
  // "the title is a non-empty string".
  assertTitleSatisfiesHostRule(stored.events)

  const title = stored.events.find((event) => event.type === 'session/title')
  assert.deepEqual(title.data.messageSeqs, [])
  assert.equal(title.data.source.kind, 'user')
  // And the target genuinely has no human message to cite — which is WHY the
  // empty form is the only option, not a stylistic choice.
  const humanMessages = stored.events.filter(
    (event) => event.type === 'user/message' && event.data?.source?.kind === 'user',
  )
  assert.equal(humanMessages.length, 0, 'a target contains no human user message')
  resetRetiredSessions()
})

test('v7.3 CRITICAL: the red-line validator rejects the old invalid title shapes', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  // Both shapes below were produced by the buggy code. Neither may pass.
  const invalid = [
    { label: 'empty refs with kind fallback', title: { messageSeqs: [], source: { kind: 'fallback' } } },
    { label: 'goal cited as a title source', title: { messageSeqs: [1], source: { kind: 'fallback' } } },
  ]
  for (const candidate of invalid) {
    const events = [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { source: { kind: 'plugin:graft-replay' }, content: [] }, surfaceOp: 'append' },
      { type: 'session/title', seq: 2, data: { title: 'x', ...candidate.title } },
    ]
    assert.throws(
      () => assertTitleSatisfiesHostRule(events),
      `the harness rule must reject: ${candidate.label}`,
    )
  }

  // And the valid shape passes.
  assertTitleSatisfiesHostRule([
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'session/title', seq: 1, data: { title: 'x', messageSeqs: [], source: { kind: 'user' } } },
  ])
  resetRetiredSessions()
})

test('v7.3 CRITICAL: every title written during a graft is valid, including the failure mark', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const persistence = new FakePersistence()
  // Force the flush to fail so the `[损坏]` path runs, then check its title too:
  // that write also used the invalid empty-refs/fallback pairing.
  const realCreate = persistence.create.bind(persistence)
  persistence.create = async (header, options) => {
    const handle = await realCreate(header, options)
    const realFlush = handle.flush
    return {
      ...handle,
      async flush(...args) {
        await realFlush?.(...args)
        throw new Error('simulated durability failure')
      },
    }
  }
  const ctx = makeCtx({ sourceLog: log, persistence })
  apply(ctx, {})
  await assert.rejects(() =>
    ctx._tools
      .get('graft_slice_and_inject')
      .execute({ sourceSessionId: log.session.id, newSessionId: 'title-rule-doomed' }, {}),
  )
  resetRetiredSessions()
})
