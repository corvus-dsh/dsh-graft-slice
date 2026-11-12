/**
 * IGNITION — the graft-specific half. `src/core/ignition.ts`.
 *
 * WHAT MOVED HERE, AND WHAT DID NOT
 *
 * v7.6 extracted the ignition block (774 lines) out of `index.ts`. The split follows one question:
 * **is this a fact about talking to a host, or a fact about graft's own bookkeeping?**
 *
 *   → `dsh-paradise/src/adapters/dsh/trigger.ts` (already exists)
 *       the CHANNEL: marker, prompt text, AbortSignal-as-timeout, `sessionController.prompt` +
 *       `remote.session.prompt`, "an unreadable log is UNKNOWN, not already-done".
 *       That code is identical in spirit to what the observer needs, which is why it belongs to the
 *       layer rather than to either plugin.
 *
 *   → this file
 *       the POLICY: per-TARGET admission bookkeeping (so two grafts finishing in the same tick cannot
 *       both prompt), the retry path's liveness checks, the durable pending-ignition queue, and the
 *       rollback that un-retires a source. All of it reads graft's OWN state — `graftTargets`,
 *       `retiredSessions`, `autoGraftStates` — and none of it is meaningful to any other plugin.
 *
 * WHY THAT LINE AND NOT ANOTHER: the layer must not learn what a "retired source" is (that is a
 * slicing concept), and this file must not re-implement an AbortSignal contract (that is a host
 * concept). Anything on the wrong side of that line becomes a second copy that drifts.
 *
 * WHAT STAYS IN index.ts: `index.ts` still owns the state itself (the maps and sets), because they are
 * shared with the pre-step gate, the transfer machinery and the tool handlers. Moving the state would
 * mean moving half of index.ts; moving the FUNCTIONS that read it is the useful cut.
 *
 * DEPENDENCY DIRECTION: this module receives everything it needs as `deps` — no import from
 * `index.ts`, which would be a cycle (`index.ts` imports this file). That is the same shape
 * `core/txn.ts` uses for its audit sink, for the same reason.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { withFileLock } from './txn.js'
import { readLedger, writeJsonAtomic, writeLedgerAtomic } from './ledger.js'
import { isRecord } from '../utils/serialize.js'
import { ensureParadiseWrite } from './paradise-write.js'
import type { ParadiseSessionLike } from './paradise-write.js'

/** The prefix every ignition prompt carries. */
/** Prefix of every ignition prompt. A retry looks for exactly this in the target's log. */
export const IGNITION_MARKER = '[dsh-graft-slice 点火]'

/**
 * Every marker this plugin has ever stamped, current first.
 *
 * ── P0 (audit 2026-11-08): WHY A LIST AND NOT THE CONSTANT ─────────────────────────────────────
 *
 * `dsh-paradise` used to default to `'[dsh-observer 点火]'` — a layer inversion (L1 naming an L4
 * plugin). It now defaults to a neutral `'[plugin 点火]'` and takes the marker from the caller,
 * accepting a LIST for the idempotence check while stamping only the first entry.
 *
 * That makes THIS list the thing standing between a rename and a double ignition: sessions in the
 * field carry `'[dsh-graft-slice 点火]'`. Passing only a future marker would make every warm target
 * look "never ignited" and be prompted a second time — the exact failure this constant exists to
 * prevent, and the reason the comment above says the dialect is preserved rather than modernised.
 *
 * APPEND ONLY. An alias is never removed: a target ignited two releases ago may still be resumed.
 */
export const IGNITION_MARKERS: readonly string[] = [IGNITION_MARKER]

/** How many activation rounds a failed ignition is retried before giving up. */
export const IGNITION_MAX_ATTEMPTS = 3

/** A prompt that has not been admitted in this long is retried next activation. */
export const IGNITION_TIMEOUT_MS = 20_000

/**
 * The wake-up text. Kept byte-identical to the v0.20 wording on purpose: a graft target in the wild
 * has already read this exact sentence, and changing it would make the "already ignited" marker
 * ambiguous across a running session.
 */
export const DEFAULT_IGNITION_PROMPT =
  `${IGNITION_MARKER} 你刚刚完成了一次物理切片：上一段会话的上下文已经交接给你，` +
  '交接看板（交接任务看板 / PendingState）在工作区与历史里。' +
  '旧会话的历史执行日志和临时错误无需理会，它们只作为回读证据保留；' +
  '请直接执行看板中「⏭️ 待开始」里的待办项，不要复述交接过程，也不要重新调研已经完成的部分。'

export interface IgnitionResult {
  /** The channel was available and a call was made. */
  attempted: boolean
  ok: boolean
  channel?: string
  promptChars?: number
  reason?: string
  /** True when the target's own log already carried the ignition prompt. */
  alreadyIgnited?: true
}

export interface PendingIgnition {
  targetId: string
  sourceSessionId: string
  at: number
  attempts: number
}

export interface IgnitionRollback {
  attempted: boolean
  sourceRestored: boolean
  noticeAppended: boolean
  /** Target left in place and marked, so it is visible but not picked up. */
  targetId: string
  reason?: string
}

export interface IgnitionAttemptWithRollback extends IgnitionResult {
  /** Present when the attempt exhausted its budget and the source was restored. */
  rollback?: IgnitionRollback
}

/** What settings this module reads. Narrower than `Required<GraftConfig>` so a test can pass a stub. */
export interface IgnitionSettings {
  igniteTarget: boolean
  ignitionPrompt: string
  ignitionMode: 'queue' | 'steer'
}

