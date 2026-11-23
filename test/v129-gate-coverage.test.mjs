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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CI = join(ROOT, '.github', 'workflows', 'ci.yml')

/** Instruments that are deliberately NOT CI steps, each with the reason it cannot be one. */
const EXEMPT = new Map([
  ['closure.mjs', 'needs the TypeScript compiler, which this package does not depend on; it exits 2 by design in CI'],
  ['verify-pure-move.mjs', 'compares the working tree to a git ref, which is IDENTICAL by construction in CI; its --self-test is run locally'],
  /**
   * Phase A 的两个 GENERATOR：它们的默认模式**写文件**，在 CI 里跑就等于让流水线改仓库。
   * 它们的断言不因此缺席 —— `v325` / `v326` 在 `node --test`（= CI 步骤）里跑同一个脚本，
   * 后者会用 `--check`。所以「未登记」与「投影过期」在 CI 上仍然会红。
   */
  ['handler-inventory.mjs', 'generator: writes docs/HANDLER-INVENTORY.md; its ASSERTION runs inside node --test via v325, which is a CI step'],
  ['emit-taxonomy.mjs', 'generator: writes src/contracts/content-taxonomy.v1.json; its --check assertion runs inside node --test via v326, which is a CI step'],
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
  ['check-export-baseline.mjs', 'GATE'],
  ['check-readme-counts.mjs', 'GATE'],
  ['check-readme-tally.mjs', 'GATE'],
  ['check-symbol-lookup.mjs', 'GATE'],
  ['check-test-separators.mjs', 'GATE'],
  /**
   * ── B4-0b-2 W5-1: TEST NUMBERS ARE A GATE, NOT A TIDINESS PREFERENCE ────────────────────────
   *
   * The dispatch reported two collisions (`v249`, `v253`). Measured across `test/`, there are 18
   * shared numbers, `v74` twelve times among them — so 「make them all unique」 is a mass rename of
   * filenames cited in commit messages and TD entries, and the rename would cause more error than
   * the collision. The gate therefore BASELINES the stock and refuses growth, which is exactly the
   * shape of `check-readme-counts`. It asserts (exit 1), so it is a GATE and must be a CI step.
   */
  ['check-test-numbers.mjs', 'GATE'],
  /**
   * ── B4-0b-2 五形态之二「门禁不咬」: THE TWO LISTS MUST NOT DRIFT ────────────────────────────
   *
   * `package.json`'s `check` and `ci.yml` are two lists kept separately, and the drift had already
   * happened: measured 2026-11-21 across the four repositories, memory's `check-cycles` and
   * `check-frontmatter-reads` and observer's `preflight` all ran locally and never on a push. It
   * asserts (exit 1), so it is a GATE and must be a CI step — which is what it checks about others,
   * so the rule is applied to itself with no exemption.
   */
  ['check-check-parity.mjs', 'GATE'],
  /**
   * ── B4-B B1b: A FIELD DECLARED AND THEN THROWN AWAY ─────────────────────────────────────────
   *
   * The same defect twice: `chunks` (v7.4) and `handover` (B4-B B1) were declared on `PreparedSlice`,
   * written to disk, and dropped by `loadPrepared`'s field-by-field reconstruction. The second one
   * shipped WITH a comment warning about the first — which is why this is a check and not a comment.
   * It asserts (exit 1), so it is a GATE.
   */
  ['check-prepared-slice-fields.mjs', 'GATE'],
  ['verify-bundle.mjs', 'GATE'],
  ['run-gate.mjs', 'GATE'],
  ['v140-audit', 'GATE'],

  // ── INSTRUMENT: measures ──
  ['bench-smoke.mjs', 'INSTRUMENT'],
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
  /**
   * ── B4-0b-2 W1-13: BURN-IN IS AN INSTRUMENT, AND A DELIBERATELY UNWIRED ONE ──────────────────
   *
   * It answers a question `check` cannot: 「这套测试稳不稳」 rather than 「这个 commit 对不对」.
   * Its output is a RATE over N runs, so wiring it into CI (which runs each file once) would produce
   * a boolean that means nothing — and slow every push by minutes to produce it. The reason lives in
   * NOT_A_CI_STEP below; the classification lives here.
   */
  ['burn-in.mjs', 'INSTRUMENT'],
  /**
   * ── W4-1: A LIBRARY MODULE, NOT A GATE ──────────────────────────────────────────────────────────
   *
   * `suite-observation.mjs` runs the suite once and hands the raw TAP to every gate that asks. It
   * asserts nothing itself — classifying it as a GATE would claim it can refuse a push, and as an
   * INSTRUMENT would put it in the "must be a CI step or exempt" bucket, where the honest answer is
   * that it is IMPORTED by gates rather than run. TOOLING is that bucket.
   */
  ['suite-observation.mjs', 'TOOLING'],
  /**
   * ── W4-5: A MEASUREMENT TOOL, NOT A CHECK ──────────────────────────────────────────────────────
   *
   * `hot-paths.mjs` prints the per-turn hot-path table into `docs/PERF-HOT-PATHS.md`. It asserts
   * nothing and sets no threshold — **a baseline is not a gate** — so a CI step would either check
   * nothing or turn every normal slowdown into a red build.
   */
  ['hot-paths.mjs', 'TOOLING'],
  ['who-references.mjs', 'INSTRUMENT'],
  ['calibrate-who-references.mjs', 'INSTRUMENT'],
  ['inventory-source-guards.mjs', 'INSTRUMENT'],
  /**
   * ── Phase A 的两件新工具：GENERATOR，不是 CI 步骤 ────────────────────────────────────────────
   *
   * 两者都**会写文件**（`docs/HANDLER-INVENTORY.md`、`src/contracts/content-taxonomy.v1.json`），
   * 所以在 CI 里跑它们等于让流水线改仓库 —— 那必然把干净树弄脏，而干净树本身是被检查的。
   *
   * 它们的**断言**并没有因此缺失：`v325` / `v326` 就在 `node --test` 里跑同一个脚本（后者用
   * `--check`），而 `node --test` 是 CI 步骤。所以「未登记 / 投影过期」在 CI 上仍然会红。
   * 分类为 INSTRUMENT 是因为它们的默认模式是产出，不是断言。
   */
  ['handler-inventory.mjs', 'INSTRUMENT'],
  ['emit-taxonomy.mjs', 'INSTRUMENT'],
  ['index-ratchet.mjs', 'INSTRUMENT'],
  ['ci-fresh-clone.mjs', 'INSTRUMENT'],
  /**
   * B4-A 的「依赖为空门禁」。它是 **GATE**（`dependencies` 非空 ⇒ exit 1），并且必须在 `ci.yml` 里
   * 有自己的步骤 —— 它在 `npm run check` 里跑不代表 CI 会跑到它（本仓已经因为「门禁没人跑」红过一次）。
   */
  ['check-runtime-deps.mjs', 'GATE'],
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
  ['w0-token-jump.mjs', 'INSTRUMENT'],
  ['w0-three-layers.mjs', 'INSTRUMENT'],  ['scan-real-logs.mjs', 'OPS'],
  ['validate-real-format.mjs', 'OPS'],
])

