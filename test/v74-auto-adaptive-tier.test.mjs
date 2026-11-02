/**
 * v7.4 (decision 2): `autoAdaptiveTier` — let the TASK STATE pick the replay tier.
 *
 * WHY IT EXISTS
 *
 * `adaptiveDepth` reads the SHAPE of recent turns (tool density, error ratio, code
 * ratio). That answers "what kind of conversation is this". It does not answer
 * "is the work at a clean stopping point", and that second question is the one
 * that decides whether the last turn's METHOD is worth replaying.
 *
 * MEASURED (this project, same source session, same instruction, same model)
 *
 *   A tier, 0 turns: 42 steps · 19 file reads · 0 `plugin_manager` calls · 173,714 tokens
 *   B tier, 1 turn :  9 steps ·  1 file read  · 3 `plugin_manager` calls ·  80,571 tokens
 *
 * The replayed turn carried "I verified with plugin_manager"; that single fact
 * removed almost all of the rediscovery. But when the work IS at a clean stop, the
 * same turn is pure cost — the read-back index already holds every pointer.
 *
 * DEFAULT: false. The rule rests on one paired observation, not a distribution, so
 * the operator opts in and the plugin does not decide on that little evidence.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInjectionPlan, normalizeConfig } from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

/** A log with an OPEN todo, which is the "unfinished work" signal. */
function logWithOpenTodo() {
  const log = makeSourceLog({ turns: 4 })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: {
      turn: 3,
      step: 1,
      callId: 'todo-1',
      name: 'todo_write',
      arguments: JSON.stringify({
        todos: [
          { content: '已完成的事', status: 'completed' },
          { content: '还没做完的事', status: 'pending' },
        ],
      }),
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  return log
}

/** A log whose todos are all complete and whose last call succeeded. */
function logAtCleanStop() {
  const log = makeSourceLog({ turns: 4 })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: {
      turn: 3,
      step: 1,
      callId: 'todo-1',
      name: 'todo_write',
      arguments: JSON.stringify({ todos: [{ content: '全部完成', status: 'completed' }] }),
    },
  })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 4, step: 1, callId: 'c-ok', name: 'pwsh', arguments: '{}' },
  })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 4,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'c-ok' },
        toolCallId: 'c-ok',
        content: [{ type: 'text', text: 'All tests passed (3 assertions)' }],
      },
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  return log
}

test('v7.4: autoAdaptiveTier defaults to false', () => {
  const settings = normalizeConfig({})
  assert.equal(settings.autoAdaptiveTier, false, 'the rule is opt-in, not default')
})

test('v7.4: disabled means the configured recentTurns still decides', () => {
  const log = logWithOpenTodo()
  const plan = buildInjectionPlan(log, { recentTurns: 3, adaptiveDepth: false })
  assert.equal(plan.recentTurnCount, 3, 'the open todo must NOT change the depth while the switch is off')
  assert.equal('adaptiveTier' in plan, false, 'no tier decision is reported when the feature is off')
})

test('v7.4: enabled + an open todo → tier B (one turn, for the method)', () => {
  const log = logWithOpenTodo()
  const plan = buildInjectionPlan(log, {
    recentTurns: 5,
    adaptiveDepth: false,
    autoAdaptiveTier: true,
  })
  assert.ok(plan.adaptiveTier, 'the decision must be reported')
  assert.equal(plan.adaptiveTier.tier, 'B')
  assert.equal(plan.adaptiveTier.depth, 1)
  // The override beats the configured 5, which is the whole point.
  assert.equal(plan.recentTurnCount, 1)
  assert.match(plan.adaptiveTier.reason, /unfinished work/u)
})

test('v7.4: enabled + a clean stop → tier A (nothing replayed)', () => {
  const log = logAtCleanStop()
  const plan = buildInjectionPlan(log, {
    recentTurns: 5,
    adaptiveDepth: false,
    autoAdaptiveTier: true,
  })
  assert.ok(plan.adaptiveTier)
  assert.equal(plan.adaptiveTier.tier, 'A')
  assert.equal(plan.adaptiveTier.depth, 0)
  assert.equal(plan.recentTurnCount, 0)
  assert.equal(plan.recentInjectedCount, 0, 'tier A really replays nothing')
  assert.match(plan.adaptiveTier.reason, /clean stopping point/u)
})

test('v7.4: enabled + a failed last call → tier B', () => {
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 3, step: 1, callId: 'f1', name: 'pwsh', arguments: '{}' },
  })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 3,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'f1' },
        toolCallId: 'f1',
        isError: true,
        content: [{ type: 'text', text: 'AssertionError: expected 1 to equal 2' }],
      },
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const plan = buildInjectionPlan(log, {
    recentTurns: 4,
    adaptiveDepth: false,
    autoAdaptiveTier: true,
  })
  assert.equal(plan.adaptiveTier.tier, 'B')
  assert.match(plan.adaptiveTier.reason, /last tool call failed/u)
})

test('v7.4: the tier decision overrides adaptiveDepth when both are on', () => {
  // adaptiveDepth would otherwise pick from conversation shape; the explicit,
  // task-derived rule wins because it is opt-in and answers a different question.
  const log = logWithOpenTodo()
  const plan = buildInjectionPlan(log, {
    recentTurns: 2,
    adaptiveDepth: true,
    autoAdaptiveTier: true,
  })
  assert.ok(plan.adaptiveTier)
  assert.equal(plan.adaptiveTier.tier, 'B')
  assert.equal(plan.recentTurnCount, 1, 'the tier, not adaptiveDepth, chose the depth')
})