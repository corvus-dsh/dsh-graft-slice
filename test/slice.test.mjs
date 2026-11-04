import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildInjectionPlan,
  buildTape,
  extractSourceTemplate,
  extractToolResultText,
  locateBoundary,
} from '../index.js'
import { makeSourceLog, makeV3ToolResult } from './fake-harness.mjs'

test('phase 1: locates the last closed turn/end', () => {
  const log = makeSourceLog({ turns: 7 })
  const boundary = locateBoundary(log.events)
  const lastEnd = log.events.filter((event) => event.type === 'turn/end').at(-1)
  assert.equal(boundary.boundarySeq, lastEnd.seq)
  assert.equal(boundary.lastTurn, 7)
  assert.equal(boundary.turnCount, 7)
  assert.equal(boundary.lastTurnReason, 'completed')
})

test('phase 1: trims an open tail turn back to the last closed boundary', () => {
  const log = makeSourceLog({ turns: 3 })
  const lastClosedSeq = log.events.filter((e) => e.type === 'turn/end').at(-1).seq
  log.events.push({
    type: 'turn/start',
    seq: log.events.length,
    time: Date.now(),
    data: { turn: 4 },
  })
  // An in-turn caller can never close its own turn, so the open tail is
  // dropped instead of refusing the whole migration.
  const boundary = locateBoundary(log.events)
  assert.equal(boundary.boundarySeq, lastClosedSeq)
  assert.equal(boundary.lastTurn, 3)
  assert.equal(boundary.droppedOpenTurns, 1)
})

test('phase 1: allowOpenTail:false restores the strict refusal', () => {
  const log = makeSourceLog({ turns: 2 })
  log.events.push({ type: 'turn/start', seq: log.events.length, time: Date.now(), data: { turn: 3 } })
  assert.throws(() => locateBoundary(log.events, { allowOpenTail: false }), /OPEN_TURN/)
})

test('phase 1: refuses a log with no turn/end', () => {
  const log = makeSourceLog({ turns: 2 })
  const events = log.events.filter((event) => event.type !== 'turn/start' && event.type !== 'turn/end')
  assert.throws(() => locateBoundary(events), /NO_CLOSED_TURN/)
})

test('phase 1: refuses an unbalanced turn/start inside an open turn', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/start', seq: 1, data: { turn: 2 } },
  ]
  assert.throws(() => locateBoundary(events), /OPEN_TURN/)
})

