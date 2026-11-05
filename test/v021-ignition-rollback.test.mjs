/**
 * v0.21 P0 — THE DOUBLE-BLIND ROLLBACK.
 *
 * The user's requirement, in their words: "如果在 20s 超时 + 3 次重试后，依然无法成功
 * 唤醒 Target 会话...必须执行 un-retire 回滚...绝对不能出现源已冻结、目标没醒的『双盲』
 * 状态。"
 *
 * The failure being prevented is not a lost migration, it is a lost SESSION: the
 * source is retired before the target is ignited, so if the ignition never lands, the
 * source rejects every step and the target never takes one. Both are on disk; neither
 * accepts work.
 *
 * The headline test here is the one the user asked for by name: an ignition channel
 * that always times out, therefore an old session that is successfully un-retired.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  clearGraftTargetsForTest,
  getPendingIgnitions,
  getRetiredSessions,
  getTransferredSessions,
  IGNITION_MAX_ATTEMPTS,
  isRetired,
  normalizeConfig,
  readLedgerPayload,
  resetRetiredSessions,
  ROLLBACK_NOTICE,
  ROLLBACK_NOTICE_MARKER,
  resumePendingIgnitions,
  rollbackFailedIgnition,
  takeRollbackNotice,
} from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold({ controller } = {}) {
  resetRetiredSessions()
  // v0.21: `graftTargets` marks a session as a TARGET this plugin created, and a
  // target inside its grace window is protected. Across tests the same source id is
  // reused, so a stale mark makes the next test's pre-step behave differently from an
  // isolated run — the classic fixture leak that hides a real regression.
  clearGraftTargetsForTest()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-rollback-'))
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
  if (controller !== undefined) ctx.sessionController = controller
  apply(ctx, { dataDir: dir })
  return { ctx, log, dir }
}

/** A channel that never answers: it hangs until the 20s ignition timeout fires. */
function neverAnswering() {
  const calls = []
  return {
    calls,
    prompt() {
      calls.push(Date.now())
      return new Promise(() => {})
    },
  }
}

/** Fill the durable queue with an exhausted entry, as three failed rounds would. */
function exhaustQueue(dir, sourceSessionId, targetId) {
  // The queue file is the durable intent; seeding it directly is what a restart
  // after three failed activations would find.
  writeFileSync(
    join(dir, '.graft-pending-ignition.json'),
    JSON.stringify([
      { targetId, sourceSessionId, at: Date.now() - 60_000, attempts: IGNITION_MAX_ATTEMPTS },
    ]),
    'utf8',
  )
}

test('v0.21 P0: an ignition that never answers leaves the source RETIRED and the work queued', async () => {
  const controller = neverAnswering()
  const { ctx, log, dir } = scaffold({ controller })

  // Not `await`ing the tool: the point is the state while the prompt is hanging.
  const pending = ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-dead-target' }, {})

  // Give the migration time to reach the ignition call without completing it.
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(controller.calls.length >= 1, 'the channel was actually called')
  assert.equal(isRetired(log.session.id), true, 'mid-flight the source IS retired by design')

  // The prompt never settles, so the tool call is still open. Stop waiting on it and
  // let the queue say what would happen next.
  pending.catch(() => {})
  assert.equal(getPendingIgnitions().has('session-dead-target'), true)
  resetRetiredSessions()
})

