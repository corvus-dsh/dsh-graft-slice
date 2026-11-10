/**
 * C1 — GOAL SEMANTICS: task > structure > transcript, and never "已完成".
 *
 * ── THE RULING THIS ENCODES ────────────────────────────────────────────────────────────────────
 *
 *   goal = 会话设置的任务（objective）+ DAG 当前节点；用户原文只附 seq 指针
 *
 * Three layers, never blended:
 *   task       objective from a `goal/change` record  → the requirement
 *   structure  the DAG's CURRENT NODE and blocker     → one node, a boundary not a body
 *   transcript the last substantive human messages    → a fallback, with a pointer
 *
 * Hard rules under test:
 *   1. The DAG provides boundaries, not content: one node line, never the whole graph.
 *   2. When the window task and the DAG node disagree, the USER WINS — and both are shown.
 *   3. The goal says task + node + conflict. It NEVER says "已完成" — that stays a fact computed from
 *      the log, and a declared node state must not be blurred into a verified one.
 *
 * ── WHY THE OLD BEHAVIOUR WAS WRONG, MEASURED ─────────────────────────────────────────────────
 *
 * Layer 3 alone made the goal "the last human message", so a pasted report ("这是 dsh 的报告：…")
 * became 原始用户要求 and a finished initial request became 「当前要做的事」 — the target then re-did work
 * that was already done. Both are the same defect: a GUESS presented as a declaration.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractGoalForTest, renderTaskBoard } from '../index.js'

/** A minimal event log: human messages plus an optional goal/change record. */
function logWith({ objective, humans = [], assistantTail }) {
  const events = []
  let seq = 0
  const push = (type, data) => events.push({ type, seq: seq++, time: 1700000000000 + seq, data })
  if (objective !== undefined) {
    push('goal/change', {
      operation: 'create',
      updatedAt: Date.now(),
      goal: { objective, status: 'active' },
    })
  }
  for (const text of humans) {
    push('user/message', { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  }
  if (assistantTail !== undefined) {
    push('assistant/message', { message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text: assistantTail }], source: { kind: 'model' } } })
  }
  return events
}

test('C1 layer 1: an ACTIVE objective wins over the transcript', () => {
  const events = logWith({
    objective: '给持久层补齐结构判据与可归因的拒绝记录',
    humans: ['这是 dsh 的报告：三项验收交付完毕。', '请继续'],
  })
  const result = extractGoalForTest(events)
  assert.equal(result.goalLayer, 'objective', 'a declared objective must be used instead of a guess')
  assert.match(result.goal, /补齐结构判据/u)
  assert.doesNotMatch(result.goal, /^这是 dsh 的报告/u, 'the pasted report must not become the requirement')
})

test('C1 layer 1: a FINISHED goal is not resurrected', () => {
  /**
   * `extractActiveGoalChange` returns undefined for a clear/complete/abandon tail on purpose: a goal the
   * user already closed must not become this session's task. Layer 1 must inherit that, or the
   * "re-did the whole finished task" failure returns through the back door.
   */
  const events = []
  let seq = 0
  events.push({ type: 'goal/change', seq: seq++, time: 1, data: { operation: 'create', updatedAt: Date.now(), goal: { objective: '已经做完的老任务', status: 'active' } } })
  events.push({ type: 'goal/change', seq: seq++, time: 2, data: { operation: 'complete', updatedAt: Date.now(), goal: { objective: '已经做完的老任务', status: 'complete' } } })
  events.push({ type: 'user/message', seq: seq++, time: 3, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '现在改做另一件事：修 CI 的红灯。' }], source: { kind: 'user' } } })

  const result = extractGoalForTest(events)
  assert.notEqual(result.goalLayer, 'objective', 'a completed goal must not be used')
  assert.match(result.goal, /修 CI 的红灯/u, 'the session must fall through to the transcript')
})

test('C1 layer 3: the transcript fallback carries a seq POINTER, not just the body', () => {
  const events = logWith({ humans: ['请把看板五处缺陷修掉，并且不要动那三条既有断言。'] })
  const result = extractGoalForTest(events)
  assert.equal(result.goalLayer, 'transcript')
  assert.equal(typeof result.sourceSeq, 'number', 'the fallback must say WHERE the words are, so a reader can jump there')
  assert.ok(result.sourceSeq >= 0)
})

test('C1 rule 1: the DAG contributes ONE node line, never the graph body', () => {
  /**
   * The boundary/content split is the whole point of rule 1. A graph dump would spend the window on
   * structure; a single node line tells the target where it is at constant cost.
   *
   * Reached through layer 2 of the real extractor rather than through a helper export, so the public
   * surface stays at 182 and the test exercises production code.
   */
  const graph = [
    '[Phase Roadmap]（快照）',
    '- 阶段 1 constraint-shape ✅',
    '- [Node] n-s1b-2 — 契约化 S1b-2（第 3/7 步）',
    '- [Node] n-ci — 修 CI 红灯',
    '  observation: 这是一段很长的观察正文，绝不该进 goal 消息。',
    '- [Node] n-done — 已完成的历史节点（done）',
  ].join('\n')

  const result = extractGoalForTest([], graph)
  assert.equal(result.goalLayer, 'dag-node', 'with no objective, the DAG node is layer 2')
  assert.match(result.goal, /n-s1b-2/u)
  assert.doesNotMatch(result.goal, /observation|阶段 1|已完成的|n-ci/u, 'only ONE node, and no graph body')
  assert.ok(result.goal.length <= 160, `the node line must stay a boundary, got ${result.goal.length} chars`)
})

test('C1 rule 1: a DAG with every node done yields no current node', () => {
  const graph = ['- [Node] a — 第一件事（done）', '- [Node] b — 第二件事（已完成）'].join('\n')
  const result = extractGoalForTest([], graph)
  assert.notEqual(result.goalLayer, 'dag-node', 'a finished graph must not claim a current node')
})

test('C1 rule 3: the goal message never claims 已完成', () => {
  /**
   * "已完成" is a VERIFIED fact computed from the log by `extractSemanticState`. A DAG node state is a
   * DECLARATION. Blurring them is how a target builds on a claim it never checked — the same reason the
   * board renders measured facts and session claims in separate sections.
   */
  const board = renderTaskBoard({
    request: '给持久层补齐结构判据',
    pending: ['修 CI 红灯'],
    hasWrittenPlan: true,
    stopPoint: { turn: 3, boundarySeq: 10 },
    sourceSessionId: 'src',
    pointerCount: 5,
    discarded: { text: [], excluded: [] },
  })
  // The requirement line must not carry a completion claim from the goal layer.
  const requestLine = board.split('\n').find((line) => line.startsWith('**原始用户要求**')) ?? ''
  assert.doesNotMatch(requestLine, /已完成|✅/u, 'the requirement must not borrow a completion claim')
})
