#!/usr/bin/env node
/**
 * ── D 档「效率」：同进程 A/B 交替采样，报相对量 ──────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：删掉绝对阈值（`10.89 µs` 这种），改成
 * **同进程 A/B 交替采样的相对量**，或写明「不可测、预期 0」。
 *
 * 为什么绝对阈值是错的：它随机器、负载、Node 版本漂移，会变成一个假判据。
 * 判据只能是「搬后相对搬前变慢了多少」，而且必须**同进程、交替**采样 ——
 * 两个进程各测一半，热机状态、GC 相位、CPU 频率都不同，差值会淹没信号。
 *
 * 为什么纯位移预期 0%：搬移只换声明所在的文件，打包产物内仍是同一份代码，
 * 调用次数也不变。**没有机制**能让它变快或变慢。所以 0% 不是「碰巧测到」，是预期值；
 * 偏离 0% 说明不是纯位移（或测量本身被噪声支配）。
 *
 * 用法：
 *   node scripts/measure-efficiency.mjs --before <old-index.js> [--after <new-index.js>] \
 *        [--rounds 9] [--calls 40]
 *
 * 退出码：0 = 有数据（无论正负，结论看输出）；2 = 无法测量（缺文件/函数不在导出面）
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const beforePath = argOf('--before')
const afterPath = argOf('--after', resolve(REPO, 'index.js'))
const rounds = Number(argOf('--rounds', '9'))
const calls = Number(argOf('--calls', '40'))
const subject = argOf('--export', 'buildTape')

if (beforePath === undefined) {
  console.error('usage: node scripts/measure-efficiency.mjs --before <old-index.js> [--after index.js]')
  process.exit(2)
}
for (const p of [beforePath, afterPath]) {
  if (!existsSync(p)) {
    console.error(`cannot measure: ${p} does not exist. This is a RESOURCE condition, not a 0% result.`)
    process.exit(2)
  }
}

const before = await import(pathToFileURL(beforePath).href)
const after = await import(pathToFileURL(afterPath).href)
const fnBefore = before[subject]
const fnAfter = after[subject]
if (typeof fnBefore !== 'function' || typeof fnAfter !== 'function') {
  console.error(`cannot measure: ${subject} is not a function on both bundles (before=${typeof fnBefore}, after=${typeof fnAfter})`)
  process.exit(2)
}

/** 固定夹具：同一份日志喂给两个版本，否则测的是不同输入。 */
const { makeSourceLog } = await import(pathToFileURL(resolve(REPO, 'test/fake-harness.mjs')).href)
const log = makeSourceLog({ turns: 40 })
const boundary = { boundarySeq: log.events[log.events.length - 1].seq }

/**
 * 每个被测符号怎么调用。夹具固定，两个版本收到**同一批对象**。
 *
 * 为什么不是一律 `buildTape`：搬移的单位是一个函数族，真正要回答的是
 * 「这个族搬走之后，调用它的那条路径有没有变慢」。族本身没有 IO，所以直接测族；
 * 端到端（buildTape）只作为参考量，它的分配与 GC 噪声会把信号盖住（实测过）。
 */
const CALLERS = {
  buildTape: (fn) => () => fn(log.events, { recentTurns: 8 }, boundary, 'session-source'),
  inheritedConstraintAnchor: (fn) => () => fn(log.events, 'session-source', 3),
  extractSemanticState: (fn) => () => fn(log.events),
  extractOpenTurnCarryover: (fn) => () => fn(log.events, 'session-source'),
}
const make = CALLERS[subject]
if (make === undefined) {
  console.error(`cannot measure: no caller template for ${subject} (known: ${Object.keys(CALLERS).join(', ')})`)
  process.exit(2)
}
const runBefore = make(fnBefore)
const runAfter = make(fnAfter)

// 预热两个版本（交替），让 JIT 处于同一状态
for (let i = 0; i < 25; i += 1) { runBefore(); runAfter() }

const usPerCall = (fn) => {
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < calls; i += 1) fn()
  return Number(process.hrtime.bigint() - t0) / calls / 1000
}

