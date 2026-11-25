import type { SessionEventLike } from './watermark.js'
import type { GraftBoundary } from './tape-shape.js'
import { asSafeInteger, graftError, isRecord } from '../utils/serialize.js'

/**
 * Phase 1: locate the last CLOSED turn boundary.
 *
 * A turn that is still open cannot be sliced: it has no `turn/end`, and the
 * caller is usually the very turn that is running, so it can never close
 * itself. Refusing outright makes the tool nearly unusable — every in-turn
 * invocation fails. Instead the open tail is dropped and the cut moves to the
 * last closed `turn/end`, which is exactly the strategy autoGraft already uses.
 *
 * Structural malformation is still fatal: a `turn/start` inside an open turn
 * or a `turn/end` without a matching `turn/start` means the log itself is
 * inconsistent, and silently trimming there could slice through a broken span.
 */
export function locateBoundary(events: readonly SessionEventLike[], options?: { allowOpenTail?: boolean }): GraftBoundary {
  const allowOpenTail = options?.allowOpenTail !== false
  let openTurn: number | null = null
  let lastEnd: { seq: number; turn: number } | null = null
  let lastClosedSeq = -1
  let droppedOpenTurns = 0
  let turnCount = 0
  let lastTurnReason = 'unknown'

  for (const event of events) {
    if (event.type === 'turn/start') {
      if (openTurn !== null) {
        throw graftError(
          'OPEN_TURN',
          `turn/start at seq ${event.seq} opens turn ${String(event.data?.turn)} while turn ${openTurn} is still open`,
        )
      }
      openTurn = asSafeInteger(event.data?.turn, 'turn/start.turn')
      turnCount += 1
      continue
    }
    if (event.type === 'turn/end') {
      const turn = asSafeInteger(event.data?.turn, 'turn/end.turn')
      if (openTurn === null) {
        throw graftError('UNBALANCED_TURN', `turn/end at seq ${event.seq} closes turn ${turn} with no open turn`)
      }
      if (turn !== openTurn) {
        throw graftError(
          'UNBALANCED_TURN',
          `turn/end at seq ${event.seq} closes turn ${turn} but turn ${openTurn} is open`,
        )
      }
      openTurn = null
      lastEnd = { seq: Number(event.seq), turn }
      lastClosedSeq = Number(event.seq)
      const reason = event.data?.reason
      lastTurnReason = isRecord(reason) && typeof reason.kind === 'string' ? reason.kind : 'unknown'
    }
  }

  if (openTurn !== null) {
    if (!allowOpenTail) {
      throw graftError(
        'OPEN_TURN',
        `the last turn (${openTurn}) has no matching turn/end; refusing to slice without a stable boundary`,
      )
    }
    // Drop the open tail and cut at the last closed turn. The caller is usually
    // the running turn itself, which can never close itself, so refusing here
    // would make every in-turn call fail.
    droppedOpenTurns = 1
  }
  if (lastEnd === null) {
    throw graftError('NO_CLOSED_TURN', 'the source log contains no closed turn (no turn/end)')
  }
  return {
    boundarySeq: lastEnd.seq,
    lastTurn: lastEnd.turn,
    turnCount,
    lastTurnReason,
    ...(droppedOpenTurns === 0 ? {} : { droppedOpenTurns }),
  }
}
