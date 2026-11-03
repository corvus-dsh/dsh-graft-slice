/**
 * v7.4 P0-3b: the breakpoint beats the state — including when the breakpoint is
 * still an OPEN turn.
 *
 * THE INCIDENT THIS ENCODES
 *
 * A 41-turn session hit the 75% watermark in the middle of an implementation
 * round. The graft ran at turn-stopping, one event before `turn/end` was
 * appended, and `autoGraftIfNeeded` cut the snapshot at the last turn/end it
 * could see. That boundary was the END OF THE PREVIOUS ROUND, so the whole
 * in-flight round — the user's decisions, 83 steps of work, the failing tests
 * being fixed — was dropped from the tape with no trace. The target then read
 * the round before it as "the task" and redid work that already existed on
 * disk.
 *
 * `extractOpenTurnCarryover` (v7.0 B1) was built for exactly this case and was
 * dead code in practice: the pre-truncation emptied the tail it reads.
 *
 * So: `locateBoundary` may still cut the skeleton at the last CLOSED turn, but
 * the open turn must ride along, and it must be injected FIRST.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  buildInjectionPlan,
  getTransferredSessions,
  resetRetiredSessions,
} from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

const ANCHOR = '决策 1：回顾句采用方案 B。断点锚点 ANCHOR-BREAKPOINT-41。'
const NARRATION = '现在重写 P0-1a 测试，反映「先校验后落盘」的真正保证。'

function appendOpenTurn(log, { turn, userText, narration, toolName = 'pwsh' }) {
  let seq = log.events.at(-1).seq + 1
  const push = (type, data, surfaceOp) => {
    log.events.push({
      type,
      seq: seq++,
      time: 1_900_000_000_000 + seq,
      data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    })
  }
  const callId = `call-open-${turn}`

  push('turn/start', { turn })
  push('step/start', { turn, step: 1 })
  push(
    'user/message',
    {
      id: `user-open-${turn}`,
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    },
    'append',
  )
  push(
    'assistant/message',
    {
      turn,
      step: 1,
      message: {
        id: `assistant-open-${turn}`,
        role: 'assistant',
        content: [
          { type: 'text', text: narration },
          { type: 'tool-call', id: callId, name: toolName, arguments: '{"command":"node --test"}' },
        ],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      },
      usage: { inputTokens: 4000, outputTokens: 90, totalTokens: 4090 },
    },
    'append',
  )
  push('tool/call', { turn, step: 1, callId, name: toolName, arguments: '{"command":"node --test"}' })
  push('tool/result', {
    turn,
    step: 1,
    message: {
      toolCallId: callId,
      content: [{ type: 'text', text: '209 tests pass' }],
      isError: false,
      source: { kind: 'tool' },
    },
  })
  // No turn/end: this is the in-flight round, cut by the watermark.
  return log
}

test('v7.4 P0-3b / v0.19: an open turn is injected FIRST, with the user’s own words', () => {
  const log = makeSourceLog({ turns: 3 })
  appendOpenTurn(log, { turn: 4, userText: ANCHOR, narration: NARRATION })

  const plan = buildInjectionPlan(log, {})
  assert.equal(plan.chunks[0]?.kind, 'open-turn-carryover', `first chunk was ${plan.chunks[0]?.kind}`)
  assert.match(plan.chunks[0].text, /Turn 4 · 进行中/u)
  assert.ok(plan.chunks[0].text.includes(ANCHOR), 'the user’s instruction must survive verbatim')
  // v0.19: the narration of the in-flight round is history. It is dropped, and the
  // drop is declared in the same chunk instead of being carried into the new window.
  assert.ok(!plan.chunks[0].text.includes(NARRATION), 'the work log does not travel')
  assert.match(plan.chunks[0].text, /已按语义瘦身/u)
  assert.match(plan.chunks[0].text, /字符中间叙述/u)
})

test('v7.4 P0-3b: without an open turn nothing is invented', () => {
  const log = makeSourceLog({ turns: 3 })
  const plan = buildInjectionPlan(log, {})
  assert.ok(!plan.chunks.some((chunk) => chunk.kind === 'open-turn-carryover'))
})

test('v7.4 P0-3b: auto-graft keeps the in-flight round, not the previous one', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 7 })
  appendOpenTurn(log, { turn: 8, userText: ANCHOR, narration: NARRATION })

  const ctx = makeCtx({ sourceLog: log, currentAgentId: log.session.id })
  apply(ctx, {
    autoGraft: true,
    autoGraftAtRatio: 0.75,
    contextWindowTokens: 500,
    recentTurns: 2,
    retireSource: true,
    verifyReadBack: true,
  })

  await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  await new Promise((resolve) => setTimeout(resolve, 2600))

  const transfer = getTransferredSessions().get(log.session.id)
  assert.ok(transfer, 'the watermark should have fired')
  const stored = ctx._persistence.read(transfer.newSessionId)
  const dump = JSON.stringify(stored)

  assert.ok(
    dump.includes('ANCHOR-BREAKPOINT-41'),
    'the in-flight round must survive the graft; losing it is the bug this test exists for',
  )
  // v0.19: the narration is NOT carried any more — but its coordinates are, so the
  // work log is one graft_read_result away rather than gone.
  assert.ok(!dump.includes(NARRATION), 'the work log stays in the old log, reachable by seq')
  assert.match(dump, /本轮过程指针：seq=/u, 'the open turn keeps its pointer coordinates')
})