/**
 * ── 丢掉「整批预热」之后的头两批样本 ──────────────────────────────────────────────────────────
 *
 * 实测：只做 25 次单调用预热时，第一批样本是 7.3 / 8.9 µs，而稳定值是 4.4 / 5.0 µs。
 * 两个版本的头一批都偏慢，但偏的幅度不同，于是**同一份代码被算出 +12.78% 的「回归」**。
 *
 * 所以预热必须按「与测量同规模的批次」做：先各跑两批 400 次并丢弃，
 * 让 JIT 进入稳态再说。这不是调参，是让仪器测它声称要测的东西。
 */
usPerCall(runBefore); usPerCall(runAfter)
usPerCall(runAfter); usPerCall(runBefore)

/**
 * ── 统计量用 min，不用中位数 ──────────────────────────────────────────────────────────────────
 *
 * 实测（同一份 bundle 当 A 和 B）：样本从 4.5 µs 到 25.4 µs，中位数算出 +19% 的「回归」。
 * 那不是代码变慢，是这台机器上有别的东西在抢 CPU —— 干扰只会让某批**变慢**，不会让 CPU-bound
 * 循环变快。所以「最快的一批」最接近真实成本，这也是 CPU 基准的通行做法。
 *
 * 中位数会同时吸收「慢批次」和「快批次」，在干扰不对称的机器上反而更不稳。
 */
const best = (xs) => Math.min(...xs)
const fmt = (x) => `${(x * 100).toFixed(2)}%`

const deltaOfBest = (a, b) => (best(b) - best(a)) / best(a)

/** 一轮采样：交替执行 A/B，顺序逐次轮换（否则「谁先跑」会系统性偏向一侧）。 */
const samplePair = () => {
  const elapsed = []
  for (let r = 0; r < rounds; r += 1) {
    if (r % 2 === 0) {
      elapsed.push(usPerCall(runBefore))
      elapsed.push(usPerCall(runAfter))
    } else {
      elapsed.push(usPerCall(runAfter))
      elapsed.push(usPerCall(runBefore))
    }
  }
  return { a: elapsed.filter((_, i) => i % 2 === 0), b: elapsed.filter((_, i) => i % 2 === 1) }
}

/**
 * ── 一轮 = 一次完整的 A/B + 一次本轮的对照 ──────────────────────────────────────────────────────
 *
 * 为什么对照也要「每轮各自做」：分辨率不是这台机器的常数，它随负载逐轮变化。
 * 用某一轮的分辨率去判另一轮的差值，等于用上一小时的天气决定现在穿什么。
 */
const runOneRound = () => {
  const { a, b } = samplePair()
  const controlA = []
  const controlB = []
  for (let r = 0; r < Math.max(6, rounds); r += 1) {
    controlA.push(usPerCall(runBefore))
    controlB.push(usPerCall(runBefore))
  }
  return {
    delta: deltaOfBest(a, b),
    control: Math.abs(deltaOfBest(controlA, controlB)),
    beforeBest: best(a),
    afterBest: best(b),
  }
}

/**
 * ── 结论必须是**多次独立运行**的产物，不是一次 ──────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：多轮独立运行 + 符号一致性 + 用**跨轮离散度**当分辨率；
 * 任一轮符号翻转即判 NOT RESOLVABLE。
 *
 * 为什么（实测证据）：同一条 A/B 连跑 4 次，得到四个不同结论 ——
 * `NOT RESOLVABLE(4.76%)` / `REGRESSION(23.83%)` / `NOT RESOLVABLE(2.96%)` / `INSTRUMENT UNFIT`。
 * 那个 23.83% 的「回归」在后三次里没有复现，它是噪声。
 *
 * 单次运行的分辨率可以小到 ±2.68%，于是噪声轻易越过阈值；而**多轮之间**的离散度才是这套测量
 * 真正的误差量级。所以三件事一起做：
 *   ① 独立重复 N 轮（各自重新采样、各自重算对照）；
 *   ② 分辨率 = 跨轮 delta 的极差（不是某一轮的自比噪声）；
 *   ③ 符号一致性：N 轮里有正有负 ⇒ 差值连方向都不稳定 ⇒ NOT RESOLVABLE。
 */
