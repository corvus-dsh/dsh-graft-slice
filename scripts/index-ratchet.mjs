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
 *
 * `why` used to say 「它的引用者仍在 index.ts —— 搬它必须先搬 <caller>」, and that was **an
 * unsatisfiable instruction, not an ordering**. Measured (lead §五十七.2): 48 units said
 * 「必须先搬 apply」 and 56 said 「必须先搬 (module scope)」 — 104 of 191. But `apply` is the
 * CONTAINER (it is the registration surface and never moves), and `(module scope)` is not a movable
 * object at all. Meanwhile the real rule is the opposite: `verify-pure-move.mjs` EXCLUDES import and
 * export lines from the content multiset, so moving a unit that `apply` calls leaves `apply` with one
 * extra import and an unchanged multiset — the pure-move check still prints IDENTICAL.
 *
 *   **An unsatisfiable prerequisite printed as an instruction is worse than no list**: the reader
 *   starts by looking for 「how do I move apply」 and stops there.
 *
 * So `why` now has exactly the shapes an executor needs:
 *
 *   「无前置（搬动后容器只多一行 import）」        — nothing has to move before it
 *   「与 <簇名> 同簇（必须一起搬）」              — it belongs to a cluster and travels with it
 *   「容器（不搬动；随簇搬动只增加 import）」      — the container itself (`apply` only)
 *
 * The cluster is the CONNECTED COMPONENT of the caller graph once `apply` and `(module scope)` are
 * removed as blockers — because those two are satisfied by an import, which is what the container
 * already does. Cluster name = the member with the smallest line number, and every member names that
 * same head, so `v347` can check the label exists AND the head agrees without recomputing the graph.
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
  return {
    name: fn.name,
    line: fn.line,
    end: fn.end,
    exported: fn.exported,
    responsibility:
      callers.length === 0
        ? 'entry：apply() 或注册面直接调用'
        : `被 ${callers.slice(0, 6).join('、')}${callers.length > 6 ? ` 等 ${callers.length} 处` : ''} 调用`,
    why: '',
    /** 标记字段来源，免得下一位读者把它当成人工判断。 */
    derivedFrom: 'call-graph',
  }
})

/**
 * ── THE ORDERING AN EXECUTOR CAN ACTUALLY FOLLOW ────────────────────────────────────────────────
 *
 * The relation that matters is **callee**, not caller:
 *
 *   - a CALLER that stays behind is satisfied by an IMPORT — `index.ts` imports the new module's
 *     symbol and nothing is cyclic. So `apply` calling a moved unit is NOT a prerequisite: it gains
 *     one import line, which `verify-pure-move.mjs` excludes from the content multiset. Same for code
 *     sitting at `(module scope)`.
 *
 *   - a CALLEE that stays behind CANNOT be satisfied: the new module would have to
 *     `import { x } from './index.js'` while `index.ts` imports the new module — a cycle, which
 *     `check-cycles` refuses. So `closure(U) = {U} ∪ callees(U) ∪ callees(callees(U)) …` is exactly
 *     the set that has to travel together.
 *
 * Hence:
 *
 *   `closure(U) = {U}` ⇒ 「无前置（搬动后容器只多一行 import）」 — movable today, on its own
 *   otherwise          ⇒ 「与 <锚点> 同簇（必须一起搬）」
 *
 * The 锚点 is the smallest-line unit INSIDE `closure(U)` that has no callees of its own — i.e. one
 * that really is `无前置` today. That gives `v347` a claim it can check without recomputing the graph:
 * **the unit a `why` names must itself be marked 无前置**. An invented or stale cluster name fails
 * immediately.
 *
 * Measured before this change (lead §五十七.2): 48 units said 「必须先搬 apply」 and 56 said
 * 「必须先搬 (module scope)」 — 104 of 191, every one an unsatisfiable instruction.
 * **An unsatisfiable prerequisite printed as an instruction is worse than no list**: the reader starts
 * by looking for 「how do I move apply」 and stops there.
 */
const CONTAINER_UNITS = new Set(['apply'])

/** Callees of `fn` that are themselves units in this file (a call `name(` anywhere in its body). */
function calleesOf (fn, all) {
  const callees = new Set()
  for (const other of all) {
    if (other.name === fn.name) continue
    /** The container is never a cluster member: it does not move, so it cannot be travelled WITH. */
    if (CONTAINER_UNITS.has(other.name)) continue
    const pattern = new RegExp(`(^|[^\\w$.])${other.name.replace(/\$/gu, '\\$')}\\s*\\(`, 'u')
    for (let i = fn.line - 1; i < fn.end; i += 1) {
      /** A mention inside a comment is not a call — measured: `/** Before apply() there is no layer …` */
      const trimmed = lines[i].trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      if (pattern.test(lines[i])) {
        callees.add(other.name)
        break
      }
    }
  }
  return [...callees].sort()
}

const byUnitName = new Map(functions.map((fn) => [fn.name, fn]))
const calleeCache = new Map()
const calleesOfName = (name) => {
  if (!calleeCache.has(name)) calleeCache.set(name, calleesOf(byUnitName.get(name), functions))
  return calleeCache.get(name)
}

/** `{U} ∪ callees(U)` transitively — the set that must move together. */
function closureOf (name) {
  const seen = new Set([name])
  const queue = [name]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const callee of calleesOfName(current)) {
      if (seen.has(callee)) continue
      seen.add(callee)
      queue.push(callee)
    }
  }
  return seen
}

/**
 * The label is the LARGEST unit in `closure(U) \ {U}` — the biggest thing that has to travel with it.
 *
 * Two earlier shapes were wrong and the criterion caught both:
 *
 *   1. 「the largest member of the whole closure」 — for a leader that is ITSELF the largest, the
 *      sentence degenerates to 「与 collectDebugStatus 同簇」 printed on `collectDebugStatus`;
 *   2. 「the topmost of a chain」 — closure containment is not a partition, so units end up naming each
 *      other in cycles and no group has a stable head.
 *
 * Naming the biggest thing you CALL is the fact an executor needs: 「this cannot move until that
 * moves too, and they travel together」. The manifest is regenerated from the call graph and
 * `index-ratchet` fails when the committed file differs from the regeneration, so these labels cannot
 * be hand-edited into something the graph does not say.
 */
function labelOf (name) {
  const others = [...closureOf(name)].filter((member) => member !== name).map((member) => byUnitName.get(member))
  if (others.length === 0) return undefined
  return others.sort((left, right) => (right.end - right.line) - (left.end - left.line) || left.line - right.line)[0].name
}

const whyOf = (fn) => {
  if (CONTAINER_UNITS.has(fn.name)) return '容器（不搬动；随簇搬动只增加 import）'
  const label = labelOf(fn.name)
  if (label === undefined) return '无前置（搬动后容器只多一行 import）'
  return `与 ${label} 同簇（必须一起搬）`
}

for (const row of rows) {
  row.why = whyOf(byUnitName.get(row.name))
}


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