/**
 * ── v267 (B4-0b-2 W1-8): a review must not expire at midnight ────────────────────────────────────
 *
 * `task-position` renders 「自 2026-10-20 起未更新（已 30 天）」. The DATE comes from the graph; the DAY
 * COUNT comes from `now`, read fresh at every call. `digestOfPlan` hashes each chunk's rendered text, so
 * the digest changed at midnight — a review opened at 23:58 and committed at 00:02 differed for a reason
 * that has nothing to do with what the user approved.
 *
 * The dispatch's judgement:
 *
 *   判据：同一 updatedAt 下，now 差 1 天 ⇒ digest 相同；渲染文本可不同（天数允许变）。
 *   can-red：把 ageDays 改回进 digest ⇒ 判据红。
 *
 * ── WHY THE FIX NORMALISES INSTEAD OF DROPPING THE CHUNK ───────────────────────────────────────
 *
 * The dispatch allows "drop the day count from the digest inputs" OR "make task-position a tail kind".
 * The second would let a REAL position change (a different current node, a different goal) through
 * unchecked, because tail kinds are explicitly allowed to move between review and commit. So the chunk
 * stays in the digest and only its clock-derived part is normalised: the day count becomes a
 * placeholder, the date — which is data — is kept.
 *
 * ── ③ IS THE ONE THAT MATTERS MOST ────────────────────────────────────────────────────────────
 *
 * A normaliser that strips too much would make ① pass while the digest stopped covering the position at
 * all. ③ asserts the opposite direction: a REAL change to the position still changes the digest.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeDigestText } from '../index.js'

const STALE_LINE = (days) => `  自 2026-10-20 起未更新（已 ${days} 天）`

test('v267 ①: the day count normalises away, so a 1-day clock difference cannot move the digest', () => {
  /**
   * The unit under test is the normaliser, because that is where the judgement lives. `digestOfPlan` is
   * not exported (it is an internal of the commit path), so the observable claim is: two texts that differ
   * ONLY in the day count become the same string here.
   */
  assert.equal(normalizeDigestText(STALE_LINE(30)), normalizeDigestText(STALE_LINE(31)), 'a day boundary is not a change')
  assert.match(normalizeDigestText(STALE_LINE(30)), /2026-10-20/u, 'the DATE is data and must survive')
  assert.match(normalizeDigestText(STALE_LINE(30)), /已 N 天/u, 'the count is replaced by a stated placeholder')
})

test('v267 ②: text WITHOUT a day count is returned byte-identical (the normaliser is not a rewriter)', () => {
  /**
   * The guard that keeps ① from being "mangle every chunk". Every other chunk kind passes through this
   * function too; if it altered ordinary text, every digest would silently change and every open review
   * would break.
   */
  for (const text of ['## 交接任务看板', '当前节点：phase-b4（active）', '全局目标：把四仓做完', '']) {
    assert.equal(normalizeDigestText(text), text)
  }
})

test('v267 ③: a REAL position change still moves the digest inputs (the normaliser is not a muzzle)', () => {
  /**
   * The other direction, and the reason the dispatch's "make it a tail kind" option was rejected: a
   * different DATE, a different node, or a different goal must NOT be normalised away.
   */
  assert.notEqual(normalizeDigestText(STALE_LINE(30)), normalizeDigestText(`  自 2026-10-21 起未更新（已 30 天）`))
  assert.notEqual(
    normalizeDigestText('当前节点：phase-b4（active）'),
    normalizeDigestText('当前节点：phase-b5（active）'),
  )
  assert.notEqual(normalizeDigestText('全局目标：把四仓做完'), normalizeDigestText('全局目标：只做读路径'))
})

test('v267 ④: only the parenthesised day count is normalised — a bare "已 30 天" is left alone', () => {
  /**
   * The pattern is `（已 \d+ 天）` with the fullwidth parentheses the renderer emits. A bare phrase could
   * legitimately be graph content (a goal mentioning "已 30 天"), and this function's scope is the ONE
   * line the renderer produces — narrowing it is what keeps ③ true.
   */
  assert.equal(normalizeDigestText('目标：已 30 天没动了'), '目标：已 30 天没动了')
})

test('v267 ⑤: a multi-day jump normalises identically to a single-day one (digit count is not data)', () => {
  assert.equal(normalizeDigestText(STALE_LINE(9)), normalizeDigestText(STALE_LINE(100)))
})
