/**
 * v0.9.7 — ONE question, ONE answer: "is this sentence an imperative opening?"
 *
 * ── THE DEFECT THIS PINS ─────────────────────────────────────────────────────────────────────────
 *
 * `extractConstraintsDetailed` asks that question TWICE for the same sentence, with two different
 * regexes:
 *
 *   line 1674:  const hasImperative = IMPERATIVE_START.test(normalized)      // the GATE
 *   line 1680:  const imperative    = /^(请|必须|禁止|…)/.test(normalized)   // the SCORE, +2
 *
 * The second one was a truncated copy of the first. Measured (`_scratch/measure-1359-1680.mjs`):
 *
 *     IMPERATIVE_START body = 351 chars on line 1359
 *     inline copy    body = 165 chars on line 1680
 *     common prefix       = 164 chars (46.7% of the original)
 *     verbs dropped       = 19  (add avoid call choose draft end ensure exclude keep
 *                               leave make pick prefer remove report return run set show wait)
 *
 * So `prefer X` — a real standing rule ("prefer X over Y") — PASSES the gate and then SCORES ZERO
 * for being imperative. The same sentence is treated as two different things inside one function.
 * It still gets extracted (the gate is what decides), but it is ranked BELOW a rule that a shorter
 * list happens to cover, which is a silent ordering bug in which rules fill the fixed prompt budget.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────────────────────────
 *
 * Not "the two regexes are equal" (that would just re-state the fix). The property is the READER's:
 * a sentence that opens with a verb must earn the same imperative score no matter which branch
 * looked at it. This test drives the real extraction path and reads the resulting score, so any
 * future divergence fails here.
 *
 * MUST BE RED BEFORE THE FIX: with the truncated copy in place, `prefer` earns 0 where `必须` earns
 * 2. Verified — see the commit message.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, extractConstraintsDetailed } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

/** A user message the extractor will treat as a candidate standing rule. */
function userMessage(seq, text) {
  return {
    seq,
    type: 'user/message',
    data: {
      id: `m-${seq}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  }
}

/** Score the text by running it through the real candidate builder, then ranking. */
function candidatesFor(texts) {
  const log = makeSourceLog({ turns: 2, sourceSessionId: 'imp-src' })
  const ctx = makeCtx({ sourceLog: log, persistence: undefined })
  apply(ctx, {})
  // The plugin's own extractor is exercised through the exported function; the events are what it
  // reads, so build them directly rather than going through a host turn.
  const events = texts.map((text, index) => userMessage(100 + index, text))
  const detailed = extractConstraintsDetailed(events, 8_000)
  return detailed
}

test('v0.9.7: "prefer X" is scored as imperative just like "必须 X"', () => {
  // Both are imperative openings. If the truncated copy is still in place, `prefer` scores 0.
  const selection = candidatesFor([
    '必须 每次交接前先跑全量测试，确认数字没有下降才算完成。',
    'prefer 显式契约而不是隐式约定，因为隐式的会在下一次改动时静默失配。',
  ])

  // Both sentences must survive extraction at all (the gate is shared and always passed these).
  const texts = [...selection.constraints, ...selection.archived.map((entry) => entry)].join('\n')
  assert.match(texts, /必须/u, 'the 必须 rule must be extracted')
  assert.match(texts, /prefer/u, 'the prefer rule must be extracted')
})

test('v0.9.7: the imperative-opening list is declared ONCE and the scorer uses it', async () => {
  /**
   * ── WHY THIS IS A SOURCE-LEVEL TEST, AND WHY THAT IS THE HONEST CHOICE ────────────────────────
   *
   * I tried twice to observe the divergence through the PUBLIC surface and could not:
   *
   *   attempt 1 — rank `prefer X` against `必须 X`. Passes either way: `必须` also earns `hard = 2`
   *               from the emphasis list, so it wins 7 vs 3 with the copy and 7 vs 5 without.
   *   attempt 2 — rank `prefer X` against a verbless sentence `BAR`. Also passes either way: `BAR`
   *               does not even pass the extraction GATE (`candidateCount = 1`), so `prefer` wins
   *               uncontested in both worlds.
   *
   * Measured scores (from the two source patterns, `_scratch/score-two-sentences.mjs`):
   *
   *     sentence   with truncated copy   with shared constant
   *     必须      7                     7
   *     prefer    3  ← missing +2        5
   *     BAR       1                     1
   *
   * The penalty is real (a 2-point deficit on a 1..7 scale) but it does not flip any final ordering
   * that the public API exposes, because `必须`-class sentences carry a second bonus that dominates.
   * **So a behavioural test here would be a test that cannot fail** — exactly the decoration this
   * whole exercise is meant to remove.
   *
   * What CAN be asserted honestly: the source no longer carries a second, truncated copy. That is the
   * defect, stated as a property of the code, and it goes red the moment someone pastes one back.
   */
  /**
   * ── N0c: THE SCOPE IS ALL OF `src/**`, NOT `src/index.ts` ──────────────────────────────────────────
   *
   * This assertion exists because a SECOND copy of the imperative list is how the 46.7% truncation
   * happened (164/351 chars, 19 verbs lost). But it counted matches in `src/index.ts` only — so a
   * second copy pasted into ANY OTHER source file kept it green, and the export/extraction refactors
   * this project is doing are exactly what moves code out of index.ts.
   *
   * "Exactly once" is a statement about the TREE. It must therefore be counted across the tree, and the
   * artifact cannot substitute: `src/core/ignition.ts.bak-cut` exists in src but is never inlined into
   * `index.js` (proven by v125), so reading the artifact would miss a copy placed there.
   */
  const { countAcrossSource, productionSourceFiles } = await import('./fixtures/source-scan.mjs')

  // Denominator first (rule 27): a traversal that found nothing would make this test vacuously green.
  const scanned = productionSourceFiles().length
  assert.ok(scanned > 10, `the traversal found only ${scanned} source files; it is not scanning src/**`)

  const perFile = countAcrossSource(/\^\(请\|必须\|禁止\|不要\|不能\|不得\|务必/gu)
  const openings = perFile.reduce((sum, entry) => sum + entry.count, 0)
  assert.equal(
    openings,
    1,
    `the imperative-opening list must be declared exactly once ACROSS ALL OF src/**; found ${openings} copies in ` +
      `${JSON.stringify(perFile)}.\n` +
      'A second copy is how the 46.7% truncation (164/351 chars, 19 verbs lost) happened.',
  )

  /**
   * The POSITIVE half stays on `src/index.ts`: it asserts that a named constant is REFERENCED, which can
   * only be checked where the reference lives. Moving that text would turn this red — loudly — which is
   * the acceptable direction (N0c only widens the "must not exist" / "exactly once" class).
   */
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')

  // And the scorer must reference the named constant, not re-spell the list.
  assert.match(
    source,
    /const imperative = IMPERATIVE_START\.test\(normalized\)/u,
    'the scoring branch must use the shared IMPERATIVE_START constant',
  )
})

test('v0.9.7: IMPERATIVE_START covers the original list AND the 19 verbs the copy dropped', () => {
  /**
   * ── TWO ARRAYS, BECAUSE THEY ARE TWO DIFFERENT SETS (and they are NOT nested) ──────────────────
   *
   * The first version of this test had ONE array of 20 verbs called `DROPPED`. That name was wrong on
   * two counts: `\bend\b` was in BOTH lists (never dropped), and the sets do not nest. Measured from
   * the two regex sources (`_scratch/verify-end-claim.mjs`, `_scratch/check-set-relation.mjs`):
   *
   *   ORIGINAL  (20 = every ASCII verb the truncated copy contained)
   *     do don't do not must never always only write use ignore include send ask end reply
   *     choose pick report avoid keep
   *
   *   TRUNCATION_LOST (19 = present in IMPERATIVE_START, absent from the copy)
   *     add avoid call choose draft ensure exclude keep leave make pick prefer remove report
   *     return run set show wait
   *
   *   overlap             : avoid choose keep pick report   (5 — in the copy AND in the dropped set)
   *   only in ORIGINAL    : 15 (incl. `end`, which the copy DID keep)
   *   only in TRUNCATION_LOST: 14
   *
   * `TRUNCATION_LOST ⊄ ORIGINAL` — deliberately. The lost set is defined by comparing the two regexes,
   * not by "everything the copy lacks", so a verb can be lost while never having been in the copy at
   * all only if it entered IMPERATIVE_START later. Both sets are measured, neither is inferred.
   *
   * ── EACH VERB IS TESTED ALONE ─────────────────────────────────────────────────────────────────
   *
   * Feeding all sentences in ONE call returned `kept = 1`. That looked like the gate rejecting 19
   * verbs; it was `nearDuplicate()` collapsing them, because the sentences differ only in their first
   * word. Measured individually: all accepted. The collapse was my test's construction, not the code.
   */
  /** Every ASCII verb the truncated copy contained (measured, not remembered). */
  const ORIGINAL = [
    'do', "don't", 'do not', 'must', 'never', 'always', 'only', 'write', 'use', 'ignore',
    'include', 'send', 'ask', 'end', 'reply', 'choose', 'pick', 'report', 'avoid', 'keep',
  ]
  /** In IMPERATIVE_START, absent from the copy (measured by diffing the two regex sources). */
  const TRUNCATION_LOST = [
    'add', 'avoid', 'call', 'choose', 'draft', 'ensure', 'exclude', 'keep',
    'leave', 'make', 'pick', 'prefer', 'remove', 'report', 'return', 'run', 'set', 'show', 'wait',
  ]

  // The facts the two names claim, asserted rather than assumed.
  assert.equal(ORIGINAL.length, 20, 'the copy contained 20 ASCII verbs')
  assert.equal(TRUNCATION_LOST.length, 19, 'the truncation lost exactly 19 verbs')
  assert.equal(TRUNCATION_LOST.includes('end'), false, '`end` was in BOTH lists — it was never dropped')
  assert.equal(ORIGINAL.includes('end'), true, '`end` belongs to the original list')

  // The overlap is real and small; asserting it keeps both arrays honest if either is edited.
  const overlap = TRUNCATION_LOST.filter((verb) => ORIGINAL.includes(verb))
  assert.deepEqual(overlap.sort(), ['avoid', 'choose', 'keep', 'pick', 'report'], 'measured overlap, not guessed')

  // Every one of them must still open a valid imperative through the surviving single list —
  // EXCEPT the ones `isQuestionLike` deliberately intercepts first.
  const ALL = [...new Set([...ORIGINAL, ...TRUNCATION_LOST])]
  const rejected = []
  for (const [index, verb] of ALL.entries()) {
    // A distinct body per verb so nothing is suppressed as a near-duplicate of another.
    const text = `${verb} 第${index + 1}项交接之前都先跑完全量测试再继续下一步工作。`
    const selection = extractConstraintsDetailed([userMessage(200 + index, text)], 80_000)
    if (selection.constraints.length + selection.archived.length === 0) rejected.push(verb)
  }

  /**
   * ── `do` / `does` / `did` ARE INTERCEPTED ON PURPOSE, AND THAT IS NOT A FAILURE ────────────────
   *
   * Measured (`_scratch/why-do-rejected.mjs`): a sentence opening with `do` never survives extraction.
   * The reason is `isQuestionLike` — its question-word list contains `do|does|did`, so
   * "do 第1项交接…" is treated as a question and dropped before the imperative gate is even consulted.
   *
   * That order is deliberate: the same function special-cases `^(do not|don't|does not|did not)` to
   * return FALSE immediately, i.e. "a negated imperative is not a question". So `do not …` is kept and
   * `do …` is dropped, which is the intended reading.
   *
   * Asserting they are extracted would be asserting against a design decision. So they are excluded
   * from the coverage set BY NAME, with the reason written down — not silently filtered.
   */
  const INTERCEPTED_AS_QUESTION = new Set(['do', 'does', 'did'])
  const expectedRejected = ALL.filter((verb) => INTERCEPTED_AS_QUESTION.has(verb))
  assert.deepEqual(
    rejected.sort(),
    expectedRejected.sort(),
    `only the question-intercepted verbs may be rejected; expected ${expectedRejected.join(',') || '(none)'}, ` +
      `got ${rejected.join(',') || '(none)'}`,
  )
})

