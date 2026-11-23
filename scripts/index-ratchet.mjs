#!/usr/bin/env node
/**
 * ── index-ratchet: THE FOURTEEN-THOUSAND-LINE FILE GETS A CEILING THAT CAN GO RED ────────────────
 *
 * TD-1's exit condition used to be 「`index.ts ≤ 300`」, which nobody can reach in one batch — so it was
 * a sentence, not a gate. Lead's re-ruling (§25.3②) replaces it with two conditions that are red TODAY:
 *
 *   1. `src/index.ts` 的行数与**顶层函数数**各设 ceiling，**只减不增**；
 *   2. 每个顶层函数在 `docs/index-manifest.json` 里有一行。
 *
 * ── WHY THIS IS A NEW GATE AND NOT `v130` ───────────────────────────────────────────────────────
 *
 * `v130` says `src/index.ts` is "out of scope BY CONSTRUCTION" — it is the file being dismantled, so the
 * module-size cap exempts it. Reusing that gate would nail the check to the one file it must not police
 * (measured: `v130:23/121/147/230`).
 *
 * ── WHAT `responsibility` AND `why` ACTUALLY SAY ────────────────────────────────────────────────
 *
 * They are derived from the CALL GRAPH, not invented:
 *
 *   responsibility = 「被 <caller1>、<caller2> … 调用」  (or 「entry：apply()/注册调用」 for leaves)
 *   why            = 「它的引用者仍在 index.ts —— 搬它必须先搬 <caller>」 / 「它是 entry，搬动等于改注册面」
 *
 * Only 80 of 191 functions carry a doc comment, so a hand-written rationale for all 191 would be
 * 111 guesses. A call-graph fact is verifiable; a guessed rationale is not. The field is recorded as
 * DERIVED in the manifest so nobody mistakes it for a human decision.
 *
 * Usage:
 *   node scripts/index-ratchet.mjs            # check (exit 1 on any gap)
 *   node scripts/index-ratchet.mjs --write    # regenerate manifest + tighten ceilings to the measurement
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src', 'index.ts')
const MANIFEST = join(ROOT, 'docs', 'index-manifest.json')
const CEILING = join(ROOT, 'docs', 'index-ratchet.json')

const source = readFileSync(SOURCE, 'utf8')
const lines = source.split('\n')

/** Count non-empty trailing lines the way `v205` counts: a trailing blank is not a line of code. */
function countLines(list) {
  let end = list.length
  while (end > 0 && list[end - 1].trim() === '') end -= 1
  return end
}

const DECL = /^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/u

/** Every top-level function with its span, found by brace depth from the declaration line. */
function scanFunctions() {
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = DECL.exec(lines[i])
    if (match === null) continue
    let depth = 0
    let end = i + 1
    let seen = false
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) {
        if (ch === '{') {
          depth += 1
          seen = true
        } else if (ch === '}') depth -= 1
      }
      if (seen && depth <= 0) {
        end = j + 1
        break
      }
    }
    found.push({ name: match[1], line: i + 1, end, exported: lines[i].startsWith('export ') })
  }
  return found
}

const functions = scanFunctions()

/** Calls to `name` that live OUTSIDE `name`'s own body — i.e. its call sites. */
function callersOf(fn, all) {
  const callers = new Set()
  const pattern = new RegExp(`(^|[^\\w$.])${fn.name.replace(/\$/gu, '\\$')}\\s*\\(`, 'u')
  for (let i = 0; i < lines.length; i += 1) {
    if (i + 1 >= fn.line && i + 1 <= fn.end) continue
    if (!pattern.test(lines[i])) continue
    const owner = all.findLast((other) => other.line <= i + 1 && i + 1 <= other.end)
    callers.add(owner === undefined ? '(module scope)' : owner.name)
  }
  return [...callers].sort()
}

