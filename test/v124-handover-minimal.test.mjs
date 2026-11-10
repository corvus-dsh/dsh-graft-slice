/**
 * ── TD-11: `handover` CARRIES EXACTLY TWO FIELDS, AND THE EXCLUSIONS ARE THE DESIGN ───────────────
 *
 * `graft_prepare` used to have no content parameter at all, so the model's only way to say "this is
 * what I want handed over" was to trigger the automatic extraction — which reads the model's OWN
 * earlier `todo_write`, i.e. the very thing it may be trying to correct at handoff time.
 *
 * The fix adds `handover?: { pending?, notes? }` and deliberately nothing else:
 *
 *   - no `goal`: TD-18 already defines `goal` as a three-layer fallback (objective > dag-node >
 *     transcript). A second writer for the same field re-introduces the "which one wins" ambiguity
 *     that ruling removed — and that ambiguity already cost one incident (ANALYSIS-BRIEF §4.4).
 *   - **no `constraints`, permanently**: a constraint parameter would let the model write a red line
 *     into the handoff, bypassing `shapeOfConstraint` / `droppedByShape`. Constraints may only enter
 *     by extraction or inheritance, and both pass the shape judge. The model cannot author a red line.
 *
 * ── WHAT EACH TEST DISCRIMINATES ────────────────────────────────────────────────────────────────
 *
 * The label pair matters more than either half: `labels` must fire on a model-supplied list and NOT
 * on a transcript-derived one. Asserting only the first half would pass on a renderer that labelled
 * every board unconditionally — which is the opposite defect (it would make an extracted list look
 * like the model's statement).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildInjectionPlan, renderTaskBoard } from '../index.js'

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

const LOG = {
  events: [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 2,
      type: 'user/message',
      data: {
        id: 'm1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '把 S1b-2 的 9 个契约骨架写出来，每个含 samples 与 nearMisses。' }],
      },
    },
    { seq: 3, type: 'turn/end', data: { turn: 1 } },
  ],
  session: { id: 'session-td11-test', cwd: 'D:\\持久层能力架构' },
}

const pendingBlockOf = (handover) => {
  const plan = buildInjectionPlan(LOG, {}, undefined, 'regex-fallback', undefined,
    handover === undefined ? undefined : { handover })
  return String((plan.chunks ?? []).find((chunk) => chunk.kind === 'pending-state')?.text ?? '')
}

const EMPTY_BOARD = {
  request: '把 S1b-2 的 9 个契约骨架写出来',
  pending: ['旧的自动提取项'],
  stopPoint: { turn: 1, boundarySeq: 3 },
  pointerCount: 0,
  discarded: { errorBodies: 0, resolvedErrors: 0, narrationChars: 0, pointerLines: 0 },
}

test('TD-11: without handover the board is UNCHANGED — no 模型提供 label anywhere', () => {
  const text = pendingBlockOf(undefined)
  assert.ok(!text.includes('模型提供'), 'an extracted list must not be labelled as model-supplied')
})

test('TD-11: handover.pending REPLACES the pending column and is labelled', () => {
  const text = pendingBlockOf({ pending: ['先修 CI：v119 语料缺失让 CI 红', '然后恢复 S3 重构'] })
  const heading = text.split('\n').find((line) => line.includes('待开始')) ?? ''
  assert.match(heading, /（模型提供）/, 'the column heading must name its source')
  assert.ok(text.includes('先修 CI'), 'the model-supplied item must appear')
})

test('TD-11: the label is driven by the SOURCE, not applied unconditionally', () => {
  // The discriminating pair. If this ever returns the same string twice, the label has become
  // decoration: either every board is labelled (an extracted list impersonating a statement) or
  // none is (a statement hidden among extracted facts).
  const extracted = renderTaskBoard({ ...EMPTY_BOARD })
  const modelSupplied = renderTaskBoard({ ...EMPTY_BOARD, pendingSource: 'model' })
  assert.ok(!extracted.includes('模型提供'), 'extracted list must not be labelled')
  assert.ok(modelSupplied.includes('模型提供'), 'model-supplied list must be labelled')
})

test('TD-11: handover.notes land in a section that cannot be read as a measured fact', () => {
  const text = pendingBlockOf({ notes: ['CI 未跑完，别推', '249 行的 v123 已入库'] })
  assert.ok(text.includes('模型提供的内容（不是工具测量的事实）'), 'notes need their own labelled heading')
  assert.ok(text.includes('CI 未跑完，别推'), 'the note body must appear')
})

test('TD-11: the digest covers handover EXPLICITLY, not only through the chunks', () => {
  // If the model's `pending` happened to equal the transcript list, the rendered text would be
  // identical and a chunk-only hash would collide — yet the review still differs, because the board
  // then says 「模型提供」. The digest is the fingerprint of what the user approved, provenance
  // included, so the hashed object must name `handover` itself.
  const at = SRC.indexOf('function digestOfPlan(')
  assert.ok(at > 0, 'digestOfPlan must exist')
  const block = SRC.slice(at, SRC.indexOf('\n}', at))
  const hashed = block.split('\n').find((line) => line.includes('.update(JSON.stringify(')) ?? ''
  assert.match(hashed, /handover: handoverDigest/u, 'the hashed object must include handover')
})

test('TD-11: the schema declares pending and notes, and NEITHER constraints NOR goal', () => {
  // The structural half of the ruling: a future edit that adds `constraints` to the schema has to
  // change this test, i.e. it cannot be a quiet addition.
  const at = SRC.indexOf('        handover: {')
  assert.ok(at > 0, 'the graft_prepare schema must declare handover')
  const propsAt = SRC.indexOf('          properties: {', at)
  const propsEnd = SRC.indexOf('          additionalProperties: false,', propsAt)
  const props = SRC.slice(propsAt, propsEnd)
  assert.match(props, /^\s*pending:\s*\{/mu, 'pending must be declared')
  assert.match(props, /^\s*notes:\s*\{/mu, 'notes must be declared')
  assert.doesNotMatch(props, /^\s*constraints:\s*\{/mu, 'the model must not be able to author a red line')
  assert.doesNotMatch(props, /^\s*goal:\s*\{/mu, 'TD-18 owns goal; a second writer re-creates the ambiguity')
})
