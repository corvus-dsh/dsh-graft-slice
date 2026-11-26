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
 * module-size cap exempts it. Reusing this gate on it would nail the check to the one file it must not
 * police (measured: `v130:23/121/147/230`).
 *
 * ── 量具（S0，2026-11-25）：花括号 → 编译器 ─────────────────────────────────────────────────────
 *
 * This script used to find each function's span by counting `{` and `}` from its declaration line. That
 * is wrong for exactly the signatures this file has: a parameter list may contain an OBJECT TYPE
 * LITERAL, so the braces in `(input: { a: number })` are balanced inside the signature and the count
 * returns to zero there. Measured consequences:
 *
 *   buildInjectionPlan   39 lines (braces) vs  931 (compiler)
 *   autoGraftIfNeeded    24            vs  229
 *   extractConstraintsDetailed  4      vs  180
 *   … 14 units off by more than three lines
 *
 * And the same scan treated NINE declarations inside `apply()`'s body as top-level functions, so the
 * ratchet's denominator was 190 while the real top-level count is 181.
 *
 * **Two rulers for one file is the defect this batch keeps re-finding** (`move-gate` reads
 * `closure.mjs`, which uses the compiler; this script used braces — the SAME unit got two answers, e.g.
 * `buildInjectionPlan` = A=NO 931 行 vs manifest 39 行). So the span is now the compiler's `getStart` /
 * `getEnd`, and the loader is the SHARED one (`scripts/ts-compiler.mjs`) so there is only ever one
 * resolver in this repo.
 *
 * **Zero compilers is not a pass** (§五十三.3's continuation): with no `typescript` resolvable, this
 * exits 2 and says `VACUOUS`. Never `exit 0`, never a silent fallback to the brace counter — a fallback
 * would make the number depend on the machine while looking exactly like success.
 *
 * ── `why`：可执行的顺序，不是不可满足的指令（S1）────────────────────────────────────────────────
 *
 * `why` used to say 「它的引用者仍在 index.ts —— 搬它必须先搬 <caller>」. Measured (lead §五十七.2):
 * 48 units said 「必须先搬 apply」 and 56 said 「必须先搬 (module scope)」 — 104 of 191, every one
 * unsatisfiable: `apply` is the CONTAINER (never moves) and `(module scope)` is not a movable object.
 * The real rule is the opposite — a caller that stays behind is satisfied by one import line, which
 * `verify-pure-move` excludes from the content multiset.
 *
 * Five shapes, each naming a DIFFERENT obstacle:
 *
 *   「容器（不搬动；随簇搬动只增加 import）」            — `apply`, the registration surface
 *   「体内声明（须先提升到模块级，非纯移动）」            — declared inside another function
 *   「依赖 apply() 赋值的模块级状态 <name>（不可搬；搬迁须先注入）」 — reads a module-level `let`
 *   「与 <成员> 同簇（必须一起搬）」                      — calls another unit of this file
 *   「无前置（搬动后容器只多一行 import）」               — movable today, on its own
 *
 * The first three are FACTS about the unit, not ordering advice, and `v347` checks each one against the
 * source with the same compiler.
 *
 * Usage:
 *   node scripts/index-ratchet.mjs                    # check (exit 1 on any gap, 2 when vacuous)
 *   node scripts/index-ratchet.mjs --write            # regenerate manifest + tighten ceilings
 *   node scripts/index-ratchet.mjs --raise-ceiling --reason "<why>"   # audited, recorded in history
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeTypeScript } from './ts-compiler.mjs'

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

/**
 * ── MEASURE WITH THE COMPILER, NEVER BY COUNTING BRACES ────────────────────────────────────────
 *
 * Every span below is `getStart()`/`getEnd()` on the parsed node, so a signature containing object type
 * literals cannot truncate the body. `top` is decided by the node's PARENT, not by its indentation:
 * indentation is a formatting fact and a formatter could change it without changing the program.
 */
