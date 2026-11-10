/**
 * S1_JSON — A SHAPE RULE THAT EATS REAL CONSTRAINTS IS WORSE THAN NO RULE.
 *
 * ── THE DEFECT (measured, and reported to me after I had wrongly called it clean) ────────────────
 *
 * `isJsonFragment` has three branches. The first two are anchored; the third is not:
 *
 *     /^":\s*[[{]|",\s*$|":\s*"/u
 *      ↑ anchored  ↑ anchored  ↑ UNANCHORED — fires on `": "` ANYWHERE
 *
 * So a line of Chinese prose that merely QUOTES a JSON key/value pair is judged a JSON fragment:
 *
 *     必须 在提交前确认 engines 里 "node": ">=22" 这一项没有降低。      → LOST (S1_JSON)
 *     禁止 把 "kind": "plugin" 这种标记换成 user，那会伪造人类来源。   → LOST (S1_JSON)
 *
 * The same rule without the quotes is KEPT — which is the tell: the shape rule is reacting to
 * punctuation INSIDE a sentence, not to the sentence being a fragment.
 *
 * ── WHY THE OLD nearMISS DID NOT CATCH THIS ────────────────────────────────────────────────────
 *
 * The shipped nearMiss was `必须 在提交前检查 "U+FFFD" 为 0。` — it contains quotes but NO COLON, so it
 * never reaches the third branch. The near miss exercised the wrong part of the rule, which is how the
 * defect survived its own test. The near miss below contains `": "` specifically to reach that branch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { shapeOfConstraint } from '../src/core/constraint-shape.ts'

test('S1: a real rule that QUOTES a JSON key/value is not a JSON fragment', () => {
  const realRules = [
    '必须 在提交前确认 engines 里 "node": ">=22" 这一项没有降低。',
    '禁止 把 "kind": "plugin" 这种标记换成 user，那会伪造人类来源。',
    '必须 确认 "node": ">=22" 未降低。',
    '必须 在提交前确认 package.json 里 "type": "module" 没有被改动。',
  ]
  for (const text of realRules) {
    const verdict = shapeOfConstraint(text)
    assert.equal(
      verdict.broken,
      false,
      `a shape rule that kills a real constraint is worse than no rule: ${JSON.stringify(text)} → ${verdict.code}`,
    )
  }
})

test('S1 nearMiss: the shape that ACTUALLY reaches the unanchored branch', (t) => {
  /**
   * This is the case the old near miss could not produce. It contains `": "` inside a sentence, which
   * is the only thing that reaches the third branch — so if that branch regresses to being unanchored,
   * THIS test goes red and the previous one explains why it matters.
   */
  const nearMiss = '必须 确认 "node": ">=22" 未降低。'
  assert.match(nearMiss, /":\s*"/u, 'the near miss must contain the branch-triggering shape, or it tests nothing')
  assert.equal(shapeOfConstraint(nearMiss).broken, false)
  t.diagnostic('this sample reaches branch 3 of isJsonFragment; it is the regression tripwire for S1')
})

test('S1 control: a REAL JSON fragment is still rejected', () => {
  // The rule must keep its power. Each of these is the shape it exists for.
  const fragments = [
    '"绝对约束（后续所有轮次都不能违反）：",',
    '": [',
    '"1. 绝对不能 import re，也不能以任何方式使用正则表达式。',
    '{"name": "x", "version": "1.0.0",',
  ]
  for (const text of fragments) {
    assert.equal(shapeOfConstraint(text).broken, true, `a real fragment must stay rejected: ${JSON.stringify(text)}`)
  }
})
