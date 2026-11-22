/**
 * ── v316 / §〇 24 同族: 面板等一个产品从不发出的信号 ────────────────────────────────────────────────
 *
 * 缺陷（我自己在同族扫描里找到的，不是用户报的）：
 *
 *   `client.js` 有一整套 degraded 通道 —— 红色「宿主通道降级」卡片，键在 `state.degraded`，hint 默认写着
 *   「上面的数值是插件默认值，不是真实配置」。而 **`src/` 里 `degraded` 零命中**（只有 `pending-transfers.ts`
 *   里一句别义的注释）。信号从不发出，通道是死的。
 *
 * 这正是 §〇 第 24 条的反面：**读的一方写了，写的一方没写，而所有测试都绿** —— 因为夹具总能提供那个字段。
 *
 * 判据（写在「真实产物」上，不是夹具）：
 *   ① `configEditor` 不可用 ⇒ `degraded === true` 且 `degradedReason` 点名它
 *   ② 负向：**健康宿主**（editor 可用 + 有可测量会话）⇒ `degraded === false`
 *   ③ 没有可测量会话 ⇒ `degraded === true` 且理由说明「阈值由配置推导」
 *   ④ 端到端：`degraded: true` 的真实 payload 让 client 渲染出红色降级卡；`false` 时是绿色
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'

const ROOT = join(import.meta.dirname, '..', '..')
const BUNDLE = 'dsh-graft-slice/client.js'
const DATA_DIR = join(import.meta.dirname, '.v316-data')

/** Run a REAL console read with the host knobs a case needs. */
async function realPayload({ editorAvailable = true, withSession = true } = {}) {
  const commands = new Map()
  const commandService = { register: (definition) => commands.set(definition.name, definition) }
  const editor = editorAvailable
    ? { entries: () => [], edit: async () => undefined }
    : undefined
  const ctx = {
    get(name) {
      if (name === 'commands') return commandService
      if (name === 'paths') return { data: DATA_DIR }
      if (name === 'configEditor') return editor
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 723000 }) }
      if (name === 'sessions') {
        return {
          get: (id) => ({
            id,
            header: { id, cwd: 'D:/work/alpha' },
            snapshotEvents: () => [],
            requestContext: () => ({ contextWindow: 1048576 }),
            requestHeader: () => ({ config: { maxTokens: 64000 } }),
          }),
          list: () => (withSession ? [{ id: 'session-alpha' }] : []),
        }
      }
      if (name === 'loader') {
        return {
          entries: () => [
            {
              options: {
                name: '@deepseek-ai/dsh-agent-preset',
                config: {
                  id: 'cordis',
                  plugins: [
                    {
                      name: '@deepseek-ai/dsh-compaction-basic',
                      config: { auto: true, thresholdRatio: 0.8, headroomTokens: 65536 },
                    },
                  ],
                },
              },
            },
          ],
        }
      }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    tools: { register() {} },
  }
  resetRetiredSessions()
  apply(ctx, { autoGraft: true, autoGraftAtRatio: 0.75, modelDrivenGraftAtRatio: 0.7 })
  const command = commands.get('graft-console-global')
  assert.ok(command !== undefined, 'graft-console-global must be registered')
  const reply = await command.handler({})
  return JSON.parse(reply.text)
}

/* ── the real-render harness (same approach as v314) ────────────────────────────────────────────── */

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

  const bridgeWith = (payload) => ({
    attach() {},
    state: async () => ({ ok: true, via: 'test', text: JSON.stringify(payload) }),
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  })

  return {
    draw: (payload) => {
      React.__beginRender()
      return mod.__panelForTest({ bridge: bridgeWith(payload) })
    },
    runEffects: async () => {
      for (const fn of effects) fn()
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
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

const panelBody = (text) => {
  const start = text.lastIndexOf('转生控制台')
  const body = start >= 0 ? text.slice(start) : text
  const dump = body.indexOf('原始状态数据')
  return dump >= 0 ? body.slice(0, dump) : body
}

test('v316 ①: an unavailable `configEditor` marks the console degraded, and says why', async () => {
  const payload = await realPayload({ editorAvailable: false })
  assert.equal(payload.degraded, true,
    'configEditor 不可用时开关全是默认值，点击不落盘 —— 这必须是降级，不是「正常」')
  assert.equal(typeof payload.degradedReason, 'string', '降级必须带理由，不能只有一个布尔')
  assert.match(payload.degradedReason, /configEditor/u,
    `理由必须点名 configEditor；实测：${String(payload.degradedReason)}`)
})

test('v316 ② (negative half): a HEALTHY host must NOT be marked degraded', async () => {
  /**
   * Without this, ① is satisfied by 「always degraded」 — and a red card that is always on is wallpaper.
   */
  const payload = await realPayload({ editorAvailable: true, withSession: true })
  assert.equal(payload.degraded, false,
    `健康的宿主不得被标为降级；实测 degraded=${String(payload.degraded)} reason=${String(payload.degradedReason)}`)
  assert.equal(payload.degradedReason, undefined, '健康时不该带理由字符串')
})

test('v316 ③: no measurable session is ALSO degraded — thresholds describe a hypothetical window', async () => {
  /**
   * The panel's own hint promises this reading: 「上面的数值是插件默认值，不是真实配置」. With no session
   * the thresholds come from CONFIG, so the two numbers describe a session that does not exist.
   */
  const payload = await realPayload({ editorAvailable: true, withSession: false })
  assert.equal(payload.degraded, true,
    '没有可测量会话时阈值为配置推导值 —— 必须标明')
  assert.match(String(payload.degradedReason), /没有可测量的活动会话/u,
    `理由必须说清是哪一种降级；实测：${String(payload.degradedReason)}`)
})

test('v316 ④ (end-to-end): the degraded payload renders the RED card; a healthy one does not', async () => {
  const { draw, runEffects } = loadPanel()
  const degradedPayload = await realPayload({ editorAvailable: false })
  draw(degradedPayload)
  await runEffects()
  const degradedText = panelBody(textOf(draw(degradedPayload)).join(' '))
  assert.match(degradedText, /宿主通道降级/u,
    `降级时必须出现红卡；实测：${degradedText.slice(0, 400)}`)

  const healthyPayload = await realPayload({ editorAvailable: true, withSession: true })
  draw(healthyPayload)
  await runEffects()
  const healthyText = panelBody(textOf(draw(healthyPayload)).join(' '))
  assert.doesNotMatch(healthyText, /宿主通道降级/u,
    `健康时不得出现降级卡（否则红卡变成壁纸）；实测：${healthyText.slice(0, 400)}`)
  assert.match(healthyText, /宿主通道正常/u, '健康时必须说正常')
})
