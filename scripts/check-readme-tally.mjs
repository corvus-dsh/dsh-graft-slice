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

/**
 * ── THE CLASSIFIER IS THE GATE'S INPUT, SO IT IS A NAMED, TESTABLE FUNCTION ────────────────────
 *
 * The distinction this gate rests on (RESOURCE = a file is missing on THIS machine; PENDING = the repo
 * declared the test as awaiting a decision) is decided by matching the SKIP REASON text. That match was
 * inline and untested, and it was wrong in the direction that fails a build:
 *
 *   measured on CI run 60: `documented skipped 2 != measured PENDING skips 6`
 *
 * The four extra were the tests in `test/v127-closure-instrument.test.mjs`, whose reason begins
 * `RESOURCE: typescript is not installed…`. The marker listed `RESOURCE_MISSING` but not the bare
 * `RESOURCE:` prefix, so four MACHINE skips were counted as REPO skips and the gate demanded the README
 * document a number that is not true in any complete checkout.
 *
 * The fix is NOT to relax the gate: the pending leg stays exact in every environment. It is to make the
 * classifier recognise the prefix the skips actually use — and to pin that with tests, because a gate
 * whose input rule is untested is the same class of defect as the empty-set green (rule 27).
 */
/**
 * ── WHAT COUNTS AS "THIS MACHINE IS MISSING SOMETHING" ──────────────────────────────────────────
 *
 * An UNRECOGNISED reason classifies as PENDING — the fail-loud direction, because PENDING is the number
 * the README must document. Defaulting to resource instead would silently exclude a skip from the
 * documented tally, which is the "report claiming more coverage than exists" failure this gate exists for.
 *
 * `git unavailable in this environment` was missing too: on a machine without git, four v023 tests skip
 * and were counted as repo-declared pending, i.e. the same false red this prefix fix is about.
 */
const RESOURCE_MARKER = /RESOURCE_MISSING|(?:^|[^A-Z])RESOURCE:|corpus absent|observer source absent|ledger absent|sibling|git unavailable/i

/**
 * `'resource'` | `'pending'` | `undefined` (not a skip line at all).
 *
 * `not ok N - … # SKIP` is still a skip: `t.skip()` after a real assertion is reported through the
 * failing channel while carrying the SKIP directive. Keying on `^ok ` counted 1 of this repo's 2.
 *
 * ── AND `\# SKIP` IS A TEST NAME, NOT A DIRECTIVE ────────────────────────────────────────────────
 *
 * Found by this gate mis-counting its OWN test suite: adding
 * `test/v128-tally-classifier.test.mjs` with a test named
 * ``` `not ok … # SKIP` is a SKIP … ``` made `pending` 3 while the suite reported `# skipped 2`.
 * TAP escapes a literal `#` inside a test NAME as `\#`, so the directive is only a directive when the
 * `#` is NOT escaped. Without the lookbehind, any test that merely names the marker inflates the
 * documented number — and the fix would look like "the README is stale" instead of "the classifier is wrong".
 */
