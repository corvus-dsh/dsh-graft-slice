/**
 * ── v353：S5 第一簇 —— `resetRetiredSessions` 搬进 `core/session-state-reset.ts` ─────────────────────
 *
 * 纯移动的验收三件套，和 v351 同一套口径：
 *
 *   ① **位置真的变了** —— 新模块里以 `export function` 声明，`index.ts` 里不再有同名声明，
 *      而 `index.ts` 只多了一行 import 与一行裸 re-export；
 *   ② **没有新内容** —— 新模块的每一个非 import/export 行都必须来自搬动前的 `index.ts`
 *      （基线 = **引入这个模块的那个提交的父提交**，不是 `HEAD`：见下面 ② 的注释）；
 *   ③ **行为不变** —— 直接 import **源码模块**（`test/source-module.mjs` 的解析钩子），
 *      往 `core/state.ts` 的集合里塞几条记录，调用它，断言清空。用构建产物测不出这一条，
 *      因为产物把 42 个模块内联进一个作用域，「模块」在那一层已经不存在了。
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
const MODULE_REL = 'src/core/session-state-reset.ts'
const MODULE = join(ROOT, 'src', 'core', 'session-state-reset.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')

const { resetRetiredSessions } = await import('../src/core/session-state-reset.ts')
const state = await import('../src/core/state.ts')
const watermark = await import('../src/core/watermark.ts')

test('v353 ①: the declaration lives in the new module, and index.ts only imports + re-exports it', () => {
  assert.ok(moduleText.includes('export function resetRetiredSessions('),
    '① 新模块必须以 `export function resetRetiredSessions(` 声明它')
  assert.ok(!indexText.includes('function resetRetiredSessions('),
    '① index.ts 里不得再有声明 —— 两个副本会让后者静默覆盖前者')
  assert.ok(indexText.includes("import { resetRetiredSessions } from './core/session-state-reset.js'"),
    '① index.ts 必须从新模块导入它（否则裸 re-export 没有可导出的绑定）')
  assert.ok(indexText.includes('export { resetRetiredSessions }'),
    '① index.ts 必须把它再导出 —— 导出面 223 条不能因为搬动而少一条')
  assert.ok(!indexText.includes("export { resetRetiredSessions } from"),
    '① re-export 必须是裸的：`export … from` 会带着相对路径活到产物里，bundle 守卫会拒绝')
})

test('v353 ②: every non-plumbing line in the new module came from the pre-move index.ts', () => {
  /**
   * ── 基线为什么是「添加这个模块的提交的父提交」，不是 HEAD ──────────────────────────────────────
   *
   * S4 的 v351 ③ 第一版用 `git show HEAD:src/index.ts`，在搬动**未提交**时完全正确；一提交，
   * HEAD 就是搬动后的树，于是每一个搬走的行都「出现」了，判据在它接受的那个提交上变红。
   * 一条把**会移动的指针**当基线的判据，不会因为方向对就安全。
   */
  const addingCommits = execFileSync(
    'git',
    ['log', '--diff-filter=A', '--format=%H', '--', MODULE_REL],
    { cwd: ROOT, encoding: 'utf8' },
  ).split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const introducing = addingCommits.pop()
  const baselineRev = introducing === undefined ? 'HEAD' : `${introducing}^`
  const before = execFileSync('git', ['show', `${baselineRev}:src/index.ts`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  const beforeCount = new Map()
  for (const line of before.split('\n').map((text) => text.trimEnd())) {
    beforeCount.set(line, (beforeCount.get(line) ?? 0) + 1)
  }

  /** Comments count: a comment is a content line for `verify-pure-move`, and this asks "did this line exist". */
  const appeared = []
  for (const line of moduleText.split('\n').map((text) => text.trimEnd())) {
    if (line.length === 0) continue
    if (line.startsWith('import ') || line.startsWith('export ')) continue
    const available = beforeCount.get(line) ?? 0
    if (available === 0) {
      appeared.push(line)
      continue
    }
    beforeCount.set(line, available - 1)
  }

  assert.deepEqual(appeared, [], `② 这些行在新模块里出现，但 ${baselineRev} 的 index.ts 里没有（＝新增内容）：\n  ${appeared.slice(0, 10).join('\n  ')}`)
})

test('v353 ③: it still clears every per-session collection (measured on the SOURCE module)', () => {
  state.retiredSessions.add('session-a')
  state.retiredSessions.add('session-b')
  state.preparedSlices.set('prepared-a', { marker: 'x' })
  state.planNudgeStates.set('agent-a', { userKey: 'k', turns: 3, nudged: true, lastNudgeTurn: 1 })
  state.watermarkEscalations.set('session-a', { at: 1 })
  state.autoGraftSuppressedUntil.set('session-a', 1)
  watermark.watermarkCache.set('session-a', { scannedUpTo: 9, contextWindow: 1000, usageTokens: 10 })

  assert.equal(state.retiredSessions.size, 2, '③ 前置：塞进去的必须真的在（否则下面测的是空集）')
  assert.equal(state.watermarkEscalations.size, 1, '③ 前置：水位集合也必须真的有内容')

  resetRetiredSessions()

  assert.equal(state.retiredSessions.size, 0, '③ 退休集合必须被清空')
  assert.equal(state.preparedSlices.size, 0, '③ 预置切片必须被清空')
  assert.equal(state.planNudgeStates.size, 0, '③ 计划吹哨状态必须被清空（v1.0.0 P0 补的那一个）')
  assert.equal(state.watermarkEscalations.size, 0, '③ 水位升级标记必须被清空')
  assert.equal(state.autoGraftSuppressedUntil.size, 0, '③ 恢复宽限必须被清空')
  assert.equal(watermark.watermarkCache.size, 0, '③ 水位缓存来自另一个模块，也必须被清空')

  /** 幂等：第二次调用不得抛错，也不得因为空集合而走另一条路径。 */
  resetRetiredSessions()
  assert.equal(state.retiredSessions.size, 0, '③ 重复调用必须仍然安全')
})