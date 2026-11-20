#!/usr/bin/env node
/**
 * ── HOT-PATH TABLE (B4-0b-2 W4-5) ───────────────────────────────────────────────────────────────
 *
 * Audit AUD-15 asked for the per-turn hot paths to be MEASURED AND WRITTEN DOWN once: what a turn
 * actually pays for `task-position` rendering, retrieval at scale, `memory_stats`, and one supervisor
 * tick. No thresholds — **a baseline is not a gate.** The point is that "it feels slow" and "it got
 * slower" become questions someone can answer with two readings instead of a memory.
 *
 * ── WHY THIS FILE IS NOT IN `check` ────────────────────────────────────────────────────────────
 *
 * Same reason as `burn-in.mjs`: it produces a RATE, takes minutes, and a threshold would turn every
 * small regression into a red build. `perf.sh` compares two readings; `check` judges correctness.
 *
 * ── THE THREE THINGS EVERY READING HERE CARRIES (this batch's rule, §26.4) ─────────────────────
 *
 *   1. HOW MANY runs      — the count is printed, and medians require ≥ 5 samples
 *   2. MEDIAN, not mean   — one GC pause must not become the headline
 *   3. THE MACHINE        — node/platform/arch/cpu, so a number can be re-checked or explained
 *
 * A reading missing any of the three is a claim, not a measurement.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/hot-paths.mjs                 # every path, 7 samples, markdown table
 *   node scripts/hot-paths.mjs --samples 15
 *   node scripts/hot-paths.mjs --only task-position,memory-stats
 *   node scripts/hot-paths.mjs --json          # machine-readable, for diffing two runs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const MIN_SAMPLES = 5

/** Median of the samples after the first is dropped (module init, not the operation). */
function medianOf(samples) {
  const sorted = [...samples.slice(1)].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function environment() {
  const cpu = cpus()[0]
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpu === undefined ? 'unknown' : `${cpu.model.trim()} × ${cpus().length}`,
    at: new Date().toISOString(),
    repo: REPO,
  }
}

// ── the paths ─────────────────────────────────────────────────────────────────────────────

/**
 * Each measurement returns the raw sample array, so the caller can print min/median/max and so a
 * future reader can see the SPREAD — a median with a huge max is a very different fact from a tight
 * one, and only printing the median would hide it.
 */
const PATHS = {
  /**
   * `task-position` rendering: the block every slice prepends so the next generation knows where it
   * stands. It runs once per handoff, so its cost matters only in that it must not be O(history).
   */
  'task-position': async (samples) => {
    /**
     * ── THE REAL HOT PATH IS THE PAIR, NOT THE RENDERER ALONE (measured) ──────────────────────────
     *
     * The first version called `renderTaskPosition(position)` with a hand-built `{ goal, progress, … }`
     * and got `undefined` — because that function's input is a POSITION produced by
     * `toTaskPosition(graph, options)`, not a loose summary. So the hot path a slice actually pays for
     * is: read the graph → `toTaskPosition` → `renderTaskPosition`. Measuring only the second half on
     * a shape it rejects would have timed an early return, and an early return is very fast.
     *
     * (Both are exported by the shipped bundle; `toTaskPosition` is the documented constructor for the
     * shape `renderTaskPosition` consumes.)
     */
    const { toTaskPosition, renderTaskPosition } = await import('../index.js')
    if (typeof toTaskPosition !== 'function' || typeof renderTaskPosition !== 'function') {
      return { skip: 'this build does not export both `toTaskPosition` and `renderTaskPosition`' }
    }

    const now = Date.now()
    /** A graph shaped like the ones this project actually writes: ~30 nodes, mixed status. */
    const graph = {
      goal: 'B4-0b-2 收口：把读、写、性能三条线各自量清楚',
      nodes: Array.from({ length: 30 }, (_, index) => ({
        id: `n${index}`,
        title: `节点 ${index}：一项可以独立验收的工作`,
        status: index < 18 ? 'done' : index < 24 ? 'in_progress' : 'pending',
        dependsOn: index === 0 ? [] : [`n${index - 1}`],
        requirements: [`要求 ${index}.1`, `要求 ${index}.2`],
        progress: index < 18 ? 100 : index < 24 ? 50 : 0,
        updatedAt: now - (30 - index) * 60 * 60 * 1000,
      })),
    }

    const times = []
    let renderedText = ''
    for (let index = 0; index < samples; index += 1) {
      const startedAt = process.hrtime.bigint()
      const position = toTaskPosition(graph, { now })
      const rendered = renderTaskPosition(position)
      const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6
      /** A renderer that returns `undefined` was not measured — refuse rather than time an early return. */
      if (rendered === undefined) return { skip: 'toTaskPosition/renderTaskPosition returned undefined for this graph shape — nothing was measured' }
      renderedText = rendered
      times.push(elapsed)
    }
    return { times, note: `30-node graph, ${String(renderedText).length} chars rendered, both halves timed` }
  },

  /**
   * `memory_stats`: the read path the memory panel calls on every paint.
   *
   * ── WHY THIS IS SKIPPED HERE RATHER THAN IMPORTED (measured) ──────────────────────────────────
   *
   * The first version imported `../lib/retrieve/documents.js` from THIS repository and crashed with
   * ERR_MODULE_NOT_FOUND — `lib/` is the memory package's build output, and the observer/graft
   * isolation rules forbid reaching into a sibling package's internals anyway. The memory repo has
   * its own reading (`dsh-memory/docs/PERF-RETRIEVAL.md`), taken by its own script.
   *
   * Saying SKIPPED with the reason is the honest option: a number measured through a forbidden import
   * would be worse than no number, because it would also break the isolation guarantee.
   */
  'memory-stats': async () => ({
    skip: 'lives in dsh-memory (cross-repo import forbidden); see dsh-memory/docs/PERF-RETRIEVAL.md',
  }),

  /**
   * ONE supervisor tick: the decision function the observer runs on every event. Pure and synchronous,
   * so this is the cost of deciding, not of delivering.
   */
  'supervisor-tick': async (samples) => {
    /**
     * The observer is a separate repository. Measuring it from here would mean importing another
     * package, which the isolation rules forbid. So this path is reported as SKIPPED with the reason,
     * and the observer repo has its own reading in `docs/PERF-HOT-PATHS.md` when it is taken.
     */
    return { skip: 'supervisor lives in dsh-observer; measure it there (cross-repo import is forbidden)' }
  },

  /**
   * Retrieval at 2000 documents — the same corpus shape the memory baseline uses, so the two readings
   * can be compared. COLD only: a warm reading is a cache hit and says nothing about scale.
   */
  'retrieval-2000-cold': async (samples) => {
    const baseline = join(REPO, '..', 'dsh-memory', 'scripts', 'retrieval-baseline.mjs')
    let output
    try {
      output = execFileSync(process.execPath, [baseline, '--samples', String(Math.max(MIN_SAMPLES, samples))], {
        encoding: 'utf8',
        timeout: 600_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return { skip: `memory baseline unavailable: ${String(error?.message ?? error).slice(0, 120)}` }
    }
    const line = /^\s+2000\s+([\d.]+)\s+([\d.]+)\s+2000\s*$/mu.exec(output)
    if (line === null) return { skip: 'could not parse the 2000-document row from the memory baseline' }
    /**
     * The memory baseline reports a MEDIAN, not samples, so it is passed through as a single reading
     * with its provenance stated. Pretending it were a sample array would be the "median of a median"
     * mistake, which hides exactly the spread this table exists to expose.
     */
    return { fixed: Number(line[2]), note: 'from dsh-memory baseline (cold median), not re-sampled here' }
  },
}

// ── run ───────────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
let samples = 7
let only
let asJson = false
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--samples') {
    samples = Number(args[index + 1])
    index += 1
    continue
  }
  if (args[index] === '--only') {
    only = String(args[index + 1]).split(',')
    index += 1
    continue
  }
  if (args[index] === '--json') {
    asJson = true
    continue
  }
}
if (!Number.isFinite(samples) || samples < MIN_SAMPLES) {
  console.error(`--samples must be ≥ ${MIN_SAMPLES}: a median of fewer on a shared machine is noise`)
  process.exit(2)
}

