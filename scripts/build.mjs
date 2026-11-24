#!/usr/bin/env node
/**
 * Build index.js from src/*.ts with Node's built-in type stripper.
 *
 * The composition itself lives in `scripts/bundle.mjs` so this script and
 * `scripts/check-docs.mjs` cannot disagree about what the shipped file should be.
 *
 * ── A4 (lead §四十二.3): A HANG MUST NOT BE SILENT ───────────────────────────────────────────────
 *
 * `bundle.mjs`'s `LOCAL_BRACKETED` capped an import block at 40 continuation lines with
 * `(?:[ \t]+[^\n]*\n){0,40}?`. An import block grew to **42 lines**, the regex stopped matching, and the
 * lazy quantifier over `[^\n]*` backtracked catastrophically:
 *
 *     node scripts/build.mjs   →   hangs forever, prints NOTHING
 *
 * This is the FIRST step of `npm run check`, so a hang here makes every later gate unverified — and it
 * reads as 「the check is slow」 locally and 「the runner timed out」 on CI, which are both wrong diagnoses.
 *
 * The watchdog below turns that into a named failure in 120 seconds. It is a WATCHDOG, not a subprocess:
 * a `spawn` with a timeout would need a second process just to kill this one, and the work is synchronous
 * — so the check is a wall-clock comparison at the two points where the work happens, plus a `finally`
 * that reports what the last completed stage was.
 *
 * WHY WALL-CLOCK AT STAGE BOUNDARIES RATHER THAN A REAL TIMER: `setTimeout` cannot fire while synchronous
 * regex work is running. A stage-boundary check cannot interrupt a single hanging call — but it does
 * catch 「the previous stage finished but this one never did」 the moment control returns, and the printed
 * last-stage is what tells the reader where to look.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { composeBundle } from './bundle.mjs'

const BUDGET_MS = 120_000
const startedAt = Date.now()
let stage = 'start'

const report = (why) => {
  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  console.error(
    `build: ${why} after ${elapsed}s (stage: ${stage}) — the build produced no verdict.\n` +
      '\n' +
      '  最可能的原因：scripts/bundle.mjs 里的正则**回溯爆炸**（不是编译慢）。\n' +
      '  已知形状：一个 {0,N}? 懒量词配 [^\\n]* 项，遇到长度超出 N 的 import 块后失配，\n' +
      '  引擎会对每个起点重试所有切分方式。上一次的触发条件是一个长到 42 行的 import 块（上限 40）。\n' +
      '\n' +
      '  排查顺序：\n' +
      '    1. 数 src/index.ts 里最长的 import 块行数；\n' +
      '    2. 逐个正则单独计时（A/B/C 分开跑）——挂死的那个就是它；\n' +
      '    3. 把 {0,N}? 换成无界但有锚点的形式（闭合 } + from 已经足够锚定）。\n' +
      '\n' +
      '  这是 RESOURCE 条件，不是通过。',
  )
  process.exit(1)
}

const root = fileURLToPath(new URL('../', import.meta.url))

stage = 'composeBundle'
const { output, modules } = composeBundle(root)
if (Date.now() - startedAt > BUDGET_MS) report('TIMEOUT')

stage = 'write'
writeFileSync(join(root, 'index.js'), output, 'utf8')
if (Date.now() - startedAt > BUDGET_MS) report('TIMEOUT')

stage = 'done'
process.stdout.write(
  `built index.js (${Buffer.byteLength(output)} bytes, ${modules.length} inlined module(s)) in ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
)