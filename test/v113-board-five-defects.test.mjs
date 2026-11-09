/**
 * C-FAMILY REGRESSION SUITE — the handoff board's five defects, each measured on RENDERED OUTPUT.
 *
 * ── WHAT THE BOARD DOES TODAY (reproduced, not read off the source) ────────────────────────────
 *
 *   1. 原始用户要求 = the last human message, whatever it was. In the live session that produced this
 *      work, the user pasted a REPORT ABOUT the constraint extractor, and the board presented
 *      "这是 dsh 的报告：三项验收交付完毕…" as the requirement. A target reading that starts by
 *      answering a report it was never given.
 *   2. The same text is rendered again as 进行中 — measured: **231 characters, byte-identical**.
 *   3. Truncation to 300 characters leaves NO marker: the text simply stops at "## 二、TD-1". The
 *      instruction's own note explains why: `truncateEnd`'s comment says "no free-text truncation
 *      markers", and that reason applies to JSON payloads, not to a board a human reads.
 *   4. ✅ 已完成 says 「尚无已经验证完成的收尾动作」 even in a turn that delivered three documents.
 *   5. 可回读指针 811 处 and the index's own count are DIFFERENT numbers with ONE name (index.ts:3117:
 *      `pointerCount + Σ userTexts`), and the board shows only the first.
 *
 * ── WHY THE ASSERTIONS BELOW ARE WRITTEN AS "MUST NOT" ─────────────────────────────────────────
 *
 * Every one of these is a property a reader can be robbed of without noticing: a requirement that is
 * not the user's, a duplicate that looks like emphasis, a cut that looks like the end of a sentence,
 * a completed list that says nothing happened, two numbers wearing one name. Each test states the
 * property, not an implementation, so a rewrite of the renderer has to keep the property rather than
 * the format.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderTaskBoard } from '../index.js'

const PASTED_REPORT = `这是 dsh 的报告：
三项验收交付完毕，四仓工作树全部干净。
## 一、end 的更正
我自己实测确认（_scratch/verify-end-claim.mjs）：
in BOTH (22): do don't do not must never always only write use ignore include send ask end reply
LOST (19): choose pick report avoid keep add remove call run wait draft leave make set ensure prefer exclude
## 二、TD-12 已登记
措辞按你的要求：结构缺陷存在，可观测后果未找到。`

const GENUINE_REQUEST = '阶段 6 请把看板五处缺陷修掉：报告不该被当成要求，一处数字不该有两个名词，截断必须留下标记。'

function board(overrides = {}) {
  return renderTaskBoard({
    request: GENUINE_REQUEST,
    inProgress: undefined,
    pending: ['阶段 6: C1-C5'],
    hasWrittenPlan: true,
    stopPoint: { turn: 9, boundarySeq: 811 },
    sourceSessionId: 'auto-graft-src',
    pointerCount: 811,
    discarded: { text: [], excluded: [] },
    ...overrides,
  })
}

/** The body of a column: the first bullet after its heading. */
function columnBody(text, headingPattern) {
  const lines = text.split('\n')
  const headingIndex = lines.findIndex((line) => headingPattern.test(line))
  if (headingIndex < 0) return ''
  return (lines.slice(headingIndex + 1).find((line) => line.trim().startsWith('-')) ?? '').replace(/^-\s*/u, '')
}

test('C1: a pasted REPORT is not presented as the requirement', (t) => {
  /**
   * ── SKIPPED: THIS NEEDS A PRODUCT DECISION, NOT A RENDERER CHANGE ───────────────────────────────
   *
   * The instruction is explicit (§十一): "C1 需要先定义 goal 的语义（「用户要什么」还是「用户最后说了
   * 什么」）… 这不是我能替你定的产品决定，也不要靠打补丁绕过". The reason it insists is that the
   * same undefined semantics already caused a worse failure once (ANALYSIS-BRIEF §4.4): a goal that
   * was originally the user's first request got labelled 「当前要做的事」after it was finished, and the
   * target re-did the whole task.
   *
   * What the board does TODAY (reproduced): renders the pasted report verbatim as 原始用户要求 —
   * "这是 dsh 的报告：三项验收交付完毕…". A `substantive()` report-shape filter would change which
   * human message is treated as the user's want, i.e. it IS the semantics decision wearing a regex.
   *
   * Left skipped, not deleted: the assertion states the property that a ruling must satisfy.
   */
  t.skip('pending a ruling on goal semantics (用户要什么 vs 用户最后说了什么)')

  const text = board({ request: PASTED_REPORT })
  const requestBody = (text.split('\n').find((line) => line.startsWith('**原始用户要求**')) ?? '').replace(/^\*\*原始用户要求\*\*：/u, '')
  assert.doesNotMatch(
    requestBody,
    /^这是 ?dsh ?的报告/u,
    'a report opening must not be rendered as the user requirement',
  )
})

test('C2: the requirement and 进行中 are never the same text', () => {
  const text = board({ request: PASTED_REPORT, inProgress: PASTED_REPORT })
  const request = (text.split('\n').find((line) => line.startsWith('**原始用户要求**')) ?? '').replace(/^\*\*原始用户要求\*\*：/u, '')
  const doing = columnBody(text, /进行中/u)
  const common = (() => {
    let n = 0
    while (n < request.length && n < doing.length && request[n] === doing[n]) n += 1
    return n
  })()
  assert.ok(common < 30, `the two columns share ${common} leading characters; a duplicate reads as emphasis, not news`)
})

test('C3: a truncation always says it truncated, and says how much', () => {
  const text = board({ request: PASTED_REPORT })
  const requestLine = text.split('\n').find((line) => line.startsWith('**原始用户要求**')) ?? ''
  // The input is far longer than the 300-char display budget, so a cut MUST have happened.
  assert.ok(PASTED_REPORT.replace(/\s+/gu, ' ').trim().length > 300, 'the fixture must exceed the display budget')
  assert.match(
    requestLine,
    /已截断|…/u,
    'a truncated display must be marked; a bare cut reads as a complete sentence that ends mid-word',
  )
})

test('C4: one number, one name — the pointer counts are not conflated', () => {
  // index.ts measures TWO facts with one word: pointers written (`pointerCount`) and the total the
  // reader can look up (`pointerCount + Σ userTexts`, index.ts:3117). The board showed one.
  const text = board()
  assert.match(text, /可回读指针\s*\d+\s*处/u)
  assert.match(
    text,
    /本索引|索引条目|共\s*\d+\s*处可回读/u,
    'the index total must be named separately, or the reader cannot tell which number is which',
  )
})

test('C5: 已完成 must not claim nothing happened when work landed', () => {
  const text = board({
    outcome: {
      summary: '提交 91b6ebf；四仓 634/423/354/204 全绿',
      deliveries: ['提交 91b6ebf', '四仓测试全绿'],
    },
  })
  const done = columnBody(text, /已完成/u)
  assert.doesNotMatch(done, /^尚无/u, 'a turn that delivered commits and green tests must not render as 尚无')
})
