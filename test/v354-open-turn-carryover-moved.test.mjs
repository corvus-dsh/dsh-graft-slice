/**
 * ── v354：S5 第二簇 —— `extractOpenTurnCarryover`（+ 两个类型）搬进 `core/open-turn-carryover.ts` ────
 *
 * 三条判据与 v351 / v353 同形：位置、无新内容、行为不变。**行为用源码模块测**（`test/source-module.mjs`）。
 *
 * 这一簇的语义值得单独钉住，因为它是「交接时该告诉目标什么」的唯一定义：
 *
 *   1. **只有拿到结果的调用才算工作**。一个没有结果的调用不是工作，把它写进 carryover 会让目标去等
 *      一件永远不会到的事（源那一轮已被放弃，不可续）。实测：未完成的调用必须不出现。
 *   2. **只有人写的消息算用户的话**。`source.kind !== 'user'` 的消息（插件自己写的卡片、转述）不得进入
 *      `userTexts` —— 否则目标会把插件的话当成人给的约束。
 *   3. **什么都没有 ⇒ `undefined`**，不是一份空壳。空壳会让看板显示「有一轮开着」，而实际没有。
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
const MODULE_REL = 'src/core/open-turn-carryover.ts'
const MODULE = join(ROOT, 'src', 'core', 'open-turn-carryover.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')

const { extractOpenTurnCarryover } = await import('../src/core/open-turn-carryover.ts')

const text = (value) => [{ type: 'text', text: value }]

test('v354 ①: the cluster lives in the new module; index.ts imports and re-exports it', () => {
  for (const name of ['extractOpenTurnCarryover', 'OpenTurnCarryover', 'PointerItem']) {
    assert.ok(moduleText.includes(name), `① 新模块必须声明 ${name}`)
  }
  assert.ok(moduleText.includes('export function extractOpenTurnCarryover('),
    '① 函数必须以 `export function` 声明')
  assert.ok(moduleText.includes('export interface OpenTurnCarryover'),
    '① 类型必须一起搬（否则新模块要 import 回 index.ts，立刻成环）')
  assert.ok(!indexText.includes('function extractOpenTurnCarryover('),
    '① index.ts 里不得再有声明')
  assert.ok(indexText.includes('export { extractOpenTurnCarryover }'),
    '① 导出面必须保持：裸 re-export（`export … from` 会带着相对路径活到产物里）')
  assert.ok(indexText.includes("export type { OpenTurnCarryover, PointerItem } from './core/open-turn-carryover.js'"),
    '① 两个类型也必须在 index.ts 里重新导出（它们是公开类型面）')
})

test('v354 ②: every non-plumbing line in the new module came from the pre-move index.ts', () => {
  /** Baseline = the parent of the commit that ADDED the module, never `HEAD` (see v351 ③ / v353 ②). */
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

test('v354 ③: completed work becomes a pointer, unfinished work does not, and absent input is undefined', () => {
  const events = [
    { seq: 10, type: 'turn/start', data: { turn: 7 } },
    { seq: 11, type: 'tool/call', data: { callId: 'c1', name: 'graft_prepare' } },
    { seq: 12, type: 'tool/result', data: { message: { toolCallId: 'c1', content: text('prepared') } } },
    { seq: 13, type: 'tool/call', data: { callId: 'c2', name: 'graft_commit' } },
    { seq: 14, type: 'tool/call', data: { callId: 'c3', name: 'pwsh' } },
    { seq: 15, type: 'tool/result', data: { message: { toolCallId: 'c3', content: text('exit code 1') }, error: 'boom' } },
    /** `user/message` 的正文在 `data.content` 上（不是 `data.message`）—— 实测的封装形状。 */
    { seq: 16, type: 'user/message', data: { source: { kind: 'user' }, content: text('继续') } },
    { seq: 17, type: 'user/message', data: { source: { kind: 'graft' }, content: text('插件自己写的一句话') } },
    { seq: 18, type: 'assistant/message', data: { message: { content: text('第一段') } } },
    { seq: 19, type: 'assistant/message', data: { message: { content: text('第二段') } } },
  ]

  const carry = extractOpenTurnCarryover(events, 0)
  assert.notEqual(carry, undefined, '③ 有内容时必须返回一份 carryover，而不是 undefined')
  assert.equal(carry.turn, 7, '③ turn 必须来自 turn/start')
  assert.deepEqual(carry.pointers, [
    { name: 'graft_prepare', seq: 12 },
    { name: 'pwsh', seq: 15, isError: true },
  ], '③ 只有拿到结果的调用才是工作；错误结果带 isError')
  assert.deepEqual(carry.userTexts, ['继续'],
    '③ 只有 source.kind === "user" 的消息算用户的话 —— 插件自己写的不得冒充')
  assert.equal(carry.assistantText, '第一段\n\n第二段', '③ 助手文本按空行拼接')

  /** `fromSeqExclusive` 之前的调用/文本必须被排除：它是「只要这一步之后的东西」。 */
  const tail = extractOpenTurnCarryover(events, 15)
  assert.notEqual(tail, undefined, '③ seq 15 之后仍有用户文本与助手文本，必须是 carryover')
  assert.equal(tail.turn, 0, '③ turn/start 在窗口之外 ⇒ turn 记 0（不是编一个数字）')
  assert.deepEqual(tail.pointers, [], '③ 两次调用都在窗口之外 ⇒ 指针必须为空')
  assert.deepEqual(tail.userTexts, ['继续'], '③ 窗口内的人话必须保留')
  assert.equal(tail.assistantText, '第一段\n\n第二段', '③ 窗口内的助手文本必须保留')

  const fromTail = extractOpenTurnCarryover(events, 17)
  assert.notEqual(fromTail, undefined, '③ seq 17 之后仍有助手文本，必须是 carryover')
  assert.deepEqual(fromTail.pointers, [], '③ 指针必须为空（两次调用都在 17 之前）')
  assert.deepEqual(fromTail.userTexts, [], '③ 用户文本必须为空')
  assert.equal(fromTail.assistantText, '第一段\n\n第二段')

  assert.equal(extractOpenTurnCarryover([], 0), undefined,
    '③ 空输入必须 undefined：空壳会让看板显示「有一轮开着」，而实际没有')
  assert.equal(extractOpenTurnCarryover([{ seq: 1, type: 'tool/call', data: { callId: 'x', name: 'pwsh' } }], 0), undefined,
    '③ 只有未完成的调用时也是 undefined —— 那不是工作，等它等于等一件不会来的事')
})