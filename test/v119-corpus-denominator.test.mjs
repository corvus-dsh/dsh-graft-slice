/**
 * RULE 27 AS A TEST: a green result must prove it measured something.
 *
 * ── THE THREE EMPTY-SET GREENS THIS SESSION PRODUCED ────────────────────────────────────────────
 *
 * 1. `node --test` run in the wrong directory → `tests 0 / pass 0 / fail 0 / exit 0`, which reads as
 *    a pass and was nearly reported as one.
 * 2. The corpus probe filtered `typeof entry === 'string'` while every entry is an OBJECT
 *    `{file, seq, type, text}` → all 9,153 skipped → "0 false rejections" reported, when the true
 *    number was 331 rejected (11 of them real false positives in the extraction window).
 * 3. An acceptance script whose `existsSync(corpus)` was false printed a SKIP that looked like a pass.
 *
 * So the corpus-based checks below assert their DENOMINATOR before asserting their result. A check
 * with 0 inputs is not "clean"; it is "not measured".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { shapeOfConstraint } from '../src/core/constraint-shape.ts'

/**
 * Locate the corpus by WALKING UP, not by a fixed number of hops: the test directory depth is not a
 * contract, and a wrong hop count silently turns every check below into a no-op.
 */
function findCorpus() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let hop = 0; hop < 5; hop += 1) {
    const candidate = join(dir, '_scratch', 'real-texts.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const CORPUS = findCorpus()

test('corpus is present and READ THE RIGHT WAY (the bug that produced a false all-clear)', (t) => {
  assert.ok(CORPUS !== undefined, 'corpus NOT FOUND — this check measured nothing, which is a failure, not a pass')
  t.diagnostic('corpus: ' + CORPUS)

  const raw = JSON.parse(readFileSync(CORPUS, 'utf8'))
  assert.ok(Array.isArray(raw), 'the corpus is a JSON array')
  assert.ok(raw.length > 0, 'the corpus must not be empty — an empty corpus makes every check below vacuous')

  /**
   * THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. The probe wrote
   * `typeof entry === 'string'`, which is false for every entry, so the loop body never ran and the
   * result was `0 rejected` — a green light over nothing.
   */
  const stringEntries = raw.filter((entry) => typeof entry === 'string').length
  assert.equal(stringEntries, 0, 'entries are OBJECTS, not strings — a `typeof === string` filter silently skips all of them')

  const withText = raw.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.text === 'string').length
  assert.equal(withText, raw.length, `every entry must expose .text; ${raw.length - withText} did not`)
  t.diagnostic(`corpus: ${raw.length} entries, all with a string .text`)
})

test('corpus: the extraction window denominator is non-zero, and every rejection is classified', (t) => {
  assert.ok(CORPUS !== undefined, 'corpus NOT FOUND — this check measured nothing, which is a failure, not a pass')
  const raw = JSON.parse(readFileSync(CORPUS, 'utf8'))
  const texts = raw.map((entry) => entry.text).filter((text) => typeof text === 'string')
  const window = texts.filter((text) => {
    const length = text.trim().length
    return length >= 10 && length <= 800
  })

  // Denominator first.
  assert.ok(window.length > 1000, `the extraction window must be a real population, got ${window.length}`)
  t.diagnostic(`window: ${window.length} of ${texts.length} texts`)

  const rejected = window.filter((text) => shapeOfConstraint(text).broken)
  t.diagnostic(`rejected in window: ${rejected.length}`)

  /**
   * The class breakdown, asserted as SHAPE rather than as a magic number, so the test stays true when
   * the corpus grows while still failing if a class appears that nobody has classified.
   */
  const byCode = new Map()
  for (const text of rejected) {
    const code = shapeOfConstraint(text).code
    byCode.set(code, (byCode.get(code) ?? 0) + 1)
  }
  const known = new Set(['S1_JSON', 'S2_TABLE', 'S3_WORDLIST', 'S4_LABEL', 'S5_META', 'S6_SEPARATORS'])
  for (const code of byCode.keys()) {
    assert.ok(known.has(code), `unexpected rejection code ${String(code)} — classify it before shipping`)
  }

  /**
   * S4_LABEL is the largest class (bare labels like `Team message from X:`). A real sentence that ends
   * in a colon would be a FALSE POSITIVE hiding in that class, so it is checked structurally: the rule
   * only fires when the text carries no clause punctuation. If that ever changes, this catches it.
   */
  const s4 = rejected.filter((text) => shapeOfConstraint(text).code === 'S4_LABEL')
  const s4WithProse = s4.filter((text) => /[，。；！？]/u.test(text.trim()))
  assert.deepEqual(
    s4WithProse.map((text) => text.trim().slice(0, 60)),
    [],
    'S4_LABEL rejected a text with clause punctuation — that is a real sentence, not a label',
  )
  t.diagnostic(`S4_LABEL: ${s4.length} rejected, ${s4WithProse.length} of them carry clause punctuation`)
})

test('the S1 fix holds on the corpus: rules that quote a JSON key survive', (t) => {
  assert.ok(CORPUS !== undefined, 'corpus NOT FOUND — this check measured nothing, which is a failure, not a pass')
  const raw = JSON.parse(readFileSync(CORPUS, 'utf8'))
  const texts = raw.map((entry) => entry.text).filter((text) => typeof text === 'string')

  // The two shapes the review proved were being LOST. They are also asserted directly in
  // v118-s1-json-anchor; here the point is that the CORPUS path is exercised at all.
  const shapes = [
    '必须 在提交前确认 engines 里 "node": ">=22" 这一项没有降低。',
    '禁止 把 "kind": "plugin" 这种标记换成 user，那会伪造人类来源。',
  ]
  for (const text of shapes) {
    assert.equal(shapeOfConstraint(text).broken, false, `a real rule being dropped: ${text}`)
  }
  assert.ok(texts.length > 0, 'denominator check: the corpus must have been read')
})
