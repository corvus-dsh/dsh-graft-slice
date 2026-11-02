/**
 * v7.3.1: carry the EFFECTIVE agent preset, not the header's initial one.
 *
 * THE LIVE DEFECT THIS PINS
 *
 * A source session was created under `standard`, then at seq 9 emitted:
 *
 *   agent-preset/selected { agentPreset: 'cordis' }
 *
 * Every later `request/header` in that session listed 40-41 tools, including
 * `plugin_manager`, `plugin_market`, `cordis_inspect_list` and
 * `cordis_inspect_query` — those come with the `cordis` preset.
 *
 * The plugin copied `header.agentPreset`, which is immutable creation metadata
 * and still said `standard`. The grafted target therefore resumed under
 * `standard`, listed 37 tools, and was missing exactly the four the task needed
 * ("check the plugin installation"). Its own reasoning recorded the symptom:
 *
 *   "plugin_manager isn't in my tool list. I don't have plugin_mana…"
 *
 * The host's own reconstruction reads the `agentPreset` PROJECTION, which is
 * "initialized from the header and advanced by `agent-preset/selected`", so a
 * target with no selection events must carry the effective value IN THE HEADER.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** A source log whose header says `standard` but which switched to `cordis`. */
function sourceWithPresetSwitch() {
  const log = makeSourceLog({ turns: 3 })
  log.session = { ...log.session, agentPreset: 'standard' }
  log.events.push({
    type: 'agent-preset/selected',
    seq: 0,
    time: 0,
    data: { agentPreset: 'cordis' },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  return log
}

test('v7.3.1: the target carries the preset the source actually selected', async () => {
  resetRetiredSessions()
  const log = sourceWithPresetSwitch()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-preset-'))
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })

  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'preset-target' }, {})

  // The persisted artifact's header is what the host reconstructs from.
  const headerPreset = persistence.read('preset-target')?.session?.agentPreset
  assert.equal(
    headerPreset,
    'cordis',
    'the header must carry the SELECTED preset, so the projection resolves to it',
  )
  resetRetiredSessions()
})

test('v7.3.1: the last selection wins when the preset changed more than once', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.session = { ...log.session, agentPreset: 'standard' }
  log.events.push({ type: 'agent-preset/selected', seq: 0, time: 0, data: { agentPreset: 'cordis' } })
  log.events.push({ type: 'agent-preset/selected', seq: 0, time: 0, data: { agentPreset: 'minimal' } })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-preset2-'))
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'preset-target-2' }, {})

  assert.equal(persistence.read('preset-target-2')?.session?.agentPreset, 'minimal')
  resetRetiredSessions()
})

test('v7.3.1: a session that never switched falls back to the header preset', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.session = { ...log.session, agentPreset: 'standard' }
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-preset3-'))
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'preset-target-3' }, {})

  assert.equal(persistence.read('preset-target-3')?.session?.agentPreset, 'standard')
  resetRetiredSessions()
})