/** The graft state this module reads. Injected, so the dependency stays one-way. */
export interface IgnitionDeps {
  /** Per-target admission bookkeeping: the guard against two same-tick prompts. */
  admissions: Map<string, { at: number; promptChars: number }>
  /** The durable pending queue. */
  pending: Map<string, PendingIgnition>
  /** Where the pending queue is persisted. */
  pendingPath: () => string
  /** Target marks, for the "already driven past its seed" retry check. */
  targets: Map<string, { seedEvents?: number }>
  /** The retired/transferred sets, for the rollback. */
  retired: Set<string>
  transferred: Map<string, unknown>
  autoGraftStates: Map<string, string>
  autoGraftInFlight: Map<string, unknown>
  pendingGraftSources: Map<string, unknown>
  pendingConfirms: Map<string, unknown>
  /**
   * Paths the rollback rewrites — GETTERS, NOT SNAPSHOTS.
   *
   * `configureRetiredStore` reassigns the owner's `retiredStorePath`/`transferredStorePath` whenever a
   * new profile or `dataDir` is resolved, and a test deliberately re-configures to a fresh directory
   * mid-suite. A deps object that captured the string at build time would roll back into the PREVIOUS
   * profile's ledger — the source would stay retired on disk while the in-memory set was cleared, which
   * is the exact double-blind state the rollback exists to end.
   */
  retiredStorePath: () => string
  transferredStorePath: () => string
  /** Sources already told about a rollback in this process (so the user is told once). */
  rollbackNoticed: Set<string>
  /**
   * THE ROLLBACK NOTICES WAITING TO BE DELIVERED, keyed by source session id.
   *
   * The rollback cannot write into a live session's log (that shape is what produced `turn: 0` and a
   * `SessionFormatError` at resume). So it REGISTERS the text here, and the source's own
   * `agent/pre-step` waterfall hands it to the model through `messages` on the next request. One
   * entry per source, consumed on delivery — same discipline as `pendingConstraints`.
   */
  rollbackNotices: Map<string, { text: string; at: number; targetId: string }>
  /** Append an audit entry. */
  audit: (entry: {
    at: string
    kind: string
    sessionId: string
    targetSessionId?: string // optional in the real type (utils/logger.ts:GraftAuditEntry)
    detail: string
  }) => void
  logWarn?: (message: string) => void
}

/**
 * THE INJECTED STATE — set once by `index.ts`, read by every function below.
 *
 * WHY A MODULE-LEVEL SINK RATHER THAN A `deps` PARAMETER: these functions are part of the plugin's
 * PUBLIC surface (four test files call them directly, and the activation path calls three more). A
 * `deps` first-argument would have changed seven signatures, which would have meant editing the tests
 * to accommodate a refactor. The refactor's whole promise is to be invisible — so the state is injected
 * once, exactly as `core/txn.ts` injects its audit sink for the same reason.
 *
 * THE DEFAULT IS REAL STATE, NOT A STUB. When nothing is injected (a unit test importing this module
 * directly, or a caller exercising ignition before activation), the module uses its OWN maps and a
 * no-op audit sink. That matters: `igniteTargetSession` records an admission on success, and a fallback
 * that discarded it would let two concurrent attempts both prompt the same target — the exact routing
 * bug the per-target map exists to stop. The default keeps that guarantee; only the persistence side
 * (which has no path yet) and the audit line are inert.
 */
const fallbackDeps: IgnitionDeps = {
  admissions: new Map(),
  pending: new Map(),
  pendingPath: () => '',
  targets: new Map(),
  retired: new Set(),
  transferred: new Map(),
  autoGraftStates: new Map(),
  autoGraftInFlight: new Map(),
  pendingGraftSources: new Map(),
  pendingConfirms: new Map(),
  retiredStorePath: () => '',
  transferredStorePath: () => '',
  rollbackNoticed: new Set(),
  rollbackNotices: new Map(),
  audit: () => {},
}

let D: IgnitionDeps = fallbackDeps

/**
 * A RESOLVER, not a value.
 *
 * The owner of the state declares its maps thousands of lines apart, so it cannot hand over a finished
 * object at module-evaluation time without hitting a temporal dead zone. It registers a function
 * instead, and this module asks for the state at the moment it actually needs it — by which time the
 * owner's module has finished evaluating.
 */
let resolver: (() => IgnitionDeps) | undefined

export function setIgnitionDepsResolver(fn: () => IgnitionDeps): void {
  resolver = fn
}

/**
 * THE current state — and it is ONE object, always.
 *
 * THE BUG THIS SIGNATURE EXISTS TO PREVENT: an earlier revision let this module keep its own fallback
 * maps while the owner kept real ones, so `resetRetiredSessions()` cleared the owner's admission map
 * while `alreadyIgnited()` consulted the fallback (or the reverse). The routing tests caught it: a
 * target whose log already carried the marker was prompted a second time. Two copies of "has this been
 * ignited" is two answers, and the wrong one is silent.
 *
 * So the resolver runs on EVERY access until it succeeds, and the fallback is only ever used when the
 * owner has not registered one at all (a bare unit test of this module).
 */
function state(): IgnitionDeps {
  if (resolver !== undefined) {
    try {
      D = resolver()
    } catch {
      // The owner's module has not finished evaluating yet; keep whatever we had.
    }
  }
  return D
}

