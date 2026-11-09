/**
 * ── THE CONTRACTS ARE PINNED TO REAL TEXT ────────────────────────────────────────────────────────
 *
 * A `samples` array of invented sentences proves nothing: it tests whether I can write a string that
 * matches a regex I just wrote. So every sample is asserted against the real corpus the review
 * supplied (`测试用真实日志/` → `_scratch/real-texts.json`, 9153 text blocks from 86 logs).
 *
 * The same applies to near misses, and the assertion is sharper there:
 *   - `real-misfire` must ACTUALLY MATCH the pattern (the whole point is that it misfires);
 *   - `real-nearby`  must ACTUALLY NOT MATCH (the whole point is that the boundary holds);
 *   - `synthetic`    is rejected outright by this suite — there are none, and adding one has to be a
 *                    deliberate act that changes this test, not a quiet addition.
 *
 * ── WHY THE CORPUS IS OPTIONAL ───────────────────────────────────────────────────────────────────
 *
 * `_scratch/real-texts.json` is a 9153-block extract of the review's logs and is NOT shipped with the
 * plugin (it is working material, not a fixture). On a bare checkout — CI, a published tarball — the
 * corpus is absent, so the provenance checks skip with a loud message rather than passing silently.
 * The pattern-shape checks (sample matches, near miss behaves) run everywhere, because they need only
 * the contract itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EMPHATIC, PROHIBITION_PLUS_ACT, TODO_TOOL_NAME, WIDE_CONSTRAINT } from '../src/contracts/model-wording.ts'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const CORPUS = resolve(REPO, '..', '_scratch', 'real-texts.json')
const CONTRACTS = [TODO_TOOL_NAME, WIDE_CONSTRAINT, EMPHATIC, PROHIBITION_PLUS_ACT]

const corpus = existsSync(CORPUS)
  ? JSON.parse(readFileSync(CORPUS, 'utf8')).map((entry) => entry.text)
  : undefined

test('every contract has a name, an intent, and at least one sample and one near miss', () => {
  for (const contract of CONTRACTS) {
    assert.ok(contract.name.length > 0, 'a contract needs a name')
    assert.ok(contract.intent.length > 10, `${contract.name}: intent must say what question it answers`)
    assert.ok(contract.samples.length >= 1, `${contract.name}: needs at least one sample`)
    assert.ok(contract.nearMisses.length >= 1, `${contract.name}: a contract with no near miss cannot be wrong`)
    for (const sample of contract.samples) {
      assert.ok(sample.source.length > 0, `${contract.name}: a sample must name its log`)
      assert.equal(typeof sample.seq, 'number', `${contract.name}: a sample must carry its seq`)
    }
    for (const near of contract.nearMisses) {
      assert.ok(
        near.kind === 'real-misfire' || near.kind === 'real-nearby',
        `${contract.name}: near misses must be real (got "${near.kind}"); an invented one proves nothing`,
      )
      assert.ok(near.why.length > 10, `${contract.name}: a near miss must say WHY it is one`)
    }
  }
})

test('every sample MATCHES its own contract', () => {
  for (const contract of CONTRACTS) {
    for (const sample of contract.samples) {
      const lines = sample.text.split(/\r?\n/u)
      const matched = lines.some((line) => contract.re.test(line))
      assert.equal(
        matched,
        true,
        `${contract.name}: sample does not match its own pattern — seq=${sample.seq} ${JSON.stringify(sample.text.slice(0, 80))}`,
      )
    }
  }
})

test('every real-misfire ACTUALLY misfires, and every real-nearby ACTUALLY does not', () => {
  for (const contract of CONTRACTS) {
    for (const near of contract.nearMisses) {
      const lines = near.text.split(/\r?\n/u)
      const matched = lines.some((line) => contract.re.test(line))
      if (near.kind === 'real-misfire') {
        assert.equal(
          matched,
          true,
          `${contract.name}: a real-misfire must match (that is what makes it a misfire) — ${JSON.stringify(near.text.slice(0, 80))}`,
        )
      } else {
        assert.equal(
          matched,
          false,
          `${contract.name}: a real-nearby must NOT match (that is the boundary being asserted) — ${JSON.stringify(near.text.slice(0, 80))}`,
        )
      }
    }
  }
})

test('every sample can be found in the real corpus (when the corpus is present)', (t) => {
  if (corpus === undefined) {
    t.skip(`corpus absent at ${CORPUS} — provenance unverified in this checkout (not a pass)`)
    return
  }
  const haystack = corpus.join('\n')
  for (const contract of CONTRACTS) {
    for (const sample of contract.samples) {
      // Compare on a distinctive slice: the corpus stores raw blocks, the contract stores excerpts.
      const needle = sample.text.slice(0, 40).replace(/\s+/gu, ' ').trim()
      const found =
        haystack.includes(needle) ||
        corpus.some((block) => block.replace(/\s+/gu, ' ').includes(needle))
      assert.equal(
        found,
        true,
        `${contract.name}: sample not found in the real corpus — seq=${sample.seq} ${JSON.stringify(needle)}`,
      )
    }
  }
})

test('every real-misfire can be found in the real corpus too', (t) => {
  if (corpus === undefined) {
    t.skip(`corpus absent at ${CORPUS} — misfire provenance unverified in this checkout (not a pass)`)
    return
  }
  const haystack = corpus.join('\n').replace(/\s+/gu, ' ')
  for (const contract of CONTRACTS) {
    for (const near of contract.nearMisses) {
      const needle = near.text.slice(0, 40).replace(/\s+/gu, ' ').trim()
      assert.equal(
        haystack.includes(needle),
        true,
        `${contract.name}: near miss not found in the real corpus — ${JSON.stringify(needle)}`,
      )
    }
  }
})
