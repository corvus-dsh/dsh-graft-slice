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

/** Gate scripts: everything named `check-*.mjs`, plus the bundle contract. These MUST be CI steps. */
const gateScripts = readdirSync(join(ROOT, 'scripts'))
  .filter((name) => /^check-.*\.mjs$/u.test(name) || name === 'verify-bundle.mjs')
  .sort()

/**
 * The measuring instruments are gates PLUS the two that measure rather than assert. The distinction
 * matters: a gate can be a CI step, an instrument may need a tool CI does not have. Both belong in the
 * coverage rule, so neither can be quietly forgotten — that is the whole point of listing them.
 */
const INSTRUMENTS = [...gateScripts, ...EXEMPT.keys()].sort()

test('meta: the gate set has a denominator (an empty scan must not pass)', () => {
  assert.ok(gateScripts.length >= 4,
    `found only ${gateScripts.length} gate script(s) under scripts/. A gate that scans nothing reports no problems.`)
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
   * The instruments are gates PLUS `closure.mjs` and `verify-pure-move.mjs`. The two are not gates —
   * one needs a compiler CI does not install, the other compares against a ref that equals the tree in
   * CI — but they still have to be ACCOUNTED FOR, which is why they are in the same list and must carry
   * a reason. An exemption without a reason is a hole with a label.
   */
  const referenced = new Set([...ciText.matchAll(/scripts\/([\w.-]+\.mjs)/gu)].map((match) => match[1]))
  const unaccounted = INSTRUMENTS.filter((name) => !referenced.has(name) && !EXEMPT.has(name))
  assert.deepEqual(unaccounted, [], 'instruments that are neither CI steps nor explained: ' + unaccounted.join(', '))
  assert.ok(INSTRUMENTS.length >= 6, `expected at least 6 instruments, found ${INSTRUMENTS.length}`)
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