async function measure() {
  const { ts, path: compilerPath, version } = await describeTypeScript()
  if (ts === undefined) return { vacuous: true }

  const sourceFile = ts.createSourceFile(SOURCE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const lineOf = (position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1

  /** Module-level `let` / `var` — the only names that carry state across calls without an import. */
  const mutableModuleScope = new Set()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const isMutable = (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    if (!isMutable) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) mutableModuleScope.add(declaration.name.text)
    }
  }

  const declarations = []
  const visit = (node, owner) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const start = lineOf(node.getStart(sourceFile))
      const end = lineOf(node.getEnd())
      declarations.push({
        name: node.name.text,
        line: start,
        end,
        exported: (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0,
        top: owner === undefined,
        owner: owner ?? null,
        node,
      })
      for (const child of node.body?.statements ?? []) visit(child, node.name.text)
      return
    }
    ts.forEachChild(node, (child) => visit(child, owner))
  }
  for (const statement of sourceFile.statements) visit(statement, undefined)

  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]))

  /** Identifiers the node's body reads that are module-level mutables — found by walking the AST. */
  const mutableReads = (node) => {
    const found = new Set()
    const walk = (child) => {
      if (ts.isIdentifier(child) && mutableModuleScope.has(child.text)) {
        /** `let x = 1; x = 2` — the declaration's own name is not a read. */
        const parent = child.parent
        const isDeclarationName = parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === child
        if (!isDeclarationName) found.add(child.text)
      }
      ts.forEachChild(child, walk)
    }
    if (node.body !== undefined) walk(node.body)
    return [...found].sort()
  }

  /** Units of THIS FILE that `node` calls — the set that must travel with it. */
  const calleesOf = (node) => {
    const found = new Set()
    const walk = (child) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        const name = child.expression.text
        if (name !== node.name.text && byName.has(name)) found.add(name)
      }
      ts.forEachChild(child, walk)
    }
    if (node.body !== undefined) walk(node.body)
    return [...found].sort()
  }

  return { vacuous: false, ts, sourceFile, compilerPath, version, declarations, byName, mutableReads, calleesOf, mutableModuleScope }
}

const measuredResult = await measure()

if (measuredResult.vacuous) {
  /**
   * §五十三.3's continuation. Without a compiler this script cannot know a function's span, and the only
   * alternative is the brace counter that produced 14 wrong spans. Printing a number derived from that
   * would be worse than printing nothing: it looks like a measurement.
   */
  console.log(`src     : ${SOURCE}`)
  console.log('VACUOUS — no TypeScript compiler is resolvable, so no span can be measured.')
  console.log('This is NOT a pass: the brace counter is not a substitute (measured: 14 spans wrong).')
  console.log('Install typescript at the workspace root (this package declares no dependency on purpose).')
  process.exit(2)
}

const { declarations, byName, mutableReads, calleesOf } = measuredResult
const functions = declarations.filter((declaration) => declaration.top)
const nested = declarations.filter((declaration) => !declaration.top)

const CONTAINER_UNITS = new Set(['apply'])

const calleeCache = new Map()
const calleesOfName = (name) => {
  if (!calleeCache.has(name)) calleeCache.set(name, calleesOf(byName.get(name).node))
  return calleeCache.get(name)
}

