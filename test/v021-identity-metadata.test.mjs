/**
 * v0.21 P1 — the handoff's IDENTITY METADATA.
 *
 * "This target is behaving oddly — where did it actually come from?" The pipeline has
 * always answered that in PROSE (a `graft_generation:` line, a sentence naming the
 * source). A human can read that; a program cannot, and the moment the question
 * matters is the moment somebody needs to point `graft_read_result` at exact
 * coordinates: which session, which boundary seq, which generation.
 *
 * What these tests hold:
 *   1. every target carries a machine-readable block with the three fields;
 *   2. the block is invisible (an HTML comment), so it never appears as text to a user
 *      reading the conversation;
 *   3. it round-trips: `parseIdentityMetadata(render(x)) === x`;
 *   4. a malformed block is "no metadata", never a crash on the read path;
 *   5. the boundary seq in it is the REAL boundary the tape was cut at.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  IDENTITY_METADATA_MARKER,
  parseIdentityMetadata,
  renderIdentityMetadata,
  resetRetiredSessions,
} from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

function activated({ controller } = {}) {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log })
  ctx.sessionController = controller ?? { async prompt() { return { accepted: true } } }
  apply(ctx, { dataDir: ctx.pathsData })
  return { ctx, log }
}

test('v0.21 P1: the metadata round-trips', () => {
  const identity = { sourceSessionId: 'session-a', boundarySeq: 42, generation: 3, cwd: 'D:\\work' }
  const text = renderIdentityMetadata(identity)
  assert.match(text, /^<!-- graft-identity: \{/u)
  assert.match(text, /-->$/u)
  assert.deepEqual(parseIdentityMetadata(text), identity)
})

test('v0.21 P1: the block is invisible — it is an HTML comment, not prose', () => {
  const text = renderIdentityMetadata({ sourceSessionId: 'session-a', boundarySeq: 1, generation: 1 })
  assert.equal(text.startsWith('<!--'), true, 'a UI renders this as nothing')
  assert.equal(text.endsWith('-->'), true)
  // It must not read as an instruction to the model either: no imperative, no label
  // the model might quote back.
  assert.doesNotMatch(text, /请|必须|立即/u)
})

test('v0.21 P1: a malformed or absent block is "no metadata", never a throw', () => {
  assert.equal(parseIdentityMetadata('no block here'), undefined)
  assert.equal(parseIdentityMetadata('<!-- graft-identity: {not json} -->'), undefined)
  assert.equal(parseIdentityMetadata('<!-- graft-identity: {"sourceSessionId":""} -->'), undefined)
  assert.equal(parseIdentityMetadata(undefined), undefined)
})

test('v0.21 P1: every created target carries its provenance in the goal message', async () => {
  const { ctx, log } = activated()
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-traced' }, {})

  const stored = ctx._persistence.read('session-traced')
  const goal = stored.events.find((event) => event.type === 'user/message')
  const goalText = goal.data.content[0].text
  assert.ok(goalText.includes(IDENTITY_METADATA_MARKER), 'the goal message carries the block')

  const identity = parseIdentityMetadata(goalText)
  assert.ok(identity, 'and it parses')
  assert.equal(identity.sourceSessionId, log.session.id, 'the TRUE source, not a guess')
  assert.equal(identity.generation, report.generation, 'the chain depth agrees with the report')
  assert.equal(identity.boundarySeq, report.boundarySeq, 'the boundary is the one the tape was cut at')
  assert.equal(identity.boundarySeq > 0, true, 'a real boundary, not the 0 default')
  resetRetiredSessions()
})

test('v0.21 P1: the provenance survives a READ of the target, so a polluted target is traceable', async () => {
  // The recovery scenario: something is wrong with the target, and the operator needs
  // the origin WITHOUT trusting anything the target itself says in prose.
  const { ctx, log } = activated()
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-forensics' }, {})

  const raw = await ctx.sessionQuery.readSession('session-forensics')
  const texts = raw.events
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data?.content?.[0]?.text ?? '')
  const identity = texts.map(parseIdentityMetadata).find(Boolean)
  assert.ok(identity, 'the coordinates are recoverable from a plain log read')
  assert.equal(identity.sourceSessionId, log.session.id)
  resetRetiredSessions()
})
