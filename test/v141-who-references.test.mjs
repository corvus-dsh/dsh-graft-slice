/**
 * ── v141: 「字符串里的名字不是引用」，但「模板插值里的表达式是」 ──────────────────────────────────
 *
 * 用户在审查 who-references.mjs 时提出：`${GraftSource}` 应归 CODE 还是 PROSE？
 * 若归 PROSE 就是**反向漏报** —— 它真的被当代码用了，却被说成只是提到。漏报比误报更危险，
 * 因为误报会有人去查，漏报不会。
 *
 * 当场用探针测了三种形态，结果第一版**全部错**：
 *
 *   'GraftSource'              普通字符串        → 实际 CODE（错，应 PROSE）
 *   `type=${GraftSource}`      模板**插值**      → 实际 CODE（对，但**是碰巧**）
 *   `type=GraftSource`         模板**文本**      → 实际 CODE（错，应 PROSE）
 *
 * 根因：splitProse 只处理 `//` 注释，**根本没处理字符串字面量**。所以 (b) 的「对」不是设计，
 * 是「什么都没做所以没搞错」。
 *
 * 修法：splitProse 改为跟踪跨行的引号状态，模板里的 `${ … }` 拷进 CODE 半（并跟踪花括号嵌套，
 * 因为 `${a ? \`${b}\` : c}` 会嵌套）。本测试钉住三种形态 + 嵌套插值 + 转义引号。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'who-references.mjs')
const CALIBRATION = join(ROOT, 'scripts', 'calibrate-who-references.mjs')
const PROBE = join(ROOT, 'src', 'core', '__v141-probe.ts')

const PROBE_SOURCE = [
  'export function probeStringLiteral(): string {',
  "  return 'GraftSource'",
  '}',
  '',
  'export function probeInterpolation(): string {',
  '  return `type=${GraftSource}`',
  '}',
  '',
  'export function probeTemplateText(): string {',
  '  return `type=GraftSource`',
  '}',
  '',
  'export function probeNested(): string {',
  '  return `a=${1 ? `${GraftSource}` : 0}`',
  '}',
  '',
  'export function probeEscapedQuote(): string {',
  '  return "it\'s GraftSource here"',
  '}',
  '',
  /**
   * ── QUOTES INSIDE A REGEX LITERAL ARE REGEX CHARACTERS ──────────────────────────────────────────
   *
   * Measured on the real tree: `/[{}[\\]"]/u` (host-shape.ts:336) and `matchAll(/…[^\\s"'`,;)|&]+/gu)`
   * (command-guard.ts) each contain a quote. The scanner read that quote as a string opener, the
   * string never closed on the line (a regex cannot span lines), and every following line was filed
   * PROSE until an accidental matching quote much later — a whole REGION misclassified, so real
   * callers disappeared. Under-reporting is the dangerous direction: "no caller" reads as "safe to
   * move".
   */
  'export function probeRegexWithQuote(): boolean {',
  '  return /[{}"]/u.test(GraftSource.value)',
  '}',
  '',
  /**
   * ── `//` ENDS AT THE END OF ITS OWN LINE ────────────────────────────────────────────────────────
   *
   * Measured on the real tree: a `//` line carried its state into the NEXT line, so the `/**` opening
   * a block comment was swallowed. The comment body was then scanned as code, the apostrophe in
   * "the target's constraints" opened a string, and index.ts:9936 — a real `sessionTitleForGoal` call —
   * came back PROSE. A line comment cannot outlive its line.
   */
  '// a trailing comment mentioning GraftSource must not swallow the NEXT line',
  '/**',
  " * the next line's apostrophe in a word like it's must not open a string — GraftSource here is prose",
  ' */',
  'export function probeAfterLineComment (): number {',
  '  return GraftSource.value',
  '}',
  '',
  /**
   * ── A NAME WITH TWO DECLARATIONS IS NOT ONE SYMBOL ─────────────────────────────────────────────
   *
   * Measured on the real tree: `families.mjs` glued 17 declarations into ONE component, and all
   * twelve gluing edges pointed at `name` — the plugin constant `export const name` — while every
   * actual reference was to a shadowing local `const name` inside a function. A text matcher cannot
   * tell those apart, so the tool must refuse to count: a name with more than one declaration site
   * is AMBIGUOUS and excluded, and the exclusion is printed.
   */
  'export const ShadowSymbol = 1',
  'export function probeShadowing(): number {',
  '  const ShadowSymbol = 2',
  '  return ShadowSymbol',
  '}',
  '',
].join('\n')

const runProbe = () => {
  writeFileSync(PROBE, PROBE_SOURCE, 'utf8')
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--json', 'GraftSource'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return JSON.parse(out).filter((f) => f.file === 'core/__v141-probe.ts')
  } finally {
    unlinkSync(PROBE)
  }
}

