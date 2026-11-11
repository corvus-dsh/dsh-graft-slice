#!/usr/bin/env node
/**
 * ── WHAT THE TYPE CHECKER SAYS, SINCE NOTHING ELSE DOES ────────────────────────────────────────────
 *
 * This project never runs `tsc`. The build passes every source file through
 * `stripTypeScriptTypes`, which removes type syntax and performs NO symbol checking whatsoever. So:
 *
 *   · 782 green tests prove RUNTIME behaviour, not type correctness;
 *   · a move that "compiles" only proves "no syntax error", not "no broken type reference";
 *   · breaking a type reference costs nothing at build time and may cost nothing at test time.
 *
 * That is not a hypothesis. `SessionEventLike` is declared and exported by `core/watermark.ts:276` and
 * imported normally by two other modules, yet `index.ts` never imported it while referencing it 36 times
 * — and the suite stayed green.
 *
 * Usage:
 *   node scripts/type-check.mjs                # summary: total errors, per-code, per-file
 *   node scripts/type-check.mjs --code 2304    # only that diagnostic code
 *   node scripts/type-check.mjs --grep NAME    # only diagnostics whose message mentions NAME
 *   node scripts/type-check.mjs --json
 *
 * It reads typescript from the workspace root (this package declares no dependencies, exactly like
 * closure.mjs) and exits 2 with a named reason when the compiler is unavailable — never a silent zero.
 */
import { createRequire } from 'node:module'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const codeIndex = args.indexOf('--code')
const onlyCode = codeIndex >= 0 ? Number(args[codeIndex + 1]) : undefined
const grepIndex = args.indexOf('--grep')
const onlyGrep = grepIndex >= 0 ? args[grepIndex + 1] : undefined

let ts
try {
  const require = createRequire(`${REPO}/`)
  ts = require('typescript')
} catch {
  console.error('typescript is not installed — the type check cannot run (this is a RESOURCE condition, not a pass)')
  process.exit(2)
}

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.ts(?:\.|$)/u.test(entry)) files.push(full)
  }
}
walk(SRC)

const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: false,
  noEmit: true,
  skipLibCheck: true,
  allowJs: false,
})
const diagnostics = ts.getPreEmitDiagnostics(program)

const rows = []
for (const diagnostic of diagnostics) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  if (onlyCode !== undefined && diagnostic.code !== onlyCode) continue
  if (onlyGrep !== undefined && !message.includes(onlyGrep)) continue
  const file = diagnostic.file === undefined ? '(global)' : relative(SRC, diagnostic.file.fileName).split('\\').join('/')
  let line
  if (diagnostic.file !== undefined && diagnostic.start !== undefined) {
    line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
  }
  rows.push({ file, line, code: diagnostic.code, message })
}

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, diagnostics: rows }, null, 1))
  process.exit(0)
}

const byCode = new Map()
const byFile = new Map()
const sampleByCode = new Map()
for (const row of rows) {
  byCode.set(row.code, (byCode.get(row.code) ?? 0) + 1)
  byFile.set(row.file, (byFile.get(row.file) ?? 0) + 1)
  if (!sampleByCode.has(row.code)) sampleByCode.set(row.code, row.message)
}

console.log(`type-check: ${rows.length} diagnostic(s)${onlyCode === undefined ? '' : ` with code ${onlyCode}`}${onlyGrep === undefined ? '' : ` mentioning "${onlyGrep}"`}`)
console.log('\nby code:')
for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
  // the sample must come from a diagnostic ALREADY FILTERED, or the label describes a different row
  console.log(`  ${String(code).padEnd(8)} ${String(count).padStart(4)}  ${(sampleByCode.get(code) ?? '').slice(0, 70)}`)
}
console.log('\nby file:')
for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${file.padEnd(40)} ${String(count).padStart(4)}`)
}

if (onlyGrep !== undefined || onlyCode !== undefined) {
  console.log('\nmatching diagnostics:')
  for (const row of rows.slice(0, 40)) console.log(`  ${row.file}:${row.line}  [${row.code}] ${row.message.slice(0, 110)}`)
  if (rows.length > 40) console.log(`  …and ${rows.length - 40} more`)
}
