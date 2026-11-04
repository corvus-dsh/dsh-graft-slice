/**
 * v0.18 module 3 — a handoff with a SHORTENED rule set is not shipped.
 *
 * THE v0.18 DEFECT (kept here as the reason this file exists). Extraction used to keep
 * the best 8 candidates and stop at 8000 characters with a bare `break`. Both are
 * silent, so a target could read a goal message whose HARD CONSTRAINTS block was
 * missing the rule it was about to violate — the exact failure the block exists to
 * prevent, committed by the plugin itself.
 *
 * THE v0.23 REVISION, and why the assertions below changed. v0.18 answered that defect
 * by refusing to ship at all when a rule did not fit. Correct, and it made a long-lived
 * project unsliceable: after twenty turns of accumulated policy the block overflowed
 * and the ONLY way forward was to delete rules by hand. Live, it produced a 27-item
 * constraint block that every migration carried into the prompt — a changelog the model
 * had to read before it could find its own boundaries.
 *
 * So the rule set is now split by PLACEMENT, not shortened:
 *
 *   constraints (≤ CONSTRAINT_PROMPT_MAX)  the red lines — what enters the PROMPT
 *   archived                               everything else — preserved on the HANDOFF
 *
 * Nothing is deleted. What changed is which array is spent on every turn.
 *
 * What is asserted here:
 *   1. `selectConstraints` caps the PROMPT at five red lines and preserves the rest;
 *   2. red lines win the prompt slots over equally-ranked standing rules;
 *   3. `archived` + `constraints` accounts for every qualifying candidate (no loss);
 *   4. `assertConstraintsPreserved` still aborts on a genuine LOSS, but a rule that
 *      moved to `archived` is not a loss;
 *   5. `buildInjectionPlan` returns a plan carrying the red lines AND the archive.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertConstraintsPreserved,
  buildInjectionPlan,
  CONSTRAINT_BUDGET_CHARS,
  CONSTRAINT_PROMPT_MAX,
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

test('v0.23: the PROMPT is capped at five red lines, and every other rule is preserved', () => {
  // The v0.18 assertion here was `selection.constraints.length === 6` and an empty
  // drop list: every rule entered the prompt because the budget allowed it. That is the
  // behaviour the user asked to change. What must NOT change is that no rule is lost.
  const heavy = rulesMessage(6)
    .split('\n')
    .map((text, index) => ({ text, index, score: index }))
  const selection = selectConstraints(heavy, CONSTRAINT_BUDGET_CHARS)

  assert.equal(selection.constraints.length, CONSTRAINT_PROMPT_MAX, 'the prompt carries five')
  assert.equal(selection.archived.length, 6 - CONSTRAINT_PROMPT_MAX, 'the sixth is archived, not deleted')
  assert.equal(
    selection.constraints.length + selection.archived.length,
    selection.candidateCount,
    'EVERY candidate is accounted for: this is the v0.18 promise, kept',
  )
  assert.deepEqual(selection.dropped, [], 'nothing was lost, so nothing is dropped')

  // Kept rules read in the user's order; the packed set is chosen by score.
  const tight = selectConstraints(heavy, heavy[5].text.length + 1)
  assert.equal(tight.constraints.length, 1, 'a tight budget still yields at least the best rule')
  assert.equal(tight.constraints[0], heavy[5].text, 'the highest score survives the tight budget')
  assert.equal(
    tight.constraints.length + tight.archived.length,
    tight.candidateCount,
    'a tight budget archives the rest instead of dropping them',
  )

  // No rule is ever cut mid-sentence: the kept text is byte-identical.
  for (const text of tight.constraints) {
    assert.equal(heavy.some((candidate) => candidate.text === text), true)
  }
})

test('v0.23: an ABSOLUTE prohibition outranks an equally-scored standing rule', () => {
  // The prompt slots are scarce, so what wins them is a design decision, not an
  // accident of ordering. A red line ("never", "绝对禁止") is what a model must not
  // violate while working; a standing rule is context it can look up.
  const candidates = [
    { text: 'Always keep bravo configuration enabled for this session.', index: 0, score: 5 },
    { text: 'Always keep charlie configuration enabled for this session.', index: 1, score: 5 },
    { text: '绝对禁止在未备份的情况下删除任何文件。', index: 2, score: 1 },
  ]
  const selection = selectConstraints(candidates, CONSTRAINT_BUDGET_CHARS)
  assert.equal(selection.constraints.includes('绝对禁止在未备份的情况下删除任何文件。'), true, 'the red line takes a prompt slot')
  assert.equal(selection.constraints.length, 3, 'there is room for all three, in original order')
  // ...and with no room, the red line still wins.
  const scarce = selectConstraints(candidates, 40)
  assert.equal(scarce.constraints.length, 1)
  assert.equal(scarce.constraints[0], '绝对禁止在未备份的情况下删除任何文件。', 'scarcity goes to the red line')
  assert.equal(scarce.archived.length, 2, 'the two standing rules are archived, not lost')
})

test('v0.23: the archive reaches the extractor, and nothing silently vanishes', () => {
  const events = logWithRules(12).events
  const full = extractConstraintsDetailed(events)
  assert.equal(full.constraints.length, CONSTRAINT_PROMPT_MAX, 'the prompt stays small however long the project runs')
  assert.equal(
    full.constraints.length + full.archived.length >= 12,
    true,
    'all twelve rules survive somewhere',
  )
  assert.deepEqual(full.dropped, [], 'archiving is not dropping')
  // The compatibility shape returns the PROMPT rules only, which is the point.
  assert.deepEqual(extractConstraints(events), full.constraints)

  const tight = extractConstraintsDetailed(events, 200)
  assert.equal(
    tight.constraints.length + tight.archived.length,
    tight.candidateCount,
    'a tight budget preserves the total count exactly',
  )
})

test('v0.23: assertConstraintsPreserved aborts on a real LOSS, not on an archive', () => {
  // A selection that genuinely lost a rule (the only remaining cause: it could not be
  // preserved anywhere) must still abort. This is the v0.18 guarantee, intact.
  const lossy = {
    constraints: ['one rule'],
    archived: [],
    dropped: [{ text: 'a rule that vanished', chars: 19, reason: 'budget' }],
    budgetChars: 60,
    totalChars: 8,
    candidateCount: 2,
    redlineCount: 1,
  }
  assert.throws(
    () => assertConstraintsPreserved(lossy, 'source=session-x'),
    (error) => {
      assert.equal(error.code, 'GRAFT_ABORTED')
      assert.match(error.message, /constraints truncated/u)
      assert.match(error.message, /constraintBudgetChars=60/u)
      assert.match(error.message, /source=session-x/u)
      return true
    },
  )
  // A selection that ARCHIVED rules did not lose anything and must NOT abort — this is
  // the assertion that changed, and it is the whole point of the revision.
  const archivedNotLost = selectConstraints(
    rulesMessage(8)
      .split('\n')
      .map((text, index) => ({ text, index, score: index })),
    60,
  )
  assert.ok(archivedNotLost.archived.length > 0, 'the tight budget archived rules')
  assert.doesNotThrow(() => assertConstraintsPreserved(archivedNotLost), 'archiving is not a truncated rule set')
  // An empty selection is not an error.
  assert.doesNotThrow(() => assertConstraintsPreserved(selectConstraints([], 100)))
})

test('v0.23: buildInjectionPlan ships the red lines AND carries the archive', () => {
  const log = logWithRules(12)
  const plan = buildInjectionPlan(log, { constraintBudgetChars: CONSTRAINT_BUDGET_CHARS })

  assert.equal(plan.constraints.length <= CONSTRAINT_PROMPT_MAX, true, 'the prompt block stays small')
  assert.equal(plan.constraintIntegrity.dropped, 0, 'nothing was lost')
  assert.equal(plan.constraintIntegrity.kept, plan.constraints.length)
  assert.equal(plan.constraintIntegrity.candidateCount >= 12, true)
  assert.equal(plan.constraintIntegrity.budgetChars, CONSTRAINT_BUDGET_CHARS)
  assert.equal(
    plan.constraintIntegrity.archived >= 12 - CONSTRAINT_PROMPT_MAX,
    true,
    'the rules that left the prompt are still in the handoff',
  )

  // The v0.18 abort-on-overflow behaviour is gone by design: a project may now carry
  // more policy than fits a prompt without becoming unsliceable. The rules are not
  // lost, so there is nothing to abort on.
  assert.doesNotThrow(
    () => buildInjectionPlan(log, { constraintBudgetChars: 200 }),
    'a small budget now archives rather than aborting',
  )
  const tight = buildInjectionPlan(log, { constraintBudgetChars: 200 })
  assert.equal(tight.constraintIntegrity.dropped, 0)
  assert.equal(tight.constraints.length <= CONSTRAINT_PROMPT_MAX, true)
})

test('v0.23: the capacity is a config knob, and the prompt cap is a constant', () => {
  assert.equal(normalizeConfig({}).constraintBudgetChars, CONSTRAINT_BUDGET_CHARS)
  assert.equal(normalizeConfig({ constraintBudgetChars: 20_000 }).constraintBudgetChars, 20_000)

  // A large capacity must NOT grow the prompt past the cap: capacity is about what may
  // be PRESERVED, the cap is about what may be SPENT per turn.
  const log = logWithRules(12)
  const migrated = buildInjectionPlan(log, { constraintBudgetChars: 20_000 })
  assert.equal(migrated.constraintIntegrity.dropped, 0)
  assert.equal(migrated.constraints.length <= CONSTRAINT_PROMPT_MAX, true, 'a big budget is not a big prompt')
  assert.equal(CONSTRAINT_PROMPT_MAX, 5)
})
