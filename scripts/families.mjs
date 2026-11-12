#!/usr/bin/env node
/**
 * ── 族划分（分量分析）────────────────────────────────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：extractGoal 搬出去后旧 12 族已失效，**必须重跑**，不能沿用旧图。
 *
 * ── 第一版写错了，这里记下来 ────────────────────────────────────────────────────────────────────
 *
 * 第一版用 `closure.mjs <name>` 取「成员之间的依赖」，但那个命令返回的是**该声明自身的闭包**
 * （对孤立函数恰好是 1 个成员 = 它自己），于是每个成员都被看成没有邻居，
 * 最终合并成 1 个「32 声明 / 1906 行」的假分量 —— 与上一轮的 13 个分量完全不符。
 *
 * 正确做法：用 `who-references.mjs` 拿到每个符号的**引用行**，再判断那一行落在哪个声明的区间里。
 * 「A 引用 B」= B 的某个引用行位于 A 的声明区间内。这是有向边，分量用无向连通。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 根目录来自 `import.meta.url`，不是写死的本机路径 —— `check-cycles.mjs` 曾在 #118 上
 * 因为写死 `D:/…` 而「本机每次过、CI 每次红」，test/v129 现在专门断言这一点。
 * 第一次写这个脚本时我也写死了，被自己新加的门禁当场抓住（families.mjs 是第一个真正
 * 命中那条正则的脚本，此前它从未匹配到任何文件，所以崩溃一直没暴露）。
 */
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/u, '')
const TARGET = process.argv[2] ?? 'buildTape'
const SRC = REPO + '/src/index.ts'

