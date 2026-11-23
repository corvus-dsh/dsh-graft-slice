/**
 * ── v330 / N1：宽限期只抑制邀请，不抑制「压缩可能先到」这一句只读事实 ────────────────────────────
 *
 * 路径：**公开 helper**（`core/chain-advisory.ts`）+ 「投递」由 N1 的接线步骤覆盖（未完成，见 §状态）。
 *
 * MEASURED（M0）：被压缩的会话 `reGraftBlocked: true`、`graceTurnsRemaining: 2`，而
 * `index.ts:12477-12479` 的注释自述「withhold the nudge and the forced cut for a protected target」。
 * 于是宽限期内 graft 一句话都不说，宿主不知道宽限期，照常压缩。
 *
 * 判据（四条，两条负向）：
 *   ① 宽限期内 + 越过 warnAt ⇒ 给出 advisory，且**说清压缩线**（未知时也必须说「未知」）
 *   ② **负向** 不在宽限期 ⇒ 不产生（否则正常会话平白多一条噪音）
 *   ③ **负向** 未越过 warnAt ⇒ 不产生（否则「提前太多」等于把宽限期取消）
 *   ④ **负向** 文案不得邀请切片 —— 它只陈述事实；邀请切片正是那条「切→种子大→再切」的循环入口
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(ROOT, 'src', 'core', 'chain-advisory.ts')).href)

test('v330 ①: a protected session past than warnAt gets a read-only advisory naming BOTH lines', () => {
  const out = mod.chainCompactionAdvisory({ chainProtected: true, ratio: 0.7037, warnAt: 0.6434, compactionLine: 0.6934 })
  assert.ok(out !== undefined, '① 宽限期内越线必须给出 advisory')
  assert.equal(out.kind, 'chain-compaction-advisory')
  assert.match(out.message, /70\.37%/u, '① 必须说出当前水位')
  assert.match(out.message, /69\.34%/u, '① 必须说出宿主压缩线')
  assert.match(out.message, /宽限期/u, '① 必须说清「没有提示」是因为宽限期')
})

test('v330 ② (negative half): a session NOT in grace must not receive it', () => {
  const out = mod.chainCompactionAdvisory({ chainProtected: false, ratio: 0.9, warnAt: 0.6434, compactionLine: 0.6934 })
  assert.equal(out, undefined, '② 不在宽限期 ⇒ 不产生（正常会话走真正的 nudge，不需要这条）')
})

test('v330 ③ (negative half): a protected session BELOW warnAt must not receive it', () => {
  const out = mod.chainCompactionAdvisory({ chainProtected: true, ratio: 0.5, warnAt: 0.6434, compactionLine: 0.6934 })
  assert.equal(out, undefined, '③ 没越线 ⇒ 不产生（否则等于把宽限期提前取消）')
})

test('v330 ④ (negative half): the copy must NOT invite a slice — that is the loop mouth', () => {
  /**
   * 宽限期的存在理由就是「不许一出生就被切」。一条写着「请尽早切片」的 advisory 会把那个循环
   * 伪装成一条提示：种子大 ⇒ 一出生越线 ⇒ 被邀请切片 ⇒ 新种子还是那么大。
   */
  const out = mod.chainCompactionAdvisory({ chainProtected: true, ratio: 0.9, warnAt: 0.6434, compactionLine: 0.6934 })
  assert.ok(out !== undefined)
  for (const verb of ['请交接', '请切片', '尽早交接', '立刻切片', '请转生']) {
    assert.equal(out.message.includes(verb), false, `④ 文案不得包含「${verb}」—— 它只陈述事实，不指令人做事`)
  }
})

test('v330 ⑤: an unknown compaction line must SAY unknown, never imply it is late', () => {
  const out = mod.chainCompactionAdvisory({ chainProtected: true, ratio: 0.9, warnAt: 0.6434, compactionLine: undefined })
  assert.ok(out !== undefined)
  assert.match(out.message, /未知/u, '⑤ 读不到压缩线时不许沉默，也不许假装它在后面')
})