/**
 * ── v301 (B4-B B0)：`graft_prepare` 的返回值必须是**无损 JSON**，不带 handover 的那次也算 ──────────
 *
 * ── 缺陷（真实 `apply()` + 真实 `execute`，实测复现）────────────────────────────────────────────
 *
 * `index.ts:7323` 曾写：
 *
 *     handover: handover === undefined ? undefined : { pending: …, notes: … }
 *
 * `JSON.stringify` 会**丢掉** `undefined` 属性 ⇒ 序列化看起来没问题。但宿主校验的是「**无损** JSON」：
 * `undefined` 本身不可无损表示，所以**自带 `undefined` 的键**直接判非法：
 *
 *     with handover    -> own key, typeof object,    $.handover 合法
 *     without handover -> own key, typeof undefined, $.handover = undefined   ← 非法
 *
 * ── 为什么这一条排在最前（比安全项还前）──────────────────────────────────────────────────────────
 *
 * 它不是安全问题，但它是**唯一一个让模型完全无法调用主流程**的问题：`graft_prepare` 是 nudge 之后
 * 模型唯一的合法出口。它失败 ⇒ 模型只剩 `graft_slice_and_inject` 这条路 ⇒
 * **两阶段审批被完全绕过**。一个非安全 bug 静默地绕过了安全流程。
 *
 * ── 为什么 1047 个测试没抓到 ─────────────────────────────────────────────────────────────────────
 *
 * 既有测试直接调 `prepareSlice()` / `execute(...)`，**宿主那一步校验不在测试里**。所以这一条不是
 * 「再多测一遍 prepare」，而是**把宿主的那条规则搬进测试**：返回值逐节点检查可无损表示性。
 *
 * ── 判据（五条，两条负向）──────────────────────────────────────────────────────────────────────
 *
 *   ① 不带 handover ⇒ 无损合法，且**没有** `handover` 这个自有键（缺席必须是**缺席**）
 *   ② 带 handover   ⇒ 无损合法，且内容逐字保留（不许为了合法而丢内容）
 *   ③ 负向：`handover` 不许变成 `null` —— `null` 合法但是**谎**（它说「提供了、内容是空」，
 *      而 `handoverSupplied` 的存在正是为了区分这两件事）
 *   ④ 负向：`handoverSupplied` 在两种情形下分别是 `false` / `true`（合法化不许把语义一起抹平）
 *   ⑤ 整份回执逐节点扫描：除 `handover` 外没有第二个越界键（否则只修一处仍会红）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/**
 * THE HOST'S RULE, WRITTEN OUT.
 *
 * Returns the JSON PATHS that are not losslessly representable, so a failure names where instead of
 * saying 「invalid」. `Object.keys` sees OWN enumerable keys — an own `undefined` is exactly the case.
 */
function losslessProblems(value, path = '$', seen = new Set()) {
  if (value === undefined) return [`${path} = undefined`]
  if (value === null) return []
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? [] : [`${path} = ${String(value)}（非有限数）`]
  if (type === 'string' || type === 'boolean' || type === 'bigint') return []
  if (type === 'function') return [`${path} = function`]
  if (type === 'symbol') return [`${path} = symbol`]
  if (seen.has(value)) return [`${path} = 循环引用`]
  seen.add(value)
  const problems = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...losslessProblems(item, `${path}[${index}]`, seen)))
  } else {
    for (const key of Object.keys(value)) {
      problems.push(...losslessProblems(value[key], `${path}.${key}`, seen))
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      problems.push(`${path}.${String(symbol)} = symbol 键`)
    }
  }
  seen.delete(value)
  return problems
}

function setup() {
  const sourceLog = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), currentAgentId: sourceLog.session.id })
  apply(ctx, {})
  return { ctx, sourceLog }
}

/** The ordinary call: everything a real nudge-driven `graft_prepare` provides and nothing more. */
const BASE = { boundarySeq: 10, cwd: 'D:\\work\\demo' }

const prepare = (ctx, args) =>
  ctx._tools.get('graft_prepare').execute(args, { agent: { id: 'session-source' } })

