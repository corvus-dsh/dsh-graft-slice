/**
 * ── v349：拆巨石的目标必须是**可达的**，地板必须写出来且与实测一致 ────────────────────────────────
 *
 * 病：计划写「`index.ts` < 4,000 行」，而按「一次一簇、只搬函数」的现行主线**永远到不了**：
 *
 *   index.ts            14,736
 *   apply（容器，冻结）   2,941
 *   其余 184 个顶层函数    ~8,000（会被搬走）
 *   ⇒ 全部搬走之后        6,824  ← 地板 = apply + 模块级
 *
 * 而每一轮都会报告「又降了」，读者因此把「在接近目标」当成事实。**一个算术上不可达的目标不是目标，
 * 是一句愿望**——它每天都在给「继续搬」发通行证，却永远不告诉任何人还差多少、以及那部分只能用另一种
 * 动作拿到。
 *
 * ── ② 为什么改成「算出来再比」而不是钉一个常数 ──────────────────────────────────────────────────
 *
 * 第一版把 `6,907` / `3,062` / `3,845` 写死在断言里，于是 S3（把 4 个体内声明提到模块级）一跑就红：
 * `apply` 少了 121 行、地板跟着降。**那不是回归，是三个常数过期了。**
 *
 * 钉常数会让判据在每次正确的搬动后变红，而人是会把它改宽的 —— 改成「从清单算出来、再要求文档与它相等」
 * 之后，判据只反对**文档与事实不一致**，不反对事实本身前进。
 *
 * 判据：
 *   ① TD-1 的退出条件必须是**两段式**：段一 ≤13,300、段二 `apply` ≤1,200；
 *   ② 地板必须写进 TD-1，**且等于从清单算出的值**（apply + 模块级），算式里的两个加数都要写出；
 *   ③ **负向**：正文里不得出现无段二前提的「< 4,000」目标；
 *   ④ 量具口径必须写清（编译器 / 顶层数 / 嵌套数），否则地板不可复现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-assertion.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ARCH = join(ROOT, 'ARCHITECTURE.md')
const MANIFEST = join(ROOT, 'docs', 'index-manifest.json')

const arch = readFileSync(ARCH, 'utf8')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

/** The floor, derived from the manifest the same way the plan derives it. */
const floorOf = (data) => {
  const apply = data.units.find((unit) => unit.name === 'apply')
  assert.ok(apply !== undefined, 'apply 必须在清单里')
  const applySpan = apply.end - apply.line + 1
  const movable = data.units
    .filter((unit) => unit.top && unit.name !== 'apply')
    .reduce((sum, unit) => sum + (unit.end - unit.line + 1), 0)
  const moduleLevel = data.measured.lines - applySpan - movable
  return { applySpan, movable, moduleLevel, floor: applySpan + moduleLevel }
}

const withCommas = (value) => value.toLocaleString('en-US')

test('v349 ①: TD-1 states a TWO-STAGE target, because one stage cannot reach the old number', () => {
  assert.match(arch, /段一（叶子簇）[^|]*≤ ?13,?300/u, '① 段一必须写明 `index.ts ≤ 13,300`')
  assert.match(arch, /段二（拆 `apply`）[^|]*≤ ?1,?200/u, '① 段二必须写明 `apply ≤ 1,200`')
  assert.match(arch, /两段式/u, '① TD-1 必须自己说明这是两段式目标，而不是一个数字')
})

test('v349 ②: the FLOOR is written down AND equals the measured arithmetic', () => {
  const { applySpan, moduleLevel, floor } = floorOf(manifest)

  /**
   * The identity first: floor = apply + module-level. This is the claim the document makes, so it is the
   * claim the document is held to — not a number copied from a past run.
   */
  assert.ok(moduleLevel > 0, '② 模块级行数必须为正')
  assert.equal(applySpan + moduleLevel, floor, '② 地板恒等式：apply + 模块级')

  const floorText = withCommas(floor)
  assert.match(arch, new RegExp(`地板[\\s\\S]{0,160}?${floorText.replace(',', ',?')}`, 'u'),
    `② TD-1 必须写出地板 ${floorText}（从清单实测）；文档里的数字与实测不一致就是过期`)

  /** Both addends must be named, or the next reader cannot tell whether the floor is still true. */
  assert.match(arch, new RegExp(`${floorText.replace(',', ',?')}[\\s\\S]{0,200}?${withCommas(applySpan).replace(',', ',?')}`, 'u'),
    `② 算式必须写出 apply 这个加数（实测 ${withCommas(applySpan)}）`)
  assert.match(arch, new RegExp(withCommas(moduleLevel).replace(',', ',?'), 'u'),
    `② 算式必须写出模块级这个加数（实测 ${withCommas(moduleLevel)}）`)
})

test('v349 ③ (negative half): no UNQUALIFIED `< 4,000` goal may remain', () => {
  /**
   * The forbidden sentence is the one that reads as reachable today: a bare "index.ts < 4,000" with no
   * mention that it requires 段二. With the current strategy the file stops at the floor, so the
   * sentence is false AS AN INSTRUCTION.
   *
   * Comments are stripped first — this criterion is ABOUT the prose, so it must not be defeated by a
   * quoted example of the bad sentence (the same lesson as §四十六).
   */
  const body = stripComments(arch)
  const lines = body.split('\n')
  const offenders = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/(< ?4,?000|≤ ?4,?000)/u.test(lines[i])) continue
    const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n')
    if (/段二|拆 `?apply`?|apply.*1,?200/u.test(window)) continue
    offenders.push(`L${i + 1}: ${lines[i].trim().slice(0, 140)}`)
  }
  assert.deepEqual(offenders, [],
    `③ 出现无段二前提的 <4,000 目标（读者会以为今天可达）：\n  ${offenders.join('\n  ')}`)
})

test('v349 ④: the instrument is named, so the floor is reproducible', () => {
  assert.match(arch, /index-ratchet\.mjs/u, '④ TD-1 必须点名量具')
  assert.match(arch, new RegExp(`顶层 ?\\*{0,2}${manifest.measured.functions}(?![0-9])`, 'u'),
    `④ 顶层函数数（${manifest.measured.functions}）必须写出来`)
  assert.match(arch, new RegExp(`嵌套 ?\\*{0,2}${manifest.measured.nested}\\*{0,2}|${manifest.measured.nested} 个体内声明`, 'u'),
    `④ 嵌套数（${manifest.measured.nested}）必须写出来，否则顶层数说明不了自己排除了什么`)
  assert.match(arch, /编译器口径|用编译器|编译器的 ?`?getStart/u, '④ 必须说明这是编译器口径，不是花括号口径')
})
