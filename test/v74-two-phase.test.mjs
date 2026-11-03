/**
 * v7.4 P1-2：两阶段切片审核（prepare / commit）。
 *
 * WHY TWO STEPS
 *
 * The old `confirm` mode asked one question — "migrate now?" — and never showed
 * what the tape would contain. The user could not see the goal, the retained
 * turns, the constraints, or what was left open; approving was a leap. Measured
 * cost of a wrong leap: an entire implementation round arriving in a window that
 * described a different task.
 *
 * `graft_prepare` is read-only: it builds the plan, summarises it, and hashes the
 * parts the user actually reads. `graft_commit` refuses to write unless
 *
 *   1. the prepared id is still fresh (30 minutes),
 *   2. the digest equals the one the user reviewed, and
 *   3. the source's last seq has not moved — a source that gained events means
 *      the review is stale, and committing it would migrate unseen work.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getTransferredSessions, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold() {
  const log = makeSourceLog({ turns: 3 })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-prepare-'))
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { log, ctx, persistence }
}

test('v7.4 P1-2: prepare is read-only and returns a reviewable digest', async () => {
  resetRetiredSessions()
  const { log, ctx, persistence } = scaffold()
  const emittedBefore = ctx._emitted.length

  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})

  assert.equal(typeof prepared.digest, 'string')
  assert.equal(prepared.digest.length, 64, 'sha256 hex')
  assert.equal(prepared.sourceSessionId, log.session.id)
  assert.equal(prepared.sourceLastSeq, log.events.at(-1).seq, 'the review records the source watermark')
  assert.match(prepared.review, /准备就绪/u)

  // Read-only means read-only.
  assert.equal(ctx._emitted.length, emittedBefore, 'prepare must not announce a session')
  assert.equal(getTransferredSessions().get(log.session.id), undefined, 'prepare must not retire the source')
  assert.equal(persistence.read(prepared.targetSessionId), undefined, 'prepare must not write a target')
  resetRetiredSessions()
})

test('v7.4 P1-2: commit refuses a digest that is not the reviewed one', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()
  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})

  await assert.rejects(
    () => ctx._tools.get('graft_commit').execute({ preparedId: prepared.preparedId, digest: 'f'.repeat(64) }, {}),
    (error) => error.code === 'SLICE_DIGEST_MISMATCH',
  )
  resetRetiredSessions()
})

test('v7.4 P1-2: a source that moved on invalidates the review', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()
  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})

  // The source CLOSED ANOTHER TURN while the user was reviewing.
  //
  // v7.4 refinement: the hard invariant is the BOUNDARY, not the last seq.
  // Comparing last seq made self-slicing impossible — the session being sliced is
  // the one taking tool calls, so it appends on every step and no commit could ever
  // succeed (observed live: 14578 -> 14583, refused). The boundary is what fixes
  // the tape's structure: which turns are replayed, which are indexed, and the seq
  // range of the read-back index. A closed turn changes all of that.
  const nextSeq = log.events.at(-1).seq + 1
  log.events.push({ type: 'turn/start', seq: nextSeq, time: 1, data: { turn: 4 } })
  log.events.push({ type: 'turn/end', seq: nextSeq + 1, time: 1, data: { turn: 4 } })

  await assert.rejects(
    () => ctx._tools.get('graft_commit').execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {}),
    (error) => error.code === 'SOURCE_DRIFT',
  )
  resetRetiredSessions()
})

test('v7.4 P1-2: events inside the OPEN turn refresh the tail instead of voiding the review', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()
  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})

  // Work continues in the turn that is already open. The boundary does not move,
  // so the reviewed history is intact; the carryover and pending state are simply
  // fresher than the ones that were displayed.
  //
  // v0.19: what refreshes the tail is a NEW INSTRUCTION, not more narration. The
  // work log no longer travels (see the semantic slimming), so appending an
  // assistant paragraph is correctly a no-op for the tape; appending a user
  // message is what changes what the target will be told to do.
  log.events.push({
    type: 'user/message',
    seq: log.events.at(-1).seq + 1,
    time: 1,
    data: {
      id: 'user-review-refresh',
      role: 'user',
      content: [{ type: 'text', text: '审核期间我又追加了一句：顺便把控制台面板一起改掉。' }],
      source: { kind: 'user' },
    },
  })

  const report = await ctx._tools
    .get('graft_commit')
    .execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {})
  assert.equal(report.ok, true, 'a moved tail inside the open turn must not block the commit')
  // v7.4b: the caller — not just the host log — must learn that what was written
  // is newer than what it approved. Measured live on handoff-demo: the
  // reviewed carryover was 277 chars, the committed one 370, and the result said
  // only "Committed the reviewed slice".
  assert.ok(report.tailRefreshed !== undefined, 'the commit result must report the refreshed tail')
  assert.ok(
    report.tailRefreshed.kinds.includes('open-turn-carryover'),
    `expected open-turn-carryover in ${JSON.stringify(report.tailRefreshed.kinds)}`,
  )
  assert.ok(Number(report.tailRefreshed.committedChars) > Number(report.tailRefreshed.reviewedChars))
  // The human-facing render must say it too, not just the structured field.
  const tool = ctx._tools.get('graft_commit')
  if (typeof tool.render === 'function') {
    const rendered = tool.render({}, report)
    const line = Array.isArray(rendered) ? rendered.map((part) => String(part?.text ?? '')).join(' ') : ''
    assert.match(line, /newer than the one you approved/u)
  }
  resetRetiredSessions()
})

test('v7.4 P1-2: an approved review commits into a durable target', async () => {
  resetRetiredSessions()
  const { log, ctx, persistence } = scaffold()
  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})

  const report = await ctx._tools
    .get('graft_commit')
    .execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {})

  assert.equal(report.ok, true)
  assert.equal(report.newSessionId, prepared.targetSessionId, 'the reviewed target id is the one written')
  assert.ok(persistence.read(report.newSessionId), 'the target is durable')
  assert.ok(getTransferredSessions().get(log.session.id), 'the source was retired at commit time')
  resetRetiredSessions()
})

test('v7.4 P1-2: committing twice is refused', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()
  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})
  await ctx._tools.get('graft_commit').execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {})

  await assert.rejects(
    () => ctx._tools.get('graft_commit').execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {}),
    (error) => error.code === 'PREPARED_UNKNOWN',
  )
  resetRetiredSessions()
})
test('v7.4b: a retired source refuses to be sliced again without allowReslice', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()
  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})
  await ctx._tools.get('graft_commit').execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {})

  // The source was retired by that commit. A second migration would fork the same
  // history into a divergent target — the exact confusion the ledger showed three
  // times in this project.
  await assert.rejects(
    () => ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {}),
    (error) => error.code === 'SOURCE_ALREADY_MIGRATED',
  )
  await assert.rejects(
    () => ctx._tools.get('graft_slice_and_inject').execute({ sourceSessionId: log.session.id, newSessionId: 'again-1' }, {}),
    (error) => error.code === 'SOURCE_ALREADY_MIGRATED',
  )
  resetRetiredSessions()
})

test('v7.4b: allowReslice: true lets an explicit re-slice through', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()
  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})
  await ctx._tools.get('graft_commit').execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {})

  const again = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id, allowReslice: true }, {})
  assert.equal(typeof again.digest, 'string')
  resetRetiredSessions()
})
