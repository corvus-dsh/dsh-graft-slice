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
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
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

/**
 * `--out <file>`：把这一轮的完整字段追加成一行 JSONL。默认 `_scratch/efficiency-runs.jsonl`。
 *
 * 为什么要落盘而不是只印在终端：终端输出会被截断、会被复制走样，而**判决的下游复核**需要原始数字。
 * 落盘的字段必须足以**独立复算** primary delta 与 spread —— 所以每轮的 beforeBest/afterBest
 * 与逐轮 delta 都要写进去，不能只写结论。
 */
const outPath = resolve(argOf('--out', join(REPO, '_scratch', 'efficiency-runs.jsonl')))

const median = (xs) => {
  const s = [...xs].sort((p, q) => p - q)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

/**
 * ── 主统计量改成「跨轮全局最小值」────────────────────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-13）：`min(beforeBest)` 对 `min(afterBest)`，median 与 spread 保留但降级为**质量指标**。
 *
 * 为什么最小值才是主统计量：每一轮的 `best` 已经是「这一轮里最快的一批」。干扰只会让某批**变慢**，
 * 不会让 CPU-bound 循环变快 —— 所以「所有轮里最快的那一批」最接近两侧各自的真实成本。
 * 逐轮 delta 里混着每一轮各自的负载，把它们平均/取中位数等于把噪声也平均进来。
 *
 * median 与 spread 不删除，因为它们是**这套测量还可不可信**的证据：
 * spread 比阈值还大，说明这台机器两次运行之间的差异超过我们想分辨的东西。
 */
export function efficiencyStats ({ beforeBests, afterBests, deltas, controls, threshold = 0.10 }) {
  const minBefore = Math.min(...beforeBests)
  const minAfter = Math.min(...afterBests)
  const delta = (minAfter - minBefore) / minBefore // ← 主统计量
  const spread = Math.max(...deltas) - Math.min(...deltas) // ← 质量指标
  const med = median(deltas) // ← 质量指标
  const signs = deltas.map((d) => (d > 0 ? '+' : d < 0 ? '−' : '0'))
  const signFlip = new Set(signs).size > 1
  const worstControl = Math.max(...controls)
  const consistent = signs.filter((s) => s === signs[0]).length

  const lines = [
    `min before     : ${(minBefore / 1).toFixed(2)} us/call   (the fastest batch across all runs)`,
    `min after      : ${(minAfter / 1).toFixed(2)} us/call`,
    `delta          : ${(delta * 100).toFixed(2)}%   (global-min statistic — the PRIMARY number)`,
    `spread         : +/-${(spread * 100).toFixed(2)}%   (cross-run, max-min — a QUALITY indicator)`,
    `median delta   : ${(med * 100).toFixed(2)}%   (quality indicator, not the verdict input)`,
    `signs          : ${signs.join(' ')}   ${signFlip ? '(FLIP)' : `(consistent ${consistent}/${signs.length})`}`,
    `worst control  : ${(worstControl * 100).toFixed(2)}%`,
  ]

  if (worstControl > threshold) {
    return {
      kind: 'INSTRUMENT_UNFIT',
      stats: { minBefore, minAfter, delta, spread, median: med, signs, worstControl, consistent },
      code: 2,
      lines: [...lines, '',
        `VERDICT: INSTRUMENT UNFIT — worst control ${(worstControl * 100).toFixed(2)}% > ${threshold * 100}%, spread ±${(spread * 100).toFixed(2)}%.`,
        '         No verdict is possible from this data — NOT a pass and NOT a regression.'],
    }
  }
  if (signFlip) {
    return {
      kind: 'NOT_RESOLVABLE_SIGN_FLIP',
      stats: { minBefore, minAfter, delta, spread, median: med, signs, worstControl, consistent },
      code: 0,
      lines: [...lines, '',
        `VERDICT: NOT RESOLVABLE — the sign flips across independent runs (${signs.join(' ')}), spread ±${(spread * 100).toFixed(2)}%.`,
        '         A difference whose direction is not stable is not a measurement of size either.'],
    }
  }
  if (delta > threshold) {
    // spread 大于阈值时，判决必须自曝「方向一致但离散度很大」，不能只给一个干净的数字。
    const qualified = spread > threshold
      ? `REGRESSION（方向一致 ${consistent}/${signs.length}，幅度 ${(delta * 100).toFixed(2)}% ± ${(spread * 100).toFixed(2)}%）`
      : `REGRESSION — ${(delta * 100).toFixed(2)}% > ${threshold * 100}%, spread ±${(spread * 100).toFixed(2)}%`
    return {
      kind: 'REGRESSION',
      stats: { minBefore, minAfter, delta, spread, median: med, signs, worstControl, consistent },
      code: 1,
      lines: [...lines, '', `VERDICT: ${qualified}`],
    }
  }
  if (Math.abs(delta) <= spread) {
    return {
      kind: 'NOT_RESOLVABLE_INSIDE_SPREAD',
      stats: { minBefore, minAfter, delta, spread, median: med, signs, worstControl, consistent },
      code: 0,
      lines: [...lines, '',
        `VERDICT: NOT RESOLVABLE — |${(delta * 100).toFixed(2)}%| is inside the cross-run spread ±${(spread * 100).toFixed(2)}%.`,
        '         The correct reading is "no regression detected", NOT "faster" or "slower".'],
    }
  }
  return {
    kind: 'UNDER_BAND_WITH_SPREAD',
    stats: { minBefore, minAfter, delta, spread, median: med, signs, worstControl, consistent },
    code: 0,
    lines: [...lines, '',
      `VERDICT: outside the cross-run spread (±${(spread * 100).toFixed(2)}%) but inside the ${threshold * 100}% band.`,
      '         Not a regression; also not evidence of improvement — a pure move has no mechanism to be faster.'],
  }
}

/**
 * ── self-test：用构造数据覆盖判决的每一种形态 ────────────────────────────────────────────────────
 *
 * 判据不能只靠「跑一次真实测量看它像不像话」来验证 —— 那样只能验证某一次的输出。
 * 这里用构造的 before/after 数字覆盖：五轮同号且 spread > 10%、符号翻转、对照超标、落在离散度内。
 */
function selfTest () {
  const cases = []

  /**
   * 用户点名要求覆盖的形态：**5 轮同号、spread > 10%**，且全局最小值显示 > 10% 的劣化。
   * 此时必须判 REGRESSION，并且判决行必须自曝「方向一致 5/5」与幅度 ± spread。
   */
  const sameSign = {
    beforeBests: [30.0, 32.0, 34.0, 36.0, 38.0],
    afterBests: [40.0, 41.0, 42.0, 43.0, 44.0],
    deltas: [0.3333, 0.2812, 0.2352, 0.1944, 0.1578], // 每轮都是正号
    controls: [0.02, 0.03, 0.01, 0.04, 0.02],
  }
  cases.push({ name: '5 runs same sign, spread > 10%', input: sameSign, expect: 'REGRESSION' })

  /**
   * 符号翻转：主统计量是一个数，但它横跨了一个方向不稳定的样本 —— 仍然判 NOT RESOLVABLE。
   */
  const flipped = {
    beforeBests: [30.0, 30.0, 30.0, 30.0, 30.0],
    afterBests: [32.0, 28.0, 33.0, 27.0, 31.0],
    deltas: [0.06, -0.06, 0.10, -0.10, 0.03],
    controls: [0.02, 0.02, 0.02, 0.02, 0.02],
  }
  cases.push({ name: 'sign flips', input: flipped, expect: 'NOT_RESOLVABLE_SIGN_FLIP' })

  /** 对照超标：这台机器这一刻连 10% 都分辨不了。 */
  const noisy = {
    beforeBests: [30.0, 30.0, 30.0, 30.0, 30.0],
    afterBests: [45.0, 45.0, 45.0, 45.0, 45.0],
    deltas: [0.5, 0.5, 0.5, 0.5, 0.5],
    controls: [0.11, 0.02, 0.02, 0.02, 0.02],
  }
  cases.push({ name: 'worst control above threshold', input: noisy, expect: 'INSTRUMENT_UNFIT' })

  /** 差值远小于跨轮离散度：方向一致也没用，量不出来。 */
  const insideSpread = {
    beforeBests: [30.0, 40.0, 50.0, 60.0, 70.0],
    afterBests: [30.3, 48.0, 55.0, 66.0, 78.0],
    deltas: [0.010, 0.200, 0.100, 0.100, 0.114], // 全为正号，但跨轮极差 19%
    controls: [0.01, 0.01, 0.01, 0.01, 0.01],
  }
  cases.push({ name: 'consistent sign, difference inside the cross-run spread', input: insideSpread, expect: 'NOT_RESOLVABLE_INSIDE_SPREAD' })

  /** 与第一例只差幅度：全局最小值没超过 10% ⇒ 不得判回归（边界守卫）。 */
  const smallSameSign = {
    beforeBests: [30.0, 32.0, 34.0, 36.0, 38.0],
    afterBests: [32.0, 34.0, 36.0, 38.0, 40.0],
    deltas: [0.0667, 0.0625, 0.0588, 0.0556, 0.0526],
    controls: [0.02, 0.02, 0.02, 0.02, 0.02],
  }
  cases.push({ name: 'consistent sign but under the band', input: smallSameSign, expect: 'UNDER_BAND_WITH_SPREAD' })

  let failures = 0
  for (const c of cases) {
    const result = efficiencyStats(c.input)
    const ok = result.kind === c.expect
    const text = result.lines.join('\n')
    const printsSpread = /spread/.test(text)
    /**
     * 契约（用户 2026-11-13 裁定）：**即使不设 spread 阈值**，主统计量也必须在
     * UNFIT / FLIP 这些「结论不成立」的形态里照常打印 —— 否则读者只看到「测不了」，
     * 拿不到任何可复核的数字。这里对**每一种**形态都断言四个主读数在场。
     */
    const printsPrimary = ['min before', 'min after', 'delta', 'spread'].every((label) => text.includes(label))
    if (!ok || !printsSpread || !printsPrimary) failures += 1
    console.log(`${ok && printsSpread && printsPrimary ? 'PASS' : 'FAIL'}  ${c.name} -> ${result.kind} (expected ${c.expect})`)
    if (!ok || !printsPrimary) console.log(result.lines.map((l) => `        ${l}`).join('\n'))
  }

  // 形态断言：spread > 10% 的 REGRESSION 必须自曝方向一致性与 ± spread
  const qualified = efficiencyStats(sameSign)
  const line = qualified.lines.find((l) => l.startsWith('VERDICT:')) ?? ''
  const hasShape = /方向一致 5\/5/u.test(line) && /±/.test(line)
  if (!hasShape) failures += 1
  console.log(`${hasShape ? 'PASS' : 'FAIL'}  spread > 10% REGRESSION discloses direction consistency and spread`)
  console.log(`      ${line}`)

  // 契约：UNFIT 与 FLIP 这两类「结论不成立」的形态也必须打印四个主读数
  for (const [name, input] of [['INSTRUMENT_UNFIT', noisy], ['NOT_RESOLVABLE_SIGN_FLIP', flipped]]) {
    const text = efficiencyStats(input).lines.join('\n')
    const printsPrimary = ['min before', 'min after', 'delta', 'spread'].every((label) => text.includes(label))
    if (!printsPrimary) failures += 1
    console.log(`${printsPrimary ? 'PASS' : 'FAIL'}  ${name} still prints the primary readings (no spread threshold needed)`)
  }

  console.log(failures === 0 ? '\nSELF-TEST PASS' : `\nSELF-TEST FAIL (${failures})`)
  return failures === 0
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1
  process.exit(process.exitCode)
}

/** ── main ─────────────────────────────────────────────────────────────────────────────────────── */
async function main () {
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

  /**
   * ── 少于 5 轮不是「更快的测量」，是「没有测量」──────────────────────────────────────────────────
   *
   * 用户裁定（2026-11-12）：`--repeat` 下限 5，否则 exit 2。
   *
   * 理由就是 B-6 的实测：单轮运行报出过 +23.83% 的假 REGRESSION。轮数不足以覆盖噪声时，
   * 输出的三档结论只是把噪声排版了一遍。所以这里**直接拒绝运行**，而不是「跑一下再标注不可信」——
   * 后者会被引用成结论，前者不会。
   */
  if (!Number.isInteger(repeats) || repeats < 5) {
    console.error(`measure-efficiency: --repeat must be an integer >= 5 (got ${argOf('--repeat', '5')}).`)
    console.error('A single run cannot tell a difference from this machine\'s noise; see B-6 in docs/backlog.')
    process.exit(2)
  }

  const observed = []
  for (let i = 0; i < repeats; i += 1) observed.push(runOneRound())

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

  const verdict = efficiencyStats({
    beforeBests: observed.map((o) => o.beforeBest),
    afterBests: observed.map((o) => o.afterBest),
    deltas: observed.map((o) => o.delta),
    controls: observed.map((o) => o.control),
  })
  for (const line of verdict.lines) console.log(line)

  const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
  const record = {
    tool: 'measure-efficiency',
    recordedAt: new Date().toISOString(),
    subject,
    fixtureEvents: log.events.length,
    sampling: { rounds, calls, repeats },
    bundles: {
      before: { path: beforePath, sha256: sha256Of(beforePath) },
      after: { path: afterPath, sha256: sha256Of(afterPath) },
    },
    // 每轮的原始读数 —— 只有它们能让下游独立复算；结论本身不构成证据
    runs: observed.map((o) => ({ beforeBest: o.beforeBest, afterBest: o.afterBest, delta: o.delta, control: o.control })),
    primary: {
      statistic: 'min(beforeBest) vs min(afterBest)',
      minBefore: verdict.stats.minBefore,
      minAfter: verdict.stats.minAfter,
      delta: verdict.stats.delta,
    },
    quality: {
      spread: verdict.stats.spread,
      medianDelta: verdict.stats.median,
      worstControl: verdict.stats.worstControl,
      signs: verdict.stats.signs,
      consistent: verdict.stats.consistent,
    },
    verdict: { kind: verdict.kind, code: verdict.code },
  }
  mkdirSync(dirname(outPath), { recursive: true })
  appendFileSync(outPath, `${JSON.stringify(record)}\n`, 'utf8')
  console.log('')
  console.log(`recorded       : ${outPath}  (one JSONL line, recomputable)`)

  process.exitCode = verdict.code

}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) await main()
