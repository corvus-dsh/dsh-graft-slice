/**
 * ── v357：S6 第二簇 —— `nudgePanelState` 搬进 `core/nudge-panel.ts` ────────────────────────────────
 *
 * 三条判据同形：位置、无新内容、行为不变（源码模块）。
 *
 * 这一簇是「面板为什么没响」的唯一回答者，所以它的语义是**区分**，不是汇总：
 *
 *   `already-nudged`           本轮已经说过 —— 沉默是**正确**的
 *   `threshold`                比值到了线上 —— 沉默才是缺陷
 *   `predicted`                还没到线，但预测会越线（第 2 层）
 *   `forced-cut-unannounced`   有强制切待宣布、却从没送过预警 —— 这是第 3 层存在的理由，
 *                              也是交接里唯一说得出「未经预警」的那个理由
 *   `predicted-unavailable`    水位/阈值缺失，预测不可得
 *   `below-both`               两条线都没到
 *
 * 一个只印 `warnAt`/`hardAt` 的面板会让前三种**看起来一模一样**。这条判据就钉这个。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE_REL = 'src/core/nudge-panel.ts'
const MODULE = join(ROOT, 'src', 'core', 'nudge-panel.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')

const { nudgePanelState } = await import('../src/core/nudge-panel.ts')
const state = await import('../src/core/state.ts')

const clearState = () => {
  state.nudgeDeliveredAt.clear()
  state.nudgeSamples.clear()
  state.forcedCutMarks.clear()
  state.modelDrivenNudgeTurns.clear()
}

test('v357 ①: the declaration lives in the new module, and index.ts IMPORTS it without widening the surface', () => {
  assert.ok(moduleText.includes('export function nudgePanelState('),
    '① 新模块必须是 `export function` —— ESM 没有隐式共享作用域，不导出 index.ts 无从 import')
  assert.ok(!indexText.includes('function nudgePanelState('), '① index.ts 里不得再有声明')
  assert.ok(indexText.includes("import { nudgePanelState } from './core/nudge-panel.js'"), '① index.ts 必须从新模块导入')

  /**
   * ── 这一条是**反向**的：不许 re-export ──────────────────────────────────────────────────────────
   *
   * `nudgePanelState` 在搬动前是模块私有的（`function`，不是 `export function`），实测**不在**
   * `.export-surface.json` 里。搬动时「顺手」给它加一行 `export { nudgePanelState }` 会让公开面
   * 从 223 悄悄变成 224 —— 那不是纯移动，是把一个内部函数发布出去。
   *
   * 判据因此断言**没有**那一行，而不是有。
   */
  assert.ok(!indexText.includes('export { nudgePanelState }'),
    '① 不得 re-export：它不在导出面上，加一行就是把公开面从 223 扩到 224')
  assert.ok(!indexText.includes('export type { nudgePanelState'), '① 同上')
})

