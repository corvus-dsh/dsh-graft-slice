/**
 * ── v307 / B4-B TD-27 + TD-28 (P1): 算好的字段必须有读者 ──────────────────────────────────────────
 *
 * 用户原话（派工单 §十六 TD-27）：**「`nudgePanelState` 已经产出 `warnMarginSource` /
 * `warnMarginFallbackReason` / `nudgeReason`，面板 state 也带 `compaction`。但 `client.js` 里
 * `compaction` / `thresholdReason` / `nudge` 三个词各 0 命中。」**
 *
 * 准确描述：**生产者有值，消费者没读。** 这是 B4 的反向同族 —— 不是「修好的函数没人调」，
 * 是「算好的字段没人显示」。
 *
 * 判据（用户给的 3 条，全部实现在**真实渲染**上，不是读源码字符串）：
 *   ① `compaction.source === 'conservative'` ⇒ 面板**必须**渲染回落原因与「生效值 ≠ 设置值」
 *   ② `computed` ⇒ **不得**渲染回落字样（负向：否则两种状态被压成一句）
 *   ③ 每个会话行显示 `thresholdReason` 与 `nudgeReason`（值来自生产者，不在 client 重算）
 *
 * 为什么用真实渲染而不是 grep 源码：`compaction` 在 client.js 里「出现」很容易（加一行注释就行），
 * 而这正是本批反复出现的形状 —— **形式齐全，实质没有**。判据读渲染出来的文本。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const BUNDLE = 'dsh-graft-slice/client.js'

/**
 * Load the real bundle and run its REAL `useEffect`, so the panel performs its own fetch.
 *
 * A stub `useEffect` that never runs is what makes a rendered-panel test unable to reach any
 * data-dependent branch — the panel would render its 「正在读取」 state forever and every assertion
 * below would be vacuous.
 */
