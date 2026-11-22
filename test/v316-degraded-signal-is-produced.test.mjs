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

  /**
   * ── 18.6-D: THE OTHER WAY A RED CARD APPEARS ────────────────────────────────────────────────────
   *
   * `bridgeWith` always answers, so it can only ever produce the DEGRADED card. A card titled
   * 「读取失败」 comes from the bridge not answering at all, which is a different branch (`setError` +
   * `fallbackState`). Without this second drawer, 「the title follows the state」 cannot be tested — the
   * old literal passed every assertion because only one of the two states was reachable.
   */
  const failingBridge = (reason) => ({
    attach() {},
    state: async () => ({ ok: false, via: 'test', text: reason }),
    set: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
    clear: async () => ({ ok: true, via: 'test', text: '{"ok":true}' }),
  })

  return {
    draw: (payload) => {
      React.__beginRender()
      return mod.__panelForTest({ bridge: bridgeWith(payload) })
    },
    drawFailing: (reason) => {
      React.__beginRender()
      return mod.__panelForTest({ bridge: failingBridge(reason) })
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

/* ── 18.6-D ────────────────────────────────────────────────────────────────────────────────────────
 * 「值到了」与「值被说成了什么」是两条判据（§〇 25）。上面四条证明 `degraded` 到了；下面三条管它
 * 到了以后被说成了什么 —— 红卡标题、页脚，以及「通了」与「未连通」不许压成一句。
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** The red card's own text: from its title onward, so a badge match cannot satisfy a title assertion. */
const cardText = (text) => {
  const body = panelBody(text)
  const at = body.lastIndexOf('错误详情：')
  if (at < 0) return ''
  const head = Math.max(body.lastIndexOf('读取失败', at), body.lastIndexOf('宿主通道降级', at))
  return head >= 0 ? body.slice(head) : body.slice(at)
}

test('v316 ⑤: the red card TITLE follows the state — 「读取失败」 only when there WAS a read failure', async () => {
  const { draw, drawFailing, runEffects } = loadPanel()

  /**
   * Half A — the bridge ANSWERED with a well-formed payload saying 「degraded」. Nothing failed to be read,
   * so 「读取失败」 is a false statement and the title must be 「宿主通道降级」.
   */
  const degradedPayload = await realPayload({ editorAvailable: false })
  draw(degradedPayload)
  await runEffects()
  const degradedCard = cardText(textOf(draw(degradedPayload)).join(' '))
  assert.equal(degradedCard.includes('读取失败'), false,
    `降级不是读取失败，标题不得说「读取失败」；实测红卡：${degradedCard.slice(0, 400)}`)
  assert.match(degradedCard, /宿主通道降级/u,
    `降级卡的标题必须是「宿主通道降级」；实测：${degradedCard.slice(0, 400)}`)

  /**
   * Half B (the other direction) — the bridge did NOT answer. Here 「读取失败」 is TRUE and must still
   * appear. Without this half, deleting the branch outright would pass.
   */
  drawFailing('桥接超时（探针）')
  await runEffects()
  const failedCard = cardText(textOf(drawFailing('桥接超时（探针）')).join(' '))
  assert.match(failedCard, /读取失败/u,
    `真的没读到时必须说「读取失败」；实测红卡：${failedCard.slice(0, 400)}`)
})

test('v316 ⑥: the footer 「开关是默认值」 appears ONLY when the switches really are defaults', async () => {
  const { draw, drawFailing, runEffects } = loadPanel()

  /** Case 1 — no measurable session: degraded, but every switch on that screen is REAL and writable. */
  const noSession = await realPayload({ editorAvailable: true, withSession: false })
  draw(noSession)
  await runEffects()
  const noSessionCard = cardText(textOf(draw(noSession)).join(' '))
  assert.match(noSessionCard, /没有可测量的活动会话/u, '这一屏确实因无会话而降级（前提确认）')
  assert.equal(noSessionCard.includes('以上开关显示的是插件默认值'), false,
    `开关是真的就不许说它们是默认值（同一张卡不能自相矛盾）；实测：${noSessionCard.slice(0, 500)}`)

  /** Case 2 (other direction) — `configEditor` unavailable ⇒ the claim IS true and must print. */
  const noEditor = await realPayload({ editorAvailable: false })
  draw(noEditor)
  await runEffects()
  const noEditorCard = cardText(textOf(draw(noEditor)).join(' '))
  assert.match(noEditorCard, /以上开关显示的是插件默认值/u,
    `configEditor 不可用时必须说开关是默认值；实测：${noEditorCard.slice(0, 500)}`)

  /** Case 3 — the bridge never answered: defaults, so the warning stays. */
  drawFailing('桥接超时（探针）')
  await runEffects()
  const failedCard = cardText(textOf(drawFailing('桥接超时（探针）')).join(' '))
  assert.match(failedCard, /以上开关显示的是插件默认值/u,
    `读不到时开关必然是默认值，警告不得消失；实测：${failedCard.slice(0, 500)}`)
})

test('v316 ③b: the no-session degradation asserts TITLE and FOOTER too, not just the badge', async () => {
  /**
   * 18.6-D ④: `v316 ③` / `v316 ④` only asserted the BADGE. That is precisely how the original defect
   * survived — the badge said 「宿主通道降级」 while the card underneath said 「读取失败」 +
   * 「以上开关显示的是插件默认值」. A criterion that reads one of the three places a state is rendered
   * cannot see the other two disagreeing with it.
   */
  const { draw, runEffects } = loadPanel()
  const payload = await realPayload({ editorAvailable: true, withSession: false })
  draw(payload)
  await runEffects()
  const text = panelBody(textOf(draw(payload)).join(' '))

  assert.match(text, /没有可测量的活动会话/u, '① 理由：说清是哪一种降级')
  assert.match(text, /宿主通道降级/u, '② 徽章：这是降级，不是断连')
  assert.equal(text.includes('宿主通道未连通'), false, '③ 徽章不得把「通了」说成「未连通」')

  const card = cardText(text)
  assert.match(card, /宿主通道降级/u, '④ 标题：由状态决定，不是字面量')
  assert.equal(card.includes('读取失败'), false, '⑤ 标题不得说「读取失败」——什么都没失败')
  assert.equal(card.includes('以上开关显示的是插件默认值'), false,
    '⑥ 页脚不得说开关是默认值——这一屏的开关是真的')
  assert.match(card, /点击「刷新」重试/u, '⑦ 页脚仍要给出下一步动作')
})
