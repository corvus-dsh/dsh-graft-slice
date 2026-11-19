/**
 * ── v265 (B4-0b-2 W0-2b): 「送达」 is not 「仍知情」 ──────────────────────────────────────────────
 *
 * W0-2's third layer made the forced cut say whether a nudge had been DELIVERED. That fixed the silent
 * case (no nudge ⇒ say so). It left the opposite one: a compaction or restore between the nudge and the
 * cut can remove the nudge from the context, and the sentence still read
 *
 *     预警已送达（52%），本代继续调用工具后在 80% 水位被强制中断
 *
 * which invites the reader to conclude 「模型被告知了却继续」 — a claim about what the model still KNEW,
 * which this process cannot observe. 送达 is a fact about this process; 知情 is not.
 *
 * The dispatch allows either repair (clear the record on reset, or add a third state). This
 * implementation picks the THIRD STATE and the reason is worth stating: clearing the record would
 * delete a delivery that really happened and make the handoff say 「未经预警」 — which is also false.
 * Keeping both facts lets the sentence say "delivered, and afterwards the context was reset (so that
 * warning may no longer be in it)". Both halves are observable; neither is a guess.
 *
 * ── THE JUDGEMENT ─────────────────────────────────────────────────────────────────────────────
 *
 *   ① nudge → reset event → forced cut ⇒ the sentence CONTAINS 「此后上下文被重置」 (and still says the
 *     nudge was delivered — the two are not exclusive);
 *   ② nudge → forced cut with NO reset ⇒ the sentence is byte-identical to W0-2's (no clause appears);
 *   ③ a reset with NO prior nudge ⇒ still 「未经预警」, i.e. the reset must not manufacture a delivery.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, getTransferredSessions, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

const NUDGE = /当前上下文水位已达 \d+%/u
const FORCED_WARNED = /预警已送达（\d+%）/u
const RESET_CLAUSE = /此后上下文被重置/u
const FORCED_UNANNOUNCED = /未经预警的强制中断/u

function setup({ window = 2600 } = {}) {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 7 })
  const ctx = makeCtx({ sourceLog: log, currentAgentId: log.session.id })
  apply(ctx, {
    autoGraft: true,
    autoGraftAtRatio: 0.75,
    modelDrivenGraft: true,
    modelDrivenGraftAtRatio: 0.7,
    contextWindowTokens: window,
    watermarkMode: 'fixed',
    retireSource: true,
    verifyReadBack: true,
  })
  return { log, ctx }
}

const payloadFor = (log, turn, step = 1) => ({
  agent: { id: log.session.id },
  turn,
  step,
  messages: [{ role: 'user', content: [{ type: 'text', text: '继续推进实现。' }] }],
})

const textsOf = (decision) =>
  (decision?.messages ?? [])
    .flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)

function appendEvent(log, type, data) {
  const event = { type, seq: log.events.length, time: Date.now(), data }
  log.events.push(event)
  return event
}

function textsIn(stored) {
  const out = []
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (typeof node.text === 'string') out.push(node.text)
    for (const value of Object.values(node)) walk(value)
  }
  walk(typeof stored === 'string' ? JSON.parse(stored) : stored)
  return out
}

/** Drive the nudge, then a context reset, then a giant step past the cutoff. */
async function nudgeResetThenCut({ reset = true } = {}) {
  const { log, ctx } = setup()
  const nudged = await dispatchPreStep(ctx, payloadFor(log, 1, 1))
  assert.match(textsOf(nudged).join('\n'), NUDGE, 'the nudge must fire first, or this test proves nothing')
  if (reset) {
    appendEvent(log, 'compaction/end', { compactionId: 'c-1', removedSeqs: [] })
  }
  appendEvent(log, 'assistant/message', { usage: { inputTokens: 2000, outputTokens: 80, totalTokens: 2080 } })
  const cut = await dispatchPreStep(ctx, payloadFor(log, 2, 1))
  assert.equal(cut.kind, 'reject', 'the hard cutoff must still stop the step')
  const targetId = getTransferredSessions().get(log.session.id)?.newSessionId
  assert.ok(targetId, 'a target must have been created')
  return textsIn(ctx._persistence.read(targetId))
}