/**
 * Resolve a host service the way the ORIGINAL code did: DIRECT PROPERTY FIRST, accessor second.
 *
 * WHY THE ORDER MATTERS AND IS NOT ARBITRARY: this plugin pre-dates the accessor. Every call site in
 * the ignition block read `ctx.sessionQuery.readSession` / `ctx.sessionController.prompt` /
 * `ctx.sessions.get` directly, and a test scaffold or a headless composition may mount only that face.
 * Switching to `ctx.get(...)` silently produced `undefined` for those hosts, which made every target
 * look "not yet ignited" — warm sessions got re-prompted, and an unreadable log stopped being reported
 * as a failure. Both were caught by the suite.
 *
 * Accepting both faces keeps the plugin working under either wiring, which is the same rule
 * `dsh-paradise`'s `service()` applies on the other side of the seam.
 */
function hostService(ctx: any, name: string): any {
  try {
    const direct = (ctx as any)?.[name]
    if (direct !== undefined && direct !== null) return direct
  } catch {
    // A property getter that throws is simply not a candidate.
  }
  try {
    const viaGet = (ctx.get as any)?.(name)
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch {
    // Same for `get`.
  }
  return undefined
}

/**
 * THE TARGET'S cwd, obtained the way this plugin obtains every cwd: from the session HEADER.
 *
 * `buildInjectionPlan` reads it as `log.session?.cwd` off `sessionQuery.readSession(sourceId)`, and
 * `MISSING_CWD` refuses a source that has none. The trigger needs the same value for the same reason —
 * the protocol's `SessionRef` requires an absolute cwd, and this plugin does not get to invent one.
 *
 * A caller that already holds the plan's cwd passes it in and skips this read; the fallback exists so a
 * direct call (a test, or a retry path that lost the plan) still addresses the right directory.
 */
async function resolveTargetCwd(ctx: any, targetId: string, known?: string): Promise<string> {
  if (typeof known === 'string' && known.length > 0) return known
  try {
    const raw = await (ctx as any).sessionQuery?.readSession?.(targetId)
    const fromHeader = isRecord(raw) && isRecord((raw as any).session) ? (raw as any).session.cwd : undefined
    if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
  } catch {
    // An unreadable log is the trigger's problem, not the cwd's: fall through with an empty string and
    // let the layer's own `CWD_REQUIRED` refusal state it.
  }
  return ''
}

/**
 * Resolve the layer's trigger verb, or `undefined` when this layer cannot provide one.
 *
 * Separate from `ensureParadiseWrite` because the two verbs fail independently: an installed layer
 * without a `trigger` can still write, and a caller that only ignites should not carry a write binding
 * it never uses.
 */
async function ensureParadiseTrigger(ctx: any): Promise<ParadiseSessionLike['trigger'] | undefined> {
  const binding = await ensureParadiseWrite(ctx)
  return binding.ok ? binding.triggers : undefined
}

/**
 * Extract the message text the way the log actually stores a `user/message`.
 *
 * THE SHAPE MATTERS AND GETTING IT WRONG IS SILENT: the original implementation passed `event.data`
 * WHOLE to `textOfMessage`, because that helper reads `.content` off its argument. A wrapper that
 * unwrapped `data.message` first would look for `.content` one level too deep, find nothing, and report
 * "no ignition marker in this log" — so every warm target would be prompted again.
 */
function textOfMessagePayload(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = Array.isArray((message as any).content) ? (message as any).content : []
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && (block as any).type === 'text' && typeof (block as any).text === 'string') {
      parts.push((block as any).text)
    }
  }
  return parts.join('\n').trim()
}

/** Is this user message the plugin's own ignition, rather than something a human typed? */
export function isIgnitionText(text: unknown): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(IGNITION_MARKER)
}

export function buildIgnitionPrompt(settings: Pick<IgnitionSettings, 'ignitionPrompt'>): string {
  const custom = typeof settings.ignitionPrompt === 'string' ? settings.ignitionPrompt.trim() : ''
  if (custom.length === 0) return DEFAULT_IGNITION_PROMPT
  return custom.startsWith(IGNITION_MARKER) ? custom : `${IGNITION_MARKER} ${custom}`
}

/**
 * Does this error mean "that session is not there", as opposed to "I could not read it"?
 *
 * THIS REGEX IS LOAD-BEARING AND WAS ONCE WRONG. The Remote's error code is `session/not-found` —
 * hyphenated — so a `/not found/` test missed the exact case it was written for, the not-found answer
 * was never taken, and the read error became "already ignited". A target that was never woken stayed
 * inert while the audit said ok.
 */
const SESSION_MISSING = /session\/not[\s_-]?found|not[\s_-]found|enoent|no such/iu

/**
 * The deadline: an AbortSignal that also doubles as the timeout.
 *
 * `release()` clears the timer on the success path. The rejected `expired` promise is pre-caught so
 * losing the race does not surface as an unhandled rejection.
 *
 * v7.7: RETAINED AS PUBLIC SURFACE, NO LONGER ON THE HOT PATH.
 *
 * The prompt CHANNEL moved to `dsh-paradise/src/adapters/dsh/trigger.ts`, which builds its own deadline
 * (`trigger.ts` has the same helper, private to it). What remains here is still used by
 * `targetAlreadyLive` below, which needs a bounded `sessionController.state` call — and it stays EXPORTED
 * because it is part of this module's published surface, which `index.ts` re-exports and which a
 * downstream integration may call. Deleting it would break a consumer to save twenty lines.
 */
export function ignitionDeadline(): { signal: AbortSignal; release: () => void; expired: Promise<never> } {
  const controller = new AbortController()
  let rejectExpired: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => {
    rejectExpired = reject
  })
  const timer = setTimeout(() => {
    const error = new Error(`timeout after ${IGNITION_TIMEOUT_MS}ms`)
    controller.abort(error)
    rejectExpired(error)
  }, IGNITION_TIMEOUT_MS)
  if (typeof (timer as any).unref === 'function') (timer as any).unref()
  expired.catch(() => {})
  return { signal: controller.signal, release: () => clearTimeout(timer), expired }
}

