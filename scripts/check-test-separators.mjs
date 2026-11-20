#!/usr/bin/env node
/**
 * ── W1-11（B4-0b-2）：测试里禁止把 `\` 当作**拼接**分隔符（三种形态） ─────────────────────────────
 *
 * ── 名分与实质（W1-11c）────────────────────────────────────────────────────────────────────────
 *
 * 这道门禁最初的名字是「禁止手写路径分隔符」。那个名字比实现宽：实现只抓三种「**值 + 裸反斜杠**」
 * 形态，抓不到 `join(dir, 'sub\\file')` —— 那也是手写的分隔符。抓不到的原因是它**不可区分**：
 * 同样三个字符 `\\` 在 Windows 路径字面量（`'D:\\work\\demo'`）与正则（`/\\/gu`）里是合法输入，
 * 仓库现有 9 处 `\\` 全是后者，加启发式第一天就误报 9 处。
 *
 * ⇒ 说法收窄为「拼接分隔符」，边界由 `test/v273-separator-gate-behaviour.test.mjs ⑤` 钉死：
 * 断言 `join(dir, 'sub\\file')` **不**红，并写明为什么它不该红。名字说多少，实现就查多少。
 *
 * 来历（AUD-16 的第二张实物证据）：`v257` 用 `${plain}\` 表示「同一目录下的另一个名字」。在 Windows 上
 * 它是分隔符；**在 POSIX 上 `\` 是合法的文件名字符**，于是 `resolve()` 给出两个不同的字符串 ——
 * 本地永远绿，CI 的 `Test` job 红。`v257` 后来去掉了那处拼写。
 *
 * 这条判据只禁止一件事：**把 `\` 当作路径分隔符用来拼接**。它不禁止
 *   · 正则里的转义（`/\\/gu`、`\\d`）；
 *   · 字面量 Windows 路径（`'D:\\work\\demo'`）—— 那是被测输入，不是拼接；
 *   · `path.join` / `path.resolve` 的调用。
 *
 * ── 为什么是「可疑 + 白名单」而不是纯正则红线 ────────────────────────────────────────────────
 *
 * 「反斜杠出现在字符串里」这个条件太宽（上面前两类都会命中），而「恰好是路径拼接」需要类型信息。
 * 所以规则是：**匹配可疑形态，逐个登记理由**。新增可疑行必须要么改成 `path.join`，要么在
 * ALLOWED 里写清为什么它不是拼接。
 *
 * 可疑形态（见 PATTERNS）：
 *   1. 模板串里 `${…}\` 或 `\${…}` —— 把一个值和一个反斜杠贴在一起，这正是 v257 的形状；
 *   2. 单引号串里以 `\` 结尾再拼变量。
 *
 * 用法：
 *   node scripts/check-test-separators.mjs           # 判定
 *   node scripts/check-test-separators.mjs --list    # 打印全部可疑行（用于登记）
 *   node scripts/check-test-separators.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEST = join(ROOT, 'test')
const SELF = 'scripts/check-test-separators.mjs'

/**
 * The suspicious shapes. Narrow on purpose — each one means "a value and a PATH SEPARATOR are glued
 * together", which is how a separator gets written by hand instead of `path.join`.
 *
 * ── `\n` IS NOT A PATH SEPARATOR, AND THE FIRST TWO VERSIONS OF THIS FILE GOT THAT WRONG ────────
 *
 * Version 1 matched any backslash after a substitution and flagged **37 lines** — every one a `\n` inside
 * an assertion message. Version 2 tried to exclude escapes with a lookahead placed the wrong side of the
 * backslash, and flagged **787** — worse. A checker that red-flags `\n` is a checker nobody keeps.
 *
 * The precise statement: a backslash followed by a LETTER (or another backslash, or a digit / `x` / `u`)
 * is an ESCAPE. A path separator is a backslash followed by something that is not a word character — in
 * the v257 shape, by the closing backtick or the end of the fragment.
 */
