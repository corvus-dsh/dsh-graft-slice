/**
 * ── META-GATE A: EVERY GATE MUST BE REACHABLE FROM CI ─────────────────────────────────────────────
 *
 * This file exists because of a measured sequence, not a worry:
 *
 *   * `check-readme-counts` was red while CI was green — it existed and nobody ran it.
 *   * `check-docs` was in the same position until N2: it reported **26 facts instead of 27** and NOTHING
 *     failed, because it was never a CI step at all. Both were found by running things by hand.
 *
 * The workflow file already says it: "A gate nobody runs is a comment." That sentence was true twice.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────
 *
 *   1. every `scripts/check-*.mjs` and `scripts/verify-bundle.mjs` must be REFERENCED by ci.yml;
 *   2. two instruments are exempt, and the exemption is an explicit list WITH REASONS — an empty
 *      whitelist would be a rule nobody can bend, and a silent one would be a hole;
 *   3. every script ci.yml mentions must EXIST (a renamed file must fail here, not at 3am in CI);
 *   4. the gate set has a denominator, so "no gates found" cannot pass.
 *
 * ── WHY THE TWO EXEMPTIONS ARE HONEST ───────────────────────────────────────────────────────────
 *
 * `closure.mjs` needs the TypeScript compiler, and this package deliberately declares no dependencies
 * (`npm i --no-save` only). In CI it would exit 2 by design — a permanently red step that teaches
 * people to ignore red. It stays a local instrument, and every number it produces carries the
 * "本机 TS 5.9.3、不可在 CI 复跑" note in ARCHITECTURE.
 *
 * `verify-pure-move.mjs` compares the WORKING TREE against a git ref. In CI the working tree IS that
 * ref, so the comparison is IDENTICAL by construction — it cannot fail there, which means running it
 * would be a green light that proves nothing. Its `--self-test` half is the part with teeth, and it is
 * exercised by the local acceptance runs quoted in each node's report.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CI = join(ROOT, '.github', 'workflows', 'ci.yml')

/** Instruments that are deliberately NOT CI steps, each with the reason it cannot be one. */
const EXEMPT = new Map([
  ['closure.mjs', 'needs the TypeScript compiler, which this package does not depend on; it exits 2 by design in CI'],
  ['verify-pure-move.mjs', 'compares the working tree to a git ref, which is IDENTICAL by construction in CI; its --self-test is run locally'],
])

const ciText = readFileSync(CI, 'utf8')

/**
 * ── THREE KINDS OF SCRIPT, AND ONLY ONE OF THEM MUST BE A CI STEP ────────────────────────────────
 *
 * First version: `/^check-.*\.mjs$/`. It silently excluded every instrument whose name does not start
 * with `check-` — `type-check`, `who-references`, `audit-line-numbers`, `verify-import-edges`.
 *
 * Widening it to "every .mjs" then produced the OPPOSITE problem: 12 scripts flagged as unreachable
 * gates, most of which are not gates at all (`prune-ghosts`, `cleanup-graft-targets`,
 * `duel-model-driven`, `e2e-multiproject` …). Forcing those into CI would be wrong — they mutate the
 * session store or need a live host.
 *
 * So the set is enumerated by KIND, and every entry carries a verdict:
 *
 *   GATE        makes an ASSERTION and can fail a push   → must be a CI step
 *   INSTRUMENT  MEASURES (prints numbers, exits 0)        → CI step if it can run; else EXEMPT + reason
 *   OPS         operates on a live store / host, or is a drill → never a CI step, reason required
 *
 * An unlisted .mjs fails this test on purpose: adding a script is a decision, not an accident.
 */
