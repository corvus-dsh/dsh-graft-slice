/**
 * Does `locateBoundary()` lose the OPEN turn's content?
 *
 * `locateBoundary()` deliberately cuts the skeleton at the last closed
 * `turn/end`, so everything the running turn already produced is outside the
 * tape's turn range. That is not allowed to lose it: `buildInjectionPlan()`
 * must carry it in the `open-turn-carryover` chunk (injected first).
 *
 * The regression these tests pin down: the carryover chunk was emitted only
 * when the open turn had tool pointers or assistant narration. An open turn
 * that contains ONLY the user's instruction — the watermark fired just after
 * the user sent the decision, before the model answered — was extracted and
 * then thrown away. That is the most expensive shape to lose: the target
 * cannot even know what the current round is about.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInjectionPlan, buildTape, locateBoundary } from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

const USER_ONLY = '新决策：不要重跑测试，先核对 SOURCE_DRIFT 的来源。ANCHOR-USER-ONLY。'
const NARRATION = '我正在核对 commit 的边界比对逻辑。'

function push(log, type, data, surfaceOp) {
  const seq = log.events.at(-1).seq + 1
  log.events.push({
    type,
    seq,
    time: 1_900_000_000_000 + seq,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  })
  return seq
}

/** turn/start + step/start + the user's message; the model has not answered yet. */
function appendUserOnlyOpenTurn(log, { turn, text }) {
  push(log, 'turn/start', { turn })
  push(log, 'step/start', { turn, step: 1 })
  push(
    log,
    'user/message',
    {
      id: `user-open-${turn}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    'append',
  )
  return log
}

/** A worked step: narration + a completed tool call. */
function appendWorkedOpenTurn(log, { turn, text, narration }) {
  push(log, 'turn/start', { turn })
  push(log, 'step/start', { turn, step: 1 })
  push(
    log,
    'user/message',
    {
      id: `user-open-${turn}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    'append',
  )
  const callId = `call-open-${turn}`
  push(log, 'assistant/message', {
    turn,
    step: 1,
    message: {
      id: `assistant-open-${turn}`,
      role: 'assistant',
      content: [
        { type: 'text', text: narration },
        { type: 'tool-call', id: callId, name: 'pwsh', arguments: '{"command":"node --test"}' },
      ],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    },
  })
  const callSeq = push(log, 'tool/call', {
    turn,
    step: 1,
    callId,
    name: 'pwsh',
    arguments: '{"command":"node --test"}',
  })
  const resultSeq = push(log, 'tool/result', {
    turn,
    step: 1,
    message: {
      toolCallId: callId,
      content: [{ type: 'text', text: '18 tests pass' }],
      isError: false,
      source: { kind: 'tool' },
    },
  })
  return { callSeq, resultSeq }
}

test('locateBoundary: an open turn moves the cut back, and the input is not mutated', () => {
  const log = makeSourceLog({ turns: 3 })
  const closedEnd = log.events.filter((event) => event.type === 'turn/end').at(-1)
  appendUserOnlyOpenTurn(log, { turn: 4, text: USER_ONLY })
  const before = log.events.length

  const boundary = locateBoundary(log.events)

  assert.equal(boundary.boundarySeq, closedEnd.seq, 'the skeleton must stay on the last closed turn')
  assert.equal(boundary.lastTurn, 3)
  assert.equal(boundary.droppedOpenTurns, 1)
  // The important part: dropping it from the SKELETON is not the same as
  // deleting it from the log. `buildInjectionPlan` still sees every event.
  assert.equal(log.events.length, before, 'locateBoundary must be read-only')
  assert.ok(log.events.some((event) => event.seq > boundary.boundarySeq && event.type === 'user/message'))
})

test('the skeleton excludes the open turn, by design', () => {
  const log = makeSourceLog({ turns: 3 })
  appendUserOnlyOpenTurn(log, { turn: 4, text: USER_ONLY })
  const boundary = locateBoundary(log.events)
  const tape = buildTape(log.events, boundary, {})

  assert.equal(tape.turns.at(-1)?.turn, 3, 'the skeleton can only replay closed turns')
  assert.ok(!tape.turns.some((turn) => turn.turn === 4))
})

test('buildInjectionPlan: an open turn holding ONLY the user instruction is still carried', () => {
  const log = makeSourceLog({ turns: 3 })
  appendUserOnlyOpenTurn(log, { turn: 4, text: USER_ONLY })

  const plan = buildInjectionPlan(log, {})

  assert.equal(plan.chunks[0]?.kind, 'open-turn-carryover', `first chunk was ${plan.chunks[0]?.kind}`)
  assert.match(plan.chunks[0].text, /Turn 4 · 进行中/u)
  assert.ok(
    plan.chunks[0].text.includes(USER_ONLY),
    'the user instruction that opened the running turn must survive verbatim; ' +
      'without it the target re-reads the previous round as "the task"',
  )
})

test('v0.19: a worked open turn keeps the INSTRUCTION; narration and pointers are dropped', () => {
  const log = makeSourceLog({ turns: 3 })
  const { resultSeq } = appendWorkedOpenTurn(log, { turn: 4, text: USER_ONLY, narration: NARRATION })

  const plan = buildInjectionPlan(log, {})
  const carry = plan.chunks.find((chunk) => chunk.kind === 'open-turn-carryover')

  assert.ok(carry, 'the open turn must produce a carryover chunk')
  assert.equal(plan.chunks[0].kind, 'open-turn-carryover', 'the breakpoint is injected first')
  assert.ok(carry.text.includes(USER_ONLY), 'user instruction survives')
  // v0.19: the narration is a work log — dropped, and the drop is declared.
  assert.ok(!carry.text.includes(NARRATION), 'narration no longer travels')
  assert.match(carry.text, /已按语义瘦身/u)
  // The result is still reachable: by seq inside the read-back index.
  assert.ok(
    JSON.stringify(plan.chunks).includes(`seq=${resultSeq}`) ||
      JSON.stringify(plan.chunks).includes(String(resultSeq)),
    'the completed tool result stays reachable by seq',
  )
})

test('buildInjectionPlan: no open turn, no invented carryover', () => {
  const log = makeSourceLog({ turns: 3 })
  const plan = buildInjectionPlan(log, {})
  assert.ok(!plan.chunks.some((chunk) => chunk.kind === 'open-turn-carryover'))
})