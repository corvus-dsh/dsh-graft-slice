/**
 * v0.9.3 — the GENERATION in the constraint anchor must be the same number the goal
 * message reports, not a count of how many constraint blocks the log happens to hold.
 *
 * THE DEFECT THIS FILE PINS
 *
 * `inheritedConstraintAnchor` used to write `第 ${goals.length} 代`, where `goals` is the
 * set of goal-shaped messages carrying a HARD CONSTRAINTS block. That is an ORDINAL OF
 * BLOCKS, not a generation. The two coincide only while every hop writes exactly one
 * block.
 *
 * They diverge the moment a hop's extraction is empty: the plugin then writes no block
 * (it has nothing to write), the next generation's log holds fewer blocks than the chain
 * is deep, and the card says "第 2 代" about a session the goal message — from the same
 * handoff — calls `graft_generation: 3`. One card, two numbers, and the wrong one is in
 * the sentence a reader acts on ("this came from three generations ago, check it").
 *
 * THE RULE NOW
 *
 * The generation comes from the MARK (`.graft-targets.json`), the same source
 * `goalMessage` reads. `goals.length` survives only as `blockOrdinal`, which decides
 * WHICH block is the origin — never which generation. The two names are deliberately
 * different so the next reader cannot collapse them again.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, buildInjectionPlan, clearGraftTargetsForTest, getGraftTargets, inheritedConstraintAnchor, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** A goal-shaped, graft-authored message that carries an extracted constraints block. */
function goalMessage(seq, source = 'plugin:graft-replay') {
  return {
    seq,
    type: 'user/message',
    data: {
      id: `m-${seq}`,
      role: 'user',
      source: { kind: source },
      content: [
        {
          type: 'text',
          text: [
            '这个会话的任务：继续修插件。',
            '',
            'HARD CONSTRAINTS（从源会话用户消息中抽取，逐条有效，不可协商）:',
            '1. 断档状态，必须灾后重建。',
          ].join('\n'),
        },
      ],
    },
  }
}

test('v0.9.3: the anchor says generation 3 when the MARK says 3, even with only 2 blocks', () => {
  // The mark is the authority. A chain that reached generation 3 whose third hop
  // extracted no constraints leaves exactly this shape in the log: two blocks.
  const events = [goalMessage(3), goalMessage(40)]
  const anchor = inheritedConstraintAnchor(events, 'session-src', 3)

  assert.ok(anchor !== undefined)
  assert.match(anchor, /源自第 3 代会话/u, 'the anchor must name the generation the mark records')
  assert.match(anchor, /当前是第 4 代/u)
  // The ordinal is NOT the generation: proving the old number is gone is the point.
  assert.equal(/源自第 2 代会话/u.test(anchor), false, 'block count must not leak into the generation')
  // And the seq still points at the LAST block, which is the newest copy.
  assert.match(anchor, /seq=40/u)
})

test('v0.9.3: an original session (mark absent => generation 0) is the original, not "generation 0"', () => {
  const events = [goalMessage(3), goalMessage(40)]
  const anchor = inheritedConstraintAnchor(events, 'session-src', 0)

  assert.ok(anchor !== undefined)
  // "第 0 代会话" would be nonsense a reader cannot act on; the mark says this log
  // was never a target, so the constraints were first written HERE.
  assert.equal(/第 0 代/u.test(anchor), false, 'a mark of 0 must never render as "generation 0"')
  assert.equal(/源自第 1 代会话/u.test(anchor), false, 'nor be silently rounded up to 1')
  assert.match(anchor, /原始会话/u)
  assert.match(anchor, /seq=40/u)
})

test('v0.9.3: the human-origin branch names the MARK generation, never a hardcoded 1', () => {
  // A human pasted an extraction. The sentence used to say "第 1 代会话" no matter how
  // deep the chain actually was — a claim the log cannot support. The mark is the only
  // thing that knows the depth, so the label must follow it.
  const events = [goalMessage(17, 'user')]
  const anchor = inheritedConstraintAnchor(events, 'session-src', 3)

  assert.ok(anchor !== undefined)
  assert.equal(/第 1 代会话/u.test(anchor), false, 'a human paste does not prove generation 1')
  assert.match(anchor, /源自第 3 代会话/u)
  assert.match(anchor, /seq=17/u)
})

test('v0.9.3: the human-origin branch on an unmarked session says 原始会话', () => {
  // Same branch, mark absent: nothing about this log was ever a target, so the human
  // who wrote the rules is in the ORIGINAL session. Neither "第 0 代" nor "第 1 代".
  const events = [goalMessage(17, 'user')]
  const anchor = inheritedConstraintAnchor(events, 'session-src', 0)

  assert.ok(anchor !== undefined)
  assert.match(anchor, /原始会话/u)
  assert.equal(/第 [01] 代/u.test(anchor), false)
  assert.match(anchor, /seq=17/u)
})

test('v0.9.3: blockOrdinal still picks the LAST block, which is what seq must point at', () => {
  // Guards the half of the old behaviour that was correct: the seq is the newest
  // copy, the generation is the mark's number. Fixing one must not break the other.
  const events = [goalMessage(3), goalMessage(40), goalMessage(77)]
  const anchor = inheritedConstraintAnchor(events, 'session-src', 5)

  assert.match(anchor, /seq=77/u, 'the pointer follows the newest block')
  assert.match(anchor, /源自第 5 代会话/u, 'the generation follows the mark')
  assert.match(anchor, /当前是第 6 代/u)
})

test('v0.9.3: end to end — the card and the goal message report the SAME generation', async () => {
  // The property a reader depends on: one handoff must not state two different
  // generations. This drives buildInjectionPlan (the card) and goalMessage (the goal)
  // off one mark, and pins them to each other.
  clearGraftTargetsForTest()
  resetRetiredSessions()

  const log = makeSourceLog({ turns: 4, sourceSessionId: 'session-chain-deep' })
  // Two constraint blocks in the log, but the mark says this session is gen 3 —
  // exactly the divergence: 2 blocks, generation 3.
  log.events.push(goalMessage(9001))
  log.events.push(goalMessage(9002))

  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  getGraftTargets().set('session-chain-deep', {
    sourceSessionId: 'session-chain-parent',
    createdAt: Date.now(),
    generation: 3,
  })

  const plan = buildInjectionPlan(log, { adaptiveDepth: false, recentTurns: 0 })
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')
  assert.ok(pending, 'the plan must carry a pending-state chunk')

  const anchorLine = pending.text.split('\n').find((line) => line.includes('[高优锚点]'))
  assert.ok(anchorLine, 'the pending state must carry the anchor')
  assert.match(anchorLine, /源自第 3 代会话/u, 'the card must use the mark generation')

  // The goal message is rendered from plan.generation, which reads the same mark.
  assert.equal(plan.generation, 4, 'the target of a gen-3 source is generation 4')

  clearGraftTargetsForTest()
  resetRetiredSessions()
})
