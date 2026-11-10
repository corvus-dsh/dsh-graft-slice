#!/usr/bin/env node
/**
 * README TEST-TALLY CONSISTENCY — `N + skipped == M`, and `M == the REAL test count`.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 *
 * `check-readme-counts` verifies that every documented number equals a MEASURED count. But a README line
 * like
 *
 *     全量测试 | graft **690/692**（2 条待裁定跳过）
 *
 * carries THREE numbers — passed / total / skipped — and only the TOTAL was ever compared. So a change
 * that moved tests from `pass` into `skip` (or the reverse) while leaving the total alone would slip
 * through: the documented "pass/skip" split could drift arbitrarily and no gate would notice.
 *
 * The failure mode is not hypothetical in this project: skipped tests are exactly where a guard goes
 * quiet (v119's corpus checks, the D-family proposal assertions, the `A1` behavioural half). A tally that
 * says "690 passed, 2 skipped" while the real split is "688 passed, 4 skipped" is a report claiming more
 * coverage than exists — the same class as every other "wider than the evidence" error here.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
 *
 * For every README line of the form `**<passed>/<total>**（<skipped> 条…跳过…）`:
 *   1. passed + skipped == total
 *   2. total == the real `tests` count from the suite
 *   3. passed == the real `pass` count, skipped == the real `skip` count
 *
 * All three are checked, because each alone is insufficient: (1) alone allows a consistently-wrong
 * triple; (2) alone allows a wrong split; (3) alone would make (1) and (2) redundant but leaves no
 * explanation when it fails.
 *
 * Usage:  node scripts/check-readme-tally.mjs [--json]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/** Run the suite once and read the tally from its summary. */
export function measureSuite() {
  let output = ''
  try {
    output = execFileSync('node', ['--test', 'test/*.test.mjs'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    output = String(error.stdout ?? '')
  }
  const read = (label) => {
    const match = new RegExp(`^\\u2139 ${label} (\\d+)$`, 'mu').exec(output)
    return match === null ? undefined : Number(match[1])
  }
  return { tests: read('tests'), pass: read('pass'), fail: read('fail'), skipped: read('skipped') }
}

/** Parse every pass/total（skipped）claim out of a README, with the REPO it belongs to. */
export function tallyClaims(text) {
  const claims = []
  /**
   * ── A LINE CAN CARRY TWO REPOS' TALLIES ──────────────────────────────────────────────────────
   *
   * Measured on the first run: the row
   *
   *     全量测试 | graft **696/698**（2 条待裁定跳过）、memory **423/423** | ...
   *
   * contains BOTH this repo's tally and `memory`'s. Comparing `423` against THIS suite's 698 reported a
   * false failure. The repo name is the token immediately before the bold span, so it is captured and
   * used to decide which claims this gate is responsible for.
   *
   * Only claims attributed to THIS package (or to no repo, i.e. bare) are checked; a foreign repo's
   * tally is reported as SKIPPED-FOREIGN rather than silently passed.
   */
  const pattern = /(\b\w[\w-]*\s+)?\*\*(\d+)\/(\d+)\*\*(?:（(\d+)\s*条[^）]*跳过[^）]*）)?/gu
  for (const match of text.matchAll(pattern)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1
    const lineEnd = text.indexOf('\n', match.index)
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    claims.push({
      repo: (match[1] ?? '').trim().replace(/[|、,，]\s*$/u, '') || undefined,
      passed: Number(match[2]),
      total: Number(match[3]),
      skipped: match[4] === undefined ? undefined : Number(match[4]),
      line: line.trim().slice(0, 120),
    })
  }
  return claims
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const readme = readFileSync(`${REPO}/README.md`, 'utf8')
  const claims = tallyClaims(readme)
  const measured = measureSuite()

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ measured, claims }, null, 1))
    process.exit(0)
  }

  console.log(`measured: tests=${measured.tests} pass=${measured.pass} fail=${measured.fail} skipped=${measured.skipped}`)
  console.log(`claims found: ${claims.length}`)

  if (measured.tests === undefined) {
    console.error('FAIL  could not read the suite tally — a gate that cannot measure is not a gate')
    process.exitCode = 1
  } else {
    const problems = []
    /** This package's name, and the spellings the README uses for it. */
    const OWN = new Set(['graft', 'graft-slice', 'dsh-graft-slice', undefined])

    for (const claim of claims) {
      const label = `${claim.repo ?? '(bare)'} ${claim.passed}/${claim.total} (skipped ${claim.skipped ?? '?'})`
      if (!OWN.has(claim.repo)) {
        // A sibling repo's tally: not this gate's business, but SAID so rather than skipped silently.
        console.log(`\n  ${label}\n    ${claim.line}\n    ↷ SKIPPED-FOREIGN (a different repo's suite)`)
        continue
      }
      console.log(`\n  ${label}`)
      console.log(`    ${claim.line}`)

      const local = []
      if (claim.skipped !== undefined && claim.passed + claim.skipped !== claim.total) {
        local.push(`passed+skipped != total: ${claim.passed}+${claim.skipped} != ${claim.total}`)
      }
      if (claim.total !== measured.tests) local.push(`total ${claim.total} != measured tests ${measured.tests}`)
      if (claim.passed !== measured.pass) local.push(`passed ${claim.passed} != measured pass ${measured.pass}`)
      if (claim.skipped !== undefined && claim.skipped !== measured.skipped) {
        local.push(`skipped ${claim.skipped} != measured skipped ${measured.skipped}`)
      }
      for (const problem of local) console.log(`    ✖ ${problem}`)
      if (local.length === 0) console.log('    ✔ consistent')
      problems.push(...local)
    }

    if (claims.length === 0) {
      // A missing claim is a missing check, not a pass.
      console.error('\nFAIL  no `passed/total（skipped）` claim found in README — the tally is unguarded')
      process.exitCode = 1
    } else if (problems.length > 0) {
      console.error(`\n${problems.length} tally problem(s):`)
      for (const problem of [...new Set(problems)]) console.error('  - ' + problem)
      process.exitCode = 1
    } else {
      console.log(`\nall ${claims.length} tally claim(s) consistent with the measured suite`)
    }
  }
}