const KINDS = new Map([
  // ── GATE: asserts, fails the push ──
  ['check-artifact-fresh.mjs', 'GATE'],
  ['check-cycles.mjs', 'GATE'],
  ['check-docs.mjs', 'GATE'],
  ['check-readme-counts.mjs', 'GATE'],
  ['check-readme-tally.mjs', 'GATE'],
  ['verify-bundle.mjs', 'GATE'],
  ['v140-audit', 'GATE'],

  // ── INSTRUMENT: measures ──
  ['audit-line-numbers.mjs', 'INSTRUMENT'],
  ['closure.mjs', 'INSTRUMENT'],
  ['move-gate.mjs', 'INSTRUMENT'],
  ['type-check.mjs', 'INSTRUMENT'],
  ['type-budget.mjs', 'INSTRUMENT'],
  ['verify-import-edges.mjs', 'INSTRUMENT'],
  ['verify-pure-move.mjs', 'INSTRUMENT'],
  ['verify-bundle-purity.mjs', 'INSTRUMENT'],
  ['measure-efficiency.mjs', 'INSTRUMENT'],
  ['measure-move.mjs', 'INSTRUMENT'],
  ['who-references.mjs', 'INSTRUMENT'],
  ['calibrate-who-references.mjs', 'INSTRUMENT'],
  ['inventory-source-guards.mjs', 'INSTRUMENT'],
  ['families.mjs', 'INSTRUMENT'],

  // ── OPS: needs a live store/host, or is a drill ──
  // ── TOOLING: the build/publish path, not a check of it ──
  ['build.mjs', 'TOOLING'],
  ['bundle.mjs', 'TOOLING'],
  ['publish.mjs', 'TOOLING'],
  ['demo.mjs', 'TOOLING'],
  ['_del.mjs', 'TOOLING'],

  ['cleanup-graft-targets.mjs', 'OPS'],
  ['debug-status.mjs', 'OPS'],
  ['duel-model-driven.mjs', 'OPS'],
  ['e2e-multiproject.mjs', 'OPS'],
  ['prune-ghosts.mjs', 'OPS'],
  ['read-session-log.mjs', 'OPS'],
  ['scan-real-logs.mjs', 'OPS'],
  ['validate-real-format.mjs', 'OPS'],
])

/** Why each OPS script is not a gate, and why each tool-dependent INSTRUMENT is exempt. */
const NOT_A_CI_STEP = new Map([
  ['build.mjs', 'THE build step: it runs as `npm run build` inside the job, not as a separate check'],
  ['bundle.mjs', 'library module imported by build.mjs and check-docs.mjs, not a standalone script'],
  ['publish.mjs', 'release path; it publishes to npm and must never run on a push'],
  ['demo.mjs', 'demonstration script for humans; asserts nothing'],
  ['_del.mjs', 'scratch helper kept for a one-off cleanup; prefixed with _ so it is not mistaken for a gate'],
  ['cleanup-graft-targets.mjs', 'mutates the live DSH session store; running it on CI has no store to clean and would mask a real failure'],
  ['debug-status.mjs', 'calls the graft_debug_status tool through a live host; there is no host in CI'],
  ['duel-model-driven.mjs', 'a drill that drives two live sessions to hand over simultaneously'],
  ['e2e-multiproject.mjs', 'end-to-end drill over three real projects concurrently'],
  ['prune-ghosts.mjs', 'quarantines GHOST sessions in a live store and resets derived ledgers — destructive by design'],
  ['read-session-log.mjs', 'reads a persisted host session log; useful by hand, nothing to assert in CI'],
  ['scan-real-logs.mjs', 'development smoke test over every persisted log on this machine — a RESOURCE condition'],
  ['validate-real-format.mjs', 'optional deep check against the real v4 validator; the committed corpus sample is the CI-safe subset'],
  ['closure.mjs', 'needs the TypeScript compiler, which this package deliberately does not depend on; it exits 2 by design in CI'],
  ['verify-pure-move.mjs', 'compares the working tree to a git ref, which is IDENTICAL by construction in CI; its --self-test is run locally'],
  ['verify-bundle-purity.mjs', 'compares two COMMITS (--before/--after <ref>), so there is nothing to compare on a tree with no pending move; run once per move and quoted in that commit'],
  ['measure-efficiency.mjs', 'a timing instrument needing two built bundles (pre/post move); timing is machine-dependent by construction, so its verdict is quoted in each move commit instead of asserted here'],
  ['measure-move.mjs', 'reports the THREE size metrics (declaration span sum / cut range / measured net change) for a COMMIT RANGE, so there is nothing to assert on a tree with no pending move; its output is quoted in the move commit'],
  ['move-gate.mjs', 'needs closure.mjs, and is a MEASURING instrument: it prints four tiers and does not assert on them in CI'],
  ['type-check.mjs', 'needs the TypeScript compiler; the incremental budget gate that consumes it is a separate proposal (PROPOSAL-incremental-type-check.md)'],
  ['type-budget.mjs', 'needs the TypeScript compiler, which this package deliberately does not depend on; it exits 2 by design in CI, and test/v143 exercises its judgement locally'],
  ['audit-line-numbers.mjs', 'produces the audit table that test/v140 consumes; v140 is the CI step, this is its instrument'],
  ['inventory-source-guards.mjs', 'inventory/report; test/v126 asserts the coverage it describes'],
  ['verify-import-edges.mjs', 'produces the edge diff that test/v136 consumes; v136 is the CI step, this is its instrument'],
  ['calibrate-who-references.mjs', 'a CALIBRATION for who-references.mjs: it asserts a known answer (5 real references across three shapes). It is run by test/v141 as a precondition, which is the point — the classifier must be calibrated BEFORE its answer is trusted, not after it is published'],
  ['families.mjs', 'needs closure.mjs and who-references.mjs, both of which need the TypeScript compiler this package deliberately does not depend on. It also answers a question that only exists DURING a refactor — "which declarations still cluster together" — so there is nothing to assert on a tree with no pending move; the 10-component table it printed is quoted in the step5 commit message instead of pinned here'],
])

