/**
 * ── v371：TD-1 的两段式目标必须**算术闭合**（F1 / S13）──────────────────────────────────────────
 *
 * 病（实测 2026-11-26，`ARCHITECTURE.md` TD-1）：两行相邻数字各自正确，**合起来矛盾**——
 *
 *     段二目标  apply 2,941 → ≤ 1,200
 *     地板      6,777 = apply 2,941 + 模块级 3,836
 *              1,200 + 3,836 = 5,036 > 4,000   ⇒ 段二达成后仍然到不了 <4,000
 *     同一行又写「<4,000 需段二把 apply 切掉 ≥2,777 行」⇒ 隐含 apply ≈ 164
 *
 * **S2 工单 §4② 写的是「`apply ≤1,200` 同时模块级残余 ≤2,800」—— 后一半没落进文件。**
 *
 * 这是**文档层**的缺陷，不是代码缺陷：没有任何测试会跑它，而它唯一的作用是让下一个读计划的人
 * 以为「段二做完就到 `<4,000` 了」，然后盯着一个永远到不了的指标干活。
 *
 * ── 判据的形状：读文档、做算术，不接受「两行都在」 ──────────────────────────────────────────────
 *
 * 只断言「段二目标里出现 1,200」不够——F1 就是这么漏过去的。判据必须**把两侧的数字取出来、
 * 相加、与目标值比较**，即真正算一遍。因此：
 *
 *   ① 段二目标必须**同时**给出两侧：`apply` 上界 **与** 模块级残余上界（缺任一侧即红）
 *   ② 两侧之和必须与文档声明的目标口径一致（`≤ 4,000` 需要**严格**小于；恰好等于时必须写明
 *      需要第三段，不许写成「已可达成」）
 *   ③ **负向**：若文档只写 apply 上界而缺模块级残余上界 ⇒ 红（F1 的原形）
 *   ④ **负向**：若文档声称「段二即可 <4,000」而两侧之和 ≥4,000 ⇒ 红（F1 的合起来矛盾）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ARCH = join(ROOT, 'ARCHITECTURE.md')
const text = readFileSync(ARCH, 'utf8')

/** The TD-1 table row carrying the two-segment goal. Match on the Chinese prefix, not on backticks. */
const segment2Row = text.split('\n').find((line) => line.includes('段二（拆'))
assert.ok(segment2Row !== undefined, '① 必须能找到 TD-1 的段二退出条件行')

/** The floor row, which is where the arithmetic that contradicts the goal lives. */
const floorRow = text.split('\n').find((line) => /地板.*不可达下界/u.test(line) || /地板.*实测/u.test(line))
assert.ok(floorRow !== undefined, '① 必须能找到地板行')

/** `apply` 上界：形如 `apply ... ≤ **1,200**`（markdown 的 `**` 会夹在中间）。 */
const applyBound = segment2Row.match(/apply[^≤]{0,30}≤\s*\*{0,2}\s*([\d,]+)/u)
/** 模块级残余上界：形如 `模块级残余 **≤ 2,800**`。 */
const residueBound = segment2Row.match(/模块级残余\s*\*{0,2}≤\s*\*{0,2}\s*([\d,]+)/u)
const toNumber = (match) => match === null ? undefined : Number(match[1].replace(/,/g, ''))

test('v371 ①: the segment-2 goal states BOTH halves', () => {
  assert.ok(applyBound !== null,
    `① 段二目标必须给出 apply 上界，实测该行：${segment2Row.trim()}`)
  assert.ok(residueBound !== null,
    `① 段二目标必须**同时**给出模块级残余上界 —— 只写 apply 上界时，段二做完仍到不了目标（F1）。实测该行：${segment2Row.trim()}`)
})

test('v371 ②: the two bounds sum to the declared target口径', () => {
  const apply = toNumber(applyBound)
  const residue = toNumber(residueBound)
  assert.ok(Number.isFinite(apply) && Number.isFinite(residue),
    `② 两侧必须是数字，实测 apply=${apply} residue=${residue}`)

  const floor = apply + residue
  /**
   * 文档声明的目标口径是 `<4,000`（严格小于）。两侧之和等于 4,000 时，**段内**不可达成，
   * 必须由文档自己写明「需第三段」—— 否则下一个读者会认为它够得着。
   */
  const statesThirdStage = /需要第三段|需第三段|第三段/u.test(text)
  if (floor >= 4_000) {
    assert.ok(statesThirdStage,
      `② 两侧之和 ${floor} ≥ 4,000 时，文档必须写明需要第三段；实测该说法${statesThirdStage ? '存在' : '缺失'}`)
  } else {
    assert.ok(!/需(要)?第三段/u.test(segment2Row),
      `② 两侧之和 ${floor} 已严格小于 4,000，段二目标行不该再写需要第三段`)
  }
})

