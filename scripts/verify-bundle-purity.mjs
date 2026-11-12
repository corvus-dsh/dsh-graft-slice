#!/usr/bin/env node
/**
 * ── bundle 纯度：一次搬移有没有改变产物里的**代码** ──────────────────────────────────────────────
 *
 * 比「行数变化」强的判据。行数变化无法区分「搬位置」与「改代码」，而多重集相同能证明：
 * **没有一行代码被增删或改写，只有位置变了。**
 *
 * 判据与 verify-pure-move 同源（同一套归一：行注释/块注释剥离、`export function f` → `function f`、
 * 裸 re-export 排除），只是作用在打包产物而不是 src/。
 *
 * 实测教训（两次，都造成假报告）：
 *   1. 不做 `export function` → `function` 归一，会把一次纯搬移报成「3 行代码被改写」——
 *      因为搬移把 inline export 改成了裸 `export { f }`，那是 plumbing。
 *   2. 提取产物时用 PowerShell 的 `>` 会写成 UTF-16LE，读成 utf8 后每个字符间夹一个 NUL，
 *      行数变成 18,807 这种假数字。所以本脚本用 `git show` 取原始字节，不经 shell 重定向。
 *
 * 用法：
 *   node scripts/verify-bundle-purity.mjs --before <ref> [--after <ref>]
 *   （--before 省略时与 HEAD 比；--after 省略时用工作树的 index.js）
 *
 * 退出码：0 = PURE；1 = NOT PURE；2 = 无法测量（资源条件）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

const argOf = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const beforeRef = argOf('--before')
const afterRef = argOf('--after') ?? 'HEAD'
if (beforeRef === undefined) {
  console.error('usage: node scripts/verify-bundle-purity.mjs --before <ref> [--after <ref>]')
  process.exit(2)
}

const bundleAt = (ref) => {
  try {
    return execFileSync('git', ['show', `${ref}:index.js`], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch {
    return undefined
  }
}

const before = bundleAt(beforeRef)
const after = bundleAt(afterRef)
if (before === undefined || after === undefined) {
  console.error(`cannot measure: index.js missing at ${before === undefined ? beforeRef : afterRef} (a resource condition, not PURE)`)
  process.exit(2)
}
if (before === after) {
  console.error(`VACUOUS — index.js is byte-identical at ${beforeRef} and ${afterRef}; nothing to compare.`)
  process.exit(2)
}

function normalise (line) {
  const stripped = line.replace(/^(\s*)export\s+(?=(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\b)/u, '$1')
  return stripped.replace(/\s+/gu, ' ').trim()
}

function codeLines (text) {
  const out = []
  let inBlock = false
  for (const raw of text.replace(/\r\n/gu, '\n').split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    line = line.replace(/\/\*[\s\S]*?\*\//gu, '')
    const openBlock = line.indexOf('/*')
    if (openBlock >= 0) {
      line = line.slice(0, openBlock)
      inBlock = true
    }
    const lineComment = line.indexOf('//')
    if (lineComment >= 0) line = line.slice(0, lineComment)
    if (/^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*)/u.test(line)) continue
    const norm = normalise(line)
    if (norm !== '') out.push(norm)
  }
  return out
}

const multiset = (lines) => {
  const m = new Map()
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
  return m
}

const a = multiset(codeLines(before))
const b = multiset(codeLines(after))
const keys = new Set([...a.keys(), ...b.keys()])
const diffs = []
for (const k of keys) {
  const x = a.get(k) ?? 0
  const y = b.get(k) ?? 0
  if (x !== y) diffs.push({ line: k, before: x, after: y })
}
diffs.sort((p, q) => (q.after - q.before) - (p.after - p.before) || p.line.localeCompare(q.line))

const total = (m) => [...m.values()].reduce((s, n) => s + n, 0)
console.log(`before : ${beforeRef}   code lines: ${total(a)}`)
console.log(`after  : ${afterRef}   code lines: ${total(b)}`)
console.log(`bundle : ${before.length} -> ${after.length} bytes`)
console.log('')

if (diffs.length === 0) {
  console.log('BUNDLE PURE — the multiset of code lines is unchanged; only position/order moved.')
  process.exit(0)
}

console.log(`BUNDLE NOT PURE — ${diffs.length} distinct line(s) differ:`)
for (const d of diffs.slice(0, 20)) console.log(`  ${d.before} -> ${d.after}   ${JSON.stringify(d.line.slice(0, 110))}`)
if (diffs.length > 20) console.log(`  … and ${diffs.length - 20} more`)
process.exit(1)
