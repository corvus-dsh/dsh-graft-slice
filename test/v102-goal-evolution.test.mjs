/**
 * v1.0.2 — GOAL EVOLUTION.
 *
 * The failure this pins down: a handoff chain re-seeded the ask that STARTED it, forever.
 * A target that legitimately narrowed or redirected the work ("先修 P0" → "现在做发布")
 * was read as drift, and the next generation was dragged back to a goal nobody wanted.
 *
 * "Never evolve" is not "never drift". The original ask stays on the board as the audit
 * trail; `currentGoal` is what the target acts on; every change is appended to
 * `goal_evolution` so the next generation can SEE the movement instead of inheriting
 * whatever the previous one happened to believe.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, renderInstructionCard, renderTaskBoard } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

const board = (extra) =>
  renderTaskBoard({
    request: '修 P0：切片写入失败',
    pending: ['跑真机切片'],
    stopPoint: { boundarySeq: 853 },
    pointerCount: 3,
    discarded: { dropped: [] },
    ...extra,
  })

test('v1.0.2 board: the goal in force is printed NEXT TO the ask it started from', () => {
  const text = board({ currentGoal: '把 v1.0.2 发出去', goalRevisions: 2 })
  assert.match(text, /\*\*原始用户要求\*\*：修 P0/u, 'the original ask stays: it is the audit trail')
  assert.match(text, /\*\*当前目标\*\*：把 v1\.0\.2 发出去/u, 'and the goal in force is what the target does')
  assert.match(text, /目标曾发生过 2 次演进/u, 'the count is stated, not implied')
  assert.match(text, /goal_evolution/u, 'and it says where the trail lives')
})

test('v1.0.2 board: an un-evolved goal is not duplicated', () => {
  const text = board({ currentGoal: '修 P0：切片写入失败', goalRevisions: 0 })
  assert.doesNotMatch(text, /\*\*当前目标\*\*/u, 'same goal = one line, not two')
  assert.doesNotMatch(text, /次演进/u, 'and no false evolution note')
})

test('v1.0.2 board: the count survives even when the text is identical', () => {
  // A goal can be rewritten to the same words with a new reason; the count must still show.
  const text = board({ currentGoal: '修 P0：切片写入失败', goalRevisions: 1 })
  assert.match(text, /目标曾发生过 1 次演进/u)
})

test('v1.0.2 card: the renderer passes the evolved goal through', () => {
  const text = renderInstructionCard({
    semantic: { outcome: undefined, unresolvedError: undefined, discarded: { dropped: [] } },
    body: '我接下来需要继续推进。',
    stopPoint: { boundarySeq: 12 },
    pointerCount: 1,
    request: '修 P0：切片写入失败',
    pending: [],
    currentGoal: '把 UI 修好',
    goalRevisions: 3,
  })
  assert.match(text, /当前目标/u)
  assert.match(text, /目标曾发生过 3 次演进/u)
})

test('v1.0.2 tool: graft_update_goal refuses a session that was never sliced', async () => {
  const log = makeSourceLog({ turns: 2, sourceSessionId: 'session-goal-plain', cwd: 'D:\\goal-ws' })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  const tool = ctx._tools.get('graft_update_goal')
  assert.ok(tool !== undefined, 'the tool is registered')

  const result = await tool.execute(
    { goal: '做点别的', reason: '测试' },
    { agent: { id: log.session.id }, callId: 'g1', name: 'graft_update_goal', arguments: {}, signal: undefined },
  )
  assert.equal(result.ok, false)
  assert.match(String(result.error), /no graft goal record/u, 'a non-target session has nothing to rewrite')
})

test('v1.0.2 tool: an empty goal is refused, never written', async () => {
  const log = makeSourceLog({ turns: 2, sourceSessionId: 'session-goal-empty', cwd: 'D:\\goal-ws' })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  const tool = ctx._tools.get('graft_update_goal')
  const result = await tool.execute(
    { goal: '   ' },
    { agent: { id: log.session.id }, callId: 'g2', name: 'graft_update_goal', arguments: {}, signal: undefined },
  )
  assert.equal(result.ok, false)
  assert.match(String(result.error), /non-empty/u)
})
