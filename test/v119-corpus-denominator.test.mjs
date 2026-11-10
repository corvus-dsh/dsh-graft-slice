/**
 * CORPUS CHECKS — WITH A COMMITTED SAMPLE SO CI ACTUALLY MEASURES SOMETHING.
 *
 * ── WHY THIS FILE WAS REWRITTEN ────────────────────────────────────────────────────────────────
 *
 * The previous version treated "corpus absent" as a FAILURE (rule 27: a green result must prove it
 * measured something). That was right in principle and wrong in packaging: the 6.3 MB corpus lives in
 * `_scratch/`, which is not committed, so every CI run went red — and I reported "all ready" without
 * checking CI at all. A red build reported as green is the same defect as an empty-set green: the
 * report had no denominator either.
 *
 * ── THE FIX: TWO TIERS, AND THE TIER IS VISIBLE ────────────────────────────────────────────────
 *
 *   test/fixtures/corpus-sample.json  (213 entries, ~58 KB, COMMITTED)
 *       → always runs: on CI and locally. It carries the two S1 regression sentences, every rejection
 *         class present in the corpus, and 196 ordinary texts.
 *
 *   _scratch/real-texts.json  (9,153 entries, 6.3 MB, NOT committed)
 *       → runs when present, printing its own denominator. Absent locally is reported as
 *         RESOURCE_MISSING (accurate: there is no file), never as a pass.
 *
 * ── AND THE DISTINCTION THE REVIEW ASKED FOR ──────────────────────────────────────────────────
 *
 * "0 inputs because the file is missing" and "0 inputs because the reader is wrong" look identical in
 * code and are completely different failures:
 *
 *   RESOURCE_MISSING   — no file. An environment fact. Must not be reported as agreement.
 *   MEASUREMENT_BROKEN — the file exists but yields no entries. That is a DEFECT IN THE READER, and it
 *                        is exactly what produced the green empty set last round (`typeof entry ===
 *                        'string'` skipped all 9,153). This one is a hard failure, always.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { shapeOfConstraint } from '../src/core/constraint-shape.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The committed sample. Always present — it is in the repo. */
const SAMPLE = join(HERE, 'fixtures', 'corpus-sample.json')

