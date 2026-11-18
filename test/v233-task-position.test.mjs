/**
 * ── v233 (B2-T3): `task-position` — WHERE THE PLAN SAYS THIS SESSION IS ──────────────────────────
 *
 * 用户裁定（Q2）：「切片交接信息要增加『查看当前节点进度』，让模型知道全局任务情况」。
 *
 * ── 为什么这不是第四个「描述过去」的 chunk ─────────────────────────────────────────────────────
 *
 * 已有三个 chunk 都在回答「发生了什么」：`phase-roadmap` 从会话日志推断阶段，`task-status` 重放
 * 最后一次 `todo_write`，pending-state 携带未完成的指令。它们都不能回答「我站在已批准计划的哪个
 * 节点上」，因为那个事实根本不在会话日志里 —— 它在任务图里，而任务是唯一跨代存在的物件。
 *
 * 权威顺序：**图 > roadmap > todo**。
 *
 * ── 本文件守的三条线 ───────────────────────────────────────────────────────────────────────────
 *
 *   ① 不许编。没有当前节点就整块不输出，绝不渲染「当前节点：（无）」那种看起来有信息的空壳。
 *   ② 三个门都要开。prepare / commit 重建 / 真正写盘。少开一个，要么每次 commit 失败，
 *      要么「批准的和写进去的不一样」——后者是 v7.4b 已经为 tail chunk 修过一次的病。
 *   ③ 读图不许失败切片。图是增强，切片是主功能。
 *
 * ── 全部走真实链路 ─────────────────────────────────────────────────────────────────────────────
 *
 * ㉙(c)：只调 `toTaskPosition` 的测试会绕过工具层与三个调用点，永远抓不到 ②。所以凡涉及
 * 「块出不出现」「写没写进去」的断言，都从 `graft_prepare` / `graft_commit` 走。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

const layer = await import(new URL('../index.js', import.meta.url).href)

/** The graph `dsh-memory` writes. Mirrored here as a literal — cross-repo, no shared type. */
function makeGraph(overrides = {}) {
  const nodes = overrides.nodes ?? [
    { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'goal', title: '目标', nodeType: '', requirements: [], status: 'active', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-a', title: '阶段 A', nodeType: 'analysis', requirements: ['看清单'], status: 'done', dependsOn: ['goal'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-b', title: '阶段 B', nodeType: 'coding', requirements: ['写代码', '跑测试'], status: 'active', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '', progress: 40 },
    { id: 'phase-c', title: '阶段 C', nodeType: 'testing', requirements: ['验收'], status: 'pending', dependsOn: ['phase-b'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
  ]
  return {
    version: 1,
    id: 'test-graph',
    goal: overrides.goal ?? '把持久层做到生产就绪',
    goalLockedAt: overrides.goalLockedAt ?? '2026-11-18T00:00:00.000Z',
    nodes,
    history: [],
    createdAt: '',
    updatedAt: '',
    persistentConstraints: [],
  }
}

const LAYOUT = {
  layout: 1,
  producer: 'dsh-memory',
  files: ['negatives.jsonl', 'facts.jsonl', 'experiences.jsonl', 'suggestions.jsonl', 'task-graph.json'],
}

/** A real store on disk plus a real plugin context: nothing about the read path is stubbed. */
function env({ graph = makeGraph(), omitGraph = false, layout = LAYOUT, graphBody } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v233-'))
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  if (layout !== undefined) writeFileSync(join(memoryDir, '.layout.json'), JSON.stringify(layout, null, 2), 'utf8')
  if (!omitGraph) {
    writeFileSync(join(memoryDir, 'task-graph.json'), graphBody ?? JSON.stringify(graph, null, 2), 'utf8')
  }
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: root } })
  apply(ctx, { dataDir: root, memoryDir })
  return { root, memoryDir, log, ctx, persistence }
}

/** Every chunk of a kind, in order — `recent-turn` repeats, so a Map would hide duplicates. */
const chunksOf = (entry, kind) => (entry.chunks ?? []).filter((chunk) => chunk.kind === kind)

/** The text of the ONE task-position chunk a review carries. */
async function reviewedPosition(envRef) {
  const prepared = await envRef.ctx._tools.get('graft_prepare').execute({ sourceSessionId: envRef.log.session.id }, {})
  const chunk = chunksOf(prepared, 'task-position')[0]
  return { prepared, chunk, text: chunk === undefined ? undefined : String(chunk.text) }
}

