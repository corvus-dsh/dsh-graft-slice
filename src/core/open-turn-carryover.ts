import type { SessionEventLike } from './watermark.js'
import { asSafeInteger } from '../utils/serialize.js'
import { textOfMessage } from './watermark.js'
import { normalizeText } from './text-normalize.js'

/**
 * v7.0 B1: do not throw away the open turn's finished work.
 *
 * `locateBoundary()` cuts at the last `turn/end`, so the turn that is *currently
 * running* is excluded — and it has to be, because the target cannot inherit a
 * turn the source has not finished. But "exclude the open turn" was implemented
 * as "exclude everything after the boundary", and by the time the watermark
 * trips that open turn typically already contains a dozen completed tool calls
 * that produced real results: files written, tests run, errors seen.
 *
 * Dropping them means the target is blind to the most recent work — the exact
 * work the user is watching. It then re-runs commands whose output is already
 * in the log.
 *
 * This function collects what the open turn actually accomplished, as pointers
 * (never bodies), so the target knows the work exists and can read it back.
 */
export interface PointerItem {
  /** The tool as the source called it. */
  name: string
  /** The seq of the tool/result a reader can fetch. */
  seq: number
  /** That call came back as an error. */
  isError?: boolean
  /** The target does not have this tool mounted (v6.4 F3). */
  unavailable?: boolean
}

export interface OpenTurnCarryover {
  turn: number
  /** Completed tool pointers, newest last. */
  pointers: PointerItem[]
  /** Assistant text produced so far in the open turn, trimmed. */
  assistantText: string
  /** User messages admitted during the open turn. */
  userTexts: string[]
}

export function extractOpenTurnCarryover(
  events: readonly SessionEventLike[],
  fromSeqExclusive: number,
  sourceSessionId?: string,
): OpenTurnCarryover | undefined {
  let turn: number | undefined
  const openCalls = new Map<string, { name: string; callSeq: number }>()
  const results = new Map<string, { resultSeq: number; isError: boolean; exitCode?: number }>()
  const assistant: string[] = []
  const user: string[] = []

  for (const event of events) {
    if (Number(event.seq) <= fromSeqExclusive) continue
    if (event.type === 'turn/start') {
      turn = asSafeInteger(event.data?.turn, 'turn/start.turn')
      continue
    }
    if (event.type === 'tool/call') {
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
      if (callId.length === 0) continue
      const name = typeof event.data?.name === 'string' && event.data.name.length > 0 ? event.data.name : 'unknown'
      openCalls.set(callId, { name, callSeq: Number(event.seq) })
      continue
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.toolCallId ?? message?.source?.callId
      if (typeof callId !== 'string' || callId.length === 0) continue
      const text = textOfMessage(message)
      const isError = message?.isError === true || event.data?.error !== undefined
      const exitMatch = /exit\s*(?:code)?\s*[:=]?\s*(\d{1,3})\b/iu.exec(text)
      results.set(callId, {
        resultSeq: Number(event.seq),
        isError,
        ...(isError && exitMatch !== null ? { exitCode: Number(exitMatch[1]) } : {}),
      })
      continue
    }
    if (event.type === 'user/message') {
      const sourceKind = typeof event.data?.source?.kind === 'string' ? event.data.source.kind : 'user'
      if (sourceKind !== 'user') continue
      const text = normalizeText(textOfMessage(event.data) ?? '').trim()
      if (text.length > 0) user.push(text)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOfMessage(event.data?.message).trim()
      if (text.length > 0) assistant.push(text)
    }
  }

  // Only calls with a real result — an unresolved call is not work, and
  // advertising it would invite the target to wait for something that will
  // never arrive (the source turn is abandoned, not resumable).
  const pointers: PointerItem[] = []
  for (const [callId, call] of openCalls) {
    const result = results.get(callId)
    if (result === undefined) continue
    pointers.push({
      name: call.name,
      seq: result.resultSeq,
      ...(result.isError ? { isError: true } : {}),
    })
  }

  if (turn === undefined && pointers.length === 0 && assistant.length === 0 && user.length === 0) return undefined
  return {
    turn: turn ?? 0,
    pointers,
    assistantText: assistant.join('\n\n'),
    userTexts: user,
  }
}
