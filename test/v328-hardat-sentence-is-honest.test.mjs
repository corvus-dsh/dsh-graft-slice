/**
 * ── v328 / N4a：`lowered from 0.75 to 0.75` 是一句什么都没说的话 ──────────────────────────────────
 *
 * 路径：**公开状态读数**（`applyCompactionCeiling(...).compaction.reason`，面板与 `graft_debug_status`
 * 读的就是它）。
 *
 * MEASURED（本机 profile，M0）：`thresholdReason` 写着
 *
 *     hardAt lowered from 0.75 to 0.75 so the slice wins
 *
 * 宿主阈值 0.8 ⇒ `0.8 − 0.02 = 0.78` 高于我们的 0.75 ⇒ **什么都没被压低**，而句子用过去时宣布了一次调整，
 * 还附了理由。读它的人会以为 75% 那把刀动过。
 *
 * 这与 `source: 'off'` 同时指「确认没有」和「没看到」是同一个形状：**字段在，事实不在。**
 *
 * 判据（三条，两条负向）：
 *   ① 宿主线高于我方 hardAt ⇒ 文案必须说 `unchanged`，**不得**出现 `lowered`
 *   ② **负向** 真的压低（宿主线低于我方）⇒ 必须说 `lowered`（不许为了修 ① 把真话也删掉）
 *   ③ **负向** 抬高是缺陷 ⇒ 必须说出来，不许静默
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const guard = await import(pathToFileURL(join(ROOT, 'src', 'core', 'compaction-guard.ts')).href)

/** `thresholdRatio` comes from the MOUNT row, not from arithmetic — a fixture without it yields NaN. */
const autoMount = { where: 'preset:standard', auto: true, thresholdRatio: 0.8 }

test('v328 ①: a host ceiling ABOVE our hardAt must not claim anything was lowered', () => {
  const out = guard.applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, [autoMount], 1_000_000, 20_000)
  const reason = String(out.compaction.reason)
  assert.equal(out.compaction.source, 'computed', `前提：这条分支应能算出天花板；实测 source=${out.compaction.source}`)
  assert.equal(out.hardAt, 0.75, `前提：宿主 0.8 − 0.02 = 0.78 高于 0.75，所以 hardAt 不动；实测 ${out.hardAt}`)
  assert.equal(reason.includes('lowered'), false,
    `① 没有压低就不许说 lowered；实测 reason=${reason}`)
  assert.match(reason, /unchanged at 0\.75/u, `① 必须说清楚它没动；实测 reason=${reason}`)
})

test('v328 ② (negative half): a genuine lowering still says `lowered`', () => {
  /**
   * Without this half, ① is satisfied by deleting the word entirely — which would lose the one case where
   * the sentence is carrying real information.
   */
  const lowMount = { where: 'preset:tight', auto: true, thresholdRatio: 0.6 }
  const out = guard.applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, [lowMount], 1_000_000, 900_000)
  const reason = String(out.compaction.reason)
  assert.equal(out.compaction.source, 'computed', '前提：这条分支应能算出天花板')
  assert.ok(out.hardAt < 0.75, `前提：0.6 − 0.02 = 0.58 应低于 0.75；实测 ${out.hardAt}`)
  assert.match(reason, /lowered from 0\.75 to/u, `② 真压低时必须说 lowered；实测 reason=${reason}`)
})

test('v328 ③ (negative half): the sentence helper refuses to hide a raised cut-off', () => {
  assert.equal(guard.hardAtSentence(0.75, 0.75), 'hardAt unchanged at 0.75')
  assert.equal(guard.hardAtSentence(0.75, 0.66), 'hardAt lowered from 0.75 to 0.66')
  assert.match(guard.hardAtSentence(0.75, 0.9), /RAISED/u, '③ 抬高必须显形，不许静默')
})