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

import { apply, buildInjectionPlan, buildTape, clearGraftTargetsForTest, getGraftTargets, inheritedConstraintAnchor, resetRetiredSessions } from '../index.js'
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

test('v0.9.3: an UNRECORDED generation is not the same claim as "an original session"', () => {
  const events = [goalMessage(3), goalMessage(40)]

  /**
   * ── 0 不等于「原始会话」────────────────────────────────────────────────────────────────────────
   *
   * 用户裁定（2026-11-12）：`sourceGeneration === 0` 只说明**标记里没有记录** ——
   * 可能是原始会话，也可能是标记被清过、或这个会话由别的 profile 创建。
   * 把「不知道」写成「原始会话」是在断言一件没有证据的事。
   */
  const unrecorded = inheritedConstraintAnchor(events, 'session-src', 0)
  assert.ok(unrecorded !== undefined)
  assert.equal(/第 0 代/u.test(unrecorded), false, 'a mark of 0 must never render as "generation 0"')
  assert.equal(/源自第 1 代会话/u.test(unrecorded), false, 'nor be silently rounded up to 1')
  assert.match(unrecorded, /一个代次未记录的会话/u, '0 means "the mark has no record", and must say so')
  assert.equal(/一个原始会话/u.test(unrecorded), false, '0 must NOT be upgraded to "original session"')
  assert.match(unrecorded, /seq=40/u)

  // And the same call with the generation simply absent behaves identically.
  const omitted = inheritedConstraintAnchor(events, 'session-src')
  assert.match(omitted ?? '', /一个代次未记录的会话/u, 'omitting the generation is also "no record"')
})

test('v0.9.3: three states render three different sentences (recorded / unrecorded / original)', () => {
  const events = [goalMessage(3), goalMessage(40)]

  const recorded = inheritedConstraintAnchor(events, 'session-src', 3)
  assert.match(recorded ?? '', /源自第 3 代会话/u)
  assert.match(recorded ?? '', /当前是第 4 代/u)

  const unrecorded = inheritedConstraintAnchor(events, 'auto-graft-abc123-def456', undefined)
  assert.match(unrecorded ?? '', /一个代次未记录的会话/u)
  assert.equal(/当前是第/u.test(unrecorded ?? ''), false, 'with no recorded generation there is no "current is the Nth" claim either')

  const original = inheritedConstraintAnchor(events, 'session-legacy-fixture', 'original')
  assert.match(original ?? '', /源自一个原始会话/u)
  assert.equal(/代次未记录/u.test(original ?? ''), false)

  // The three must be mutually distinguishable, not three spellings of one sentence.
  const labels = [recorded, unrecorded, original].map((text) => {
    const m = /核心约束源自([^（]+)（/u.exec(text ?? '')
    return m?.[1] ?? '(none)'
  })
  assert.equal(new Set(labels).size, 3, `three states must produce three distinct labels, got ${JSON.stringify(labels)}`)
})

test('v0.9.3: the three labels are NOUN PHRASES — the sentence says "源自X（id）", never a clause', () => {
  /**
   * 用户裁定（2026-11-12）：三态文案必须是**名词短语**。
   *
   * 为什么能机器判：这个值拼在「核心约束源自」后面接宾语。写成从句就会拼出半截话
   * （「源自代次未被记录」）。所以断言形态而不是断言措辞：
   * 「源自」与「（id）」之间那一段必须**完整等于**三种名词短语之一 —— 多一个字都不行。
   */
  const events = [goalMessage(3), goalMessage(40)]
  const texts = [
    inheritedConstraintAnchor(events, 'session-src', 3),
    inheritedConstraintAnchor(events, 'auto-graft-abc123', undefined),
    inheritedConstraintAnchor(events, 'session-legacy-fixture', 'original'),
  ]
  const NOUN_PHRASES = [/^第 \d+ 代会话$/u, /^一个原始会话$/u, /^一个代次未记录的会话$/u]

  const segments = texts.map((text) => {
    const m = /核心约束源自([^（]+)（/u.exec(text ?? '')
    assert.ok(m !== null, `every label must sit between 「源自」 and 「（id）」: ${text}`)
    return m[1]
  })

  for (const segment of segments) {
    const matches = NOUN_PHRASES.filter((re) => re.test(segment))
    assert.equal(matches.length, 1,
      `the segment after 源自 must be EXACTLY one of the three noun phrases; got ${JSON.stringify(segment)}`)
  }
  assert.equal(new Set(segments).size, 3, 'and the three must not collapse into fewer')

  // A clause glued onto 源自 is the failure this guards: no sentence-final particles or verb tails.
  for (const text of texts) {
    assert.equal(/源自[^（]*?(了|的会话是|未被|没有记录)/u.test(text ?? ''), false,
      `no clause may follow 源自: ${text}`)
  }
})

test('v0.9.3: an UNMARKED auto-graft session id is classified as unrecorded, not as an original', () => {
  /**
   * 调用点的三态判定（`buildTape` 内）：标记里没有记录时，
   *   · id 是本插件 `autoGraftIdPrefix` 生成的前缀 ⇒ 它确实是被自动切片造出来的，只是标记没留下 ⇒ 无标记；
   *   · 否则 ⇒ 在本地记录下可判定不是目标 ⇒ 原始会话。
   *
   * 这条走端到端（buildTape 的 pendingStateText），因为判定逻辑在调用点而不在被调函数里。
   */
  const events = [goalMessage(3), goalMessage(40)]
  const boundary = { boundarySeq: 40 }
  clearGraftTargetsForTest()

  const auto = buildTape(events, boundary, {}, 'auto-graft-not-in-mark')
  assert.match(auto.pendingStateText, /一个代次未记录的会话/u,
    'an unmarked auto-graft id was made by this plugin, so its generation is UNRECORDED, not original')

  const plain = buildTape(events, boundary, {}, 'session-legacy-fixture')
  assert.match(plain.pendingStateText, /源自一个原始会话/u,
    'an id this plugin never generates, absent from the mark, is classified as an original session')
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

test('v0.9.3: the human-origin branch on an unrecorded session says so, not "original"', () => {
  // 2026-11-12 裁定：0 只表示标记里没有记录。人类粘贴能证明「人写过」，
  // 不能证明「这是原始会话」—— 所以文案是「一个代次未记录的会话」。
  const events = [goalMessage(17, 'user')]
  const anchor = inheritedConstraintAnchor(events, 'session-src', 0)

  assert.ok(anchor !== undefined)
  assert.match(anchor, /一个代次未记录的会话/u)
  assert.equal(/一个原始会话/u.test(anchor), false, '0 must not be upgraded to "original session"')
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
