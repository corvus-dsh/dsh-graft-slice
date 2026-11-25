/**
 * ── v352：`event-helpers` 的**行为** ──────────────────────────────────────────────────────────────
 *
 * 这是「拆完就能单独测这个模块」的兑现。**加载方式说明（2026-11-25 更正）**：本文件的 v1 版走
 * `import … from '../index.js'`（构建产物），理由是「Node 不能直接跑 `.ts`」——那句话**是错的**。
 * Node 24 本身支持执行 `.ts`（`process.features.typescript === 'strip'`），当时实测到的
 * `ERR_MODULE_NOT_FOUND` 是**解析**失败：源码里的相对 import 写成 `./x.js`，磁盘上是 `x.ts`。
 * `test/source-module.mjs` 一条 resolve 钩子补上这一跳，于是本文件现在直接 import **模块本身**。
 *
 * ── 为什么要换成源码 ─────────────────────────────────────────────────────────────────────────────
 *
 * 构建产物把 42 个模块内联进**一个作用域**：在那里，「模块边界」已经不存在了。用产物测，测到的是
 * 整个插件，不是这个模块；「搬动是否真的把依赖断开」在那一层根本看不出来。**独立性由 import 什么
 * 决定**（`v351 ②` 仍然管这一条），但**能不能测**由加载方式决定——两者都要对。
 *
 * ── 这些值是**读实现读出来的**，不是猜的 ────────────────────────────────────────────────────────
 *
 * 第一版按「听起来合理」写了 `validateAppendIsLifecycleSafe('append', type, data, events)` 与
 * `continuationTitle` 返回裸标题 —— 三条全红。真实签名是
 * `validateAppendIsLifecycleSafe(events, append)`，而 `continuationTitle` **自己加 `[接续]` 前缀**。
 * 那种红证明的只是「我猜错了」，与被测行为无关；把它留下来的代价是下一个人以为函数坏了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const {
  continuationTitle,
  isSteeringOnly,
  openStepOf,
  validateAppendIsLifecycleSafe,
} = await import('../src/registration/event-helpers.ts')

test('v352 isSteeringOnly: short acknowledgements are steering, anything substantive is not', () => {
  /** Real corpus shapes this function was written for. */
  for (const text of ['继续', '好的', '可以', 'ok', 'yes', '继续吧', '/clear']) {
    assert.equal(isSteeringOnly(text), true, `「${text}」应判为 steering`)
  }
  /** The boundary is 12 chars AFTER trimming trailing punctuation — a rule, not a guess. */
  assert.equal(isSteeringOnly('好，但是别动 JSX'), false, '带实质内容的短句不是 steering —— 丢掉它会丢一条约束')
  assert.equal(isSteeringOnly('继续，然后把 v138 的十一条都跑一遍'), false, '长句不是 steering')
  /** Empty / punctuation-only counts as steering: there is nothing to lose. */
  assert.equal(isSteeringOnly('   '), true, '空白是 steering')
  assert.equal(isSteeringOnly('。。。'), true, '只有标点是 steering')
})

test('v352 openStepOf: the open turn/step comes from turn/step start events, undefined when none is open', () => {
  assert.equal(openStepOf([]), undefined, '没有事件 ⇒ 没有 open step')

  const opened = openStepOf([
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'step/start', data: { step: 1 } },
  ])
  assert.deepEqual(opened, { turn: 3, step: 1 }, 'turn/step start 打开一个 open step')

  /** A completed step is no longer open — this is what stops a card from attaching to a closed step. */
  const closed = openStepOf([
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'step/start', data: { step: 1 } },
    { type: 'step/end', data: { step: 1 } },
  ])
  assert.equal(closed, undefined, 'step 结束后没有 open step')

  /** `turn/start` resets the step: a new turn cannot inherit the previous turn's open step. */
  const newTurn = openStepOf([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { step: 5 } },
    { type: 'turn/start', data: { turn: 2 } },
  ])
  assert.equal(newTurn, undefined, '新 turn 开始时 step 必须被清空（否则卡片会挂到上一 turn 的 step 上）')
})

test('v352 validateAppendIsLifecycleSafe: a lifecycle event is REFUSED, an ordinary card is allowed', () => {
  /**
   * The rule this guards is a real incident: a plugin that writes `turn/start` desynchronizes the step
   * sequence and v4 rejects the whole log. So the refusal is the important half.
   *
   * Signature measured from the source: `(events, append)` — the first version of this test had the
   * arguments in a different order and produced three red tests about nothing.
   */
  for (const type of ['turn/start', 'step/start', 'turn/end', 'step/end']) {
    const verdict = validateAppendIsLifecycleSafe([], { type, data: {} })
    assert.equal(verdict.ok, false, `${type} 必须被拒（生命周期事件只有 agent loop 能写）`)
    assert.match(verdict.reason, /agent-loop owned/u, `${type} 的拒绝理由必须说明「这是 agent loop 拥有的」`)
  }

  /** A transition card is not a lifecycle event — it must be allowed. */
  const allowed = validateAppendIsLifecycleSafe(
    [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { step: 1 } }],
    { type: 'message', data: { id: 'card-1' } },
  )
  assert.equal(allowed.ok, true, '普通 message 在 open step 里必须被允许')

  /** Measured: it returns a verdict, never throws — the caller logs, it does not crash. */
  assert.doesNotThrow(() => validateAppendIsLifecycleSafe([], { type: 'message', data: {} }),
    '它必须返回判决而不是抛错：调用点在 apply() 的卡片写入路径上')
})

test('v352 continuationTitle: the `[接续]` prefix is added by the function, not by the caller', () => {
  assert.equal(continuationTitle('修复 v138', 'target-1'), '[接续] 修复 v138', '有标题时用标题并加前缀')
  assert.equal(continuationTitle(undefined, 'target-1'), '[接续] → target-1', '没有标题时用 id')
  /** Measured: an already-prefixed title is not double-prefixed. */
  assert.equal(continuationTitle('[接续] 修复 v138', 'target-1'), '[接续] 修复 v138',
    '重复搬运时不得叠成 `[接续] [接续] …`')
  assert.equal(continuationTitle('  修复 v138  ', 'target-1'), '[接续] 修复 v138', '标题要 trim')
  assert.equal(continuationTitle('   ', 'target-1'), '[接续] → target-1', '全空白的标题等同于没有标题')
})
