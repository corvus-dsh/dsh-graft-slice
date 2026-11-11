#!/usr/bin/env node
/**
 * ── IMPORT-EDGE INVARIANT — the gap verify-pure-move.mjs cannot see ────────────────────────────────
 *
 * `verify-pure-move.mjs` proves the CONTENT-line multiset is unchanged. By definition a content line
 * excludes any line starting with `import ` or `export ` — because a pure move necessarily produces
 * that plumbing. That exclusion is correct for its purpose and it is also a hole:
 *
 *     measured 2026-11-11: injecting `import { ledgerRecord } from './ledger.js'` at the top of
 *     src/core/adaptive-depth.ts leaves verify-pure-move printing IDENTICAL.
 *
 * So "a pure move introduces no new dependency" is NOT something that script can testify to. This one
 * can. It compares the SET OF IMPORT EDGES (module → module, plus the imported symbol names) between two
 * revisions, and reports every edge that appeared or disappeared.
 *
 * ── WHAT AN EDGE IS ─────────────────────────────────────────────────────────────────────────────────
 *
 *   from: the .ts-bearing file's path relative to src/
 *   spec: the module specifier, normalised (`./x.js` and `./x` are the same module)
 *   names: the imported binding names, sorted (`*` for a namespace import, `default` for a default import)
 *
 * A move legitimately ADDS edges in the new module (it now imports what it used) and REMOVES edges in
 * `src/index.ts` (that file now re-exports instead of declaring). The invariant is therefore about the
 * WHOLE TREE plus a reported per-file delta — not "no change anywhere", which a real move never satisfies.
 *
 * ── THE RULE THIS ENABLES (proposed, NOT adopted — waiting for the user's ruling) ────────────────────
 *
 *   A target moved out under a MODULE-SIZE criterion must, in the same commit, prove either
 *   (a) it is a pure move (verify-pure-move) AND the import-edge delta is explainable, or
 *   (b) it moved as a whole closure cluster (no new edge to a symbol outside that cluster).
 *
 * Usage:
 *   node scripts/verify-import-edges.mjs                      # working tree vs HEAD
 *   node scripts/verify-import-edges.mjs --against HEAD~1
 *   node scripts/verify-import-edges.mjs --self-test           # prove it can fail
 *   node scripts/verify-import-edges.mjs --cluster <name>...   # assert no edge escapes the named set
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')

/** Collapse `./x.js` / `./x.ts` / `./x` to one key so a move that only changes the extension is not noise. */
export function normaliseSpec(spec) {
  return spec.replace(/\.(?:js|ts|mjs|cjs)$/u, '')
}

/**
 * Parse the import edges of one file. Regex, not a parser — deliberately: this runs in CI where
 * `typescript` is absent BY DESIGN (the same reason closure.mjs exits 2 there). Import syntax is
 * regular enough for this purpose, and --self-test pins the shapes that matter.
 */
export function edgesOf(text) {
  const edges = []
  const push = (spec, names) => {
    if (!spec.startsWith('.')) return // a package import: not part of this tree's edge graph
    edges.push({ spec: normaliseSpec(spec), names: [...new Set(names)].sort().join(',') })
  }

  // import ... from 'x'   |   import 'x'
  // The clause may span lines (a long `{ a, b, c }` list), but it must NOT swallow the next `import`.
  for (const match of text.matchAll(/^\s*import\s+(?:type\s+)?((?:(?!^\s*(?:import|export)\b)[\s\S])*?)\s*from\s*['"]([^'"]+)['"]/gmu)) {
    const clause = match[1].trim()
    const names = []
    const braced = /\{([\s\S]*?)\}/u.exec(clause)
    if (braced) {
      for (const part of braced[1].split(',')) {
        const name = part.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0]?.trim()
        if (name) names.push(name)
      }
    }
    const head = clause.split('{')[0].replace(/,\s*$/u, '').trim()
    if (head) {
      if (head === '*') names.push('*')
      else if (head.startsWith('* as ')) names.push('*')
      else if (head && !/^type$/u.test(head)) names.push('default')
    }
    push(match[2], names)
  }
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gmu)) push(match[1], ['(side-effect)'])
  for (const match of text.matchAll(/^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gmu)) {
    push(match[1], ['(re-export)'])
  }
  return edges
}

function sourceFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.ts(?:\.|$)/u.test(entry)) continue
      out.push(full)
    }
  }
  walk(dir)
  return out
}

