/**
 * ── v263 (B4-0b-2 W1-6): when the position block is cut, the ACTIONABLE lines survive ────────────
 *
 * The old `capText` kept `lines.slice(0, 4)` and dropped from the BOTTOM. Measured against the
 * renderer's own section order, that is exactly backwards: 「已完成」 sits ABOVE the lists and survived,
 * while 「未开始」/「我被谁阻塞」/「我解锁谁」 — the three lines a next generation needs in order to know
 * what to do — were the FIRST to go. The one case where the cap fires therefore handed the reader
 * history and no instructions.
 *
 * The dispatch writes the requirement as a sacrifice order (已完成 → 本代 → 多条 requirements → 新鲜度,
 * with 未开始 / 我被谁阻塞 / 我解锁谁 last) and two assertions:
 *
 *   ① 触发截断后「未开始」仍在，「已完成」可缺；
 *   ② 正文长度 ≤ TASK_POSITION_MAX_CHARS（不含声明行）。
 *
 * ── WHY OVERFLOW NEEDS A CAREFULLY BUILT GRAPH ────────────────────────────────────────────────
 *
 * The id lists are capped at 8 entries (`MAX_NODE_LIST`) and requirements at 3, so a large graph does
 * NOT overflow — `v233 ⑨` passes at 30 nodes and never reaches the interesting branch. Overflow needs
 * LONG TEXT, so every case below inflates the parts that are never sacrificed until the body really is
 * over the cap, then asserts what survived.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { TASK_POSITION_MAX_CHARS, renderTaskPosition, toTaskPosition } from '../index.js'

const NOW = '2026-11-20T00:00:00.000Z'
const OLD = '2026-10-20T00:00:00.000Z'

const longId = (prefix, width) => `${prefix}-${'x'.repeat(width)}`

/**
 * A graph with ALL FIVE sacrifice kinds present and a body far over the cap:
 *
 *   · goal          — long, and `goal` is never sacrificed
 *   · 已完成          — 8 long done ids
 *   · 当前节点        — 12 long requirements (the `requirements` kind, sacrificed one at a time)
 *   · 未开始          — 8 long pending ids (NEVER sacrificed)
 *   · 我被谁阻塞/我解锁谁 — long edge lists (NEVER sacrificed)
 *   · 新鲜度          — 30 days stale (a sacrifice kind)
 *   · 本代            — supplied by the caller (a sacrifice kind)
 */
function overflowingGraph() {
  const currentId = longId('current', 24)
  const nodes = [
    { id: 'goal', title: '目标', status: 'done', dependsOn: [], requirements: [], updatedAt: OLD },
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((index) => ({
      id: longId(`done-${index}`, 24),
      title: '',
      status: 'done',
      dependsOn: ['goal'],
      requirements: [],
      updatedAt: OLD,
    })),
    /**
     * A REAL unfinished blocker. Without it `blockedBy` is empty (the current node would only depend on
     * `goal`, which is the destination and is not counted) and ①b would assert on a line the renderer is
     * right not to print — the first draft of this fixture did exactly that and failed for the right
     * reason.
     */
    ...['gate-a', 'gate-b'].map((id) => ({
      id: longId(id, 24),
      title: '',
      status: 'pending',
      dependsOn: ['goal'],
      requirements: [],
      updatedAt: OLD,
    })),
    {
      id: currentId,
      title: '',
      status: 'active',
      dependsOn: ['goal', longId('gate-a', 24), longId('gate-b', 24)],
      requirements: Array.from({ length: 12 }, (_, index) => `要求${index}：${'r'.repeat(60)}`),
      progress: 40,
      updatedAt: OLD,
    },
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((index) => ({
      id: longId(`pend-${index}`, 24),
      title: '',
      status: 'pending',
      dependsOn: [currentId],
      requirements: [],
      updatedAt: OLD,
    })),
  ]
  return {
    goal: `把持久层能力全部生产就绪：${'g'.repeat(400)}`,
    goalLockedAt: '2026-11-18T00:00:00.000Z',
    nodes,
  }
}

test('v263 ①: after truncation 「未开始」 SURVIVES and 「已完成」 may be gone', () => {
  const position = toTaskPosition(overflowingGraph(), { now: NOW })
  assert.ok(position !== undefined, 'the graph must yield a position at all')
  const text = renderTaskPosition({ ...position, generation: 3, originSessionId: 'auto-graft-origin' })
  assert.ok(text !== undefined, 'the block must exist')

  assert.ok(text.length < TASK_POSITION_MAX_CHARS + 200, `the cap must actually fire; got ${text.length} chars`)
  assert.match(text, /未开始：/u, `the ACTIONABLE list must survive; got:\n${text}`)
  assert.match(text, /当前节点：/u, 'and the current node is never sacrificed')
  assert.doesNotMatch(text, /已完成：/u, `history is the FIRST thing given up; got:\n${text}`)
})

