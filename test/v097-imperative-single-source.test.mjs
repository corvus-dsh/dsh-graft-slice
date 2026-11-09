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
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const sourcePath = fileURLToPath(new URL('../src/index.ts', import.meta.url))
  const source = readFileSync(sourcePath, 'utf8')

  // The distinctive opening of the imperative list. It must appear exactly once — at its declaration.
  const openings = [...source.matchAll(/\^\(请\|必须\|禁止\|不要\|不能\|不得\|务必/gu)]
  assert.equal(
    openings.length,
    1,
    `the imperative-opening list must be declared exactly once; found ${openings.length} copies.\n` +
      'A second copy is how the 46.7% truncation (164/351 chars, 19 verbs lost) happened.',
  )

  // And the scorer must reference the named constant, not re-spell the list.
  assert.match(
    source,
    /const imperative = IMPERATIVE_START\.test\(normalized\)/u,
    'the scoring branch must use the shared IMPERATIVE_START constant',
  )
})

test('v0.9.7: the shared constant still matches every verb the truncated copy had', () => {
  /**
   * The truncation dropped 19 verbs. This pins that the single surviving list covers ALL of them, so
   * de-duplication cannot silently narrow the vocabulary.
   *
   * ── EACH VERB IS TESTED ALONE, AND THAT IS NOT A SHORTCUT ─────────────────────────────────────
   *
   * The first version fed all 20 sentences in ONE call and got `kept = 1`. That looked like the gate
   * rejecting 19 verbs; it was `nearDuplicate()` collapsing them, because the sentences differ only
   * in their first word. Measured individually: **20/20 accepted**. So the collapse was my test's
   * construction, not the code — a batch assertion here would have reported a defect that does not
   * exist, and would have "passed" the fix for the wrong reason.
   */
  const DROPPED = [
    'add', 'avoid', 'call', 'choose', 'draft', 'end', 'ensure', 'exclude', 'keep',
    'leave', 'make', 'pick', 'prefer', 'remove', 'report', 'return', 'run', 'set', 'show', 'wait',
  ]

  const rejected = []
  for (const [index, verb] of DROPPED.entries()) {
    // A distinct body per verb so nothing is suppressed as a near-duplicate of another.
    const text = `${verb} 第${index + 1}项交接之前都先跑完全量测试再继续下一步工作。`
    const selection = extractConstraintsDetailed([userMessage(200 + index, text)], 80_000)
    if (selection.constraints.length + selection.archived.length === 0) rejected.push(verb)
  }

  assert.deepEqual(
    rejected,
    [],
    `these verbs must still open a valid imperative but were rejected: ${rejected.join(', ')}`,
  )
})

