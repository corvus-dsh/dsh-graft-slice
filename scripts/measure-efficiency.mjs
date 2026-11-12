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

const elapsed = []
for (let r = 0; r < rounds; r += 1) {
  // 交替顺序也要轮换：否则「谁先跑」会系统性偏向某一侧
  if (r % 2 === 0) {
    elapsed.push(usPerCall(runBefore))
    elapsed.push(usPerCall(runAfter))
  } else {
    elapsed.push(usPerCall(runAfter))
    elapsed.push(usPerCall(runBefore))
  }
}
const aSamples = elapsed.filter((_, i) => i % 2 === 0)
const bSamples = elapsed.filter((_, i) => i % 2 === 1)

/**
 * 对照组：同一份 bundle 和自己比。它必须接近 0；如果不接近，这套仪器在这台机器上就不成立。
 */
const controlA = []
const controlB = []
for (let r = 0; r < Math.max(6, rounds); r += 1) {
  controlA.push(usPerCall(runBefore))
  controlB.push(usPerCall(runBefore))
}
const controlDelta = Math.abs(deltaOfBest(controlA, controlB))
const delta = deltaOfBest(aSamples, bSamples)

console.log(`subject        : ${subject}`)
console.log(`fixture        : ${log.events.length} events`)
console.log(`sampling       : ${rounds} rounds x ${calls} calls, alternating, order rotated`)
console.log(`before (best)  : ${best(aSamples).toFixed(2)} µs/call`)
console.log(`after  (best)  : ${best(bSamples).toFixed(2)} µs/call`)
console.log(`delta          : ${fmt(delta)}   (min-of-samples, CPU-bound convention)`)
console.log('')
console.log(`resolution     : ±${fmt(controlDelta)}  ← this machine's measured noise floor, NOT zero`)
console.log('                 (control = the same bundle measured against itself)')
console.log('')

/**
 * ── 结论的措辞只有三档，且必须提到分辨率 ────────────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：他的机器上对照组是 7.79%，不是 0.64% —— 所以「−2.27%」的正确读法是
 * **「测不出回归」**，不是「快了 2.3%」。任何小于本机分辨率的差值都不能当结论。
 *
 * 第一版这里会输出 `FASTER by 2.26%` —— 那是把噪声说成结论。三档改成一个方向：
 *
 *   control > 10%      → INSTRUMENT UNFIT（exit 2）：连 10% 都分辨不了，任何结论都是编的
 *   |delta| <= control → NOT RESOLVABLE：差值落在分辨率里，只能说「测不出」
 *   delta > +10% 且超出 control → REGRESSION（exit 1）
 *
 * 「变快」永不作结论 —— 纯位移没有变快的机制，报「变快」等于承认仪器在测噪声。
 */
if (controlDelta > 0.10) {
  console.log(`VERDICT: INSTRUMENT UNFIT — the control deviates ${fmt(controlDelta)}, above the 10% threshold.`)
  console.log('         This machine cannot resolve a 10% difference right now, so no verdict is possible.')
  console.log('         Expected value for a pure move: 0% by construction (no code, no call count changed).')
  console.log('         Recorded as "not measurable, expected 0" — NOT a pass and NOT a regression.')
  process.exit(2)
}

if (Math.abs(delta) <= controlDelta) {
  console.log(`VERDICT: NOT RESOLVABLE — |${fmt(delta)}| is inside this machine's resolution ±${fmt(controlDelta)}.`)
  console.log('         The correct reading is "no regression detected", NOT "faster" or "slower".')
  console.log('         Expected value for a pure move: 0% by construction.')
} else if (delta > 0.10) {
  console.log(`VERDICT: REGRESSION — ${fmt(delta)} exceeds +10% AND this machine's resolution ±${fmt(controlDelta)}.`)
  process.exitCode = 1
} else {
  console.log(`VERDICT: outside the resolution (±${fmt(controlDelta)}) but inside the 10% band.`)
  console.log('         Not a regression; also not evidence of improvement — a pure move has no mechanism to be faster.')
}
