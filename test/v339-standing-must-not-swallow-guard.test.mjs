/**
 * ── v339 / D1 (P0, SECURITY)：standing 分支不得吞掉红线（report §3.1 / 优化项 O3）────────────────
 *
 * 路径：**真实 `agent/pre-step`**（`dispatchPreStep`）—— 不是读源码文本，也不是调判定函数。
 *
 * ── 缺陷（实测复核，2026-11-24）────────────────────────────────────────────────────────────────
 *
 * `index.ts` 在 pre-step 里把工作目录红线收进 `guardMessages`，并在旁边写着
 * 「COLLECTED, never returned early」。但紧接着的 standing 分支：
 *
 *     if (!constraintsReasserted.has(agentId)) {
 *       const standing = targetConstraintSections.get(agentId)
 *       if (standing !== undefined && standing.constraints.length > 0) {
 *         …
 *         return { kind: 'enter', messages: [...existing, standing] }   ← 早退
 *
 * `existing` 只来自 `payload.messages`，**不含 `guardMessages`**；而 `guardMessages` 的合并点在
 * 这个 `return` 之后（`:12717`），永远到不了。
 *
 * 命中的正是最要紧的那个场景：**刚迁移过来的目标会话的第一次 pre-step**。目标一定带着
 * standing 约束（graft 会写进去），所以它一定走这个分支，于是工作目录红线静默消失。
 * 现场读数是 `standing=1 / guard=0`。
 *
 * > **只在「另一个分支」运行时才出现的红线，不是红线。**
 *
 * ── 判据（三条，两条负向）──────────────────────────────────────────────────────────────────────
 *
 *   ① standing 分支的注入里**必须**同时有红线与该会话的 standing 约束
 *   ② **负向** 红线只出现一次 —— 修法不许变成「两次都注入」
 *   ③ **负向** can-red：把 `...guardMessages` 从那个返回里去掉 ⇒ ① 必须红
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { FakePersistence, dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)

/** Messages are `{ content: [{ type: 'text', text }] }`. */
const textsOf = (messages) =>
  (messages ?? [])
    .map((message) => {
      if (typeof message === 'string') return message
      const content = message?.content
      if (Array.isArray(content)) return content.map((part) => String(part?.text ?? '')).join('')
      return String(content ?? message?.text ?? '')
    })
    .join('\n')

/**
 * A target session that ALREADY carries standing constraints — i.e. exactly what graft produces.
 *
 * The state is established through the PRODUCTION path, not by reaching into a private map: graft
 * writes `.graft-constraint-sections.json` under its data dir and `loadConstraintSections` reads it
 * back during `apply()`. Writing that file before activation is therefore the same route the plugin
 * itself uses — which is what makes this test's premise real instead of imitated.
 */
function bootWithStandingConstraints() {
  const dir = mkdtempSync(join(tmpdir(), 'v339-standing-'))
  /** v337 / A5: prove both hooks exist before calling them optionally. */
  assert.equal(typeof plugin.clearGraftTargetsForTest, 'function', 'clearGraftTargetsForTest 必须导出')
  assert.equal(typeof plugin.resetRetiredSessions, 'function', 'resetRetiredSessions 必须导出')
  plugin.clearGraftTargetsForTest?.()
  plugin.resetRetiredSessions?.()
  const sourceLog = makeSourceLog({ turns: 1 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence() })
  const sessionId = sourceLog.session.id

  /** The file graft writes and re-reads; its shape is `{ [sessionId]: { constraints, at } }`. */
  writeFileSync(
    join(dir, '.graft-constraint-sections.json'),
    JSON.stringify({
      [sessionId]: {
        constraints: ['绝对不能 import re，也不能以任何方式使用正则表达式。'],
        at: Date.now(),
      },
    }),
    'utf8',
  )

  plugin.apply(ctx, {
    dataDir: dir,
    graftTargetGraceTurns: 5,
    autoGraft: false,
    modelDrivenGraft: false,
  })
  /** The target mark makes `chainProtected` true, which is the migration-target scenario. */
  plugin.getGraftTargets().set(sessionId, {
    sourceSessionId: `${sessionId}-upstream`,
    createdAt: Date.now(),
    generation: 2,
  })
  return { dir, sessionId, ctx }
}

test('v339 ①: the standing branch carries the red line too (a migrated target keeps its guard)', async () => {
  const { dir, sessionId, ctx } = bootWithStandingConstraints()
  try {
    const decision = await dispatchPreStep(ctx, { sessionId, messages: [] })
    const texts = textsOf(decision?.messages)

    assert.match(
      texts,
      /工作目录红线/u,
      `① standing 分支必须同时带红线 —— 否则「已迁移目标首次注入」时红线静默消失。实测：${texts.slice(0, 500) || '(空)'}`,
    )
    assert.match(
      texts,
      /绝对不能 import re/u,
      `① 同时必须带该会话的 standing 约束（前置条件：文件已被 apply 读回）。实测：${texts.slice(0, 500) || '(空)'}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v339 ② (negative): the red line appears ONCE, not twice', async () => {
  /**
   * The lazy repair is to add `guardMessages` at BOTH exits, which duplicates a top-priority
   * instruction in the same prompt. Two copies of a red line is not "safer" — it is the same
   * instruction competing with itself for the same scarce slot.
   */
  const { dir, sessionId, ctx } = bootWithStandingConstraints()
  try {
    const decision = await dispatchPreStep(ctx, { sessionId, messages: [] })
    const texts = textsOf(decision?.messages)
    const occurrences = texts.split('工作目录红线').length - 1
    assert.equal(occurrences, 1, `② 红线只能出现一次，实测 ${occurrences} 次`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v339 ③ (negative): the criterion can fail — removing `...guardMessages` breaks ①', () => {
  /**
   * A criterion that reads the injected array is strong, but it can still be vacuous if the red line
   * arrives through some OTHER path. This third half pins the specific mechanism: the standing
   * branch's own message list must contain the spread.
   *
   * MEASURED SELF-HARM (first run of this very assertion): it went GREEN while the spread had been
   * deleted, because the DOC COMMENT above it quotes `...guardMessages` as the thing v339 proves.
   * A grep that does not exclude comments measures the explanation, not the code — the third time
   * in this batch (v336 ①, v337 ①, here). Comments are stripped first, and then the assertion is
   * run against a WINDOW anchored on the standing marker, so an unrelated spread elsewhere in the
   * file cannot satisfy it either.
   */
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
    })
    .join('\n')
  const markerAt = code.indexOf('graft-standing-')
  assert.notEqual(markerAt, -1, '③ 必须在源码里找到 standing 分支的标记')
  /** Everything BEFORE the marker, up to the start of its message array — the guard belongs here. */
  const beforeMarker = code.slice(Math.max(0, markerAt - 2000), markerAt)
  assert.match(
    beforeMarker,
    /\.\.\.guardMessages/u,
    '③ standing 分支的消息数组里必须显式展开 `guardMessages` —— 它是「每个出口都带红线」的结构保证' +
      '（注释里的引用不算，必须是真的代码行）',
  )
})