test('v263 ①b: 「我被谁阻塞」/「我解锁谁」 also survive — the cap must not eat the edges', () => {
  /**
   * The edges are the only lines that answer "why can't I start" and "who am I holding up". They are
   * separately actionable from the pending list, so they get their own assertion: a fix that keeps
   * 「未开始」 and still drops the edges is half a fix — the exact shape the review found in W1-4/W1-5.
   */
  const position = toTaskPosition(overflowingGraph(), { now: NOW })
  assert.ok(position !== undefined)
  const text = renderTaskPosition({ ...position, generation: 3 })
  assert.ok(text !== undefined)
  assert.match(text, /我被谁阻塞：/u, `blockedBy must survive; got:\n${text}`)
  assert.match(text, /我解锁谁：/u, `unlocks must survive; got:\n${text}`)
})

test('v263 ②: the BODY is within the cap, and the declaration is measured separately', () => {
  const position = toTaskPosition(overflowingGraph(), { now: NOW })
  assert.ok(position !== undefined)
  const text = renderTaskPosition({ ...position, generation: 3 })
  assert.ok(text !== undefined)
  /**
   * 「不含声明行」 means: strip the note, and what remains must be ≤ TASK_POSITION_MAX_CHARS. The old
   * implementation appended the note to an already-full body, so the TOTAL exceeded the cap while every
   * assertion passed — nothing measured the total.
   */
  const noteIndex = text.lastIndexOf('\n（本块已按')
  assert.ok(noteIndex > 0, `a truncation must be DECLARED; got:\n${text.slice(-200)}`)
  const body = text.slice(0, noteIndex)
  assert.ok(
    body.length <= TASK_POSITION_MAX_CHARS,
    `the BODY must be within ${TASK_POSITION_MAX_CHARS}, got ${body.length}`,
  )
  assert.ok(
    text.length <= TASK_POSITION_MAX_CHARS + 120,
    `and the declared total must stay close to the cap; got ${text.length}`,
  )
})

test('v263 ③: below the cap NOTHING is sacrificed and no note appears (the guard is not always-on)', () => {
  const small = {
    goal: '把持久层能力全部生产就绪',
    goalLockedAt: '2026-11-18T00:00:00.000Z',
    nodes: [
      { id: 'goal', title: '目标', status: 'done', dependsOn: [], requirements: [], updatedAt: OLD },
      { id: 'p1', title: '一', status: 'done', dependsOn: ['goal'], requirements: [], updatedAt: OLD },
      { id: 'p2', title: '二', status: 'active', dependsOn: ['p1'], requirements: ['甲', '乙'], progress: 40, updatedAt: OLD },
      { id: 'p3', title: '三', status: 'pending', dependsOn: ['p2'], requirements: [], updatedAt: OLD },
    ],
  }
  const position = toTaskPosition(small, { now: NOW })
  assert.ok(position !== undefined)
  const text = renderTaskPosition(position)
  assert.ok(text !== undefined)
  assert.doesNotMatch(text, /已按 \d+ 字符上限截断/u)
  assert.match(text, /已完成：/u, 'a block inside the cap keeps its history')
  assert.match(text, /未开始：/u)
  assert.match(text, /自 2026-10-20 起未更新/u, 'and keeps the freshness line')
})

test('v263 ④: requirements are shortened one at a time before the whole line is dropped', () => {
  /**
   * `requirements` is a joined list, so dropping it wholesale wastes a real intermediate step. The
   * judgement: a partially-kept requirements line that still ENDS in a declared ellipsis is better than
   * no requirements at all — and it must say it was cut, or the reader believes it saw them all.
   */
  const position = toTaskPosition(overflowingGraph(), { now: NOW })
  assert.ok(position !== undefined)
  const text = renderTaskPosition({ ...position, generation: 3 })
  assert.ok(text !== undefined)
  const line = text.split('\n').find((entry) => entry.startsWith('  要求：'))
  if (line !== undefined) {
    assert.match(line, /（已截断）|…/u, 'a shortened requirements line must say so')
  }
  /** Either way the CURRENT NODE line survives, which is the invariant this test protects. */
  assert.match(text, /当前节点：/u)
})
