/**
 * ── v234 (B2-T4): `b2-trigger` 第 1 条 —— 任务图未建立时，交接要说出来 ─────────────────────────────
 *
 * 用户裁定（`b2-trigger` 节点第 1 条）：
 *   graft prepare：目标会话无任务图 ⇒ 交接写「[任务图：尚未建立]」+ 一行提示。
 *
 * ── 这条与 T3 已定的纪律冲突，冲突的解法是本文件的全部内容 ────────────────────────────────────
 *
 * T3 的 `readTaskPosition` 第 3 条规则说：**「没有图」与「图读不懂」都要产出 no chunk**，因为一个
 * 从未用过记忆插件的工作区不该被提醒。这一条是对的，但它把**两种不同的「没有图」**合并了：
 *
 *   目录不存在        ⇒ 插件没装。说「请建图」等于让模型去调一个**不存在**的工具。
 *   目录存在、图不存在 ⇒ 插件**跑过**（它激活时就写 `.layout.json` 与几条账本），却没有图。
 *                        这是一条关于**计划**的事实，而且**可行动**：现在就能建。
 *
 * 所以划线不按「图在不在」，按「插件在不在」。
 *
 * ── 三件必须同时成立的事 ─────────────────────────────────────────────────────────────────────
 *
 *   ① 目录存在 + 无图 ⇒ 一格提示（本文件 ①②）
 *   ② 目录不存在      ⇒ 仍然无 chunk（③，即 `v233 ⑮` 的语义**一个字不能变**）
 *   ③ 图在但读不出位置 ⇒ 仍然无 chunk（④⑤⑥，T3 的三条规则原样保留）
 *
 * ② 与 ③ 一起才证明这次改动是**加了一条分支**，而不是把 T3 的规则改松了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

const layer = await import(new URL('../index.js', import.meta.url).href)

const LAYOUT = {
  layout: 1,
  producer: 'dsh-memory',
  files: ['negatives.jsonl', 'facts.jsonl', 'experiences.jsonl', 'suggestions.jsonl', 'task-graph.json'],
}

function makeGraph() {
  return {
    version: 1,
    id: 'test-graph',
    goal: '把持久层做到生产就绪',
    goalLockedAt: '2026-11-18T00:00:00.000Z',
    nodes: [
      { id: 'start', title: '开始', nodeType: '', requirements: [], status: 'done', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
      { id: 'goal', title: '目标', nodeType: '', requirements: [], status: 'pending', dependsOn: [], knowledgePointers: [], fixed: true, harvestedAt: '', createdAt: '', updatedAt: '' },
      { id: 'phase-a', title: '阶段 A', nodeType: 'analysis', requirements: ['看清单'], status: 'active', dependsOn: ['goal'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '', progress: 40 },
      { id: 'phase-b', title: '阶段 B', nodeType: 'coding', requirements: ['写代码'], status: 'pending', dependsOn: ['phase-a'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
      { id: 'phase-c', title: '阶段 C', nodeType: 'testing', requirements: ['验收'], status: 'pending', dependsOn: ['phase-b'], knowledgePointers: [], harvestedAt: '', createdAt: '', updatedAt: '' },
    ],
    history: [],
    createdAt: '',
    updatedAt: '',
    persistentConstraints: [],
  }
}

/**
 * `mode` 是本文件的核心参数 —— 它让「目录在不在」与「图在不在」成为两个独立的开关：
 *
 *   'no-dir'           目录根本不存在（插件没装）
 *   'dir-no-graph'     目录在、`.layout.json` 在、图不在（插件装了但没建图）
 *   'dir-graph'        目录在、图在
 *   'dir-bad-graph'    目录在、图是半截 JSON
 *   'dir-empty-graph'  目录在、图在但没有当前节点（全 done）
 */
