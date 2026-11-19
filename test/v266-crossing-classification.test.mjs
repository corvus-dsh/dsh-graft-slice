/**
 * ── v266 (B4-0b-2 §17.2): `prevented` was a RESULT name for a PROCESS fact ──────────────────────
 *
 * Layer 2's first classification called a crossing `prevented` when the pre-step BEFORE the jump would
 * have fired a prediction. That only proves 「预警比切断早一步到达」. The cut itself still happens — the
 * pre-step checks `ratio >= hardAt` and returns before the predictor runs — and whether the model then
 * hands over is a separate question with its own evidence (a `graft_*` tool call).
 *
 * The field name is the whole risk: it gets quoted into acceptance notes and read as 「这一次切没发生」
 * the first time it is non-zero. That is the same fault as `prevented` vs `disclosed` one level deeper,
 * so the classifier now takes evidence and the names say what was MEASURED:
 *
 *   announced-then-handed-over — prediction fired AND a `graft_*` call between nudge and jump
 *   announced-not-prevented    — prediction fired and NO handover call followed
 *   forced-cut                 — no prediction at all (layer 3's mark is the only disclosure)
 *
 * The dispatch's acceptance criterion is exactly the middle case:
 *
 *   判据：构造「预测开火 → 没交 → 下一跳切断」⇒ 现在记 prevented（**错**），改后必须记
 *        announced-not-prevented；构造「预测开火 → 交了（有 graft 事件）」⇒ 记 prevented。
 *
 * ── WHY THIS TEST DRIVES THE REAL CLASSIFIER ──────────────────────────────────────────────────
 *
 * `classifyCrossing` is imported from `scripts/w0-three-layers.mjs` — the same function the measurement
 * uses. A test that re-implemented the three-way rule would pass while the probe kept mislabelling, which
 * is the `v250` trap (`canred-must-drive-real-callsite`) one layer up: the thing under test is the
 * MEASUREMENT's judgement, not a copy of it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyCrossing, handoverSeqsOf } from '../scripts/w0-three-layers.mjs'

/** The three handover tools, each in its real `tool/call` shape. */
const handoverCall = (seq, name = 'graft_prepare') => ({
  type: 'tool/call',
  seq,
  data: { name, arguments: '{}' },
})

test('v266 ①: predicted + NO handover ⇒ announced-not-prevented (the case the old code called prevented)', () => {
  /**
   * This is the dispatch's acceptance criterion, verbatim: 「预测开火 → 没交 → 下一跳切断」. Under the old
   * classification this was `prevented`, which reads as "the cut did not happen" — false.
   */
  const layer = classifyCrossing({
    predictedBefore: true,
    nudgeSeq: 100,
    jumpSeq: 120,
    handoverSeqs: [],
  })
  assert.equal(layer, 'announced-not-prevented', 'a warning with no handover must NOT be called prevention')
})

test('v266 ②: predicted + a graft_* call between nudge and jump ⇒ announced-then-handed-over', () => {
  const layer = classifyCrossing({
    predictedBefore: true,
    nudgeSeq: 100,
    jumpSeq: 120,
    handoverSeqs: [110],
  })
  assert.equal(layer, 'announced-then-handed-over', 'evidence of a handover makes it real prevention')
})

test('v266 ③: a handover call OUTSIDE the window does not count', () => {
  /**
   * Both edges, because "some handover exists somewhere in the log" is the tempting wrong rule:
   *   · BEFORE the nudge — the session was already handing over; the warning cannot have caused it;
   *   · AFTER the jump — the cut already happened, so nothing was averted.
   */
  assert.equal(
    classifyCrossing({ predictedBefore: true, nudgeSeq: 100, jumpSeq: 120, handoverSeqs: [99] }),
    'announced-not-prevented',
    'a handover BEFORE the nudge is not caused by it',
  )
  assert.equal(
    classifyCrossing({ predictedBefore: true, nudgeSeq: 100, jumpSeq: 120, handoverSeqs: [121] }),
    'announced-not-prevented',
    'a handover AFTER the jump cannot have averted it',
  )
})

test('v266 ④: no prediction ⇒ forced-cut, whatever handovers exist', () => {
  assert.equal(
    classifyCrossing({ predictedBefore: false, nudgeSeq: undefined, jumpSeq: 120, handoverSeqs: [110] }),
    'forced-cut',
    'layer 3 discloses; layer 2 never spoke, so nothing can be called announced',
  )
})

test('v266 ⑤: handoverSeqsOf reads tool/call, and only the graft_ tools', () => {
  /**
   * Measured across the real corpus: the log carries `tool/call` named `graft_prepare` (29),
   * `graft_commit` (9), `graft_slice_and_inject` (14) — and no separate transfer event type. So
   * `tool/call` IS the evidence, and a non-graft tool must not be mistaken for one.
   */
  const events = [
    { type: 'turn/start', seq: 1 },
    handoverCall(2, 'graft_prepare'),
    handoverCall(3, 'pwsh'),
    handoverCall(4, 'graft_commit'),
    handoverCall(5, 'graft_slice_and_inject'),
    handoverCall(6, 'graft_debug_status'),
    handoverCall(7, 'graft_read_result'),
  ]
  const seqs = handoverSeqsOf(events)
  assert.deepEqual(seqs, [2, 4, 5], `only the three handover tools count; got ${JSON.stringify(seqs)}`)
})

test('v266 ⑥: the classifier is driven by EVIDENCE, so a session with many handovers but no prediction stays forced-cut', () => {
  /**
   * The control that keeps ② from being "any handover ⇒ prevented". A session can hand over constantly and
   * still be force-cut by a jump that no prediction foresaw; that crossing is layer 3's.
   */
  const layer = classifyCrossing({
    predictedBefore: false,
    nudgeSeq: undefined,
    jumpSeq: 500,
    handoverSeqs: [10, 20, 30, 40, 50, 400],
  })
  assert.equal(layer, 'forced-cut')
})