test('v265 ①: nudge → reset → cut says the warning was delivered AND that the context was reset', async () => {
  const texts = await nudgeResetThenCut({ reset: true })
  const note = texts.find((text) => FORCED_WARNED.test(text))
  assert.ok(note, `the delivery fact must survive a reset; got:\n${texts.join('\n').slice(0, 800)}`)
  assert.match(note, RESET_CLAUSE, `and the reset must be stated; got: ${note}`)
  /**
   * Both halves, on purpose: the delivery happened (so 「未经预警」 would be a lie) and the awareness is
   * unknowable (so silence about the reset would be a different lie).
   */
  assert.doesNotMatch(note, FORCED_UNANNOUNCED, 'a delivery that happened must not be denied')
})

test('v265 ②: nudge → cut with NO reset is byte-identical to W0-2 (no clause leaks in)', async () => {
  const texts = await nudgeResetThenCut({ reset: false })
  const note = texts.find((text) => FORCED_WARNED.test(text))
  assert.ok(note, `the delivery sentence must still appear; got:\n${texts.join('\n').slice(0, 800)}`)
  assert.doesNotMatch(note, RESET_CLAUSE, `no reset happened, so no reset clause; got: ${note}`)
})

test('v265 ③: a reset with NO prior nudge does not manufacture a delivery', async () => {
  /**
   * The control that keeps ① from being "any reset ⇒ talk about resets". With no nudge ever delivered,
   * the sentence must remain 「未经预警」 even though a reset event exists.
   */
  const { log, ctx } = setup({ window: 10_000 })
  const first = await dispatchPreStep(ctx, payloadFor(log, 1, 1))
  assert.doesNotMatch(textsOf(first).join('\n'), NUDGE, '19% of the window: no nudge')
  appendEvent(log, 'compaction/end', { compactionId: 'c-2', removedSeqs: [] })
  appendEvent(log, 'assistant/message', { usage: { inputTokens: 8000, outputTokens: 80, totalTokens: 8080 } })
  const cut = await dispatchPreStep(ctx, payloadFor(log, 2, 1))
  assert.equal(cut.kind, 'reject')
  const targetId = getTransferredSessions().get(log.session.id)?.newSessionId
  const texts = textsIn(ctx._persistence.read(targetId))
  const note = texts.find((text) => FORCED_UNANNOUNCED.test(text))
  assert.ok(note, `the unannounced sentence must appear; got:\n${texts.join('\n').slice(0, 800)}`)
  assert.doesNotMatch(note, RESET_CLAUSE, 'and it must not borrow the reset clause from ①')
})

test('v265 ④: the debug panel distinguishes 「delivered」 from 「delivered then reset」', async () => {
  /**
   * W0-2's §12.2 layer 4 rule: 「哑了」 and 「不需要」 must be distinguishable from the panel. The same rule
   * applies to the two delivery states — a panel printing only `nudgeDeliveredAt` makes them identical.
   *
   * ── THE SAME TURN, ON PURPOSE ──────────────────────────────────────────────────────────────────
   *
   * The second pre-step uses the SAME turn as the nudge, so `modelDrivenNudgeTurns` suppresses a second
   * delivery. That is the only way to observe 「delivered, then reset」 from the panel: on a NEW turn the
   * session is told again, which correctly re-establishes awareness and clears the flag. The first draft
   * used `payloadFor(log, 2)` and failed for exactly that reason — a test that mistook correct behaviour
   * for a missing feature.
   *
   * The reading lives at `status.nudge` (sibling of `status.watermark`), measured rather than guessed.
   */
  const { log, ctx } = setup()
  await dispatchPreStep(ctx, payloadFor(log, 1, 1))
  const before = await ctx._tools.get('graft_debug_status').execute({ section: 'watermark' }, { agent: { id: log.session.id } })
  assert.equal(before?.nudge?.nudgeDeliveredAt !== undefined, true, `delivery must be reported; got ${JSON.stringify(before?.nudge)}`)
  assert.equal(before?.nudge?.nudgeResetAfterDelivery, undefined, 'and no reset flag yet')

  appendEvent(log, 'compaction/end', { compactionId: 'c-3', removedSeqs: [] })
  /** Same turn, next step: no second nudge, but the predictor now sees the reset. */
  await dispatchPreStep(ctx, payloadFor(log, 1, 2))
  const after = await ctx._tools.get('graft_debug_status').execute({ section: 'watermark' }, { agent: { id: log.session.id } })
  assert.equal(after?.nudge?.nudgeResetAfterDelivery, true, `the reset must be visible; got ${JSON.stringify(after?.nudge)}`)
})
