/**
 * ── THE TODO PATTERN HAS TWO COPIES, IN TWO PLUGINS, AND THEY MUST AGREE ────────────────────────
 *
 * `dsh-graft-slice/src/contracts/model-wording.ts` declares `TODO_TOOL_NAME`.
 * `dsh-observer/src/core/monitor.ts` declares `TODO_TOOL`, with its own comment: "exactly like graft
 * does" — i.e. it was copied on purpose.
 *
 * They cannot share code: observer is an independent plugin, and importing graft would make it a
 * hard dependency of an optional one. So the duplication is correct, and the ONLY protection against
 * drift is this test.
 *
 * ── WHY IT READS SOURCE, NOT THE BUILT BUNDLE ──────────────────────────────────────────────────
 *
 * The review's requirement, and it is the right one: `index.js` / `lib/*.js` are generated, and the
 * bundler rewrites string and regex literals. A comparison of generated artefacts could drift for a
 * reason that has nothing to do with the two source files — or, worse, pass because both were mangled
 * identically. The claim being tested is about INTENT IN THE SOURCE, so the source is what is read.
 *
 * ── WHY IT COMPARES CHARACTERS, NOT BEHAVIOUR ──────────────────────────────────────────────────
 *
 * A behavioural comparison ("both accept mcp__x__todo_write") would miss a narrowing that no current
 * test exercises. A character comparison catches any edit at all, which is what "the same pattern"
 * means.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const GRAFT_SOURCE = join(REPO, 'src', 'contracts', 'model-wording.ts')
const OBSERVER_SOURCE = resolve(REPO, '..', 'dsh-observer', 'src', 'core', 'monitor.ts')

/**
 * Extract the regex literal that the consumer actually uses.
 *
 * Under A′ the contract file holds TWO related lines:
 *
 *     export const TODO_TOOL_NAME = /(?:^|[^a-z0-9])todo[_-]?write$/iu     ← the binding to compare
 *     export const TODO_TOOL_NAME_CONTRACT = { re: TODO_TOOL_NAME, … }     ← metadata, not a literal
 *
 * The first version of this helper searched for `re:` first and picked up `/…/iu` from a COMMENT
 * earlier in the file, so it compared a placeholder against the real pattern and reported a drift
 * that did not exist. So: prefer an actual `= /…/flags` assignment, and skip `/…/` placeholders.
 */
function literalOf(source, constName) {
  const lines = source.split(/\r?\n/u)

  /** Pull a `/body/flags` literal starting at a given `=`/`:` position on a line. */
  const literalFrom = (line) => {
    const eq = line.search(/=\s*\//u)
    const colon = line.search(/:\s*\//u)
    const at = eq >= 0 ? eq : colon
    if (at < 0) return undefined
    const start = line.indexOf('/', at)
    if (start < 0) return undefined
    let i = start + 1
    let inClass = false
    while (i < line.length) {
      const ch = line[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '[') inClass = true
      else if (ch === ']') inClass = false
      else if (ch === '/' && !inClass) {
        const flags = /^[a-z]*/u.exec(line.slice(i + 1))?.[0] ?? ''
        const body = line.slice(start + 1, i)
        // A placeholder like `/…/` is not a pattern.
        if (body.trim() === '…' || body.trim() === '...') return undefined
        return `/${body}/${flags}`
      }
      i += 1
    }
    return undefined
  }

  // 1. an actual declaration of this name assigned to a literal
  for (const line of lines) {
    if (!new RegExp(`\\b(?:const|let|var)\\s+${constName}\\s*=\\s*/`, 'u').test(line)) continue
    const literal = literalFrom(line)
    if (literal !== undefined) return literal
  }

  // 2. the name used as a `re:` value — resolve it to the OTHER declaration it points at
  for (const line of lines) {
    if (!new RegExp(`\\b${constName}\\s*=\\s*\\{`, 'u').test(line)) continue
    // Nothing more to do: the object form has no literal of its own.
  }

  // 3. any line mentioning the name near a literal (last resort, still skips placeholders)
  for (const line of lines) {
    if (!new RegExp(`\\b${constName}\\b`, 'u').test(line)) continue
    const literal = literalFrom(line)
    if (literal !== undefined) return literal
  }
  return undefined
}

test('graft TODO_TOOL_NAME and observer TODO_TOOL are character-for-character identical', (t) => {
  if (!existsSync(OBSERVER_SOURCE)) {
    // A published tarball or a single-repo checkout has no sibling. Say so; do not pass silently.
    t.skip(`observer source absent at ${OBSERVER_SOURCE} — parity unverified in this checkout (not a pass)`)
    return
  }

  const graftLiteral = literalOf(readFileSync(GRAFT_SOURCE, 'utf8'), 'TODO_TOOL_NAME')
  const observerLiteral = literalOf(readFileSync(OBSERVER_SOURCE, 'utf8'), 'TODO_TOOL')

  assert.ok(graftLiteral !== undefined, 'could not find the TODO_TOOL_NAME literal in the contract file')
  assert.ok(observerLiteral !== undefined, 'could not find the TODO_TOOL literal in observer monitor.ts')

  assert.equal(
    observerLiteral,
    graftLiteral,
    'the two TODO tool-name patterns have drifted apart.\n' +
      `  graft   : ${graftLiteral}\n` +
      `  observer: ${observerLiteral}\n` +
      'If they disagree, observer starts believing a main session\'s TODO never moved and nudges it for ' +
      'being stalled — blaming the model for the plugins\' disagreement. Change BOTH or neither.',
  )
})

test('the observer copy still carries the same intent note (a warning, not a gate)', (t) => {
  if (!existsSync(OBSERVER_SOURCE)) {
    t.skip('observer source absent — intent note unverified')
    return
  }
  const source = readFileSync(OBSERVER_SOURCE, 'utf8')
  // The note is what tells the next reader the duplication is deliberate.
  assert.match(
    source,
    /exactly like graft does|same as graft|与 graft 相同/u,
    'observer\'s TODO_TOOL lost the comment saying the duplication is deliberate — the next reader will ' +
      'either delete one copy or "fix" it independently',
  )
})
