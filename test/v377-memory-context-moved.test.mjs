/**
 * ── v377：`renderMemoryContext` 与它的输入类型一起搬出（纯移动，零环）─────────────────────────────
 *
 * 这一簇搬走 `renderMemoryContext`（35 行）**和** `MemoryContextInput`（27 行，含文档注释）。
 *
 * 为什么类型也要走：第一版把类型留在 `index.ts`、新模块 `import type { … } from '../index.js'`。
 * `check-cycles` 接受了（type-only 环被显式允许 —— `import type` 运行时擦除），**但 `build.mjs`
 * 拒绝任何它无法在打包时解析的相对 import**。两侧对同一个形状给了不同答案，而打包器是更硬的那一侧。
 *
 * 更根本的理由：这两个东西是**一起写的、一起用的**。把它们分开住，等于为了「类型不必搬」而制造
 * 一条反向依赖 —— 那不是纯移动，是把环搬出来。
 *
 * ① 新模块零 import（既无值依赖，也无反向类型依赖）—— 这是「搬干净了」的可判定形态
 * ② 从源码模块直接 import 可用：三种内容各自成段，空集必须返回 `undefined`
 * ③ `index.ts` 仍导出函数与类型（它们**都是**公开面的一部分）
 * ④ 空集返回 `undefined` 而不是空标题 —— 那条注释说的事，必须在行为里成立
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE = join(ROOT, 'src', 'core', 'memory-context.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')
const { renderMemoryContext } = await import('../src/core/memory-context.ts')

test('v377 ①: the new module has NO imports at all (no value edge, no back type import)', () => {
  const imports = moduleText.match(/^\s*import\s.*$/gmu) ?? []
  assert.deepEqual(imports, [],
    `① 新模块必须零 import —— 有反向类型 import 就等于把环搬了出来：\n  ${imports.join('\n  ')}`)
  /** And it owns both the renderer and its input type. */
  assert.ok(/export interface MemoryContextInput/u.test(moduleText),
    '① 类型必须与渲染器同住 —— 它们是一起写、一起用的')
  assert.ok(/export function renderMemoryContext/u.test(moduleText),
    '① 函数必须在')
})

test('v377 ②: it renders all three sections from SOURCE', () => {
  const text = renderMemoryContext({
    skills: [{ name: 'k', title: '做法', when: '当需要时' }],
    negatives: [{ title: '失败', detail: '原因' }],
    facts: [{ title: '事实' }],
  })
  assert.ok(text !== undefined, '② 有内容时必须返回文本')
  assert.ok(text.includes('已知做法'), `② 必须有技能段，实测：${text.slice(0, 200)}`)
  assert.ok(text.includes('已知失败'), '② 必须有负知识段')
  assert.ok(text.includes('相关事实'), '② 必须有事实段')
  assert.ok(text.includes('HARD CONSTRAINTS'), '② 结尾必须写清优先级，否则读者不知道哪边更大')
})

test('v377 ③: index.ts still exports both — they ARE public', () => {
  assert.ok(/import \{ renderMemoryContext \} from '\.\/core\/memory-context\.js'/u.test(indexText),
    '③ index.ts 必须从新模块引入')
  assert.ok(/export \{ renderMemoryContext \}/u.test(indexText),
    '③ 必须再导出函数（它是公开面的一部分，与上一个簇不同）')
  assert.ok(/export type \{ MemoryContextInput \}/u.test(indexText),
    '③ 必须再导出类型')
})

test('v377 ④: an EMPTY set returns undefined, never an empty heading', () => {
  /**
   * The comment in the file says this explicitly: an empty "MEMORY CONTEXT" heading reads as
   * 「memory was consulted and knew nothing」, which is a DIFFERENT signal from 「memory was not
   * consulted」. That claim has to hold in behaviour, not only in prose.
   */
  assert.equal(renderMemoryContext({}), undefined, '④ 空输入必须返回 undefined')
  assert.equal(renderMemoryContext({ skills: [], negatives: [], facts: [] }), undefined,
    '④ 三个空数组也必须返回 undefined')
})