test('v357 ②: every non-plumbing line in the new module came from the pre-move index.ts', () => {
  const addingCommits = execFileSync(
    'git',
    ['log', '--diff-filter=A', '--format=%H', '--', MODULE_REL],
    { cwd: ROOT, encoding: 'utf8' },
  ).split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const introducing = addingCommits.pop()
  const baselineRev = introducing === undefined ? 'HEAD' : `${introducing}^`
  const before = execFileSync('git', ['show', `${baselineRev}:src/index.ts`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  const beforeCount = new Map()
  for (const line of before.split('\n').map((each) => each.trimEnd())) {
    beforeCount.set(line, (beforeCount.get(line) ?? 0) + 1)
  }

  const appeared = []
  for (const line of moduleText.split('\n').map((each) => each.trimEnd())) {
    if (line.length === 0) continue
    if (line.startsWith('import ') || line.startsWith('export ')) continue
    const available = beforeCount.get(line) ?? 0
    if (available === 0) {
      appeared.push(line)
      continue
    }
    beforeCount.set(line, available - 1)
  }

  assert.deepEqual(appeared, [],
    `② 这些行在新模块里出现，但 ${baselineRev} 的 index.ts 里没有（＝新增内容）：\n  ${appeared.slice(0, 10).join('\n  ')}`)
})

test('v357 ③: the five nudge reasons stay DISTINGUISHABLE (that distinction is the whole panel)', () => {
  const watermark = { tokens: 900, contextWindow: 1000, ratio: 0.9 }
  const thresholds = { warnAt: 0.7, hardAt: 0.9 }
  const session = 'v357-session'

  clearState()
  assert.equal(nudgePanelState('', watermark, thresholds, 1), undefined,
    '③ 空 sessionId ⇒ undefined（没有会话就没有面板）')
  assert.equal(nudgePanelState(session, undefined, undefined, 1), undefined,
    '③ 什么都没有 ⇒ undefined；「不需要报告」与「报告 0」必须不同')

  /** (1) above both lines, nothing said yet ⇒ threshold. */
  const fire = nudgePanelState(session, watermark, thresholds, 1)
  assert.equal(fire.nudgeReason, 'threshold', '③ 到线且没说过 ⇒ threshold')
  assert.equal(fire.nudgeDeliveredAt, undefined, '③ 没送过预警就不该有送达时刻')

  /** (2) the same numbers, but this turn already spoke ⇒ already-nudged (silence is CORRECT). */
  state.modelDrivenNudgeTurns.set(session, 1)
  const paced = nudgePanelState(session, watermark, thresholds, 1)
  assert.equal(paced.nudgeReason, 'already-nudged', '③ 本轮已说过 ⇒ already-nudged，而不是 threshold')
  state.modelDrivenNudgeTurns.clear()

  /** (3) a forced cut is pending and no nudge was ever delivered ⇒ the ONE reason that says 「未经预警」. */
  state.forcedCutMarks.set(session, { ratio: 0.57, warned: false })
  const unannounced = nudgePanelState(session, watermark, thresholds, 1)
  assert.equal(unannounced.nudgeReason, 'forced-cut-unannounced',
    '③ 有强制切、没送预警 ⇒ forced-cut-unannounced（第 3 层存在的理由）')
  assert.equal(unannounced.forcedCutPending.ratio, 0.57, '③ 强制切的比值必须被印出来')
  state.forcedCutMarks.clear()

  /** (4) below both lines ⇒ below-both, and it must not be confused with a missing measurement. */
  const low = nudgePanelState(session, { tokens: 10, contextWindow: 1000, ratio: 0.01 }, thresholds, 1)
  assert.equal(low.nudgeReason, 'below-both', '③ 两条线都没到 ⇒ below-both')

  /**
   * (5) not measurable ⇒ predicted-unavailable, NOT below-both.
   *
   * 实测：**四样东西全空时函数返回 `undefined`**（`delivered === undefined && ring.length === 0 &&
   * mark === undefined && watermark === undefined` 的提前返回）。我第一版直接拿全空输入去要
   * `predicted-unavailable`，拿到的是 `undefined` —— 那是**实现早就写明**的语义（「没什么可报」），
   * 不是缺陷。要走到 `predicted-unavailable`，必须还有别的可报事实存在（这里给一条样本环）。
   */
  state.nudgeSamples.set(session, [{ seq: 1, tokens: 10 }, { seq: 2, tokens: 20 }])
  const unavailable = nudgePanelState(session, undefined, undefined, 1)
  assert.equal(unavailable.nudgeReason, 'predicted-unavailable',
    '③ 量不到 ⇒ predicted-unavailable；把它报成 below-both 就是「没量」冒充「没事」')
  assert.equal(unavailable.warnAt, null, '③ 阈值缺失时 warnAt 是 null，而不是被编成 0')
  state.nudgeSamples.clear()

  /** (6) delivered ⇒ the ratio is carried, and a reset after delivery is a separate fact. */
  state.nudgeDeliveredAt.set(session, { ratio: 0.72, resetAfter: true })
  const delivered = nudgePanelState(session, watermark, thresholds, 1)
  assert.equal(delivered.nudgeDeliveredAt, 0.72, '③ 送达时刻（比值）必须保留')
  assert.equal(delivered.nudgeResetAfterDelivery, true,
    '③ 「送达后上下文被重置」是独立事实，不能与「送达了」合并成一句')

  clearState()
})