test('v141: a name inside a STRING is prose, a name inside ${…} is code', () => {
  const findings = runProbe()
  const kindAt = (line) => findings.filter((f) => f.line === line).map((f) => f.kind)[0]

  assert.equal(kindAt(2), 'PROSE', "a name in a string literal is not a reference: return 'GraftSource'")
  assert.equal(kindAt(6), 'CODE', 'a name in a template INTERPOLATION is an expression: `${GraftSource}`')
  assert.equal(kindAt(10), 'PROSE', 'a name in template TEXT is not a reference: `type=GraftSource`')
})

test('v141: nested interpolation stays code, and an escaped quote does not end the string early', () => {
  const findings = runProbe()
  const kindAt = (line) => findings.filter((f) => f.line === line).map((f) => f.kind)[0]

  // `${1 ? `${GraftSource}` : 0}` — the inner interpolation is still an expression
  assert.equal(kindAt(14), 'CODE', 'nested interpolation must remain code')

  // "it\'s GraftSource here" — the backslash must not terminate the string at the apostrophe
  assert.equal(kindAt(18), 'PROSE', 'an escaped quote must not leak the rest of the line into code')
})

test('v141: a quote inside a REGEX literal does not open a string (it used to eat a whole region)', () => {
  const findings = runProbe()
  const kindAt = (line) => findings.filter((f) => f.line === line).map((f) => f.kind)[0]

  // `return /[{}"]/u.test(GraftSource.value)` — the `"` is a regex character, the reference is real
  assert.equal(kindAt(22), 'CODE', 'a name after a regex literal containing a quote is still a reference')
})

test('v141: `//` ends at its own line and must not swallow the `/**` on the next line', () => {
  const findings = runProbe()
  const kindAt = (line) => findings.filter((f) => f.line === line).map((f) => f.kind)[0]

  // the prose mention in the line comment itself
  assert.equal(kindAt(25), 'PROSE', 'the line comment is prose')
  // the block comment body that follows must be PROSE, not code (its apostrophe is not a string opener)
  assert.equal(kindAt(27), 'PROSE', "the apostrophe in \"it's\" inside a block comment must not open a string")
  // and the code after that comment must still be recognised as a reference
  assert.equal(kindAt(30), 'CODE', 'code after an apostrophe-bearing block comment is still code')
})

test('v141: the probe really exercises the classifier (a denominator)', () => {
  /**
   * If the probe file were not scanned at all, every assertion above would pass for the wrong reason
   * (kindAt would return undefined and equal nothing). Require every synthetic finding to exist.
   *
   * Measured: NINE findings, not the eight I first asserted. My count came from "synthetic cases I
   * wrote" (8), but the block-comment body now names the symbol too, so it is its own finding. Counting
   * expected findings by arithmetic over intent rather than by MEASURING the probe is the same mistake
   * this project keeps catching — so the number below is the measured one.
   */
  const findings = runProbe()
  assert.equal(findings.length, 9, `expected nine findings in the probe, got ${findings.length}: ${JSON.stringify(findings)}`)
})

