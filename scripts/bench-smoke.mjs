#!/usr/bin/env node
/**
 * ── bench-smoke: 一个仓的纯函数微基准，**记录基线，不设阈值** ──────────────────────────────────
 *
 * 这个脚本永远 exit 0。它不是一个门禁，是一个**量具**：B0.5 只要求把今天的数字记下来，
 * 好让未来某一天有人能指着它说「这里慢了 3 倍」——而那个判断需要波动范围，现在还没有。
 *
 * ── 两件事它必须做到，否则它就是一个昂贵的 `console.log` ─────────────────────────────────────
 *
 *   ① 报**中位数**，不是平均值。一次 GC 或一个调度抖动就能把平均值拉走 30%，
 *      而中位数对这种长尾免疫。单次测量没有意义，所以内部重复 ROUNDS 轮，每轮 n 次，
 *      报每轮 per-call 耗时的中位数。
 *
 *   ② 自带 can-red：如果被测函数被换成空实现，中位数必须**显著更低**。
 *      没有这条，「测了一个不存在的函数」和「测了一个很快的函数」在输出上长得一样。
 *      这是「防空集恒绿」在性能测量上的对应物，和 v205/v130 的 can-red 是同一个动机。
 *
 * 用法：
 *   node scripts/bench-smoke.mjs            # 正常输出
 *   node scripts/bench-smoke.mjs --json     # 只输出一行 JSON（给别人读）
 *
 * 输出格式（固定，便于 grep 与跨仓对比）：
 *   bench-smoke: <name> median=<x>ms (n=100000)
 */

import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const N = 100_000
const ROUNDS = 7

/**
 * ── 被测目标：一个真实的纯函数 ────────────────────────────────────────────────────────────────
 *
 * `load()` 返回 { name, fn, input, sourceFile }。
 * `sourceFile` 用来在输出里带上被调代码的哈希——即使 can-red 自检没做，
 * 读的人也能核对「测的确实是那个函数」，而不是一个同名的替身。
 */
const TARGET = {
  name: 'parseIdentityMetadata',
  async load () {
    /**
     * ── 为什么换掉了第一个候选（`truncateEnd`）：can-red 自检把它否了 ─────────────────────────
     *
     * 第一版测 `utils/serialize.ts` 的 `truncateEnd`，实测 separation=1.57x / spread=673%，
     * 落在 NO-SIGNAL 区。原因不是它坏了，是它**太快**：每次调用约 6e-6 ms，
     * 与「调用一个空函数」的开销同量级，于是量具测到的主要是循环与调用开销，不是函数体。
     * 这种基线对未来的回归完全无知 —— 函数体慢 10 倍，输出也只动一点点。
     *
     * 换成 `parseIdentityMetadata`：实测 4.0e-4 ms/call（比空调用大两个数量级），
     * 每次都要构造 RegExp、匹配、JSON.parse、逐字段类型判定。工作量足够大。
     * 这正是一条 can-red 自检该起的作用：它否掉了我第一个选择，而不是让我带着一个假基线走。
     *
     * ── 为什么不从 src 直接加载 ────────────────────────────────────────────────────────────────
     * `src/core/host-shape.ts` 内部 `import ... from './constraint-shape.js'`（`.js` 扩展名），
     * Node 的 type stripping 不会把 `.js` 重写成 `.ts`，直接加载 src 会 ERR_MODULE_NOT_FOUND。
     * 所以走**构建产物** `index.js` —— 它本来是 export 的，不是我新开的口子。
     */
    const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)
    return {
      fn: mod.parseIdentityMetadata,
      input: '<!-- dsh-graft-identity: {"sourceSessionId":"session-abc123","boundarySeq":42,"generation":3,"cwd":"D:\\\\work\\\\proj","at":"2026-11-16T10:00:00.000Z"} -->\n这是随消息一起搬运的正文部分，不参与解析。',
      sourceFile: join(ROOT, 'src', 'core', 'host-shape.ts'),
    }
  },
}

/** 每轮跑 n 次，返回该轮的 per-call 毫秒数。 */
function round (fn, input, n) {
  const started = process.hrtime.bigint()
  for (let i = 0; i < n; i += 1) fn(input)
  return Number(process.hrtime.bigint() - started) / 1e6 / n
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

const fmt = (x) => {
  // per-call 很小，用科学计数会难读；保留 6 位有效数字
  if (x === 0) return '0'
  if (x < 1e-4) return x.toExponential(3)
  return x.toPrecision(6)
}

const sourceHash = (file) => {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
  } catch {
    return 'unavailable'
  }
}

const json = process.argv.includes('--json')
const log = json ? () => {} : (s) => process.stdout.write(s + '\n')

const { fn, input, sourceFile } = await TARGET.load()

if (typeof fn !== 'function') {
  // 加载不到就不是「绿」——但本脚本永远 exit 0，所以必须把这件事喊出来
  console.log(`bench-smoke: ${TARGET.name} UNAVAILABLE (the function could not be loaded; NOT a measurement)`)
  process.exit(0)
}

/* 真函数：ROUNDS 轮，取中位数 */
const realRounds = []
for (let r = 0; r < ROUNDS; r += 1) realRounds.push(round(fn, input, N))
const realMedian = median(realRounds)

/**
 * ── can-red：空实现必须更快 ────────────────────────────────────────────────────────────────────
 *
 * 这不是在测空函数，是在证明「这个量具能区分做了事和没做事」。
 * 若两者分不开（比值 ≈ 1），说明本脚本测的是**调用开销**而不是函数体，
 * 于是它对未来的回归完全无知——那种情况下输出里必须写明 NO-SIGNAL，而不是装作测到了。
 */
const emptyRounds = []
for (let r = 0; r < ROUNDS; r += 1) emptyRounds.push(round(() => {}, input, N))
const emptyMedian = median(emptyRounds)

const separation = emptyMedian === 0 ? Infinity : realMedian / emptyMedian
const hasSignal = separation >= 2

log(`bench-smoke: ${TARGET.name} median=${fmt(realMedian)}ms (n=${N})`)
log(`  rounds=${ROUNDS} real=[${realRounds.map(fmt).join(', ')}]`)
log(`  spread=${fmt(((Math.max(...realRounds) - Math.min(...realRounds)) / realMedian) * 100)}% of median`)
log(`  can-red: empty=${fmt(emptyMedian)}ms  separation=${separation === Infinity ? 'inf' : separation.toFixed(2)}x  ${hasSignal ? 'SIGNAL-OK' : 'NO-SIGNAL (the timer may be measuring call overhead, not the function body)'}`)
log(`  source: ${sourceFile.replace(ROOT, '.').replaceAll('\\\\', '/').replaceAll('\\', '/')} sha256=${sourceHash(sourceFile)}`)
log('  verdict: baseline only — NO THRESHOLD. A threshold needs a known normal range; see docs/PERF-BASELINE-2026-11-16.md')

if (json) {
  console.log(JSON.stringify({
    name: TARGET.name,
    n: N,
    rounds: ROUNDS,
    medianMs: realMedian,
    realRounds,
    emptyMedianMs: emptyMedian,
    separation,
    hasSignal,
    sourceFile,
  }))
}

// 永远 exit 0：这是量具，不是门禁
process.exit(0)
