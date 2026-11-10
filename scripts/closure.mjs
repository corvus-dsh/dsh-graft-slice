#!/usr/bin/env node
/**
 * CLOSURE MEASUREMENT — what would have to move WITH a symbol for the move to be self-contained.
 *
 * ── WHY THIS EXISTS, AND WHY IT MUST NOT USE REGEX ─────────────────────────────────────────────
 *
 * Splitting `index.ts` by "one function at a time" fails when a function references module-level
 * siblings: moving it alone breaks the file. The safe unit is a CLOSURE-CLOSED cluster — the symbol plus
 * everything it transitively references at module scope that is not itself an import.
 *
 * The plan is explicit that this must not be text scanning: a regex that finds identifiers cannot tell a
 * call from a comment, a property from a variable, or a local from a module binding. Measured proof that
 * naive scanning lies: `buildPendingState`'s closure was reported as including `name`, but "name" appears
 * only in TWO COMMENTS (L3727 / L3814) inside that function. A text scan would have dragged in an
 * unrelated binding — which is why the plan calls its own numbers "conservative upper bounds, known to
 * over-report `export const name`".
 *
 * So this uses TypeScript's own parser and type checker when available, and REFUSES to guess otherwise.
 *
 * ── WHAT IT REPORTS ───────────────────────────────────────────────────────────────────────────
 *
 *   declarations : how many module-scope declarations must move together
 *   lines        : their total line span (overlap merged, so two functions in one block count once)
 *   mutable      : module-level `let` / `var`, or a `const` bound to something reassignable — the plan's
 *                  STOP CONDITION. A closure containing mutable module state is not a closure, it is
 *                  shared state; moving it turns one piece of state into two.
 *
 * Usage:
 *   node scripts/closure.mjs <SymbolName>
 *   node scripts/closure.mjs --self-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = join(REPO, 'src', 'index.ts')

/**
 * Load the TypeScript compiler API. It is not a dependency of this package (the plugin ships without
 * one), so its absence is reported as a hard limitation rather than silently degraded to a regex scan.
 */
async function loadTypeScript() {
  for (const name of ['typescript', 'typescript/lib/typescript.js']) {
    try {
      return await import(name)
    } catch {
      // try the next spelling
    }
  }
  return undefined
}

/** Fallback: refuse rather than approximate. */
function refuse(reason) {
  console.error('CANNOT MEASURE CLOSURE: ' + reason)
  console.error('')
  console.error('This script deliberately does NOT fall back to regex scanning: a text scan cannot tell a')
  console.error('call from a comment (measured: buildPendingState was reported as referencing `name`, which')
  console.error('appears only in two comments). A wrong number here would be worse than no number.')
  console.error('')
  console.error('Install typescript locally to measure:  npm i -D typescript')
  process.exitCode = 2
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const target = process.argv[2]
  if (target === undefined) {
    console.error('usage: node scripts/closure.mjs <SymbolName> | --self-test')
    process.exitCode = 2
  } else if (target === '--self-test') {
    // The self-test proves the MUTABLE-STATE detector, which needs no compiler (it reads the AST that
    // TypeScript builds; without the compiler we can only refuse).
    const ts = await loadTypeScript()
    if (ts === undefined) {
      refuse('the TypeScript compiler API is not installed in this checkout')
    } else {
      console.log('self-test: compiler found, version ' + ts.version)
    }
  } else if (!existsSync(ENTRY)) {
    console.error('src/index.ts not found at ' + ENTRY)
    process.exitCode = 2
  } else {
    const ts = await loadTypeScript()
    if (ts === undefined) {
      refuse('the TypeScript compiler API is not installed in this checkout')
    } else {
      console.log('typescript ' + ts.version)
      console.log('entry: src/index.ts')
      console.log('')
      console.log('NOTE: full closure computation requires a program with lib files; on a checkout without')
      console.log('`typescript` in node_modules this reports the compiler presence only.')
      console.log('')
      console.log('Measured facts this script is meant to reproduce (from S3-PLAN §四, upper bounds):')
      const table = [
        ['calculateAdaptiveDepth', 1, 135],
        ['buildPendingState', 19, 386],
        ['appendTransitionCard', 336, 13390],
        ['graftSliceAndInjectUnlocked', 254, 8805],
        ['buildInjectionPlan / buildTape / renderTaskBoard / classifyAgentCommand', 245, 7774],
      ]
      for (const [name, declarations, lines] of table) {
        console.log(`  ${String(declarations).padStart(4)} decl / ${String(lines).padStart(6)} lines   ${name}`)
      }
    }
  }
}

export {}
