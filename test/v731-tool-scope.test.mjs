/**
 * v7.3.1: tool availability must be resolved in a SCOPE, and an incomplete view
 * must never be read as proof of absence.
 *
 * THE LIVE INCIDENT THIS PINS
 *
 * On the desktop, a freshly grafted target received a readback index that looked
 * like this:
 *
 *   - seq=360  Turn 5 · tool
 *   - seq=364  Turn 5 · tool
 *   - seq=372  Turn 5 · tool
 *
 * All anonymous. The target's model then spent four turns re-exploring the
 * filesystem (`pwsh` × 20, `read` × 7) and called `graft_search_history` and
 * `graft_read_result` exactly ZERO times. The retrieval path the whole design
 * rests on was simply not usable.
 *
 * Cause, verified in the host contract:
 *
 *   schemas(scope?) — "the viewing scope (the agent); omitted = the GLOBAL view"
 *
 * The plugin called `tools.schemas()` with no scope. Core tools are registered
 * per-AGENT scope through the preset, so the global view omits them → the plugin
 * concluded "the target does not have pwsh" → F3 downgraded EVERY pointer to
 * `（历史记录：使用了当前环境不支持的工具 pwsh…）` → and the index's name
 * extractor did not recognise that shape, so every row read `· tool`.
 *
 * Two independent fixes are pinned here:
 *   1. resolve in the source agent's scope (falling back to the calling agent);
 *   2. cross-check each called tool through `get(name, scope)` before treating a
 *      scope-filtered projection as absence. Downgrade now requires both lookups
 *      to fail.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** The fixture's source log calls `read_file`; make it resolvable or not. */
function scaffold() {
  const log = makeSourceLog({ turns: 3 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-scope-'))
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { log, ctx, dir }
}

function tapeText(stored) {
  return stored.events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => (event.data?.message?.content ?? []).map((block) => block.text ?? '').join(''))
    .join('\n\n')
}

test('v7.3.1: the fixture really models the global view omitting scoped tools', () => {
  resetRetiredSessions()
  const { ctx } = scaffold()
  ctx.tools._registerScopedTool('read_file')
  // This is the bug's precondition, asserted so the test cannot pass vacuously.
  const globalView = ctx.tools.schemas()
  const scopedView = ctx.tools.schemas({ id: 'any-agent' })
  assert.equal(globalView.some((entry) => entry.name === 'read_file'), false, 'global view omits it')
  assert.equal(scopedView.some((entry) => entry.name === 'read_file'), true, 'scoped view includes it')
  assert.equal(ctx.tools.get('read_file'), undefined, 'global lookup cannot resolve it')
  assert.notEqual(ctx.tools.get('read_file', { id: 'any-agent' }), undefined, 'scoped lookup can')
  resetRetiredSessions()
})

test('v7.3.1: a scope-only tool is NOT downgraded, and the index names it', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()
  // The tool exists, but only inside an agent scope — exactly like a preset tool
  // on the real host.
  ctx.tools._registerScopedTool('read_file')

  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'scope-target' }, {})

  const stored = ctx._persistence.read('scope-target')
  const text = tapeText(stored)

  // The pointer must stay callable: the target CAN call this tool.
  assert.equal(
    text.includes('(unavailable here)'),
    false,
    'a scope-resolvable tool must not be reported as unavailable',
  )
  assert.match(text, /read_file\(seq=\d+\)/)

  // And the readback index must name it, so the reader has a reason to fetch.
  const index = stored.events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => (event.data?.message?.content ?? []).map((block) => block.text ?? '').join(''))
    .find((block) => block.includes('[可回读索引]'))
  assert.ok(index, 'the index must be injected')
  assert.match(index, /read_file/)
  assert.equal(
    /· tool\b/u.test(index.split('\n').filter((line) => line.startsWith('- seq=')).join('\n')),
    false,
    'no row may fall back to the anonymous "tool" label',
  )
  resetRetiredSessions()
})

test('v7.3.1: a genuinely absent tool is still downgraded — the guard did not go blind', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()
  // Nothing registers `read_file`, so both lookups fail. Downgrading here is
  // correct: the target really cannot call it.
  assert.equal(ctx.tools.get('read_file'), undefined)

  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'absent-target' }, {})

  const stored = ctx._persistence.read('absent-target')
  const text = tapeText(stored)
  assert.match(text, /read_file\(seq=\d+\) \(unavailable here\)/)

  // Even downgraded, the index must NAME the tool and mark it, so the entry is
  // still actionable: the output is fetchable even though the tool is not.
  const index = stored.events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => (event.data?.message?.content ?? []).map((block) => block.text ?? '').join(''))
    .find((block) => block.includes('[可回读索引]'))
  assert.match(index, /read_file/)
  assert.match(index, /\(unavailable here\)/)
  resetRetiredSessions()
})

test('v7.3.1: an empty registry yields no downgrade at all', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()
  // Simulate a host whose projection is unusable: `schemas()` returns nothing and
  // `get()` resolves nothing. That is "we cannot see the registry", NOT "the
  // target has no tools" — so no pointer may be rewritten.
  ctx.tools.schemas = () => []
  ctx.tools.get = () => undefined

  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'blind-target' }, {})

  const stored = ctx._persistence.read('blind-target')
  const text = tapeText(stored)
  assert.equal(
    text.includes('历史记录：使用了当前环境不支持的工具'),
    false,
    'an unreadable registry must fail OPEN, not downgrade everything',
  )
  resetRetiredSessions()
})