function loadPanel() {
  const source = readFileSync(join(ROOT, BUNDLE), 'utf8')
  let captured
  const effects = []
  const states = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    /**
     * A hook store that SURVIVES a re-render.
     *
     * The first version returned `[slot.value, set]` — a snapshot. `setState` updated the slot, but the
     * component's next call read `initial` again and the panel stayed on its 「宿主通道未连通」 branch
     * no matter how many times the effect ran. React guarantees the value persists across renders;
     * a stub that does not is not a smaller React, it is a different one, and it makes every
     * data-dependent assertion vacuous.
     */
    useState(initial) {
      if (React.__cursor >= React.__slots.length) {
        React.__slots.push({ value: typeof initial === 'function' ? initial() : initial })
      }
      const slot = React.__slots[React.__cursor]
      React.__cursor += 1
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
        },
      ]
    },
    useEffect(fn) {
      effects.push(fn)
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useRef(initial) {
      return { current: initial }
    },
    __slots: [],
    __cursor: 0,
    /** One "render pass": hooks must be read in the same order from the same slots. */
    __beginRender() {
      React.__cursor = 0
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    require(name) {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    console: { log() {}, error() {} },
    /**
     * The panel polls once a minute and returns a CLEANUP function from its effect. A harness that
     * awaited the effect's return value would wait forever (it is a function, not a promise), and one
     * that left `setInterval` real would keep the process alive. Both are stubbed here so the panel
     * still performs its own fetch while nothing is left running.
     */
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => {
      // `withTimeout` arms a rejection timer; letting it fire would fail an otherwise-good read.
      void fn
      return 0
    },
    clearTimeout: () => {},
  }
  const run = new Function('window', 'require', 'console', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', `"use strict";\n${source}\n`)
  run(
    sandbox.window,
    sandbox.require,
    sandbox.console,
    sandbox.setInterval,
    sandbox.clearInterval,
    sandbox.setTimeout,
    sandbox.clearTimeout,
  )
  assert.ok(captured, 'the bundle must register a module definition')

  const ctx = {
    slots: { inject(_key, cb) { cb() }, register() { return () => {} } },
    get() { return undefined },
  }
  const mod = captured.factory(
    (name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    { insert: () => () => {} },
    undefined,
  )
  mod.apply(ctx)

  /**
   * A bridge that answers with the payload under test, then let the effects run to completion.
   *
   * `useEffect` callbacks are async in this bundle (they `await bridge.state()`), so the harness
   * awaits every effect's returned promise before rendering — a fire-and-forget effect would leave
   * the panel on its 「正在读取」 branch and make ①②③ untestable.
   */
  /**
   * A bridge that answers with the payload under test.
   *
   * Passing it through `__panelForTest` is not enough on its own: the component calls
   * `bridge.attach(useSessions)` and (in the bundle) the LIVE bridge is built by `makeBridge(ctx, host)`.
   * The props route works because `GraftConsole({ bridge })` uses the prop when one is supplied —
   * which is what the render tests in this repo rely on.
   */
  const bridgeWith = (payload) => ({
    attach() {},
    state: async () => ({ ok: true, via: 'test', text: JSON.stringify(payload) }),
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  })

  /**
   * Run the effects and wait for the fetch to SETTLE, without waiting on the polling timer.
   *
   * Each effect starts an async `run()` and returns a cleanup function, so awaiting its return value
   * would wait forever. Instead: invoke the effect, then yield enough microtask turns for the awaited
   * `bridge.state()` to resolve and its `setState` calls to land.
   */
  return {
    mod,
    React,
    bridgeWith,
    /**
     * Render the panel one pass, with the hook cursor reset.
     *
     * Each call is a fresh render: hooks read their persistent slots in the same order, so a `setState`
     * performed by the previous pass is visible here. That is what makes 「effect ran → render again →
     * the fetched state is on screen」 true.
     */
    draw: (payload) => {
      React.__beginRender()
      return mod.__panelForTest({ bridge: bridgeWith(payload) })
    },
    /**
     * Run the effects and wait for the fetch to SETTLE, without waiting on the polling timer.
     *
     * Each effect starts an async `run()` and returns a cleanup function, so awaiting its return value
     * would wait forever. Instead: invoke the effect, then yield enough microtask turns for the awaited
     * `bridge.state()` to resolve and its `setState` calls to land.
     */
    runEffects: async () => {
      for (const fn of effects) fn()
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

/**
 * Collect every string in the element tree.
 *
 * A FUNCTION COMPONENT MUST BE CALLED, not walked: `h(SessionRow, { row })` produces
 * `{ type: SessionRow, props }` with no children, so a walker that only descends into `children`
 * silently renders the whole session table as empty. Measured: criterion ③ failed with the table
 * present but no rows, and the row markup was there all along — one level down, unrendered.
 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node !== 'object') return out

  // A composite element: React calls the component with its props and renders the result.
  if (typeof node.type === 'function') {
    const rendered = node.type(node.props || {})
    return textOf(rendered, out)
  }
  for (const child of node.children ?? []) textOf(child, out)
  if (node.props && node.props.children !== undefined) textOf(node.props.children, out)
  return out
}

/** The panel's own words, without the stylesheet: a failure message has to be readable. */
function tail(text) {
  const cut = text.lastIndexOf('转生控制台')
  return cut >= 0 ? text.slice(cut, cut + 900) : text.slice(-900)
}

/**
 * The panel body WITHOUT the 「原始状态数据（排查用）」 dump.
 *
 * That block prints the whole payload as JSON, so every field appears in the rendered text whether or
 * not any card displays it. A negative assertion (「must NOT contain X」) run against the raw text
 * therefore fails for a reason that has nothing to do with the UI — measured: criterion ② went red
 * because the fixture's own `thresholdReason` string (containing 保守值) was echoed by the debug dump,
 * while the compaction card correctly rendered `computed`.
 */
function panelBody(text) {
  const start = text.lastIndexOf('转生控制台')
  const body = start >= 0 ? text.slice(start) : text
  const dump = body.indexOf('原始状态数据')
  return dump >= 0 ? body.slice(0, dump) : body
}

const basePayload = (compaction) => ({
  ok: true,
  config: { warnAtRatio: 0.7, hardAtRatio: 0.75, autoGraft: true, graftMode: 'silent' },
  thresholds: { warnAt: 0.7, hardAt: 0.75, estimatedGraftCost: 12000, feasible: true },
  compaction,
  rows: [
    {
      sessionId: 'session-alpha',
      cwd: 'D:/work/alpha',
      tokens: 900000,
      contextWindow: 1000000,
      percent: 90,
      source: 'meter',
      toWarnTokens: 200000,
      toHardTokens: 350000,
      state: 'over-warn-line',
      warnAt: 0.7,
      hardAt: 0.55,
      /**
       * Coherent with the ceiling passed in: a `computed` payload gets a `computed` row reason. An
       * incoherent fixture would make criterion ② prove something about the fixture instead of the card.
       */
      thresholdReason:
        compaction !== null && compaction !== undefined && compaction.source === 'conservative'
          ? 'warn 边距由 token 预算得出（40000 tokens）；压缩阈值算不出来 ⇒ 落到保守值 0.550'
          : 'warn 边距由 token 预算得出（40000 tokens）；压缩阈值可读，硬阈值被压到 0.600',
      nudgeReason: 'already-nudged',
      warnMarginSource: 'tokens',
      generation: 0,
      graceTurnsRemaining: 0,
    },
  ],
  sessions: [],
  pendingIgnitions: [],
})

test('v307 TD-27 ①: a CONSERVATIVE ceiling renders its reason AND 「生效值 ≠ 设置值」', async () => {
  const { draw, runEffects } = loadPanel()
  const payload = basePayload({
    present: true,
    auto: true,
    source: 'conservative',
    effectiveHardAt: 0.55,
    effectiveWarnAt: 0.5,
    reason: 'RESOURCE：上下文窗口读不出来，落到保守值',
  })
  /**
   * The first render starts from `state === null` (the panel's initial state) and its effects do the
   * fetch; the SECOND render reads the state those effects set. Rendering once and asserting would
   * only ever test the 「正在读取」 branch.
   */
  draw(payload)
  await runEffects()
  const text = panelBody(textOf(draw(payload)).join(' '))

  assert.match(text, /conservative/u, `conservative 必须出现在面板上；实测：${tail(text)}`)
  assert.match(text, /RESOURCE/u, '保守来源必须说明它是 RESOURCE 条件（不是通过）')
  assert.match(text, /生效值 ≠ 设置值/u,
    '生效值与设置值不同时必须明说 —— 这正是这张卡存在的理由')

  // The reason string from the producer must be rendered verbatim, not paraphrased away.
  assert.match(text, /上下文窗口读不出来/u, '生产者的 reason 必须原样上屏')
})

test('v307 TD-27 ② (negative half): COMPUTED must NOT render fallback wording', async () => {
  /**
   * If a `computed` ceiling also printed 「保守」/「回落」, the two states would be one sentence and
   * a reader could no longer tell a measured threshold from a fallback.
   */
  const { draw, runEffects } = loadPanel()
  const payload = basePayload({
    present: true,
    auto: true,
    source: 'computed',
    thresholdRatio: 0.62,
    effectiveHardAt: 0.6,
    effectiveWarnAt: 0.55,
    reason: '阈值与窗口都可读',
  })
  draw(payload)
  await runEffects()
  const text = panelBody(textOf(draw(payload)).join(' '))

  assert.match(text, /computed/u, 'computed 必须上屏')
  assert.doesNotMatch(text, /保守值|回落|RESOURCE 条件/u,
    `computed 不许出现回落字样（两种状态被压成一句）；实测：${tail(text)}`)
  assert.match(text, /0\.600|0\.6/u, 'and the effective value must be printed')
})

test('v307 TD-28 ③: every session row shows thresholdReason AND nudgeReason', async () => {
  const { draw, runEffects } = loadPanel()
  const payload = basePayload({ present: false, auto: false, source: 'off', effectiveHardAt: 0.75, effectiveWarnAt: 0.7, reason: '未挂载' })
  draw(payload)
  await runEffects()
  const text = panelBody(textOf(draw(payload)).join(' '))

  assert.match(text, /阈值来源：warn 边距由 token 预算得出/u,
    `会话行必须显示生产者算好的 thresholdReason；实测：${tail(text)}`)
  assert.match(text, /提醒状态：already-nudged/u,
    '会话行必须显示生产者算好的 nudgeReason')
  assert.match(text, /session-alpha/u, '夹具自检：那一行确实画出来了')
})
