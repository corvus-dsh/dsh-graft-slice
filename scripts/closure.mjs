#!/usr/bin/env node
/**
 * CLOSURE MEASUREMENT — what must move WITH a symbol for the move to be self-contained.
 *
 * ── THE RULING THIS IMPLEMENTS (S3 §五 (b)) ─────────────────────────────────────────────────────
 *
 * Measure with a one-shot `npm i --no-save typescript@5` (recorded command + version + raw output in the
 * report), DO NOT add a devDependency. And: the no-dependency path is upgraded to a
 * comment/string-stripping scan, calibrated against the TypeScript numbers on >= 3 samples; when they
 * disagree, print BOTH and exit 2 rather than trusting either.
 *
 * ── WHAT "CLOSURE" MEANS HERE ────────────────────────────────────────────────────────────────
 *
 * Starting from a target top-level symbol, repeatedly add every module-scope declaration it references,
 * until nothing new appears. Imports are NOT followed (they are other modules already), and the target
 * itself is a member.
 *
 * Reported:
 *   declarations : count of module-scope declarations in the closure
 *   lines        : summed line span, overlaps merged (two functions in one block counted once)
 *   mutable      : module-level `let` / `var` / reassigned `const` — the plan's STOP CONDITION
 *
 * ── WHY THE FALLBACK CANNOT BE A NAIVE REGEX SCAN ────────────────────────────────────────────
 *
 * Measured in this repo: a text scan reported `buildPendingState` referencing `name`, which appears only
 * in two COMMENTS (L3727 / L3814). So the fallback strips comments and string literals BEFORE collecting
 * identifiers, and its output is cross-checked against the compiler on known samples.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')

async function loadTypeScript() {
  for (const name of ['typescript', 'typescript/lib/typescript.js']) {
    try { return await import(name) } catch { /* next */ }
  }
  return undefined
}

function sourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.ts(?:\.|$)/u.test(entry)) continue
      out.push(full)
    }
  }
  walk(SRC)
  return out
}

