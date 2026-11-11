#!/usr/bin/env node
/**
 * ── IS THE COMMITTED ARTIFACT THE ONE THIS SOURCE BUILDS? ────────────────────────────────────────
 *
 * CI already refuses a push whose build changes a committed artifact:
 *
 *     ##[error]The build changed committed artifacts. Run 'npm run build' and commit the result.
 *
 * That check ran only AFTER the push, so run #110 went red for a cause that was fully visible locally.
 * Measured cause: the D-tier benchmark copies the previous artifact into place to measure a baseline and
 * restores it in a `finally` — so a build performed before the benchmark was silently REVERTED, and the
 * commit captured the pre-build bytes.
 *
 * This is the same check, one step earlier, where it costs a second instead of a CI run.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REPO = new URL('..', import.meta.url)
execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: REPO })

let committed
try {
  committed = execFileSync('git', ['show', 'HEAD:index.js'], { cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
} catch {
  console.log('artifact-check: index.js is not committed yet — nothing to compare')
  process.exit(0)
}
const working = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

if (working === committed) {
  console.log('artifact-check: OK — the committed index.js is what this source builds')
  process.exit(0)
}

const workingLines = working.split('\n').length
const committedLines = committed.split('\n').length
console.log('artifact-check: THE COMMITTED ARTIFACT IS STALE')
console.log(`  working  : ${working.length} chars / ${workingLines} lines`)
console.log(`  committed: ${committed.length} chars / ${committedLines} lines`)
console.log('  Run: git add index.js  (a benchmark or a restore step may have written the old bytes back)')
process.exit(1)
