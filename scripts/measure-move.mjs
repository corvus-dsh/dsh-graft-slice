#!/usr/bin/env node
/**
 * ── 一次搬移的尺寸，必须给出三个数，缺一不可 ──────────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：「以后所有尺寸写三口径：声明跨度和 / 切除区间 / index.ts 实测净变化。」
 *
 * 为什么必须三个：
 *
 *   ① **声明跨度和** —— 搬走的那几个声明本身占多少行（不含分隔空行、不含文档注释以外的空白）。
 *      回答「这个族有多大」。
 *   ② **切除区间** —— 从 index.ts 里实际剪掉的那一段（连续区间，可能包含声明之间的空行与文档注释）。
 *      回答「这一刀切掉了文件多少行」。
 *   ③ **index.ts 实测净变化** —— 搬前与搬后 `wc -l` 的差。它等于 ② 的删除量减去搬入的 plumbing 行
 *      （import + 裸 export），**而且必须实测**，不能拿 ① 或 ② 去加减推算。
 *
 * 三个数互不相等是正常的；只报其中一个才是问题 —— 项目里出现过「用切除区间冒充族大小」
 * 与「用声明跨度之和冒充净变化」两种混淆。
 *
 * 用法：
 *   node scripts/measure-move.mjs --from <ref> --to <ref|working> \
 *        --decl extractSemanticState --decl outcomeOfResult --decl TEST_PASS_PATTERNS
 *
 * 退出码：0 = 三个数都量到；2 = 量不到（资源/用法条件）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const IDX_REL = 'src/index.ts'

const argValues = (flag) => {
  const out = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1])
  }
  return out
}
const from = argValues('--from')[0]
const to = argValues('--to')[0] ?? 'working'
const decls = argValues('--decl')

if (from === undefined || decls.length === 0) {
  console.error('usage: node scripts/measure-move.mjs --from <ref> [--to <ref|working>] --decl <name> [--decl <name> …]')
  process.exit(2)
}

const git = (args, encoding = 'utf8') => execFileSync('git', args, { cwd: REPO, encoding, maxBuffer: 256 * 1024 * 1024 })

const fileAt = (ref) => {
  if (ref === 'working') return readFileSync(join(REPO, IDX_REL), 'utf8')
  return git(['show', `${ref}:${IDX_REL}`])
}

const wc = (text) => {
  const parts = text.replace(/\r\n/gu, '\n').split('\n')
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
}

/** 与 families.mjs 同一套判定：三种括号都参与配平；首行无开括号 ⇒ 这一行就是整条声明。 */
const spanOf = (lines, name) => {
  const re = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${name}\\b`, 'u')
  const start = lines.findIndex((l) => re.test(l))
  if (start < 0) return undefined
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const closers = new Set([')', ']', '}'])
  let depth = 0
  let opened = false
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (pairs[ch] !== undefined) { depth += 1; opened = true }
      else if (closers.has(ch)) depth -= 1
      else if (ch === ';' && !opened) return [start + 1, i + 1]
    }
    if (opened && depth === 0) return [start + 1, i + 1]
    if (!opened) return [start + 1, i + 1]
  }
  return [start + 1, lines.length]
}

const beforeText = fileAt(from)
const afterText = fileAt(to)
const beforeLines = beforeText.replace(/\r\n/gu, '\n').split('\n')
const afterLines = afterText.replace(/\r\n/gu, '\n').split('\n')

// ① 声明跨度和 —— 在**搬前**的版本上量
let spanSum = 0
const perDecl = []
for (const name of decls) {
  const span = spanOf(beforeLines, name)
  if (span === undefined) {
    console.error(`cannot measure: declaration ${name} not found in ${from}:${IDX_REL}`)
    process.exit(2)
  }
  const size = span[1] - span[0] + 1
  spanSum += size
  perDecl.push({ name, from: span[0], to: span[1], size })
}

// ② 切除区间 —— 取 src/index.ts 里删除行最多的那个 hunk 的旧区间
const diffArgs = ['diff', '-U0', from, to === 'working' ? '--' : to, IDX_REL].filter((x) => x !== '--' || to !== 'working')
const diffText = to === 'working'
  ? git(['diff', '-U0', from, '--', IDX_REL])
  : git(['diff', '-U0', from, to, '--', IDX_REL])
void diffArgs

let cut
for (const m of diffText.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gmu)) {
  const start = Number(m[1])
  const count = m[2] === undefined ? 1 : Number(m[2])
  if (cut === undefined || count > cut.count) cut = { start, count, end: start + count - 1 }
}

// ③ index.ts 实测净变化 —— 两侧各自 wc -l
const beforeWc = wc(beforeText)
const afterWc = wc(afterText)

const numstat = to === 'working'
  ? git(['diff', '--numstat', from, '--', IDX_REL])
  : git(['diff', '--numstat', from, to, '--', IDX_REL])
const [added, removed] = (numstat.trim().split(/\s+/u).slice(0, 2)).map(Number)

console.log(`move: ${from} -> ${to}`)
console.log('')
console.log('① 声明跨度和')
for (const d of perDecl) console.log(`     ${d.name.padEnd(28)} L${d.from}..L${d.to}   ${d.size} lines`)
console.log(`     sum                          ${spanSum} lines`)
console.log('')
console.log('② 切除区间（index.ts 里删除行最多的 hunk，旧侧坐标）')
if (cut === undefined) {
  console.log('     (no deletion hunk — nothing was cut)')
} else {
  console.log(`     L${cut.start}..L${cut.end}   ${cut.count} lines deleted`)
}
console.log(`     git numstat                  +${added} / -${removed}`)
console.log('')
console.log('③ index.ts 实测净变化（wc -l，两侧各量一次）')
console.log(`     ${from}: ${beforeWc}  →  ${to}: ${afterWc}   net ${afterWc - beforeWc >= 0 ? '+' : ''}${afterWc - beforeWc}`)
console.log('')
console.log('三个数互不相等是正常的：②是切掉的行数，③还包含搬入的 plumbing 行，①只算声明本身。')