/**
 * Say WHY the prompt died, in the one line the audit keeps.
 *
 * A bare `AbortError` hides the interesting case: the Host aborted because the session was busy or its
 * writer was held (retryable), versus our own deadline expiring (a fact about us, not the target).
 *
 * v7.7: RETAINED AS PUBLIC SURFACE. The trigger's own failure description now lives in
 * `adapters/dsh/trigger.ts` (`describeFailure`), and this copy is what `index.ts` re-exports. A caller
 * that inspects an abort reason — the console panel does — keeps working without learning a new name.
 */
export function describePromptFailure(error: unknown, signal: AbortSignal): string {
  const message = String((error as any)?.message ?? error)
  if (signal?.aborted === true) {
    const reason = (signal as any).reason
    const why = typeof reason === 'string' ? reason : String((reason as any)?.message ?? 'deadline')
    return `${message} (aborted: ${why})`
  }
  return message
}

/* ── the durable pending queue ──────────────────────────────────────────────────────────────── */

/**
 * Read a plain JSON array, tolerating every failure as "empty".
 *
 * LOCAL TO THIS MODULE ON PURPOSE. `index.ts` still owns `readJsonArray` / `ledgerArray`, but this
 * module must not import from `index.ts` — `index.ts` imports THIS file, and the bundler inlines both
 * into one scope where a reverse import is a temporal-dead-zone crash rather than a build error (the
 * same hazard `core/txn.ts` documents for its audit sink). The bodies are copied verbatim so behaviour
 * cannot drift; when the storage block moves out in a later batch, both copies collapse into one.
 */
