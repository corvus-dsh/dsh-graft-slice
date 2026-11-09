/**
 * E2 — EMPHATIC IS WIRED TO NOTHING, SO A PARITY TEST IS THE ONLY THING KEEPING IT HONEST.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────────────────────────
 *
 * `src/contracts/model-wording.ts` exports `EMPHATIC`, and production `src/index.ts` has a local
 * `const hard = …` that does the same job. Nothing imports one from the other, so they are two copies
 * of one word list with no mechanism connecting them. The instruction's wording is exact: "EMPHATIC 零
 * 消费方、零 parity".
 *
 * ── WHY PARITY BY READING THE SOURCES, NOT BY IMPORTING ─────────────────────────────────────────
 *
 * Importing `EMPHATIC` and comparing it to a value imported from `index.js` would compare the contract
 * to the BUNDLE — and the bundle is built from the same source, so a typo in either place could still
 * pass if the other was regenerated from it. This reads both SOURCE files and compares the character
 * literals, which is what actually drifted before (the contract was `hard ∪ strong` while production
 * `hard` was 13 words, and the difference was invisible until someone counted).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CONTRACT = new URL('../src/contracts/model-wording.ts', import.meta.url)
const PRODUCTION = new URL('../src/index.ts', import.meta.url)

/** The body of a regex literal assigned to `name`, as written in the file. */
function regexBodyOf(source, name) {
  const pattern = new RegExp(`(?:export )?const ${name}\\s*=\\s*/((?:[^/\\\\\\n]|\\\\.)+)/[gimsuy]*`, 'u')
  const match = pattern.exec(source)
  if (match === null) throw new Error(`regex ${name} not found`)
  return match[1]
}

test('E2: the EMPHATIC contract is character-identical to production `hard`', () => {
  const contractSource = readFileSync(CONTRACT, 'utf8')
  const productionSource = readFileSync(PRODUCTION, 'utf8')

  const contract = regexBodyOf(contractSource, 'EMPHATIC')
  const production = regexBodyOf(productionSource, 'hard')

  assert.equal(
    contract,
    production,
    'the contract and the production word list must be the same characters — a difference changes ' +
      'which constraints fit the prompt budget, and that is a behaviour change, not a refactor',
  )
})

test('E2: the contract is NOT the union with `strong` (the correction that was measured)', () => {
  /**
   * `strong` carries 不要 / 只能 / 始终 / 绝不, which `hard` does not. Merging them was ruled out: it
   * raises the score of 必须-type sentences by +2 and changes which rules survive the budget. The
   * union is the more reasonable LONG-TERM design (TD-14), but only with its own verification round.
   *
   * This test exists so a future "helpful" merge cannot land silently: it would fail here first.
   */
  const contractSource = readFileSync(CONTRACT, 'utf8')
  const productionSource = readFileSync(PRODUCTION, 'utf8')

  const contract = regexBodyOf(contractSource, 'EMPHATIC')
  const strong = regexBodyOf(productionSource, 'strong')

  const strongOnly = ['只能', '始终', '绝不'].filter((word) => strong.includes(word) && !contract.includes(word))
  assert.ok(
    strongOnly.length > 0,
    'expected `strong` to carry words the contract does not; if this fails, someone merged them ' +
      'into EMPHATIC without the TD-14 verification',
  )
})

test('E2 self-test: the comparison can actually fail', () => {
  // The mechanism, not the result: given two different word lists, the comparison must detect it.
  // (Without this, both tests above could pass because the extractor found the SAME regex twice.)
  const source = readFileSync(PRODUCTION, 'utf8')
  const hard = regexBodyOf(source, 'hard')
  const strong = regexBodyOf(source, 'strong')
  assert.notEqual(hard, strong, 'hard and strong are different lists today; if they ever become equal, E2 must be re-examined')
})
