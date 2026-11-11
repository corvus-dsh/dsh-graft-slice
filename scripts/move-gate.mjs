#!/usr/bin/env node
/**
 * ── MOVE GATE: the four tiers that must ALL pass before a cluster may move ─────────────────────────
 *
 * User ruling 2026-11-11. A move is admitted only when every tier says YES; any NO stops the move and
 * the reason is reported. The point of putting this in a script is that "I checked it" is not a result:
 * each tier prints the MEASUREMENT it was decided from, so a reader can disagree with the verdict.
 *
 *   A  模块大小   module size ≤ 800 lines (declaration span)                       ← TD-1's original meaning
 *   B  依赖总和   closure size — REPORTED ONLY, never a veto                        ← the old misreading
 *   C  可拆分性   four questions, all must be YES (see below)
 *   D  性能不退   efficiency / safety / stability / concurrency, all must hold
 *
 * ── C: THE FOUR QUESTIONS ───────────────────────────────────────────────────────────────────────────
 *
 * C1 一句话说清   can the cluster be described in one sentence WITHOUT "and"?
 * C2 调用面       is it called only by the container and its own cluster? (a test importing it is fine —
 *                 the question is whether PRODUCTION code reaches into it)
 * C3 可独立测试   can ≥3 assertions be written importing ONLY the cluster (never index.ts)?
 * C4 无隐式时序   does correctness depend on "must run inside the container, after variable X is set"?
 *                 C4 is the decisive one: a sub-block that reads state produced by an earlier loop is
 *                 not functional, no matter how small its closure.
 *
 * This script MEASURES C1–C4 as far as a machine can, and prints what a human must still confirm. It is
 * deliberately honest about that split: `machine` verdicts are computed, `review` verdicts are printed
 * as OPEN and must be filled by a human reading the code. A gate that pretends to decide a semantic
 * question by regex would be the same failure this whole phase keeps finding.
 *
 * Usage:
 *   node scripts/move-gate.mjs --cluster GraftConfig
 *   node scripts/move-gate.mjs --cluster GraftConfig --json
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')
const INDEX = join(SRC, 'index.ts')
const TOOL = join(REPO, 'scripts', 'closure.mjs')

const args = process.argv.slice(2)
const clusterIndex = args.indexOf('--cluster')
const CLUSTER = clusterIndex >= 0 ? args.slice(clusterIndex + 1).filter((a) => !a.startsWith('--')) : []
const asJson = args.includes('--json')
if (CLUSTER.length === 0) {
  console.error('usage: node scripts/move-gate.mjs --cluster <Name> [<Name> ...]')
  process.exit(2)
}

const subset = new Set(CLUSTER)

/**
 * Evidence fixtures under src/ that are NOT part of the packaging closure.
 *
 * `src/core/ignition.ts.bak-cut` is a v7.6 baseline backup. It is deliberately tracked, and v125/v126
 * exist to keep it (a) present and (b) OUT of the artifact. Counting it as a production caller would
 * be a false positive: nothing imports it and it never ships.
 *
 * The rule is not "ignore .bak files" — it is "ignore files the bundler cannot reach", and v125
 * asserts that property for this exact file.
 */
const NOT_SHIPPED = new Set(['core/ignition.ts.bak-cut'])

// ── measurement helpers ─────────────────────────────────────────────────────────────────────────────
function sourceFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (/\.ts(?:\.|$)/u.test(entry)) out.push(full)
    }
  }
  walk(dir)
  return out
}