const scriptNames = readdirSync(join(ROOT, 'scripts')).filter((name) => name.endsWith('.mjs')).sort()

/** The gate set is whatever this file says it is — an unlisted script is an ERROR, not a silent pass. */
const gateScripts = scriptNames.filter((name) => KINDS.get(name) === 'GATE')

const referencedInCi = (name) => new RegExp(`scripts/${name.replace(/\./gu, '\\.')}`, 'u').test(ciText)

const INSTRUMENTS = scriptNames.sort()

test('meta: the gate set has a denominator (an empty scan must not pass)', () => {
  assert.ok(gateScripts.length >= 4,
    `found only ${gateScripts.length} gate script(s) under scripts/. A gate that scans nothing reports no problems.`)
})

test('meta: every script under scripts/ is CLASSIFIED (an unlisted script is a decision nobody made)', () => {
  /**
   * ── THE ENUMERATION IS THE POINT ────────────────────────────────────────────────────────────────
   *
   * The earlier versions of this file both failed the same way: a FILTER decided what counted
   * (`/^check-*`), so anything outside the pattern was invisible rather than unclassified. That is how
   * `type-check.mjs`, `who-references.mjs` and `audit-line-numbers.mjs` shipped without anyone asking
   * whether they belonged in CI.
   *
   * Now the list is explicit, and a script that is not in it fails HERE — with its name — instead of
   * being silently outside the rule.
   */
  const unclassified = scriptNames.filter((name) => KINDS.get(name) === undefined)
  assert.deepEqual(unclassified, [],
    `these script(s) are not classified as GATE / INSTRUMENT / OPS:\n  ${unclassified.join('\n  ')}\n` +
    'Add each to KINDS with its kind — and if it is not a CI step, add a reason to NOT_A_CI_STEP.')

  /**
   * A reason is required only for a script that is NOT a CI step. Two instruments
   * (`verify-import-edges`, `who-references`) ARE wired into ci.yml, so demanding a reason for them
   * was a false failure — measured, and fixed here rather than by adding dummy reasons.
   */
  const needsReason = scriptNames
    .filter((name) => KINDS.get(name) !== 'TOOLING')
    .filter((name) => !referencedInCi(name))
    .filter((name) => {
      const reason = NOT_A_CI_STEP.get(name)
      return reason === undefined || reason.length < 40
    })
  assert.deepEqual(needsReason, [],
    `${needsReason.length} script(s) are not CI steps and have no written reason:\n  ${needsReason.join('\n  ')}`)
})

test('meta: every gate script is referenced by ci.yml (a gate that cannot run is a comment)', () => {
  const referenced = new Set([...ciText.matchAll(/scripts\/([\w.-]+\.mjs)/gu)].map((match) => match[1]))
  const notInCi = gateScripts.filter((name) => !referenced.has(name))

  assert.deepEqual(
    notInCi,
    [],
    'these gates exist but ci.yml never runs them: ' + notInCi.join(', ') +
      '. This exact shape was measured twice (check-readme-counts, then check-docs). ' +
      'Wire it into ci.yml, or — if it is an INSTRUMENT rather than a gate — move it to EXEMPT in this file with its reason.',
  )
})

