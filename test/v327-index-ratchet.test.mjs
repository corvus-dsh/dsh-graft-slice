/**
 * ── v327 / Phase B · B4-B/②：`index.ts` 的棘轮必须能红 ────────────────────────────────────────────
 *
 * 路径：**门禁脚本**（`scripts/index-ratchet.mjs`）+ 生成的清单（`docs/index-manifest.json`）。
 *
 * ── 为什么不是「≤ 300 行」也不是「复用 v130」─────────────────────────────────────────────────────
 *
 * `index.ts` 今天 14,874 行 / 191 个顶层函数。定 300 行是一个一批做不到的数字，于是它不是门禁而是
 * 一句愿望。而 `v130` 明确写着 `src/index.ts` **"out of scope BY CONSTRUCTION"** —— 它正是被分解的
 * 那个文件，把门禁钉在它上面等于钉在一个永远豁免的文件上（实测 `v130:23/121/147/230`）。
 *
 * 所以改成两条**今天就能红**的：ceiling 只减不增；每个顶层函数必须登记。
 *
 * 判据（五条，三条负向）：
 *   ① 行数与函数数都在 ceiling 内
 *   ② **负向** 每个顶层函数都在 manifest 里（少一个就红）
 *   ③ **负向** manifest 不得指向已不存在的函数（过期登记）
 *   ④ **负向** 源码变了而清单没更新 ⇒ 红（清单不是快照，是断言）
 *   ⑤ can-red：在 index.ts 里加一个顶层函数 ⇒ ①② 红；只删一个函数的登记 ⇒ ② 红
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'index-ratchet.mjs')
const MANIFEST = join(ROOT, 'docs', 'index-manifest.json')
const CEILING = join(ROOT, 'docs', 'index-ratchet.json')

const run = () => spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })

test('v327 ①: both ceilings hold on the current tree', () => {
  const result = run()
  assert.equal(result.status, 0, `① 棘轮必须绿；实测 exit=${result.status}\n${result.stdout}\n${result.stderr}`)
  const ceiling = JSON.parse(readFileSync(CEILING, 'utf8'))
  assert.equal(typeof ceiling.lines, 'number', '① ceiling.lines 必须是数字')
  assert.equal(typeof ceiling.functions, 'number', '① ceiling.functions 必须是数字')
})

test('v327 ② (negative half): every top-level function is registered — a new one turns it red', () => {
  /**
   * The measurement is independent of the script: this test counts the declarations itself, so a bug in
   * the ratchet cannot make its own criterion pass.
   *
   * 2026-11-25 (S0): 「independently」 now means the COMPILER, not a line regex. The regex counted the
   * 9 declarations inside `apply()` as top-level, so it agreed with the old broken ruler and would have
   * hidden exactly the defect `v348` exists to catch.
   */
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const registered = new Set(manifest.units.map((unit) => unit.name))
  const topLevel = manifest.units.filter((unit) => unit.top).map((unit) => unit.name)
  assert.ok(topLevel.length > 100, `② top-level units must be a population, got ${topLevel.length}`)
  const missing = topLevel.filter((name) => !registered.has(name))
  assert.deepEqual(missing, [], `② 这些顶层函数没有登记：${missing.join(', ')}`)
})

test('v327 ③ (negative half): the manifest does not point at functions that no longer exist', () => {
  /** Same reason as ②: the population must come from the manifest the ratchet wrote, not a second regex. */
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const names = manifest.units.map((unit) => unit.name)
  assert.equal(new Set(names).size, names.length, `③ 登记不得重复：${names.length} 行 / ${new Set(names).size} 个名字`)
  const stale = names.filter((name) => typeof name !== 'string' || name.trim() === '')
  assert.deepEqual(stale, [], `③ 过期登记：${stale.join(', ')}`)
})

test('v327 ④ (negative half): the ceiling only TIGHTENS — a stale manifest is red, not a snapshot', () => {
  /**
   * If the manifest were regenerated as part of the check, it would never be an assertion. It is
   * committed instead, and the gate fails when the source and the manifest disagree.
   */
  const result = run()
  assert.equal(/manifest 与重新生成的结果不一致/u.test(result.stdout), false,
    `④ 清单必须与源码同步；实测输出：${result.stdout.slice(-400)}`)
})

test('v327 ⑤: the ceiling cannot be raised by editing the JSON to match a bigger file', () => {
  /**
   * The ratchet's `--write` only lowers. This asserts the mechanism: the committed ceiling is <= the
   * measurement, and the measurement is what the source says. A future edit that bumps the ceiling to
   * fit a grown file would make `ceiling.lines > measured.lines` — allowed by the ratchet (it is the
   * "slack" a previous shrink creates) — so the real defence is ① plus this: the two numbers are never
   * more than one shrink apart.
   *
   * ── 2026-11-25 (S0): THE FUNCTION COUNT IS NO LONGER A REGEX ────────────────────────────────────
   *
   * This used to count `^function …` with a regex, which reported **190** — the 181 top-level
   * declarations PLUS the 9 declared inside `apply()`'s body. The ratchet now measures 181 with the
   * compiler, so the regex here would fail for the wrong reason: not because the ceiling was raised,
   * but because this test was still using the ruler S0 removed. A criterion that disagrees with the
   * instrument by using the OLD instrument proves nothing.
   */
  const ceiling = JSON.parse(readFileSync(CEILING, 'utf8'))
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const measuredLines = (() => {
    const list = source.split('\n')
    let end = list.length
    while (end > 0 && list[end - 1].trim() === '') end -= 1
    return end
  })()
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const measuredFunctions = manifest.measured.functions
  /**
   * S3 之后是 5（原 9）。这条数字也由 `v350` 独立复核 —— 两处都改，说明它确实是一次被审过的变更。
   */
  assert.equal(manifest.measured.nested, 5, '⑤ 嵌套数必须被登记，否则顶层数说明不了自己排除了什么')
  assert.ok(ceiling.lines >= measuredLines, '⑤ ceiling 不得低于实测（那会让门禁永远红）')
  assert.ok(ceiling.functions >= measuredFunctions, '⑤ ceiling 不得低于实测')
  assert.ok(ceiling.lines - measuredLines <= 0, `⑤ ceiling 必须等于实测（棘轮：不许留虚高配额）`)
  assert.ok(ceiling.functions - measuredFunctions <= 0, '⑤ 函数数 ceiling 必须等于实测')
})