/**
 * Declaration spans and kinds, without a TypeScript dependency (CI has none by design).
 *
 * ── TWO BUGS THIS HAD TO BE FIXED FOR, BOTH MEASURED ────────────────────────────────────────────
 *
 * 1. PARSING LINE BY LINE CANNOT STRIP A BLOCK COMMENT. `/** … *\/` usually spans many lines, so a
 *    per-line regex never matches it and the braces inside the prose are counted as code. Measured: a
 *    JSDoc listing `{ … }` made `export const inject` (ONE line, an array of strings) swallow everything
 *    up to L767 — GraftConfig disappeared entirely from the declaration map, and the gate reported
 *    "A YES, 288 lines" for a declaration it had never found.
 *    FIX: strip comments and string literals over the WHOLE FILE first, preserving line count.
 *
 * 2. A DECLARATION IS NOT "CLOSED WHEN IT SEES A `{` AND RETURNS TO 0". `export const inject = [...]`
 *    has no braces at all; keying on `sawBody` let it run to the next brace, which was GraftConfig's.
 *    FIX: track a single depth over `{ ( [`, and end the declaration when that depth returns to 0
 *    AFTER the line it started on — with an explicit exception for `type X = A | B`, which has no
 *    bracketed body at all.
 *
 * Calibrated against four known answers (buildTape 3714/4209/496, GraftConfig 480/767/288,
 * extractGoal 2617/2824/208, renderReplayTurn 3684/3704/21) — all four must match or the parser is not
 * usable. The calibration is in test/v138-move-gate.test.mjs so a regression cannot pass silently.
 */
function stripCommentsAndStrings(source) {
  let out = ''
  let index = 0
  let state = 'code'
  let quote = ''
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '*') { state = 'block'; out += '  '; index += 2; continue }
      if (char === '/' && next === '/') { state = 'line'; out += '  '; index += 2; continue }
      if (char === "'" || char === '"' || char === '`') { state = 'string'; quote = char; out += char; index += 1; continue }
      out += char; index += 1; continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; index += 2; continue }
      out += char === '\n' ? '\n' : ' '; index += 1; continue
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += '\n'; index += 1; continue }
      out += ' '; index += 1; continue
    }
    // inside a string literal: keep the delimiters, blank the contents
    if (char === '\\') { out += '  '; index += 2; continue }
    if (char === quote) { state = 'code'; out += char; index += 1; continue }
    out += char === '\n' ? '\n' : ' '; index += 1; continue
  }
  return out
}

