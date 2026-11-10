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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/** Run the suite once and read the tally from its summary. */
export function measureSuite() {
  let output = ''
  /**
   * ── TAP, NOT THE DEFAULT REPORTER, BECAUSE ONLY TAP PRINTS THE SKIP REASON ─────────────────────
   *
   * Measured: the default reporter prints `- test name # SKIP ...` only sometimes, and the `# SKIP`
   * text is absent for `t.skip()` calls entirely — so a classifier keyed on `# SKIP` counted
   * `pending=0 resource=0` against a real `skipped=2`. TAP prints the reason on every skip line:
   *
   *     ok 369 - D2 control: … # SKIP TD-17 ruled to KEEP this behaviour: …
   *
   * Only the reason lets the gate tell a DECLARED pending test from a MACHINE-missing resource, which is
   * the entire distinction this file rests on.
   */
  try {
    output = execFileSync('node', ['--test', '--test-reporter=tap', 'test/*.test.mjs'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    output = String(error.stdout ?? '')
  }
  const read = (label) => {
    const match = new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output)
    return match === null ? undefined : Number(match[1])
  }

  /**
   * ── TWO KINDS OF SKIP, AND ONLY ONE OF THEM BELONGS IN A README ──────────────────────────────
   *
   * RESOURCE — a file is missing on THIS machine (the corpus, a sibling checkout). A property of the
   *            environment; CI legitimately has more of them (measured: 2 locally vs 8 on CI).
   * PENDING  — the repo itself declares the test as awaiting a decision. A property of the REPO, and
   *            therefore the number a README can honestly document in every checkout.
   *
   * Without this split the gate had to choose between a permanent false red on CI and a hole where
   * "skipped 2→4, total unchanged" stayed green. Splitting makes the documented number exact everywhere.
   */
  /**
   * ── TAP PRINTS SKIPS AS BOTH `ok … # SKIP` AND `not ok … # SKIP` ────────────────────────────────
   *
   * Measured: this checkout has `# skipped 2`, and the two lines are
   *
   *     ok 369 - D2 control: … # SKIP TD-17 ruled to KEEP this behaviour: …
   *     not ok 373 - C1: a pasted REPORT … # SKIP pending a ruling on goal semantics
   *
   * The second one starts with `not ok` because the test was DECLARED as skipped via `t.skip()` while
   * still being reported through the failing channel. A classifier keyed on `^ok ` therefore counted
   * 1 pending when the truth was 2 — the gate's INPUT was wrong, which is the same failure class as the
   * empty-set green (rule 27): a number with no correct denominator.
   */
  const RESOURCE_MARKER = /RESOURCE_MISSING|corpus absent|observer source absent|ledger absent|sibling/i
  let pending = 0
  let resource = 0
  for (const line of output.split(/\r?\n/)) {
    // `ok N - … # SKIP …` OR `not ok N - … # SKIP …`; the directive is what decides, not the status verb.
    if (!/^(?:not )?ok \d+ - .*# SKIP/u.test(line)) continue
    if (RESOURCE_MARKER.test(line)) resource += 1
    else pending += 1
  }

  return { tests: read('tests'), pass: read('pass'), fail: read('fail'), skipped: read('skipped'), pending, resource }
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

  console.log(`measured: tests=${measured.tests} pass=${measured.pass} fail=${measured.fail} skipped=${measured.skipped} (pending=${measured.pending} resource=${measured.resource})`)
  console.log(`claims found: ${claims.length}`)

  /**
   * Strict split only where this machine has the local-only resources. Elsewhere (CI) the pending set is
   * still compared EXACTLY — that is the environment-independent leg — and the pass/skip split is left to
   * the arithmetic plus that pending comparison.
   */
  const hasCorpus = existsSync(join(REPO, '..', '_scratch', 'real-texts.json'))
  console.log(`environment: ${hasCorpus ? 'corpus present → strict split' : 'corpus absent (CI) → pending exact, split via invariants'}`)

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
      // (1) arithmetic — true in every checkout
      if (claim.skipped !== undefined && claim.passed + claim.skipped !== claim.total) {
        local.push(`passed+skipped != total: ${claim.passed}+${claim.skipped} != ${claim.total}`)
      }
      // (2)(3) invariants
      if (claim.total !== measured.tests) local.push(`total ${claim.total} != measured tests ${measured.tests}`)
      if (measured.fail !== 0) local.push(`measured fail is ${measured.fail}, must be 0`)
      /**
       * (4) THE DECLARED PENDING SET — exact, in EVERY environment.
       *
       * This is the leg that catches "a test quietly became a skip": the README declares N pending
       * tests; if the suite now has N+2, the repo is declaring work it does not document. Resource
       * skips are excluded because they are a property of the machine, not of the repo.
       */
      if (claim.skipped !== undefined && claim.skipped !== measured.pending) {
        local.push(
          `documented skipped ${claim.skipped} != measured PENDING skips ${measured.pending} ` +
            `(resource skips ${measured.resource} excluded — they belong to this machine)`,
        )
      }
      // (5) the strict split, only where the environment is complete
      if (hasCorpus) {
        if (claim.passed !== measured.pass) local.push(`passed ${claim.passed} != measured pass ${measured.pass}`)
        if (claim.skipped !== undefined && claim.skipped !== measured.skipped) {
          local.push(`skipped ${claim.skipped} != measured skipped ${measured.skipped}`)
        }
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