function env(mode, { graphOverride } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v234-'))
  const memoryDir = join(root, 'memory')
  if (mode !== 'no-dir') {
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, '.layout.json'), JSON.stringify(LAYOUT, null, 2), 'utf8')
  }
  if (mode === 'dir-graph') {
    writeFileSync(join(memoryDir, 'task-graph.json'), JSON.stringify(graphOverride ?? makeGraph(), null, 2), 'utf8')
  }
  if (mode === 'dir-bad-graph') {
    writeFileSync(join(memoryDir, 'task-graph.json'), '{"version":1,"nodes":[{"id":"phase-a","sta', 'utf8')
  }
  if (mode === 'dir-empty-graph') {
    const done = makeGraph()
    for (const node of done.nodes) {
      if (node.id === 'start' || node.id === 'goal') continue
      node.status = 'done'
    }
    writeFileSync(join(memoryDir, 'task-graph.json'), JSON.stringify(done, null, 2), 'utf8')
  }

  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: root } })
  apply(ctx, { dataDir: root, memoryDir })
  return { root, memoryDir, log, ctx, persistence }
}

const positionsOf = (entry) => (entry.chunks ?? []).filter((chunk) => chunk.kind === 'task-position')

async function review(envelope) {
  const prepared = await envelope.ctx._tools.get('graft_prepare').execute({ sourceSessionId: envelope.log.session.id }, {})
  return { prepared, positions: positionsOf(prepared) }
}

// ── ① 目录在、图不存在 ⇒ 一格提示 ─────────────────────────────────────────────────────────────

test('v234 ①: memoryDir 存在但 task-graph.json 不存在 ⇒ 产出 task-position 一格，点名 memory_graph_update', async () => {
  const e = env('dir-no-graph')
  try {
    const { prepared, positions } = await review(e)
    assert.equal(positions.length, 1, '必须恰好一格 —— 多了就是在同一个问题上反复说')
    const text = String(positions[0].text)
    assert.match(text, /\[TASK POSITION\]/u)
    /** 「尚未建立」是这条的全部信息量：它说的不是「我看不到」，是「它还没被建」。 */
    assert.match(text, /尚未建立/u)
    /** 可行动：必须点名工具与 op，否则读者还得自己去查怎么建。 */
    assert.match(text, /memory_graph_update/u, '必须点名工具 —— 否则这条提示不可行动')
    assert.match(text, /bootstrap/u, '必须点名 op:bootstrap（从零建整张计划的那条路）')
    /** It is a PLAN fact, not a defect: no warning, and the slice must be unaffected. */
    assert.equal((e.ctx._logged.warn ?? []).filter((line) => line.includes('task-position')).length, 0)
    assert.equal(prepared.digest.length, 64, '切片照常完成')
  } finally {
    resetRetiredSessions()
  }
})

// ── ② 一格 ≤ 200 字符 ────────────────────────────────────────────────────────────────────────

test('v234 ②: 那一格 ≤ 200 字符（一格，不是一段）', async () => {
  const e = env('dir-no-graph')
  try {
    const { positions } = await review(e)
    const text = String(positions[0].text)
    assert.ok(text.length <= 200, `必须 ≤ 200 字符，实测 ${text.length}：\n${text}`)
    /** And it must still say the two actionable things at that size. */
    assert.match(text, /memory_graph_update/u)
  } finally {
    resetRetiredSessions()
  }
})

// ── ③ 目录不存在 ⇒ 无 chunk（v233 ⑮ 语义不变） ──────────────────────────────────────────────

test('v234 ③: memoryDir 不存在 ⇒ 无 chunk —— 插件没装时提示没有意义（v233 ⑮ 语义不变）', async () => {
  const e = env('no-dir')
  try {
    const { prepared, positions } = await review(e)
    assert.equal(positions.length, 0, '插件没装时说「请建图」= 让模型去调一个不存在的工具')
    assert.equal(prepared.digest.length, 64)
    /**
     * AND NO WARNING EITHER. A workspace that never used the plugin is the normal case; warning about
     * it would train the reader to ignore the warning that matters.
     */
    assert.equal((e.ctx._logged.warn ?? []).filter((line) => line.includes('task-position')).length, 0)
  } finally {
    resetRetiredSessions()
  }
})