/** `{U} ∪ callees(U)` transitively — the units that have to travel together. */
function closureOf(name) {
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
 * The label names the LARGEST unit in `closure(U) \ {U}`: the biggest thing that must travel with it.
 *
 * Two earlier shapes were wrong and `v347` caught both — naming the largest member of the whole closure
 * made a leader name ITSELF (「与 collectDebugStatus 同簇」 printed on `collectDebugStatus`), and naming a
 * chain's topmost member cycled, because closure containment is not a partition.
 */
function labelOf(name) {
  const others = [...closureOf(name)].filter((member) => member !== name).map((member) => byName.get(member))
  if (others.length === 0) return undefined
  return others.sort((left, right) => (right.end - right.line) - (left.end - left.line) || left.line - right.line)[0].name
}

/** The five executable shapes. Each names a different obstacle, so an executor knows what to do. */
const whyOf = (declaration) => {
  if (!declaration.top) return '体内声明（须先提升到模块级，非纯移动）'
  if (CONTAINER_UNITS.has(declaration.name)) return '容器（不搬动；随簇搬动只增加 import）'
  const mutables = mutableReads(declaration.node)
  if (mutables.length > 0) {
    return `依赖 apply() 赋值的模块级状态 ${mutables.join('、')}（不可搬；搬迁须先注入）`
  }
  const label = labelOf(declaration.name)
  if (label === undefined) return '无前置（搬动后容器只多一行 import）'
  return `与 ${label} 同簇（必须一起搬）`
}

/** Callers of a unit that live outside its own body — the `responsibility` column. */
const callersOf = (declaration) => {
  const callers = new Set()
  for (const other of declarations) {
    if (other.name === declaration.name) continue
    if (!calleesOfName(other.name).includes(declaration.name)) continue
    callers.add(other.name)
  }
  /** A call at module scope (a top-level `await`/initializer) has no owning function. */
  const pattern = new RegExp(`(^|[^\\w$.])${declaration.name.replace(/\$/gu, '\\$')}\\s*\\(`, 'u')
  const inAnyFunction = (index) => declarations.some((other) => index + 1 >= other.line && index + 1 <= other.end)
  for (let i = 0; i < lines.length; i += 1) {
    if (i + 1 >= declaration.line && i + 1 <= declaration.end) continue
    if (!pattern.test(lines[i])) continue
    if (!inAnyFunction(i)) {
      const trimmed = lines[i].trim()
      if (!trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) callers.add('(module scope)')
    }
  }
  return [...callers].sort()
}

const rows = declarations.map((declaration) => {
  const callers = callersOf(declaration)
  return {
    name: declaration.name,
    line: declaration.line,
    end: declaration.end,
    exported: declaration.exported,
    top: declaration.top,
    responsibility:
      callers.length === 0
        ? 'entry：apply() 或注册面直接调用'
        : `被 ${callers.slice(0, 6).join('、')}${callers.length > 6 ? ` 等 ${callers.length} 处` : ''} 调用`,
    why: whyOf(declaration),
    /** 标记字段来源，免得下一位读者把它当成人工判断。 */
    derivedFrom: 'call-graph',
  }
})

const measured = { lines: countLines(lines), functions: functions.length, nested: nested.length }
const manifest = {
  generatedFrom: 'src/index.ts',
  derivedFrom: 'call-graph+typescript',
  measured,
  compiler: { version: measuredResult.version, resolvedFrom: measuredResult.compilerPath ?? null },
  units: rows,
}

let ceiling
try {
  ceiling = JSON.parse(readFileSync(CEILING, 'utf8'))
} catch {
  ceiling = { lines: measured.lines, functions: measured.functions, history: [] }
}

if (process.argv.includes('--raise-ceiling')) {
  /**
   * ── RAISING IS POSSIBLE, BUT NEVER SILENT ──────────────────────────────────────────────────────
   *
   * A ceiling that can only go down is right; a ceiling with NO way to account for a legitimate
   * addition gets deleted the first time someone adds a function. So raising exists and requires a
   * written reason, which lands in `history` where a reviewer reads it next to the old number.
   */
  const reasonIndex = process.argv.indexOf('--reason')
  const reason = reasonIndex >= 0 ? process.argv[reasonIndex + 1] : undefined
  if (reason === undefined || reason.trim() === '') {
    console.error('--raise-ceiling requires --reason "<why this growth is legitimate>"')
    process.exit(1)
  }
  const next = { ...ceiling, history: [...(ceiling.history ?? [])] }
  if (measured.lines > ceiling.lines) {
    next.history.push({ at: new Date().toISOString(), field: 'lines', from: ceiling.lines, to: measured.lines, reason, raised: true })
    next.lines = measured.lines
  }
  if (measured.functions > ceiling.functions) {
    next.history.push({ at: new Date().toISOString(), field: 'functions', from: ceiling.functions, to: measured.functions, reason, raised: true })
    next.functions = measured.functions
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(CEILING, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  console.log(`raised ceiling to ${next.lines} lines / ${next.functions} functions — reason recorded`)
  process.exit(0)
}

if (process.argv.includes('--write')) {
  mkdirSync(dirname(MANIFEST), { recursive: true })
  /** The ratchet only TIGHTENS: a measurement below the ceiling lowers it; a measurement above it is a
   * failure the caller must fix, never a ceiling bump (that would make the gate a rubber stamp). */
  const next = { ...ceiling }
  if (measured.lines < ceiling.lines) {
    next.lines = measured.lines
    next.history = [...(ceiling.history ?? []), { at: new Date().toISOString(), field: 'lines', from: ceiling.lines, to: measured.lines, raised: false }]
  }
  if (measured.functions < ceiling.functions) {
    next.functions = measured.functions
    next.history = [...(next.history ?? []), { at: new Date().toISOString(), field: 'functions', from: ceiling.functions, to: measured.functions, raised: false }]
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(CEILING, `${JSON.stringify({ lines: next.lines, functions: next.functions, nested: measured.nested, history: next.history ?? [] }, null, 2)}\n`, 'utf8')
  console.log(`wrote manifest (${measured.functions} top-level + ${measured.nested} nested) and ceiling ${next.lines} lines / ${next.functions} functions`)
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
  const measuredNames = new Set(declarations.map((declaration) => declaration.name))
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

console.log(`index-ratchet: ${measured.lines} lines / ${measured.functions} functions (+${measured.nested} nested) ` +
  `(ceiling ${ceiling.lines} / ${ceiling.functions}) · compiler ${measuredResult.version}`)
if (failures.length > 0) {
  console.log('\nFAIL:')
  for (const line of failures) console.log(`  ❌ ${line}`)
  process.exit(1)
}
console.log('OK — under both ceilings, every top-level function is registered, manifest is current.')