// ── ① 六段齐全，且顺序被钉住 ──────────────────────────────────────────────────────────────────

test('v233 ①: 六段齐全，且顺序本身被钉住（不是「都在」）', async () => {
  const e = env()
  try {
    const { text } = await reviewedPosition(e)
    assert.ok(text !== undefined, '六段必须存在')
    /**
     * ORDER IS THE ARGUMENT: the goal orients, the current node locates, and the edges explain why
     * the next step is not available. A reader who stops after two lines still knows what they are
     * doing — but only if those two lines come first.
     */
    const sections = ['[TASK POSITION]', '全局目标', '当前节点', '已完成', '未开始', '我解锁谁']
    const positions = sections.map((label) => text.indexOf(label))
    for (const [index, position] of positions.entries()) {
      assert.ok(position >= 0, `缺少「${sections[index]}」这一行`)
    }
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(positions[i - 1] < positions[i], `「${sections[i - 1]}」必须排在「${sections[i]}」之前`)
    }
  } finally {
    resetRetiredSessions()
  }
})

// ── ② 唯一的 active 被选中 ───────────────────────────────────────────────────────────────────

test('v233 ②: 唯一的 active 节点 ⇒ 选中它', async () => {
  const e = env()
  try {
    const { text } = await reviewedPosition(e)
    assert.match(text, /当前节点：phase-b（active）阶段 B/u)
  } finally {
    resetRetiredSessions()
  }
})

// ── ③ 无 active ⇒ 选「pending 且依赖全 done」中 id 最小的 ────────────────────────────────────