const rows = functions.map((fn) => {
  const callers = callersOf(fn, functions)
  const isEntry = fn.name === 'apply' || callers.length === 0
  return {
    name: fn.name,
    line: fn.line,
    end: fn.end,
    exported: fn.exported,
    responsibility:
      callers.length === 0
        ? 'entry：apply() 或注册面直接调用'
        : `被 ${callers.slice(0, 6).join('、')}${callers.length > 6 ? ` 等 ${callers.length} 处` : ''} 调用`,
    why:
      callers.length === 0
        ? '它是入口（apply / 注册面），搬动等于改注册形状'
        : `它的引用者仍在 index.ts —— 搬它必须先搬 ${callers[0]}`,
    /** 标记字段来源，免得下一位读者把它当成人工判断。 */
    derivedFrom: 'call-graph',
  }
})

const measured = { lines: countLines(lines), functions: functions.length }
const manifest = { generatedFrom: 'src/index.ts', derivedFrom: 'call-graph', measured, units: rows }

let ceiling
try {
  ceiling = JSON.parse(readFileSync(CEILING, 'utf8'))
} catch {
  ceiling = { lines: measured.lines, functions: measured.functions, history: [] }
}

if (process.argv.includes('--write')) {
  mkdirSync(dirname(MANIFEST), { recursive: true })
  /** The ratchet only TIGHTENS: a measurement below the ceiling lowers it; a measurement above it is a
   * failure the caller must fix, never a ceiling bump (that would make the gate a rubber stamp). */
  const next = { ...ceiling }
  if (measured.lines < ceiling.lines) {
    next.lines = measured.lines
    next.history = [...(ceiling.history ?? []), { at: new Date().toISOString(), field: 'lines', from: ceiling.lines, to: measured.lines }]
  }
  if (measured.functions < ceiling.functions) {
    next.functions = measured.functions
    next.history = [...(next.history ?? []), { at: new Date().toISOString(), field: 'functions', from: ceiling.functions, to: measured.functions }]
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(CEILING, `${JSON.stringify({ lines: next.lines, functions: next.functions, history: next.history ?? [] }, null, 2)}\n`, 'utf8')
  console.log(`wrote manifest (${measured.functions} functions) and ceiling ${next.lines} lines / ${next.functions} functions`)
  process.exit(0)
}

const failures = []

if (measured.lines > ceiling.lines) {
  failures.push(`index.ts 有 ${measured.lines} 行，ceiling 是 ${ceiling.lines} —— 只减不增：拆出去，不要抬天花板`)
}
if (measured.functions > ceiling.functions) {
  failures.push(`index.ts 有 ${measured.functions} 个顶层函数，ceiling 是 ${ceiling.functions} —— 只减不增`)
}

let committed = null
try {
  committed = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch {
  failures.push(`缺少 ${MANIFEST} —— 先跑 node scripts/index-ratchet.mjs --write 并审阅它`)
}

if (committed !== null) {
  const committedNames = new Set((committed.units ?? []).map((unit) => unit.name))
  const measuredNames = new Set(functions.map((fn) => fn.name))
  const unregistered = [...measuredNames].filter((name) => !committedNames.has(name))
  const stale = [...committedNames].filter((name) => !measuredNames.has(name))
  if (unregistered.length > 0) {
    failures.push(`这些顶层函数没有登记（没登记 = 红）：\n    ${unregistered.join('\n    ')}`)
  }
  if (stale.length > 0) {
    failures.push(`登记指向已不存在的函数（过期登记和没登记一样有害）：\n    ${stale.join('\n    ')}`)
  }
  const blank = (committed.units ?? []).filter(
    (unit) => typeof unit.responsibility !== 'string' || unit.responsibility.trim() === '' || typeof unit.why !== 'string' || unit.why.trim() === '',
  )
  if (blank.length > 0) {
    failures.push(`这些登记缺 responsibility / why：${blank.map((unit) => unit.name).join(', ')}`)
  }
  if (JSON.stringify(manifest.units) !== JSON.stringify(committed.units)) {
    failures.push('manifest 与重新生成的结果不一致 —— 源码变了而清单没更新：跑 --write 并审阅 diff')
  }
}

console.log(`index-ratchet: ${measured.lines} lines / ${measured.functions} functions (ceiling ${ceiling.lines} / ${ceiling.functions})`)
if (failures.length > 0) {
  console.log('\nFAIL:')
  for (const line of failures) console.log(`  ❌ ${line}`)
  process.exit(1)
}
console.log('OK — under both ceilings, every top-level function is registered, manifest is current.')