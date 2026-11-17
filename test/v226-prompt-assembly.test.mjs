/**
 * ── v226：prompt 组装的端到端 —— 用户说「这条别再用」，模型真的收不到 ──────────────────────────
 *
 * ── 为什么需要这个文件（实测缺口，2026-11-17 评审）────────────────────────────────────────────
 *
 * v224 ①⑥ 断言的是 `buildInjectionPlan(...).constraints` 里没有那条文本 —— 那是**计划**，
 * 不是**模型看到的东西**。而 F3 的全部承诺是「用户说这条别再用，它就真的不再出现在模型面前」。
 *
 * 中间还有整整两跳，v224 一跳都没走：
 *
 *     plan.constraints
 *       ↓  index.ts L7380  targetConstraintSections.set(newId, { constraints: [...plan.constraints] })
 *       ↓  index.ts L10728 systemPrompt.section({ name: 'graft:constraints', text: (context) => … })
 *     '## Standing constraints for this work' + '1. …'     ← 最终进入 prompt 的字符串
 *
 * 两跳的任何一跳断掉，v224 都仍然全绿，而功能是哑的。这个文件走完整条链路：
 * 记录来自**真实 store**、切片走**真实工具**、断言打在**渲染后的字符串**上。
 *
 * ── 三条判据 ────────────────────────────────────────────────────────────────────────────────────
 *
 *   ① reject 过的文本**不出现在渲染文本里**，且它确实在源日志里（否则断言是空转）
 *   ② 主动 add 的文本**出现在渲染文本里**，且它不在源日志里（所以只能是主动轨送进去的）
 *   ③ 渲染层仍受 5 条上限约束（计划层守了，最后一跳也必须守）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, constraintRejectionPath, readConstraintRejections, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

const WS = 'D:\\持久层能力架构'
const KEPT = '绝不能在没有备份的情况下删除任何脚本；'
const DROPPED = '必须在每次提交前手写一份变更说明文档。'
const DECLARED = '禁止把任何凭据写入测试夹具目录'
/**
 * ── THE TEXT MUST MATCH WHAT EXTRACTION ACTUALLY PRODUCED, PUNCTUATION INCLUDED ─────────────────
 *
 * Measured while writing this file: the fixture sentence `…；…。` is split into two candidates, and
 * each one KEEPS its terminating punctuation (`绝不能…脚本；` / `必须…文档。`). The first version of
 * this test rejected `必须…文档` — without the `。` — so the record matched nothing, the rule stayed in
 * the prompt, and the test "proved" the whole chain was broken. It was not: the test was comparing
 * two different strings.
 *
 * That failure mode is worth the paragraph: a false red here is cheap (it fails loudly), but the same
 * mistake in the OTHER direction is what D9 is about. If the filter had been fuzzy-matched instead of
 * exact, this test would have been green against a filter that rejects neighbouring sentences too.
 *
 * So: the strings below are copied from what the extractor emits, not from what reads nicely.
 */
/**
 * The same stand-in `v70-compaction-immunity` uses, and the reason is not convenience:
 * `apply()` resolves the section registry through `ctx.get('systemPrompt')`, so a fixture that only
 * sets `ctx.systemPrompt` never gets `graft:constraints` registered — and then every assertion here
 * would pass against an empty string. A test that renders nothing proves nothing.
 */
function installSystemPrompt(ctx) {
  const sections = new Map()
  ctx.systemPrompt = {
    section(definition) {
      if (!Number.isFinite(definition.order)) throw new TypeError('order must be finite')
      sections.set(definition.name, definition)
      return () => sections.delete(definition.name)
    },
    getSectionOrder() {
      return 100
    },
  }
  ctx.get = ((original) => (name) => {
    if (name === 'systemPrompt') return ctx.systemPrompt
    return original(name)
  })(ctx.get)
  return sections
}

