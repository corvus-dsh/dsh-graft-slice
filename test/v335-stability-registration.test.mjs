/**
 * ── v335 / A2：事前登记不得被事后倒改（lead §四十二.5）──────────────────────────────────────────
 *
 * 路径：**门禁脚本** `scripts/check-stability-registration.mjs`（`contentHash` 锁）。
 *
 * ── 要防的事 ──────────────────────────────────────────────────────────────────────────────────
 *
 * `v2.3` §15.18.4：「指标不得事后倒改」。老板在 §28.7 写的「连续 3 代」正是反例——**自己造的数，
 * 而且在结果出来之后才定**。
 *
 * 三处严格化（老板原话）：
 *   1. 只写日期**不够**（事后仍可改）⇒ 记 **`contentHash`**，改哈希这个动作本身就是记录；
 *   2. 「L0 = 2 小时」必须写清**测什么** ⇒ 六类工作负载**各至少 1 次**，否则该窗口**作废**；
 *   3. 「出现 1 次即判不稳」要有**事先就能写的代价论据** ⇒ 两条代价**不对称**。
 *
 * 判据（五条，三条负向）：
 *   ① 登记文件存在，且哈希与锁定值一致
 *   ② **负向** 改动正文但不动哈希 ⇒ 红（这是本条的全部意义）
 *   ③ 正文必须写清窗口 **2 小时**、**六类**工作负载、「出现 **1 次**」、对象是**逻辑会话**
 *   ④ 必须写出**代价不对称**的论据（不是「我判断它更严重」，而是两条代价的方向不同）
 *   ⑤ **负向** 文档不得宣称「已稳」或「RSI」—— 截至登记时刻零次有效观察
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOC = join(ROOT, 'docs', 'STABILITY-REGISTRATION.md')
const LOCK = join(ROOT, 'docs', 'stability-registration.hash')

const text = readFileSync(DOC, 'utf8')

test('v335 ①: the registration exists and its content hash matches the lock', () => {
  assert.equal(existsSync(LOCK), true, '① 必须有锁定哈希文件')
  const digest = createHash('sha256').update(text).digest('hex')
  assert.equal(readFileSync(LOCK, 'utf8').trim(), digest,
    '① 事前登记的正文与其锁定哈希必须一致 —— 不一致就是「事后倒改」')
})

test('v335 ② (negative): the window is 2 hours (L0 lower bound), not an invented 「3 generations」', () => {
  assert.match(text, /2 小时/u, '② 窗口必须是报告里 L0 的下限 2 小时')
  /**
   * 「连续 3 代」 MAY be mentioned — but only as the rejected example. A blanket string ban would forbid
   * the document from explaining what it replaced, and the obvious "fix" would be to delete the history.
   *
   * So the assertion is about ADOPTION, not occurrence: the phrase must never appear in a position that
   * states it as the criterion. Measured shape of the two allowed mentions:
   *
   *   `… 写的「连续 3 代」是`           ← the rejected one, introduced by my own name
   *   `这不同于「连续 3 代无失败才算稳」` ← explicitly contrasted with the adopted rule
   */
  const adopted = [...text.matchAll(/连续\s*3\s*代/gu)]
    .map((match) => text.slice(Math.max(0, match.index - 40), match.index + 40))
    .filter((window) => !/不同于|不是|反例|而是|违反|自己造的数|事后合理化|要防/u.test(window))
  assert.deepEqual(adopted, [], `② 「连续 3 代」只能作为被否定的反例出现；实测这些上下文在断言它：\n${adopted.join('\n')}`)
})

test('v335 ③: the SIX workload classes are enumerated, so an idle window cannot count', () => {
  /**
   * `v2.3` §15.18.2：**「仅保持进程存活、发空心跳不构成证据」**。没有这一条，
   * 「跑了两小时空转」会被当成一次有效观察。
   */
  for (const label of ['目标推进', '工具执行', '结果检查', '错误处理', '记忆检索', '阶段验收']) {
    assert.ok(text.includes(label), `③ 六类工作负载缺「${label}」—— 缺任何一类该窗口作废`)
  }
  assert.match(text, /各至少发生 1 次/u, '③ 必须写明「各至少 1 次」')
  assert.match(text, /逻辑会话/u, '③ 对象必须是逻辑会话（generationId 链），不是进程')
})

test('v335 ④: the asymmetry of the two costs is stated up front (not rationalised afterwards)', () => {
  assert.match(text, /不对称/u, '④ 必须写出代价不对称')
  assert.match(text, /不可重建/u, '④ 压缩的代价必须是「不可重建的上下文」')
  assert.match(text, /可恢复/u, '④ 误降级的代价必须是「可恢复」')
  assert.match(text, /出现 1 次/u, '④ 判据必须是「出现 1 次即判不稳」')
})

test('v335 ⑤ (negative): it must NOT claim stability or any RSI capability', () => {
  assert.match(text, /不宣称/u, '⑤ 必须显式写出它不宣称什么')
  assert.match(text, /零次|0 次|0$/mu, '⑤ 必须承认截至登记时刻没有有效观察')
  assert.match(text, /CI 未观测|403/u, '⑤ CI 未观测必须照旧写')
})