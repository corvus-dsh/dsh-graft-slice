#!/usr/bin/env node
/**
 * N0c — WHICH TESTS GUARD SOURCE TEXT, AND *HOW*? (definition-first inventory)
 *
 * ── WHY THIS FILE EXISTS, AND WHY DEFINITIONS COME FIRST ───────────────────────────────────────
 *
 * The review counted "16 files read src/index.ts as text"; the measurement found 9. Both numbers were
 * right — they counted DIFFERENT SETS. Writing one as the other is how a conclusion got wider than its
 * evidence (rule 31/32). So this script reports THREE separate sets and never merges them:
 *
 *   MENTIONS  — the path appears anywhere in the file: a string, an error message, a comment, a URL to
 *               a DIFFERENT file that merely ends in index.ts. Widest set. Useless for judging risk.
 *
 *   READS     — the file actually obtains the TEXT of src/index.ts (readFileSync / import of the
 *               source, not of ../index.js). This is the set where a position-sensitive assertion could
 *               even exist.
 *
 *   ASSERTS   — a READS file whose assertion's SUBJECT is that source text (or a slice of it). This is
 *               the only set that can silently change verdict when code moves.
 *
 * A file in MENTIONS but not READS cannot be affected by a move. A file in READS but not ASSERTS reads
 * the source without asserting on it (e.g. it counts lines for a report).
 *
 * ── AND ONE MORE AXIS, WHICH IS THE ACTUAL RISK ────────────────────────────────────────────────
 *
 * Within ASSERTS, the direction matters:
 *
 *   POSITIVE  ("must contain X")  — moving X out turns it RED. Loud. Self-announcing.
 *   NEGATIVE  ("must NOT contain X") and EXACTLY-ONCE ("X appears exactly 1 time")
 *             — these are the ones whose SCOPE can be too narrow: a second copy in ANOTHER file keeps
 *               them green. That is the class N0c must widen, and it is what v097 / v114 missed.
 *
 * Usage:  node scripts/inventory-source-guards.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const TEST_DIR = join(REPO, 'test')

/** Every .test.mjs under test/ (flat, which is how this repo lays them out). */
function testFiles() {
  return readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.mjs'))
}

// ── MENTIONS: the path string appears at all ────────────────────────────────────────────────────
const MENTION_PATTERNS = [/src[\\/]index\.ts/u, /'src',\s*'index\.ts'/u, /"src",\s*"index\.ts"/u, /index\.ts/u]

// ── READS: the file obtains the TEXT of src/index.ts ───────────────────────────────────────────
// Deliberately specific: `from '../index.js'` is the BUILT artifact (different file, position-INVARIANT),
// so importing it must NOT count as reading the source.
const READ_PATTERNS = [
  /readFileSync\([^)]*src[\\/]index\.ts/u,
  /readFileSync\([^)]*'index\.ts'[^)]*\)/u,
  /readFileSync\([^)]*"index\.ts"[^)]*\)/u,
  /new URL\('\.\.\/src\/index\.ts'/u,
  /join\([^)]*'src',\s*'index\.ts'\)/u,
  /fileURLToPath\(new URL\('\.\.\/src\/index\.ts'/u,
]

// ── ASSERT SHAPES ─────────────────────────────────────────────────────────────────────────────
const POSITIVE = /assert\.(?:match|ok|equal|strictEqual|deepEqual)\(|\.includes\(|indexOf\(/u
const NEGATIVE = /assert\.(?:doesNotMatch)|assert\.ok\(\s*!|\.includes\([^)]*\)\s*===?\s*false/u
const EXACTLY_ONCE = /assert\.equal\([^)]*\.length,\s*1\b|assert\.equal\([^)]*count,\s*1\b|exactly once|恰好一次/iu

function classify(name) {
  const path = join(TEST_DIR, name)
  const source = readFileSync(path, 'utf8')
  const lines = source.split(/\r?\n/)

  const mentions = MENTION_PATTERNS.some((pattern) => pattern.test(source))
  const reads = READ_PATTERNS.some((pattern) => pattern.test(source))

  // Which lines constitute assertions about the source? Heuristic: an assertion line in a READS file
  // whose subject name is a variable that was derived from the source text.
  const derivedNames = new Set()
  for (const line of lines) {
    const assignment = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:readFileSync|SRC|INDEX|source|srcText|indexSource)/u.exec(line)
    if (assignment !== null) derivedNames.add(assignment[1])
    if (/(?:const|let)\s+(?:SRC|INDEX|SOURCE|indexSource|srcText)\s*=/u.test(line)) {
      derivedNames.add(line.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)/u)?.[1] ?? '')
    }
  }
  for (const line of lines) {
    const slice = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.(?:slice|indexOf)/u.exec(line)
    if (slice !== null && derivedNames.has(slice[2])) derivedNames.add(slice[1])
  }
  derivedNames.delete('')

  let positive = 0
  let negative = 0
  let exactlyOnce = 0
  const samples = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/assert\./u.test(line)) continue
    // Is the assertion's subject derived from the source text?
    const subjectMentioned = [...derivedNames].some((derived) => derived.length > 1 && new RegExp(`\\b${derived}\\b`, 'u').test(line))
    if (!subjectMentioned && !/src[\\/]index\.ts/u.test(line)) continue

    const entry = { line: index + 1, text: line.trim().slice(0, 110) }
    if (NEGATIVE.test(line)) { negative += 1; samples.push(['NEGATIVE', entry]) }
    else if (EXACTLY_ONCE.test(line)) { exactlyOnce += 1; samples.push(['ONCE', entry]) }
    else if (POSITIVE.test(line)) { positive += 1; samples.push(['POSITIVE', entry]) }
  }

  return { name, mentions, reads, positive, negative, exactlyOnce, samples, derived: [...derivedNames] }
}