/** Why each OPS script is not a gate, and why each tool-dependent INSTRUMENT is exempt. */
const NOT_A_CI_STEP = new Map([
  ['build.mjs', 'THE build step: it runs as `npm run build` inside the job, not as a separate check'],
  ['bundle.mjs', 'library module imported by build.mjs and check-docs.mjs, not a standalone script'],
  /**
   * ── Phase A 的两个 GENERATOR（不是断言）─────────────────────────────────────────────────────
   *
   * 两者的默认模式**写文件**：在 CI 里跑它们等于让流水线改仓库，而干净树本身是被检查的。
   * 它们的断言不因此缺席 —— `v325` / `v326` 在 `node --test`（= CI 步骤）里跑同一个脚本，
   * 后者用 `--check`。所以「未登记」与「投影过期」在 CI 上仍然会红。
   */
  ['handler-inventory.mjs', 'generator: writes docs/HANDLER-INVENTORY.md. Its ASSERTION (exit 1 on an unregistered unit) runs inside node --test via v325, which IS a CI step; running the generator in CI would modify the tree it is meant to check'],
  ['emit-taxonomy.mjs', 'generator: writes src/contracts/content-taxonomy.v1.json. Its --check assertion runs inside node --test via v326, which IS a CI step; the default mode rewrites a committed file'],
  /**
   * `index-ratchet.mjs` 的默认模式**就是断言**（超 ceiling / 未登记 ⇒ exit 1），但它的判据 `v327`
   * 已经在 `node --test` 里跑，而 `node --test` 是 `npm run check` 的最后一环、也是 CI 步骤。
   * 所以它不需要再作为独立 CI 步骤登记 —— 再登记一次只会让同一个断言在两个地方各跑一遍。
   */
  ['index-ratchet.mjs', 'asserting instrument whose criteria v327 already runs inside node --test (the last step of npm run check and a CI step); a separate CI step would run the same assertion twice'],
  /**
   * 本地 CI 代理：**clone + install + check**。它在 CI 里跑没有意义（CI 本身就是全新环境），
   * 而它会写临时目录、需要网络装依赖。它的用途是**在 CI 看不见时**抓「只在本地成立」的失败。
   */
  ['ci-fresh-clone.mjs', 'local proxy: clones the repo to a temp dir and runs the check chain there. Pointless as a CI step (CI IS a clean environment) and needs a registry; its job is to catch local-only failures while CI is unobserved'],
  /**
   * ── W4-1: THE MODULE THAT RUNS THE SUITE ONCE FOR EVERY GATE ───────────────────────────────────
   *
   * Not a CI step because it is not a step at all: it exports `observeSuite()`, which the three
   * count/docs/tally gates import. Running it directly would measure the suite and print nothing,
   * which is a tool, not a check.
   */
  ['suite-observation.mjs', 'library module imported by check-readme-counts / check-docs / check-readme-tally to share ONE suite run; it asserts nothing itself, so running it as a CI step would check nothing (B4-0b-2 W4-1)'],
  ['hot-paths.mjs', 'prints the per-turn hot-path table into docs/PERF-HOT-PATHS.md; asserts nothing and has no threshold, because a baseline is not a gate (B4-0b-2 W4-5)'],
  ['publish.mjs', 'release path; it publishes to npm and must never run on a push'],
  ['demo.mjs', 'demonstration script for humans; asserts nothing'],
  /**
   * ── WHY BURN-IN IS NOT A CI STEP (W1-13) ────────────────────────────────────────────────────────
   *
   * `check` answers "is this commit correct"; burn-in answers "is this SUITE trustworthy". The second
   * question needs the same file run 5–10 times, and its answer is a rate (`5/5`, `4/5`) — not a
   * boolean a gate can consume. CI runs each file ONCE per push, which is exactly why the rate has to
   * be measured somewhere else.
   *
   * The measurement is not optional: paradise was signed off at 「399/399, check exit 0」 and was red
   * on the next full run (397/399), then 4 red in 12 concurrent runs. A single green run is a READING.
   */
  ['burn-in.mjs', 'runs the same test file N times and reports a RATE; CI runs each file once, so wiring it in would slow every push and yield a boolean that cannot express stability (B4-0b-2 W1-13)'],
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
  ['bench-smoke.mjs', 'a MEASURING instrument for the B0.5 performance baseline: it records one pure function\'s median over 100k calls and ALWAYS exits 0, so it can assert nothing. Its numbers are quoted in docs/PERF-BASELINE-2026-11-16.md. Deliberately no threshold: a threshold needs a known normal range, and that range does not exist yet'],
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
  ['who-references.mjs', 'an INSTRUMENT (it measures and always exits 0): it is run BY `scripts/check-symbol-lookup.mjs`, which is the CI step — and now also a local `npm run check` step — that asserts its answer. Until 2026-11-17 the assertion was `node -e` inline in ci.yml writing /tmp/refs.json, which is why this file looked like a CI step itself; that shape could not be reproduced on Windows at all'],
  ['calibrate-who-references.mjs', 'a CALIBRATION for who-references.mjs: it asserts a known answer (5 real references across three shapes). It is run by test/v141 as a precondition, which is the point — the classifier must be calibrated BEFORE its answer is trusted, not after it is published'],
  ['families.mjs', 'needs closure.mjs and who-references.mjs, both of which need the TypeScript compiler this package deliberately does not depend on. It also answers a question that only exists DURING a refactor — "which declarations still cluster together" — so there is nothing to assert on a tree with no pending move; the 10-component table it printed is quoted in the step5 commit message instead of pinned here'],
  /**
   * ── W0-2 §12.5: THE TWO MEASUREMENT SCRIPTS, AND WHY THEY ARE NOT CI STEPS ────────────────────
   *
   * They were REQUIRED to be committed precisely because 「没有可复跑物，数字就只是声称」 — the first W0
   * run lived in a temp directory and the next generation could read the conclusion but not re-run it.
   * Committing them is the fix; running them on CI is not, for the same reason `scan-real-logs.mjs` is
   * not: both read a LIVE DSH session store (`$DSH_HOME/sessions`), and a CI runner has none. On an
   * empty store they would exit 2, which the classification rule exists to keep out of the gate list.
   *
   * `w0-three-layers.mjs` imports `src/core/nudge-margin.ts` — the shipped decision functions, so the
   * measurement cannot drift from the code it measures. That import works because Node 24 strips types.
   */
  ['w0-token-jump.mjs', 'measures per-step token growth over a real session store. It is the re-runnable artifact for the W0 numbers, not a gate: a CI runner has no session store, so it exits 2 by design. Its verdict is quoted in 报告/B4-0b-2-W0-测量.md, and `--exclude-resets` is its can-red'],
  ['w0-three-layers.mjs', 'replays the same corpus through the SHIPPED `shouldNudge`/`predictGrowthTokens` and reports layer 2 / layer 3 coverage. Same store dependency, same reason it is not a gate. `test/v260` is the CI-safe pin for the same behaviour, driven through the real `agent/pre-step` listener on fixtures'],
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

test('meta: measure-efficiency writes a recomputable JSONL record (fields complete, delta/spread reproducible)', () => {
  /**
   * 用户裁定（2026-11-13）：判决必须落盘，且落盘的字段要足以**独立复算** primary delta 与 spread。
   *
   * 判据三条：
   *   ① 跑完必须生成文件；
   *   ② 字段齐全（每轮原始读数 + primary + quality + verdict + 两个 bundle 的 sha256）；
   *   ③ 用文件里的 per-run 数据**重新算** delta 与 spread，必须与文件里记的一致 —— 这才是「可复核」。
   *
   * 退出码不断言：同一份 bundle 自比也可能被判 UNFIT（这台机器噪声大），那不影响落盘。
   */
  const tmp = mkdtempSync(join(tmpdir(), 'v129-eff-'))
  const outFile = join(tmp, 'runs.jsonl')
  try {
    try {
      execFileSync(process.execPath, [
        join(ROOT, 'scripts', 'measure-efficiency.mjs'),
        '--before', join(ROOT, 'index.js'), '--after', join(ROOT, 'index.js'),
        '--export', 'buildTape', '--rounds', '3', '--calls', '20', '--repeat', '5', '--out', outFile,
      ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    } catch {
      // a verdict of UNFIT/REGRESSION exits non-zero; the record must exist regardless
    }

    assert.ok(existsSync(outFile), 'the run must write the record file')
    const lines = readFileSync(outFile, 'utf8').trim().split('\n').filter((l) => l.trim() !== '')
    assert.equal(lines.length, 1, 'one run appends exactly one JSONL line')
    const record = JSON.parse(lines[0])

    for (const key of ['tool', 'recordedAt', 'subject', 'sampling', 'bundles', 'runs', 'primary', 'quality', 'verdict']) {
      assert.ok(key in record, `the record must carry "${key}"`)
    }
    assert.equal(record.runs.length, 5, 'every independent run must be recorded, not just the aggregate')
    for (const run of record.runs) {
      for (const key of ['beforeBest', 'afterBest', 'delta', 'control']) {
        assert.equal(typeof run[key], 'number', `each run needs a numeric ${key}`)
      }
    }
    for (const side of ['before', 'after']) {
      assert.match(record.bundles[side].sha256, /^[0-9A-F]{64}$/u, `${side} bundle must be identified by sha256`)
    }

    // ③ 独立复算：只用文件里的 per-run 原始数字
    const beforeBests = record.runs.map((r) => r.beforeBest)
    const afterBests = record.runs.map((r) => r.afterBest)
    const deltas = record.runs.map((r) => r.delta)
    const minBefore = Math.min(...beforeBests)
    const minAfter = Math.min(...afterBests)
    const recomputedDelta = (minAfter - minBefore) / minBefore
    const recomputedSpread = Math.max(...deltas) - Math.min(...deltas)

    assert.ok(Math.abs(recomputedDelta - record.primary.delta) < 1e-12,
      `primary delta must be recomputable from the file: ${recomputedDelta} vs ${record.primary.delta}`)
    assert.ok(Math.abs(recomputedSpread - record.quality.spread) < 1e-12,
      `spread must be recomputable from the file: ${recomputedSpread} vs ${record.quality.spread}`)
    assert.equal(record.primary.minBefore, minBefore, 'minBefore is recorded, not re-derived differently')
    assert.equal(record.primary.minAfter, minAfter, 'minAfter is recorded')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
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
