/**
 * P1-2 (audit 2026-11-08) — THE CROSS-PLUGIN LAYOUT CONTRACT, PINNED WITH LITERALS.
 *
 * ── WHY LITERALS AND NOT IMPORTS ──────────────────────────────────────────────────────────────
 *
 * This plugin must never import `dsh-memory` (either one has to survive being uninstalled alone), so
 * the contract cannot be a shared constant. It is a set of file names and a version number that BOTH
 * sides state independently — which is the exact shape that drifts silently: a rename on the writer's
 * side turns this side's reads into `[]`, and "no memories recorded" reads like a workspace that has
 * nothing to say.
 *
 * The defence is the literals below: this file fails the moment GRAFT's side of the contract moves,
 * and `dsh-memory/test/v102-layout-contract.test.mjs` carries the SAME literal block and fails if the
 * MEMORY side moves. `_scratch/check-layout-contract.mjs` compares the two published manifests
 * directly, which is the only check that can see both sides at once.
 *
 * These tests do not import the other plugin's constants. They hard-code them. That is the point.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GRAFT_LEDGER_FILES,
  GRAFT_LEDGER_LAYOUT_VERSION,
  LAYOUT_MANIFEST_FILE,
  LayoutUnsupportedError,
  MEMORY_LAYOUT_FILES,
  MEMORY_LAYOUT_VERSION,
  assertLayoutSupported,
  collectMemoryStoreStatus,
  readLayoutManifest,
  writeLayoutManifest,
} from '../index.js'

/** ── THE CONTRACT, AS LITERALS. Copied verbatim from memory's test; divergence is the alarm. ── */

/** What this plugin writes into its ledger directory. */
const GRAFT_MANIFEST_LITERAL = {
  layout: 1,
  producer: 'dsh-graft-slice',
  files: ['.retired.json', '.transferred.json'],
}

/** What `dsh-memory` writes into its store — the layout this plugin reads. */
const MEMORY_MANIFEST_LITERAL = {
  layout: 1,
  producer: 'dsh-memory',
  files: ['negatives.jsonl', 'facts.jsonl', 'experiences.jsonl', 'suggestions.jsonl'],
}

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, LAYOUT_MANIFEST_FILE), 'utf8'))

test('P1-2: this plugin publishes exactly the manifest memory expects, byte for byte', () => {
  const dir = temp('dsh-graft-layout-own-')
  assert.equal(
    writeLayoutManifest(dir, { layout: GRAFT_LEDGER_LAYOUT_VERSION, producer: 'dsh-graft-slice', files: GRAFT_LEDGER_FILES }),
    true,
  )
  assert.deepEqual(manifestOf(dir), GRAFT_MANIFEST_LITERAL)
})

test('P1-2: the memory-store layout this reader expects is pinned to literals', () => {
  assert.equal(LAYOUT_MANIFEST_FILE, '.layout.json')
  assert.deepEqual([...MEMORY_LAYOUT_FILES], MEMORY_MANIFEST_LITERAL.files)
  assert.equal(MEMORY_LAYOUT_VERSION, MEMORY_MANIFEST_LITERAL.layout)
})

test('P1-2: this reader must be able to parse the very manifest memory publishes', () => {
  const dir = temp('dsh-graft-layout-memory-')
  writeFileSync(join(dir, LAYOUT_MANIFEST_FILE), `${JSON.stringify(MEMORY_MANIFEST_LITERAL, null, 2)}\n`, 'utf8')
  const read = assertLayoutSupported(dir, { version: MEMORY_LAYOUT_VERSION, producer: 'dsh-memory' })
  assert.equal(read.state, 'present')
  assert.deepEqual(read.manifest.files, [
    'negatives.jsonl',
    'facts.jsonl',
    'experiences.jsonl',
    'suggestions.jsonl',
  ])
})