function harness(sessionId) {
  const log = makeSourceLog({ turns: 2, sourceSessionId: sessionId, cwd: WS })
  // Both rules live in REAL user messages, so "it is in the log" is a fact rather than a claim.
  log.events.push({
    type: 'user/message',
    seq: log.events.length,
    time: Date.now(),
    data: {
      id: 'uc-rules',
      role: 'user',
      content: [{ type: 'text', text: `${KEPT}；${DROPPED}。` }],
      source: { kind: 'user' },
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  return log
}

const callTool = (ctx, name, args, sessionId) =>
  ctx._tools.get(name).execute(args, {
    agent: { id: sessionId },
    callId: 'v226',
    name,
    arguments: args,
    signal: undefined,
  })

/** Slice for real, then return the STRING the host would put in front of the model. */
async function sliceAndRender(ctx, sections, log, targetId) {
  const report = await callTool(
    ctx,
    'graft_slice_and_inject',
    { sourceSessionId: log.session.id, newSessionId: targetId },
    log.session.id,
  )
  assert.equal(report.ok, true, `切片本身必须成功，否则下面的断言测的不是 prompt 组装：${JSON.stringify(report).slice(0, 300)}`)
  const definition = sections.get('graft:constraints')
  assert.ok(definition !== undefined, 'graft:constraints 段必须在 apply() 时注册')
  return definition.text({ agent: { session: { id: targetId } } })
}

/** One slice, one render — the common shape. Keeps each test to a single migration. */
async function freshRun(prefix, sessionId) {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const log = harness(sessionId)
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  const sections = installSystemPrompt(ctx)
  apply(ctx, { dataDir: dir })
  return { dir, log, ctx, sections }
}

test('① reject 过的文本不出现在 system prompt 段落里（kept 的仍在）', async () => {
  const { dir, log, ctx, sections } = await freshRun('graft-v226-reject-', 'session-v226-reject')
  try {
    // ── 前置条件：不否决时，两条都在渲染文本里。否则下一条断言是空转。 ──────────────────────────
    const before = await sliceAndRender(ctx, sections, log, 'target-v226-reject-a')
    assert.ok(before.length > 0, '渲染文本不许为空 —— 空文本会让「被否决的不在里面」变成恒真')
    assert.ok(before.includes(KEPT), `前置条件：KEPT 本来应当进 prompt。实测渲染：\n${before}`)
    assert.ok(before.includes(DROPPED), `前置条件：DROPPED 本来应当进 prompt。实测渲染：\n${before}`)

    // ── 用真实工具写否决（不手写文件：store 的写入路径也是链路的一环）──────────────────────────
    const receipt = await callTool(
      ctx,
      'graft_constraint',
      { action: 'reject', text: DROPPED, workspace: WS, reason: 'v226' },
      log.session.id,
    )
    assert.equal(receipt.ok, true, `reject 必须成功：${JSON.stringify(receipt)}`)
    assert.equal(readConstraintRejections(constraintRejectionPath(dir)).length, 1, '否决必须落盘')

    // ── 再切一次（源已被转移 ⇒ 显式 allowReslice），这次渲染文本里不许有 DROPPED ────────────────
    const report = await callTool(
      ctx,
      'graft_slice_and_inject',
      { sourceSessionId: log.session.id, newSessionId: 'target-v226-reject-b', allowReslice: true },
      log.session.id,
    )
    assert.equal(report.ok, true, `第二次切片必须成功：${JSON.stringify(report).slice(0, 300)}`)
    const after = sections.get('graft:constraints').text({ agent: { session: { id: 'target-v226-reject-b' } } })

    assert.equal(after.includes(DROPPED), false,
      `被否决的文本仍然进了 system prompt —— 整条链路最后一跳是断的。实测渲染：\n${after}`)
    assert.ok(after.includes(KEPT), `否决不许波及无关的规则。实测渲染：\n${after}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    resetRetiredSessions()
  }
})

test('② 主动 add 的文本出现在 system prompt 段落里（而它不在源日志里）', async () => {
  const { dir, log, ctx, sections } = await freshRun('graft-v226-manual-', 'session-v226-manual')
  try {
    /**
     * 这一条是关键：DECLARED 从来不在源日志里。所以它出现在渲染文本里，
     * **只可能**是主动轨送进去的 —— 正则抽取取不到一段用户没说过的话。
     */
    assert.equal(JSON.stringify(log.events).includes(DECLARED), false, '前置条件：DECLARED 不在源日志里')

    const receipt = await callTool(ctx, 'graft_constraint', { action: 'add', text: DECLARED, workspace: WS }, log.session.id)
    assert.equal(receipt.ok, true, `add 必须成功：${JSON.stringify(receipt)}`)
    assert.equal(receipt.effect, 'prompt', '回执必须说明它落在 prompt 这条轨道上')

    const rendered = await sliceAndRender(ctx, sections, log, 'target-v226-manual-a')
    assert.ok(rendered.length > 0, '渲染文本不许为空')
    assert.ok(rendered.includes(DECLARED),
      `主动声明的约束没有到达 system prompt。实测渲染：\n${rendered}`)
    // 它渲染成一条编号规则，而不是散文里偶然提到。
    assert.match(rendered, new RegExp(`^\\s*\\d+\\.\\s+${DECLARED}$`, 'mu'),
      `主动声明必须以编号条目出现。实测渲染：\n${rendered}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    resetRetiredSessions()
  }
})

test('③ 渲染层仍受 5 条上限约束（不是计划层独自守）', async () => {
  const { dir, log, ctx, sections } = await freshRun('graft-v226-cap-', 'session-v226-cap')
  try {
    const ten = Array.from({ length: 10 }, (_, i) => `主动声明的第 ${i} 条规则必须始终生效`)
    for (const text of ten) {
      const receipt = await callTool(ctx, 'graft_constraint', { action: 'add', text, workspace: WS }, log.session.id)
      assert.equal(receipt.ok, true, `add 「${text}」必须成功：${JSON.stringify(receipt)}`)
    }

    const rendered = await sliceAndRender(ctx, sections, log, 'target-v226-cap-a')
    const numbered = rendered.split('\n').filter((line) => /^\s*\d+\.\s+/u.test(line))
    /**
     * ── THE CAP HAS TO HOLD AT THE LAST HOP, NOT ONLY IN THE PLAN ────────────────────────────────
     *
     * v222 ③ proves `selectConstraints` caps the prompt at five. But the renderer reads
     * `targetConstraintSections`, which is filled from `plan.constraints` at L7380. If that fill ever
     * used the CANDIDATE list instead of the selected one, the plan test would stay green while the
     * model received ten rules — the cap would be enforced in a place nobody looks.
     */
    assert.equal(numbered.length, 5,
      `渲染出的条目数必须等于 CONSTRAINT_PROMPT_MAX。实测 ${numbered.length} 条：\n${rendered}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    resetRetiredSessions()
  }
})