/** Every edge in a tree, keyed `file -> spec [names]`. */
export function edgeSet(readFile) {
  const set = new Map()
  for (const file of sourceFiles(SRC)) {
    const key = relative(SRC, file).split('\\').join('/')
    for (const edge of edgesOf(readFile(file))) {
      set.set(`${key} -> ${edge.spec} [${edge.names}]`, edge)
    }
  }
  return set
}

function gitShow(rev, path) {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return undefined
  }
}

function edgeSetAt(rev) {
  const list = execFileSync('git', ['ls-tree', '-r', '--name-only', rev, 'src'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter((line) => /\.ts(?:\.|$)/u.test(line))
  const set = new Map()
  for (const path of list) {
    const text = gitShow(rev, path)
    if (text === undefined) continue
    const key = path.replace(/^src\//u, '')
    for (const edge of edgesOf(text)) set.set(`${key} -> ${edge.spec} [${edge.names}]`, edge)
  }
  return set
}

function diff(before, after) {
  const added = [...after.keys()].filter((key) => !before.has(key)).sort()
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort()
  return { added, removed }
}

function selfTest() {
  console.log('── self-test: the checker must be able to fail ──')
  let ok = true
  const assert = (label, condition) => {
    if (!condition) ok = false
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`)
  }

  const base = edgeSet(() => '')
  const text = `import { a, b } from './x.js'\nimport type { T } from './y'\nimport def from './z.js'\nimport './side.js'\nexport { q } from './r.js'\n`
  const parsed = edgesOf(text)
  assert('parses 5 edges', parsed.length === 5)
  assert('normalises .js away', parsed[0].spec === './x')
  assert('captures named bindings', parsed[0].names === 'a,b')
  assert('captures type-only import', parsed[1].names === 'T')
  assert('captures default import', parsed[2].names === 'default')
  assert('captures side-effect import', parsed[3].names === '(side-effect)')
  assert('captures re-export', parsed[4].names === '(re-export)')
  assert('ignores package imports', edgesOf(`import { join } from 'node:path'\n`).length === 0)

  // a new edge must show up as ADDED
  const setA = new Map([['a.ts -> ./x [a]', {}]])
  const setB = new Map([['a.ts -> ./x [a]', {}], ['a.ts -> ./ledger [ledgerRecord]', {}]])
  const d = diff(setA, setB)
  assert('a new import is reported as ADDED', d.added.length === 1 && d.added[0].includes('ledger'))

  // the exact failure verify-pure-move cannot see
  console.log('  -- the gap this exists for: a NEW import must be visible --')
  const withNewImport = edgesOf(`import { ledgerRecord } from './ledger.js'\n`)
  assert('the injected ledger import is visible here', withNewImport.some((edge) => edge.spec === './ledger'))

  const verdict = ok ? 'SELF-TEST PASS' : 'SELF-TEST FAIL'
  console.log(verdict)
  if (!ok) process.exit(1)
}

const args = process.argv.slice(2)
if (args.includes('--self-test')) {
  selfTest()
  process.exit(0)
}

const againstIndex = args.indexOf('--against')
const against = againstIndex >= 0 ? args[againstIndex + 1] : 'HEAD'

const before = edgeSetAt(against)
const after = edgeSet((file) => readFileSync(file, 'utf8'))
const { added, removed } = diff(before, after)

console.log(`ref     : ${against}   edges: ${before.size}`)
console.log(`tree    : working   edges: ${after.size}`)
console.log(`\nADDED   (${added.length}):`)
for (const line of added) console.log(`  + ${line}`)
console.log(`REMOVED (${removed.length}):`)
for (const line of removed) console.log(`  - ${line}`)

// Optionally assert that no new edge points at a symbol outside a named cluster.
const clusterIndex = args.indexOf('--cluster')
if (clusterIndex >= 0) {
  const allowed = new Set(args.slice(clusterIndex + 1).flatMap((value) => value.split(',')))
  const escaped = added.filter((line) => ![...allowed].some((name) => line.includes(name)))
  console.log(`\nCLUSTER CHECK against ${allowed.size} allowed symbol(s):`)
  console.log(escaped.length === 0 ? '  OK: no new edge escapes the declared cluster' : `  FAIL: ${escaped.length} edge(s) escape:\n${escaped.map((line) => `    ${line}`).join('\n')}`)
  if (escaped.length > 0) process.exit(1)
}

if (added.length > 0) {
  console.log('\nEvery added edge is a NEW DEPENDENCY unless it points at a symbol that moved with this commit.')
  console.log('verify-pure-move.mjs cannot see these by design (it excludes import/export lines).')
}
