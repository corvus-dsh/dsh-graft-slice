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

test('v141: the probe really exercises the classifier (a denominator)', () => {
  // If the probe file were not scanned at all, every assertion above would pass for the wrong reason
  // (kindAt would return undefined and equal nothing). Require all five findings to exist.
  const findings = runProbe()
  assert.equal(findings.length, 5, `expected five findings in the probe, got ${findings.length}: ${JSON.stringify(findings)}`)
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

  // The only genuine import/export clause is index.ts's own re-export.
  const importClauses = findings.filter((f) => f.kind === 'IMPORT')
  assert.equal(importClauses.length, 1, `expected exactly one import clause, got ${JSON.stringify(importClauses)}`)
  assert.equal(importClauses[0].file, 'index.ts')
  assert.match(importClauses[0].text, /export type \{ GraftConfig \}/u)
})
