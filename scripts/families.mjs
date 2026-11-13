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
/**
 * ── 成员正则的 `(\w+)` 会漏掉 `let/var` —— 同一个缺陷在 observer 上已经咬过一次 ────────────────
 *
 * `closure.mjs` 打印的 kind 里有 `[let/var]`，而这里原来写 `\[(\w+)\]`：`/` **不是** `\w`，
 * 于是模块级 `let` 被**整条丢弃** —— 既不进成员表，也不进跨度求和。
 *
 * **本仓（graft-slice）当前没暴露**：`buildTape` 的闭包里 `mutable` 是空（实测），
 * 一个模块级 `let` 都没有，所以正则匹配不到任何东西也没有代价。
 * 但这不是"修好了"，是"恰好没有输入"。observer 那边同时有 `FollowTransferResult` 多算 1 行，
 * 两个方向相反的缺陷相抵成「差 1」，于是它伪装成了「一点空行」——查了很久才拆开。
 *
 * 修法：kind 允许 `let/var`（`[\w/]+`），并由 `spanOf` 认出这个 kind（见下）。
 * 这不是为了本仓的今天，是为了本仓**将来出现模块级 `let` 时**不再重现同一个差 1。
 */
const members = [...report.matchAll(/^\s+index\.ts:(\w+) \[([\w/]+)\]/gmu)].map((m) => ({ name: m[1], kind: m[2] }))
console.log(`${TARGET}: ${members.length} declaration(s), ${/lines\s*:\s*(\d+)/u.exec(report)?.[1]} lines`)

/**
 * ── AMBIGUOUS MEMBERS LEAVE THE TABLE ENTIRELY ──────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：`name` 移出分量表，单列一行 AMBIGUOUS + 声明点数。
 *
 * 上一版只剔除**边**、仍把 `name` 留在**成员表**里，于是它自己变成一个 1-decl 分量，
 * 把分量数从 13 推到 14 —— 一个「我们测量不了的东西」占据了一个格子，读者会以为那里有个族。
 *
 * 实测：`name` 在整棵树有 17 个声明点（1 个模块级 `export const name` + 16 个函数内局部 `const name`），
 * 对它的任何「引用行」都无法归给某一个符号。判据来自 `who-references --json` 的 `ambiguous` 字段，
 * 消费方不另立一套。
 */
const findingsByMember = new Map()
const ambiguousMembers = []
const ambiguousDeclCounts = new Map()
for (const m of members) {
  let findings
  try {
    findings = JSON.parse(run('who-references.mjs', ['--json', m.name]))
  } catch {
    console.error(`families: cannot parse who-references --json for ${m.name}`)
    continue
  }
  if (findings.some((f) => f.ambiguous === true)) {
    ambiguousMembers.push(m.name)
    ambiguousDeclCounts.set(m.name, findings.filter((f) => f.kind === 'DECL').length)
    continue
  }
  findingsByMember.set(m.name, findings)
}

if (ambiguousMembers.length > 0) {
  const parts = ambiguousMembers.map((n) => `${n} (${ambiguousDeclCounts.get(n)} declaration site(s))`)
  console.log(`AMBIGUOUS — removed from the component table: ${parts.join(', ')}`)
}

const liveMembers = members.filter((m) => !ambiguousMembers.includes(m.name))

