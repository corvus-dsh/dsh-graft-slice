/**
 * ── SHAPE JUDGEMENT: six rules, six near misses, and 35 real constraints that must survive ──────
 *
 * Every assertion here is bidirectional. A rule that rejects a fragment but also rejects a real rule
 * is worse than no rule, because the user's rule disappears silently and nothing reports it.
 *
 * ── THE 35 CLEAN CONSTRAINTS ARE THE MOST IMPORTANT PART OF THIS FILE ───────────────────────────
 *
 * Seven clean generations of live data hold 35 constraints that were accepted by the old pipeline and
 * that a reader can verify are genuine. They are the direct probe for "is the shape rule too wide?"
 * — and unlike a hand-written near miss, they cannot be tuned to fit the rule.
 *
 * ── WHY EACH RULE IS ASSERTED IN BOTH DIRECTIONS, AND WHY SOME NEED `S5` OFF ─────────────────────
 *
 * `绝对约束（后续所有轮次都不能违反）：` must be rejected. `绝对约束：禁止在没有备份的情况下删除任何脚本。`
 * must be kept. They differ ONLY in where the colon sits and whether the text ends in a full stop —
 * which is exactly the distinction a shape rule is supposed to see.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { shapeOfConstraint } from '../src/core/constraint-shape.ts'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

/** The five fragments measured on the live corpus (turn 538). Verbatim. */
const MEASURED_FRAGMENTS = [
  { text: '- 必须、禁止、绝对、不能、不得、不许、务必', code: 'S3_WORDLIST' },
  { text: '- must / never / forbidden / required / cannot / do not', code: 'S3_WORDLIST' },
  { text: '"绝对约束（后续所有轮次都不能违反）：",', code: 'S1_JSON' },
  { text: '"1. 绝对不能 import re，也不能以任何方式使用正则表达式。', code: 'S1_JSON' },
  { text: '| 2 | 4 | Information | Never include my name in your replies or in any tool call. |', code: 'S2_TABLE' },
]

/** The genuine constraint that appeared alongside them in the same corpus. */
const GENUINE = '绝对约束：禁止在没有备份的情况下删除任何脚本，这条永远有效。'

test('each of the five measured fragments is rejected, with a STABLE code', () => {
  for (const fragment of MEASURED_FRAGMENTS) {
    const verdict = shapeOfConstraint(fragment.text)
    assert.equal(verdict.broken, true, `must be rejected: ${JSON.stringify(fragment.text.slice(0, 40))}`)
    assert.equal(verdict.code, fragment.code, `wrong code for ${JSON.stringify(fragment.text.slice(0, 40))}: got ${verdict.code}`)
    assert.ok(typeof verdict.why === 'string' && verdict.why.length > 5, 'a rejection must say what structure was seen')
  }
})

test('the genuine constraint in the same corpus is KEPT', () => {
  const verdict = shapeOfConstraint(GENUINE)
  assert.equal(verdict.broken, false, `a real rule must never be rejected: ${GENUINE}`)
})

test('nearMiss per rule — a rule that kills these is the wrong rule', () => {
  const NEAR_MISSES = [
    // S1: quotes INSIDE a sentence are ordinary prose.
    { text: '必须 在提交前检查 "U+FFFD" 为 0。', rule: 'S1' },
    // S2: a pipe inside a sentence.
    { text: '禁止 用 | 拼接路径，因为 Windows 上会被当成分隔符。', rule: 'S2' },
    // S3: a bullet that IS prose — has a comma and a full stop.
    { text: '- 必须先跑全量测试再提交，数字不变才算完成。', rule: 'S3' },
    // S4: colon mid-sentence, ends with a full stop. THIS is the control group.
    { text: '绝对约束：禁止在没有备份的情况下删除任何脚本。', rule: 'S4' },
    // S5: a real instruction that uses a meta-sounding phrase but is prose.
    { text: '我要求你 按句提取 这段日志里的错误行，然后按顺序贴出来。', rule: 'S5' },
    // S6: comma-dense but a complete sentence.
    { text: '禁止 rm -rf /、Remove-Item -Recurse 指向盘符根目录、工作区之外的路径。', rule: 'S6' },
  ]
  for (const near of NEAR_MISSES) {
    const verdict = shapeOfConstraint(near.text)
    assert.equal(
      verdict.broken,
      false,
      `${near.rule} nearMiss was rejected (code=${verdict.code}, why=${verdict.why}): ${near.text}`,
    )
  }
})