const run = (script, args) => {
  try {
    return execFileSync(process.execPath, [REPO + '/scripts/' + script, ...args], { cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

const report = run('closure.mjs', [TARGET])
const members = [...report.matchAll(/^\s+index\.ts:(\w+) \[(\w+)\]/gmu)].map((m) => ({ name: m[1], kind: m[2] }))
console.log(`${TARGET}: ${members.length} declaration(s), ${/lines\s*:\s*(\d+)/u.exec(report)?.[1]} lines`)

/** 每个声明的行区间 [start, end]（1-based）。 */
const lines = readFileSync(SRC, 'utf8').split('\n')
const spanOf = (name, kind) => {
  // 声明行：interface/type/const/function 后面跟名字；允许 export 前缀
  const kw = kind === 'InterfaceDeclaration' ? 'interface'
    : kind === 'TypeAliasDeclaration' ? 'type'
      : kind === 'FunctionDeclaration' ? 'function'
        : 'const'
  const re = new RegExp(`^(?:export\\s+)?${kw}\\s+${name}\\b`, 'u')
  const start = lines.findIndex((l) => re.test(l))
  if (start < 0) return undefined
  /**
   * 花括号配平必须容忍「签名跨行」：`export function buildTape(` 之后若干行才是 `{`。
   * 第一版在第一行没看到 `{` 就判定为单行声明，于是 buildTape 被算成 1 行 ——
   * 分量表因此把最大的那个声明当成最小的，整张表失去意义。
   * 判据改成：在遇到 `;`（语句结束）之前出现的第一个 `{` 开始配平。
   */
  let depth = 0
  let opened = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth += 1; opened = true }
      else if (ch === '}') depth -= 1
      else if (ch === ';' && !opened) return [start + 1, i + 1]
    }
    if (opened && depth === 0) return [start + 1, i + 1]
  }
  return [start + 1, lines.length]
}

const spans = new Map()
for (const m of members) {
  const span = spanOf(m.name, m.kind)
  if (span !== undefined) spans.set(m.name, span)
}

/** owner(line) → 包含该行的最内层声明。 */
const ownerOf = (line) => {
  let best
  for (const [name, [start, end]] of spans) {
    if (line < start || line > end) continue
    if (best === undefined || (end - start) < (spans.get(best)[1] - spans.get(best)[0])) best = name
  }
  return best
}

const memberSet = new Set(members.map((m) => m.name))
/**
 * ── 根节点不参与连通 ──────────────────────────────────────────────────────────────────────────
 *
 * 闭包是 `buildTape` 的**传递闭包**：它必然引用几乎每一个成员。若把根节点算进连通性，
 * 所有成员都会经由 buildTape 连成一团，得到一个「32 声明 / 1240 行」的假分量 —— 实测过一次。
 *
 * 族划分要回答的是「除了根之外，哪些成员彼此纠缠」，所以根节点被排除在连通之外；
 * 它到每一个族的边被单独记下来，作为「搬迁时根要改几处」的度量。
 */
const ROOT = TARGET
const rootsRefs = new Set()
const edges = new Map(members.map((m) => [m.name, new Set()]))
const unresolvedRefs = []
const ambiguousMembers = []

/**
 * ── AMBIGUOUS NAMES CONTRIBUTE NO EDGES ──────────────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：修的是 `who-references` 的作用域，不是这个脚本。
 *
 * 实测：族 #2 那 17 个声明之所以连成一团，是因为 12 条边都指向 `name` —— 而 `name` 在整棵树里有
 * 17 个声明点（1 个模块级 `export const name` + 16 个函数内的局部 `const name`）。
 * 对这样的名字，「引用行」无法归给某一个符号，于是任何一条由它产生的边都是编的。
 *
 * 所以这里不再自己判歧义：`who-references --json` 已经给每条 finding 标了 `ambiguous`，
 * 消费方只需跳过。**判据属于仪器，消费方不许另立一套** —— 否则两个工具会各说各话。
 */
for (const name of memberSet) {
  const raw = run('who-references.mjs', ['--json', name])
  let findings
  try {
    findings = JSON.parse(raw)
  } catch {
    console.error(`families: cannot parse who-references --json for ${name}`)
    continue
  }
  if (findings.some((f) => f.ambiguous === true)) {
    ambiguousMembers.push(name)
    continue
  }
  for (const f of findings) {
    if (f.file !== 'index.ts') continue
    if (f.kind !== 'CODE' && f.kind !== 'TYPE') continue
    const from = ownerOf(f.line)
    if (from === undefined || from === name) continue
    if (!memberSet.has(from)) continue
    if (from === ROOT) { rootsRefs.add(name); continue }
    if (name === ROOT) { rootsRefs.add(from); continue }
    edges.get(from).add(name)
    edges.get(name).add(from) // 无向连通
  }
}

if (ambiguousMembers.length > 0) {
  console.log(`AMBIGUOUS members skipped (same text, more than one declaration): ${ambiguousMembers.join(', ')}`)
  console.log('')
}

const seen = new Set()
const components = []
for (const name of memberSet) {
  if (seen.has(name)) continue
  const stack = [name]
  const comp = []
  seen.add(name)
  while (stack.length) {
    const cur = stack.pop()
    comp.push(cur)
    for (const next of edges.get(cur) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  components.push(comp)
}

const sizeOf = (name) => {
  const [s, e] = spans.get(name) ?? [0, 0]
  return e - s + 1
}

components.sort((a, b) => {
  const la = a.reduce((s, n) => s + sizeOf(n), 0)
  const lb = b.reduce((s, n) => s + sizeOf(n), 0)
  return lb - la
})

const total = members.reduce((s, m) => s + sizeOf(m.name), 0)
console.log(`\n${components.length} connected component(s), ${total} lines total\n`)
let idx = 0
for (const comp of components) {
  idx += 1
  const sum = comp.reduce((s, n) => s + sizeOf(n), 0)
  console.log(`#${idx}  ${comp.length} decl / ${sum} lines   ${comp.sort((a, b) => sizeOf(b) - sizeOf(a)).join(', ')}`)
}
if (unresolvedRefs.length) console.log(`\nunresolved refs: ${unresolvedRefs.length}`)