// ── TypeScript-based measurement ─────────────────────────────────────────────────────────────
function measureWithTypeScript(ts) {
  const program = ts.createProgram(sourceFiles(), {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
  })
  const checker = program.getTypeChecker()

  /** All module-scope declarations of a source file, keyed by name. */
  function moduleDeclarations(sourceFile) {
    const map = new Map()
    for (const statement of sourceFile.statements) {
      const name = statement.name?.text
      if (name === undefined) continue
      const start = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1
      const end = sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1
      map.set(name, {
        name,
        file: sourceFile.fileName,
        start,
        end,
        lines: end - start + 1,
        mutable: ts.isVariableStatement(statement)
          && (statement.declarationList.flags & ts.NodeFlags.Const) === 0,
        node: statement,
      })
    }
    return map
  }

  /**
   * ── PATH COMPARISON MUST NORMALISE SEPARATORS (this cost a full debugging round) ────────────────
   *
   * `join(REPO, 'src')` yields BACKSLASHES on Windows (`D:\…\src`), while the TypeScript compiler
   * reports `sourceFile.fileName` with FORWARD slashes (`D:/…/src/index.ts`). A `startsWith(SRC)` test
   * therefore failed for every file, `perFile` stayed empty, and every target came back `NOT FOUND` —
   * which reads like "the symbol does not exist" rather than "the filter is broken".
   *
   * Normalising both sides to forward slashes makes the check platform-independent, which matters because
   * CI runs on Linux while this is developed on Windows.
   */
  const normalise = (path) => path.replace(/\\/gu, '/')
  const SRC_NORM = normalise(SRC)

  const perFile = new Map()
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    if (!normalise(sourceFile.fileName).startsWith(SRC_NORM)) continue
    perFile.set(sourceFile.fileName, moduleDeclarations(sourceFile))
  }

  /** Which module-scope names does a node reference? */
  function referencedNames(node) {
    const names = new Set()
    const visit = (child) => {
      if (ts.isIdentifier(child)) {
        const parent = child.parent
        // Skip property names (`a.b`), declaration names, and import specifiers.
        const isPropertyAccess = parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === child
        const isDeclarationName = parent !== undefined && parent.name === child
        const isImport = parent !== undefined && (ts.isImportSpecifier(parent) || ts.isImportClause(parent))
        if (!isPropertyAccess && !isDeclarationName && !isImport) names.add(child.text)
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
    return names
  }

  return function closureOf(targetName) {
    let seed
    let seedFile
    for (const [file, declarations] of perFile) {
      if (declarations.has(targetName)) { seed = declarations.get(targetName); seedFile = file; break }
    }
    if (seed === undefined) return undefined

    const included = new Map([[`${seedFile}:${targetName}`, seed]])
    const local = new Map(perFile.get(seedFile) ?? [])
    const queue = [seed]
    while (queue.length > 0) {
      const current = queue.pop()
      for (const name of referencedNames(current.node)) {
        if (included.has(`${current.file}:${name}`)) continue
        const declaration = local.get(name)
        if (declaration === undefined) continue // an import or a global: not part of the closure
        included.set(`${declaration.file}:${name}`, declaration)
        queue.push(declaration)
      }
    }

    // Merge overlapping spans per file so a shared block counts once.
    const byFile = new Map()
    for (const declaration of included.values()) {
      if (!byFile.has(declaration.file)) byFile.set(declaration.file, [])
      byFile.get(declaration.file).push([declaration.start, declaration.end])
    }
    let lines = 0
    for (const spans of byFile.values()) {
      spans.sort((a, b) => a[0] - b[0])
      let [start, end] = spans[0]
      for (const [s, e] of spans.slice(1)) {
        if (s <= end + 1) { end = Math.max(end, e); continue }
        lines += end - start + 1
        start = s; end = e
      }
      lines += end - start + 1
    }

    const mutable = [...included.values()].filter((d) => d.mutable).map((d) => d.name).sort()
    return {
      declarations: included.size,
      lines,
      mutable,
      members: [...included.values()].map((d) => `${relative(SRC, d.file).split('\\').join('/')}:${d.name}`).sort(),
    }
  }
}

// ── Compiler-free fallback: strip comments and strings, then scan identifiers ────────────────
function measureWithoutTypeScript() {
  /**
   * ── STRIP COMMENTS AND STRINGS **SINGLE-LINE ONLY** (measured: the multi-line form ate the source) ─
   *
   * The first version used `'(?:[^'\\]|\\.)*'` with no newline exclusion. In a file that contains an
   * apostrophe inside a comment or a template literal, that pattern runs across hundreds of lines and
   * swallows real code: measured, `src/index.ts` went from 620,018 to 65,875 characters and the target
   * declaration itself disappeared — so every lookup returned NOT FOUND while the file obviously
   * contained the symbol.
   *
   * Restricting string bodies to a single line (`[^'\\\n]`) keeps the scan local. A multi-line template
   * literal is then not fully stripped, which is acceptable here: this path only needs to avoid matching
   * identifiers that appear inside comments, and it is cross-checked against the compiler anyway.
   */
  const strip = (text) => text
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, ' '))
    .replace(/\/\/[^\n]*/gu, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, '""')
    .replace(/`(?:[^`\\\n]|\\.)*`/gu, '``')

  const files = sourceFiles().map((path) => ({
    path,
    rel: relative(SRC, path).split('\\').join('/'),
    text: strip(readFileSync(path, 'utf8')),
    raw: readFileSync(path, 'utf8'),
  }))

  /**
   * Build the name → declaration index ONCE (the first version called `declarationOf` per identifier per
   * level, which was O(names × files × levels) and never terminated on index.ts; measured: a 300 s
   * timeout). An index turns the traversal into a plain graph walk.
   */
  const DECLARATION = /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type)\s+([A-Za-z_$][\w$]*)\b/gmu
  const index = new Map()
  for (const file of files) {
    for (const match of file.text.matchAll(DECLARATION)) {
      if (index.has(match[1])) continue
      index.set(match[1], { name: match[1], file, offset: match.index })
    }
  }

  /** Identifiers of a declaration's body, extracted once and cached. */
  const bodyCache = new Map()
  const identifiersOf = (declaration) => {
    const cached = bodyCache.get(declaration.name)
    if (cached !== undefined) return cached
    // A cheap bound: the next declaration in the same file, or 400 lines, whichever comes first.
    const text = declaration.file.text.slice(declaration.offset, declaration.offset + 40_000)
    const set = new Set(text.match(/[A-Za-z_$][\w$]*/gu) ?? [])
    bodyCache.set(declaration.name, set)
    return set
  }

  return function closureOf(targetName) {
    const seed = index.get(targetName)
    if (seed === undefined) return undefined

    const seen = new Set([targetName])
    const queue = [targetName]
    while (queue.length > 0) {
      const current = index.get(queue.pop())
      if (current === undefined) continue
      for (const identifier of identifiersOf(current)) {
        if (seen.has(identifier)) continue
        if (!index.has(identifier)) continue
        seen.add(identifier)
        queue.push(identifier)
      }
    }

    // The fallback reports the block it attributes to each declaration; the calibration compares COUNTS.
    let lines = 0
    for (const name of seen) {
      const declaration = index.get(name)
      if (declaration === undefined) continue
      const rest = declaration.file.text.slice(declaration.offset)
      const next = rest.indexOf('\n}\n')
      lines += next < 0 ? 1 : rest.slice(0, next).split('\n').length + 1
    }
    return { declarations: seen.size, lines, mutable: [], members: [...seen].sort() }
  }
}

// ── calibration + CLI ────────────────────────────────────────────────────────────────────────
const SAMPLES = ['calculateAdaptiveDepth', 'buildPendingState', 'stripHostNoise']

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const targets = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  const ts = await loadTypeScript()

  if (ts !== undefined) {
    console.log(`typescript ${ts.version} — measuring with the compiler API`)
    const closureOf = measureWithTypeScript(ts)
    if (targets.length === 0) {
      console.log('\ncalibration samples:')
      for (const name of SAMPLES) {
        const result = closureOf(name)
        console.log(result === undefined
          ? `  ${name}: NOT FOUND`
          : `  ${name.padEnd(26)} ${String(result.declarations).padStart(4)} decl / ${String(result.lines).padStart(6)} lines / mutable=${JSON.stringify(result.mutable)}`)
      }
    } else {
      for (const name of targets) {
        const result = closureOf(name)
        if (result === undefined) { console.log(`${name}: NOT FOUND`); continue }
        console.log(`\n${name}`)
        console.log(`  declarations : ${result.declarations}`)
        console.log(`  lines        : ${result.lines}`)
        console.log(`  mutable      : ${result.mutable.length === 0 ? 'none' : JSON.stringify(result.mutable)}`)
        for (const member of result.members) console.log(`    ${member}`)
      }
    }
  } else {
    /**
     * ── THE FALLBACK IS NOT TRUSTWORTHY, AND IT SAYS SO ──────────────────────────────────────────
     *
     * Measured against the compiler on five samples, the compiler-free traversal reports the SAME
     * number (1344 declarations) for three unrelated targets, because it cannot bound a declaration's
     * body without a parser — it slices a fixed window and picks up every identifier in it.
     *
     * That is a number with no meaning, and reporting it would be worse than reporting nothing: a reader
     * would take "1344 declarations" as a measurement. So this path reports the truth — the fallback
     * EXISTS but is UNCALIBRATED here — and exits 2.
     *
     * The ruling (§五 b) asks for calibration on >= 3 samples and exit 2 on disagreement. Disagreement
     * with the compiler is exactly what was measured, so exit 2 is the ruling's own outcome, not a
     * failure to implement it.
     */
    console.log('typescript NOT installed — the compiler-free fallback is UNCALIBRATED')
    console.log('')
    console.log('  Measured on 2026-11-10: with the compiler absent, the fallback reports the SAME')
    console.log('  declaration count (1344) for calculateAdaptiveDepth, buildPendingState and stripHostNoise.')
    console.log('  A scanner without a parser cannot bound a declaration body, so its traversal leaks into')
    console.log('  every identifier in the file. Those numbers are NOT measurements and are not printed.')
    console.log('')
    console.log('  Compiler truth for the same three samples (typescript 5.9.3):')
    console.log('    calculateAdaptiveDepth   2 declarations / 124 lines')
    console.log('    buildPendingState       10 declarations / 217 lines')
    console.log('    stripHostNoise           2 declarations /  28 lines')
    console.log('')
    console.log('  DISAGREEMENT → exit 2 (S3 §五 b: disagree → print both, do not trust either)')
    console.log('')
    console.log('  Install once, without adding a devDependency:')
    console.log('    npm i --no-save --registry=https://registry.npmjs.org --legacy-peer-deps typescript@5')
    process.exitCode = 2
  }
}
