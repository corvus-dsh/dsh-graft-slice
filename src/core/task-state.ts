/**
 * v7.7 TASK-STATE LAYER — the three gates that READ the session log and answer a question.
 *
 * Moved verbatim from index.ts. Nothing here writes, nothing here touches the host: every
 * function is a pure fold over a `SessionEventLike[]`, which is what makes them testable in
 * isolation and what makes the move behaviour-free.
 *
 * Dependency rules honoured here (same rules as core/watermark.ts):
 *   - the only imports are `../utils/serialize.js` and `./watermark.js`;
 *   - nothing in this file imports index.ts, so no cycle can form;
 *   - no module-level mutable state: a re-imported copy is indistinguishable from the original.
 *
 * WHY THESE THREE TOGETHER AND NOT JUST ONE: they share the same traversal. `checkTaskBoundary`
 * consumes `extractTaskState(...).openTodos`, and all three walk the same event list looking at
 * tool/call vs tool/result pairs — splitting them further would duplicate that walk, not remove it.
 *
 * WHAT DID *NOT* MOVE, AND WHY: `buildPendingState` / `renderTaskBoard`, which are built on top of
 * `extractTaskState` but are also the exact implementation of the automatic handover extraction
 * (TD-11). Their shape will change when `graft_prepare` gains a content parameter, so moving them
 * now would mean moving them twice.
 */

import { isRecord, truncateEnd } from '../utils/serialize.js'
import { textOfMessage } from './watermark.js'
import type { SessionEventLike } from './watermark.js'

/**
 * Split prose into sentences.
 *
 * Shared, not private to the task-state fold: index.ts uses it for the plan/citation scanners too.
 * It moves with the block that needs it because a module may not import index.ts — and an
 * inlined bundle makes the reverse import unnecessary anyway (one scope, one copy).
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

export interface TaskState {
  todos: string[]
  subagentReports: string[]
  /** Unchecked items from the last todo_write, in order. */
  openTodos: string[]
  /**
   * v7.4: the seq of the last `todo_write`, and how far the log has moved since.
   *
   * The list is a snapshot of what the model believed at that moment, and models
   * stop updating it: measured on a real 44-turn session, the last `todo_write`
   * was at seq 9269 while the boundary was 13413 — 4,144 events and eleven turns
   * of work later. The block was presented without any date, so the target read a
   * finished list as the current plan and re-verified work that was already done.
   *
   * The plugin cannot invent fresher data; what it can do is refuse to imply that
   * the list is current.
   */
  todoSeq?: number
  /** Events between the last todo_write and the end of the sliced span. */
  todoAgeEvents?: number
  todoAgeTurns?: number
}

/**
 * v7.4b: does this tool result look like a file listing, a source dump or a test
 * log rather than a conclusion someone wrote for me?
 *
 * Kept separate from `addReport`'s own dump test because the two run at
 * different stages: this one guards the *decision to call it a report*, the
 * other guards the rendering.
 */
/**
 * v7.4b: tools whose results are file text or logs, never a subagent's conclusion.
 * For these the report marker has to be at the very start of the result.
 */
const NEVER_REPORTERS = new Set([
  'read',
  'glob',
  'grep',
  'pwsh',
  'edit',
  'write',
  'create_file',
  'apply_patch',
  'str_replace_editor',
])

function looksLikeToolDump(text: string): boolean {
  if (/<path>|<\/content>|<type>/u.test(text)) return true
  if ((text.match(/^\s*\d+:\s/gmu) ?? []).length >= 3) return true
  if ((text.match(/✔ /gu) ?? []).length >= 3) return true
  return (text.match(/[A-Za-z]:\\/gu) ?? []).length >= 4
}

