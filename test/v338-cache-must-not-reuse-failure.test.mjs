/**
 * ── v338 / A5'：失败的观测不得复用，成功的观测必须复用（lead §四十四.5）────────────────────────────
 *
 * 路径：**`suite-observation.mjs` 的缓存判定**（不是它跑出来的计数）。
 *
 * ── 事故（measured 2026-11-24，两次）─────────────────────────────────────────────────────────────
 *
 * 缓存键是 `test/` + `scripts/` 的文件大小与 mtime。一个**原因不在这些文件里**的失败——
 * 磁盘满、子进程死掉、机器负载 40——不会改变 digest，于是**一次坏观测被反复当成当前结论**。
 *
 * 实测：C 盘满时跑出 93 条 `ENOSPC`，此后腾出空间再跑 `npm run check`，**仍报 93 条**；
 * 而同一时刻直接 `node --test`（不走缓存）是绿的。paradise 也踩了同一个坑（改完文档仍红）。
 *
 * ── 规则是有方向的，不是「一律不用缓存」───────────────────────────────────────────────────────
 *
 *     failCount === 0  → 可以复用（缓存保住它存在的意义：check 还是快的）
 *     failCount  > 0   → **必须重新观察**。红结果重算便宜，信错很贵
 *
 * 判据（三条，两条负向）：
 *   ① 缓存里 `fail > 0` ⇒ `cached === false`（必须重跑），且重跑后的读数以新结果为准
 *   ② **负向** 缓存里 `fail === 0` ⇒ `cached === true`（不许把 check 从 5 分钟变 30 分钟）
 *   ③ **负向** 判据可红：把「`cachedFail === 0` 这个条件」从源码里去掉 ⇒ ① 必须变红
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OBS = await import(pathToFileURL(join(ROOT, 'scripts', 'suite-observation.mjs')).href)

/**
 * Build a throwaway repo whose `test` script prints a controllable TAP summary, and whose cache we
 * can seed by hand. The point is the CACHE DECISION, so the suite itself must be trivially fake.
 */
function makeStubRepo({ failCount }) {
  const root = mkdtempSync(join(tmpdir(), 'v338-obs-'))
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'stub', scripts: { test: `node stub-suite.mjs ${failCount}` } }),
    'utf8',
  )
  /** Prints a TAP-shaped summary; exit code follows the failure count so `execFileSync` throws on red. */
  writeFileSync(
    join(root, 'stub-suite.mjs'),
    [
      'const fail = Number(process.argv[2] ?? 0)',
      "console.log('# tests 3')",
      "console.log('# pass ' + (3 - fail))",
      "console.log('# fail ' + fail)",
      "console.log('# skipped 0')",
      'process.exit(fail > 0 ? 1 : 0)',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, 'test', 'x.test.mjs'), '// placeholder so inputDigest has an input\n', 'utf8')
  return root
}

/** Seed the cache the way a previous run would have left it, for THIS tree's digest. */
function seedCache(root, { failCount }) {
  const tap = ['# tests 3', `# pass ${3 - failCount}`, `# fail ${failCount}`, '# skipped 0', ''].join('\n')
  const digest = OBS.__inputDigestForTest(root)
  const payload = JSON.stringify({
    digest,
    tap,
    tapDigest: createHash('sha256').update(tap).digest('hex'),
  })
  writeFileSync(join(root, 'node_modules', '.cache', 'dsh-suite-observation.json'), payload, 'utf8')
}

test('v338 ①: a cached FAILURE is never reused — the suite is re-observed', () => {
  /**
   * The fake repo now PASSES (0 failures) while the seeded cache says 2. Reusing that cache would
   * reproduce the exact incident: a red observation surviving a fix, because nothing in the digest
   * moved. A correct implementation re-runs and reports the CURRENT answer.
   */
  const root = makeStubRepo({ failCount: 0 })
  try {
    seedCache(root, { failCount: 2 })
    const result = OBS.observeSuite({ root })
    assert.equal(result.cached, false, '① 缓存里 fail > 0 ⇒ 必须重新观察，不得复用')
    assert.equal(result.index.fail, 0, '① 重跑之后的读数必须是当前结果（0 fail），不是缓存里那 2 条')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v338 ② (negative): a cached GREEN is still reused — the cache keeps its reason to exist', () => {
  /**
   * Without this half, the obvious "fix" is to stop caching altogether, which turns `check` into a
   * 30-minute command and gets the cache deleted by the next person. A green observation is
   * environment-independent enough to trust, and it is the common case.
   */
  const root = makeStubRepo({ failCount: 0 })
  try {
    seedCache(root, { failCount: 0 })
    const result = OBS.observeSuite({ root })
    assert.equal(result.cached, true, '② fail === 0 的缓存必须命中 —— 否则 check 会从 5 分钟变 30 分钟')
    assert.equal(result.index.fail, 0, '② 命中的读数仍然是 0 fail')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v338 ③ (negative): the criterion can fail — dropping the failCount guard breaks ①', () => {
  /**
   * A criterion about a cache decision is easy to write vacuously: `cached` is false whenever the
   * cache misses for ANY reason. So we prove the specific guard is what does the work by checking
   * that it is present AND that its removal would let a red cache through.
   */
  const source = readFileSync(join(ROOT, 'scripts', 'suite-observation.mjs'), 'utf8')
  assert.match(
    source,
    /cachedFail\s*===\s*0/u,
    '③ 源码里必须有 `cachedFail === 0` 这个条件 —— 它就是「失败不复用」的那一条',
  )
  /**
   * And the simulation: with the guard, a red cache is a miss. The assertion above is what would
   * disappear if someone reverted it, so the pair cannot both pass while the guard is gone.
   */
  const root = makeStubRepo({ failCount: 0 })
  try {
    seedCache(root, { failCount: 1 })
    const result = OBS.observeSuite({ root })
    assert.equal(result.cached, false, '③ 有 red 缓存时仍必须重跑（这条与 ① 同源，但用不同的 fail 值）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
