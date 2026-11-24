/**
 * ── v331 / N1+N2+N3：宽限期让位于压缩，但**过闸**；而且让位这件事必须记账 ─────────────────────────
 *
 * 路径：**纯判定模块** `core/compaction-observer.ts`（装配层的接线由 `v332` 用真实 `agent/pre-step`
 * 覆盖；本文件只钉判定，**不声称投递已通**）。
 *
 * ── 缺陷（M0 实测）────────────────────────────────────────────────────────────────────────────
 *
 * 被压缩的会话 `reGraftBlocked: true`、`graceTurnsRemaining: 2`。`index.ts:12477` 的注释自述
 * 「withhold the nudge and the forced cut for a protected target」——宽限期内 graft 一句话都不说，
 * 而宿主不知道宽限期，照常压缩。
 *
 * 用户裁定：**被自己再切一次至少还有一份交接；被宿主压掉什么都没有。** 所以两个保护必须分开。
 *
 * ── 但「让位」有个会造出循环的洞（lead §二十九）─────────────────────────────────────────────────
 *
 * 若种子本身就很大，新代一出生就 ≥ hardAt ⇒ 立刻作废宽限期 ⇒ 下一轮可切 ⇒ 新种子还是那么大
 * ⇒ **无限循环**。而「种子大 ⇒ 一出生就被切」**正是宽限期当初要防的事**。
 *
 * 判据（六条，四条负向）：
 *   ① 宽限期内越过 warnAt 但未到 hardAt ⇒ advisory，且**文案不含任何邀请切片的动词**
 *   ② **负向** 越线且**未工作过**、且已过 hardAt ⇒ `seed-too-large`（**不许切**，报 RESOURCE）
 *   ③ 工作过一轮（turnsSinceBirth ≥ 1）之后过 hardAt ⇒ `yield`，并带 `grace-yielded` 审计
 *   ④ **负向** 不在宽限期 ⇒ `none`（正常路径自己有机制，本模块不介入）
 *   ⑤ **负向** 未越 warnAt ⇒ `none`（否则低水位也被打扰）
 *   ⑥ **负向** 种子小、正常越线 ⇒ **立刻可让位**（不许变成「永远等一轮」）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(ROOT, 'src', 'core', 'compaction-observer.ts')).href)

const base = {
  chainProtected: true,
  graceTurnsRemaining: 2,
  turnsSinceBirth: 0,
  ratio: 0.7,
  warnAt: 0.6434,
  hardAt: 0.6734,
  compactionLine: 0.6934,
}

test('v331 ①: in grace, past warnAt but below hardAt ⇒ a READ-ONLY advisory', () => {
  const out = mod.observeCompaction({ ...base, ratio: 0.66, turnsSinceBirth: 3 })
  assert.equal(out.kind, 'advisory', `① 应给 advisory；实测 ${out.kind}`)
  assert.equal(out.suppressedByChain, true, '① N3：必须记下「是链闸关了它」，否则下一位读者归因到预警门坏了')
  assert.match(out.message, /宽限期/u, '① 必须说清「没有提示」是因为宽限期')
  assert.match(out.message, /69\.34%/u, '① 必须说出宿主压缩线')
})

test('v331 ② (negative): seed too large at birth ⇒ REFUSE to cut, report RESOURCE', () => {
  /**
   * THE LOOP. 种子大 ⇒ 一出生就越过 hardAt。若这里返回 `yield`，下一轮就允许切出一个
   * **同样大的新种子**，而宽限期当初正是为这件事存在的。
   */
  const out = mod.observeCompaction({ ...base, ratio: 0.9, turnsSinceBirth: 0 })
  assert.equal(out.kind, 'seed-too-large', `② 一出生就越线必须报 seed-too-large，不许 yield；实测 ${out.kind}`)
  assert.equal(out.audit.kind, 'graft-seed-too-large')
  assert.match(String(out.audit.kind), /seed-too-large/u, '② 审计必须点名原因，否则没人知道该修种子')
})

test('v331 ③: once this generation has WORKED, crossing hardAt yields the grace', () => {
  const out = mod.observeCompaction({ ...base, ratio: 0.9, turnsSinceBirth: 1 })
  assert.equal(out.kind, 'yield', `③ 工作过一轮之后越线应让位；实测 ${out.kind}`)
  assert.equal(out.audit.kind, 'grace-yielded')
  assert.equal(out.audit.turnsSinceBirth, 1, '③ 审计必须带「工作过几轮」，否则无法区分 ① 与 ③')
})

test('v331 ④ (negative): not in grace ⇒ none — the normal path owns its own machinery', () => {
  const out = mod.observeCompaction({ ...base, chainProtected: false, ratio: 0.99, turnsSinceBirth: 5 })
  assert.equal(out.kind, 'none')
  assert.equal(out.reason, 'not-in-grace')
})

test('v331 ⑤ (negative): below warnAt ⇒ none, even inside grace', () => {
  const out = mod.observeCompaction({ ...base, ratio: 0.1 })
  assert.equal(out.kind, 'none')
  assert.equal(out.reason, 'below-warn')
})

test('v331 ⑥ (negative): the copy must NOT invite a slice — that is the loop mouth', () => {
  const out = mod.observeCompaction({ ...base, ratio: 0.66, turnsSinceBirth: 5 })
  assert.equal(out.kind, 'advisory')
  for (const verb of ['请交接', '请切片', '尽早交接', '立刻切片', '请转生', '立即交接']) {
    assert.equal(out.message.includes(verb), false, `⑥ 文案不得包含「${verb}」—— 只陈述事实，不指令人做事`)
  }
})

test('v331 ⑦: an unknown compaction line must SAY unknown, never imply it is later', () => {
  const out = mod.observeCompaction({ ...base, ratio: 0.66, compactionLine: undefined })
  assert.equal(out.kind, 'advisory')
  assert.match(out.message, /未知/u, '⑦ 读不到压缩线时不许沉默，也不许假装它在后面')
})