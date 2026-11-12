import type { SessionEventLike } from './watermark.js'
import { textOfMessage } from './watermark.js'
import { isRecord, truncateEnd } from '../utils/serialize.js'
import type { SemanticOutcome, SemanticDiscard } from './task-board.js'
import type { SemanticState } from './instruction-card.js'

/** Test runners and git are the two honest "this finished" signals on this project. */
const TEST_PASS_PATTERNS: readonly RegExp[] = [
  /ℹ pass (\d+)/u,
  /(\d+)\s+passing\b/u,
  /(\d+)\/(\d+)\s+checks passed/u,
  /(\d+)\s+passed\b/u,
]

function outcomeOfResult(
  tool: string,
  args: Record<string, unknown> | undefined,
  text: string,
  seq: number,
): SemanticOutcome | undefined {
  const command = typeof args?.command === 'string' ? args.command : ''
  if (/(^|[;&|\s])git push\b/u.test(command)) {
    const ref = /([\w./-]+)\s*->\s*([\w./-]+)/u.exec(text)
    return {
      kind: 'push',
      text: ref === null ? 'git push 成功' : `git push 成功（${ref[2].trim()}）`,
      seq,
      tool,
    }
  }
  if (/(^|[;&|\s])git commit\b/u.test(command)) {
    const ref = /\[[^\]]*?\s([0-9a-f]{7,40})\]/u.exec(text)
    return {
      kind: 'commit',
      text: ref === null ? 'git commit 成功' : `git commit ${ref[1].slice(0, 7)} 成功`,
      seq,
      tool,
    }
  }
  for (const pattern of TEST_PASS_PATTERNS) {
    const match = pattern.exec(text)
    if (match === null) continue
    const first = Number(match[1])
    const second = match[2] === undefined ? undefined : Number(match[2])
    if (!Number.isFinite(first) || first <= 0) continue
    const label = second === undefined || second === first ? `${first}` : `${first}/${second}`
    return { kind: 'test-pass', text: `测试 ${label} 通过`, seq, tool }
  }
  if (tool === 'write' || tool === 'edit') {
    const path = typeof args?.file_path === 'string' ? args.file_path : ''
    const base = path.split(/[\\/]/u).filter((part) => part.length > 0).at(-1)
    if (base !== undefined && base.length > 0) {
      return { kind: 'artifact', text: `${tool === 'write' ? '写入' : '修改'} ${base} 完成`, seq, tool }
    }
  }
  return undefined
}

/**
 * v0.19: read the LAST RESULT, the UNRESOLVED failure, and what was thrown away.
 *
 * The scan is newest-first and stops at the first success: anything older than the
 * newest success is history. A failure found after that success (i.e. older) was
 * therefore superseded — it is counted as `resolvedErrors` and dropped, which is
 * the concrete meaning of "已解决的冲突不带进新上下文".
 */
export function extractSemanticState(events: readonly SessionEventLike[]): SemanticState {
  const discarded: SemanticDiscard = { errorBodies: 0, resolvedErrors: 0, narrationChars: 0, pointerLines: 0 }
  const calls = new Map<string, { tool: string; args: Record<string, unknown> | undefined }>()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
    if (callId.length === 0) continue
    const tool = typeof event.data?.name === 'string' ? event.data.name : ''
    let args: Record<string, unknown> | undefined
    try {
      const parsed = JSON.parse(String(event.data?.arguments ?? '{}'))
      if (isRecord(parsed)) args = parsed
    } catch {
      // Arguments that are not JSON cannot name a command or a path.
    }
    calls.set(callId, { tool, args })
  }

  let outcome: SemanticOutcome | undefined
  let unresolved: SemanticState['unresolvedError']
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/result') continue
    const seq = Number(event.seq)
    const message = event.data?.message
    const callId = String(message?.toolCallId ?? message?.source?.callId ?? '')
    const call = calls.get(callId)
    const tool = call?.tool ?? ''
    const text = textOfMessage(message)
    const isError = message?.isError === true || event.data?.error !== undefined
    if (isError) {
      if (outcome !== undefined || unresolved !== undefined) {
        // Something succeeded after it: the failure was superseded. Drop it.
        discarded.resolvedErrors += 1
        continue
      }
      const line =
        text
          .split(/\r?\n/u)
          .map((candidate) => candidate.trim())
          .find((candidate) => /error|失败|exception|assert|not found|cannot|exit code/iu.test(candidate)) ??
        text.split(/\r?\n/u)[0] ??
        ''
      unresolved = {
        text: truncateEnd(line.replace(/\s+/gu, ' '), 160).text,
        seq,
        tool: tool.length > 0 ? tool : 'tool',
      }
      discarded.errorBodies += 1
      continue
    }
    if (outcome !== undefined) continue
    const found = outcomeOfResult(tool, call?.args, text, seq)
    if (found !== undefined) outcome = found
  }

  return {
    ...(outcome === undefined ? {} : { outcome }),
    ...(unresolved === undefined ? {} : { unresolvedError: unresolved }),
    discarded,
  }
}
