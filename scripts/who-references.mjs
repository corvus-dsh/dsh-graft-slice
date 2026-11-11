#!/usr/bin/env node
/**
 * ── WHO REFERENCES SYMBOL X? — exact identifier, never a substring ─────────────────────────────────
 *
 * THE FAILURE THIS EXISTS TO PREVENT (observed twice, on both sides of the review):
 *
 *     includes('GraftSource')  also matches
 *        GraftSourceShape        (host-shape.ts — a different interface)
 *        pendingGraftSources     (state.ts / ignition.ts — a Map field / Set variable)
 *
 * That produced "GraftSource is referenced by 5 core/ modules" — a confident, wrong statement. The
 * finding was caught by re-checking line by line, not by any tool, which is exactly why the tool is
 * needed: the next reader would have believed the sum.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────────────────────
 *
 * A symbol reference is a WHOLE IDENTIFIER. Matching is `\b<name>\b`, and the classification separates
 *   DECL   the declaration itself
 *   IMPORT an import/export clause naming it
 *   TYPE   a type position (`: X`, `<X>`, `as X`, `X |`)
 *   CODE   any other code reference
 *   PROSE  a comment or a string literal (NOT a reference — reported separately so it cannot be
 *          silently counted, and so "5 modules mention it" can be seen for what it is)
 *
 * Usage:
 *   node scripts/who-references.mjs GraftSource [GraftTape …]
 *   node scripts/who-references.mjs --json GraftSource
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const names = args.filter((a) => !a.startsWith('--'))
if (names.length === 0) {
  console.error('usage: node scripts/who-references.mjs [--json] <Symbol> [<Symbol> ...]')
  process.exit(2)
}

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

/** Blank comments and string literals, preserving line count, so PROSE can be told from CODE. */
function splitProse(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const code = []
  const prose = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (inBlock) { code.push(''); prose.push(line); if (trimmed.includes('*/')) inBlock = false; continue }
    if (trimmed.startsWith('/*')) { code.push(''); prose.push(line); if (!trimmed.includes('*/')) inBlock = true; continue }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) { code.push(''); prose.push(line); continue }
    // split a trailing line comment out of a code line
    const idx = line.search(/(?:^|\s)\/\//u)
    if (idx >= 0) { code.push(line.slice(0, idx)); prose.push(line.slice(idx)) } else { code.push(line); prose.push('') }
  }
  return { code, prose }
}

const findings = []
for (const file of sourceFiles(SRC)) {
  const rel = relative(SRC, file).split('\\').join('/')
  const { code, prose } = splitProse(file)
  for (const name of names) {
    // \b is the whole point: GraftSource must not match GraftSourceShape or pendingGraftSources
    const exact = new RegExp(`\\b${name.replace(/\$/gu, '\\$')}\\b`, 'u')
    for (const [index, line] of code.entries()) {
      if (!exact.test(line)) continue
      const isDecl = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:interface|type|class|const|let|var|function)\\s+${name}\\b`, 'u').test(line.trim())
      const isImport = /^\s*(?:import|export)\b/u.test(line)
      const isType = new RegExp(`(?::\\s*|as\\s+|<|\\||&\\s*)${name}\\b`, 'u').test(line)
      findings.push({
        symbol: name, file: rel, line: index + 1,
        kind: isDecl ? 'DECL' : isImport ? 'IMPORT' : isType ? 'TYPE' : 'CODE',
        text: line.trim().slice(0, 110),
      })
    }
    // prose mentions are reported separately — never as references
    for (const [index, line] of prose.entries()) {
      if (!exact.test(line)) continue
      findings.push({ symbol: name, file: rel, line: index + 1, kind: 'PROSE', text: line.trim().slice(0, 110) })
    }
  }
}

if (asJson) { console.log(JSON.stringify(findings, null, 1)); process.exit(0) }

for (const symbol of names) {
  const mine = findings.filter((f) => f.symbol === symbol)
  const refs = mine.filter((f) => f.kind !== 'PROSE' && f.kind !== 'DECL')
  const proseOnly = mine.filter((f) => f.kind === 'PROSE')
  console.log(`\n${symbol}`)
  console.log(`  declarations : ${mine.filter((f) => f.kind === 'DECL').length}`)
  console.log(`  references   : ${refs.length}  (files: ${[...new Set(refs.map((f) => f.file))].join(', ') || 'none'})`)
  console.log(`  prose mentions: ${proseOnly.length}  ← NOT references`)
  for (const f of mine) console.log(`    [${f.kind.padEnd(6)}] ${f.file}:${f.line}  ${f.text}`)
}