test('v0.21 P0 ACCEPTANCE: an always-timing-out ignition UN-RETIRES the old session', async () => {
  // The user asked for exactly this: "模拟点火接口永远超时，断言旧会话被成功 un-retire".
  //
  // Three failed activation rounds are simulated by seeding the durable queue at the
  // attempt cap — that is precisely the state a restart finds after 20s x 3 — and the
  // migration is completed first so the source really is retired when the rollback runs.
  const { ctx, log, dir } = scaffold({ controller: neverAnswering() })

  // Run the migration to completion with a channel that hangs: the tool's ignition
  // attempt times out, so the source stays retired and the target stays queued.
  const pending = ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-will-die' }, {})
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(isRetired(log.session.id), true, 'the migration retired the source')

  // Pretend the budget is spent and the process restarted.
  //
  // Deliberately NOT `apply(again)`: activation itself consumes the queue, so the
  // rollback would happen inside `apply` and this test could not observe the state
  // that PRECEDES it. A fresh context plus an explicit `loadPendingIgnitions` is the
  // same read a restart performs, without the automatic consumption.
  exhaustQueue(dir, log.session.id, 'session-will-die')
  const again = makeCtx({ sourceLog: log, paths: { data: dir } })
  again.sessionController = neverAnswering()
  resetRetiredSessions()
  const { loadPendingIgnitions, refreshMigrationLedgers } = await import('../index.js')
  loadPendingIgnitions(again)
  refreshMigrationLedgers()
  assert.equal(isRetired(log.session.id), true, 'the on-disk ledger still retires it before rollback')

  const results = await resumePendingIgnitions(again, normalizeConfig({}))
  pending.catch(() => {})
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, false)
  assert.equal(results[0].rollback?.attempted, true)
  assert.equal(results[0].rollback?.sourceRestored, true, 'the source must be RESTORED, not left frozen')

  // THE ASSERTION THE USER ASKED FOR.
  assert.equal(isRetired(log.session.id), false, 'the old session is un-retired')
  assert.equal(getRetiredSessions().has(log.session.id), false)
  assert.equal(getTransferredSessions().has(log.session.id), false)

  // ...and it is durable, not just in memory: a restart must not re-retire it.
  const retiredOnDisk = readLedgerPayload(join(dir, '.retired.json'))
  assert.equal(Array.isArray(retiredOnDisk), true)
  assert.equal(retiredOnDisk.includes(log.session.id), false, '.retired.json no longer lists the source')
  const transferredOnDisk = readLedgerPayload(join(dir, '.transferred.json'))
  assert.equal(Object.keys(transferredOnDisk ?? {}).includes(log.session.id), false)

  // The queue is drained, so the rollback cannot fire twice.
  assert.equal(getPendingIgnitions().has('session-will-die'), false)
  resetRetiredSessions()
})

test('v0.21 P0 / v7.8: the source is told WHY it is back — through pre-step messages, not its log', async () => {
  const { ctx, log } = scaffold({ controller: { async prompt() { return { accepted: true } } } })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-notice' }, {})

  const rollback = await rollbackFailedIgnition(ctx, log.session.id, 'session-notice', 'timeout after 20000ms')
  assert.equal(rollback.sourceRestored, true)
  assert.equal(
    rollback.noticeAppended,
    true,
    'a rollback nobody can see reads as "nothing happened" — the notice must exist SOMEWHERE',
  )

  /**
   * v7.8 — THE CHANNEL MOVED. This test used to assert the notice arrived as an appended
   * `developer/message` event. That shape carried `{ turn: 0, step: 0 }`, which is not a real round; the
   * host's resume-time format validation rejects it, and it fired on the SOURCE session the user was
   * still working in. The notice now travels through the pre-step `messages` channel, which writes
   * nothing and consumes no step.
   *
   * So there are now TWO facts to pin, and they are opposite halves of the same guarantee:
   *   1. the notice is DELIVERED to the model on the source's next step (below);
   *   2. it is NOT written into the source's log (asserted at the end).
   */
  const decision = await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [{ role: 'user', content: [] }] })
  assert.equal(decision.kind, 'enter')
  const injected = decision.messages.filter(
    (message) => typeof message?.content?.[0]?.text === 'string' && message.content[0].text.includes(ROLLBACK_NOTICE_MARKER),
  )
  assert.equal(injected.length, 1, 'the rollback notice is delivered exactly once')
  assert.equal(injected[0].content[0].text, ROLLBACK_NOTICE)
  assert.match(injected[0].content[0].text, /由于新会话点火失败，已为您自动回滚到当前会话，请重试切片。/u)

  /**
   * THE DEFECT THIS CHANGE EXISTS TO REMOVE: nothing may be appended to the source's log, and in
   * particular nothing may carry the fabricated `turn: 0` / `step: 0`.
   */
  assert.equal(
    ctx._sourceDeveloperAppends.length,
    0,
    'the rollback must NOT write a developer/message into the source log — that event needed turn:0/step:0',
  )

  /**
   * ...and it is one-shot: the next step must not be told again. A repeated notice reads as a second
   * failure, which is the wrong next move for the user to take.
   */
  const second = await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [{ role: 'user', content: [] }] })
  const again = second.messages.filter(
    (message) => typeof message?.content?.[0]?.text === 'string' && message.content[0].text.includes(ROLLBACK_NOTICE_MARKER),
  )
  assert.equal(again.length, 0, 'the notice is consumed on delivery, never repeated')
  resetRetiredSessions()
})

