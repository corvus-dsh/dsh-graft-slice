/**
 * v7.0 P1-4: whether a message is only steering.
 *
 * Deliberately narrow. It matches a short message (<= 12 chars after trimming
 * trailing punctuation) whose entire content is an acknowledgement, a
 * continuation, or a slash command. Anything longer is real content even if it
 * opens with "好，" — a user who writes "好，但是别动 JSX" is asking for
 * something, and dropping it would lose a constraint.
 */
export function isSteeringOnly(text: string): boolean {
  const compact = text.replace(/[\s。.!！?？,，、~～]+$/gu, '').trim()
  if (compact.length === 0) return true
  if (compact.startsWith('/')) return true
  if (compact.length > 12) return false
  return /^(请?继续|继续吧?|好的?|可以|行|嗯+|是|对|确认|确定|同意|开始|ok|okay|yes|y|sure|go|proceed|continue|doit)$/iu.test(
    compact,
  )
}

  /**
 * v6.0 zero-forgery transition card.
 *
 * Hard rules, learned from a real incident that corrupted a 7,531-event user
 * log (see README: "v6.0 日志损坏事故"):
 *
 *   1. NEVER write `turn/start` or `step/start`. The agent loop is the only
 *      writer of lifecycle events; a plugin that opens them desynchronizes the
 *      step sequence and v4 rejects the whole log.
 *   2. Only write when the agent loop already has an OPEN step. No open step
 *      means no card — silence is strictly better than a corrupt log.
 *   3. Only append `developer/message` and `session/title`. Both are log-only
 *      records that no lifecycle rule constrains.
 *   4. Pre-validate the projected sequence with the same rules v4 enforces,
 *      and skip the write entirely if it would break turn/step monotonicity.
 */
export function validateAppendIsLifecycleSafe(
  events: readonly any[],
  append: { type: string; data: Record<string, any> },
): { ok: true } | { ok: false; reason: string } {
  // Only lifecycle-relevant event types can break the sequence. The two types
  // this card writes are excluded from the state machine by design.
  if (append.type === 'turn/start' || append.type === 'step/start' || append.type === 'turn/end' || append.type === 'step/end') {
    return { ok: false, reason: `${append.type} is agent-loop owned` }
  }
  let turn: number | null = null
  let step: number | null = null
  let nextTurn = 1
  let nextStep = 1
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        if (turn !== null) return { ok: false, reason: `turn/start while turn ${turn} is open` }
        if (event.data?.turn !== nextTurn) return { ok: false, reason: `turn/start ${event.data?.turn} != ${nextTurn}` }
        turn = event.data.turn
        step = null
        nextStep = 1
        break
      }
      case 'step/start': {
        if (turn === null) return { ok: false, reason: 'step/start without an open turn' }
        if (step !== null) return { ok: false, reason: `step/start while step ${step} is open` }
        if (event.data?.step !== nextStep) return { ok: false, reason: `step/start ${event.data?.step} != ${nextStep}` }
        step = event.data.step
        break
      }
      case 'step/end': {
        if (step === null || event.data?.step !== step) return { ok: false, reason: 'step/end mismatch' }
        step = null
        nextStep = (event.data.step ?? 0) + 1
        break
      }
      case 'turn/end': {
        if (turn === null || step !== null) return { ok: false, reason: 'turn/end with open step or closed turn' }
        turn = null
        nextTurn += 1
        break
      }
      default:
        break
    }
  }
  return { ok: true }
}

/** The open turn/step the card may attach to, or undefined when none is open. */
export function openStepOf(events: readonly any[]): { turn: number; step: number } | undefined {
  let turn: number | null = null
  let step: number | null = null
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turn = typeof event.data?.turn === 'number' ? event.data.turn : null
        step = null
        break
      case 'step/start':
        step = typeof event.data?.step === 'number' ? event.data.step : null
        break
      case 'step/end':
        step = null
        break
      case 'turn/end':
        turn = null
        step = null
        break
      default:
        break
    }
  }
  return turn !== null && step !== null ? { turn, step } : undefined
}

/**
 * v7.0 B4: a sidebar title that reads as the SAME work continuing.
 *
 * The old form was `[已交接] → <id>`, which announces an administrative event.
 * A user scanning the sidebar wants to find "the task I was doing", not "an
 * event that happened to a session". Reusing the target's own title head keeps
 * the two windows recognisably the same thread.
 */
export function continuationTitle(targetTitle: string | undefined, targetId: string): string {
  const head = (targetTitle ?? '').replace(/^\[接续\]\s*/u, '').trim()
  if (head.length === 0) return `[接续] → ${targetId}`
  return `[接续] ${head}`
}