test('v301 ①: 不带 handover ⇒ 无损合法，且 handover 是缺席的键（不是 undefined 值）', async () => {
  const { ctx } = setup()
  const reply = await prepare(ctx, BASE)

  const problems = losslessProblems(reply)
  assert.deepEqual(problems, [], `返回值必须是无损 JSON，实测越界路径：${problems.join('; ')}`)

  /**
   * ABSENCE MUST BE ABSENCE. `Object.prototype.hasOwnProperty` is the only check that distinguishes
   * "the key is gone" from "the key is here and holds undefined" — and the latter is the defect.
   */
  assert.equal(
    Object.prototype.hasOwnProperty.call(reply, 'handover'),
    false,
    '没有提供 handover 时，这个键必须**不存在**；存在且为 undefined 正是宿主拒绝的那一形状',
  )
})

test('v301 ②: 带 handover ⇒ 无损合法，且内容逐字保留', async () => {
  const { ctx } = setup()
  const reply = await prepare(ctx, { ...BASE, handover: { pending: ['P1', 'P2'], notes: ['N1'] } })

  const problems = losslessProblems(reply)
  assert.deepEqual(problems, [], `带 handover 时也必须无损，实测：${problems.join('; ')}`)
  assert.deepEqual(reply.handover, { pending: ['P1', 'P2'], notes: ['N1'] }, '内容不许为了合法而被丢掉')
})

test('v301 ③: 负向 —— handover 不许变成 null', async () => {
  /**
   * `null` is legal JSON, so it would pass ①② and look like a fix. It is also a LIE: it says 「a
   * handover was supplied and its content is null」. Absence and 「nothing supplied」 are different
   * facts, which is exactly what `handoverSupplied` exists to keep apart.
   */
  const { ctx } = setup()
  const reply = await prepare(ctx, BASE)
  assert.notEqual(reply.handover, null, 'null 合法但是谎 —— 缺席必须用缺席表达，不是用 null 表达')
})

test('v301 ④: 负向 —— handoverSupplied 仍然区分「没提供」与「提供了但内容全空」', async () => {
  const withoutEnv = setup()
  const without = await prepare(withoutEnv.ctx, BASE)
  assert.equal(without.handoverSupplied, false, '没提供 ⇒ false')

  /**
   * THE CASE IS 「提供了但全是空串」, THE USER'S OWN WORDING (B1 判据 5), not 「提供了空数组」.
   *
   * `asStringList` folds `[]` into `undefined` (an empty list carries no content), so `{pending: []}`
   * legitimately means "nothing supplied". But `['', '  ']` — supplied, and blank — SURVIVES that
   * filter, and that is the state the review text has to be able to describe: 『本段由模型提供』 is
   * accurate for it and a lie for an absent handover.
   *
   * My first draft used `{pending: [], notes: []}` and read the resulting `false` as a defect. It was
   * MY CRITERION that was wrong: an empty list is not 「提供了内容」. Recorded rather than quietly
   * swapped — the difference between the two readings is exactly what this case is about.
   */
  const withEnv = setup()
  const withHandover = await prepare(withEnv.ctx, { ...BASE, handover: { pending: [''], notes: ['  '] } })
  assert.equal(withHandover.handoverSupplied, true, '提供了（哪怕全是空串）⇒ true')

  /**
   * THE PAIR IS THE POINT: `handoverSupplied: true` must come WITH a content field, because 「提供了」
   * is a provenance claim and the content is what makes it checkable. If a future fix collapsed the two
   * fields, this case is what notices.
   */
  assert.equal(Object.prototype.hasOwnProperty.call(withHandover, 'handover'), true, '提供了就要有内容字段')
  assert.deepEqual(withHandover.handover, { pending: [''], notes: ['  '] }, '内容逐字保留，不做空白裁剪')
})

test('v301 ⑤: 整份回执逐节点扫描 —— 没有第二个越界键', async () => {
  /**
   * A fix aimed only at the one key the user reported would satisfy ①–④ and leave the NEXT
   * `… ? undefined : …` to be found by a user in a screenshot. So the whole reply is scanned, and the
   * scan is the durable part: any future field that holds `undefined` fails here by name.
   */
  const { ctx } = setup()
  for (const args of [BASE, { ...BASE, handover: { pending: ['P'], notes: [] } }]) {
    const reply = await prepare(ctx, args)
    const problems = losslessProblems(reply)
    assert.deepEqual(problems, [], `越界路径：${problems.join('; ')}`)
  }
})
