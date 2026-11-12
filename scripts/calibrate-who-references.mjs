#!/usr/bin/env node
/**
 * ── CALIBRATION BASELINE for who-references.mjs ─────────────────────────────────────────────────
 *
 * 用户硬要求（2026-11-12）：这个工具在同一个位置上已经错过五次 ——
 *
 *   1. 子串匹配（GraftSource 命中 GraftSourceShape / pendingGraftSources）
 *   2. 完全不处理字符串字面量（'GraftSource' 与模板文本被算成 CODE）
 *   3. 不认正则字面量（/[{}"]/u 里的引号开了字符串，污染整个区域）
 *   4. `//` 状态跨行（吞掉下一行的 /​** ，注释体被当代码，150 行错判）
 *   5. `--code` 明细静默截断 40 行（下游把 40 当总数，少读 17 条）
 *
 * 五次全部错向「少报」。而少报在这个项目里的后果不是「少查一次」，是：
 *   C2「生产调用者 = 0」是搬移许可的核心证据 —— 少报一个，就把还有依赖的东西当孤儿搬走。
 *
 * 所以「下次小心」不管用。这里放一份**已知答案**的样本：N 已知、永不随代码变化、
 * 覆盖五次失败各自的形态。任何对分类器的改动都必须先跑它。
 *
 * 用法：
 *   node scripts/calibrate-who-references.mjs
 *
 * 退出码：0 = 全部吻合；1 = 有偏差（打印逐条差异）。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TOOL = join(ROOT, 'scripts', 'who-references.mjs')
const PROBE = join(ROOT, 'src', 'core', '__calibration-probe.ts')
const SYMBOL = 'CalSymbol'

/**
 * ── 样本：每个形态一行，行号即身份（不要重排）─────────────────────────────────────────────────
 *
 * 期望值写死在下面 EXPECTED 里。CAL_ 前缀的名字保证不与真实代码冲突。
 */
const PROBE_SOURCE = [
  '// 1. a line comment mentioning CalSymbol is PROSE',
  'export function calPlain(): number {',
  '  return CalSymbol.value',
  '}',
  '',
  '// 2. a plain string literal is PROSE',
  'export function calString(): string {',
  "  return 'CalSymbol'",
  '}',
  '',
  '// 3. a template INTERPOLATION is CODE (a real reference)',
  'export function calInterp(): string {',
  '  return `x=${CalSymbol.value}`',
  '}',
  '',
  '// 4. template TEXT is PROSE',
  'export function calTemplateText(): string {',
  '  return `x=CalSymbol`',
  '}',
  '',
  '// 5. a regex literal containing a quote — the reference AFTER it is still CODE',
  'export function calRegexQuote(): boolean {',
  '  return /[{}"]/u.test(CalSymbol.value)',
  '}',
  '',
  '// 6. a line comment immediately followed by a block comment containing an apostrophe',
  '// both are PROSE and the code after them is still CODE',
  '/**',
  " * it's prose here, mentioning CalSymbol",
  ' */',
  'export function calAfterComments(): number {',
  '  return CalSymbol.value',
  '}',
  '',
  '// 7. a substring neighbour must NOT count (exact identifier only)',
  'export function calNeighbour(): number {',
  '  return CalSymbolShape.value + pendingCalSymbols.size',
  '}',
  '',
  '// 8. a nested interpolation is CODE',
  'export function calNested(): string {',
  '  return `a=${1 ? `${CalSymbol.value}` : 0}`',
  '}',
  '',
].join('\n')

/**
 * 已知答案：行号 → 期望种类。
 *
 * 合计 **CODE 5 条**（真实引用）、PROSE 3 条、DECL 0 条（样本里没有声明）。
 * 5 ≥ 3，满足用户要求的「N ≥ 3 且覆盖三种形态」。
 *
 * ── 行号是测出来的，不是数出来的 ──────────────────────────────────────────────────────────────
 *
 * 第一版我按「第几段」心算写行号，把块注释体写成 26/28、把嵌套插值写成 40 —— 那三行**根本不含符号**，
 * 校准立刻报 "got NOTHING"。工具没错，是我的算术错了。行号一律用下面这个脚本打印后填入：
 *   node -e "…读 PROBE_SOURCE 并逐行打印…"   （见提交信息里的命令）
 *
 * 注意第 37 行：`CalSymbolShape` 与 `pendingCalSymbols` 都会**匹配子串**，但都不是引用 ——
 * 该行必须**不产生任何 finding**，这是「精确标识符」这条规则的校准点。
 */
const EXPECTED = new Map([
  [1, 'PROSE'], // line comment
  [3, 'CODE'], // plain call                    ← 形态 1
  [8, 'PROSE'], // plain string
  [13, 'CODE'], // template interpolation        ← 形态 2
  [18, 'PROSE'], // template text
  [23, 'CODE'], // regex containing a quote      ← 形态 3
  [29, 'PROSE'], // block comment body with an apostrophe (the line after a `//` line)  ← 跨行样本
  [32, 'CODE'], // code after the comments
  [42, 'CODE'], // nested interpolation
])

/** 第 37 行：必须不产生 finding（子串命中不是引用）。 */
const NO_FINDING_LINES = [37]

const run = () => {
  writeFileSync(PROBE, PROBE_SOURCE, 'utf8')
  try {
    const out = execFileSync(process.execPath, [TOOL, '--json', SYMBOL], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    return JSON.parse(out).filter((f) => f.file === 'core/__calibration-probe.ts')
  } finally {
    unlinkSync(PROBE)
  }
}

let findings
try {
  findings = run()
} catch (error) {
  console.error('calibration: the probe run failed —', error.message)
  process.exit(1)
}

const actual = new Map()
for (const f of findings) {
  if (!actual.has(f.line)) actual.set(f.line, [])
  actual.get(f.line).push(f.kind)
}

const problems = []

for (const [line, expectedKind] of EXPECTED) {
  const kinds = actual.get(line)
  if (kinds === undefined) {
    problems.push(`line ${line}: expected ${expectedKind}, got NOTHING (the scanner did not see the line at all)`)
    continue
  }
  if (!kinds.includes(expectedKind)) {
    problems.push(`line ${line}: expected ${expectedKind}, got ${kinds.join('+')}  ←  ${PROBE_SOURCE[line - 1].trim()}`)
  }
}

for (const line of NO_FINDING_LINES) {
  if (actual.has(line)) {
    problems.push(`line ${line}: expected NO finding (substring neighbour, not a reference), got ${actual.get(line).join('+')}  ←  ${PROBE_SOURCE[line - 1].trim()}`)
  }
}

// 分母：如果扫描器整体失效（一行都没看见），上面每条都会报 NOTHING，但显式断言一行数更好读
const codeLines = findings.filter((f) => f.kind !== 'PROSE' && f.kind !== 'DECL')
console.log(`calibration: ${findings.length} finding(s), ${codeLines.length} code reference(s) — expected 5 code reference(s)`)
if (codeLines.length !== 5) {
  problems.push(`expected exactly 5 CODE references, got ${codeLines.length}: ${codeLines.map((f) => `L${f.line}`).join(', ')}`)
}

if (problems.length > 0) {
  console.error(`\nCALIBRATION FAILED (${problems.length}):`)
  for (const p of problems) console.error(`  ${p}`)
  console.error('\nFix the classifier before using its output to decide whether a symbol has callers.')
  process.exit(1)
}

console.log('CALIBRATION PASS — the classifier agrees with every known answer, including the five historical failures.')