test('v0.21 P0: the dead target is marked, so it is not mistaken for the way forward', async () => {
  const { ctx, log } = scaffold({ controller: { async prompt() { return { accepted: true } } } })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-marked' }, {})
  await rollbackFailedIgnition(ctx, log.session.id, 'session-marked', 'no channel')

  const target = JSON.parse(
    JSON.stringify(ctx._persistence.read('session-marked')),
  )
  const title = target.events
    .filter((event) => event.type === 'session/title')
    .map((event) => event.data?.title ?? '')
    .some((value) => value.startsWith('[点火失败]'))
  assert.equal(title, true, 'the target keeps its data but says it did not start')
  resetRetiredSessions()
})

test('v0.21 P0: a SUCCESSFUL ignition is never rolled back', async () => {
  // The inverse mistake would resurrect a session the user already left, which is the
  // "two divergent targets" failure the retirement machinery exists to stop.
  const { ctx, log } = scaffold({ controller: { async prompt() { return { accepted: true } } } })
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-healthy' }, {})
  assert.equal(report.ignition.ok, true)
  assert.equal(report.ignition.rollback, undefined, 'a healthy ignition reports no rollback')
  assert.equal(isRetired(log.session.id), true, 'the retirement stands')
  resetRetiredSessions()
})

test('v0.21 P0: after a rollback the source ACCEPTS work again (the double-blind is closed)', async () => {
  const { ctx, log } = scaffold({ controller: { async prompt() { return { accepted: true } } } })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-recovered' }, {})

  const blocked = await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  assert.equal(blocked.kind, 'reject', 'precondition: retired sessions are rejected')

  const rollback = await rollbackFailedIgnition(ctx, log.session.id, 'session-recovered', 'gave up')
  assert.equal(rollback.sourceRestored, true)
  // The in-memory gate the pre-step reads must agree with the file; if these disagree
  // the session is un-retired on disk and still frozen in the running process.
  assert.equal(isRetired(log.session.id), false)
  assert.equal(getTransferredSessions().has(log.session.id), false)

  // The DOUBLE-BLIND is the failure: source frozen AND target inert. Closing it means
  // the source takes work again — asserted on the live decision, not on a flag.
  const allowed = await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  assert.notEqual(
    allowed.kind,
    'reject',
    `the user must be able to work again; got ${allowed.kind}: ${String(allowed.reason ?? '')}`,
  )
  resetRetiredSessions()
})

test('v0.21 P0: the rollback is audited, and the audit names both sides', async () => {
  const { ctx, log } = scaffold({ controller: { async prompt() { return { accepted: true } } } })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-audited' }, {})
  await rollbackFailedIgnition(ctx, log.session.id, 'session-audited', 'timeout after 20000ms')

  const audit = readFileSync(join(ctx.pathsData, '.graft-audit.jsonl'), 'utf8')
  assert.match(audit, /"kind":"ignite-rollback"/u)
  assert.match(audit, /session-audited/u)
  assert.match(audit, /sourceRestored=true/u)
  resetRetiredSessions()
})

test('v7.8: the rollback notice queue is ONE-SHOT and keyed per source', async () => {
  /**
   * THE PRIMITIVE, ASSERTED DIRECTLY.
   *
   * The delivery test above proves the notice reaches the model once. This proves the MECHANISM cannot
   * do otherwise: `takeRollbackNotice` is a TAKE, not a GET, and the queue is keyed by source id — so
   * two sessions that each rolled back get their own notice, and neither gets a second one.
   *
   * A `get`-style accessor here would be catastrophic in a subtle way: every step of the recovered
   * session would re-tell the model that a migration failed, and the model would keep apologising for
   * something that is already resolved.
   */
  const { ctx, log } = scaffold({ controller: { async prompt() { return { accepted: true } } } })
  await rollbackFailedIgnition(ctx, log.session.id, 'session-notice-q', 'no channel')
  assert.equal(takeRollbackNotice(log.session.id)?.content?.[0]?.text, ROLLBACK_NOTICE)
  assert.equal(takeRollbackNotice(log.session.id), undefined, 'the second take finds nothing')

  /**
   * PER SOURCE. A notice queued for session A must not be delivered to session B — the exact class of
   * bug the ignition routing tests pinned for admissions ("an admission for A does not mark B").
   */
  await rollbackFailedIgnition(ctx, log.session.id, 'session-notice-q2', 'no channel again')
  assert.equal(
    takeRollbackNotice('session-some-other-source'),
    undefined,
    'a notice is addressed to the session that rolled back, not to whoever asks next',
  )
  assert.equal(takeRollbackNotice(log.session.id), undefined, 'the doorbell has already been answered once')
  resetRetiredSessions()
})