test('P1-2: an unknown layout THROWS LAYOUT_UNSUPPORTED rather than being guessed at', () => {
  const dir = temp('dsh-graft-layout-future-')
  writeFileSync(join(dir, LAYOUT_MANIFEST_FILE), JSON.stringify({ layout: 7, producer: 'dsh-memory', files: [] }), 'utf8')
  assert.throws(
    () => assertLayoutSupported(dir, { version: MEMORY_LAYOUT_VERSION, producer: 'dsh-memory' }),
    (error) => {
      assert.ok(error instanceof LayoutUnsupportedError, 'the refusal is a named error, not a string')
      assert.equal(error.code, 'LAYOUT_UNSUPPORTED')
      assert.equal(error.expected, 1)
      assert.equal(error.found, 7)
      return true
    },
  )
})

test('P1-2: a torn manifest is refused too — unreadable is not proof of an understood layout', () => {
  const dir = temp('dsh-graft-layout-torn-')
  writeFileSync(join(dir, LAYOUT_MANIFEST_FILE), 'not json at all', 'utf8')
  assert.throws(
    () => assertLayoutSupported(dir, { version: MEMORY_LAYOUT_VERSION, producer: 'dsh-memory' }),
    (error) => error.code === 'LAYOUT_UNSUPPORTED',
  )
  assert.equal(readLayoutManifest(dir).state, 'unreadable')
})

test('P1-2: the debug panel REPORTS an unknown layout instead of printing a silent zero', () => {
  const dir = temp('dsh-graft-layout-panel-')
  writeFileSync(join(dir, 'negatives.jsonl'), `${JSON.stringify({ kind: 'negative', workspace: 'D:\\w' })}\n`, 'utf8')
  writeFileSync(join(dir, LAYOUT_MANIFEST_FILE), JSON.stringify({ layout: 2, producer: 'dsh-memory', files: [] }), 'utf8')

  const status = collectMemoryStoreStatus(dir, join(dir, 'skills'), 'D:\\w')
  /**
   * The unguarded version of this call would have returned `available: true` with `negatives: 0` —
   * a store holding a record, reported as empty, with nothing anywhere saying why. That is the
   * failure this guard exists to convert into a reason.
   */
  assert.equal(status.available, false)
  assert.equal(status.reason, 'LAYOUT_UNSUPPORTED')
  assert.match(String(status.detail), /LAYOUT_UNSUPPORTED/u)
  assert.deepEqual(status.counts, { skills: 0, negatives: 0, facts: 0, experiences: 0, suggestions: 0 })
})

test('P1-2 REGRESSION: a matching manifest reads the store exactly as before', () => {
  const dir = temp('dsh-graft-layout-ok-')
  writeFileSync(join(dir, LAYOUT_MANIFEST_FILE), JSON.stringify(MEMORY_MANIFEST_LITERAL), 'utf8')
  writeFileSync(join(dir, 'negatives.jsonl'), `${JSON.stringify({ kind: 'negative', workspace: 'D:\\w' })}\n`, 'utf8')
  writeFileSync(join(dir, 'facts.jsonl'), `${JSON.stringify({ kind: 'fact', workspace: 'D:\\w' })}\n`, 'utf8')

  const status = collectMemoryStoreStatus(dir, join(dir, 'skills'), 'D:\\w')
  assert.equal(status.available, true)
  assert.equal(status.counts.negatives, 1)
  assert.equal(status.counts.facts, 1)
})

test('P1-2 REGRESSION: a legacy store with no manifest reads exactly as before', () => {
  const dir = temp('dsh-graft-layout-legacy-')
  writeFileSync(join(dir, 'negatives.jsonl'), `${JSON.stringify({ kind: 'negative', workspace: 'D:\\w' })}\n`, 'utf8')
  const status = collectMemoryStoreStatus(dir, join(dir, 'skills'), 'D:\\w')
  assert.equal(status.available, true, 'refusing an unstamped directory would break every existing install')
  assert.equal(status.counts.negatives, 1)
})

test('P1-2: an absent memory directory is still "available, empty", never a refusal', () => {
  const dir = join(temp('dsh-graft-layout-missing-'), 'does-not-exist')
  const status = collectMemoryStoreStatus(dir, join(dir, 'skills'), 'D:\\w')
  assert.equal(status.available, true)
  assert.equal(status.counts.negatives, 0)
})