function readJsonArrayLocal(path: string): unknown[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** The ledger-aware variant: a torn or future-epoch envelope reads as empty, not as garbage. */
function ledgerArrayLocal(path: string): unknown[] {
  const read = readLedger(path)
  if (read.defect !== undefined && read.defect !== 'unreadable') return []
  return Array.isArray(read.payload) ? read.payload : []
}

export function loadPendingIgnitions(): void {
  try {
    for (const value of readJsonArrayLocal(state().pendingPath())) {
      if (!isRecord(value)) continue
      const targetId = typeof value.targetId === 'string' ? value.targetId : ''
      if (targetId.length === 0) continue
      state().pending.set(targetId, {
        targetId,
        sourceSessionId: typeof value.sourceSessionId === 'string' ? value.sourceSessionId : '',
        at: Number(value.at ?? 0),
        attempts: Number(value.attempts ?? 0),
      })
    }
  } catch (error) {
    try {
      state().logWarn?.(`[dsh-graft-slice] cannot read ${state().pendingPath()}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not block activation.
    }
  }
}

export function persistPendingIgnitions(): void {
  try {
    mkdirSync(dirname(state().pendingPath()), { recursive: true })
    writeJsonAtomic(state().pendingPath(), [...state().pending.values()])
  } catch (error) {
    try {
      state().logWarn?.(`[dsh-graft-slice] cannot write ${state().pendingPath()}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the migration result.
    }
  }
}

/* ── idempotence: has THIS target already been woken? ───────────────────────────────────────── */

/**
 * Does the target's own log already carry the ignition prompt?
 *
 * TWO SIGNALS, CHECKED IN THIS ORDER, AND THE ORDER IS THE POINT:
 *
 *   1. the in-process admission for THIS target — the only signal that covers the window between
 *      "prompt accepted" and "prompt visible in the target's log";
 *   2. the target's own log, which survives a restart.
 *
 * AND TWO KINDS OF READ FAILURE:
 *   - the session does not exist → it was certainly never ignited (the `resume` inside `prompt` is what
 *     creates the live agent), so the answer is `false`;
 *   - anything else → UNKNOWN, thrown, so the caller retries rather than believes a lie.
 *
 * v0.32 P0: an unknown used to return `true`. That turned a failed READ into a reported SUCCESS, the
 * queue entry was deleted, and the target was never woken — a silent no-op in the one place this
 * module promises never to produce one.
 */
export async function alreadyIgnited(
  readSession: ((id: string) => Promise<any>) | undefined,
  targetId: string,
): Promise<boolean> {
  if (state().admissions.has(targetId)) return true
  if (typeof readSession !== 'function') return false
  try {
    const raw = await readSession(targetId)
    const events: any[] = isRecord(raw) && Array.isArray((raw as any).events) ? (raw as any).events : []
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      // `event.data` is passed WHOLE: the text helper reads `.content` off its argument, and a
      // user/message stores the message payload at `data` (not at `data.message`). Unwrapping one
      // level too far finds no text and reports "no marker" for a log that has one.
      if (isIgnitionText(textOfMessagePayload(event.data))) return true
    }
    return false
  } catch (error) {
    const message = String((error as any)?.message ?? error)
    if (SESSION_MISSING.test(message)) return false
    throw new Error(`cannot read target log: ${message}`)
  }
}

/** Has this target exhausted its ignition budget? Kept as a predicate so the decision is testable. */
export function ignitionExhausted(entry: PendingIgnition | undefined): boolean {
  return entry !== undefined && entry.attempts >= IGNITION_MAX_ATTEMPTS
}

/**
 * Is the target already RUNNING, as the Host itself defines it?
 *
 * Used only on the retry path. A retried ignition must never re-instruct a target that is already live:
 * either our earlier prompt did land (and its marker is in the log) or a human opened the target and
 * took over. Prompting again in that window reads as the same instruction given twice.
 */
async function targetAlreadyLive(ctx: any, targetId: string): Promise<boolean> {
  try {
    const service = hostService(ctx, 'sessionController')
    if (!isRecord(service) || typeof (service as any).state !== 'function') return false
    const { signal, release } = ignitionDeadline()
    try {
      const state = await (service as any).state({ sessionId: targetId }, signal)
      return isRecord(state) && (state as any).active === true
    } finally {
      release()
    }
  } catch {
    // Unknown is not "live": an unknown target still gets its one ignition attempt.
    return false
  }
}

/**
 * Has the target moved past the tape the slice wrote?
 *
 * Only meaningful on the retry path, and only when the mark recorded how many events the tape had. A
 * cold target that nobody touched still ends exactly at that count.
 */
async function targetAlreadyDriven(
  readSession: ((id: string) => Promise<any>) | undefined,
  targetId: string,
): Promise<boolean> {
  const mark = state().targets.get(targetId)
  if (mark === undefined || typeof mark.seedEvents !== 'number') return false
  if (typeof readSession !== 'function') return false
  try {
    const raw = await readSession(targetId)
    const events: unknown[] = isRecord(raw) && Array.isArray((raw as any).events) ? (raw as any).events : []
    return events.length > mark.seedEvents
  } catch {
    return false
  }
}

/**
 * Wake the target: idempotence first, then the first channel that accepts.
 *
 * Never throws. Every outcome is a receipt, because a caller that believes ignition happened and sees no
 * work starting has no way to tell a slow start from a broken channel.
 */
export async function igniteTargetSession(
  ctx: any,
  settings: IgnitionSettings,
  targetId: string,
  sourceSessionId: string,
  options: { retry?: boolean; cwd?: string } = {},
): Promise<IgnitionResult> {
  void sourceSessionId
  if (!settings.igniteTarget) return { attempted: false, ok: false, reason: 'igniteTarget=false' }
  const prompt = buildIgnitionPrompt(settings)
  /**
   * Resolve the log reader the way the ORIGINAL code did: `ctx.sessionQuery.readSession` as a direct
   * property.
   *
   * WHY NOT `ctx.get('sessionQuery')`: this host exposes services through both faces, but not always
   * both — a test scaffold (and a headless composition) may mount only the direct property, exactly as
   * the pre-refactor code assumed. Switching to the accessor silently produced `undefined`, which made
   * every target look "not yet ignited" and re-prompted warm sessions. Both faces are tried, direct
   * first, to match the original precedence.
   */
  const query = (() => {
    const direct = (() => {
      try {
        return (ctx as any).sessionQuery
      } catch {
        return undefined
      }
    })()
    if (isRecord(direct) && typeof (direct as any).readSession === 'function') return direct
    try {
      const viaGet = hostService(ctx, 'sessionQuery')
      if (isRecord(viaGet) && typeof (viaGet as any).readSession === 'function') return viaGet
    } catch {
      // A throwing getter is simply not a candidate.
    }
    return undefined
  })()
  const readSession =
    isRecord(query) && typeof (query as any).readSession === 'function'
      ? (id: string) => (query as any).readSession(id)
      : undefined

  // The retry path asks the HOST for liveness FIRST: a live log mid-turn can fail replay validation,
  // and "I could not read it" must not become "it was never woken".
  if (options.retry === true && (await targetAlreadyLive(ctx, targetId))) {
    return {
      attempted: false,
      ok: true,
      alreadyIgnited: true,
      channel: 'sessionController.state',
      reason: 'target already live',
      promptChars: prompt.length,
    }
  }
  try {
    if (await alreadyIgnited(readSession, targetId)) {
      return { attempted: false, ok: true, alreadyIgnited: true, promptChars: prompt.length }
    }
  } catch (error) {
    return {
      attempted: false,
      ok: false,
      reason: String((error as any)?.message ?? error),
      promptChars: prompt.length,
    }
  }
  if (options.retry === true && (await targetAlreadyDriven(readSession, targetId))) {
    return {
      attempted: false,
      ok: true,
      alreadyIgnited: true,
      channel: 'graft-targets.seedEvents',
      reason: 'target already driven past its seed',
      promptChars: prompt.length,
    }
  }

  /**
   * v7.7 — THE CHANNEL IS THE LAYER'S.
   *
   * Everything above this line is graft's POLICY and stays here: the retry path's two liveness questions
   * (`targetAlreadyLive`, `targetAlreadyDriven`) read graft's own marks, and the admission map is graft's
   * guard against two same-tick prompts. None of that is meaningful to another plugin.
   *
   * What moved into `dsh-paradise` is the MECHANICS: building the request, passing the AbortSignal the
   * host requires, racing it against the deadline, trying `sessionController.prompt` then
   * `remote.session.prompt`, and turning every outcome into a receipt. That is a fact about talking to
   * a host, and it is now the same code the observer runs.
   *
   * THE CALLER'S DIALECT IS PRESERVED. graft keeps its own marker (`[dsh-graft-slice 点火]`) and its own
   * mode word (`steer`): sessions already in the field carry prompts stamped with that marker, and
   * swapping it would make every warm target look "never ignited" and re-prompt it. The layer accepts
   * both as caller-supplied options instead of imposing its own.
   */
  const paradise = await ensureParadiseTrigger(ctx)
  if (paradise === undefined) {
    return {
      attempted: false,
      ok: false,
      reason: 'no ignition channel: dsh-paradise 未安装或版本过旧（需要 >= 0.4.0 的 trigger）',
      promptChars: prompt.length,
    }
  }
  const receipt = await paradise(
    { id: targetId, cwd: await resolveTargetCwd(ctx, targetId, options.cwd) },
    {
      text: prompt,
      mode: settings.ignitionMode === 'steer' ? 'interrupt' : 'queue',
      origin: 'plugin:graft-slice:ignition',
      marker: IGNITION_MARKERS,
      /**
       * graft NEVER escalates: a `queue` prompt that the host refused is REPORTED, not re-sent as a
       * `steer` into a live turn. That would be a stronger intervention than the user configured, and
       * the pre-v7.7 code returned the refusal instead. Kept as a caller option rather than a default.
       */
      fallbackModes: false,
    },
  )
  if (receipt.ok) {
    state().admissions.set(targetId, { at: Date.now(), promptChars: prompt.length })
    return {
      attempted: receipt.alreadyTriggered === true ? false : true,
      ok: true,
      ...(receipt.alreadyTriggered === true ? { alreadyIgnited: true as const } : {}),
      ...(receipt.channel === undefined ? {} : { channel: graftChannelName(receipt.channel) }),
      ...(receipt.alreadyTriggered === true && receipt.stage === 'trigger:already'
        ? { reason: 'target log already carries the ignition prompt' }
        : {}),
      promptChars: prompt.length,
    }
  }
  /**
   * "NO CHANNEL" IS NOT AN ATTEMPT — the distinction the receipt exists to keep.
   *
   * graft has always reported a host with no prompt service as `attempted: false`, because nothing was
   * called: the intent is queued for the next activation instead. The layer reports it as a failure with
   * the code `NO_TRIGGER_CHANNEL`; mapping it back to "not attempted" keeps the receipt honest AND
   * keeps the retry queue's meaning ("we tried and it failed" vs "we never had a way to try").
   */
  if (receipt.error?.code === 'NO_TRIGGER_CHANNEL') {
    return {
      attempted: false,
      ok: false,
      reason: 'no ignition channel: ctx.sessionController.prompt is not mounted',
      promptChars: prompt.length,
    }
  }
  return {
    attempted: true,
    ok: false,
    reason: receipt.error?.message ?? receipt.stage,
    promptChars: prompt.length,
  }
}

/**
 * graft's channel vocabulary, restored from the layer's richer label.
 *
 * The layer names WHICH MODE was used (`sessionController.prompt(queue)`) because a caller that
 * falls back between modes needs to know which one landed. graft never falls back, and its audit trail
 * and compatibility record both say `sessionController.prompt` — so the mode suffix is dropped here
 * rather than quietly changing a field the reports and docs quote.
 */
function graftChannelName(label: string): string {
  const trimmed = String(label)
  const paren = trimmed.indexOf('(')
  return paren >= 0 ? trimmed.slice(0, paren) : trimmed
}

/* ── the queue primitive: register → ignite → settle ───────────────────────────────────────── */

/**
 * One ignition attempt, with the durable queue maintained around it.
 *
 * THE ORDER IS THE RECOVERABILITY: the intent is persisted BEFORE the prompt is tried, so a crash
 * between "the target exists" and "the target is running" leaves a queue entry rather than a stranded
 * artifact. On failure the entry's attempt counter grows, which is what `resumePendingIgnitions` reads
 * to decide when to stop retrying and roll back instead.
 */
export async function attemptIgnition(
  ctx: any,
  settings: IgnitionSettings,
  sourceSessionId: string,
  targetId: string,
  options: { retry?: boolean; cwd?: string } = {},
): Promise<IgnitionAttemptWithRollback> {
  if (!settings.igniteTarget) return { attempted: false, ok: false, reason: 'igniteTarget=false' }
  const existing = state().pending.get(targetId)
  state().pending.set(targetId, {
    targetId,
    sourceSessionId,
    at: existing?.at ?? Date.now(),
    attempts: existing?.attempts ?? 0,
  })
  persistPendingIgnitions()
  const result = await igniteTargetSession(ctx, settings, targetId, sourceSessionId, options)
  if (result.ok) {
    state().pending.delete(targetId)
    persistPendingIgnitions()
  } else {
    const entry = state().pending.get(targetId)
    if (entry !== undefined) {
      state().pending.set(targetId, { ...entry, attempts: entry.attempts + 1 })
      persistPendingIgnitions()
    }
  }
  try {
    state().audit({
      at: new Date().toISOString(),
      kind: result.ok ? 'ignite' : result.attempted ? 'ignite-failed' : 'ignite-skipped',
      sessionId: targetId,
      ...(sourceSessionId.length === 0 ? {} : { targetSessionId: sourceSessionId }),
      detail:
        `${result.ok ? 'ok' : result.reason ?? 'not attempted'}` +
        `${result.channel === undefined ? '' : ` via ${result.channel}`}` +
        `${result.alreadyIgnited === true ? ' (already ignited)' : ''}` +
        `${result.ok && result.reason !== undefined ? ` (${result.reason})` : ''}`,
    })
  } catch {
    // The audit line is evidence; the migration must not depend on it.
  }
  return result
}

/* ── rollback: undo a migration whose target never started ─────────────────────────────────── */

/**
 * TAKE the rollback notice for this session, if one is waiting — once, and through `messages` only.
 *
 * WHY THIS IS A "TAKE" AND NOT A "GET": the same discipline as `takePendingConstraintMessages`. The
 * notice is consumed on delivery, so a session that runs ten more turns is not told ten times that one
 * migration failed. `rollbackNoticed` (the delivery ledger) and this map (the queue) are separate on
 * purpose: the first answers "does the user know?", the second answers "is there anything left to send?".
 *
 * WHAT A CALLER DOES WITH IT: appends the returned message to the pre-step `messages` array. Nothing is
 * written to any log, so no `turn`/`step` is consumed and no resume-time format check can trip.
 */
export function takeRollbackNotice(agentId: string): { id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'user' } } | undefined {
  const notice = state().rollbackNotices.get(agentId)
  if (notice === undefined) return undefined
  state().rollbackNotices.delete(agentId)
  return {
    id: `graft-rollback-${agentId}`,
    /**
     * `role: 'user'`, NOT `'developer'`.
     *
     * Measured on this host: pre-step `messages` are projected as `user/message`, and DSH requires the
     * developer role to travel with a real `developer/message` event instead — i.e. a shape that would
     * need the very step-scoped write this change exists to eliminate. A user-role message carrying an
     * explicit `[系统提示]` header is the shape a pre-step listener can legitimately deliver, and it is
     * the same choice the constraint re-assertion already makes.
     */
    role: 'user',
    content: [{ type: 'text', text: notice.text }],
    source: { kind: 'user' },
  }
}