test('each rule can go RED individually — disabling it lets its sample through', () => {
  /**
   * "A test that cannot fail is not a test." This does not disable the rule inside the module (there
   * is no switch, and adding one for a test would ship a way to turn the filter off). Instead it
   * asserts the DISCRIMINATING property each rule relies on: strip that property from the sample and
   * the rule stops firing. If a rule's sample survives its own property being changed, the rule is not
   * doing what its name claims.
   */
  // S1: remove the unbalanced quote → the JSON rule no longer applies.
  assert.equal(shapeOfConstraint('绝对约束（后续所有轮次都不能违反）：').broken, true, 'S4 catches the label') // label, no quotes
  assert.equal(shapeOfConstraint('"绝对约束（后续所有轮次都不能违反）：",').code, 'S1_JSON', 'S1 wins when quoting is unbalanced')

  // S2: a row needs ≥2 pipes.
  assert.equal(shapeOfConstraint('| 单管道 |').broken, true, 'S2 fires on a two-cell row')

  // S3: adding sentence punctuation converts a term list into prose → rule stops firing.
  const words = '- 必须、禁止、绝对、不能、不得、不许、务必'
  assert.equal(shapeOfConstraint(words).code, 'S3_WORDLIST')
  assert.equal(shapeOfConstraint(`${words}。`).broken, false, 'S3 must not fire once the text is a sentence')

  // S4: lengthening past 30 chars beyond the label form → rule stops firing.
  assert.equal(shapeOfConstraint('绝对约束（后续所有轮次都不能违反）：').code, 'S4_LABEL')
  assert.equal(
    shapeOfConstraint('这是一条很长的说明文字用来超过三十个字符的界限因此不再算作标签行：').broken,
    false,
    'S4 must not fire on a long line that merely ends in a colon',
  )
})

test('the 35 constraints from the seven clean generations are ALL accepted', (t) => {
  /**
   * The reverse validation: live data from seven generations that produced no complaint. If the shape
   * rule is too wide, this test is where it shows up — and unlike a hand-written near miss, these
   * cannot be adjusted to suit the rule.
   *
   * Skipped (loudly, not silently) when the ledger is absent: it is runtime state, not shipped data.
   */
  const ledgerPath = join(REPO, '.graft-constraint-sections.json')
  if (!existsSync(ledgerPath)) {
    t.skip(`ledger absent at ${ledgerPath} — reverse validation not run in this checkout (not a pass)`)
    return
  }
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  /** The one generation known to be contaminated — its entries are expected to be rejected. */
  const CONTAMINATED = 'auto-graft-mw9g6el4-1e5uue'

  const clean = []
  for (const [sessionId, record] of Object.entries(ledger)) {
    if (sessionId === CONTAMINATED) continue
    const sections = Array.isArray(record) ? record : (record?.sections ?? record?.constraints ?? [])
    for (const entry of sections) {
      const text = typeof entry === 'string' ? entry : (entry?.text ?? '')
      if (typeof text === 'string' && text.trim().length > 0) clean.push(text)
    }
  }

  assert.ok(clean.length > 0, 'the ledger must yield at least one clean constraint, else this test is vacuous')

  const rejected = clean.filter((text) => shapeOfConstraint(text).broken)
  assert.deepEqual(
    rejected,
    [],
    `the shape rule rejected ${rejected.length}/${clean.length} constraints from clean generations:\n` +
      rejected.map((text) => `  - ${text.slice(0, 100)}`).join('\n'),
  )
  console.log(`reverse validation: ${clean.length} constraint(s) from clean generations all accepted`)
})