const repeats = Number(argOf('--repeat', '5'))
const observed = []
for (let i = 0; i < repeats; i += 1) observed.push(runOneRound())

const deltas = observed.map((o) => o.delta)
const median = (xs) => {
  const s = [...xs].sort((p, q) => p - q)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}
const spread = Math.max(...deltas) - Math.min(...deltas)
const signs = deltas.map((d) => (d > 0 ? '+' : d < 0 ? '−' : '0'))
const signFlip = new Set(signs).size > 1
const worstControl = Math.max(...observed.map((o) => o.control))
const med = median(deltas)

console.log(`subject        : ${subject}`)
console.log(`fixture        : ${log.events.length} events`)
console.log(`sampling       : ${rounds} rounds x ${calls} calls per independent run, alternating, order rotated`)
console.log(`independent    : ${repeats} run(s)`)
console.log('')
console.log('  run   before(us)  after(us)      delta    control')
for (let i = 0; i < observed.length; i += 1) {
  const o = observed[i]
  console.log(`  ${String(i + 1).padStart(3)}   ${o.beforeBest.toFixed(2).padStart(10)}  ${o.afterBest.toFixed(2).padStart(9)}  ${fmt(o.delta).padStart(9)}  ${fmt(o.control).padStart(9)}`)
}
console.log('')
console.log(`median delta   : ${fmt(med)}`)
console.log(`signs          : ${signs.join(' ')}   ${signFlip ? '(FLIP — the difference has no stable direction)' : '(consistent)'}`)
console.log(`resolution     : +/-${fmt(spread)}  = cross-run spread (max-min), NOT a single run's self-noise`)
console.log(`worst control  : ${fmt(worstControl)}`)
console.log('')

/**
 * ── 四档结论 ────────────────────────────────────────────────────────────────────────────────────
 *
 *   worst control > 10%            → INSTRUMENT UNFIT（exit 2）
 *   符号翻转                        → NOT RESOLVABLE（方向都不稳定，谈不上大小）
 *   |median| <= cross-run spread   → NOT RESOLVABLE（差值小于跨轮离散度）
 *   median > +10%                  → REGRESSION（exit 1）
 *   其余                            → 可分辨但在 10% 以内
 *
 * 「变快」永不作结论：纯位移没有变快的机制，报「变快」等于承认仪器在测噪声。
 */
if (worstControl > 0.10) {
  console.log(`VERDICT: INSTRUMENT UNFIT — the worst control across runs is ${fmt(worstControl)}, above 10%.`)
  console.log('         This machine cannot resolve a 10% difference right now, so no verdict is possible.')
  console.log('         Recorded as "not measurable" — NOT a pass and NOT a regression.')
  process.exit(2)
}

if (signFlip) {
  console.log(`VERDICT: NOT RESOLVABLE — the sign flips across independent runs (${signs.join(' ')}).`)
  console.log('         A difference whose direction is not stable is not a measurement of size either.')
  console.log(`         Cross-run spread +/-${fmt(spread)}. No regression claim is possible from this data.`)
} else if (Math.abs(med) <= spread) {
  console.log(`VERDICT: NOT RESOLVABLE — |${fmt(med)}| is inside the cross-run spread +/-${fmt(spread)}.`)
  console.log('         The correct reading is "no regression detected", NOT "faster" or "slower".')
} else if (med > 0.10) {
  console.log(`VERDICT: REGRESSION — median ${fmt(med)} exceeds +10% and the cross-run spread +/-${fmt(spread)}.`)
  process.exitCode = 1
} else {
  console.log(`VERDICT: outside the cross-run spread (+/-${fmt(spread)}) but inside the 10% band.`)
  console.log('         Not a regression; also not evidence of improvement — a pure move has no mechanism to be faster.')
}
