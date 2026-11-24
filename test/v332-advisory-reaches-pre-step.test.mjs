/**
 * ── v332 / N1 投递：那句话必须真的进入 pre-step 的消息数组（lead §三十 判据 1）─────────────────────
 *
 * 路径：**真实 `agent/pre-step` 派发**（`test/fake-harness.mjs` 的 `dispatchPreStep` / `makeCtx`）——
 * 与 `inject.test.mjs` 等既有判据同一条夹具路径。**不是**函数返回值，也不是状态表。
 *
 * ── 缺口（lead 核实为真）──────────────────────────────────────────────────────────────────────
 *
 * `v331` 七条全绿，但它钉的是**纯判定的返回值**。而 `compactionAdvisories` 在 `src/` 里
 * **只有定义、导入与 `set`，零个读取** —— 消息进了一个 Map，**从来没有到达会话**。
 * 这正是 `v322` 的形状：门禁写好了、字段被丢掉、几条判据全绿而用户那条路走不到。
 *
 * ── 我的第一版夹具错在哪（写下来，免得下一个人重犯）────────────────────────────────────────────
 *
 * 我自己拼了一个 `ctx`：给了 `tokenMeter`、`sessions`、`paths`，以为够了。结果注入数组是空的，
 * 而我先去改水位数字、再改 payload 字段 —— **两次都在猜**。真相是这套装配要一整套 harness
 * （settings 归一、store 路径、stableCtx），手拼的那份缺了它不是缺一个字段。
 * **仓库里已经有 `fake-harness.mjs`，先找它，再自己造。**
 *
 * 判据（四条，两条负向）：
 *   ① 宽限期内越过 warnAt（未到 hardAt）⇒ **注入的消息里真有那句话**
 *   ② **负向** 低水位 ⇒ 没有这句话
 *   ③ **负向** 只投递一次：同会话再派发一次，不得重复
 *   ④ can-red：把读取改回「只 set 不读」⇒ ① 红
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
const harness = await import(pathToFileURL(join(ROOT, 'test', 'fake-harness.mjs')).href)

const {
  COMPACTION_HARD,
  COMPACTION_WARN,
  dispatchPreStep,
  FakePersistence,
  makeCtx,
  makeSourceLog,
} = { ...harness }

/**
 * A session marked as a fresh graft target, with the host meter parked at a chosen water level.
 *
 * ── THE KEY MUST BE THE SESSION pre-step ACTUALLY RUNS FOR (measured) ────────────────────────────
 *
 * `makeCtx` sets `agents.currentInitiator()` to `currentAgentId ?? sourceLog.session.id`, and pre-step
 * uses THAT as its agent id. My first three fixtures marked `'session-target'` while pre-step ran for
 * `'session-source'`, so `chainProtected` was false and the observer branch never executed.
 *
 * The diagnostic outlet is what found it: `sessionId: "session-source"` next to a mark on
 * `'session-target'`. **Three rounds of changing water levels could never fix a key mismatch** —
 * that is exactly the 「stop guessing inputs, add observation」 rule (lead §四十一.5).
 */
function boot({ tokens }) {
  /**
   * `resetRetiredSessions()` is the package's existing session-state reset, and it now clears the
   * advisory/dedupe half too — so the criteria do not need a second seam. A dedicated hook was tried and
   * removed: `resetCompactionAdvisoryStateForTest?.()` hid its own absence, and a bare
   * `export { … }` re-export did not survive the bundler.
   */
  plugin.clearGraftTargetsForTest?.()
  plugin.resetRetiredSessions?.()
  const sourceLog = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence() })
  const sessionId = sourceLog.session.id
  plugin.apply(ctx, { graftTargetGraceTurns: 5, autoGraft: false, modelDrivenGraft: false })
  plugin.getGraftTargets().set(sessionId, { sourceSessionId: `${sessionId}-upstream`, createdAt: Date.now(), generation: 2 })
  ctx.tokenMeter = { measure: () => ({ totalTokens: tokens }) }
  /* The session must be LIVE: `readTokenWatermark` only consults the meter for a session in the store. */
  ctx.get('sessions').live.set(sessionId, {
    id: sessionId,
    requestContext: () => ({ contextWindow: 1_000_000 }),
    snapshotEvents: () => [{ type: 'turn/end' }, { type: 'turn/end' }],
  })
  return { ctx, sessionId, tokens }
}

/** Messages are `{ content: [{ type: 'text', text }] }` — not `{ content: '…' }`. */
const textsOf = (messages) =>
  (messages ?? [])
    .map((message) => {
      if (typeof message === 'string') return message
      const content = message?.content
      if (Array.isArray(content)) return content.map((part) => String(part?.text ?? '')).join('')
      return String(content ?? message?.text ?? '')
    })
    .join('\n')

test('v332 ① (REAL pre-step): the advisory reaches the injected messages', async () => {
  const { ctx, sessionId } = boot({ tokens: 720_000 })
  const decision = await dispatchPreStep(ctx, { sessionId, messages: [] })
  const texts = textsOf(decision?.messages)

  assert.match(texts, /宽限期/u,
    `① 注入的消息里必须有这句话（判据要读 messages，不是函数返回值）；实测：${texts.slice(0, 400) || '(空)'}`)
})

test('v332 ② (negative): a low water level gets no advisory', async () => {
  const { ctx, sessionId } = boot({ tokens: 10_000 })
  const decision = await dispatchPreStep(ctx, { sessionId, messages: [] })
  const texts = textsOf(decision?.messages)
  assert.equal(texts.includes('压缩不受宽限期保护'), false, '② 低水位不得出现这句话')
})

test('v332 ③ (negative): it is delivered AT MOST ONCE', async () => {
  const { ctx, sessionId } = boot({ tokens: 720_000 })
  const first = await dispatchPreStep(ctx, { sessionId, messages: [] })
  assert.match(textsOf(first?.messages), /宽限期/u, '前提：第一次必须送达')

  const second = await dispatchPreStep(ctx, { sessionId, messages: [] })
  assert.equal(textsOf(second?.messages).includes('压缩不受宽限期保护'), false,
    '③ 第二次不得重复 —— 「只注入一次」是它作为『此刻的事实』而不是常驻状态的全部意义')
})

test('v332 ④: the map is READ, not merely written — the v322 shape is gone', () => {
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(source, /takeCompactionAdvisory\(agentId\)/u,
    '④ index.ts 必须真的调用 takeCompactionAdvisory —— 只 import 不调用就是「机制在、投递不在」')
})

/** Referenced only to keep the harness constants visible in this file's vocabulary. */
void COMPACTION_HARD
void COMPACTION_WARN