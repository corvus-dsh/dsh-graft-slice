/**
 * v7.9: the nudge is advisory, not decorative.
 *
 * v7.6 told the model at 70% "you may hand over yourself" and left the 75%
 * cutoff as the fallback. Measured failure: a model that ignores the nudge keeps
 * issuing tool calls, so the cut lands mid-write and the target reads a forced
 * stop as a planned handover. Three behaviours now separate the two cases:
 *
 *   1. ignored nudge → ONE hard instruction ("水位告急…切走") at the next step;
 *   2. a graft_* call after the nudge is OBEDIENCE, not refusal — no accusation;
 *   3. a forced cut records the refusal in the target's pending state.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, getTransferredSessions, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

const NUDGE = /当前上下文水位已达 \d+%/u
const URGENT = /水位告急/u
const FORCED = /模型拒绝提前切走/u
const USER_TURN = '继续推进实现，先把这一轮写完。'

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
    // v0.18: the escalation chain is a MECHANISM test at the historical ratios;
    // the derived-ratio behaviour has its own file (v018-watermark).
    watermarkMode: 'fixed',
    retireSource: true,
    verifyReadBack: true,
  })
  return { log, ctx }
}

function payloadFor(log, turn = 1, step = 1) {
  return {
    agent: { id: log.session.id },
    turn,
    step,
    messages: [{ role: 'user', content: [{ type: 'text', text: USER_TURN }] }],
  }
}

function textsOf(decision) {
  return (decision?.messages ?? [])
    .flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
}

/** Append an event to the live fixture log (snapshotEvents reads this array). */
function appendEvent(log, type, data) {
  const event = { type, seq: log.events.length, time: Date.now(), data }
  log.events.push(event)
  return event
}

test('v7.9: after the 70% nudge, one more step gets ONE hard handover instruction', async () => {
  const { log, ctx } = setup()
  const first = await dispatchPreStep(ctx, payloadFor(log, 1, 1))
  assert.match(textsOf(first).join('\n'), NUDGE, 'the nudge must fire first')
  assert.doesNotMatch(textsOf(first).join('\n'), URGENT, 'no accusation in the same step as the nudge')

  const second = await dispatchPreStep(ctx, payloadFor(log, 1, 2))
  assert.equal(second.kind, 'enter', 'the instruction is injected, not a rejection')
  const joined = textsOf(second).join('\n')
  assert.match(joined, URGENT)
  assert.match(joined, /graft_prepare/u)
  assert.match(joined, /graft_slice_and_inject/u)

  const third = await dispatchPreStep(ctx, payloadFor(log, 1, 3))
  assert.doesNotMatch(textsOf(third).join('\n'), URGENT, 'once, not every step')
})

test('v7.9: a graft_* call after the nudge counts as obedience, not refusal', async () => {
  const { log, ctx } = setup()
  await dispatchPreStep(ctx, payloadFor(log, 1, 1))
  // The model did what the nudge asked: it called graft_prepare.
  appendEvent(log, 'tool/call', { turn: 1, step: 1, callId: 'graft-call', name: 'graft_prepare', arguments: '{}' })
  const next = await dispatchPreStep(ctx, payloadFor(log, 1, 2))
  assert.doesNotMatch(textsOf(next).join('\n'), URGENT, 'do not accuse a session that is already handing over')
})

test('v7.9: an ignored nudge that hits the hard cutoff marks the target as force-cut', async () => {
  const { log, ctx } = setup()
  const nudged = await dispatchPreStep(ctx, payloadFor(log, 1, 1))
  assert.match(textsOf(nudged).join('\n'), NUDGE)

  // The model kept working and the context grew past 75%: 2000 / 2600 ≈ 77%.
  appendEvent(log, 'assistant/message', { usage: { inputTokens: 2000, outputTokens: 80, totalTokens: 2080 } })

  const cut = await dispatchPreStep(ctx, payloadFor(log, 2, 1))
  assert.equal(cut.kind, 'reject', 'the hard cutoff still stops the step')
  assert.match(cut.reason, /已自动迁移/u)
  const targetId = getTransferredSessions().get(log.session.id)?.newSessionId
  assert.ok(targetId, 'a target must have been created')

  const stored = JSON.stringify(ctx._persistence.read(targetId))
  assert.match(stored, FORCED, 'the target must know the interruption was forced')
  assert.match(stored, /75%|77%/u, 'and at what watermark')
})

test('v7.9: a planned self-slice never carries the forced-cut mark', async () => {
  const { log, ctx } = setup()
  await dispatchPreStep(ctx, payloadFor(log, 1, 1))
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-planned-slice' }, {})
  assert.equal(report.ok, true, `graft failed: ${JSON.stringify(report.warnings ?? report)}`)
  const stored = JSON.stringify(ctx._persistence.read('session-planned-slice'))
  assert.doesNotMatch(stored, FORCED, 'a handover the model performed itself is not a forced cut')
})