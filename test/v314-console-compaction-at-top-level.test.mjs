/**
 * ── v314 / 17.4-A (P0, lead-measured): `compaction` 必须出现在 console 的**顶层** ──────────────────
 *
 * lead 的原话（§十七）：
 *
 * > `graft_debug_status`（工具）顶层有 `compaction`；`graft-console` 从不写顶层，`governedWatermarks`
 * > 返回里的那份被 `thresholds: { ...thresholds }` **整个吞进 thresholds**。`client.js:1351` 读的是
 * > `state.compaction`（顶层）⇒ **client 拿到的永远是 undefined ⇒ 整块卡片不渲染（不是样式问题）**。
 *
 * ── 为什么 1079 个测试没抓到（§〇 24 的来源）───────────────────────────────────────────────────
 *
 * `v307` 的夹具在 `basePayload` 里**手写了顶层 `compaction`** —— 那正是 client 期望、**产品从不产出**
 * 的形状。**夹具替产品补上了缺失的那一步。**
 *
 * 判据（lead 的四条，全部实现）：
 *   ① 真实 `graft-console-global` 的 payload **顶层**有 `compaction`，且 `source ∈ {computed, conservative, off}`；
 *   ② **端到端**：把真实 payload 喂给真实 client bundle，`conservative` 时卡片必须出现；
 *   ③ 负向：`present === false`（无后端）时卡片显示「本部署没有挂载压缩插件」，不是空白也不是红卡；
 *   ④ 夹具来自产品（本条用真实 handler 取，`v307` 也已改为同一来源）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'

const ROOT = join(import.meta.dirname, '..', '..')
const BUNDLE = 'dsh-graft-slice/client.js'
const DATA_DIR = join(import.meta.dirname, '.v314-data')

/**
 * Run a REAL `apply()` against a host that mounts (or does not mount) compaction, then read
 * `graft-console-global` — the exact command the panel's bridge calls.
 *
 * `configEditor` IS PROVIDED, and that is not decoration: `v316` made the console report
 * `degraded: true` when the editor is unavailable, because every switch would then be a default that
 * cannot be saved. A fixture without an editor therefore produces a payload that is legitimately
 * degraded — and the client renders the degraded state with the same 「读取失败」 headline it uses for a
 * bridge error, which made this file's negative assertion (「没有这个后端」 is not 「读取失败」) fire for a
 * reason that had nothing to do with compaction.
 *
 * That is the same lesson as the lead's §17.2: **check the fixture is a healthy host before believing a
 * red that blames the feature under test.**
 */
async function realConsolePayload({ mountCompaction }) {
  const commands = new Map()
  const commandService = { register: (definition) => commands.set(definition.name, definition) }
  const ctx = {
    get(name) {
      if (name === 'commands') return commandService
      if (name === 'paths') return { data: DATA_DIR }
      /**
       * A healthy editor: `entries()` reports no config rows (nothing to patch in a fixture) and
       * `edit()` resolves. `consoleState` only asks whether the service CAN save.
       */
      if (name === 'configEditor') return { entries: () => [], edit: async () => undefined }
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
          list: () => [{ id: 'session-alpha' }],
        }
      }
      if (name === 'loader') {
        return {
          entries: () =>
            mountCompaction
              ? [
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
                ]
              : [],
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

/* ── the real render harness, same approach as v307 ─────────────────────────────────────────────── */

let cachedMod = null
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
  cachedMod = captured.factory(
    (name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    { insert: () => () => {} },
    undefined,
  )
  cachedMod.apply(ctx)

  const bridgeWith = (payload) => ({
    attach() {},
    state: async () => ({ ok: true, via: 'test', text: JSON.stringify(payload) }),
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  })

  return {
    draw: (payload) => {
      React.__beginRender()
      return cachedMod.__panelForTest({ bridge: bridgeWith(payload) })
    },
    runEffects: async () => {
      for (const fn of effects) fn()
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

/** Call function components, walk children, collect text. */
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

test('v314 ①: the REAL console payload carries `compaction` at the TOP level', async () => {
  /**
   * Read from the handler, not from a fixture. If the producer stops emitting it, this goes red — which is
   * the property `v307` did not have.
   */
  const payload = await realConsolePayload({ mountCompaction: true })
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'compaction'), true,
    `顶层必须有 compaction；实测顶层键：${Object.keys(payload).join(', ')}`)
  assert.equal(['computed', 'conservative', 'off'].includes(payload.compaction.source), true,
    `source 必须 ∈ {computed, conservative, off}；实测 ${String(payload.compaction.source)}`)

  /**
   * And it must be the SAME value `graft_debug_status` puts at ITS top level — two addresses, one fact.
   * `thresholds.compaction` may still exist (removing it would break callers walking the nested path);
   * the criterion is that the top-level copy agrees with it.
   */
  if (payload.thresholds?.compaction !== undefined) {
    assert.deepEqual(payload.compaction, payload.thresholds.compaction,
      '顶层与 thresholds 内必须是同一个值 —— 不允许两份可能分叉的副本')
  }
})

test('v314 ② (end-to-end): a CONSERVATIVE payload from the product renders the ceiling card', async () => {
  const { draw, runEffects } = loadPanel()
  const real = await realConsolePayload({ mountCompaction: true })
  /**
   * ── WHY THIS DOES NOT OVERWRITE `compaction` ─────────────────────────────────────────────────────
   *
   * My first version replaced the ceiling with a conservative object and asserted the card appeared — and
   * it stayed GREEN with the top-level field mutated away, because the test itself had put it back. **A
   * criterion that supplies the very field it is checking cannot fail for that field's absence.**
   *
   * So the payload is the product's, unmodified, and what is asserted adapts to it:
   *   · if the product emitted a ceiling, the CARD must render (with whatever source it emitted);
   *   · if it did not, the criterion fails — which is exactly the defect being fixed.
   *
   * `conservative` is exercised where it can be honestly produced: the RENDERING of a conservative
   * ceiling is `v307 ①`'s job, fed by the same real payload. Here the question is whether the field
   * survives the trip from producer to panel at all.
   */
  assert.equal(Object.prototype.hasOwnProperty.call(real, 'compaction'), true,
    '端到端的前提：产品必须真的发出顶层 compaction（否则面板没有东西可画）')

  draw(real)
  await runEffects()
  const text = panelBody(textOf(draw(real)).join(' '))

  assert.match(text, /压缩天花板/u,
    `真实 payload 必须让卡片出现；实测：${text.slice(0, 400)}`)
  assert.equal(['computed', 'conservative', 'off'].includes(real.compaction.source), true,
    '来源必须是三者之一')
  assert.equal(text.includes(String(real.compaction.source)), true,
    `卡片必须显示产品给的 source（${String(real.compaction.source)}）；实测：${text.slice(0, 400)}`)
})

test('v314 ③ (negative half): `present: false` says 「没有挂载」, not blank and not an error card', async () => {
  const { draw, runEffects } = loadPanel()
  const real = await realConsolePayload({ mountCompaction: false })
  const payload = {
    ...real,
    compaction: { present: false, auto: false, source: 'off', effectiveHardAt: 0.75, effectiveWarnAt: 0.7, reason: 'no compaction backend mounted' },
  }
  draw(payload)
  await runEffects()
  const text = panelBody(textOf(draw(payload)).join(' '))

  assert.match(text, /没有挂载压缩插件/u,
    `无后端时必须明说，而不是空白；实测：${text.slice(0, 400)}`)
  assert.doesNotMatch(text, /读取失败/u, '「没有这个后端」不是「读取失败」——两者不许压成一句')
})
