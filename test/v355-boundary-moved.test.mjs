/**
 * ── v355：S5 第三簇 —— `locateBoundary` 搬进 `core/boundary.ts` ────────────────────────────────────
 *
 * 三条判据与 v351 / v353 / v354 同形：位置、无新内容、行为不变（源码模块）。
 *
 * 这一簇是「切片切在哪」的唯一定义，语义要钉住：
 *
 *   1. **只认已闭合的 `turn/end`**。开着的那一轮按策略处理：默认丢弃它、切到上一个闭合处
 *      （调用者通常就是正在跑的那一轮，它不能关自己）；`allowOpenTail: false` 时**拒绝**。
 *   2. **结构畸形是致命的**，不是可裁剪的：`turn/start` 套 `turn/start`、`turn/end` 关错轮次，
 *      都意味着日志本身不自洽——在那里「顺手修一下」等于穿过一个坏区间切片。
 *   3. **一个闭合轮次都没有 ⇒ 抛错**，而不是返回一个「切在 0」的边界。空边界看起来像能切，
 *      切出来的东西是空的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE_REL = 'src/core/boundary.ts'
const MODULE = join(ROOT, 'src', 'core', 'boundary.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')

const { locateBoundary } = await import('../src/core/boundary.ts')

/** The code on a thrown graft error, or a marker that says nothing was thrown. */
const codeOf = (fn) => {
  try {
    fn()
    return '(no throw)'
  } catch (error) {
    return String(error?.code ?? error?.message ?? error)
  }
}

test('v355 ①: the declaration lives in the new module, and index.ts imports + re-exports it', () => {
  assert.ok(moduleText.includes('export function locateBoundary('), '① 新模块必须以 export function 声明它')
  assert.ok(!indexText.includes('function locateBoundary('), '① index.ts 里不得再有声明')
  assert.ok(indexText.includes("import { locateBoundary } from './core/boundary.js'"),
    '① index.ts 必须从新模块导入（容器里有两个调用点）')
  assert.ok(indexText.includes('export { locateBoundary }'), '① 必须裸 re-export，保持导出面')
  assert.ok(!indexText.includes("export { locateBoundary } from"), '① `export … from` 会带着相对路径活到产物里')
})

test('v355 ②: every non-plumbing line in the new module came from the pre-move index.ts', () => {
  const addingCommits = execFileSync(
    'git',
    ['log', '--diff-filter=A', '--format=%H', '--', MODULE_REL],
    { cwd: ROOT, encoding: 'utf8' },
  ).split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const introducing = addingCommits.pop()
  const baselineRev = introducing === undefined ? 'HEAD' : `${introducing}^`
  const before = execFileSync('git', ['show', `${baselineRev}:src/index.ts`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  const beforeCount = new Map()
  for (const line of before.split('\n').map((each) => each.trimEnd())) {
    beforeCount.set(line, (beforeCount.get(line) ?? 0) + 1)
  }

  const appeared = []
  for (const line of moduleText.split('\n').map((each) => each.trimEnd())) {
    if (line.length === 0) continue
    if (line.startsWith('import ') || line.startsWith('export ')) continue
    const available = beforeCount.get(line) ?? 0
    if (available === 0) {
      appeared.push(line)
      continue
    }
    beforeCount.set(line, available - 1)
  }

  assert.deepEqual(appeared, [],
    `② 这些行在新模块里出现，但 ${baselineRev} 的 index.ts 里没有（＝新增内容）：\n  ${appeared.slice(0, 10).join('\n  ')}`)
})

test('v355 ③: closed turns are the boundary; an open tail is dropped by default and refused on demand', () => {
  const closed = [
    { seq: 3, type: 'turn/start', data: { turn: 1 } },
    { seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: 'handoff' } } },
    { seq: 11, type: 'turn/start', data: { turn: 2 } },
    { seq: 17, type: 'turn/end', data: { turn: 2, reason: { kind: 'done' } } },
  ]
  const boundary = locateBoundary(closed)
  assert.equal(boundary.boundarySeq, 17, '③ 边界必须落在最后一个闭合的 turn/end 上')
  assert.equal(boundary.lastTurn, 2, '③ lastTurn 是那个闭合轮次的编号')
  assert.equal(boundary.turnCount, 2, '③ turnCount 数的是开始过的轮次')
  assert.equal(boundary.lastTurnReason, 'done', '③ 结束原因是结构化字段，不是猜的')
  assert.equal(boundary.droppedOpenTurns, undefined, '③ 没有开着的一轮就不该出现这个字段（不是 0）')

  const openTail = [...closed, { seq: 19, type: 'turn/start', data: { turn: 3 } }]
  const dropped = locateBoundary(openTail)
  assert.equal(dropped.boundarySeq, 17, '③ 开着的那一轮必须被丢弃：切到上一个闭合处')
  assert.equal(dropped.droppedOpenTurns, 1, '③ 丢弃必须被记账，而不是静默发生')

  assert.equal(codeOf(() => locateBoundary(openTail, { allowOpenTail: false })), 'OPEN_TURN',
    '③ allowOpenTail:false 时必须拒绝，而不是悄悄丢一轮')

  /** 结构畸形是致命的 —— 日志本身不自洽时，「顺手修」等于穿过坏区间切片。 */
  assert.equal(codeOf(() => locateBoundary([
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'turn/start', data: { turn: 2 } },
  ])), 'OPEN_TURN', '③ 轮次内再开一轮 ⇒ OPEN_TURN')
  assert.equal(codeOf(() => locateBoundary([
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'turn/end', data: { turn: 2 } },
  ])), 'UNBALANCED_TURN', '③ 关掉一个没开的轮次 ⇒ UNBALANCED_TURN')
  assert.equal(codeOf(() => locateBoundary([{ seq: 1, type: 'turn/end', data: { turn: 1 } }])), 'UNBALANCED_TURN',
    '③ 没有 turn/start 的 turn/end ⇒ UNBALANCED_TURN')

  assert.equal(codeOf(() => locateBoundary([])), 'NO_CLOSED_TURN',
    '③ 空日志 ⇒ NO_CLOSED_TURN（不是「切在 0」的空边界）')
  assert.equal(codeOf(() => locateBoundary([{ seq: 1, type: 'turn/start', data: { turn: 1 } }], { allowOpenTail: false })), 'OPEN_TURN',
    '③ 只有一轮且没闭合：拒绝（上面那条 allowOpenTail 的默认值是 true，这里显式关掉）')
})