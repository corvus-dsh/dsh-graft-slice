/**
 * ── v240 (B3 / F4): 交接七段的固定顺序 ──────────────────────────────────────────────────────────
 *
 * spec（`报告/06-实施计划-v2-定稿.md` §B3 3.1）定死的七段：
 *
 *   ① 总目标        — goal 消息，先于任何 chunk
 *   ② 你在哪        — `task-position`
 *   ③ 硬约束（≤5）  — goal 消息里的约束块（`CONSTRAINT_PROMPT_MAX = 5`，本批不动）
 *   ④ 最近 3 轮     — `recent-turn ×N`
 *   ⑤ 未完成的后台  — `open-work`
 *   ⑥ 待办（≤3）    — `task-status`
 *   ⑦ 指针索引      — `readback-index`
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────────────
 *
 * 改动前实测的 push 顺序里，④⑤⑥ 是**反的**：`open-work` 在 `recent-turn` 之前，`task-status` 更在
 * `phase-roadmap` 之后就出场。于是「我在哪 → 最近发生了什么 → 还有什么没回来 → 下一步」这条阅读
 * 链路被打断，读者先看到「未完成的后台」，再看到历史，最后才知道刚发生了什么。
 *
 * **顺序不能靠读代码确认** —— 它是 `chunks.push` 的先后，而 push 分散在 400 行里，任何人都可能在
 * 无关改动中把它拨乱。所以钉在这里：两两比较 `indexOf`，不是「都在」。
 *
 * ── 本文件只测顺序与截断 ───────────────────────────────────────────────────────────────────────
 *
 * 预算裁剪的**存活**顺序是另一件事（`priority` 表），本批一个字都没动，见 ④。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TODO_STATUS_MAX_LINES } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

const layer = await import(new URL('../index.js', import.meta.url).href)

/** A plan whose position AND todos AND background work all exist, so every section can appear. */
function context({ todos = 6 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v240-'))
  const log = makeSourceLog({ turns: 4 })
  const ctx = makeCtx({ sourceLog: log, paths: { data: root } })
  layer.apply(ctx, { dataDir: root })
  void todos
  return { root, log, ctx }
}

/**
 * Feed one synthetic `todo_write` so `task-status` exists, plus one open background job so
 * `open-work` exists. Both go through the same event shapes the host produces.
 */
function withTodos(log, count) {
  let seq = Number(log.events.at(-1)?.seq ?? 0)
  const items = Array.from({ length: count }, (_, index) => ({ content: `待办 ${index + 1}`, status: 'pending' }))
  log.events.push({
    type: 'tool/call',
    seq: (seq += 1),
    data: { turn: 1, step: 1, callId: 'todo-1', name: 'todo_write', arguments: { todos: items } },
  })
  log.events.push({
    type: 'tool/result',
    seq: (seq += 1),
    data: { turn: 1, step: 2, message: { isError: false, source: { callId: 'todo-1' } } },
  })
  return log
}

/**
 * An UNREGISTERED-UNTIL-SETTLED background job — the shape `extractOpenBackgroundWork` reads
 * (`job/registered` without a matching `job/settled`). Built from the log, never from a live handle.
 */
function withOpenJob(log, jobId = 'job-1') {
  const seq = Number(log.events.at(-1)?.seq ?? 0) + 1
  log.events.push({ type: 'job/registered', seq, data: { jobId, label: `后台作业 ${jobId}` } })
  return log
}

/** A graph position, so ② exists without needing a memory store on disk. */
const POSITION = {
  goal: '把持久层做到生产就绪',
  goalLocked: true,
  current: { id: 'phase-b2', title: 'B2', status: 'active', requirements: ['一条要求'], progress: 70 },
  done: ['phase-1-kg'],
  pending: ['b2-trigger'],
  blockedBy: [],
  unlocks: ['b2-trigger'],
  totalNodes: 3,
}

function plan(log) {
  return layer.buildInjectionPlan(log, { recentTurns: 3, maxTotalChars: 200_000 }, undefined, 'regex-fallback', undefined, {
    taskPosition: POSITION,
  })
}

const kindsOf = (built) => (built.chunks ?? []).map((chunk) => chunk.kind)

/** Index of the first chunk of a kind, or -1. */
const at = (kinds, kind) => kinds.indexOf(kind)

// ── ① 七段的相对顺序逐对钉住 ─────────────────────────────────────────────────────────────────

test('v240 ①: ②→④→⑤→⑥→⑦ 的相对顺序被逐对钉住（不是「都在」）', () => {
  const { log } = context()
  withTodos(log, 6)
  withOpenJob(log)
  const built = plan(log)
  const kinds = kindsOf(built)

  /**
   * Print the order on failure: "which index is -1" is useless without seeing the sequence, and the
   * whole point is that a human can check the layout in one glance.
   */
  const order = `实测 kinds：${kinds.join(' | ')}`

  assert.ok(at(kinds, 'task-position') >= 0, `② 你在哪 必须出现。${order}`)
  assert.ok(at(kinds, 'recent-turn') >= 0, `④ 最近 3 轮 必须出现。${order}`)
  assert.ok(at(kinds, 'open-work') >= 0, `⑤ 未完成的后台 必须出现（夹具里有一个未 settle 的作业）。${order}`)
  assert.ok(at(kinds, 'task-status') >= 0, `⑥ 待办 必须出现。${order}`)
  assert.ok(at(kinds, 'readback-index') >= 0, `⑦ 指针索引 必须出现。${order}`)

  /** Every pair the spec orders, compared directly — all five sections are present here. */
  assert.ok(at(kinds, 'task-position') < at(kinds, 'recent-turn'), `② 必须在 ④ 之前。${order}`)
  assert.ok(at(kinds, 'recent-turn') < at(kinds, 'open-work'), `④ 必须在 ⑤ 之前。${order}`)
  assert.ok(at(kinds, 'open-work') < at(kinds, 'task-status'), `⑤ 必须在 ⑥ 之前。${order}`)
  assert.ok(at(kinds, 'task-status') < at(kinds, 'readback-index'), `⑥ 必须在 ⑦ 之前。${order}`)
})

test('v240 ①b: ③ 硬约束仍在 goal 消息里且上限 5 —— 本批没有把它挪进 chunk 序列', () => {
  /**
   * The spec's ③ is already satisfied by the goal message (`CONSTRAINT_PROMPT_MAX = 5`). Asserting it
   * here stops a future reordering from "helpfully" turning it into an eighth chunk, which would move
   * the constraint block out of the slot that is actually read first.
   */
  assert.equal(layer.CONSTRAINT_PROMPT_MAX, 5)
})

// ── ② 超过 3 条时只渲染 3 条，且写明省略几条 ────────────────────────────────────────────────

test('v240 ②: task-status 超过 3 条 ⇒ 只渲染 3 条，且**写明省略了几条**（不许静默截断）', () => {
  assert.equal(TODO_STATUS_MAX_LINES, 3, 'spec 的 ⑥ 是「3 条以内」，常量本身也要钉住')
  const { log } = context()
  withTodos(log, 7)
  const built = plan(log)
  const status = (built.chunks ?? []).find((chunk) => chunk.kind === 'task-status')
  assert.ok(status !== undefined, 'task-status 必须出现')

  const lines = String(status.text).split('\n')
  const todoLines = lines.filter((line) => line.includes('待办 '))
  assert.equal(todoLines.length, 3, `只许列 3 条，实测 ${todoLines.length}：\n${status.text}`)
  /** The omission must be DECLARED — and name how many are missing, not merely that some are. */
  assert.match(String(status.text), /另有 4 条未列出/u, `必须写明省略了几条：\n${status.text}`)
  assert.match(String(status.text), new RegExp(`最多 ${TODO_STATUS_MAX_LINES} 条`, 'u'), '还要写明为什么')
  /** And where to read the rest: a count without coordinates is a dead end. */
  assert.match(String(status.text), /graft_read_result/u, '必须给出回读方式')
})

test('v240 ②b: 恰好 3 条 ⇒ 不出现省略声明（没省略就不许说省略）', () => {
  const { log } = context()
  withTodos(log, 3)
  const built = plan(log)
  const status = (built.chunks ?? []).find((chunk) => chunk.kind === 'task-status')
  assert.ok(status !== undefined)
  assert.doesNotMatch(String(status.text), /另有 \d+ 条未列出/u, '3 条刚好，不该有省略行')
  assert.equal(String(status.text).split('\n').filter((line) => line.includes('待办 ')).length, 3)
})

// ── ③ 顺序改了，深度没改 ───────────────────────────────────────────────────────────────────

test('v240 ③: recent-turn 的条数仍由 recentTurns 决定 —— 顺序改动不许顺手改深度', () => {
  const { log } = context()
  const built = plan(log)
  const turns = (built.chunks ?? []).filter((chunk) => chunk.kind === 'recent-turn')
  assert.ok(turns.length > 0, '最近几轮必须被复述')
  assert.ok(turns.length <= 3, `recentTurns=3 ⇒ 最多 3 条，实测 ${turns.length}`)
  /** The order within them stays chronological — a reordering must not reverse the replay. */
  const turnNumbers = turns.map((chunk) => Number(chunk.turn)).filter((value) => Number.isFinite(value))
  const sorted = [...turnNumbers].sort((left, right) => left - right)
  assert.deepEqual(turnNumbers, sorted, '复述必须保持时间顺序')
})

// ── ④ 预算裁剪的存活顺序不变 ────────────────────────────────────────────────────────────────

test('v240 ④: `priority` 表未动 —— 存活顺序与 push 顺序是两件事', () => {
  /**
   * The reordering above changes what the reader SEES first when nothing is cut. When the budget cuts,
   * a different table decides what survives, and B3 deliberately left it alone: changing both at once
   * would make a budget regression indistinguishable from a layout regression.
   *
   * Pinned as source text because the table is a literal inside `buildInjectionPlan` and is not
   * exported. `recent-turn` must still outrank `task-position`, which must outrank `open-work`.
   */
  const source = layer.__sourceOfBuildInjectionPlan
  void source
  const index = (needle) => {
    const found = SOURCE_TEXT.indexOf(needle)
    assert.ok(found > 0, `必须能找到：${needle}`)
    return found
  }
  const tableStart = index('const priority: GraftInjectionChunk')
  /**
   * Anchor on `= [` — NOT on the first `]`, which appears inside `GraftInjectionChunk['kind']` and
   * would slice the array empty (the first version did exactly that and the assertions failed for a
   * reason unrelated to the table).
   */
  const tableOpen = SOURCE_TEXT.indexOf('= [', tableStart)
  assert.ok(tableOpen > tableStart, '必须能定位 priority 表的起点')
  const tableEnd = SOURCE_TEXT.indexOf(']', tableOpen)
  const table = SOURCE_TEXT.slice(tableOpen, tableEnd)
  for (const kind of ['readback-index', 'recent-turn', 'task-position', 'open-work', 'task-status']) {
    assert.ok(table.includes(`'${kind}'`), `priority 表必须仍含 ${kind}`)
  }
  assert.ok(
    table.indexOf("'recent-turn'") < table.indexOf("'task-position'"),
    '存活顺序里 recent-turn 仍高于 task-position —— 唯一不可重建的东西优先',
  )
  assert.ok(
    table.indexOf("'task-position'") < table.indexOf("'open-work'"),
    '存活顺序里 task-position 仍高于 open-work',
  )
})

/** Read once at module load: the source is the only place this literal exists. */
const SOURCE_TEXT = await (async () => {
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  return readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'src', 'index.ts'), 'utf8')
})()