test('v233 ③: 无 active ⇒ 选中「pending 且依赖全 done」里 id 最小的', async () => {
  const nodes = [
    { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'goal', title: '目标', nodeType: '', requirements: [], status: 'active', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-a', title: '阶段 A', nodeType: '', requirements: [], status: 'done', dependsOn: ['goal'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    /** Two runnable candidates, declared out of order: the SMALLEST id must win, not the first listed. */
    { id: 'phase-z', title: 'Z（先声明）', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-b', title: 'B（后声明）', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-c', title: 'C（被阻塞）', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-z'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
  ]
  const e = env({ graph: makeGraph({ nodes }) })
  try {
    const { text } = await reviewedPosition(e)
    assert.match(text, /当前节点：phase-b（pending）/u, '必须取 id 最小的可做节点，不是数组里第一个')
    assert.doesNotMatch(text, /当前节点：phase-z/u)
    assert.doesNotMatch(text, /当前节点：phase-c/u, '被阻塞的节点不是可做的下一步')
  } finally {
    resetRetiredSessions()
  }
})

// ── ④ 多个 active ⇒ 取依赖全满足且 id 最小，并带警告 ─────────────────────────────────────────

test('v233 ④: 多个 active ⇒ 取可做的且 id 最小，并明说「多个 active」', async () => {
  const nodes = [
    { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'goal', title: '目标', nodeType: '', requirements: [], status: 'active', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-a', title: '阶段 A', nodeType: '', requirements: [], status: 'done', dependsOn: ['goal'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-b', title: 'B', nodeType: '', requirements: [], status: 'active', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-d', title: 'D', nodeType: '', requirements: [], status: 'active', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-c', title: 'C', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-b'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
  ]
  const e = env({ graph: makeGraph({ nodes }) })
  try {
    const { text } = await reviewedPosition(e)
    assert.match(text, /当前节点：phase-b/u, '两个都可做 ⇒ 取 id 最小的那个')
    /**
     * A graph with two active nodes contradicts itself. Picking one silently would hide that from the
     * only reader who can fix it, so the block says so.
     */
    assert.match(text, /⚠ 多个节点同时 active/u)
    assert.match(text, /phase-b, phase-d/u, '警告里要点名全部 active 节点')
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑤ blockedBy / unlocks 从反向边算 ─────────────────────────────────────────────────────────

test('v233 ⑤: blockedBy 与 unlocks 都正确 —— 反向边是从别人的 dependsOn 算出来的', async () => {
  const nodes = [
    { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'goal', title: '目标', nodeType: '', requirements: [], status: 'active', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    /**
     * `phase-a` depends on `goal` (structural, never counted as a blocker) AND on `phase-x`, which is
     * still pending — so it has a real blocked-by edge. Its `id` is smallest among the runnable
     * candidates ONLY IF its own dependencies are... not satisfied. That is the point: this fixture
     * gives `phase-x` the runnable slot, and `phase-a` inherits `phase-x` as its blocker.
     */
    { id: 'phase-a', title: 'A', nodeType: '', requirements: [], status: 'pending', dependsOn: ['goal', 'phase-x'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-x', title: 'X', nodeType: '', requirements: [], status: 'pending', dependsOn: ['goal'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-y', title: 'Y', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-x'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-z', title: 'Z', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-x'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
  ]
  const e = env({ graph: makeGraph({ nodes }) })
  try {
    /**
     * The graph stores `dependsOn` only — `unlocks` is COMPUTED. A graph that stored both directions
     * could contradict itself (A says it unlocks B, B says it does not depend on A), so only one
     * direction is authoritative.
     *
     * `phase-a` is the smallest id but is BLOCKED by `phase-x`, so the current node is `phase-x`;
     * `phase-y` and `phase-z` are pending and name `phase-x`, so they are what it unlocks.
     */
    const position = layer.toTaskPosition(makeGraph({ nodes }))
    assert.equal(position.current.id, 'phase-x', 'phase-a 被 phase-x 阻塞 ⇒ 可做的是 phase-x')
    assert.deepEqual(position.blockedBy, [], 'phase-x 只依赖 goal —— 而 goal 是终点不是前置，不算阻塞')
    /**
     * `phase-a` counts too: it is pending and names `phase-x`. Both directions of the same edge come
     * from one authoritative field (`dependsOn`), so a node that blocks me is also a node I unlock.
     */
    assert.deepEqual(position.unlocks, ['phase-a', 'phase-y', 'phase-z'], '谁等我：从别人的 dependsOn 反查')
    const { text } = await reviewedPosition(e)
    assert.match(text, /我解锁谁：phase-a, phase-y, phase-z/u)
    /** And the blocked one still appears as `pending`, with its blocker named from ITS point of view. */
    const blockedView = layer.toTaskPosition(
      makeGraph({
        nodes: nodes.map((node) => (node.id === 'phase-x' ? { ...node, status: 'done' } : node)),
      }),
    )
    assert.equal(blockedView.current.id, 'phase-a', 'phase-x 完成后，phase-a 成为可做节点')
    assert.deepEqual(blockedView.blockedBy, [], '它唯一的等待已经完成')
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑤b `goal` 是终点不是前置：它不许把整张图判成「没有当前节点」 ─────────────────────────────

test('v233 ⑤b: goal 节点永远 pending ⇒ 不许因此判成「没有当前节点」（实测踩到的坑）', async () => {
  /**
   * ── THE SHAPE THAT BROKE THE FIRST IMPLEMENTATION ────────────────────────────────────────────
   *
   * Measured against `dsh-memory/src/graph.ts`: `lock-goal` creates the goal node with
   * `status: 'pending'`, and NOTHING ever completes it — the goal is the destination. The most
   * ordinary plan there is hangs its first phase off the objective:
   *
   *     phase-a.dependsOn = ['goal']
   *
   * The first version of `toTaskPosition` compared against EVERY dependency. So `phase-a` was never
   * "all dependencies done", no node was runnable, and the whole block vanished — for a graph that is
   * not merely valid but typical. A silence that reads exactly like "the plan is finished".
   *
   * This test is that graph, reduced to nothing else.
   */
  const nodes = [
    { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    /** `pending`, as memory actually creates it — the whole point of the fixture. */
    { id: 'goal', title: '最终目标', nodeType: '', requirements: ['做到生产就绪'], status: 'pending', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-a', title: 'A', nodeType: '', requirements: [], status: 'pending', dependsOn: ['goal'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-b', title: 'B', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-c', title: 'C', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-b'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
  ]
  const e = env({ graph: makeGraph({ nodes }) })
  try {
    const position = layer.toTaskPosition(makeGraph({ nodes }))
    assert.ok(position !== undefined, 'goal 永不为 done，但它不是前置 —— 图必须仍有当前节点')
    assert.equal(position.current.id, 'phase-a')
    /** `goal` must not be reported as a blocker: saying so of every node says nothing. */
    assert.deepEqual(position.blockedBy, [], 'goal 不许出现在「我被谁阻塞」里')
    assert.equal(position.goalLocked, true)

    const { text } = await reviewedPosition(e)
    assert.ok(text !== undefined, '这一块必须出现 —— 它是「最普通的一张图」')
    assert.match(text, /当前节点：phase-a（pending）A/u)
    assert.doesNotMatch(text, /我被谁阻塞：goal/u, 'goal 是终点，不是等待中的前置')
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑥ 无当前节点 ⇒ 整块不出现（两种输入各测一次） ────────────────────────────────────────────

test('v233 ⑥a: 全 done 的图 ⇒ 整块不出现（不是空标题）', async () => {
  const nodes = [
    { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'goal', title: '目标', nodeType: '', requirements: [], status: 'active', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-a', title: 'A', nodeType: '', requirements: [], status: 'done', dependsOn: ['goal'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-b', title: 'B', nodeType: '', requirements: [], status: 'done', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
  ]
  const e = env({ graph: makeGraph({ nodes }) })
  try {
    assert.equal(layer.toTaskPosition(makeGraph({ nodes })), undefined, '做完了就没有「当前节点」')
    const { prepared } = await reviewedPosition(e)
    assert.equal(chunksOf(prepared, 'task-position').length, 0, '没有当前节点 ⇒ 一个 chunk 都不许产出')
    /** The slice itself must be unaffected: the graph's opinion is an enhancement. */
    assert.ok((prepared.chunks ?? []).length > 0, '切片照常产出其他块')
  } finally {
    resetRetiredSessions()
  }
})

test('v233 ⑥b: 所有 pending 都被阻塞的图 ⇒ 整块不出现', async () => {
  const nodes = [
    { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'goal', title: '目标', nodeType: '', requirements: [], status: 'active', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    /** A cycle between two pending nodes: each waits for the other, so neither is runnable. */
    { id: 'phase-a', title: 'A', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-b'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-b', title: 'B', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
  ]
  const e = env({ graph: makeGraph({ nodes }) })
  try {
    assert.equal(layer.toTaskPosition(makeGraph({ nodes })), undefined)
    const { prepared } = await reviewedPosition(e)
    assert.equal(chunksOf(prepared, 'task-position').length, 0)
    /** And it must not be replaced by a happy-looking empty shell. */
    assert.doesNotMatch(JSON.stringify(prepared.chunks ?? []), /当前节点/u, '不许出现「当前节点：（无）」这种空壳')
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑦ goalLocked 标「已锁定」/ 不标 ──────────────────────────────────────────────────────────

test('v233 ⑦: goalLockedAt 非空 ⇒ 标「已锁定」；空 ⇒ 不标（不撒谎）', async () => {
  const locked = env({ graph: makeGraph({ goalLockedAt: '2026-11-18T00:00:00.000Z' }) })
  try {
    const { text } = await reviewedPosition(locked)
    assert.match(text, /全局目标：把持久层做到生产就绪（已锁定）/u)
  } finally {
    resetRetiredSessions()
  }
  const unlocked = env({ graph: makeGraph({ goalLockedAt: '' }) })
  try {
    const { text } = await reviewedPosition(unlocked)
    assert.match(text, /全局目标：把持久层做到生产就绪$/mu, '未锁定就不许出现「已锁定」')
    assert.doesNotMatch(text, /已锁定/u)
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑧ progress 缺失 ⇒ 不写「进度：」这一行 ───────────────────────────────────────────────────

test('v233 ⑧: progress 缺失 ⇒ 不出现「进度：」这一行（不写 0%）', async () => {
  const nodes = [
    { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'goal', title: '目标', nodeType: '', requirements: [], status: 'active', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    /** No `progress` field at all — the common case, because measuring progress is opt-in. */
    { id: 'phase-a', title: 'A', nodeType: '', requirements: [], status: 'active', dependsOn: ['goal'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-b', title: 'B', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'phase-c', title: 'C', nodeType: '', requirements: [], status: 'pending', dependsOn: ['phase-b'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
  ]
  const e = env({ graph: makeGraph({ nodes }) })
  try {
    const { text } = await reviewedPosition(e)
    assert.doesNotMatch(text, /进度：/u, '没测量过就不许写进度 —— 0% 是一个测量结果，不是「不知道」')
    assert.doesNotMatch(text, /0%/u)
    assert.match(text, /当前节点：phase-a/u, '其他行照常')
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑨ 字符上限 ───────────────────────────────────────────────────────────────────────────────

test('v233 ⑨: 30 个节点 ⇒ 总字符 ≤ 1200，且确实做了截断', async () => {
  const nodes = [
    { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
    { id: 'goal', title: '目标', nodeType: '', requirements: [], status: 'active', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
  ]
  for (let i = 0; i < 30; i += 1) {
    const id = `phase-${String(i).padStart(2, '0')}`
    nodes.push({
      id,
      title: `阶段 ${i}`,
      nodeType: '',
      /** Long requirements too: the cap must hold even when every field is at its own maximum. */
      requirements: [`要求一 ${i}`, `要求二 ${i}`, `要求三 ${i}`, `要求四 ${i}`],
      status: i === 0 ? 'active' : 'pending',
      dependsOn: i === 0 ? ['goal'] : [`phase-${String(i - 1).padStart(2, '0')}`],
      knowledgePointers: [],
      harvestedAt: '',
      createdAt: '',
      updatedAt: '',
      progress: i === 0 ? 50 : undefined,
    })
  }
  const e = env({ graph: makeGraph({ nodes }) })
  try {
    const position = layer.toTaskPosition(makeGraph({ nodes }))
    const text = layer.renderTaskPosition(position)
    assert.ok(text.length <= layer.TASK_POSITION_MAX_CHARS, `必须 ≤ ${layer.TASK_POSITION_MAX_CHARS}，实测 ${text.length}`)
    /** Truncation must be VISIBLE, and the id lists are the first thing to give way. */
    assert.match(text, /…共 \d+ 个/u, '节点列表被截断时必须说「…共 N 个」')
    /** The current node survives: it is the one line a reader came for. */
    assert.match(text, /当前节点：phase-00/u)
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑩ layout 版本不匹配 ⇒ 降级为无 chunk + warning，切片照常成功 ─────────────────────────────

test('v233 ⑩: .layout.json 版本不匹配 ⇒ 无 chunk + warning，但切片照常成功', async () => {
  const e = env({ layout: { layout: 7, producer: 'dsh-memory', files: [] } })
  try {
    const { prepared } = await reviewedPosition(e)
    assert.equal(chunksOf(prepared, 'task-position').length, 0, '读不懂的布局不许猜')
    assert.ok(prepared.digest.length === 64, '切片本身必须照常完成 —— 图是增强')
    const warnings = e.ctx._logged.warn
    assert.ok(
      warnings.some((line) => String(line).includes('task-position')),
      `必须留下一条可查的 warning（实测：${JSON.stringify(warnings).slice(0, 300)}）`,
    )
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑪ 端到端：批准时的 chunks === 写盘时的 chunks ────────────────────────────────────────────

test('v233 ⑪: 写盘的那段 task-position 与批准的逐字相同（批准 ≠ 写盘 是 v7.4b 的病）', async () => {
  const e = env()
  try {
    const { prepared, text } = await reviewedPosition(e)
    assert.ok(text !== undefined, '前提：批准的那份要含 task-position')
    const report = await e.ctx._tools.get('graft_commit').execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {})
    const record = e.persistence.byId.get(report.newSessionId)
    const events = Array.isArray(record?.events) ? record.events : []
    const bodies = events.flatMap((event) => {
      const content = event?.data?.message?.content
      return Array.isArray(content) ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')) : []
    })
    const written = bodies.find((body) => body.includes('[TASK POSITION]'))
    assert.ok(written !== undefined, '写进目标会话的 tape 必须含 TASK POSITION —— 第三个门没开就是这里红')
    assert.equal(written, text, '写盘的那段必须与批准的逐字相同')
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑫ prepare→commit 全链路不因 task-position 报 SLICE_DIGEST_MISMATCH ──────────────────────

test('v233 ⑫: 图不变时 prepare→commit 全链路成功（不报 SLICE_DIGEST_MISMATCH）', async () => {
  const e = env()
  try {
    const { prepared } = await reviewedPosition(e)
    const report = await e.ctx._tools.get('graft_commit').execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {})
    assert.equal(report.ok, true, '图没变，commit 必须成功')
    /**
     * And the complement, which is the whole reason `task-position` is NOT in `tailKinds`: once the
     * graph moves, the reviewed tape genuinely describes a position the store no longer holds.
     */
    const graphPath = join(e.memoryDir, 'task-graph.json')
    const moved = makeGraph()
    moved.nodes.find((node) => node.id === 'phase-b').progress = 99
    writeFileSync(graphPath, JSON.stringify(moved, null, 2), 'utf8')

    const e2 = env()
    const second = await reviewedPosition(e2)
    const moved2 = makeGraph()
    moved2.nodes.find((node) => node.id === 'phase-b').progress = 99
    writeFileSync(join(e2.memoryDir, 'task-graph.json'), JSON.stringify(moved2, null, 2), 'utf8')
    await assert.rejects(
      () => e2.ctx._tools.get('graft_commit').execute({ preparedId: second.prepared.preparedId, digest: second.prepared.digest }, {}),
      (error) => {
        assert.equal(error.code, 'SLICE_DIGEST_MISMATCH')
        assert.match(String(error.message), /task-position/u, '必须点名是哪个块变了')
        return true
      },
      '审核期间计划变了 ⇒ 必须重新 prepare，不许静默刷新',
    )
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑬ layout 契约：两侧名单逐字相等 ─────────────────────────────────────────────────────────

test('v233 ⑬: layout 契约 —— 本仓的 MEMORY_LAYOUT_FILES 含 task-graph.json（两侧各跑一次）', () => {
  /**
   * This side's half of the contract. `dsh-memory/test/v102-layout-contract.test.mjs` carries the
   * mirror assertion; the two hard-coded lists must stay equal, and neither imports the other.
   */
  assert.deepEqual([...layer.MEMORY_LAYOUT_FILES], [
    'negatives.jsonl',
    'facts.jsonl',
    'experiences.jsonl',
    'suggestions.jsonl',
    'task-graph.json',
  ])
  /**
   * 版本号不动（仍是 1）：读者只断言 `layout === 1`，`files` 数组是**声明**不是白名单。
   * 新增一个文件名不会让旧读者拒绝（它本来就不读那个文件）。这条正是下面这三个断言的用途。
   */
  assert.equal(layer.MEMORY_LAYOUT_VERSION, 1)
  assert.ok(layer.MEMORY_LAYOUT_FILES.includes('task-graph.json'))
})

test('v233 ⑬b: 旧 manifest（不含 task-graph.json）仍被接受 —— 新增文件名不算版本变更', async () => {
  /** A store written by the PREVIOUS release declares the four .jsonl files and no graph. */
  const oldLayout = { layout: 1, producer: 'dsh-memory', files: ['negatives.jsonl', 'facts.jsonl', 'experiences.jsonl', 'suggestions.jsonl'] }
  const e = env({ layout: oldLayout })
  try {
    const { text } = await reviewedPosition(e)
    assert.ok(text !== undefined, '旧 manifest 下依然要能读到图：files 是声明，不是白名单')
    assert.match(text, /当前节点：phase-b/u)
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑭ 图文件损坏 ⇒ 不抛、无 chunk、切片成功 ────────────────────────────────────────────────

test('v233 ⑭: 图文件损坏（半截 JSON）⇒ 不抛、无 chunk、切片成功 + 可查 warning', async () => {
  const e = env({ graphBody: '{"version":1,"nodes":[{"id":"phase-a","sta' })
  try {
    const { prepared } = await reviewedPosition(e)
    assert.equal(chunksOf(prepared, 'task-position').length, 0)
    assert.equal(prepared.digest.length, 64, '切片照常成功')
    const warnings = e.ctx._logged.warn
    assert.ok(
      warnings.some((line) => String(line).includes('task-position')),
      '「文件在但读不懂」与「没有文件」必须能区分 —— 只有前者该报警',
    )
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑮ memoryDir 不存在 ⇒ 不抛、无 chunk、切片成功 ───────────────────────────────────────────

test('v233 ⑮: memoryDir 不存在 ⇒ 不抛、无 chunk、切片成功，且不产生噪声 warning', async () => {
  resetRetiredSessions()
  const root = mkdtempSync(join(tmpdir(), 'dsh-v233-missing-'))
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: root } })
  /** Point at a directory that was never created. */
  apply(ctx, { dataDir: root, memoryDir: join(root, 'never-existed', 'memory') })
  try {
    const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})
    assert.equal(chunksOf(prepared, 'task-position').length, 0)
    assert.equal(prepared.digest.length, 64)
    /**
     * A workspace that never used the graph is the NORMAL case. Warning about it would train the
     * reader to ignore the warning that matters.
     */
    const warnings = ctx._logged.warn.filter((line) => String(line).includes('task-position'))
    assert.equal(warnings.length, 0, `没有图不是缺陷，不许报警（实测：${JSON.stringify(warnings)}）`)
  } finally {
    resetRetiredSessions()
  }
})