/** 每个声明的行区间 [start, end]（1-based）。 */
const lines = readFileSync(SRC, 'utf8').split('\n')
const spanOf = (name, kind) => {
  // 声明行：interface/type/const/function 后面跟名字；允许 export 前缀
  const kw = kind === 'InterfaceDeclaration' ? 'interface'
    : kind === 'TypeAliasDeclaration' ? 'type'
      : kind === 'FunctionDeclaration' ? 'function'
        /**
         * ── `let/var` 这一支与上面成员正则的 `[\w/]+` 是一对 ─────────────────────────────────────
         *
         * 只改正则不加这一支，会得到「名字进了成员表但 `spanOf` 返回 undefined」——
         * 调用方的 `sizeOf()` 会退回默认 1 行，于是差额从「少 2 行」变成「少 0 行但仍不对」。
         * 两处必须同时改，否则修完看着像修好了，实际只是把同一个错换了位置。
         */
        : kind === 'let/var' ? '(?:let|var)'
          : 'const'
  const re = new RegExp(`^(?:export\\s+)?${kw}\\s+${name}\\b`, 'u')
  const start = lines.findIndex((l) => re.test(l))
  if (start < 0) return undefined
  /**
   * 花括号配平必须容忍「签名跨行」：`export function buildTape(` 之后若干行才是 `{`。
   * 第一版在第一行没看到 `{` 就判定为单行声明，于是 buildTape 被算成 1 行 ——
   * 分量表因此把最大的那个声明当成最小的，整张表失去意义。
   * 判据改成：在遇到 `;`（语句结束）之前出现的第一个 `{` 开始配平。
   *
   * ── 反向的同类缺陷：**没有**任何括号的单行声明 ─────────────────────────────────────────────
   *
   * 实测：`export const name = 'dsh-graft-slice'` 既没有 `{` 也没有 `;`，于是旧逻辑一路向下扫，
   * 直到撞上下一条带 `{` 的声明才收尾，把一个 1 行常量报成 **20 行**。
   *
   * 修法用同一套括号（`(` `[` `{` 三种都参与配平）：
   *   · 首行没有任何开括号 ⇒ 这一行就是整条声明；
   *   · 有开括号 ⇒ 配平到深度归零那一行（自动覆盖 `new Set([...])` 这类一行写完的字面量）。
   */
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const closers = new Set([')', ']', '}'])
  let depth = 0
  let opened = false
  for (let i = start; i < lines.length; i++) {
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

const spans = new Map()
// 跨度对**全部**声明计算（含歧义成员）：自校验需要它，展示只用 liveMembers
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

const memberSet = new Set(liveMembers.map((m) => m.name))
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
const edges = new Map(liveMembers.map((m) => [m.name, new Set()]))
const unresolvedRefs = []

/** 边只从**非歧义**成员的 findings 里取；歧义成员已在上面整体移出成员表。 */
for (const name of memberSet) {
  const findings = findingsByMember.get(name) ?? []
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

/**
 * ── 自校验：声明跨度之和必须等于 closure 报的闭包行数 ────────────────────────────────────────────
 *
 * 实测到的症状：修 `spanOf` 之前，各分量之和是 **1,068**，而 `closure.mjs` 说闭包是 **974 行**。
 * 差 94 行不是噪声，是 `spanOf` 把「没有分号的一行常量」一路扫到下一条带括号的声明造成的虚胖
 * （`name` 被报成 20 行、`ATTACHMENT_KINDS` 与 `WRITE_TOOL_NAMES` 同样被放大）。
 *
 * 修好后两者相等（863 = 863）。这个等式因此可以当断言用：一旦再次不等，就是 spanOf 又偏了。
 * 不相等时**依然打印整张表**，只在末尾给出警告 —— 一张有瑕疵的表比没有表有用，但瑕疵必须被说出来。
 */
const closureLineTotal = Number(/lines\s*:\s*(\d+)/u.exec(report)?.[1])
const spanTotal = members.reduce((s, m) => s + sizeOf(m.name), 0)

const total = spanTotal
const inTable = components.reduce((s, c) => s + c.reduce((q, n) => q + sizeOf(n), 0), 0)
console.log(`\n${components.length} connected component(s), ${inTable} lines in the table (+ ${total - inTable} for the removed ambiguous member = ${total})`)
console.log('行的口径：每个分量的数字是**声明跨度和**（`families.mjs` 自身的 spanOf），')
console.log('          既不是「切除区间」，也不是「`index.ts` 实测净变化」；只用于排序与族大小比较。\n')
if (spanTotal !== closureLineTotal) {
  console.log(`WARNING: declaration spans total ${spanTotal} != closure total ${closureLineTotal} (difference ${spanTotal - closureLineTotal})`)
  console.log('         spanOf and closure DISAGREE — one of them is counting a line the other is not.')
  console.log('         Do not trust these numbers until the difference is 0. Audit per-member, do not hand-wave "blank lines".\n')
} else {
  /**
   * ── 相等时也要**说出来**，不是静默 ──────────────────────────────────────────────────────────
   *
   * observer 那份同源脚本在这里会打印「跨度之和 == 闭包总行数（N == N）」。
   * 本仓原来差值为 0 时一句不吭 —— 于是「自校验跑过了」和「自校验根本没跑」在输出上一样。
   * 静默的通过不是证据。
   */
  console.log(`跨度之和 == 闭包总行数（${spanTotal} == ${closureLineTotal}），逐成员与编译器 0 差。\n`)
}
let idx = 0
for (const comp of components) {
  idx += 1
  const sum = comp.reduce((s, n) => s + sizeOf(n), 0)
  console.log(`#${idx}  ${comp.length} decl / ${sum} lines   ${comp.sort((a, b) => sizeOf(b) - sizeOf(a)).join(', ')}`)
}
if (unresolvedRefs.length) console.log(`\nunresolved refs: ${unresolvedRefs.length}`)