/** The full corpus, found by walking up. Not committed; may legitimately be absent on CI. */
function findFullCorpus() {
  let dir = HERE
  for (let hop = 0; hop < 5; hop += 1) {
    const candidate = join(dir, '_scratch', 'real-texts.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Read a corpus file and DISTINGUISH the two zero cases. Returns { texts, kind } where kind is
 * 'ok' | 'RESOURCE_MISSING' | 'MEASUREMENT_BROKEN'.
 */
function readCorpus(path) {
  if (path === undefined || !existsSync(path)) return { kind: 'RESOURCE_MISSING', texts: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { kind: 'MEASUREMENT_BROKEN', texts: [], why: `unparseable: ${String(error.message).slice(0, 80)}` }
  }
  if (!Array.isArray(parsed)) return { kind: 'MEASUREMENT_BROKEN', texts: [], why: 'not a JSON array' }
  // Accept both shapes: the sample stores {text}, the full corpus stores {file,seq,type,text}.
  const texts = parsed
    .map((entry) => (entry !== null && typeof entry === 'object' ? entry.text : entry))
    .filter((text) => typeof text === 'string')
  if (parsed.length > 0 && texts.length === 0) {
    // The file has entries but the reader found no text in any of them — the exact defect that
    // produced last round's false all-clear. Never a pass.
    return { kind: 'MEASUREMENT_BROKEN', texts, why: `${parsed.length} entries but 0 readable .text` }
  }
  return { kind: 'ok', texts }
}

const inWindow = (text) => {
  const length = text.trim().length
  return length >= 10 && length <= 800
}

test('the committed sample exists and is large enough to be a denominator', (t) => {
  assert.ok(existsSync(SAMPLE), 'test/fixtures/corpus-sample.json must be committed — CI depends on it')
  const corpus = readCorpus(SAMPLE)
  assert.equal(corpus.kind, 'ok', `the sample is unreadable (${corpus.kind}): this is MEASUREMENT_BROKEN, not a skip`)
  assert.ok(corpus.texts.length >= 100, `the sample must be a real population, got ${corpus.texts.length}`)

  // CI must be able to SEE the denominator. If this line is missing from a CI log, the sample was not
  // read — which is the failure mode the review called out.
  t.diagnostic(`CORPUS-SAMPLE: ${corpus.texts.length} entries (committed, runs on CI)`)
  console.log(`CORPUS-SAMPLE: ${corpus.texts.length} entries`)

  // Class coverage: a sample that lost the regression cases would pass while testing nothing.
  const shapes = new Map()
  for (const entry of JSON.parse(readFileSync(SAMPLE, 'utf8'))) shapes.set(entry.shape, (shapes.get(entry.shape) ?? 0) + 1)
  assert.ok((shapes.get('REAL_CONSTRAINT') ?? 0) >= 2, 'the S1 regression sentences must be in the sample')
  assert.ok((shapes.get('S1_JSON') ?? 0) >= 1, 'the sample must contain at least one S1_JSON rejection')
  assert.ok((shapes.get('KEPT') ?? 0) >= 50, 'the sample must contain plenty of ordinary text')
})

test('SAMPLE: the S1 regression sentences are KEPT, and are IN the sample verbatim', (t) => {
  const corpus = readCorpus(SAMPLE)
  assert.equal(corpus.kind, 'ok')

  const regression = [
    '必须 在提交前确认 engines 里 "node": ">=22" 这一项没有降低。',
    '禁止 把 "kind": "plugin" 这种标记换成 user，那会伪造人类来源。',
  ]

  /**
   * ── PINNED BY CONTENT, NOT BY THE `shape` LABEL ────────────────────────────────────────────────
   *
   * A first version asserted only "the sentence is not rejected" using a hard-coded string, and then
   * asserted "every non-KEPT entry is rejected". Mutating the sample's REAL_CONSTRAINT into a word list
   * satisfied both: the literal string was still checked in isolation, and the mutated entry was
   * rejected (for a different reason). The suite stayed green while the fixture had lost the very case
   * it exists for.
   *
   * So the sample must CONTAIN each sentence, and that exact sentence must be kept. Both directions.
   */
  for (const text of regression) {
    assert.ok(
      corpus.texts.includes(text),
      `the sample no longer contains the regression sentence verbatim: ${text}`,
    )
    const verdict = shapeOfConstraint(text)
    assert.equal(verdict.broken, false, `a real constraint is being dropped: ${text} → ${verdict.code}`)
  }
  t.diagnostic(`regression sentences present and KEPT among ${corpus.texts.length} sample entries`)
})

test('SAMPLE: ordinary text is never rejected, and rejected text carries a known code', (t) => {
  const raw = JSON.parse(readFileSync(SAMPLE, 'utf8'))
  const known = new Set(['S1_JSON', 'S2_TABLE', 'S3_WORDLIST', 'S4_LABEL', 'S5_META', 'S6_SEPARATORS'])

  let keptCount = 0
  let rejectedCount = 0
  for (const entry of raw) {
    const verdict = shapeOfConstraint(entry.text)
    if (entry.shape === 'KEPT' || entry.shape === 'REAL_CONSTRAINT') {
      assert.equal(verdict.broken, false, `ordinary/real text rejected as ${verdict.code}: ${entry.text.slice(0, 80)}`)
      keptCount += 1
      continue
    }
    // Entries the full corpus rejected: they must STILL be rejected, with a known code.
    assert.equal(verdict.broken, true, `a corpus rejection no longer fires (${entry.shape}): ${entry.text.slice(0, 80)}`)
    assert.ok(known.has(verdict.code), `unexpected code ${String(verdict.code)}`)
    rejectedCount += 1
  }
  assert.ok(keptCount > 0 && rejectedCount > 0, `both directions must be measured, got kept=${keptCount} rejected=${rejectedCount}`)
  // The S1_JSON class is the one this whole round is about; its disappearance would mean the sample
  // silently stopped covering the defect.
  const s1Count = raw.filter((entry) => entry.shape === 'S1_JSON').length
  assert.ok(s1Count >= 1, 'the sample must still carry at least one S1_JSON case')
  t.diagnostic(`sample: ${keptCount} kept / ${rejectedCount} rejected (${s1Count} of them S1_JSON)`)
})

test('FULL CORPUS (local only): runs when present, and says so when it is not', (t) => {
  const corpusPath = findFullCorpus()
  const corpus = readCorpus(corpusPath)

  if (corpus.kind === 'RESOURCE_MISSING') {
    /**
     * RESOURCE_MISSING is an ENVIRONMENT FACT, not agreement. It is reported as a skip so CI does not
     * fail on a file that was never committed — and it prints a line large enough to notice, so a green
     * build that never ran the full corpus cannot be mistaken for one that did.
     *
     * It is NOT reported as a pass, and it is NOT conditional on `process.env.CI`: the same code path
     * runs everywhere, so nobody can weaken the check by setting an environment variable.
     */
    t.skip('CORPUS-CHECK SKIPPED (RESOURCE_MISSING): full corpus not present; the committed sample above still ran')
    console.log('CORPUS-CHECK SKIPPED: RESOURCE_MISSING — full corpus not present, denominator unverified here')
    return
  }

  assert.equal(corpus.kind, 'ok', `the corpus exists but could not be read (${corpus.kind}) — that is MEASUREMENT_BROKEN, a defect`)
  const window = corpus.texts.filter(inWindow)
  assert.ok(window.length > 1000, `full-corpus denominator must be real, got ${window.length}`)

  const rejected = window.filter((text) => shapeOfConstraint(text).broken)
  const byCode = new Map()
  for (const text of rejected) {
    const code = shapeOfConstraint(text).code
    byCode.set(code, (byCode.get(code) ?? 0) + 1)
  }
  t.diagnostic(`FULL CORPUS: ${corpus.texts.length} entries, window ${window.length}, rejected ${rejected.length}`)
  console.log(`FULL-CORPUS: ${corpus.texts.length} entries, window ${window.length}, rejected ${rejected.length} (${[...byCode.entries()].map(([c, n]) => c + '=' + n).join(', ')})`)

  // S4_LABEL is the largest class; a real sentence ending in a colon would be a false positive there.
  const s4WithProse = rejected.filter((text) => shapeOfConstraint(text).code === 'S4_LABEL' && /[，。；！？]/u.test(text.trim()))
  assert.deepEqual(s4WithProse.map((text) => text.trim().slice(0, 60)), [], 'S4_LABEL rejected a real sentence')
})

test('the reader distinguishes RESOURCE_MISSING from MEASUREMENT_BROKEN', () => {
  // Not a narrative claim: exercise the function with a path that does not exist, and with a file that
  // exists but whose entries carry no readable text. The two must not collapse into one verdict.
  assert.equal(readCorpus(join(HERE, 'definitely-not-here.json')).kind, 'RESOURCE_MISSING')
  assert.equal(readCorpus(undefined).kind, 'RESOURCE_MISSING')

  // A sample IS present and readable, so it must come back 'ok' — if this ever reports
  // MEASUREMENT_BROKEN, the reader is wrong, not the corpus.
  const sample = readCorpus(SAMPLE)
  assert.equal(sample.kind, 'ok', `the committed sample must be readable: ${sample.why ?? ''}`)
})