function moduleDeclarations(file) {
  const text = readFileSync(file, 'utf8')
  const lines = stripCommentsAndStrings(text).split('\n')
  const found = new Map()
  const DECL = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(interface|type|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/u

  const depthOf = (line) => {
    let depth = 0
    for (const char of line) {
      if (char === '{' || char === '(' || char === '[') depth += 1
      else if (char === '}' || char === ')' || char === ']') depth -= 1
    }
    return depth
  }

  for (let index = 0; index < lines.length; index++) {
    const decl = DECL.exec(lines[index])
    if (decl === null) continue
    const keyword = decl[1]
    const name = decl[2]
    if (found.has(name)) continue
    const kind = keyword === 'interface' || keyword === 'type' ? 'type'
      : keyword === 'function' ? 'function'
        : keyword === 'class' ? 'class' : 'value'

    let depth = 0
    let endLine = index
    for (let cursor = index; cursor < lines.length; cursor++) {
      depth += depthOf(lines[cursor])
      endLine = cursor
      // `type X = A | B` has no bracketed body: it ends on its own line
      if (cursor === index && keyword === 'type' && depth === 0) break
      // a body that opened and closed again on/before this line
      if (cursor > index && depth <= 0) break
      if (cursor === index && depth <= 0 && keyword !== 'type') {
        // one-liner const/let (e.g. `export const inject = [...]`) — depth already balanced
        if (/=\s*[[{]/u.test(lines[index])) break
        if (!/=\s*$/u.test(lines[index]) && !/\(\s*$/u.test(lines[index])) break
      }
    }

    found.set(name, { name, kind, start: index + 1, end: endLine + 1, lines: endLine - index + 1 })
    index = endLine
  }
  return found
}

/**
 * ── A CLUSTER MAY ALREADY LIVE IN ITS OWN MODULE ────────────────────────────────────────────────
 *
 * The first version parsed only `src/index.ts`, because every target happened to be there. After
 * GraftConfig moved to `core/graft-config.ts`, tier A reported "0 行 — YES": a pass on something the
 * gate had not found at all. That is the same failure shape this phase keeps finding (a green number
 * with no correct denominator), so the gate now resolves a cluster across the whole tree and says
 * WHICH FILE it found it in.
 */
const indexDeclarations = moduleDeclarations(INDEX)

/** Every module-scope declaration under src/, keyed by name, with the file it came from. */
const allDeclarations = new Map()
for (const file of sourceFiles(SRC)) {
  const rel = relative(SRC, file).split('\\').join('/')
  for (const [name, span] of moduleDeclarations(file)) {
    if (!allDeclarations.has(name)) allDeclarations.set(name, { ...span, file: rel })
  }
}

/** Resolve a cluster name to wherever it actually lives. */
const resolveDeclaration = (name) => allDeclarations.get(name) ?? indexDeclarations.get(name)

const runClosure = (name) => {
  try {
    const output = execFileSync(process.execPath, [TOOL, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return {
      declarations: Number(/declarations : (\d+)/u.exec(output)?.[1]),
      lines: Number(/lines\s+: (\d+)/u.exec(output)?.[1]),
      mutable: (/mutable\s+: (.*)/u.exec(output)?.[1] ?? '').trim(),
      members: [...output.matchAll(/^ {4}(\S+?):(\w+) \[([^\]]+)\]/gmu)].map((m) => ({ file: m[1], name: m[2], kind: m[3] })),
    }
  } catch {
    return undefined
  }
}

// ── A: module size ──────────────────────────────────────────────────────────────────────────────────
const spans = CLUSTER.map((name) => resolveDeclaration(name)).filter(Boolean)
const moduleLines = spans.reduce((total, span) => total + span.lines, 0)
const aVerdict = spans.length > 0 && moduleLines <= 800

// ── B: closure (reported, never a veto) ───────────────────────────────────────────────────────────
const closureOfCluster = runClosure(CLUSTER[0])
const clusterClosureLines = closureOfCluster === undefined
  ? undefined
  : Math.max(...CLUSTER.map((name) => runClosure(name)?.lines ?? 0))

// ── C1: one sentence without "and" ─────────────────────────────────────────────────────────────────
// A machine cannot decide this. What it CAN do is show the declaration so the reader decides, and
// flag the mechanical signal: how many distinct exported members the cluster holds.
const kinds = spans.map((span) => span.kind)
const oneKind = new Set(kinds).size === 1

// ── C2: who calls it ───────────────────────────────────────────────────────────────────────────────
/**
 * ── A MENTION IN A COMMENT IS NOT A CALLER ──────────────────────────────────────────────────────
 *
 * Measured on GraftConfig: four modules under `src/core/` mention the name, and the first version of
 * this gate counted all four as production callers (verdict REVIEW). Reading them showed every one is
 * inside a comment: "Mirrors `Required<GraftConfig>`'s used fields", "Declared structurally instead of
 * importing `GraftConfig` from index.ts: the dependency must not point backwards". Not one imports it.
 *
 * So comments and string literals are stripped from the FILE under scrutiny before references are
 * collected, using the same whole-file stripper the declaration parser uses. Otherwise the gate would
 * be answering "who talks about it", which is not the question C2 asks.
 */
const referenceSites = []
for (const file of [...sourceFiles(SRC)]) {
  const rel = relative(SRC, file).split('\\').join('/')
  if (NOT_SHIPPED.has(rel)) continue
  const lines = stripCommentsAndStrings(readFileSync(file, 'utf8')).split('\n')
  for (const [index, line] of lines.entries()) {
    const declarationOfItself = CLUSTER.some((name) => {
      const span = indexDeclarations.get(name)
      return span !== undefined && rel === 'index.ts' && index + 1 >= span.start && index + 1 <= span.end
    })
    if (declarationOfItself) continue
    for (const name of CLUSTER) {
      const pattern = new RegExp(`\\b${name.replace(/\$/gu, '\\$')}\\b`, 'u')
      if (!pattern.test(line)) continue
      referenceSites.push({ file: rel, line: index + 1, name, text: line.trim() })
    }
  }
}
/**
 * ── THE FILE A CLUSTER LIVES IN IS NOT A CALLER OF ITSELF ──────────────────────────────────────
 *
 * After GraftConfig moved to \`core/graft-config.ts\`, that module naturally contains the name — and the
 * first version counted it as a production caller, turning C2 from YES to REVIEW. A cluster is not its
 * own dependency.
 *
 * \`index.ts\` is treated separately for the same reason: it is the container, and its references are
 * counted (they are the reason the cluster is reachable) but they are not "production callers" in the C2
 * sense — the question is whether anything ELSE reaches in.
 */
const clusterHomeFiles = new Set(spans.map((span) => span.file ?? 'index.ts').filter(Boolean))
const productionCallers = [...new Set(
  referenceSites
    .filter((site) => site.file !== 'index.ts')
    .filter((site) => !clusterHomeFiles.has(site.file))
    .filter((site) => !/^\s*(?:import|export)\b/u.test(site.text)) // a re-export/import is plumbing, not a call
    .map((site) => site.file),
)]
const indexSites = referenceSites.filter((site) => site.file === 'index.ts')

/** Files that literally IMPORT the cluster (stronger evidence than a reference inside the same tree). */
const importersOf = []
for (const file of sourceFiles(SRC)) {
  const rel = relative(SRC, file).split('\\').join('/')
  if (rel === 'index.ts' || NOT_SHIPPED.has(rel)) continue
  const text = stripCommentsAndStrings(readFileSync(file, 'utf8'))
  const importLines = text.split('\n').filter((line) => /^\s*(?:import|export)\b/u.test(line))
  for (const line of importLines) {
    if (CLUSTER.some((name) => new RegExp(`\\b${name}\\b`, 'u').test(line))) { importersOf.push({ file: rel, line: line.trim() }); break }
  }
}

/** Test files that mention the cluster (informational: a test may legitimately import a module). */
const testCallers = []
for (const entry of readdirSync(join(REPO, 'test'))) {
  const full = join(REPO, 'test', entry)
  if (!statSync(full).isFile() || !/\.m?js$/u.test(entry)) continue
  const text = readFileSync(full, 'utf8')
  if (CLUSTER.some((name) => new RegExp(`\\b${name}\\b`, 'u').test(text))) testCallers.push(entry)
}

// ── C3: can it be tested by importing only the cluster? ────────────────────────────────────────────
// Machine signal: does the cluster have any reference to a symbol that lives in index.ts and would NOT
// travel with it? That is exactly the cluster's `outside` set.
const outsideRefs = (() => {
  if (closureOfCluster === undefined) return []
  const members = new Set(closureOfCluster.members.map((member) => member.name))
  return [...members].filter((name) => !subset.has(name)).map((name) => {
    const member = closureOfCluster.members.find((candidate) => candidate.name === name)
    return { name, kind: member.kind }
  })
})()

// ── C4: implicit ordering inside the container ─────────────────────────────────────────────────────
// Machine signal: does the cluster read a name that is ASSIGNED inside the container's body but
// declared outside the cluster? Those are the "must run after X is set" dependencies.
const CONTAINER = 'buildTape'
const containerSpan = indexDeclarations.get(CONTAINER)
const containerAssignments = new Set()
let containerBodyLines = 0
if (containerSpan !== undefined) {
  const all = readFileSync(INDEX, 'utf8').split('\n')
  const body = all.slice(containerSpan.start - 1, containerSpan.end)
  containerBodyLines = body.length
  for (const line of body) {
    // destructuring: const { a, b } = ... / const [x, y] = ...
    for (const match of line.matchAll(/(?:^|\s)(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/gu)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(':').pop()?.split('=')[0]?.trim()
        if (name !== undefined && /^[A-Za-z_$][\w$]*$/u.test(name)) containerAssignments.add(name)
      }
    }
    // simple declarations: const x = ... / let x = ... / var x = ...
    for (const match of line.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) containerAssignments.add(match[1])
    // bare reassignment of an outer binding: x = ... (not ==, ===, =>, <=, >=, !=)
    for (const match of line.matchAll(/(?:^|\s)([A-Za-z_$][\w$]*)\s*=(?![=>])/gu)) {
      if (!/^(?:const|let|var|if|while|for|return|throw)$/u.test(match[1])) containerAssignments.add(match[1])
    }
    // for-of / for-in bindings
    for (const match of line.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) containerAssignments.add(match[1])
  }
}
const clusterNames = new Set(CLUSTER)
const implicitOrdering = outsideRefs.filter((ref) => containerAssignments.has(ref.name))

// ── D: performance tiers ───────────────────────────────────────────────────────────────────────────
const exportSurface = (() => {
  try {
    const json = JSON.parse(readFileSync(join(REPO, '.export-surface.json'), 'utf8'))
    return { count: json.count, list: json.exports ?? [] }
  } catch { return { count: undefined, list: [] } }
})()
const clusterInExportSurface = CLUSTER.filter((name) => exportSurface.list.includes(name))

const forbiddenPatterns = [
  { label: 'eval(', pattern: /\beval\s*\(/u },
  { label: 'dynamic import(', pattern: /\bimport\s*\(/u },
  { label: 'absolute Windows path', pattern: /[A-Za-z]:\\\\|[A-Za-z]:\/[A-Za-z]/u },
]

const report = {
  cluster: CLUSTER,
  A: {
    tier: 'A 模块大小 ≤ 800',
    verdict: spans.length === 0 ? 'NOT-FOUND' : (aVerdict ? 'YES' : 'NO'),
    machine: true,
    measured: {
      moduleLines,
      cap: 800,
      declarations: spans.map((span) => ({ name: span.name, kind: span.kind, file: span.file ?? 'index.ts', start: span.start, end: span.end, lines: span.lines })),
    },
  },
  B: {
    tier: 'B 闭包（只报告，不设限）',
    verdict: 'REPORTED',
    machine: true,
    measured: { closureLines: clusterClosureLines, declarations: closureOfCluster?.declarations, mutable: closureOfCluster?.mutable },
  },
  C1: {
    tier: 'C1 一句话说清（不含「并且」）',
    verdict: oneKind ? 'LIKELY' : 'REVIEW',
    machine: false,
    measured: { kinds: [...new Set(kinds)], note: oneKind ? 'the cluster is a single declaration kind' : 'mixed kinds — the sentence may need "and"' },
  },
  C2: {
    tier: 'C2 调用面：只被容器及同簇调用',
    verdict: productionCallers.length === 0 ? 'YES' : 'REVIEW',
    machine: true,
    measured: { productionCallers, indexSites: indexSites.length, testCallers },
  },
  C3: {
    tier: 'C3 能否只 import 该簇写 ≥3 条断言',
    verdict: outsideRefs.length === 0 ? 'YES' : 'REVIEW',
    machine: true,
    measured: { outsideRefs, note: outsideRefs.length === 0 ? 'the cluster needs nothing outside itself' : 'these must come along or be imported' },
  },
  C4: {
    tier: 'C4 无隐式时序',
    verdict: implicitOrdering.length === 0 ? 'YES' : 'NO',
    machine: true,
    measured: { implicitOrdering, containerAssignments: containerAssignments.size, containerBodyLines, note: implicitOrdering.length === 0 ? 'nothing it reads is produced inside the container body' : 'reads state produced earlier inside the container — NOT functionally separable' },
  },
  D: {
    tier: 'D 性能不退（四项）',
    verdict: 'MEASURED-SEPARATELY',
    machine: false,
    measured: {
      efficiency: 'n=50 × 5 runs, median; > 10% worse = regression (scripts/bench-*.mjs)',
      safety: { exportSurfaceCount: exportSurface.count, clusterInExportSurface, forbidden: forbiddenPatterns.map((entry) => entry.label) },
      stability: '761 green + 3 identical full runs + identical build SHA256 ×2',
      concurrency: 'v77-state-locks + v096-lock-trace green; lock boundary unchanged if the cluster writes files',
    },
  },
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const line = (text) => console.log(text)
line(`cluster: ${CLUSTER.join(', ')}`)
line('')
line(`── A 模块大小 ≤ 800 ─────────────────────────────────────────────`)
line(`   ${aVerdict ? 'YES' : 'NO'}   ${moduleLines} 行`)
for (const span of spans) line(`        ${span.name} [${span.kind}] ${span.file ?? 'index.ts'}:L${span.start}..L${span.end} = ${span.lines} 行`)
if (spans.length === 0) line(`        !! NOT FOUND in src/ — the gate cannot measure what it cannot locate`)

line('')
line(`── B 闭包（只报告，不设限）─────────────────────────────────────`)
line(`   ${clusterClosureLines ?? '?'} 行 / ${closureOfCluster?.declarations ?? '?'} 声明 / mutable: ${closureOfCluster?.mutable ?? '?'}`)

line('')
line(`── C1 一句话说清（不含「并且」）────────────────────────────────`)
line(`   ${report.C1.verdict}   声明种类: ${[...new Set(kinds)].join(', ')}`)
line(`        人工确认：这个簇能否用一句不含「并且」的话说清？`)

line('')
line(`── C2 调用面 ───────────────────────────────────────────────────`)
line(`   ${report.C2.verdict}   生产代码调用者: ${productionCallers.length === 0 ? '(无)' : productionCallers.join(', ')}`)
line(`        index.ts 内引用 ${indexSites.length} 处；测试提及 ${testCallers.length} 个文件`)
for (const site of testCallers) line(`          test/${site}`)

line('')
line(`── C3 能否只 import 该簇写 ≥3 条断言 ───────────────────────────`)
line(`   ${report.C3.verdict}   outside 引用: ${outsideRefs.length === 0 ? '(无)' : outsideRefs.map((ref) => `${ref.name} [${ref.kind}]`).join(', ')}`)

line('')
line(`── C4 无隐式时序（最关键）──────────────────────────────────────`)
line(`   ${report.C4.verdict}   依赖容器内先赋值的外部名字: ${implicitOrdering.length === 0 ? '(无)' : implicitOrdering.map((ref) => ref.name).join(', ')}`)
line(`        buildTape 体内 ${containerBodyLines} 行，解析出 ${containerAssignments.size} 个局部赋值`)

line('')
line(`── D 性能不退（四项，需分别测量）───────────────────────────────`)
line(`   效率     n=50 × 5 次中位数，劣化 >10% 视为退`)
line(`   安全性   导出面 ${exportSurface.count} 条不变；本簇是否在导出面: ${clusterInExportSurface.length === 0 ? '否（类型不进产物）' : clusterInExportSurface.join(', ')}`)
line(`            禁 eval / 动态 import / 明文路径`)
line(`   稳定性   761 全绿 + 连续 3 次一致 + build 两次 SHA256 相同`)
line(`   并发     v77-state-locks + v096-lock-trace 全绿；簇若写文件须证明锁边界未变`)

line('')
const machineVetoes = [report.A, report.C2, report.C3, report.C4].filter((entry) => entry.verdict === 'NO' || entry.verdict === 'NOT-FOUND')
line(`── 机器判据汇总 ────────────────────────────────────────────────`)
line(`   A=${report.A.verdict}  C2=${report.C2.verdict}  C3=${report.C3.verdict}  C4=${report.C4.verdict}`)
line(`   ${machineVetoes.length === 0 ? '无机器否决。C1 与 D 四项仍须人工/单独测量。' : `否决 ${machineVetoes.length} 项：${machineVetoes.map((entry) => entry.tier).join('; ')}`}`)
process.exit(machineVetoes.length === 0 ? 0 : 1)