// ── ④ 图在且有当前节点 ⇒ 仍是六段 ───────────────────────────────────────────────────────────

test('v234 ④: 图在且有当前节点 ⇒ 仍是六段（T3 行为不变，不是被这次改掉了）', async () => {
  const e = env('dir-graph')
  try {
    const { positions } = await review(e)
    assert.equal(positions.length, 1)
    const text = String(positions[0].text)
    assert.match(text, /当前节点：phase-a（active）阶段 A/u)
    assert.match(text, /全局目标：把持久层做到生产就绪（已锁定）/u)
    assert.match(text, /我解锁谁：phase-b/u)
    /** The notEstablished sentence must NOT appear when a plan exists. */
    assert.doesNotMatch(text, /尚未建立/u)
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑤ 图在但无当前节点 ⇒ 无 chunk ──────────────────────────────────────────────────────────

test('v234 ⑤: 图在但没有当前节点（全 done）⇒ 无 chunk（T3 规则 1 不变）', async () => {
  const e = env('dir-empty-graph')
  try {
    const { positions } = await review(e)
    assert.equal(positions.length, 0, '做完了就是做完了，不许退化成「尚未建立」')
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑥ 图损坏 ⇒ 无 chunk + warning ──────────────────────────────────────────────────────────

test('v234 ⑥: 图损坏 ⇒ 无 chunk + warning（T3 规则 3 不变）', async () => {
  const e = env('dir-bad-graph')
  try {
    const { positions } = await review(e)
    assert.equal(positions.length, 0, '读不懂的图不许被渲染成任何东西 —— 尤其不许被说成「尚未建立」')
    const warnings = (e.ctx._logged.warn ?? []).filter((line) => line.includes('task-position'))
    assert.ok(warnings.length > 0, '「文件在但读不懂」必须留下可查的 warning')
    /** The distinction matters: a corrupt graph is NOT the same fact as an absent one. */
    assert.doesNotMatch(warnings[0], /尚未建立/u)
  } finally {
    resetRetiredSessions()
  }
})

// ── ⑦ 端到端：三处拿到的 chunk 逐字相同 ─────────────────────────────────────────────────────

test('v234 ⑦: 目录在、无图时，prepare / commit / 写盘 三处拿到的 chunk 逐字相同', async () => {
  const e = env('dir-no-graph')
  try {
    const { prepared, positions } = await review(e)
    assert.equal(positions.length, 1, '前提：批准的那份要含这一格')
    const reviewed = String(positions[0].text)

    /**
     * ㉙(c)：只测一处会漏掉另外两处。这条走完整链路 —— prepare 给用户看，commit 重建用来比对，
     * 写盘真正落进目标会话。三处同一个 `readTaskPosition`、同一份渲染。
     */
    const report = await e.ctx._tools.get('graft_commit').execute(
      { preparedId: prepared.preparedId, digest: prepared.digest },
      {},
    )
    assert.equal(report.ok, true, '图不存在不该让 commit 失败')
    const record = e.persistence.byId.get(report.newSessionId)
    const events = Array.isArray(record?.events) ? record.events : []
    const bodies = events.flatMap((event) => {
      const content = event?.data?.message?.content
      return Array.isArray(content) ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')) : []
    })
    const written = bodies.find((body) => body.includes('[TASK POSITION]'))
    assert.ok(written !== undefined, '写盘路径必须也读到这一格 —— 第三扇门没开就是这里红')
    assert.equal(written, reviewed, '写进去的必须与批准的逐字相同')
    assert.match(written, /尚未建立/u)
  } finally {
    resetRetiredSessions()
  }
})