const selected = only === undefined ? Object.keys(PATHS) : only.filter((name) => name in PATHS)
if (selected.length === 0) {
  console.error(`no such path. available: ${Object.keys(PATHS).join(', ')}`)
  process.exit(2)
}

const rows = []
for (const name of selected) {
  const result = await PATHS[name](samples)
  if (result.skip !== undefined) {
    rows.push({ path: name, skipped: result.skip })
    continue
  }
  if (result.fixed !== undefined) {
    rows.push({ path: name, median: result.fixed, note: result.note })
    continue
  }
  const times = result.times
  rows.push({
    path: name,
    median: medianOf(times),
    min: Math.min(...times.slice(1)),
    max: Math.max(...times.slice(1)),
    samples: times.length,
    note: result.note,
  })
}

const env = environment()
if (asJson) {
  console.log(JSON.stringify({ environment: env, samples, rows }, null, 2))
  process.exit(0)
}

console.log('# 热路径读数（W4-5）')
console.log('')
console.log('> 基线，不是门禁。判据在别处；这里只回答「一轮大概花多少」。')
console.log('')
console.log('## 环境')
console.log('')
console.log('| 项 | 值 |')
console.log('|---|---|')
console.log(`| Node | ${env.node} |`)
console.log(`| 平台 | ${env.platform} |`)
console.log(`| CPU | ${env.cpu} |`)
console.log(`| 采样 | 每项 ${samples} 次，取中位（丢弃第 1 次：模块初始化） |`)
console.log(`| 时间 | ${env.at} |`)
console.log('')
console.log('## 读数（ms）')
console.log('')
console.log('| 热路径 | 中位 | min | max | 样本 | 备注 |')
console.log('|---|---|---|---|---|---|')
for (const row of rows) {
  if (row.skipped !== undefined) {
    console.log(`| \`${row.path}\` | — | — | — | — | **SKIPPED**：${row.skipped} |`)
    continue
  }
  console.log(
    `| \`${row.path}\` | ${row.median.toFixed(3)} | ${row.min === undefined ? '—' : row.min.toFixed(3)} | ` +
      `${row.max === undefined ? '—' : row.max.toFixed(3)} | ${row.samples ?? '—'} | ${row.note ?? ''} |`,
  )
}
console.log('')
console.log('## 怎么用这张表')
console.log('')
console.log('1. **两次读数才有意义**：一次基线不说明快慢，只说明当时是多少。改动前后各跑一次，比较中位。')
console.log('2. **看 max，不只盯中位**：中位 0.3 ms 而 max 40 ms 说明偶发停顿，那是另一类问题。')
console.log('3. **SKIPPED 不是 0**：跳过说明本次没测到，写进报告时必须写「未测」，不许写「很快」。')
