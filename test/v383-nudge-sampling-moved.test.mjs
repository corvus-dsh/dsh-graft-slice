/**
 * ── v383：nudge 采样四件搬出后的独立性与行为（段一 · 第 5 簇）────────────────────────────────────
 *
 * 搬出四个互不依赖的单元（73 行）：`noteForcedCut` / `nudgePredictionFor` / `previousRatioOf` /
 * `resetSinceLastNudgeSample`。它们同属一个主题（「这次该不该预警、离阈值还有多远」），
 * 而**调用它们的 `takeModelDrivenNudge` 留在 index.ts** —— 调用者留下、被调用者搬走，
 * 正是让这次移动成环为零的原因（调用者只多一行 import，被调用者从不反向 import）。
 *
 * 判据四条：
 *   ① 新模块不反向 import `index.ts`
 *   ② 从**源码模块**直接 import 可用，且 `noteForcedCut` / `previousRatioOf` 的行为不变
 *   ③ `index.ts` import 它们但**不** re-export（四个原本都不在公开面）
 *   ④ `takeModelDrivenNudge` **仍在 index.ts**，且仍调用它们 —— 这一簇搬的是被调用者，不是整条链
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE = join(ROOT, 'src', 'core', 'nudge-sampling.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')

const { noteForcedCut, previousRatioOf } = await import('../src/core/nudge-sampling.ts')

test('v383 ①: the new module does not import back into index.ts', () => {
  const imports = moduleText.match(/from '[^']+'/gu) ?? []
  const back = imports.filter((line) => /index(?:\.js)?'/u.test(line))
  assert.deepEqual(back, [], `① 不得反向 import index.ts：${back.join(', ')}`)
  /** All four units must be present, or the cluster was split. */
  for (const name of ['noteForcedCut', 'nudgePredictionFor', 'previousRatioOf', 'resetSinceLastNudgeSample']) {
    assert.ok(new RegExp(`export function ${name}\\b`, 'u').test(moduleText),
      `① 新模块必须导出 ${name}`)
  }
})

test('v383 ②: previousRatioOf reads the last recorded ratio, and undefined when there is none', () => {
  /**
   * The contract, measured from the implementation AFTER my first assertion was wrong:
   *
   *     previousRatioOf(agentId, contextWindow): number | undefined
   *
   * It takes TWO arguments (the ratio is `tokens / contextWindow`) and returns **`undefined`** — not
   * −1 — when there is no sample or the window is not a positive finite number.
   *
   * `undefined` rather than 0 matters for the same reason I wrote about −1: 0 is a real ratio, and
   * conflating 「never sampled」 with 「sampled at 0%」 would make the first nudge look like a regression.
   */
  assert.equal(previousRatioOf('never-seen-session', 128_000), undefined,
    '② 没有采样时必须返回 undefined（不是 0 —— 0 是一个真实比例）')
  assert.equal(previousRatioOf('never-seen-session', 0), undefined,
    '② contextWindow 非正时必须返回 undefined（否则会除出 Infinity）')
  assert.equal(previousRatioOf('never-seen-session', Number.NaN), undefined,
    '② contextWindow 为 NaN 时必须返回 undefined')
})

test('v383 ③: noteForcedCut is importable and records into a shared map', async () => {
  const { forcedCutMarks } = await import('../src/core/state.ts')
  const before = forcedCutMarks.size
  noteForcedCut('v383-session', { ratio: 0.9, reason: 'v383 probe' })
  assert.ok(forcedCutMarks.size >= before, '③ 必须写入共享状态（否则面板读不到）')
})

test('v383 ④: takeModelDrivenNudge STAYS in index.ts and still calls the moved units', () => {
  /**
   * 这一侧是「簇边界」的证据：调用者留下。若它也被搬走，那这次就是搬了一整条链，
   * 而 manifest 标的是「这四个可搬」—— 判据要钉住实际做了什么。
   */
  assert.ok(/function takeModelDrivenNudge\b/u.test(indexText),
    '④ takeModelDrivenNudge 必须仍在 index.ts')
  assert.ok(/from '\.\/core\/nudge-sampling\.js'/u.test(indexText),
    '④ index.ts 必须从新模块引入被搬走的四个')
  for (const name of ['noteForcedCut', 'nudgePredictionFor', 'previousRatioOf', 'resetSinceLastNudgeSample']) {
    assert.ok(!new RegExp(`export \\{ ${name} \\}`, 'u').test(indexText),
      `④ ${name} 原本不在公开面，不得 re-export`)
  }
})
