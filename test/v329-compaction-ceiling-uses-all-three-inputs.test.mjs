/**
 * ── v329 / N5（P0）：天花板必须实现宿主公式的三个参数，不是一个 ──────────────────────────────────
 *
 * 路径：**公开状态读数**（`applyCompactionCeiling(...).compaction`，面板与 `graft_debug_status` 读它）。
 *
 * `compaction-guard.ts:7` 的模块文档逐字写着宿主公式：
 *
 *     threshold = floor(min(W × thresholdRatio, W − O − headroomTokens))
 *
 * 而代码只取 `min` 的**第一臂**：`O` 被 `void` 掉、`headroomTokens` 只在 alert 文案里出现。
 *
 * 实测（本 profile）：W=1048576, O=256000, B=65536 ⇒ `(1048576−256000−65536)/1048576 = 0.69336`。
 * 宿主在 **69.34%** 压缩，而 graft 预警线在 **70.00%** —— 永远落后 0.66 个点（1M 窗口约 6,963 token），
 * **预警永远到不了**。
 *
 * 判据（五条，三条负向）：
 *   ① 本 profile（W=1M, O=256k, B=64k）⇒ 0.6934，且 warn/hard 都在其下
 *   ② **负向** `W−O−B` **不**赢时（O 很小）⇒ 仍是挂载配置的 0.8（不许无条件用窗口臂）
 *   ③ **负向** `O` 不可读 ⇒ 必须落 `conservative` 并点名 `O`，不得静默当作 0
 *   ④ **负向** 传不同 `O` 输出必须不同（F3 的反面：O 曾被完全忽略）
 *   ⑤ can-red：退回只看 `thresholdRatio` ⇒ ① 红、② 绿
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const guard = await import(pathToFileURL(join(ROOT, 'src', 'core', 'compaction-guard.ts')).href)

const W = 1_048_576
const O = 256_000
const B = 65_536
const mount = { where: 'preset:standard', auto: true, thresholdRatio: 0.8, headroomTokens: B }
const setting = { warnAt: 0.7, hardAt: 0.75 }

test('v329 ①: the user profile yields 0.6934, and both graft lines sit BELOW it', () => {
  const out = guard.applyCompactionCeiling(setting, [mount], W, O)
  assert.equal(out.compaction.source, 'computed', `① 应能算出；实测 source=${out.compaction.source}`)
  assert.equal(out.compaction.thresholdRatio, 0.6934,
    `① 必须复现宿主公式：min(0.8, 1−(256000+65536)/1048576)=0.6934；实测 ${out.compaction.thresholdRatio}`)
  assert.ok(out.warnAt < 0.6934, `① 预警线必须在宿主压缩线之前；实测 warnAt=${out.warnAt}`)
  assert.ok(out.hardAt < 0.6934, `① 强切线必须在宿主压缩线之前；实测 hardAt=${out.hardAt}`)
})

test('v329 ② (negative half): when the window arm does NOT win, the mount ratio stands', () => {
  /**
   * Without this half, ① is satisfied by always taking the window arm — which would let a tiny `O`
   * silently push the ceiling up to 1.0 and undo the whole point.
   */
  const out = guard.applyCompactionCeiling(setting, [mount], W, 1_000)
  assert.equal(out.compaction.thresholdRatio, 0.8, `② O 很小时 0.8 应仍然赢；实测 ${out.compaction.thresholdRatio}`)
})

test('v329 ③ (negative half): an unreadable O must fall to conservative and NAME O', () => {
  const out = guard.applyCompactionCeiling(setting, [mount], W, undefined)
  assert.equal(out.compaction.source, 'conservative',
    `③ O 读不出时不得当作 0（那会静默回到 0.8）；实测 source=${out.compaction.source}`)
  /**
   * 第一版这里写的是 `/O/u` —— 它匹配到 `auto is ON` 里的那个字母 O，**假绿**。
   * 判据必须钉住「点名 O 是输出预留且被当成未知」，而不是钉住一个字母。
   */
  assert.match(String(out.compaction.reason), /O \(output reservation\) unreadable/u,
    `③ 理由必须点名 O 是输出预留且被当成未知；实测 ${out.compaction.reason}`)
  assert.equal(/treated as UNKNOWN, not as 0/u.test(String(out.compaction.reason)), true,
    '③ 必须明说「不当作 0」—— 否则「O 读不出」与「O=0」在读者那里不可区分')
})

test('v329 ④ (negative half): different O must produce different output', () => {
  /**
   * The measured defect F3: `O=256000 / 16000 / undefined` produced IDENTICAL output, because `O` was
   * `void`-ed. This is the direct reversal of that observation.
   */
  const a = guard.applyCompactionCeiling(setting, [mount], W, 256_000)
  const b = guard.applyCompactionCeiling(setting, [mount], W, 16_000)
  assert.notEqual(a.compaction.thresholdRatio, b.compaction.thresholdRatio,
    '④ 不同的 O 必须得到不同的阈值 —— 否则 O 又被忽略了')
  assert.ok(a.compaction.thresholdRatio < b.compaction.thresholdRatio,
    '④ O 越大，宿主越早判满，阈值必须更低')
})

test('v329 ⑤: the header formula is the one implemented', () => {
  /** The module's own doc says `threshold = floor(min(W × r, W − O − headroomTokens))`; pin that. */
  const out = guard.applyCompactionCeiling(setting, [mount], W, O)
  const expected = Math.min(0.8, 1 - (O + B) / W)
  assert.equal(out.compaction.thresholdRatio, Math.round(expected * 10_000) / 10_000,
    `⑤ 实现必须等于文档里的公式；实测 ${out.compaction.thresholdRatio} vs ${expected}`)
})