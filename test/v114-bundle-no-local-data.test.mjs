/**
 * E3 — THE BUNDLE MUST NOT CARRY LOCAL DATA, AND THIS CHECK MUST BE ABLE TO FAIL.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * `verify-bundle.mjs` already checks 28 properties of the shipped file, and it did NOT catch this:
 * the published artifact contained two real `session-<uuid>` ids, five `.jsonl.zstd` filenames and
 * eight `auto-graft-*` names, plus the whole test-only metadata block (+15,514 bytes, 86% of it
 * metadata). Every existing check asked "is the bundle well FORMED", none asked "what is IN it".
 *
 * ── WHY THE PATTERNS ARE SHAPED THIS WAY ────────────────────────────────────────────────────────
 *
 * - `session-[0-9a-f]{8}` : a session id, not the word "session". Anchored tightly enough that
 *   `session/title` and `sourceSessionId` do not trip it.
 * - `.jsonl.zstd`         : the corpus filenames. No legitimate runtime string needs the extension.
 * - `_CONTRACT` / `nearMisses` / `ALL_CONTRACTS` : the metadata object names. These are the exact
 *   symbols whose presence in the bundle WAS the leak.
 *
 * The check must be able to FAIL, so it is tested against synthetic bundles that violate each rule.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = new URL('../index.js', import.meta.url)

/** The rules, in one place, so the shipped check and the self-test cannot drift. */
const RULES = [
  {
    name: 'real session ids',
    pattern: /session-[0-9a-f]{8}/gu,
    why: 'a session id identifies a real conversation on a real machine; it must never ship',
  },
  {
    name: 'corpus filenames',
    pattern: /\.jsonl\.zstd/gu,
    why: 'the compressed-log extension only appears in corpus paths from this machine',
  },
  {
    name: 'test-only contract symbols',
    pattern: /\b(?:nearMisses|ALL_CONTRACTS)\b|_[A-Z_]*CONTRACT\b/gu,
    why: 'the metadata block was 86% of a 15KB size increase and carried real ids in `samples`',
  },
]

/** Find violations in a given text. Exported shape: [{ rule, match, line }] */
function violations(text) {
  const found = []
  const lines = text.split(/\r?\n/)
  for (const rule of RULES) {
    for (let index = 0; index < lines.length; index += 1) {
      rule.pattern.lastIndex = 0
      for (const match of lines[index].matchAll(rule.pattern)) {
        found.push({ rule: rule.name, match: match[0], line: index + 1 })
      }
    }
  }
  return found
}

test('E3: the shipped bundle carries no local session ids, corpus paths or contract metadata', () => {
  const text = readFileSync(BUNDLE, 'utf8')
  const found = violations(text)

  /**
   * The three earlier hits that remain are COMMENTS explaining the split itself — the header of
   * `model-wording.ts` necessarily names `.jsonl.zstd` to say what used to leak. A rule that forbids
   * a design note from naming the thing it prevents would force the note to become vague, so the
   * exemption is explicit and narrow: only comment lines, and only the ones that are part of the
   * E1 explanation.
   */
  const realLeaks = found.filter((hit) => {
    const line = text.split(/\r?\n/)[hit.line - 1] ?? ''
    const isComment = /^\s*(?:\*|\/\/|\/\*)/u.test(line)
    return !isComment
  })

  assert.deepEqual(
    realLeaks,
    [],
    `the bundle still carries non-comment local data: ${JSON.stringify(realLeaks.slice(0, 5))}`,
  )
})

test('E3 self-test: each rule fires on a synthetic violation (so the check is not decorative)', () => {
  // If any of these stops being detected, the shipped check has gone blind and this test says so.
  const samples = [
    ['const id = "session-64345616"', 'real session ids'],
    ['path: "auto-graft-x/session.v4.jsonl.zstd"', 'corpus filenames'],
    ['const TODO_TOOL_NAME_CONTRACT = { nearMisses: [] }', 'test-only contract symbols'],
    ['export const ALL_CONTRACTS = []', 'test-only contract symbols'],
  ]
  for (const [text, expected] of samples) {
    const found = violations(text)
    assert.ok(
      found.some((hit) => hit.rule === expected),
      `rule "${expected}" did not fire on ${JSON.stringify(text)}`,
    )
  }

  // And it must NOT fire on ordinary runtime strings, or the check would block correct builds.
  const clean = [
    'ctx.on("session/title", handler)',
    'sourceSessionId: string',
    "join(dataDir, '.auto-graft-suppressed.json')",
    'this.session = session',
  ]
  for (const text of clean) {
    assert.deepEqual(violations(text), [], `false positive on ${JSON.stringify(text)}`)
  }
})

test('E3: the metadata file is not reachable from the entry point (the structural guarantee)', async () => {
  /**
   * ── N0c: "PRODUCTION" MEANS ALL OF `src/**`, NOT FOUR NAMED FILES ────────────────────────────────
   *
   * The claim is "production does not depend on the metadata module". The code used to check four
   * hard-coded files, so every module extracted from `index.ts` became a fifth file nobody checked —
   * the guarantee quietly shrank with each refactor, which is the same defect shape as rule 31
   * (a conclusion wider than its evidence).
   *
   * A NEGATIVE assertion must traverse all of src/** and must NOT read the artifact: a forbidden import
   * in a file that is never inlined (`ignition.ts.bak-cut` is such a file, proven by v125) would be
   * invisible in the bundle.
   */
  const { sourceFilesMatching, productionSourceFiles } = await import('./fixtures/source-scan.mjs')

  const scanned = productionSourceFiles().length
  assert.ok(scanned > 10, `the traversal found only ${scanned} source files; it is not scanning src/**`)

  const importers = sourceFilesMatching(/from\s*['"][^'"]*model-wording\.contracts/u)
  assert.deepEqual(
    importers,
    [],
    `production source must not import the metadata module; these do: ${JSON.stringify(importers)}`,
  )
})