export function classifySkipLine(line) {
  if (!/^(?:not )?ok \d+ - .*(?<!\\)# SKIP/u.test(line)) return undefined
  return RESOURCE_MARKER.test(line) ? 'resource' : 'pending'
}


/**
 * ── CLASSIFY SKIP LINES WITHOUT RUNNING ANYTHING ────────────────────────────────────────────────
 *
 * Extracted so the classification can be CHECKED without re-running the suite. The previous shape
 * had the loop inline in `measureSuite`, which runs `node --test` as a child process — a test that
 * wanted to inspect the classification therefore had to spawn the whole suite, and since that suite
 * contains the test itself, it recursed (measured: tests 756 -> 760, fail 0 -> 3).
 *
 * Pure input, pure output: a multi-line string in, an array of {verdict, name, reason} out.
 */
export function classifySkipLines(tapOutput) {
  const classified = []
  for (const line of tapOutput.split(/\r?\n/)) {
    const verdict = classifySkipLine(line)
    if (verdict !== 'resource' && verdict !== 'pending') continue
    const reasonAt = line.lastIndexOf('# SKIP')
    classified.push({
      verdict,
      name: /^(?:not )?ok \d+ - (.*?)(?: # SKIP|$)/u.exec(line)?.[1]?.trim() ?? '(unnamed)',
      reason: reasonAt < 0 ? '(no reason given)' : line.slice(reasonAt + 6).trim(),
    })
  }
  return classified
}

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
  /**
   * ── THE CLASSIFICATION MUST BE VISIBLE, NOT JUST COUNTED ────────────────────────────────────────
   *
   * Measured 2026-11-11: this gate classified every CI skip correctly (pending=2, resource=15) but the
   * classification was only ever printed as TWO TOTALS. A reader of the CI log could not check that the
   * 15 were really resource skips — only that the arithmetic added up. That is precisely the failure
   * mode the user warned about: "总数对 ≠ 每类都对", and the reason it kept happening is that the
   * per-line evidence never left this process.
   *
   * The lines are therefore collected and printed. They are printed even when everything is green,
   * because a conclusion with no visible evidence is a conclusion the next reader has to re-derive.
   */
  const classified = classifySkipLines(output)

  return {
    tests: read('tests'), pass: read('pass'), fail: read('fail'), skipped: read('skipped'),
    pending: classified.filter((entry) => entry.verdict === 'pending').length,
    resource: classified.filter((entry) => entry.verdict === 'resource').length,
    classified,
  }
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

  /**
   * ── PRINT THE EVIDENCE BEHIND THE TWO TOTALS ───────────────────────────────────────────────────
   *
   * Every classified skip is printed with its reason, so the totals above can be CHECKED instead of
   * believed. If this list ever disagrees with the totals, that is a bug in this gate — the totals are
   * derived from exactly these lines.
   */
  const classified = measured.classified ?? []
  console.log(`skip evidence: ${classified.length} classified line(s)`)
  for (const [index, entry] of classified.entries()) {
    console.log(`  ${String(index + 1).padStart(2)}. [${entry.verdict}] ${entry.name.slice(0, 72)}`)
    console.log(`      ${entry.reason.slice(0, 140)}`)
  }
  const classifiedSum = classified.filter((entry) => entry.verdict === 'resource').length +
    classified.filter((entry) => entry.verdict === 'pending').length
  const totalsAgree = classifiedSum === (measured.pending ?? 0) + (measured.resource ?? 0)
  console.log(`  totals derived from these lines: ${totalsAgree ? 'AGREE' : 'DISAGREE — gate bug'}`)
  if (!totalsAgree) process.exitCode = 1

  console.log(`claims found: ${claims.length}`)

  /**
   * ── "IS THIS ENVIRONMENT COMPLETE?" IS NOW DERIVED, NOT ENUMERATED ──────────────────────────────
   *
   * It used to be `existsSync(../_scratch/real-texts.json)` — the corpus, the one machine resource the
   * author happened to think of. That is an enumeration, and enumerations drift: the moment the suite
   * gained a second machine resource (v127 needs the TypeScript compiler) the predicate was wrong. It
   * was measured doing so: with typescript hidden and the corpus present, this gate reported
   * `passed 700 != measured pass 696` on a checkout where nothing was actually stale.
   *
   * The honest predicate is the measurement itself: the strict split applies only when the suite has NO
   * resource skips at all, i.e. when every test the machine could run, did run. New machine resources are
   * then covered automatically — they raise `resource`, which turns the strict split off, while the
   * PENDING leg stays exact everywhere (that is the leg that catches "a test quietly became a skip").
   */
  const completeEnvironment = measured.resource === 0
  console.log(
    `environment: ${completeEnvironment
      ? 'complete (no resource skips) → strict pass/skip split'
      : `${measured.resource} resource skip(s) on this machine → pending exact, split via invariants`}`,
  )

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
      if (completeEnvironment) {
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