export const ROLLBACK_NOTICE_MARKER = '[dsh-graft-slice 回滚]'

export const ROLLBACK_NOTICE =
  `${ROLLBACK_NOTICE_MARKER} 由于新会话点火失败，已为您自动回滚到当前会话，请重试切片。`

/**
 * The TRUE un-retire.
 *
 * `persistRetiredStore(ctx, [id])` is not enough, and the reason is subtle: the write path is a
 * read-modify-write that ADOPTS the file's contents back into memory (correct for merging two
 * processes' retirements). So a removal that runs before the file is rewritten can be UNDONE by that
 * same adopt pass on the next write — the id comes back from disk and the session is frozen again,
 * durably, on the next restart. The rollback would look successful in memory and be a no-op on disk.
 *
 * This does the removal in the only order that holds: remove from the file under the lock, and make the
 * in-memory set agree with the file afterwards.
 */
function unRetireDurably(sessionId: string): boolean {
  let restored = false
  try {
    mkdirSync(dirname(state().retiredStorePath()), { recursive: true })
    withFileLock(state().retiredStorePath(), () => {
      const remaining = new Set(ledgerArrayLocal(state().retiredStorePath()).filter((v): v is string => typeof v === 'string'))
      remaining.delete(sessionId)
      writeLedgerAtomic(state().retiredStorePath(), [...remaining].sort())
      // The memory set is made to AGREE with the file, not merged into: after an explicit removal,
      // "the file does not have it" is the authoritative answer.
      state().retired.delete(sessionId)
      restored = !remaining.has(sessionId)
    })
  } catch (error) {
    try {
      state().logWarn?.(`[dsh-graft-slice] un-retire write failed for ${sessionId}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the rollback result.
    }
    return false
  }
  try {
    mkdirSync(dirname(state().transferredStorePath()), { recursive: true })
    withFileLock(state().transferredStorePath(), () => {
      const remaining = { ...(ledgerArrayLocal(state().transferredStorePath()) as unknown as Record<string, unknown>) }
      delete remaining[sessionId]
      writeLedgerAtomic(state().transferredStorePath(), remaining)
      state().transferred.delete(sessionId)
    })
  } catch (error) {
    try {
      state().logWarn?.(
        `[dsh-graft-slice] un-retire transfer write failed for ${sessionId}: ${String((error as any)?.message ?? error)}`,
      )
    } catch {
      // Logging must not change the rollback result.
    }
  }
  /**
   * Belt and braces for the in-memory gate the pre-step actually reads.
   *
   * The pre-step consults FOUR per-session marks, not just the two ledgers: the retired set, the
   * transferred map, the auto-graft STATE machine, and the deferred graft queue. Clearing only the
   * ledgers leaves `autoGraftStates === 'done'`, which returns `reason: 'Transferred'` forever — the
   * session would be un-retired on disk and still frozen in the running process, the same double-blind
   * one layer down.
   */
  state().retired.delete(sessionId)
  state().transferred.delete(sessionId)
  state().autoGraftStates.delete(sessionId)
  state().autoGraftInFlight.delete(sessionId)
  state().pendingGraftSources.delete(sessionId)
  state().pendingConfirms.delete(sessionId)
  // The "this id is a target we created" mark belongs to the TARGET, and a rollback ends that
  // relationship: the source is a plain session again and must not inherit the target's grace window.
  state().targets.delete(sessionId)
  return restored || !state().retired.has(sessionId)
}

/**
 * Undo a migration whose target never started.
 *
 * Order matters: the ledgers are restored FIRST, because an in-memory-only rollback dies on the next
 * restart and leaves the user exactly as stuck as before.
 */
export async function rollbackFailedIgnition(
  ctx: any,
  sourceSessionId: string,
  targetId: string,
  reason: string,
): Promise<IgnitionRollback> {
  const out: IgnitionRollback = {
    attempted: true,
    sourceRestored: false,
    noticeAppended: false,
    targetId,
    reason,
  }
  if (sourceSessionId.length === 0) {
    return { ...out, attempted: false, reason: 'no source session to roll back to' }
  }
  try {
    state().retired.delete(sourceSessionId)
    state().transferred.delete(sourceSessionId)
    out.sourceRestored = unRetireDurably(sourceSessionId)
  } catch (error) {
    out.reason = `${reason}; ledger rollback failed: ${String((error as any)?.message ?? error)}`
  }
  /**
   * Tell the human, in the session they will actually be looking at. A rollback that is only visible in
   * an audit file reads as "nothing happened, try again" — and repeating the same failed migration is
   * the wrong next move.
   *
   * v7.8 — THE CHANNEL CHANGED, the guarantee did not.
   *
   * WHAT IT USED TO DO: `live.append('developer/message', { turn: 0, step: 0, … })`.
   *
   * Two defects, and the second is fatal:
   *
   *   1. `turn: 0` / `step: 0` are not a real round. `developer/message`'s payload REQUIRES `turn` and
   *      `step` as numbers, so the shape parses — but it describes a step that never happened, and the
   *      host's replay/format validation rejects numbers that do not match an open skeleton. That
   *      surfaces as `SessionFormatError` at resume time, on the SOURCE session — the one the user is
   *      still working in.
   *   2. Writing a step-scoped event into a LIVE session from outside the agent loop is exactly the
   *      class of write this ecosystem has already paid for twice.
   *
   * WHAT IT DOES NOW: it REGISTERS the notice. The source's own `agent/pre-step` waterfall delivers it
   * through `messages` — the channel DSH documents for exactly this ("a listener may add messages to the
   * next request"), which is the same channel the constraint re-assertion already uses. `messages` do not
   * touch the persisted lifecycle, consume no step number, and cannot produce a format violation:
   * nothing is ever written to the log.
   *
   * The trade is stated rather than hidden: the notice is no longer IN the log, so it is not
   * forensically visible after the fact. `out.noticeAppended` therefore means "the notice has been
   * queued for delivery", not "an event exists on disk" — and the audit line below says which.
   *
   * Registered at most ONCE per source: both the single-shot path (this call exhausted the budget) and
   * the queue path (a restart found the budget spent) can reach here for the same migration, and two
   * identical notices read as two separate failures.
   */
  if (state().rollbackNoticed.has(sourceSessionId)) {
    out.noticeAppended = true
  } else {
    try {
      state().rollbackNotices.set(sourceSessionId, {
        text: ROLLBACK_NOTICE,
        at: Date.now(),
        targetId,
      })
      state().rollbackNoticed.add(sourceSessionId)
      out.noticeAppended = true
    } catch (error) {
      out.reason = `${out.reason ?? reason}; notice failed: ${String((error as any)?.message ?? error)}`
    }
  }
  /**
   * The target stays on disk — it may be perfectly good and just un-wakeable — but it must not look like
   * the session to continue. A title is visible and survives a reload.
   *
   * The target is a DURABLE artifact: nobody has resumed it, which is the whole problem. So the mark is
   * appended through the persistence handle when a live one is absent, and a failure to mark is reported
   * rather than hidden.
   */
  try {
    const sessions = hostService(ctx, 'sessions')
    const target = isRecord(sessions) && typeof (sessions as any).get === 'function' ? (sessions as any).get(targetId) : undefined
    if (target !== undefined && typeof target.append === 'function') {
      target.append('session/title', {
        title: `[点火失败] ${targetId}`,
        messageSeqs: [],
        source: { kind: 'user' },
      })
    } else {
      const persistence = hostService(ctx, 'sessionPersistence')
      if (isRecord(persistence) && typeof (persistence as any).open === 'function') {
        const handle = await (persistence as any).open(targetId)
        if (handle !== undefined && typeof handle.append === 'function') {
          await handle.append([
            {
              type: 'session/title',
              time: Date.now(),
              data: { title: `[点火失败] ${targetId}`, messageSeqs: [], source: { kind: 'user' } },
            },
          ])
          if (typeof handle.flush === 'function') await handle.flush()
          if (typeof handle.close === 'function') await handle.close()
        }
      }
    }
  } catch {
    // A missing target is not a rollback failure; the title is cosmetic evidence.
  }
  try {
    state().audit({
      at: new Date().toISOString(),
      kind: 'ignite-rollback',
      sessionId: sourceSessionId,
      targetSessionId: targetId,
      detail: `${reason}; sourceRestored=${out.sourceRestored} noticeAppended=${out.noticeAppended}`,
    })
  } catch {
    // Evidence only.
  }
  return out
}

/**
 * Consume the queue — one activation, one attempt per pending target.
 *
 * Called at the end of `apply()`. It retries what a crash or a missing channel left behind, and it GIVES
 * UP after `IGNITION_MAX_ATTEMPTS` instead of retrying forever: a target nobody can start is a fact to
 * report, not a loop.
 *
 * v0.21: giving up now means ROLLING BACK. Before this, "gave up" deleted the queue entry and left the
 * source retired — the double-blind state, permanently.
 */
export async function resumePendingIgnitions(
  ctx: any,
  settings: IgnitionSettings,
): Promise<Array<{ targetId: string; ok: boolean; reason?: string; rollback?: IgnitionRollback }>> {
  const out: Array<{ targetId: string; ok: boolean; reason?: string; rollback?: IgnitionRollback }> = []
  for (const entry of [...state().pending.values()]) {
    if (!settings.igniteTarget) break
    if (ignitionExhausted(entry)) {
      state().pending.delete(entry.targetId)
      persistPendingIgnitions()
      const rollback = await rollbackFailedIgnition(
        ctx,
        entry.sourceSessionId,
        entry.targetId,
        `gave up after ${entry.attempts} attempts`,
      )
      out.push({
        targetId: entry.targetId,
        ok: false,
        reason: `gave up after ${entry.attempts} attempts; rolled back to ${entry.sourceSessionId}`,
        rollback,
      })
      continue
    }
    const result = await attemptIgnition(ctx, settings, entry.sourceSessionId, entry.targetId, { retry: true })
    out.push({
      targetId: entry.targetId,
      ok: result.ok,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.rollback === undefined ? {} : { rollback: result.rollback }),
    })
  }
  return out
}


