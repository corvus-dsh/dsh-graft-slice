/**
 * ── v319 / 19.4-E (P1, lead-measured): 「未连通」必须可达，「正常」必须不是谎 ──────────────────────
 *
 * lead 的三条时间线（真实渲染，真实 effect）：
 *
 * | 时间线 | 修前徽章 | 修前红卡标题 |
 * |---|---|---|
 * | C. 初次渲染（effect 未跑） | 未连通 ← 唯一可达的一帧 | （无卡片） |
 * | A. 首次就失败 | **降级** ✗ | 读取失败 |
 * | B. 先成功、再失败 | **正常（绿）** ✗✗ | 读取失败 |
 *
 * 根因三行凑在一起：
 *
 *   client.js:1423  health 第一分支判 `state === null`（不是 error）
 *   client.js:1272  失败时 setState(prev ?? fallbackState(reason))
 *   client.js:1010  fallbackState 里 degraded: true
 *
 * ⇒ 失败后 `state` 永远不是 null，于是「未连通」只活在 effect 跑完之前那一帧。
 *
 * 判据（三条，两条负向 — 见 §〇 26）：
 *   ① 首次就失败 ⇒ 徽章含「未连通」、不含「降级」
 *   ② 先成功、再失败 ⇒ 徽章**不再**是「宿主通道正常」（当前最刺眼的一条）
 *   ③ 负向：降级（通道通了、数值不可信）⇒ 徽章**仍**是「降级」，不被 error 分支吃掉
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const BUNDLE = 'dsh-graft-slice/client.js'

function loadPanel() {
  const source = readFileSync(join(ROOT, BUNDLE), 'utf8')
  let captured
  const effects = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    useState(initial) {
      if (React.__cursor >= React.__slots.length) {
        React.__slots.push({ value: typeof initial === 'function' ? initial() : initial })
      }
      const slot = React.__slots[React.__cursor]
      React.__cursor += 1
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect(fn) { effects.push(fn) },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(initial) { return { current: initial } },
    __slots: [],
    __cursor: 0,
    __beginRender() { React.__cursor = 0 },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { captured = definition } } },
    require(name) {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    console: { log() {}, error() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  const run = new Function(
    'window', 'require', 'console', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    `"use strict";\n${source}\n`,
  )
  run(
    sandbox.window, sandbox.require, sandbox.console,
    sandbox.setInterval, sandbox.clearInterval, sandbox.setTimeout, sandbox.clearTimeout,
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
   * A bridge whose ANSWER can be swapped between calls. That is what timeline B needs — a fixed
   * failing bridge cannot express 「it worked, then it did not」, and that timeline is the one where the
   * defect is most visible (green badge beside a red 「读取失败」 card).
   */
  let reply = { ok: true, via: 'test', text: '{}' }
  const bridge = {
    attach() {},
    state: async () => reply,
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  }
  return {
    setReply: (next) => { reply = next },
    draw: () => {
      React.__beginRender()
      return mod.__panelForTest({ bridge })
    },
    runEffects: async () => {
      for (const fn of effects) fn()
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') return textOf(node.type(node.props || {}), out)
  for (const child of node.children ?? []) textOf(child, out)
  if (node.props && node.props.children !== undefined) textOf(node.props.children, out)
  return out
}

/** The panel body without the raw JSON dump — it echoes every field and defeats negative assertions. */
const panelBody = (text) => {
  const start = text.lastIndexOf('转生控制台')
  const body = start >= 0 ? text.slice(start) : text
  const dump = body.indexOf('原始状态数据')
  return dump >= 0 ? body.slice(0, dump) : body
}

const HEALTHY = {
  degraded: false,
  configWritable: true,
  config: {},
  thresholds: { warnAt: 0.7, hardAt: 0.75, windowLimit: 1000000, compaction: null },
  compaction: { source: 'computed', effectiveHardAt: 0.75, thresholdRatio: 0.8, readable: true },
  rows: [],
  pendingIgnitions: [],
  sessions: [],
}

const DEGRADED = {
  degraded: true,
  degradedReason: '没有可测量的活动会话：阈值由配置推导，不代表任何真实窗口',
  configWritable: true,
  config: {},
  thresholds: { warnAt: 0.7, hardAt: 0.75, windowLimit: 1000000, compaction: null },
  rows: [],
  pendingIgnitions: [],
  sessions: [],
}

const FAILURE = { ok: false, via: 'test', text: '桥接超时（3000ms 内宿主没有响应）' }
const answer = (payload) => ({ ok: true, via: 'test', text: JSON.stringify(payload) })

const badgeOf = (text) =>
  ['宿主通道未连通', '宿主通道降级', '已连通 · 推导缺失', '宿主通道正常', '正在读取…']
    .find((name) => text.includes(name)) ?? '(none)'

test('v319 ①: the FIRST fetch failing ⇒ 「未连通」, not 「降级」', async () => {
  /**
   * A bridge that never answered is NOT a host that answered with untrustworthy numbers. The old code
   * said 「降级」 here because the failure path stores a `degraded: true` fallback — the most consequential
   * confusion this panel can make, since it sends the operator to read switches instead of the bridge.
   */
  const { setReply, draw, runEffects } = loadPanel()
  setReply(FAILURE)
  draw()
  await runEffects()
  const text = panelBody(textOf(draw()).join(' '))
  assert.match(text, /宿主通道未连通/u,
    `首次就失败必须说「未连通」；实测徽章=${badgeOf(text)}，面板：${text.slice(0, 400)}`)
  assert.equal(badgeOf(text), '宿主通道未连通',
    `徽章必须**只是**「未连通」，不得同时出现「降级」；实测=${badgeOf(text)}`)
})

test('v319 ②: succeeded once, then fails ⇒ the badge must NOT still say 「正常」', async () => {
  /**
   * The most objectionable timeline: a green 「宿主通道正常」 badge sitting beside a red card reading
   * 「读取失败」. The retained payload is why the old `state === null` test never fired a second time.
   */
  const { setReply, draw, runEffects } = loadPanel()
  setReply(answer(HEALTHY))
  draw()
  await runEffects()
  const before = panelBody(textOf(draw()).join(' '))
  assert.equal(badgeOf(before), '宿主通道正常', '前提确认：先成功的这一帧徽章应当是绿的')

  setReply(FAILURE)
  await runEffects()
  const after = panelBody(textOf(draw()).join(' '))
  assert.equal(badgeOf(after), '宿主通道未连通',
    `成功后失败必须翻成「未连通」——现在是绿徽章配红卡；实测=${badgeOf(after)}，面板：${after.slice(0, 400)}`)
  assert.match(after, /读取失败/u, '前提确认：红卡同时在说「读取失败」（两句必须一致）')
})

test('v319 ③ (negative half): a DEGRADED host is still 「降级」 — not swallowed by the error branch', async () => {
  /**
   * Without this, ①② are satisfied by making everything 「未连通」. A host that answered and told us its
   * numbers are not this machine's configuration is a different fact, and the switches stay writable.
   */
  const { setReply, draw, runEffects } = loadPanel()
  setReply(answer(DEGRADED))
  draw()
  await runEffects()
  const text = panelBody(textOf(draw()).join(' '))
  assert.equal(badgeOf(text), '宿主通道降级',
    `降级仍是降级，不许被 error 分支吃掉；实测=${badgeOf(text)}`)
  assert.equal(text.includes('宿主通道未连通'), false,
    `降级不是断连（那份 payload 就是经这条通道送来的）；实测：${text.slice(0, 400)}`)
})

test('v319 ④: before the first fetch lands the badge says 「正在读取…」, not a verdict', async () => {
  /**
   * §〇 26 corollary. The old code asserted 「未连通」 on the very first frame — before anything had been
   * attempted. A verdict that arrives before the attempt is not a verdict; it is a guess that happens to
   * look like one. The three timelines above then become the only places a verdict may come from.
   */
  const { setReply, draw } = loadPanel()
  setReply(answer(HEALTHY))
  const text = panelBody(textOf(draw()).join(' '))
  assert.equal(badgeOf(text), '正在读取…',
    `尚未尝试时不得断言「未连通」；实测=${badgeOf(text)}`)
})