test('phase 1: records a producer-owned source and drops replayState', () => {
  const log = makeSourceLog({ turns: 2 })
  const source = extractSourceTemplate(log.events)
  assert.deepEqual(source, {
    kind: 'model',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  assert.equal('replayState' in source, false)
})

test('phase 1: falls back to plugin:graft, never kind:plugin', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.deepEqual(extractSourceTemplate(events), {
    kind: 'plugin:graft',
    provider: 'unknown',
    model: 'unknown',
  })
})

test('phase 2: keeps an adaptive recent window, indexes older turns, embeds pointers', () => {
  const log = makeSourceLog({ turns: 7 })
  const plan = buildInjectionPlan(log, {})
  // v6.3: the window comes from the session's shape; this fixture is prose-only.
  assert.equal(plan.recentTurnCount, plan.adaptiveDepth.depth)
  assert.equal(plan.olderTurnCount, 7 - plan.recentTurnCount)
  // v7.0 P12: +1 for the trailing [可回读索引].
  assert.equal(plan.chunks.length, plan.recentTurnCount + 3)
  assert.equal(plan.chunks[0].kind, 'old-summary')
  // v7.0 A3: a compact index replaces the per-turn prose summary.
  assert.match(plan.chunks[0].text, /\[历史片段索引\]/)
  assert.match(plan.chunks[0].text, /\[历史片段: Turn 1-/)
  assert.match(plan.chunks[0].text, /graft_read_result/)
  assert.match(plan.chunks[0].text, /涉及工具: read_file/)
  assert.equal(plan.chunks[0].text.includes('[tool name=read_file seq='), false)
  assert.equal(plan.chunks[0].text.includes('expand_result('), false)
  // The index must not carry the old turn prose it replaced.
  assert.ok(plan.chunks[0].text.length < 400, `index stays tiny, got ${plan.chunks[0].text.length}`)
  assert.equal(plan.chunks.at(-1).kind, 'pending-state')
  // v6.2：优先用 todo；无 todo 时回退到经过噪声过滤的散文。
  // v0.20: the card is a task board, so the next action lives in the ⏭️ column
  // rather than in a "我接下来需要…" sentence.
  assert.match(plan.chunks.at(-1).text, /⏭️ 待开始/)
  assert.match(plan.chunks.at(-1).text, /继续推进，并验证结果/u)
  assert.equal(plan.chunks.at(-1).text.includes('当前假设：'), false)
  assert.equal(plan.chunks.at(-1).text.includes('已排除：'), false)
  assert.equal(plan.chunks.at(-1).text.includes('下一步：'), false)
  assert.match(plan.chunks.at(-1).text, /graft_read_result/)
  assert.equal(plan.pointerCount, 1)
  assert.equal(plan.olderPointerCount, 1)
  assert.deepEqual(plan.olderToolNames, ['read_file'])
  // v7.0 A4: the goal is the LATEST substantive user intent, not the opening
  // brief. This fixture's last real instruction is the turn-2 follow-up.
  assert.equal(plan.goal.includes('补上测试和冷恢复验证'), true)
  assert.equal(plan.goalSource, 'user')
  assert.equal(plan.cwd, log.session.cwd)

  const recent = plan.chunks.filter((chunk) => chunk.kind === 'recent-turn')
  // v6.3: the retained-turn count is adaptive; this fixture is prose-only, so
  // the generation profile keeps a shallow window.
  assert.equal(recent.length, plan.adaptiveDepth.depth)
  assert.equal(plan.adaptiveDepth.mode, 'generation')
  assert.equal(recent.some((chunk) => chunk.text.includes('- 记录：')), true)
  assert.equal(plan.chunks.some((chunk) => chunk.text.includes('SESSION API VERIFIED')), false)
})

test('phase 2: ignores assistant/chunk and assistant/attempt', () => {
  const log = makeSourceLog({ turns: 2 })
  const boundary = locateBoundary(log.events)
  const tape = buildTape(log.events, boundary, {})
  assert.equal(tape.turns.length, 2)
  assert.equal(tape.turns.some((turn) => turn.text.includes('partial')), false)
})

test('v7.0 P1: an over-budget turn is dropped whole and declared, never cut mid-sentence', () => {
  const log = makeSourceLog({ turns: 7 })
  const plan = buildInjectionPlan(log, { maxTurnChars: 80 })

  // v6.x truncated the middle of an oversized turn, leaving the user's ask and
  // the assistant's conclusion with the work missing between two ellipses and
  // no marker. What survives now is verbatim, and the loss is stated up front.
  const recent = plan.chunks.filter((chunk) => chunk.kind === 'recent-turn')
  assert.equal(recent.every((chunk) => chunk.truncated === false), true, 'kept turns are always whole')
  assert.equal(recent.some((chunk) => chunk.text.includes('graft truncated')), false, 'no mid-turn cuts')

  const omitted = plan.chunks.find((chunk) => chunk.kind === 'omitted-turns')
  assert.ok(omitted, 'dropped turns must be declared')
  // v0.23: the declaration is an XML element, not a bracket sentence. The old
  // `[已省略 Turn N…]` form put the cut INSIDE the tape text, where a strict consumer
  // (a JSON body, a fenced block) reads it as payload. The facts are the same; they
  // now live in attributes, which are inert to a parser.
  assert.match(omitted.text, /<omitted_turns\b/)
  assert.match(omitted.text, /span="Turn \d+-?\d*"/)
  assert.match(omitted.text, /recoverable="true"/)
  assert.match(omitted.text, /graft_read_result/)
  assert.match(omitted.text, /seq=\d+-\d+/)
  // ...and the element is balanced, so nothing after it can be mistaken for payload.
  assert.equal(omitted.text.includes('</omitted_turns>'), true, 'the element must close')
  // The declaration is placed before the surviving turns, not appended.
  assert.equal(plan.chunks[0].kind, 'omitted-turns')
  assert.equal(plan.warnings.some((warning) => warning.includes('dropped whole')), true)
})

test('phase 2: respects a total tape budget', () => {
  const log = makeSourceLog({ turns: 7 })
  const plan = buildInjectionPlan(log, { maxTotalChars: 500 })

  // The budget is honoured by dropping low-priority material, not by cutting
  // turns in half: recent turns stay whole and the pending state is protected.
  const recent = plan.chunks.filter((chunk) => chunk.kind === 'recent-turn')
  assert.equal(recent.every((chunk) => chunk.truncated === false), true, 'turns are never cut by the total budget')
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')
  assert.ok(pending, 'the pending state survives the budget')

  // Something below the turns was sacrificed, and it was declared.
  assert.equal(
    plan.warnings.some((warning) => warning.includes('budget') || warning.includes('dropped whole')),
    true,
  )
  // The irreducible floor (protected blocks + the declaration) may exceed a very
  // small budget; what must hold is that everything droppable was dropped.
  const nonProtected = plan.chunks.filter(
    (chunk) => !['pending-state', 'open-turn-carryover', 'omitted-turns'].includes(chunk.kind),
  )
  const droppable = nonProtected.reduce((sum, chunk) => sum + chunk.text.length, 0)
  assert.ok(droppable <= 500, `droppable material must fit the budget, got ${droppable}`)
})

test('phase 4 fallback: reads a v4 tool result message', () => {
  const log = makeSourceLog({ turns: 1 })
  const result = log.events.find((event) => event.type === 'tool/result')
  assert.equal(extractToolResultText(result), 'SESSION API VERIFIED: prepare/create/append/flush')
})

test('phase 4 fallback: reads a nested v3 tool-result block', () => {
  assert.equal(extractToolResultText(makeV3ToolResult()), 'v3 nested result')
})

test('phase 4 fallback: returns undefined for a non-result event', () => {
  assert.equal(extractToolResultText({ type: 'assistant/message', seq: 0, data: {} }), undefined)
})
