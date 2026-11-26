/**
 * ── v372：`extractOpenBackgroundWork` 搬出 `index.ts` 之后的独立性与行为 ──────────────────────────
 *
 * 这一刀把 `OpenBackgroundWork` 接口与 `extractOpenBackgroundWork` 一起搬进
 * `src/core/open-background-work.ts`。纯移动由 `verify-pure-move` 保证（IDENTICAL，多重集 25321
 * 不变），但**纯移动判据只证明「没有改写」，不证明「搬出来的东西还能被单独用」**。
 *
 * 这正是 S5/S6 定下的那条纪律：**拆完就能单独测模块**。所以这里 `registerSourceModules()`
 * 直接读**源码模块** —— 产物把 49 个模块内联进一个作用域，「模块」那一层已经不存在，
 * 用产物测就证明不了独立性。
 *
 * ① 新模块**不反向 import `index.ts`**（否则搬动把环搬出来了）
 * ② 从**源码模块**直接 import 可用，且四类事件（开/结 × job/subagent）行为不变
 * ③ `index.ts` 仍再导出它（84 个测试文件从入口拿符号，导出面不许缩）
 * ④ 标签与 ID 的分工不变（v0.40 那条区分不许被搬动抹掉）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE = join(ROOT, 'src', 'core', 'open-background-work.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')

const { extractOpenBackgroundWork } = await import('../src/core/open-background-work.ts')

test('v372 ①: the new module does not import back into index.ts', () => {
  const imports = moduleText.match(/from '[^']+'/gu) ?? []
  const back = imports.filter((line) => /index(?:\.js)?'/u.test(line))
  assert.deepEqual(back, [],
    `① 搬出来的模块不得反向 import index.ts —— 那是搬动了环而不是搬出了模块：${back.join(', ')}`)
})

test('v372 ②: the module loads from SOURCE and behaves exactly as before', () => {
  /**
   * Four event kinds: the (open, settle) × (job, subagent) matrix is what the function exists for.
   * **The names are read from the shared table**, not guessed — `SUBAGENT_OPEN_EVENT_NAMES` is
   * `subagent/start` (`pending-transfers.ts`), and the first version of this fixture wrote
   * `subagent/started`, which simply is not an event name. A fixture built from memory measures the
   * fixture, not the code.
   */
  const events = [
    { type: 'job/registered', data: { jobId: 'j1', label: '后台作业 1' } },
    { type: 'job/registered', data: { jobId: 'j2', label: '' } },
    { type: 'job/settled', data: { jobId: 'j1' } },
    { type: 'subagent/start', data: { taskId: 's1', label: '子代理 A' } },
  ]
  const open = extractOpenBackgroundWork(events)

  /** j1 settled ⇒ gone; j2 still open, empty label ⇒ falls back to the id. */
  assert.deepEqual(open.jobs, ['j2'], `② jobs 实测 ${JSON.stringify(open.jobs)}`)
  assert.deepEqual(open.jobIds, ['j2'], `② jobIds 实测 ${JSON.stringify(open.jobIds)}`)
  assert.deepEqual(open.subagents, ['子代理 A'], `② subagents 实测 ${JSON.stringify(open.subagents)}`)
  assert.deepEqual(open.subagentIds, ['s1'], `② subagentIds 实测 ${JSON.stringify(open.subagentIds)}`)

  /** And a settled subagent must disappear — `subagent/end` is one of the three settle names. */
  const settled = extractOpenBackgroundWork([
    ...events,
    { type: 'subagent/end', data: { taskId: 's1' } },
  ])
  assert.deepEqual(settled.subagents, [],
    `② 结算后 subagents 必须为空，实测 ${JSON.stringify(settled.subagents)}`)
})

test('v372 ③: index.ts still re-exports it — the public surface may not shrink', () => {
  assert.ok(/from '\.\/core\/open-background-work\.js'/u.test(indexText),
    '③ index.ts 必须仍然从新模块引入（导出面不许因为搬动而缩小）')
  assert.ok(/export \{ extractOpenBackgroundWork \}/u.test(indexText),
    '③ 必须仍然以具名形式再导出 extractOpenBackgroundWork')
  assert.ok(/export type \{ OpenBackgroundWork \}/u.test(indexText),
    '③ 类型也必须再导出 —— 84 个测试文件从入口拿符号')
})

test('v372 ④: labels and ids stay separate (the v0.40 distinction, not re-merged by the move)', () => {
  /**
   * A pure move must preserve this comment: it records WHY the ids exist, and that reason is the
   * only thing standing between a future reader and 「labels are enough」.
   */
  assert.ok(/THE LABELS ARE FOR READING/u.test(moduleText),
    '④ 说明「标签给人读、ID 给台账看」的那段必须在搬动中保留 —— 它是这个接口存在四个字段的理由')
})