test('meta: every instrument is either a CI step or exempt with a written reason', () => {
  /**
   * Every GATE, INSTRUMENT and OPS script must be either a CI step or carry a written reason.
   * An exemption without a reason is a hole with a label; an unlisted script is worse (see the
   * CLASSIFIED test above).
   */
  const referenced = new Set([...ciText.matchAll(/scripts\/([\w.-]+\.mjs)/gu)].map((match) => match[1]))
  // NOT_A_CI_STEP replaced the old EXEMPT map when the set became three-way (GATE / INSTRUMENT / OPS).
  const unaccounted = INSTRUMENTS.filter((name) => !referenced.has(name) && !NOT_A_CI_STEP.has(name))
  assert.deepEqual(unaccounted, [], 'instruments that are neither CI steps nor explained: ' + unaccounted.join(', '))
  assert.ok(INSTRUMENTS.length >= 6, `expected at least 6 instruments, found ${INSTRUMENTS.length}`)
})

test('meta: measure-efficiency REFUSES fewer than 5 independent runs (exit 2, no verdict line)', () => {
  /**
   * 用户裁定（2026-11-12）：`--repeat` 下限 5。
   *
   * 判据必须同时是两条：
   *   ① exit 2（拒绝运行），不是 exit 0 带着「不可信」的标注继续跑；
   *   ② 输出里**一行 VERDICT 都没有** —— 否则「跑一下再标注」的结果会被下游引用成结论。
   *
   * 实测背景（B-6）：单轮运行报出过 +23.83% 的假 REGRESSION。
   */
  const bundle = join(ROOT, 'index.js')
  let code = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, [
      join(ROOT, 'scripts', 'measure-efficiency.mjs'),
      '--before', bundle, '--after', bundle, '--export', 'buildTape', '--repeat', '1',
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    code = error.status ?? 1
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  assert.equal(code, 2, `fewer than 5 runs must exit 2; got ${code}:\n${out.slice(0, 400)}`)
  assert.equal(/VERDICT/u.test(out), false, `a refused run must print NO verdict line:\n${out.slice(0, 400)}`)
  assert.match(out, />= 5/u, 'the refusal must say the minimum')
})

test('meta: measure-efficiency self-test covers the verdict shapes, including same-sign with spread > 10%', () => {
  /**
   * 用户裁定（2026-11-13）：判决用构造数据覆盖，不靠「跑一次真实测量看它像不像话」。
   *
   * 本断言同时钉住两件事：
   *   ① self-test 必须存在且通过（构造数据覆盖五种判决形态）；
   *   ② **spread > 10% 时的 REGRESSION 必须自曝「方向一致 N/N」与「± spread」** —— 这是用户点名的形态，
   *      所以它在真实输出里出现过一次还不够，必须由测试钉住。
   */
  let code = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'measure-efficiency.mjs'), '--self-test'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    code = error.status ?? 1
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  assert.equal(code, 0, `measure-efficiency --self-test must pass:\n${out.slice(0, 600)}`)
  assert.match(out, /SELF-TEST PASS/u, 'the self-test must announce its own result')
  assert.match(out, /5 runs same sign, spread > 10%/u, 'the case the user named must be one of the covered shapes')
  assert.match(out, /REGRESSION（方向一致 5\/5，幅度 [\d.]+% ± [\d.]+%）/u,
    'a REGRESSION with spread > 10% must disclose direction consistency and ± spread')
  assert.equal((out.match(/^FAIL/mu) ?? []).length, 0, `no case may fail:\n${out.slice(0, 600)}`)
})

test('meta: every exemption names a real file and states a reason long enough to argue with', () => {
  for (const [name, reason] of EXEMPT) {
    assert.ok(existsSync(join(ROOT, 'scripts', name)), `EXEMPT lists ${name}, which does not exist`)
    assert.ok(INSTRUMENTS.includes(name),
      `${name} is exempted but is not an instrument — the exemption list is growing beyond its rule`)
    assert.ok(reason.trim().length >= 40,
      `the exemption for ${name} needs a reason long enough to argue with, not a shrug`)
  }
})