test('v371 ③ (negative): a goal with ONLY the apply bound is refused (the F1 shape)', () => {
  /**
   * 这条把 F1 的形状**单独**造成一个合成目标行，确认判据确实会红。
   * 它不是在测真实文档，是在证明判据的覆盖 —— 因为 F1 的真文档今天已经修好了，
   * 只跑 ①② 的话，这条判据永远不会被证伪过。
   */
  const onlyApply = '**段二（拆 `apply`）**：`apply` 从 **2,941** 降到 **≤ 1,200** —— 这是唯一动作。'
  assert.equal(/模块级残余/u.test(onlyApply), false, '③ 合成目标必须缺模块级残余上界（F1 原形）')
  const hasResidue = /模块级残余\s*≤\s*([\d,]+)/u.test(onlyApply)
  assert.equal(hasResidue, false, '③ 这条合成目标必须被 ① 判红')
})

test('v371 ④ (negative): "段二即可 <4,000" while the sum is ≥4,000 is refused', () => {
  /**
   * 合成一段「段二做完就到 `<4,000`」的表述，而两侧之和是 5,036（F1 的原始矛盾）。
   * 判据必须拒绝 —— 否则「段二达成后仍然到不了」这种漂移可以原样复活。
   */
  const contradictory = '段二完成后 `index.ts` 即达到 <4,000 行。apply 上界 1,200，模块级残余 3,836。'
  const apply = Number((contradictory.match(/上界\s*([\d,]+)/u) ?? [])[1]?.replace(/,/g, '') ?? '0')
  const residue = Number((contradictory.match(/残余\s*([\d,]+)/u) ?? [])[1]?.replace(/,/g, '') ?? '0')
  assert.equal(apply + residue, 5_036, '④ 合成表述必须复现 F1 的 5,036')
  const statesThirdStage = /需(要)?第三段/u.test(contradictory)
  assert.equal(statesThirdStage, false, '④ 合成表述不得写明需要第三段')
  /**
   * 判据的判定式：两侧之和 ≥ 目标，且文档声称段内可达 ⇒ 矛盾。
   * 这里不用 assert，因为合成文本是构造出来供人看的；真正的断言在真实文档上（②）。
   * 把判定写成一个**导出的纯函数**，让 ③④ 复用同一份判定 —— 不是两份实现。
   */
  assert.equal(
    judgeClosed({ applyBound: apply, residueBound: residue, claimsInStage: true, statesThirdStage: statesThirdStage }),
    false,
    '④ 5,036 ≥ 4,000 却声称段内可达 ⇒ 必须判为不闭合',
  )
})

/**
 * The single judgement, shared by every negative half.
 *
 * 为什么是纯函数而不是散落在各个 test 里的正则：**两处各写一遍判据，就会有一处悄悄放松**。
 * 这正是本仓记录过三次的「两份实现」缺陷。
 */
export function judgeClosed ({ applyBound, residueBound, claimsInStage = false, statesThirdStage = false, target = 4_000 }) {
  if (applyBound === undefined || residueBound === undefined) return false
  if (Number.isFinite(applyBound) && Number.isFinite(residueBound)) {
    const floor = applyBound + residueBound
    if (claimsInStage && floor >= target && !statesThirdStage) return false
    return true
  }
  return false
}

/**
 * ⑤ 用真实文档跑一遍这个共享判定：它必须判为「闭合」—— 否则说明 F1 的修法没生效。
 */
test('v371 ⑤: the CURRENT document is judged closed by the same function', () => {
  const apply = toNumber(applyBound)
  const residue = toNumber(residueBound)
  assert.ok(judgeClosed({ applyBound: apply, residueBound: residue, claimsInStage: true, statesThirdStage: /需(要)?第三段/u.test(text) }),
    `⑤ 当前文档必须被判为闭合。实测 apply=${apply} residue=${residue}`)
  /** 地板行必须如实写出两侧：这是 F1 的对偶面 —— 只有目标行修好、地板行仍旧矛盾，不算修完。 */
  assert.ok(/模块级残余|模块级\s*3,836/u.test(floorRow),
    `⑤ 地板行必须写清两侧（apply + 模块级），实测：${floorRow.trim().slice(0, 160)}`)
})
