/**
 * C1 RULES 2 AND 3 — THE PART THAT WAS MISSING.
 *
 * ── WHAT WAS WRONG, MEASURED BY THE REVIEW ─────────────────────────────────────────────────────
 *
 *   objective = '把 S1b-2 的 9 个契约骨架写出来'
 *   user/message = '先别写骨架，先修 CI'
 *   dagText = '- [Node] n-s1b-2 — 契约化 S1b-2'
 *
 *   goal  = "把 S1b-2 的 9 个契约骨架写出来"      ← the user's change had VANISHED
 *   layer = objective
 *   冲突标记：none
 *
 * `grep -c 不一致` = 0, `grep -c 窗口任务` = 0. Rule 1 (one node line) and rule 3 (no 已完成) were
 * implemented and tested; **rule 2 was not implemented at all** — and it is the most important one,
 * because it is the arbitration that ANALYSIS-BRIEF §4.4 lacked when a mislabelled goal made a target
 * redo finished work.
 *
 * ── AND goalLayer WAS WRITE-ONLY ────────────────────────────────────────────────────────────────
 *
 * Assigned in 9 places, read in 0. My own comment claimed a reader could tell a declared objective from
 * a guess; only a test could. A target reading an unlabelled "原始用户要求" cannot know whether the user
 * SET that task or the plugin fished it out of a sentence — so the label now reaches the board.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractGoalForTest, renderTaskBoard } from '../index.js'

function build({ objective, humans = [] }) {
  const events = []
  let seq = 0
  if (objective !== undefined) {
    events.push({
      type: 'goal/change',
      seq: seq++,
      time: 1,
      data: { operation: 'create', updatedAt: Date.now(), goal: { objective, status: 'active' } },
    })
  }
  for (const text of humans) {
    events.push({
      type: 'user/message',
      seq: seq++,
      time: 2 + seq,
      data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    })
  }
  return events
}

test('C1 rule 2: a changed direction AFTER the objective is carried as a structured value', () => {
  const events = build({ objective: '把 S1b-2 的 9 个契约骨架写出来', humans: ['先别写骨架，先修 CI'] })
  const result = extractGoalForTest(events, '- [Node] n-s1b-2 — 契约化 S1b-2')

  assert.equal(result.goalLayer, 'objective', 'the objective still answers first')
  assert.match(result.goal, /9 个契约骨架/u, 'the objective is preserved as the declaration')
  assert.ok(result.supersededBy !== undefined, 'a newer human message must NOT vanish behind the objective')
  assert.match(result.supersededBy.text, /先修 CI/u, 'the new direction must be carried verbatim')
  assert.equal(typeof result.supersededBy.seq, 'number', 'and with a seq, so a reader can read the whole message')
  assert.equal(result.supersededBy.afterObjective, true)
})

test('C1 rule 2: the board renders BOTH, names the arbitration, and says the user wins', () => {
  const board = renderTaskBoard({
    request: '把 S1b-2 的 9 个契约骨架写出来',
    goalLayer: 'objective',
    supersededBy: { text: '先别写骨架，先修 CI', seq: 2, afterObjective: true },
    pending: ['修 CI'],
    hasWrittenPlan: true,
    stopPoint: { turn: 1, boundarySeq: 2 },
    sourceSessionId: 'src',
    pointerCount: 1,
    discarded: { text: [], excluded: [] },
  })

  assert.match(board, /原始用户要求.*objective/u, 'the requirement must be labelled as a DECLARED objective')
  assert.match(board, /把 S1b-2 的 9 个契约骨架写出来/u, 'the declaration is still shown')
  assert.match(board, /后来改了口径/u, 'the change of direction must be named, not silently folded in')
  assert.match(board, /先别写骨架，先修 CI/u, 'the new direction must appear')
  assert.match(board, /seq=2/u, 'with its seq')
  assert.match(board, /以最新的用户要求为准/u, 'and the arbitration rule stated explicitly')
})

test('C1 rule 2 self-test: without a change of direction there is NO conflict section', () => {
  // A bare acknowledgement must not masquerade as a new instruction; the section must not appear.
  const events = build({ objective: '把 S1b-2 的 9 个契约骨架写出来', humans: ['好的，继续'] })
  const result = extractGoalForTest(events, undefined)
  assert.equal(result.supersededBy, undefined, 'a bare "好的，继续" is not a new direction')

  const board = renderTaskBoard({
    request: '把 S1b-2 的 9 个契约骨架写出来',
    goalLayer: 'objective',
    pending: ['x'],
    hasWrittenPlan: true,
    stopPoint: { turn: 1 },
    sourceSessionId: 'src',
    pointerCount: 1,
    discarded: { text: [], excluded: [] },
  })
  assert.doesNotMatch(board, /后来改了口径/u, 'no conflict section when there is no conflict')
})

test('C1: the requirement line states WHICH LAYER it came from', () => {
  /**
   * The label is the delivery mechanism for the three-layer split: objective/dag-node are DECLARED and
   * trustworthy, transcript is GUESSED and needs verification. Without it the reader cannot weigh the
   * line at all.
   */
  const base = {
    request: 'x',
    pending: [],
    hasWrittenPlan: true,
    stopPoint: {},
    sourceSessionId: 'src',
    pointerCount: 0,
    discarded: { text: [], excluded: [] },
  }

  const asObjective = renderTaskBoard({ ...base, request: '任务 A', goalLayer: 'objective' })
  assert.match(asObjective, /原始用户要求.*（objective）/u)

  const asNode = renderTaskBoard({ ...base, request: 'n-1 — 某节点', goalLayer: 'dag-node' })
  assert.match(asNode, /原始用户要求.*（dag-node）/u)

  const asTranscript = renderTaskBoard({ ...base, request: '先别写骨架，先修 CI', goalLayer: 'transcript' })
  assert.match(asTranscript, /原始用户要求.*（transcript，未声明目标）/u, 'a guess must SAY it is a guess')

  const unknown = renderTaskBoard({ ...base, request: '任务 A' })
  assert.match(unknown, /原始用户要求.*（来源未知）/u, 'absent provenance is stated, never silently omitted')
})

test('C1: layer 2 (dag-node) is labelled too, and layer 3 carries the pointer', () => {
  const node = extractGoalForTest([], '- [Node] n-ci — 修 CI 红灯')
  assert.equal(node.goalLayer, 'dag-node')

  const transcript = extractGoalForTest(build({ humans: ['先别写骨架，先修 CI'] }), undefined)
  assert.equal(transcript.goalLayer, 'transcript')
  assert.equal(typeof transcript.sourceSeq, 'number', 'the fallback points at the words instead of pasting them')
})
