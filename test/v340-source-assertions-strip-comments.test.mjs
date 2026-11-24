/**
 * ── v340 / P1：对源码文本做断言的判据，必须先剥注释（lead §四十五.2）────────────────────────────
 *
 * 路径：**共享实现**（`test/source-assertion.mjs` 的 `stripComments`）+ **门禁**
 * （`scripts/check-source-assertions.mjs`）。
 *
 * ── 事故：同一形状四次 ────────────────────────────────────────────────────────────────────────
 *
 *   1. `check-doc-claims` 扫到自己描述的规则；
 *   2. `v329 ③` 的 `/O/u` 匹配到 `a**o**uto is ON`（注释，不是调用点）；
 *   3. `v336 ①` / `v337 ①` 红在它们**自己的文件头**上 —— 而那个文件头必须引用它禁止的形状；
 *   4. `v339 ③` 反而**绿**了：机制已被删掉，但它读到了上方注释里的引用。
 *
 * **前三次靠人看出来，第四次也靠人。三次人工发现 ⇒ 必须变成判据。**
 *
 * ── 判据（四条，三条负向）──────────────────────────────────────────────────────────────────────
 *   ① 共享工具存在，且对「注释里有目标串」的样例**不命中**
 *   ② **负向** 同一份文本**不剥注释**时必须命中 —— 证明 ① 不是因为它什么都匹配不到
 *   ③ **负向** 字符串字面量里的同样文本**不得**被剥掉（注释与数据必须区分）
 *   ④ **负向** 行号保持：剥离后行数与原文相同（否则失败会把读者指到错的行）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { stripComments } from './source-assertion.mjs'

/** A shape that must never be matched when it only appears in a comment. */
const TARGET = /forbiddenCall\(/gu

const SAMPLE = [
  '/* the file header must be able to QUOTE `forbiddenCall(` — that is the point */',
  'const keep = 1',
  '// a line comment mentioning forbiddenCall( too',
  "const data = 'forbiddenCall('",
].join('\n')

test('v340 ①: a commented-out occurrence does not match after stripping', () => {
  const code = stripComments(SAMPLE)
  /**
   * Two occurrences are in comments (block header + line comment) and MUST disappear.
   * The third is inside a STRING — it is data the code uses, so it stays. Asserting the COUNT
   * rather than mere absence keeps ① from passing on a function that returns ''.
   */
  const matches = [...code.matchAll(TARGET)]
  assert.equal(matches.length, 1, `① 剥注释后只应剩下字符串里那一处，实测 ${matches.length} 处`)
})

test('v340 ② (negative): the SAME sample without stripping DOES match — ① is not vacuous', () => {
  /**
   * Without this half, `stripComments` could return an empty string and ① would still pass.
   * The pair is what makes ① meaningful.
   */
  const raw = [...SAMPLE.matchAll(TARGET)]
  assert.equal(raw.length, 3, `② 原文应有 3 处（注释 2 + 字符串 1），实测 ${raw.length}`)
  assert.ok(
    raw.length > [...stripComments(SAMPLE).matchAll(TARGET)].length,
    '② 剥注释必须真的减少命中数 —— 否则剥离没起作用',
  )
})

test('v340 ③ (negative): string literals are DATA, not comments — they must survive', () => {
  /**
   * The cheap implementation strips everything between quote characters too, which would make
   * every assertion about a user-facing string silently vacuous. A red line is written as a string
   * literal; a grepper must still see it.
   */
  const onlyString = "const redline = '工作目录红线：禁止 rm -rf /'\n"
  const code = stripComments(onlyString)
  assert.match(code, /工作目录红线/u, '③ 字符串里的文本必须保留 —— 它是代码在用的数据')
  assert.match(code, /rm -rf/u, '③ 同上：剥的只是注释')
})

test('v340 ④ (negative): stripping preserves every newline, so failures keep their line numbers', () => {
  const source = ['a', '/* multi', 'line', 'comment */', 'b', '// tail', 'c'].join('\n')
  const code = stripComments(source)
  assert.equal(
    code.split('\n').length,
    source.split('\n').length,
    '④ 剥注释不得改变行数 —— 否则断言失败时报告的行号是错的，读者会被指到别处',
  )
  assert.equal(code.split('\n')[0], 'a', '④ 第 1 行必须仍是 a')
  assert.equal(code.split('\n')[4], 'b', '④ 第 5 行必须仍是 b')
})
