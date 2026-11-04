/**
 * v1.4 GUARD — EVERY `ctx.tools.register` MUST DECLARE AN OUTPUT CONTRACT.
 *
 * Why this test exists (it is written from a production outage, not from taste):
 *
 *   0.2.2-rc.1 rejects an entry whose tool omits `output { schema, render, presentationMeta? }`:
 *
 *     TypeError: tool "graft_update_goal" must declare output { schema, render, presentationMeta? }
 *
 * and a rejected entry takes the whole Web boot with it — the app does not start. That is a
 * class of failure no unit test would ever reach, because the tool itself works fine; only
 * the REGISTRATION is invalid.
 *
 * The scan is deliberately crude: find every `ctx.tools.register({ ... })` block by brace
 * matching and require an `output:` key inside it. A real AST would be nicer, but this has
 * to run on the built artefact too (`index.js`), where types are gone anyway.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Every `ctx.tools.register({...})` block, by brace matching from the call site. */
function toolRegistrations(source) {
  const blocks = []
  const marker = 'ctx.tools.register('
  let from = 0
  for (;;) {
    const at = source.indexOf(marker, from)
    if (at < 0) break
    const open = source.indexOf('{', at)
    if (open < 0) break
    let depth = 0
    let end = -1
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end < 0) break
    blocks.push(source.slice(at, end))
    from = end
  }
  return blocks
}

function nameOf(block) {
  return /name:\s*'([^']+)'/u.exec(block)?.[1] ?? '(unnamed)'
}

for (const file of ['src/index.ts', 'index.js']) {
  test(`output contract: every tool in ${file} declares output { schema, render }`, () => {
    const source = readFileSync(join(root, file), 'utf8')
    const blocks = toolRegistrations(source)
    assert.ok(blocks.length > 0, `${file}: no tool registrations found — the scan would be vacuous`)

    const offenders = []
    for (const block of blocks) {
      if (!/\boutput:\s*\{/u.test(block)) offenders.push(`${nameOf(block)} (no output)`)
      else {
        const outputPart = block.slice(block.search(/\boutput:\s*\{/u))
        if (!/\bschema:\s*\{/u.test(outputPart)) offenders.push(`${nameOf(block)} (output without schema)`)
        if (!/\brender:\s*/u.test(outputPart)) offenders.push(`${nameOf(block)} (output without render)`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${file}: registrations that would abort activation on 0.2.2: ${offenders.join(', ')}`,
    )
  })
}

test('output contract: the built bundle is the current source (no stale artefact hiding an offender)', () => {
  const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const built = readFileSync(join(root, 'index.js'), 'utf8')
  const sourceNames = toolRegistrations(source).map(nameOf).sort()
  const builtNames = toolRegistrations(built).map(nameOf).sort()
  assert.deepEqual(builtNames, sourceNames, 'run scripts/build.mjs — the shipped tool set differs from src')
})
