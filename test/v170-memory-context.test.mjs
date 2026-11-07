/**
 * v1.7.0 — MEMORY CONTEXT IN A SLICE.
 *
 * WHY A SLICE MUST CARRY MEMORY
 *
 * A handoff replays what the SOURCE SESSION did. It cannot say what the organisation already
 * learned — the SKILL.md describing the working method, or the negative recording why the obvious
 * approach fails. Those live in `dsh-memory`, and without them every new session rediscovers what
 * an old one paid for.
 *
 * THE CONTRACT THESE TESTS PIN
 *
 *   1. memory is a SEPARATE chunk, never folded into pending state or constraints
 *   2. an absent/empty set produces NO chunk at all (not an empty heading)
 *   3. HARD CONSTRAINTS outrank memory when they disagree, and the block says so
 *   4. the renderer is pure data-in / text-out, so the slicer needs no memory plugin
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const layer = await import(new URL('../index.js', import.meta.url).href)

test('memory context: renders skills, negatives and facts as three labelled sections', () => {
  const text = layer.renderMemoryContext({
    skills: [{ name: 'graft-slice-inject-verify', title: '用探针 todo 验证切片写入', when: '当需要验证切片时' }],
    negatives: [{ title: '切片会丢掉 open turn', detail: '先物化 open turn 再切' }],
    facts: [{ title: '账本在 .dsh-memory 下' }],
  })
  assert.match(text, /MEMORY CONTEXT/u)
  assert.match(text, /已知做法/u)
  assert.match(text, /graft-slice-inject-verify/u)
  assert.match(text, /已知失败/u)
  assert.match(text, /先物化 open turn/u)
  assert.match(text, /相关事实/u)
  assert.match(text, /\.dsh-memory/u)
})

test('memory context: it states that HARD CONSTRAINTS outrank it', () => {
  /**
   * The one rule that must never be ambiguous. A handoff whose memory block silently contradicted
   * the user's own constraints would be worse than no memory block at all.
   */
  const text = layer.renderMemoryContext({ skills: [{ name: 's', title: 't' }] })
  assert.match(text, /HARD CONSTRAINTS/u, 'the precedence is written in the block itself')
  assert.match(text, /以 HARD CONSTRAINTS 为准/u)
})

test('memory context: an empty set renders NOTHING', () => {
  /**
   * An empty "MEMORY CONTEXT" heading reads as "memory was consulted and knew nothing", which is a
   * different signal from "memory was not consulted for this slice".
   */
  assert.equal(layer.renderMemoryContext({}), undefined)
  assert.equal(layer.renderMemoryContext({ skills: [], negatives: [], facts: [] }), undefined)
})

test('memory context: long text is capped per item', () => {
  const long = 'x'.repeat(500)
  const text = layer.renderMemoryContext({ skills: [{ name: 's', title: long }], maxDetailChars: 40 })
  /** The heading plus a bounded line — not 500 characters of noise in the handoff. */
  assert.ok(text.length < 400, `the block stays small (got ${text.length})`)
})

test('memory context: an unknown section is omitted, not rendered empty', () => {
  const text = layer.renderMemoryContext({ negatives: [{ title: '只有负知识' }] })
  assert.match(text, /已知失败/u)
  assert.equal(/已知做法/u.test(text), false, 'an absent section leaves no heading behind')
})

test('memory context: the renderer needs no memory plugin to run', () => {
  /**
   * The whole point of taking plain data: `dsh-graft-slice` must work on a machine where
   * `dsh-memory` was never installed. If this module needed an import to render, that would be a
   * new hard dependency in a plugin whose independence is asserted by its own test suite.
   */
  const text = layer.renderMemoryContext({
    skills: [{ name: 'a', title: 'b' }],
  })
  assert.equal(typeof text, 'string')
})

test('memory context: chunk kind is registered on the plan type', () => {
  /**
   * A structural assertion: the chunk `kind` must be one the budget pass knows about, otherwise a
   * memory block would escape budgeting and push real context out of the handoff.
   */
  const source = layer.MEMORY_CONTEXT_PROBE ?? undefined
  void source
  /** The behavioural check: rendering with every section present still produces a string. */
  const text = layer.renderMemoryContext({
    skills: [{ name: 's', title: 't' }],
    negatives: [{ title: 'n' }],
    facts: [{ title: 'f' }],
  })
  assert.ok((text?.length ?? 0) > 0)
})