const BARE_BACKSLASH = '(?<![\\\\])\\\\(?![A-Za-z0-9\\\\])'
const PATTERNS = [
  // `${x}\` — a substitution immediately followed by a BARE backslash (the v257 shape)
  { id: 'template-then-backslash', re: new RegExp(`\\$\\{[^}]*\\}${BARE_BACKSLASH}`, 'u') },
  // `\${x}` — a BARE backslash immediately before a substitution
  { id: 'backslash-then-template', re: new RegExp(`${BARE_BACKSLASH}\\$\\{`, 'u') },
  // a string ending with a BARE backslash, followed by a concatenation
  { id: 'string-concat-backslash', re: new RegExp(`'[^'\\n]*${BARE_BACKSLASH}'\\s*\\+`, 'u') },
]

/**
 * ── THE ALLOWLIST: EVERY ENTRY NEEDS A REASON ──────────────────────────────────────────────────
 *
 * Keyed by `file|patternId|occurrence` so re-indenting does not invalidate an entry but moving a NEW
 * suspicious line into the same file does. The count is per (file, pattern) and may only go DOWN.
 */
const ALLOWED = new Map()

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path, out)
      continue
    }
    if (entry.name.endsWith('.mjs')) out.push(path)
  }
  return out
}

function scan() {
  const findings = []
  for (const file of walk(TEST)) {
    const rel = relative(ROOT, file).split('\\').join('/')
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      /** A line that is entirely a comment is documentation, not code. */
      if (/^\s*(?:\/\/|\*|\/\*)/u.test(line)) continue
      for (const pattern of PATTERNS) {
        if (!pattern.re.test(line)) continue
        findings.push({ file: rel, line: index + 1, id: pattern.id, text: line.trim() })
      }
    }
  }
  return findings
}

if (process.argv.includes('--self-test')) {
  /**
   * The checker must catch the v257 shape and must NOT flag the three legitimate uses. A checker that
   * red-flags Windows path literals would be switched off within a week.
   */
  const cases = [
    { name: 'v257 shape: template then backslash', line: "const p = `${plain}\\`", expect: 'template-then-backslash' },
    { name: 'backslash then template', line: "const p = `\\${plain}`", expect: 'backslash-then-template' },
    { name: 'string concat with trailing backslash', line: "const p = 'a\\' + b", expect: 'string-concat-backslash' },
    { name: 'LEGIT: a windows path literal', line: "const cwd = 'D:\\\\work\\\\demo'", expect: undefined },
    { name: 'LEGIT: regex escape', line: 'const rel = src.replace(/\\\\/gu, "/")', expect: undefined },
    { name: 'LEGIT: path.join', line: "const p = join(dir, 'a', 'b')", expect: undefined },
  ]
  let failures = 0
  for (const testCase of cases) {
    const hit = PATTERNS.find((pattern) => pattern.re.test(testCase.line))
    const got = hit?.id
    const pass = got === testCase.expect
    if (!pass) failures += 1
    process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${testCase.name}${pass ? '' : ` (expected ${testCase.expect ?? 'none'}, got ${got ?? 'none'})`}\n`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

const findings = scan()

if (process.argv.includes('--list')) {
  for (const finding of findings) process.stdout.write(`  ${finding.file}:${finding.line}  [${finding.id}]  ${finding.text.slice(0, 100)}\n`)
  process.stdout.write(`  total: ${findings.length}\n`)
  process.exit(0)
}

const counts = new Map()
for (const finding of findings) {
  const key = `${finding.file}|${finding.id}`
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

const violations = []
for (const [key, observed] of counts) {
  const allowed = ALLOWED.get(key) ?? 0
  if (observed > allowed) violations.push({ key, observed, allowed })
}

if (violations.length > 0) {
  process.stdout.write('test-separators: FAILED — hand-written path separator(s)\n')
  for (const violation of violations) {
    const [file] = violation.key.split('|')
    process.stdout.write(`  ${violation.key}: ${violation.observed} (allowed ${violation.allowed})\n`)
    for (const finding of findings.filter((item) => `${item.file}|${item.id}` === violation.key)) {
      process.stdout.write(`    ${finding.file}:${finding.line}  ${finding.text.slice(0, 110)}\n`)
    }
  }
  process.stdout.write('\nFix: use `path.join` / `path.resolve`. A backslash is a FILENAME character on POSIX,\n')
  process.stdout.write('so `${dir}\\` names a different path there — green locally, red in CI.\n')
} else {
  process.stdout.write(`test-separators: OK — ${findings.length} suspicious line(s), all accounted for\n`)
}
process.exitCode = violations.length === 0 ? 0 : 1
void SELF