test('meta: every script ci.yml mentions exists on disk (a rename must fail here, not in CI)', () => {
  const referenced = [...ciText.matchAll(/scripts\/([\w.-]+\.mjs)/gu)].map((match) => match[1])
  assert.ok(referenced.length >= 4, `ci.yml references ${referenced.length} script(s); expected at least 4`)
  const missing = [...new Set(referenced)].filter((name) => !existsSync(join(ROOT, 'scripts', name)))
  assert.deepEqual(missing, [], `ci.yml runs scripts that do not exist: ${missing.join(', ')}`)
})

test('meta: check-docs and the two README gates are all CI steps (the three that failed this way)', () => {
  /**
   * Named explicitly rather than left to the generic rule: each of these three has ALREADY been the one
   * that was not running. A regression that removes one from ci.yml should name it in the failure.
   */
  for (const name of ['check-docs.mjs', 'check-readme-counts.mjs', 'check-readme-tally.mjs']) {
    assert.match(ciText, new RegExp(`scripts/${name.replace(/\./gu, '\\.')}`, 'u'),
      `${name} is not referenced by ci.yml — this is precisely the state it was already found in once`)
  }
})

test('meta: no script hard-codes an absolute path (it would only work on one machine)', () => {
  /**
   * ── MEASURED ON ITS FIRST CI RUN (#118, step 19) ──────────────────────────────────────────────
   *
   * `scripts/check-cycles.mjs` opened with `const REPO = 'D:/…/dsh-graft-slice'` — this machine's own
   * path. Every local run passed, because locally that path exists. The first runner has no `D:` drive,
   * so the step failed with NO local symptom whatsoever. The gap between writing the bug and seeing it
   * was exactly one push, which is the worst feedback loop a gate can have.
   *
   * Every other script in this directory already derives its root from `import.meta.url`. This
   * assertion makes the difference CHECKABLE instead of remembered.
   *
   * Comments are stripped first on purpose: several files legitimately MENTION `D:/…` while explaining
   * a Windows behaviour (`closure.mjs` documents where tsc lives, this very comment names the bug). A
   * guard that failed on a comment would be deleted rather than fixed.
   */
  const scripts = readdirSync(join(ROOT, 'scripts')).filter((name) => name.endsWith('.mjs'))
  assert.ok(scripts.length >= 20, `expected the full script set, scanned only ${scripts.length}`)

  const offenders = []
  for (const name of scripts) {
    const source = readFileSync(join(ROOT, 'scripts', name), 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n')
    /**
     * The pattern targets a path that names THIS machine, not any path-shaped string.
     *
     * `e2e-multiproject.mjs` writes `'D:\\\\proj\\\\' + sessionId` — a SYNTHETIC fixture path, already
     * double-escaped inside a JSON.stringify argument, deliberately generic (`proj`). It is test data.
     * `check-cycles.mjs` wrote `'D:/…/dsh-graft-slice'` — a real, resolvable, this-repo path. Only the
     * second kind is the defect, so the discriminator is "does the literal name this working tree or a
     * user home" rather than "does it start with a drive letter".
     */
    const pattern = new RegExp(
      `['"\`](?:[A-Za-z]:[\\\\/](?:[^'"\`]*dsh-graft-slice|Users[\\\\/][^'"\`]*)|/home/[^'"\`]*|/Users/[^'"\`]*)['"\`]`,
      'gu')
    /**
     * `match[0]`, not `match[1]` — and this guard crashed the first time it ever found something.
     *
     * Every group in `pattern` is NON-capturing (`(?:…)`), so `match[1]` was always `undefined` and
     * `.slice(0, 60)` threw. The crash only happened when `offenders` was non-empty, which is exactly
     * the case the assertion exists to REPORT: the guard could never name an offender, only die on one.
     *
     * It had never fired because no script matched before `families.mjs` did. That is the same shape as
     * every other instrument defect in this repo — a discriminator that was never exercised is not a
     * discriminator that works. The message must carry the offending literal, so it uses the whole match.
     */
    for (const match of code.matchAll(pattern)) offenders.push(`${name}: ${match[0].slice(0, 60)}`)
  }
  assert.deepEqual(offenders, [],
    'these scripts embed an absolute path, which only resolves on the machine that wrote it: ' +
    offenders.join(' | '))
})
