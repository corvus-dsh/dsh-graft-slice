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
 * Extract a regex literal assigned to `const <name> =` / declared as `re:` in an object.
 *
 * Both files place the pattern on ONE line, so a line-anchored extraction is enough — and it is
 * deliberately strict: if either file is reformatted so the literal spans lines, this helper returns
 * undefined and the test fails loudly instead of comparing nothing.
 */
function literalOf(source, constName) {
  const lines = source.split(/\r?\n/u)
  for (const [index, line] of lines.entries()) {
    const isConst = new RegExp(`\\bconst\\s+${constName}\\s*=`, 'u').test(line)
    const isProp = new RegExp(`\\b${constName}\\s*=\\s*\\{`, 'u').test(line) || new RegExp(`^\\s*re:\\s*/`, 'u').test(line)
    // Contract-object declarations put the regex on a `re:` line; locate it by proximity to the name.
    if (!isConst && !isProp) continue
    // For `export const X: WordingPattern = {` the regex is on a later `re:` line.
    for (let cursor = index; cursor < Math.min(index + 12, lines.length); cursor += 1) {
      const candidate = lines[cursor]
      const start = candidate.indexOf('/')
      if (start < 0) continue
      // Skip the comment/URL slashes by requiring a plausible regex opening.
      if (!/\/[\^(\[\\a-zA-Z\u4e00-\u9fff]/u.test(candidate.slice(start))) continue
      let i = start + 1
      let inClass = false
      while (i < candidate.length) {
        const ch = candidate[i]
        if (ch === '\\') { i += 2; continue }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) {
          const flags = /^[a-z]*/u.exec(candidate.slice(i + 1))?.[0] ?? ''
          return `${candidate.slice(start, i + 1)}${flags}`
        }
        i += 1
      }
    }
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
