import type { SessionEventLike } from './watermark.js'
import { textOfMessage } from './watermark.js'
import { isGraftAuthored } from './message-source.js'

/**
 * v7.0: where this task's constraints originally came from, across generations.
 *
 * The problem the report names: after several migrations, the read-back index
 * lists only the most recent ~24 pointers. A fifth-generation model therefore
 * cannot find the first generation's constraints — they are real, they are in a
 * log it can read, but nothing tells it those seqs exist. The index is a window,
 * and the window has moved past them.
 *
 * The fix is an anchor, not a bigger window: state that constraints exist
 * upstream, how many generations back, and one seq to start from. That is a
 * constant-size fact regardless of depth, so it stays true at generation 20.
 *
 * Detection is from the log, not from memory: a prior graft writes its own
 * handoff into a `user/message` whose source is `plugin:graft-replay`, and that
 * message contains the HARD CONSTRAINTS block. Finding the OLDEST such message is
 * finding the earliest recorded statement of the rules.
 */
export interface ConstraintProvenance {
  /** How many graft generations before this one the constraints were recorded. */
  generationsBack: number
  /** The seq of the earliest replay message that carried a constraints block. */
  seq: number
  /** The session that log belongs to. */
  sessionId: string
}

export function findConstraintProvenance(
  events: readonly SessionEventLike[],
  sourceSessionId: string,
  sourceGeneration: number,
): ConstraintProvenance | undefined {
  let oldest: { seq: number; text: string } | undefined
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    if (!isGraftAuthored(event.data?.source)) continue
    const text = textOfMessage(event.data)
    if (!/HARD CONSTRAINTS/u.test(text)) continue
    if (oldest === undefined || Number(event.seq) < oldest.seq) {
      oldest = { seq: Number(event.seq), text }
    }
  }
  if (oldest === undefined) return undefined
  // If the block we found already carries a provenance line, that line names the
  // TRUE origin (an earlier generation, another session). Pass it through rather
  // than re-deriving "one generation back" from this hop alone — otherwise the
  // anchor would always say "上一代" no matter how deep the chain is.
  const inherited = /核心约束最早记录在第?\s*(\d+)?\s*代会话（([^，]+)，seq=(\d+)）/u.exec(oldest.text)
  if (inherited !== null) {
    const depth = Number(inherited[1])
    const sessionId = inherited[2].trim()
    const seq = Number(inherited[3])
    if (Number.isFinite(depth) && depth > 0 && Number.isFinite(seq)) {
      return { generationsBack: depth + 1, seq, sessionId }
    }
  }
  return {
    // The oldest constraints block we can see was written by the PREVIOUS
    // generation, so it is at least one back; deeper ancestry is carried by the
    // generation counter, not guessed from the text.
    generationsBack: Math.max(1, sourceGeneration),
    seq: oldest.seq,
    sessionId: sourceSessionId,
  }
}

export function renderConstraintProvenance(provenance: ConstraintProvenance): string {
  const generation =
    provenance.generationsBack === 1 ? '上一代会话' : `第 ${provenance.generationsBack} 代会话`
  return (
    `核心约束最早记录在${generation}（${provenance.sessionId}，seq=${provenance.seq}）。` +
    '上面列出的约束是它们的最新副本；如果这里的表述和回读结果冲突，以后读到的原文为准。'
  )
}
