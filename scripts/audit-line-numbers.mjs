#!/usr/bin/env node
/**
 * ── HARDCODED LINE-NUMBER AUDIT ────────────────────────────────────────────────────────────────────
 *
 * Two moves have already broken coordinate-based assertions, twice each:
 *   −288 (GraftConfig) and −16 (text tools). Each time only the two failures that HAPPENED TO BE RED
 *   were fixed — which leaves the next move to break the next two.
 *
 * This scans every test file for three shapes and classifies each:
 *
 *   FRAGILE   a literal line number used to ADDRESS source (start:/end:, '--block …, 1234, 5678',
 *             lines[1234], L1234 in an assertion about position)
 *   SAFE      a number that is a SPAN SIZE (lines: 496, = 288 行) or a count — these are the invariants
 *             and are SUPPOSED to be hardcoded
 *   LOCATED   the test finds the range itself (a regex search over the source, or a tool span)
 *
 * Output is a table, so the decision is made once per entry instead of once per breakage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_DIR = join(ROOT, 'test')

/** A line number is a plausible source address only in this range. */
const MIN = 100
const MAX = 20000

const files = readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.mjs') && statSync(join(TEST_DIR, name)).isFile())

const findings = []

/**
 * A line number inside a COMMENT is not an address — it is prose describing history.
 * `v135:170` says "ensureTurn (L3467..L3474 after the GraftConfig move shifted every line below" —
 * that sentence is TRUE about the past and cannot break. Only a number the CODE uses to address the
 * source can break, so comments are excluded before classification.
 */
function codeLinesOf(source) {
  const out = []
  let inBlock = false
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (inBlock) { out.push(''); if (trimmed.includes('*/')) inBlock = false; continue }
    if (trimmed.startsWith('/*')) { out.push(''); if (!trimmed.includes('*/')) inBlock = true; continue }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) { out.push(''); continue }
    out.push(line)
  }
  return out
}

for (const name of files) {
  const source = codeLinesOf(readFileSync(join(TEST_DIR, name), 'utf8')).join('\n')
  const lines = source.split('\n')

  for (const [index, line] of lines.entries()) {
    const where = `${name}:${index + 1}`

    // ── shape 1: closure.mjs --block with literal numbers ──
    const block = /--block['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/u.exec(line)
    if (block !== null) {
      findings.push({ where, kind: 'FRAGILE', what: `--block ${block[1]} ${block[2]}..${block[3]}`, text: line.trim() })
      continue
    }

    // ── shape 2: object literal start/end or lines with a source-like number ──
    const span = /\b(start|end|from|to)\s*:\s*(\d{3,5})\b/u.exec(line)
    if (span !== null && Number(span[2]) >= MIN && Number(span[2]) <= MAX) {
      findings.push({ where, kind: 'FRAGILE', what: `${span[1]}: ${span[2]}`, text: line.trim() })
      continue
    }

    // ── shape 3: array indexing with a literal ──
    const indexing = /\b(lines|src|source)\[\s*(\d{3,5})\s*\]/u.exec(line)
    if (indexing !== null && Number(indexing[2]) >= MIN && Number(indexing[2]) <= MAX) {
      findings.push({ where, kind: 'FRAGILE', what: `${indexing[1]}[${indexing[2]}]`, text: line.trim() })
      continue
    }

    // ── shape 4: an assertion mentioning L#### ──
    const literal = /\bL(\d{3,5})\b/u.exec(line)
    if (literal !== null && Number(literal[1]) >= MIN && Number(literal[1]) <= MAX) {
      // a size assertion ("= 288 行") is a SIZE, not an address
      const isSize = /行|lines/u.test(line)
      findings.push({
        where,
        kind: isSize ? 'SAFE' : 'FRAGILE',
        what: `L${literal[1]}`,
        text: line.trim(),
      })
    }
  }
}

// ── locate the tests that FIND their range instead of remembering it ──
const located = []
for (const name of files) {
  const source = readFileSync(join(TEST_DIR, name), 'utf8')
  if (/for \(let index = 0; index < lines\.length; index\+\+\)/u.test(source) || /\.findIndex\(/u.test(source)) {
    if (/assert\.match|assert\.equal/u.test(source)) located.push(name)
  }
}

const fragile = findings.filter((f) => f.kind === 'FRAGILE')
const safe = findings.filter((f) => f.kind === 'SAFE')

console.log('=== FRAGILE: a literal line number used to ADDRESS source ===')
if (fragile.length === 0) console.log('  (none)')
for (const f of fragile) {
  console.log(`  ${f.where.padEnd(42)} ${f.what.padEnd(24)} ${JSON.stringify(f.text.slice(0, 80))}`)
}

console.log('\n=== SAFE: the number is a SIZE or COUNT (an invariant, keep it) ===')
if (safe.length === 0) console.log('  (none)')
for (const f of safe) console.log(`  ${f.where.padEnd(42)} ${f.what.padEnd(24)} ${JSON.stringify(f.text.slice(0, 70))}`)

console.log('\n=== LOCATED: the test searches for its target ===')
for (const name of located) console.log(`  ${name}`)

console.log(`\nsummary: FRAGILE ${fragile.length} / SAFE ${safe.length} / LOCATED ${located.length}`)