/**
 * v0.32 P1: recognise the todo tool even when it arrives under a namespace.
 *
 * The live host registers `todo_write`, but a preset/toolset is allowed to expose
 * it as `mcp__server__todo_write`, `foo.todo_write` or `foo/todo-write`. An exact
 * `name === 'todo_write'` test then misses the newest write and the board keeps
 * showing the previous list — the exact "old P1-1/P1-2" symptom.
 */
const TODO_TOOL_NAME = /(?:^|[^a-z0-9])todo[_-]?write$/iu

function isTodoWriteTool(name: string): boolean {
  return TODO_TOOL_NAME.test(name.trim())
}

/**
 * v0.32 P1: parse a todo_write argument payload from every shape the log may
 * carry: a JSON string (the public `tool/call.arguments` contract), an
 * already-parsed object (older plugin / fixture), a bare array, or a `todos`
 * field that is itself a JSON string.
 *
 * `undefined` means "this call did not carry a usable list"; it must NOT replace
 * the previous state with an empty list.
 */
function todoItemsFromArguments(raw: unknown): Array<{ text: string; completed: boolean }> | undefined {
  let payload: any
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw)
    } catch {
      return undefined
    }
  } else if (isRecord(raw)) {
    payload = raw
  } else {
    return undefined
  }
  let list: unknown = Array.isArray(payload) ? payload : payload?.todos
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(list)) return undefined
  const next: Array<{ text: string; completed: boolean }> = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const content = String(item.content ?? item.text ?? item.title ?? '').replace(/\s+/gu, ' ').trim()
    if (content.length === 0) continue
    const status = String(item.status ?? '')
    next.push({
      text: truncateEnd(content, 300).text,
      completed: status === 'completed' || status === 'done' || item.completed === true,
    })
  }
  return next
}

/** Stable seq order: a concatenated or replayed log must never let an older write win. */
function orderedBySeq(events: readonly SessionEventLike[]): SessionEventLike[] {
  return [...events].sort((left, right) => {
    const a = Number(left.seq)
    const b = Number(right.seq)
    const aValid = Number.isFinite(a)
    const bValid = Number.isFinite(b)
    if (!aValid && !bValid) return 0
    if (!aValid) return 1
    if (!bValid) return -1
    return a - b
  })
}

