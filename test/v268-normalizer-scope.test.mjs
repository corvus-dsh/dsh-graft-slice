/**
 * ── v268 (B4-0b-2 W1-8b): the normaliser's SCOPE must not be wider than its reason ───────────────
 *
 * W1-8 fixed the midnight digest drift by normalising 「（已 N 天）」 before hashing. The first version ran
 * that over EVERY chunk's text — wider than the reason for it:
 *
 *   · 「（已 N 天）」 has exactly ONE producer in this tree: `task-position.ts`'s staleness line
 *     (`自 ${since} 起未更新（已 ${age} 天）`), which lands in the `kind: 'task-position'` chunk;
 *   · every OTHER chunk holds QUOTED matter — user messages, tool results, replayed turns.
 *
 * Normalising quoted text before hashing means two tapes whose quoted text differs only in
 * 「（已 30 天）」 vs 「（已 31 天）」 hash the same. The digest's entire job is 「用户审过的那一份」, so that
 * is the digest quietly editing a character of somebody else's words and then reporting a match.
 *
 * The judgement, from the dispatch:
 *
 *   ① 两条日志只在用户消息里差一天 ⇒ digest 必须**不同**；
 *   ② `task-position` 天数变、其余不变 ⇒ digest **相同**；
 *   ③ `v267` 五条继续绿。
 *   can-red：范围改回全部 chunk ⇒ ① 红。
 *
 * ── WHY THE TEST DRIVES `digestTextOfChunk` AND NOT `normalizeDigestText` ──────────────────────
 *
 * W1-8b is a statement about SCOPE, and the scope lives in `digestTextOfChunk`. Testing
 * `normalizeDigestText` here would pass while the digest still pushed every chunk through it — the
 * `v250` trap one layer out. ① and ② therefore drive the function the digest actually calls.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { digestTextOfChunk, isClockBearingChunkKind, normalizeDigestText } from '../index.js'

const STALE = (days) => `  自 2026-10-20 起未更新（已 ${days} 天）`

test('v268 ①: a day difference in QUOTED text survives into the digest (the normaliser is scoped)', () => {
  /**
   * The case the old broad scope silently ate. A user message (or a tool result) that happens to contain
   * 「（已 30 天）」 is DATA — it is what the user typed. Two tapes differing there are two different tapes.
   */
  const quotedA = { kind: 'recent-turn', text: '用户说：这套已经（已 30 天）没动了' }
  const quotedB = { kind: 'recent-turn', text: '用户说：这套已经（已 31 天）没动了' }
  assert.notEqual(
    digestTextOfChunk(quotedA),
    digestTextOfChunk(quotedB),
    'quoted text must reach the hash verbatim — a day boundary in it is a different tape',
  )

  /** And the same for a tool result / readback quotation, which is a different chunk kind. */
  const toolA = { kind: 'readback-index', text: 'seq=12 · 输出：已（已 30 天）无变化' }
  const toolB = { kind: 'readback-index', text: 'seq=12 · 输出：已（已 31 天）无变化' }
  assert.notEqual(digestTextOfChunk(toolA), digestTextOfChunk(toolB))
})

test('v268 ②: in the task-position chunk the day count still normalises (W1-8 behaviour is intact)', () => {
  const positionA = { kind: 'task-position', text: STALE(30) }
  const positionB = { kind: 'task-position', text: STALE(31) }
  assert.equal(
    digestTextOfChunk(positionA),
    digestTextOfChunk(positionB),
    'the ONE clock-bearing chunk must still absorb a day boundary',
  )
  /** And the date inside it is still data. */
  assert.notEqual(
    digestTextOfChunk({ kind: 'task-position', text: '  自 2026-10-20 起未更新（已 30 天）' }),
    digestTextOfChunk({ kind: 'task-position', text: '  自 2026-10-21 起未更新（已 30 天）' }),
  )
})

test('v268 ③: every non-task-position chunk passes through BYTE-IDENTICAL', () => {
  /**
   * The sweep that makes the scope a property of the FUNCTION rather than of the two cases above: any
   * chunk kind that is not `task-position` must be returned untouched, whatever it contains.
   */
  const samples = [
    { kind: 'pending-state', text: '## 交接任务看板\n已 30 天' },
    { kind: 'open-turn-carryover', text: '我做了一句（已 30 天）' },
    { kind: 'recent-turn', text: '（已 99 天）' },
    { kind: 'workspace-files', text: 'src/index.ts（已 3 天）' },
    { kind: '', text: '（已 5 天）' },
    { kind: undefined, text: '（已 5 天）' },
  ]
  for (const chunk of samples) {
    assert.equal(digestTextOfChunk(chunk), String(chunk.text), `kind=${String(chunk.kind)} must be verbatim`)
  }
})

test('v268 ④: the scope is exactly one kind, and it is named (not a prefix or a fuzzy match)', () => {
  assert.equal(isClockBearingChunkKind('task-position'), true)
  for (const kind of ['task-position-detail', 'Task-Position', 'taskposition', '', undefined, 'recent-turn']) {
    assert.equal(isClockBearingChunkKind(kind), false, `${String(kind)} must not be treated as clock-bearing`)
  }
})

test('v268 ⑤: `normalizeDigestText` is still a pure text function — the scope lives in its caller', () => {
  /**
   * W1-8b did not change what the normaliser does, only WHEN it is applied. Keeping that separation is
   * what lets `v267` (which pins the normaliser's own behaviour) stay meaningful after this change.
   */
  assert.equal(normalizeDigestText(STALE(30)), '  自 2026-10-20 起未更新（已 N 天）')
  assert.equal(normalizeDigestText('没有天数'), '没有天数')
})