test('v141: a name with more than one declaration is AMBIGUOUS — excluded, printed, and never counted', () => {
  /**
   * ── 实测到的根问题：同一段文本在不同作用域里是不同的符号 ────────────────────────────────────────
   *
   * `families.mjs` 曾把 `buildTape` 的 17 个声明连成一个分量，12 条边全部指向 `name`
   * （插件常量 `export const name`），而每一条「引用」其实都是被遮蔽的局部 `const name`。
   *
   * 这个工具按 `\bname\b` 匹配行，不可能解析绑定。所以判据必须是：**同名多声明 ⇒ 不计数**，
   * 并且剔除清单必须打印出来（与这个仓库其他所有剔除同一条规则）。
   */
  writeFileSync(PROBE, PROBE_SOURCE, 'utf8')
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--json', 'ShadowSymbol'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const findings = JSON.parse(out).filter((f) => f.file === 'core/__v141-probe.ts')

    assert.ok(findings.length > 0, 'the shadowing probe must produce findings, else this test proves nothing')
    assert.ok(findings.every((f) => f.ambiguous === true),
      'EVERY finding for a doubly-declared name must carry ambiguous:true — the JSON consumer is ' +
      'families.mjs, so a guard that only exists in the human output is not a guard')

    const decls = findings.filter((f) => f.kind === 'DECL')
    assert.equal(decls.length, 2, `expected two declaration sites, got ${decls.length}`)
    assert.equal(decls.filter((d) => d.nested === false).length, 1, 'exactly one declaration is module-level')
    assert.equal(decls.filter((d) => d.nested === true).length, 1, 'exactly one declaration is nested (the shadow)')

    // and the human-readable mode must PRINT the exclusion rather than silently subtracting
    const human = execFileSync(process.execPath, [SCRIPT, 'ShadowSymbol'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    assert.match(human, /AMBIGUOUS/u, 'the exclusion must be announced')
    assert.match(human, /ShadowSymbol/u, 'the exclusion must name the symbol')
    assert.match(human, /nested — shadows/u, 'the report must distinguish the shadowing declaration')
    assert.match(human, /EXCLUDED/u, 'the reference count must say EXCLUDED, not print a number')
  } finally {
    unlinkSync(PROBE)
  }
})

test('v141: the CALIBRATION baseline passes — run it before trusting any answer from this tool', () => {
  /**
   * ── 用户硬要求（2026-11-12）：这个工具已经在同一个位置错过五次 ──────────────────────────────────
   *
   *   1. 子串匹配（GraftSource 命中 GraftSourceShape / pendingGraftSources）
   *   2. 完全不处理字符串字面量
   *   3. 不认正则字面量（引号开了字符串，污染整个区域）
   *   4. `//` 状态跨行（吞掉下一行的 /​** ，150 行错判）
   *   5. `--code` 明细静默截断 40 行
   *
   * 五次全部错向「少报」。而少报在这个项目里的后果不是「少查一次」：
   * **C2「生产调用者 = 0」是搬移许可的核心证据** —— 少报一个，就把还有依赖的东西当孤儿搬走。
   *
   * 所以这里不放「注意小心」的注释，放一份已知答案的样本（scripts/calibrate-who-references.mjs）：
   * N = 5 条真实引用，覆盖普通调用 / 模板插值 / 正则含引号三种形态 + `//` 紧邻 `/**` 的跨行样本
   * + 一条子串邻居必须不命中的反向样本。
   *
   * 三条历史回归都实测能红（注入后立刻失败）：
   *   去掉正则分支 → CODE 5→2，第 23 行误判 PROSE
   *   `//` 状态跨行 → CODE 5→3，4 行错判
   *   去掉 \b 边界 → CODE 5→6，子串邻居被算成引用
   */
  const output = execFileSync(process.execPath, [CALIBRATION], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.match(output, /CALIBRATION PASS/u, `the calibration baseline must pass; got:\n${output}`)
  assert.match(output, /5 code reference\(s\)/u, 'the known answer is 5 real references (N >= 3, three shapes)')
})

test('v141: on the real tree, a known prose-only mention is classified as prose', () => {
  /**
   * `watermark.ts` says: "Declared structurally instead of importing `GraftConfig` from index.ts".
   * That is PROSE — and it is the sentence this whole subject started from (C2 once counted it as a
   * caller). Pinning it here means the classifier is checked against reality, not only a synthetic file.
   *
   * The word "importing" inside that comment is also why the classifier must run on PROSE and CODE
   * separately: a line that SAYS "importing X" is not an import of X.
   */
  const out = execFileSync(process.execPath, [SCRIPT, '--json', 'GraftConfig'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const findings = JSON.parse(out)
  const proseInWatermark = findings.filter((f) => f.file === 'core/watermark.ts' && f.kind === 'PROSE')
  assert.ok(proseInWatermark.length > 0, 'the watermark comment must be classified PROSE')

  /**
   * And `export` is not `import`. Measured: `export function apply(ctx, config: GraftConfig)` used to
   * be classified IMPORT because the line starts with `export`. It is a SIGNATURE (TYPE position).
   */
  const signatureAsImport = findings.filter((f) => f.kind === 'IMPORT'
    && /function\s+\w+\s*\(/u.test(f.text))
  assert.deepEqual(signatureAsImport, [],
    'a function signature naming the symbol is a TYPE use, never an IMPORT')

  /**
   * Every import clause must be a REAL clause, and the re-export must be among them.
   *
   * ── WHY THIS IS NOT `assert.equal(importClauses.length, 1)` ANY MORE ──────────────────────────
   *
   * The count was 1 when it was written: `core/` imported nothing from `index.ts`, so the single
   * clause in the tree was index.ts's own `export type { GraftConfig } from`. That count was a
   * measurement of a defect, not of the classifier — `index.ts` named `GraftConfig` 18 times without
   * importing it, which is exactly what `tsc --noEmit` reported as code 2304. Repairing that added
   * `import { GraftConfig } from './core/graft-config.js'`, and the hard-coded 1 went red BECAUSE the
   * code got better.
   *
   * The invariant that actually matters is: an IMPORT finding must be a binding clause, never a
   * signature (asserted above), and the re-export must still be recognised. Both survive repair.
   */
  const importClauses = findings.filter((f) => f.kind === 'IMPORT')
  const reExport = importClauses.filter((f) => /^export\s+type\s*\{[^}]*\bGraftConfig\b/u.test(f.text))
  assert.equal(reExport.length, 1,
    `the re-export clause must be recognised exactly once, got ${JSON.stringify(importClauses)}`)
  assert.equal(reExport[0].file, 'index.ts')
  assert.match(reExport[0].text, /export type \{ GraftConfig \}/u)

  // and every other clause must genuinely be a binding clause, not a signature or a declaration
  for (const clause of importClauses) {
    assert.match(clause.text, /^(?:import|export)\b/u,
      `an IMPORT finding must start with import/export: ${JSON.stringify(clause)}`)
  }
})
