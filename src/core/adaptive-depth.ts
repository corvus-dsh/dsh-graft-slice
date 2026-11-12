import type { SessionEventLike } from './watermark.js'
import { textOfMessage } from './watermark.js'

/**
 * v6.3 module 3: adaptive slice depth.
 *
 * A debug session and a writing session need opposite things from a handoff.
 * Debug work lives in the most recent actions — error text, failing commands,
 * file diffs — so cutting too shallow loses the thread. Prose work accumulates
 * meaning over the whole conversation, so keeping fewer verbatim turns leaves
 * the target room to actually generate.
 *
 * Signals used, all cheap and local:
 *   - tool-call density in the last few turns
 *   - share of tool results that are errors
 *   - share of assistant text that is code (fenced blocks)
 */
export interface AdaptiveDepthResult {
  depth: number
  mode: 'debug' | 'generation' | 'balanced'
  reason: string
}

export function calculateAdaptiveDepth(
  events: readonly SessionEventLike[],
  settings: { adaptiveDepthMin: number; adaptiveDepthMax: number },
): AdaptiveDepthResult {
  const min = Math.max(1, settings.adaptiveDepthMin)
  const max = Math.max(min, settings.adaptiveDepthMax)

  // Count only the trailing window; old history should not decide today's shape.
  const turnStarts: number[] = []
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.type === 'turn/start') turnStarts.push(index)
  }
  const windowTurns = 6
  const windowStart = turnStarts.length > windowTurns ? turnStarts[turnStarts.length - windowTurns] : 0
  const window = events.slice(windowStart)

  let toolCalls = 0
  let toolResults = 0
  let toolErrors = 0
  let assistantChars = 0
  let codeChars = 0

  for (const event of window) {
    if (event.type === 'tool/call') {
      toolCalls += 1
      continue
    }
    if (event.type === 'tool/result') {
      toolResults += 1
      const message = event.data?.message
      const text = textOfMessage(message)
      const isError =
        message?.isError === true || event.data?.error !== undefined || /^\s*(error|dsh:\s*error)\b/iu.test(text)
      if (isError) toolErrors += 1
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOfMessage(event.data?.message)
      assistantChars += text.length
      for (const block of text.matchAll(/```[\s\S]*?```/gu)) codeChars += block[0].length
    }
  }

  /**
   * ── AUDIT F2: THE DENOMINATOR IS THE WINDOW'S ACTUAL TURN COUNT, NOT THE CONSTANT 6 ────────────
   *
   * WHAT WAS WRONG. `windowTurns` is the WINDOW SIZE — an upper bound on how far back to look. The
   * code then divided by it unconditionally:
   *
   *     const turns = Math.max(1, windowTurns)   // always 6
   *     const callsPerTurn = toolCalls / turns
   *
   * For a session with fewer than six turns, `window` holds fewer turns than the divisor claims,
   * so density is under-reported by the ratio. Measured with a log of a constant 3 tool calls per
   * turn, varying only the total:
   *
   *     2 turns  -> "1.0 tool calls/turn"  (should be 3.0)  -> depth 5, treated as BALANCED
   *     6 turns  -> "3.0 tool calls/turn"  (correct)        -> depth 0, treated as DEBUG
   *     12 turns -> "3.0 tool calls/turn"  (correct)
   *
   * THE CONSEQUENCE IS BACKWARDS. A short session is the one whose every message matters most,
   * and it was the one getting the LOOSEST boundary, because its density was under-reported into
   * the "generation-shaped" bucket.
   *
   * Fix: count the turn starts INSIDE the window that was actually sliced. `Math.max(1, …)` stays,
   * because a window with tool calls but no turn/start event is still one unit of work rather than
   * a division by zero.
   */
  let windowTurnCount = 0
  for (const event of window) {
    if (event.type === 'turn/start') windowTurnCount += 1
  }
  const turns = Math.max(1, windowTurnCount)
  const callsPerTurn = toolCalls / turns
  const errorRatio = toolResults === 0 ? 0 : toolErrors / toolResults
  const codeRatio = assistantChars === 0 ? 0 : codeChars / assistantChars

  // Debug wins when the session is busy with tools and hitting failures.
  const debugScore = callsPerTurn * 1.2 + errorRatio * 3 + codeRatio * 1.2
  // Generation shows up as long assistant text with few tools and no failures.
  const generationScore = (assistantChars / turns / 1200) * 1.0 + (1 - Math.min(1, callsPerTurn)) * 1.5 + (1 - errorRatio) * 0.5

  let depth: number
  let mode: AdaptiveDepthResult['mode']
  let reason: string
  if (debugScore >= generationScore && debugScore > 1.2) {
    mode = 'debug'
    // v7.2: debug sessions get ZERO replayed turns.
    //
    // The measurement that decided this: on a real 14-turn session, tier A
    // (0 turns) and tier C (5 turns) carry the SAME 342 read-back handles — every
    // pointer the target could want is in the index either way — while A is ~70%
    // smaller in characters. The replayed turns were not adding retrieval; they
    // were adding bulk.
    //
    // That matters most in exactly this shape: a debugging session's recent turns
    // are stack traces and command output, the least compressible text there is.
    // Replaying them spends the budget restating failures, while the ONE failure
    // that matters is now inlined verbatim into the pending state, with its seq
    // and (if long) a truncation mark.
    //
    // What the target keeps: goal, task status, workspace files, pending state
    // with the failure text, the failure's own body, and the full read-back index.
    depth = 0
    reason =
      `debug-shaped: ${callsPerTurn.toFixed(1)} tool calls/turn, ${(errorRatio * 100).toFixed(0)}% errors, ` +
      `${(codeRatio * 100).toFixed(0)}% code — zero replay, failure text inlined, every pointer indexed`
  } else if (generationScore > debugScore && callsPerTurn < 1) {
    mode = 'generation'
    depth = Math.max(min, Math.min(4, Math.round(min + 1)))
    reason = `generation-shaped: ${callsPerTurn.toFixed(1)} tool calls/turn, ${(codeRatio * 100).toFixed(0)}% code, long prose`
  } else {
    mode = 'balanced'
    depth = Math.max(min, Math.min(max, 5))
    reason = `balanced: ${callsPerTurn.toFixed(1)} tool calls/turn, ${(errorRatio * 100).toFixed(0)}% errors`
  }

  return { depth, mode, reason }
}
