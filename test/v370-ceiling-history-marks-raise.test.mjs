/**
 * ── v370：棘轮的提级记录必须自述它是提级（F5 / S13）────────────────────────────────────────────
 *
 * 病（实测 2026-11-26，`docs/index-ratchet.json`）：`--raise-ceiling` 写进 `history` 的记录是
 *
 *     { at, field, from, to, reason }
 *
 * **没有 `raised` 这个字段**。而同一个数组里还有 `--write` 自动收紧写的记录，形状几乎一样，
 * 只少 `reason`。于是读历史的读者要靠**猜**才知道哪一条是「有人决定抬了天花板」，哪一条是
 * 「棘轮自己降了」：
 *
 *     字段长、数字在变、reason 有时有有时没有 —— 这就是全部线索。
 *
 * 为什么这是缺陷而不只是不整齐：**「提级」是审批动作**，而「收紧」是机制结果。两者混在一个
 * 数组里且形状相同，就是「一条审批记录可以看起来是一次自动收缩」——那正是棘轮存在的意义
 * 要防止的（`v327 ⑤` 管的是数字，这条管的是**身份**）。
 *
 * ── 判据的形状 ────────────────────────────────────────────────────────────────────────────────
 *
 * ① 每条记录都有布尔 `raised`（字段缺失即红）
 * ② 每条提级（`to > from`）记录必须有非空 `reason`
 * ③ **负向**：`to > from` 但 `raised !== true` ⇒ 红（形状与语义矛盾）
 * ④ **负向**：`raised === true` 但缺 `reason` ⇒ 红（没有理由的提级）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CEILING = join(ROOT, 'docs', 'index-ratchet.json')

const history = () => JSON.parse(readFileSync(CEILING, 'utf8')).history ?? []

test('v370 ①: every history record carries a boolean `raised`', () => {
  const records = history()
  assert.ok(records.length > 5, `① 历史必须是一个有人口的序列，实测 ${records.length} 条`)
  const missing = records.filter((record) => record.raised === undefined)
  assert.deepEqual(
    missing.map((record) => JSON.stringify(record)), [],
    `① 这些提级/收紧记录没有 raised 字段（读的人只能靠猜它是哪一类）：\n  ${missing.map((r) => JSON.stringify(r)).join('\n  ')}`,
  )
  for (const record of records) {
    assert.equal(typeof record.raised, 'boolean', `① raised 必须是布尔，实测 ${JSON.stringify(record.raised)}`)
  }
})

test('v370 ②: every RAISE record states why', () => {
  const unmarked = history()
    .filter((r) => Number(r.to) > Number(r.from))
    .filter((r) => typeof r.reason !== 'string' || r.reason.trim() === '')
  assert.deepEqual(
    unmarked.map((r) => JSON.stringify(r)), [],
    `② 提级（from→to 变大）必须写理由，实测这些没有：\n  ${unmarked.map((r) => JSON.stringify(r)).join('\n  ')}`,
  )
})

test('v370 ③ (negative): a record that GROWS must be marked raised', () => {
  /**
   * 形状与语义必须一致：一个 `to > from` 的记录如果标 `raised: false`，它要么标错了，
   * 要么是形状在骗人。**这条读的是同一条记录的两侧，不是两件独立的事**。
   */
  const contradictory = history()
    .filter((r) => Number(r.to) > Number(r.from) && r.raised !== true)
    .map((r) => JSON.stringify(r))
  assert.deepEqual(contradictory, [],
    `③ 这些记录在变大却没标 raised:true：\n  ${contradictory.join('\n  ')}`)
})

test('v370 ④ (negative): a raise without a reason is refused', () => {
  const unjustified = history()
    .filter((r) => r.raised === true && (typeof r.reason !== 'string' || r.reason.trim() === ''))
    .map((r) => JSON.stringify(r))
  assert.deepEqual(unjustified, [],
    `④ 这些记录自称提级却没有理由（提级是审批动作，不能没有审批）：\n  ${unjustified.join('\n  ')}`)
})

test('v370 ⑤: the marks agree with the auditable quantity (a raise must have grown something)', () => {
  /**
   * 最后一道：把「标了 `raised`」与「数字确实变了」对上。
   *
   * 一条 `raised: true` 的记录如果 `to === from`，那它标了一个不成立的事实；反之一条
   * `raised: false` 且 `to < from` 的记录是正常的收紧。两侧都要检查，缺一不可 ——
   * 只查一侧的话，「标错方向」永远不会被发现。
   */
  const bogusRaise = history()
    .filter((r) => r.raised === true && Number(r.to) <= Number(r.from))
    .map((r) => JSON.stringify(r))
  assert.deepEqual(bogusRaise, [], `⑤ 这些记录自称提级，数字却没有变大：\n  ${bogusRaise.join('\n  ')}`)
})
