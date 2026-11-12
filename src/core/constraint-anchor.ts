import { isGraftAuthored, isHumanAuthored } from './message-source.js'
import { textOfMessage } from './watermark.js'
import type { SessionEventLike } from './watermark.js'

/**
 * 硬约束 7（v7.4）：把"这套约束从哪一代来"钉在 pending state 的第一行。
 *
 * A graft's goal message carries the source's accumulated HARD CONSTRAINTS. The
 * next generation copies that text again — with provenance stripped. After two
 * or three hops the target cannot tell whether a rule was said by the human
 * three generations ago or written by a plugin's own bootstrap, and the only
 * sanctioned way to check (graft_read_result) needs a seq it was never given.
 *
 * Measured consequence, this repo: an inherited block has been re-copied through
 * every generation, and the target has twice acted on a rule as though the
 * current user had just stated it.
 *
 * So: when the source's OWN goal already contained an inherited HARD CONSTRAINTS
 * section, say which generation wrote it and which seq holds the original.
 */
export function inheritedConstraintAnchor(
  events: readonly SessionEventLike[],
  sourceSessionId: string,
  sourceGeneration = 0,
): string | undefined {
  // v7.4: only the GOAL counts as the origin.
  //
  // The plugin also re-asserts the same constraints in-band as a standing
  // `user/message` on later steps (`plugin:graft-replay`, "[系统提示] 本次任务的
  // 硬约束…"). Those are copies too, and picking the newest one pointed the anchor
  // at a re-assertion (seq=1425) instead of the goal (seq=3) — a seq that holds
  // the text but not the origin the reader is being sent to.
  const GOAL_SHAPE = /(这个会话的任务|当前要做的事|【系统交接】)/u
  const goals = events.filter((event) => {
    if (event.type !== 'user/message' || !isGraftAuthored(event.data?.source)) return false
    const text = textOfMessage(event.data)
    return text.includes('HARD CONSTRAINTS') && GOAL_SHAPE.test(text)
  })
  // v7.4b (硬约束 7 + 8): a HUMAN goal can carry an explicitly labelled
  // extraction too.
  //
  // The user pasted "HARD CONSTRAINTS（从源会话用户消息中抽取，逐条有效…）"
  // after an audit. A human sent it, so it is `source.kind === 'user'` — but the
  // text is still a copy of an earlier statement, not something this
  // generation's user just said. Measured on `handoff-demo`: the anchor
  // stayed absent because only graft-authored goals were scanned, so the target
  // had eight rules with no pointer to their source.
  //
  // The gate is both facts, not one: a human author (硬约束 8 — never a system
  // injection) AND the extraction marker itself (a human stating rules in their
  // own words needs no anchor; pointing at their own sentence adds nothing).
  const humanOrigins = events.filter((event) => {
    if (event.type !== 'user/message' || !isHumanAuthored(event.data?.source)) return false
    const text = textOfMessage(event.data)
    return text.includes('HARD CONSTRAINTS')
  })
  /**
   * ── v0.9.3: `blockOrdinal` IS NOT `generation` ────────────────────────────────────────────────
   *
   * Two different questions used to share one number, and the card answered the wrong one:
   *
   *   blockOrdinal = how many goal-shaped HARD CONSTRAINTS blocks this log holds.
   *                  It answers ONE thing: which block is the origin (the newest copy).
   *   generation   = where this session sits in the chain, read from the MARK
   *                  (`.graft-targets.json`), the same source `goalMessage` reports.
   *
   * They coincide only while every hop writes exactly one block. A hop whose extraction came
   * back empty writes none — so a generation-3 session can hold 2 blocks, and the card said
   * "第 2 代会话" while the goal message in the same handoff said `graft_generation: 3`.
   *
   * Measured before the fix (this repo's own `.graft-targets.json`: a 3-deep chain), the
   * anchor and the goal disagreed by one. The names are now different on purpose: collapsing
   * them again has to be a deliberate act, not a typo.
   */
  const blockOrdinal = goals.length
  // The mark is 0 for a session that was never a target (an original session), and N for the
  // Nth-generation target. Rendering 0 as "第 0 代" would be nonsense, and rounding it to 1
  // would assert a chain position the mark does not record.
  const originLabel =
    sourceGeneration > 0 ? `第 ${sourceGeneration} 代会话` : '原始会话'
  if (blockOrdinal === 0 && humanOrigins.length > 0) {
    // v7.4b: point at the EARLIEST human statement, not the newest copy.
    //
    // The constraints are harvested from several user messages across the
    // session (measured: seq 2282, 3474, 6592, 7420 on session-source-demo), then
    // rendered into the target's goal as a numbered block. The reader needs the
    // place where the rule was first written, so a re-assertion later on cannot
    // masquerade as the origin.
    //
    // v0.9.3: this branch says SESSION, never "第 1 代". A human paste proves a human
    // wrote it, not which generation they were in — only the mark knows that.
    const first = humanOrigins[0]
    return (
      `[高优锚点] 核心约束源自${originLabel}（${sourceSessionId}），seq=${first.seq}，必要时请优先回读。` +
      `\n下面这段 HARD CONSTRAINTS 是插件从用户原话抽取的副本，不是这一代用户刚刚说的；` +
      `要确认原话，用 graft_read_result(sourceSessionId, ${first.seq})。`
    )
  }
  if (blockOrdinal === 0) return undefined
  const goal = goals[goals.length - 1]
  return (
    `[高优锚点] 核心约束源自${originLabel}（${sourceSessionId}），seq=${goal.seq}，必要时请优先回读。` +
    (sourceGeneration > 0
      ? `\n当前是第 ${sourceGeneration + 1} 代。下面这段 HARD CONSTRAINTS 是逐代复制来的文本，不是这一代用户刚刚说的；`
      : `\n下面这段 HARD CONSTRAINTS 是逐代复制来的文本，不是这一代用户刚刚说的；`) +
    `要确认原话，用 graft_read_result(sourceSessionId, ${goal.seq})。`
  )
}
