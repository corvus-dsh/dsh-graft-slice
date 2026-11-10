/**
 * THE ARTIFACT MUST BE FRESH — the claim that "reading ../index.js is safe" made executable.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 *
 * `v121-goal-arbitration.test.mjs` imports `../index.js`, the BUILT artifact, and its header explains
 * why that is safe: the docs gate re-composes the bundle from `src/` and fails if the two differ.
 *
 * The first version of that explanation quoted two byte counts from a probe run
 * (862832 vs 862817). The review pointed out the obvious problem: nothing keeps such a number true. It
 * was accurate the day it was written and would silently rot — and a rotten number in a comment is
 * worse than no number, because it reads as verified.
 *
 * Measured while writing THIS file: the same class of probe produces 862832 vs 862844 (a 12-byte
 * difference), not the 15 the old comment claimed. So the numbers were never a property of the code;
 * they were a property of that particular edit.
 *
 * The fix is not a better number. It is an ASSERTION: compose the bundle from `src/` and require it to
 * equal the committed artifact byte for byte. Then the claim is executable, and it cannot rot.
 *
 * This is deliberately a second channel to the same fact that `scripts/check-docs.mjs` checks. That is
 * not duplication for its own sake — the docs gate runs in the release pipeline, while this runs beside
 * the test that DEPENDS on freshness. A test that relies on a fresh artifact should fail when the
 * artifact is stale, in its own suite, rather than relying on someone remembering to run the gate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { composeBundle } from '../scripts/bundle.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

test('the committed index.js is exactly composeBundle(src/) — v121 may read it safely', (t) => {
  const { output, modules } = composeBundle(REPO)
  const committed = readFileSync(join(REPO, 'index.js'), 'utf8')

  const expectedBytes = Buffer.byteLength(output)
  const actualBytes = Buffer.byteLength(committed)

  assert.equal(
    actualBytes,
    expectedBytes,
    `index.js is STALE: ${actualBytes} bytes committed vs ${expectedBytes} expected from src/. ` +
      'Run `node scripts/build.mjs`. Every test that imports ../index.js is reading the wrong code.',
  )
  assert.equal(committed, output, 'index.js must be byte-identical to composeBundle(src/), not merely the same length')

  // The diagnostic names the real numbers for THIS build, so a reader never has to trust a comment.
  t.diagnostic(`artifact fresh: ${actualBytes} bytes, ${modules.length} inlined module(s)`)
})
