/**
 * v0.18 module 3 — a handoff with a SHORTENED rule set is not shipped.
 *
 * The defect: extraction kept the best 8 candidates and stopped at 8000 characters
 * with a bare `break`. Both are silent, so a target could read a goal message whose
 * HARD CONSTRAINTS block was missing the rule it was about to violate — the exact
 * failure the block exists to prevent, committed by the plugin itself.
 *
 * What is asserted here:
 *   1. capacity decides how many rules survive, and every rule that does not fit is
 *      REPORTED (no count cap, no mid-sentence truncation);
 *   2. `assertConstraintsPreserved` turns that report into `GRAFT_ABORTED`;
 *   3. `buildInjectionPlan` — the single choke point every migration path shares —
 *      aborts, and a plan that IS returned carries positive proof of completeness.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertConstraintsPreserved,
  buildInjectionPlan,
  CONSTRAINT_BUDGET_CHARS,
  extractConstraints,
  extractConstraintsDetailed,
  normalizeConfig,
  selectConstraints,
} from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

/** A user message full of standing rules, all of which qualify as constraints. */
const RULE_SEEDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot',
  'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
]

function rulesMessage(count = RULE_SEEDS.length) {
  return RULE_SEEDS.slice(0, count)
    .map((seed) => `Always keep ${seed} configuration enabled for this session.`)
    .join('\n')
}

function logWithRules(count) {
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: log.events.length,
    time: Date.now(),
    data: {
      id: `rules-${count}`,
      role: 'user',
      content: [{ type: 'text', text: rulesMessage(count) }],
      source: { kind: 'user' },
    },
  })
  return log
}

test('v0.18: selection is budget-driven, orders by score, and reports every drop', () => {
  const heavy = rulesMessage(6)
    .split('\n')
    .map((text, index) => ({ text, index, score: index }))
  const selection = selectConstraints(heavy, CONSTRAINT_BUDGET_CHARS)
  assert.equal(selection.constraints.length, 6)
  assert.deepEqual(selection.dropped, [])
  assert.equal(selection.candidateCount, 6)

  // Kept rules read in the user's order; the packed set is chosen by score.
  const tight = selectConstraints(heavy, heavy[5].text.length + 1)
  assert.equal(tight.constraints.length, 1)
  assert.equal(tight.dropped.length, 5)
  assert.equal(tight.constraints[0], heavy[5].text, 'the highest score survives the tight budget')
  assert.ok(tight.dropped.every((item) => item.reason === 'budget' && item.chars > 0))

  // No rule is ever cut mid-sentence: the kept text is byte-identical.
  for (const text of tight.constraints) {
    assert.equal(heavy.some((candidate) => candidate.text === text), true)
  }
})

test('v0.18: the loss report reaches the extractor, not just the packer', () => {
  const events = logWithRules(12).events
  const full = extractConstraintsDetailed(events)
  assert.equal(full.constraints.length >= 12, true, 'every qualifying rule fits the default budget')
  assert.deepEqual(full.dropped, [])
  // The compatibility shape returns the same strings.
  assert.deepEqual(extractConstraints(events), full.constraints)

  const tight = extractConstraintsDetailed(events, 200)
  assert.ok(tight.dropped.length > 0)
  assert.equal(tight.constraints.length + tight.dropped.length, tight.candidateCount)
})

test('v0.18: assertConstraintsPreserved aborts with GRAFT_ABORTED and names the count', () => {
  const selection = selectConstraints(
    rulesMessage(4)
      .split('\n')
      .map((text, index) => ({ text, index, score: 0 })),
    60,
  )
  assert.ok(selection.dropped.length > 0)
  assert.throws(
    () => assertConstraintsPreserved(selection, 'source=session-x'),
    (error) => {
      assert.equal(error.code, 'GRAFT_ABORTED')
      assert.match(error.message, /constraints truncated/u)
      assert.match(error.message, /constraintBudgetChars=60/u)
      assert.match(error.message, /source=session-x/u)
      return true
    },
  )
  // A complete selection is not an error.
  assert.doesNotThrow(() => assertConstraintsPreserved(selectConstraints([], 100)))
})

test('v0.18: buildInjectionPlan refuses to ship a shortened block', () => {
  const log = logWithRules(12)
  const fits = buildInjectionPlan(log, { constraintBudgetChars: CONSTRAINT_BUDGET_CHARS })
  assert.equal(fits.constraintIntegrity.dropped, 0)
  assert.equal(fits.constraintIntegrity.kept, fits.constraints.length)
  assert.equal(fits.constraintIntegrity.candidateCount >= 12, true)
  assert.equal(fits.constraintIntegrity.budgetChars, CONSTRAINT_BUDGET_CHARS)
  assert.equal(fits.constraintIntegrity.totalChars, fits.constraints.reduce((sum, item) => sum + item.length, 0))

  assert.throws(
    () => buildInjectionPlan(log, { constraintBudgetChars: 200 }),
    (error) => {
      assert.equal(error.code, 'GRAFT_ABORTED')
      assert.match(error.message, /constraints truncated/u)
      return true
    },
    'a plan whose rule set does not fit must not be returned at all',
  )
})

test('v0.18: the capacity is a config knob, and it is a number an operator can raise', () => {
  assert.equal(normalizeConfig({}).constraintBudgetChars, CONSTRAINT_BUDGET_CHARS)
  assert.equal(normalizeConfig({ constraintBudgetChars: 20_000 }).constraintBudgetChars, 20_000)

  const log = logWithRules(12)
  assert.throws(() => buildInjectionPlan(log, { constraintBudgetChars: 200 }), /GRAFT_ABORTED/u)
  // The same log migrates once the capacity is declared large enough: the abort is
  // about capacity, not about the log.
  const migrated = buildInjectionPlan(log, { constraintBudgetChars: 20_000 })
  assert.equal(migrated.constraintIntegrity.dropped, 0)
})