const rows = testFiles().map(classify)
const mentions = rows.filter((row) => row.mentions)
const reads = rows.filter((row) => row.reads)
const asserts = reads.filter((row) => row.positive + row.negative + row.exactlyOnce > 0)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    definition: {
      mentions: 'the path appears anywhere in the file (string/comment/other-file URL)',
      reads: 'the file obtains the TEXT of src/index.ts (not ../index.js, the artifact)',
      asserts: 'a READS file whose assertion subject is that source text or a slice of it',
    },
    counts: { mentions: mentions.length, reads: reads.length, asserts: asserts.length, total: rows.length },
    files: { mentions: mentions.map((r) => r.name), reads: reads.map((r) => r.name), asserts: asserts.map((r) => r.name) },
    detail: asserts.map((r) => ({ name: r.name, positive: r.positive, negative: r.negative, exactlyOnce: r.exactlyOnce, derived: r.derived })),
  }, null, 1))
  process.exit(0)
}

console.log('DEFINITIONS (never merged — this is the distinction that caused the 16-vs-9 error)')
console.log('  MENTIONS : the path appears anywhere (string / comment / a URL to another index.ts)')
console.log('  READS    : the file obtains the TEXT of src/index.ts (NOT ../index.js, the artifact)')
console.log('  ASSERTS  : a READS file whose assertion SUBJECT is that text or a slice of it\n')

console.log(`test files total : ${rows.length}`)
console.log(`MENTIONS         : ${mentions.length}`)
console.log(`READS            : ${reads.length}`)
console.log(`ASSERTS          : ${asserts.length}\n`)

console.log('ASSERTS detail (POSITIVE = moves→loud red; NEGATIVE/ONCE = scope can be too narrow):')
console.log('file'.padEnd(44), 'POS  NEG  ONCE')
for (const row of asserts.sort((a, b) => b.negative + b.exactlyOnce - (a.negative + a.exactlyOnce))) {
  console.log(row.name.padEnd(44), String(row.positive).padEnd(4), String(row.negative).padEnd(4), String(row.exactlyOnce))
}

console.log('\n── NEGATIVE / EXACTLY-ONCE occurrences (the class N0c must widen) ──')
for (const row of asserts.filter((entry) => entry.negative + entry.exactlyOnce > 0)) {
  console.log(`\n${row.name}`)
  for (const [kind, entry] of row.samples.filter(([kind]) => kind !== 'POSITIVE')) {
    console.log(`  ${kind.padEnd(9)} L${entry.line}: ${entry.text}`)
  }
}

console.log('\n── MENTIONS but NOT READS (cannot be affected by a move) ──')
for (const row of mentions.filter((entry) => !entry.reads)) console.log(`  ${row.name}`)