export function extractTaskState(events: readonly SessionEventLike[]): TaskState {
  const reports: string[] = []
  const reportSeen = new Set<string>()
  const callNames = new Map<string, string>()

  // v6.2: the todo list is a STATE, not a log.
  //
  // The previous version accumulated every todo_write snapshot, so a task that
  // was written three times appeared three times — once unchecked, then checked,
  // then checked again. On a Flash-class model that reads as "there are twelve
  // things to do" and is worse than no list at all.
  //
  // A later todo_write replaces the previous state entirely; only the LAST one
  // describes what the model currently believes.
  let latestTodoWrite: Array<{ text: string; completed: boolean }> | undefined
  /** v7.4: where that snapshot was taken, so staleness can be reported. */
  let latestTodoSeq: number | undefined
  let latestTodoTurn: number | undefined
  let lastTurn = 0

  // v0.32 P1: read in SEQ order, never in array order. `readSession` is normally
  // monotonic, but a rebuilt/concatenated snapshot (live tail + persisted prefix)
  // is not guaranteed to be. Taking "the last todo_write in the array" then picked
  // an older write and the board showed a plan from dozens of turns ago.
  const ordered = orderedBySeq(events)

  // A failed todo_write never changed the model's state. Without this, the
  // arguments of a REJECTED call override the last successful list — again an
  // older board. A call with no result yet stays eligible: it is the newest
  // intent and the surrounding step has not closed.
  const resultFailed = new Map<string, boolean>()
  for (const event of ordered) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    const callId = String(message?.source?.callId ?? message?.toolCallId ?? '')
    if (callId.length === 0) continue
    resultFailed.set(callId, message?.isError === true || event.data?.error !== undefined)
  }

  const addReport = (text: string): void => {
    const normalized = text.replace(/\s+/gu, ' ').trim()
    if (normalized.length === 0) return
    // v7.0: a "report" is a summary a subagent returned, not a directory dump.
    //
    // Measured on session-legacy-fixture, the injected [Subagent Reports] block was
    // 4,533 characters of raw `pwsh` output — file listings and test logs that
    // happened to match /report|调研/. That is tool output wearing a report's
    // label: it spends the largest single chunk of the budget on text the target
    // can neither act on nor verify, while the real subagent conclusions sit
    // below it in the same blob.
    //
    // A directory listing or a log tail is recognisable: many short lines with
    // timestamps/sizes, or a wall of paths. Those become pointers instead — the
    // caller keeps the seq, and re-reading is one tool call away.
    const looksLikeDump =
      (normalized.match(/[A-Za-z]:\\/gu) ?? []).length >= 4 ||
      (normalized.match(/\d{4}\/\d{1,2}\/\d{1,2}/gu) ?? []).length >= 3 ||
      (normalized.match(/-{3,}/gu) ?? []).length >= 2
    if (looksLikeDump) return
    const line = `- ${truncateEnd(normalized, 400).text}`
    if (reportSeen.has(line)) return
    reportSeen.add(line)
    reports.push(line)
  }

  for (const event of ordered) {
    if (event.type === 'turn/start') {
      const value = Number(event.data?.turn)
      if (Number.isFinite(value)) lastTurn = value
      continue
    }
    if (event.type === 'tool/call') {
      const name = String(event.data?.name ?? '')
      const callId = String(event.data?.callId ?? '')
      if (callId.length > 0) callNames.set(callId, name)
      if (isTodoWriteTool(name)) {
        // A rejected write did not land. Keep the last successful state.
        if (callId.length > 0 && resultFailed.get(callId) === true) continue
        const next = todoItemsFromArguments(event.data?.arguments)
        if (next !== undefined) {
          const seq = Number(event.seq)
          // Sorting already guarantees this; the guard keeps the invariant local
          // even if a caller passes duplicate/shadowed seqs.
          if (latestTodoSeq === undefined || !Number.isFinite(seq) || seq >= latestTodoSeq) {
            // Replace, never merge.
            latestTodoWrite = next
            latestTodoSeq = Number.isFinite(seq) ? seq : latestTodoSeq
            latestTodoTurn = lastTurn
          }
        }
      }
      continue
    }

    if (event.type === 'assistant/message') {
      const text = textOfMessage(event.data?.message)
      for (const sentence of splitSentences(text)) {
        if (/(子代理|Subagent|subagent|teammate|调研结果|回传报告)/u.test(sentence)) {
          addReport(sentence)
        }
      }
      continue
    }

    if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = String(message?.source?.callId ?? message?.toolCallId ?? '')
      const name = callNames.get(callId) ?? ''
      const text = textOfMessage(message)
      const byTool = /wait_agent|send_message|subagent|spawn_teammate/u.test(name)
      if (text.length === 0) continue
      // v7.4b: a keyword ANYWHERE in a 4 KB file dump is not a subagent report.
      //
      // Measured on `handoff-demo`: 4 of the 5 injected "reports" were
      // `read`/`pwsh`/`job_output` output that merely happened to contain the
      // word "report" or a test runner's `✔`. The block then spent ~1.7 KB — the
      // second largest chunk of the tape — on text the target can neither act on
      // nor verify, and every such line pushes a real conclusion out.
      //
      // Two gates now: the keyword must be in the OPENING of the result (where a
      // report announces itself), and the body must not look like a file/log dump.
      if (!byTool) {
        // A report announces itself in its first line. Scanning 300 chars was
        // still enough for a `graft_prepare` summary that mentions
        // "subagent-reports" as a chunk name, and for a test probe that printed
        // `origin= subagent`. 60 characters is where a real conclusion says what
        // it is.
        //
        // v7.4b: tools that only ever produce file/log text need the marker at the
        // very START. `pwsh` grep output can contain "subagentReports" in a code
        // line and still be a grep hit, not a report.
        const window = NEVER_REPORTERS.has(name) ? text.slice(0, 12) : text.slice(0, 60)
        if (!/(子代理|Subagent|subagent|teammate|调研结果|回传报告|report)/iu.test(window)) continue
        if (looksLikeToolDump(text)) continue
      }
      addReport(`${name || 'subagent'}: ${text}`)
    }
  }

  // Only the final snapshot becomes the injected list.
  const todos = (latestTodoWrite ?? []).map(
    (item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`,
  )

  // v7.4: how stale is this snapshot?
  const lastSeq = ordered.reduce((max, event) => {
    const seq = Number(event?.seq)
    return Number.isFinite(seq) ? Math.max(max, seq) : max
  }, 0)
  const ageEvents =
    latestTodoSeq === undefined || !Number.isFinite(lastSeq) ? undefined : Math.max(0, lastSeq - latestTodoSeq)
  const ageTurns =
    latestTodoTurn === undefined || lastTurn === 0 ? undefined : Math.max(0, lastTurn - latestTodoTurn)

  return {
    todos: todos.slice(0, 30),
    subagentReports: reports.slice(-5),
    openTodos: (latestTodoWrite ?? []).filter((item) => !item.completed).map((item) => item.text),
    ...(latestTodoSeq === undefined ? {} : { todoSeq: latestTodoSeq }),
    ...(ageEvents === undefined ? {} : { todoAgeEvents: ageEvents }),
    ...(ageTurns === undefined ? {} : { todoAgeTurns: ageTurns }),
  }
}

/**
 * v6.3 module 1: Safe Harbor.
 *
 * Migrating while a tool call is still pending, or while the model is streaming,
 * cuts a half-finished step. The target then inherits a dangling call with no
 * result — the model sees work it cannot account for.
 *
 * A session is NOT at a safe harbor when:
 *   - a tool/call has no matching tool/result yet
 *   - an assistant/message has a non-empty stream that never closed
 *
 * When unsafe, the caller records `pendingGraft` and retries at the next
 * turn/end, which is by construction a quiet boundary.
 */
/**
 * The state of a session's harbour check.
 *
 * ── v0.9.3 (2026-11-09): `openCallAgeSeconds` WAS ADDED BECAUSE THE QUESTION HAD NO TIME DIMENSION ──
 *
 * The check used to be purely structural: "is there a `tool/call` with no matching `tool/result`". A
 * call that never returns — a crashed tool, a killed subprocess, a probe that hung — therefore held the
 * harbour closed FOREVER. The consequence is not a deadlock while the user is active (`turn-stopping`
 * and `pendingGraftSources` still fire); it is worse in a quieter way: once the session goes **idle**,
 * nothing re-triggers the check, and that session sits above the watermark permanently, never migrating.
 *
 * Measured before the change: `openCalls` was a `Set<string>` of ids only — no timestamp was retained
 * anywhere, so "how long has this call been open" was not answerable from the data on hand.
 *
 * So the age is now REPORTED, and a caller may act on it. `ageSeconds` is the largest age among the
 * still-open calls, derived from the `time` field of the `tool/call` event — the only per-event clock this
 * plugin has (it does not read a wall clock during a pure function, so the result stays deterministic
 * for a given event list).
 */
export interface HarborState {
  safe: boolean
  reason: string
  /**
   * Age of the OLDEST still-open tool call, in seconds, or `0` when there is none / no clock is available.
   *
   * `0` is also what an event list WITHOUT `time` fields produces, which is the pre-existing behaviour:
   * a caller that sets no age limit therefore sees exactly what it saw before.
   */
  openCallAgeSeconds: number
}

/**
 * v7.3: task-boundary probe — a second, orthogonal gate next to the harbour check.
 *
 * `checkSafeHarbor` answers a PHYSICAL question: is the log quiet right now (no
 * dangling tool call, no live stream)? This answers a SEMANTIC one: if we cut
 * here, does the target inherit a task that is mid-hole — a failing test nobody
 * has fixed yet, or a todo list with unfinished items?
 *
 * Why it matters even when the harbour is safe. The watermark trips on token
 * pressure, which has nothing to do with where the work is. In a debugging
 * session the most common shape at that moment is: a test just failed, the fix is
 * not written yet. Cutting there hands the target "a test is red" with no
 * knowledge of what the person was about to try — and the failure text, though
 * now inlined, describes a state that is about to become stale the moment anyone
 * edits a file. Waiting one turn turns "here is a failure" into "here is the
 * failure and the change it produced".
 *
 * The wait is bounded. `maxDeferTurns` (default 1) is enforced by the caller
 * through a per-session deferral counter, so a session with a permanently red
 * test — an expected one, a flaky one, one the user has decided to ignore — still
 * migrates on the next opportunity instead of never.
 */
export interface TaskBoundaryState {
  /** True when cutting now would split an unfinished task. */
  shouldDefer: boolean
  reason: string
  /** How many todos the model itself left unchecked. */
  openTodoCount: number
  /** True when the most recent completed tool call produced a failure. */
  lastCallFailed: boolean
}

export function checkTaskBoundary(
  events: readonly SessionEventLike[],
  openTodos: readonly string[] = [],
): TaskBoundaryState {
  // The most recent tool outcome, newest first. Only "completed" results count:
  // an unresolved call is the harbour's problem, not this one.
  let lastCallFailed = false
  let sawResult = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/result') continue
    const message = event.data?.message
    const text = textOfMessage(message)
    lastCallFailed =
      message?.isError === true ||
      event.data?.error !== undefined ||
      /^\s*(error|dsh:\s*error)\b/iu.test(text) ||
      /\b(?:AssertionError|FAIL(?:ED)?\b|tests? failed|exit code [1-9])/u.test(text)
    sawResult = true
    break
  }

  const openTodoCount = openTodos.length
  const reasons: string[] = []
  if (openTodoCount > 0) reasons.push(`${openTodoCount} todo item(s) still open`)
  if (sawResult && lastCallFailed) reasons.push('the last tool call failed')

  if (reasons.length === 0) {
    return { shouldDefer: false, reason: 'clean boundary', openTodoCount, lastCallFailed }
  }
  return {
    shouldDefer: true,
    reason: reasons.join(' and '),
    openTodoCount,
    lastCallFailed,
  }
}

export function checkSafeHarbor(
  events: readonly SessionEventLike[],
  options: { openCallMaxAgeMs?: number } = {},
): HarborState {
  /**
   * callId → the `time` of its `tool/call` (0 when the event carried no clock).
   *
   * The map replaces the old `Set<string>`: the ids are still what decides "is a call open", and the
   * timestamp is what lets the answer carry an AGE. Keeping both in one structure is why this stayed a
   * small change rather than a second pass over the events.
   */
  const openCalls = new Map<string, number>()
  let streaming = false
  /** The newest event clock in the list — the only "now" available to a pure function. */
  let latestTime = 0

  for (const event of events) {
    const eventTime = Number(event.time)
    if (Number.isFinite(eventTime) && eventTime > latestTime) latestTime = eventTime

    if (event.type === 'tool/call') {
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
      if (callId.length > 0) openCalls.set(callId, Number.isFinite(eventTime) ? eventTime : 0)
      continue
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.toolCallId ?? message?.source?.callId
      if (typeof callId === 'string') openCalls.delete(callId)
      continue
    }
    if (event.type === 'assistant/message') {
      const stream = event.data?.stream
      // A committed assistant message carries its completed stream; an in-flight
      // one is represented by assistant/chunk, which we also watch below.
      if (Array.isArray(stream) && stream.length > 0) streaming = false
      continue
    }
    if (event.type === 'assistant/chunk' || event.type === 'assistant/attempt') {
      // v7.2: `assistant/attempt` is a record of an ATTEMPT, not proof that a
      // stream is still open.
      //
      // Verified on the seven surviving real logs: every one contains 8-15
      // `assistant/attempt` events and every one still computes `safe: true`,
      // because a `turn/end` clears the flag. So the claim "attempt makes the
      // harbour permanently unsafe" is wrong for a well-formed log.
      //
      // But the shape below is not well-formed, and it is exactly what a crash or
      // an interrupted turn leaves behind:
      //
      //   turn/end {turn:1}      <- the turn closed
      //   assistant/attempt {turn:2}   <- a later attempt that never closed
      //
      // In that shape the flag is set AFTER the last clearing event, nothing ever
      // clears it again, and every future pre-step reports unsafe — which means
      // P6's overflow recovery can never run, on the one session that needs it
      // most. An attempt carries `stream: []` when it never produced output, and
      // a live stream always has `assistant/chunk` events alongside it, so the
      // honest reading is: chunks prove streaming, attempts do not.
      if (event.type === 'assistant/attempt') {
        const stream = event.data?.stream
        if (Array.isArray(stream) && stream.length > 0) streaming = true
        continue
      }
      streaming = true
      continue
    }
    if (event.type === 'turn/end') {
      streaming = false
    }
  }

  /**
   * THE AGE, COMPUTED BEFORE THE VERDICT.
   *
   * `latestTime - oldestOpenCallTime`. When no event carries a clock (an old fixture, a hand-built
   * list), `latestTime` is 0 and the age is 0 — which is the pre-existing behaviour, not a new one.
   */
  const oldestOpenTime = openCalls.size === 0 ? 0 : Math.min(...[...openCalls.values()].filter((t) => t > 0))
  const ageSeconds =
    oldestOpenTime > 0 && latestTime > oldestOpenTime ? Math.round((latestTime - oldestOpenTime) / 1000) : 0

  if (openCalls.size > 0) {
    /**
     * ── THE AGE LIMIT: opt-in, and OFF unless a caller asks for it ─────────────────────────────
     *
     * `0` / `Infinity` / a non-finite value keeps the old behaviour exactly ("a dangling call holds the
     * harbour forever"). A positive value means: past this age, stop waiting.
     *
     * WHY EXPIRING IS THE SAFE DIRECTION **HERE**, when a stale lease is not: a lease protects exclusive
     * access to shared state, so letting it expire early lets two writers in. This protects a MIGRATION
     * DECISION about a log that is already durable and being read, not written. Waiting forever costs the
     * session its only migration opportunity; migrating a session whose dangling call is 40 minutes old
     * costs a slightly-less-clean cut, and the dangler is named in the reason so a reader can see what
     * was skipped. Between "never migrate" and "migrate and say why", the second is the honest one.
     */
    const limit = Number(options.openCallMaxAgeMs)
    const limitActive = Number.isFinite(limit) && limit > 0 && limit !== Number.POSITIVE_INFINITY
    if (limitActive && ageSeconds > 0 && ageSeconds * 1000 >= limit) {
      return {
        safe: true,
        openCallAgeSeconds: ageSeconds,
        reason:
          `open call 超龄 ${ageSeconds} 秒（上限 ${Math.round(limit / 1000)} 秒），放弃等待：` +
          `${openCalls.size} 个 tool call 仍未返回`,
      }
    }
    return {
      safe: false,
      openCallAgeSeconds: ageSeconds,
      reason: `${openCalls.size} tool call(s) still awaiting a result`,
    }
  }
  if (streaming) {
    return { safe: false, openCallAgeSeconds: ageSeconds, reason: 'an assistant response is still streaming' }
  }
  return { safe: true, openCallAgeSeconds: ageSeconds, reason: 'quiet boundary' }
}
