/**
 * ── v358：S6 第三簇 —— `discardPartialTarget` 搬进 `core/discard-target.ts` ────────────────────────
 *
 * 三条判据同形：位置、无新内容、行为不变（源码模块）。它同样**不在导出面**上，所以 ① 是反向断言。
 *
 * 这一簇是「失败的目标怎么收拾」，它的语义是**尽力而为 + 记账**，不是「删干净」：
 *
 *   1. **三种后端各试一个方法就停**（`discardPrepared`/`discard`/`forget`；`remove`/`delete`；
 *      `remove`/`delete`/`dispose`）。宿主能力不齐，所以「有哪些就调用哪个」；
 *   2. **每一步都记进 notes**，包括**失败**的那一步（`persistence.discard failed: …`）。
 *      把失败吞掉的清理函数会让下一次读起来像「什么都没发生」；
 *   3. **一个方法都没有时也要说清楚**：日志写「could not be removed (no delete API on this host);
 *      the id stays reserved」—— id 仍被占用是一个**事实**，不能静默；
 *   4. **清理失败不得替换主故障**：整个函数不抛错，日志本身也包在 try/catch 里。
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
const MODULE_REL = 'src/core/discard-target.ts'
const MODULE = join(ROOT, 'src', 'core', 'discard-target.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')

const { discardPartialTarget } = await import('../src/core/discard-target.ts')

/** A fake plugin context: `get(name)` returns whatever the case mounted, and a logger that records. */
const contextWith = (services, warnings) => ({
  get: (name) => services[name],
  logger: { warn: (line) => warnings.push(line) },
})

test('v358 ①: the function lives in the new module, and index.ts imports it without widening the surface', () => {
  assert.ok(moduleText.includes('export async function discardPartialTarget(') || moduleText.includes('export function discardPartialTarget('),
    '① 新模块必须导出它（ESM 没有隐式共享作用域）')
  assert.ok(!indexText.includes('function discardPartialTarget('), '① index.ts 里不得再有声明')
  assert.ok(indexText.includes("import { discardPartialTarget } from './core/discard-target.js'"), '① index.ts 必须从新模块导入')
  assert.ok(!indexText.includes('export { discardPartialTarget }'),
    '① 不得 re-export：它不在 .export-surface.json 上，加一行就是把公开面从 223 扩到 224')
})

test('v358 ②: every non-plumbing line in the new module came from the pre-move index.ts', () => {
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

test('v358 ③: cleanup is best-effort AND accounted — every attempt, including its failure, is named', async () => {
  /** (1) the happy path: the first usable method is called once and recorded. */
  {
    const warnings = []
    const called = []
    const ctx = contextWith({
      sessionPersistence: { discardPrepared: async (id) => { called.push(`discardPrepared:${id}`) } },
    }, warnings)
    await discardPartialTarget(ctx, 'target-1')
    assert.deepEqual(called, ['discardPrepared:target-1'], '③ 有 discardPrepared 就调用它，且只调用一次')
    assert.equal(warnings.length, 1, '③ 恰好一行日志')
    assert.ok(warnings[0].includes('discarded failed target target-1'), '③ 日志必须点名目标')
    assert.ok(warnings[0].includes('persistence.discardPrepared'), '③ 日志必须点名用了哪个方法（notes 是证据）')
  }

  /** (2) a THROWING method is recorded as a failure, and the next method is still tried. */
  {
    const warnings = []
    const ctx = contextWith({
      sessionPersistence: {
        discardPrepared: async () => { throw new Error('backend said no') },
        remove: async () => undefined,
      },
    }, warnings)
    await discardPartialTarget(ctx, 'target-2')
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('persistence.discardPrepared failed: backend said no'),
      '③ 失败的那一步必须被记进 notes —— 吞掉的清理会让下一次读起来像「什么都没发生」')
    assert.ok(warnings[0].includes('persistence.remove'), '③ 第一个方法失败后，第二种后端仍要被尝试')
  }

  /** (3) nothing usable at all ⇒ the log says the id stays RESERVED (a fact, not silence). */
  {
    const warnings = []
    const ctx = contextWith({}, warnings)
    await discardPartialTarget(ctx, 'target-3')
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes('could not be removed'), '③ 一个方法都没有 ⇒ 明说删不掉')
    assert.ok(warnings[0].includes('the id stays reserved'), '③ 且必须说 id 仍被占用 —— 那是读者真正需要知道的事实')
  }

  /** (4) a live-store entry is only touched when it exists. */
  {
    const warnings = []
    const called = []
    const ctx = contextWith({
      sessions: {
        get: (id) => (id === 'target-4' ? { id } : undefined),
        dispose: async (id) => { called.push(`dispose:${id}`) },
      },
    }, warnings)
    await discardPartialTarget(ctx, 'target-4')
    assert.deepEqual(called, ['dispose:target-4'], '③ 活着的条目必须被移除')
    assert.ok(warnings[0].includes('sessions.dispose'))
  }

  /** (5) `ctx.get` throwing must not escape, and neither must a throwing logger. */
  {
    const warnings = []
    const ctx = {
      get: () => { throw new Error('no such service') },
      logger: { warn: () => { throw new Error('logger is broken') } },
    }
    await discardPartialTarget(ctx, 'target-5')
    assert.equal(warnings.length, 0, '③ 夹具的 logger 会抛，所以没有记录 —— 但它必须不把异常抛出来')
  }
})