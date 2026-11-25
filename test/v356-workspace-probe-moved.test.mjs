/**
 * ── v356：S6 第一簇 —— `verifyWorkspace` 搬进 `core/workspace-probe.ts` ────────────────────────────
 *
 * 三条判据同形：位置、无新内容、行为不变（源码模块）。
 *
 * 这一簇的语义值得钉住的地方是它的**诚实性**，不是它读到了什么：
 *
 *   1. **「查不到」与「查到了、是干净的」必须不同**。没有 git、不是仓库、超时、拒权 —— 一律写进
 *      `unavailable`，而不是省略字段让读的人以为干净。看板说「成功」而 12 个文件没提交，
 *      是这类探针最常见的真实故障。
 *   2. **没有工作目录与没有条目是两个事实**：`cwd` 为空 ⇒ `cwd: '(未记录)'` + 原因，
 *      且不能把 `entries` 编成 0（`entries` 是「读不到就不出现」的字段，不是计数器）。
 *   3. **脏树要分「已跟踪改动」与「未跟踪」**，因为 `??` 前缀是 porcelain 的分类依据，混在一起报
 *      「5 个改动」会让读的人以为都是已跟踪文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE_REL = 'src/core/workspace-probe.ts'
const MODULE = join(ROOT, 'src', 'core', 'workspace-probe.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')

const { verifyWorkspace } = await import('../src/core/workspace-probe.ts')

test('v356 ①: the declaration lives in the new module, and index.ts imports + re-exports it', () => {
  assert.ok(moduleText.includes('export function verifyWorkspace('), '① 新模块必须以 export function 声明它')
  assert.ok(!indexText.includes('function verifyWorkspace('), '① index.ts 里不得再有声明')
  assert.ok(indexText.includes("import { verifyWorkspace } from './core/workspace-probe.js'"), '① index.ts 必须从新模块导入')
  assert.ok(indexText.includes('export { verifyWorkspace }'), '① 必须裸 re-export，保持导出面')
  assert.ok(!indexText.includes("export { verifyWorkspace } from"), '① `export … from` 会带着相对路径活到产物里')
})

test('v356 ②: every non-plumbing line in the new module came from the pre-move index.ts', () => {
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

test('v356 ③: an unanswerable probe reports WHY, and "could not check" is never rendered as "clean"', () => {
  /**
   * A directory that is NOT inside any git repository. The first version of this test used
   * `join(ROOT, 'test')` — which is a SUBDIRECTORY of this repo, so `git rev-parse` walks up and
   * answers with the repo's own HEAD. The assertion then failed with a real value where it expected
   * `undefined`, and the correct conclusion was "the fixture is wrong", not "the probe lies":
   * a subdirectory of a repo IS in a repo.
   *
   * So the fixture is a fresh temp directory, deliberately outside this checkout.
   */
  const outside = mkdtempSync(join(tmpdir(), 'v356-not-a-repo-'))
  const verdict = verifyWorkspace(outside, 1_700_000_000_000)
  assert.equal(verdict.cwd, outside, '③ cwd 必须原样回报')
  assert.equal(verdict.head, undefined, '③ 不是仓库 ⇒ 不得有 head（更不能编一个）')
  assert.equal(typeof verdict.unavailable, 'string', '③ 「查不到」必须写在 unavailable 里，而不是省略字段')
  assert.ok(verdict.unavailable.length > 0, '③ unavailable 必须说明原因，不能是空串')
  assert.equal(verdict.at, 1_700_000_000_000, '③ 读数时刻必须来自注入的 now，不读系统时钟')
  assert.equal(verdict.entries, 0, '③ 空目录可读 ⇒ entries 是 0；0 是真读数，不是「读不到」')

  /** An empty cwd is its own fact: it must not fall through to the git probes. */
  const empty = verifyWorkspace('   ', 1_700_000_000_001)
  assert.equal(typeof empty.unavailable, 'string', '③ cwd 为空 ⇒ 必须有 unavailable，说明「源会话没有可用的工作目录」')
  assert.equal(empty.head, undefined, '③ cwd 为空 ⇒ 不得有 head')
  assert.equal(empty.at, 1_700_000_000_001)

  /** A real repository answers: this very checkout is one. Then dirty counts must be split by porcelain prefix. */
  const real = verifyWorkspace(ROOT, 1_700_000_000_002)
  assert.ok(typeof real.head === 'string' && real.head.length > 0, '③ 真仓库必须读出 HEAD')
  assert.equal(real.unavailable, undefined, '③ 能回答时不得留 unavailable（否则「干净」与「没查」又混了）')
  if (real.dirty !== undefined) {
    assert.equal(typeof real.dirty.tracked, 'number', '③ 已跟踪改动必须是独立计数')
    assert.equal(typeof real.dirty.untracked, 'number', '③ 未跟踪改动必须是独立计数')
    assert.equal(real.dirty.tracked + real.dirty.untracked >= 0, true)
  }
})