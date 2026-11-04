/**
 * dsh-graft-slice — log slicing and minimal injection for DeepSeek Harness.
 *
 * Spec source: 《日志切片与最小注入规格书 v2.1》
 * Runtime target verified against: DSH 0.2.1-rc.5 (the installed desktop build).
 *
 * Two v2.1 corrections are deliberate and are explained at their call sites:
 *
 *   1. Skeleton numbering.  v2.1 says turn/start {turn:0} and step/start
 *      {turn:0,step:0}.  DSH's released v4 relationship validator starts at 1
 *      and rejects 0 with "turn/start does not open the expected turn".  The
 *      default is therefore 1/1 (configurable, but 0 only works on a harness
 *      whose validator starts at 0).
 *
 *   2. Creation and flush.  v2.1 says ctx.sessions.create() then
 *      ctx.sessions.flush().  create() publishes a *live* session; after the
 *      tool returns, a later agents.resume() calls sessions.prepare() and fails
 *      with `session "<id>" already exists`; sessions.flush() also rejects a
 *      detached session.  The durable cold-handoff path is the same path
 *      AgentLoop.create() uses: sessions.prepare() (zero inherited events) +
 *      sessionPersistence.create() + handle.append() + handle.flush() +
 *      handle.close().  No fork is ever used.
 *
 * Phase mapping follows the spec sections in the comments below.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'dsh-graft-slice'

/**
 * Hard service dependencies. sessionPersistence is required for a durable
 * handoff: a bare ctx.sessions.create session is not persisted in rc.5.
 */
export const inject = ['tools', 'sessions', 'sessionQuery', 'sessionPersistence']

// ===========================================================================
// Public types
// ===========================================================================

/** Per-row configuration. All fields are optional; defaults are conservative. */
export interface GraftConfig {
  /** Number of trailing turns kept verbatim. Default 5 (used only when adaptiveDepth is off). */
  recentTurns?: number
  /**
   * v6.3: choose the retained-turn count from the source's own shape.
   * Debug-heavy sessions keep more verbatim turns; prose-heavy ones keep fewer
   * so the target has room to generate. Default true.
   */
  adaptiveDepth?: boolean
  /** Lower bound for adaptive depth. Default 3. */
  adaptiveDepthMin?: number
  /** Upper bound for adaptive depth. Default 8. */
  adaptiveDepthMax?: number
  /** Maximum characters kept for one recent turn; 0 disables the cap. Default 0. */
  maxTurnChars?: number
  /** Maximum characters kept across all tape chunks; 0 disables the cap. Default 0. */
  maxTotalChars?: number
  /** Maximum characters per older-turn summary. Default 600. */
  oldTurnSummaryChars?: number
  /** Add the source session to the in-memory retired set on success. Default true. */
  retireSource?: boolean
  /** Re-read the new session through sessionQuery and validate it. Default true. */
  verifyReadBack?: boolean
  /** Skeleton turn number. Default 1 (DSH 0.2.1-rc.5 requires 1). */
  skeletonTurn?: number
  /** Skeleton step number. Default 1 (DSH 0.2.1-rc.5 requires 1). */
  skeletonStep?: number
  /** v4.0: automatically graft when the turn-stopping token watermark is reached. */
  autoGraft?: boolean
  /** v4.0: watermark ratio, default 0.75. */
  autoGraftAtRatio?: number
  /**
   * v7.6 (Model-Driven): let the MODEL decide to hand over before the system does.
   *
   * At `modelDrivenGraftAtRatio` (default 0.70) pre-step injects ONE quiet nudge
   * per turn, leaving a 5% safety margin: the model can finish the sentence or
   * tool call it is in, then call `graft_prepare` / `graft_slice_and_inject`
   * itself. The system still force-grafts at `autoGraftAtRatio` (default 0.75)
   * when the model ignores the nudge — the hard cutoff stays the fallback.
   *
   * Default true: a forced kill mid-thought is the failure mode this removes.
   */
  modelDrivenGraft?: boolean
  /**
   * v7.6: nudge watermark, default 0.70.
   *
   * Keep it strictly below `autoGraftAtRatio`; the gap is the model's safety
   * margin. A value at/above the hard cutoff leaves no window and the nudge can
   * never fire (no clamping: silent correction would hide the misconfiguration).
   */
  modelDrivenGraftAtRatio?: number
  /** v4.0: fallback context window when request/context does not publish one. */
  contextWindowTokens?: number
  /** v4.0: target-id prefix for automatically generated sessions. */
  autoGraftIdPrefix?: string
  /** Optional test allowlist; empty means all sessions. */
  autoGraftSessionIds?: string[]
  /**
   * v0.13 GUARD: inject the workspace boundary (see `workspaceRedline`).
   *
   * Default true. A migrated target is handed ONE working directory; without an
   * explicit boundary, "the file is not here" turns into an unbounded widening
   * search — the profile directory, AppData, the drive roots — and a confident
   * summary of a filesystem that was only listed. The red line travels in both the
   * migration system prompt and the durable goal user/message.
   *
   * It is a switch only so a differential test can prove the guard is what
   * changed the behaviour. Localization tests and log diffs will notice it.
   */
  workspaceRedline?: boolean
  /**
   * v0.14 GUARD: intercept command execution at the TOOL layer.
   *
   * Default true. A red line in the prompt is a request; a tool guard is a
   * refusal. Measured live: a session that could not find a file widened the
   * search to the drive roots regardless of what the prompt said, because the
   * prompt is advisory and the tool layer is not. The guard denies before
   * dispatch (via `ctx.tools.guard`), so the command never runs.
   *
   * Denied: root-wide searches (`rg /`, `Get-ChildItem C:\ -Recurse`, anything
   * aimed at AppData / the user profile / a drive root) and recursive deletion
   * that escapes the session workspace or names a system root. Confined work —
   * a search inside the workspace, a recursive delete of a build directory — is
   * untouched: a guard that blocks ordinary work gets switched off.
   */
  commandGuard?: boolean
  /**
   * v0.18: which DECISION TABLE the command policy uses. Default `balanced`.
   *
   *   strict      unknown and destructive are refused outright
   *   balanced    destructive refused; unknown (a mutating verb we cannot place) refused
   *   autonomous  unknown allowed; destructive still ASKS rather than running silently
   *
   * The mode changes no classifier — only what the operator wants done about a
   * given risk, which is the whole point of separating the two.
   */
  safetyMode?: SafetyMode
  /**
   * v0.18: where the migration thresholds come from. Default `dynamic`.
   *
   * `fixed` uses `modelDrivenGraftAtRatio` / `autoGraftAtRatio` verbatim (the old
   * behaviour, kept for a differential test). `dynamic` derives them from the
   * window and the estimated cost of the handoff itself — see
   * `calculateSafeWatermark`. Migrating at 90% of a window that a graft needs 12%
   * of is not "late", it is impossible.
   */
  watermarkMode?: 'fixed' | 'dynamic'
  /** v0.18: measured turns used to predict growth. Default 6. */
  growthSampleTurns?: number
  /** v0.18: how many turns of growth headroom `dynamic` reserves. Default 2. */
  growthReserveTurns?: number
  /**
   * v0.18: tokens a completed turn adds, used by the growth prediction.
   *
   * Default 1200 (measured on this project: a turn with two tool calls and their
   * results). The figure is a RATE, not a measurement of this session, because a
   * session near its ceiling has no cheap way to prove its own future slope —
   * the honest move is to name the assumption and let the operator correct it.
   */
  growthTokensPerTurn?: number
  /**
   * v0.18: total characters the HARD CONSTRAINTS block may occupy. Default 8000.
   *
   * The block is a hard-preservation contract: if the qualified rules do not fit
   * here, the migration ABORTS (`GRAFT_ABORTED`) instead of shipping a shortened
   * rule set. Raising this is the operator's way of saying "this task has more
   * standing rules than a default task".
   */
  constraintBudgetChars?: number
  /**
   * v0.19: PHYSICAL IGNITION. Default true.
   *
   * After the target is durable (`flush()`) and the retirement transaction has
   * committed, call `sessionController.prompt(...)` once so the new session starts
   * working on its own. Off exists for the differential test and for an operator
   * who wants to inspect a target before it runs.
   */
  igniteTarget?: boolean
  /** v0.19: how the ignition prompt is admitted. Default `queue`. */
  ignitionMode?: 'queue' | 'steer'
  /** v0.19: custom ignition text; the marker is prepended when it is missing. */
  ignitionPrompt?: string
  /**
   * v0.14: where `dsh-memory` keeps its store, read-only, for the debug panel.
   *
   * The two plugins never import each other; the panel simply reads the same
   * files the memory plugin writes. Empty = `<state dir>/.dsh-memory`.
   */
  memoryDir?: string
  /** v0.14: where SKILL.md files live. Empty = `~/.agents/skills`. */
  skillsDir?: string
  /**
   * v6.3: 'silent' migrates immediately at the watermark (default).
   * 'confirm' asks the user first and only migrates after they agree.
   */
  graftMode?: 'silent' | 'confirm'
  /** v6.3: how long a confirm prompt stays valid. Default 10 minutes. */
  confirmTtlMs?: number
  /** Test/diagnostic: keep the host event loop alive briefly after an auto turn. Default 0. */
  autoGraftKeepAliveMs?: number
  /**
   * v7.0 C2: completed turns a freshly created target is immune to auto-graft.
   *
   * Default 2. A target seeded with a large tape can already sit above
   * `autoGraftAtRatio` on its very first request, which would graft it again
   * before the user types anything — and repeat indefinitely. Zero disables the
   * guard (not recommended).
   */
  graftTargetGraceTurns?: number
  /**
   * v7.3: how many times a graft may be postponed waiting for a task boundary.
   *
   * Default 1. The probe defers when the model left todos open or the last tool
   * call failed — cutting there hands the target a half-finished task. The wait
   * is capped because a permanently red test must not pin the session forever;
   * zero disables the probe entirely.
   */
  taskBoundaryMaxDeferTurns?: number
  /**
   * v7.4 (decision 2): let the TASK STATE, not just the conversation shape, pick
   * the replay tier. Off by default.
   *
   * Measured on this project: a target that replays 1 turn reaches `plugin_manager`
   * in 3 calls and finishes in 9 steps, while a zero-replay target spends 19 file
   * reads rediscovering *how* to verify and finishes in 42. The difference is
   * whether the last turn's method is visible.
   *
   * So when the work is visibly unfinished — an open todo, or a failed last call —
   * one turn is worth its cost. When the work is at a clean stopping point, zero
   * replay is cheaper and the read-back index still holds every pointer.
   *
   * Default `false` because the rule is supported by ONE paired observation
   * (n=1), not a distribution. An operator opts in; the plugin does not decide on
   * that little evidence.
   */
  autoAdaptiveTier?: boolean
  /**
   * v7.4 P4-3: announce persisted, cold FORK sessions to the client sidebar.
   *
   * A fork is written by `sessions.fork` and is never published, so the host's
   * `session/created` -> `api-session/added` path never fires for it. The
   * session is loadable and resumable but invisible, which reads to the user as
   * "my sample disappeared". Default true: the announcement is idempotent and
   * only covers sessions the plugin did not create itself.
   */
  registerArchivedForks?: boolean
  /**
   * Explicit directory for the plugin's own state files.
   *
   * The desktop host does NOT export DSH_PROFILE_DIR/DSH_HOME to the Electron
   * main process — those exist only inside the tool sandbox. Guessing a profile
   * from the environment therefore silently falls back to the plugin directory,
   * which every profile shares. Set this per profile in cordis.patch.yml.
   */
  dataDir?: string
  /** Optional provider/model for the one-shot LLM constraint extractor. */
  constraintProvider?: string
  constraintModel?: string
}

/** Producer-owned message source. Falls back to the legal `plugin:graft` namespace. */
export interface GraftSource {
  kind: string
  provider?: string
  model?: string
}

/**
 * v7.0 P5: the mark that stops a replay from being replayed.
 *
 * The generational-pollution failure this prevents:
 *
 * A graft copies the source's user messages into the target as a new
 * `user/message`. On its face that is what "preserve the user's own words"
 * means. But the copy is now indistinguishable from a real user turn — and the
 * target can itself be grafted later. Generation 2 reads the target's log,
 * finds those messages, and replays them as "what the user said". Generation 3
 * repeats it. The tape is no longer a record of the conversation; it is a record
 * of our own previous recordings, with the assistant's narration slowly
 * outvoting the user's actual words.
 *
 * A marker fixes it because our replays are the only messages that carry it,
 * and the extractor can then state the rule plainly: a message we authored is
 * never evidence of what the user said.
 *
 * `plugin:<name>` is the namespace this project already uses for synthetic
 * producers (`extractSourceTemplate` refuses a bare `plugin` and accepts
 * `plugin:graft`). Reusing it keeps one convention instead of two.
 */
export const GRAFT_REPLAY_SOURCE_KIND = 'plugin:graft-replay'

/** Whether a message source was written by this plugin's replay injector. */
export function isGraftAuthored(source: unknown): boolean {
  if (!isRecord(source)) return false
  const kind = source.kind
  if (typeof kind !== 'string') return false
  return kind === GRAFT_REPLAY_SOURCE_KIND || kind.startsWith('plugin:graft')
}

/**
 * v7.4b (硬约束 8): a message the HUMAN actually typed.
 *
 * `role: "user"` is not evidence of a human. The standing-constraint
 * re-assertion, the skill catalog, the time stamp and the runtime snapshot all
 * arrive with that role; the plugin's own replays do too. The only strict test
 * is the source kind, so exactly one value qualifies. Everything else is an
 * injection and must never be read as an instruction.
 */
export function isHumanAuthored(source: unknown): boolean {
  return isRecord(source) && source.kind === 'user'
}

/**
 * One tape turn after extraction.
 *
 * v7.0: a turn is now a *replay script*, not a prose blob. `text` remains the
 * rendered legacy form (kept for older callers and for the pending-state
 * builder), while `replay` carries the structured user → assistant → pointer
 * flow the target actually re-reads.
 */
export interface GraftTapeTurn {
  turn: number
  text: string
  assistantMessages: number
  pointers: number
  firstSeq: number
  lastSeq: number
  /** v7.0: verbatim user messages that opened this turn, newest last. */
  userTexts?: string[]
  /** v7.0: assistant text for this turn, already pointer-annotated. */
  assistantText?: string
  /** v7.0: rendered replay block; falls back to `text` when absent. */
  replay?: string
}

/** Result of phase one. */
export interface GraftBoundary {
  boundarySeq: number
  lastTurn: number
  turnCount: number
  lastTurnReason: string
}

/** Result of phase two, before chunk budgeting. */
export interface GraftTape {
  boundary: GraftBoundary
  sourceTemplate: GraftSource
  turns: GraftTapeTurn[]
  goal: string
  goalSource: 'user' | 'fallback-user' | 'assistant' | 'placeholder'
  phase: string
  pendingStateText: string
  pointerCount: number
  /** v0.19: the semantic state the instruction card was built from (evidence). */
  semantic?: SemanticState
  /** v7.0 P5: replays found in the source log and refused (present only when > 0). */
  replayedMessagesSkipped?: number
}

/** One assistant message to inject. */
export interface GraftInjectionChunk {
  kind:
    | 'old-summary'
    | 'recent-turn'
    | 'pending-state'
    | 'task-status'
    | 'subagent-reports'
    | 'workspace-files'
    | 'open-turn-carryover'
    | 'omitted-turns'
    | 'readback-index'
    | 'open-work'
    | 'phase-roadmap'
  text: string
  turn?: number
  truncated: boolean
}

/** Fully validated, ready-to-write injection plan. */
export interface GraftPlan {
  cwd: string
  boundary: GraftBoundary
  sourceTemplate: GraftSource
  goal: string
  goalSource: GraftTape['goalSource']
  phase: string
  chunks: GraftInjectionChunk[]
  /** The window depth the slice chose (intended replays). */
  recentTurnCount: number
  /** How many of those replays survived the per-turn budget (v7.0). */
  recentInjectedCount: number
  olderTurnCount: number
  /** v6.3: the depth actually used, and why. */
  adaptiveDepth: { depth: number; mode: 'debug' | 'generation' | 'balanced'; reason: string }
  /**
   * v7.4 (decision 2): present only when `autoAdaptiveTier` picked the depth.
   *
   * Its presence is the signal: when absent, `adaptiveDepth` (or the configured
   * `recentTurns`) decided, and the operator should not read a task-state rule into
   * the number.
   */
  adaptiveTier?: { tier: 'A' | 'B'; depth: number; reason: string }
  /** v6.4: files the source actually wrote or edited, newest first. */
  workspaceFiles: WorkspaceFile[]
  pointerCount: number
  olderPointerCount: number
  olderToolNames: string[]
  constraints: string[]
  constraintSource: 'llm' | 'regex-fallback'
  /**
   * v0.18: proof that the rule set travels WHOLE.
   *
   * A returned plan always has `dropped: 0` — a rule that does not fit the
   * capacity aborts the build (`GRAFT_ABORTED`), so this field is the positive
   * evidence that "every qualified constraint survived", rather than something a
   * reader has to infer from the absence of an exception upstream.
   */
  constraintIntegrity: {
    budgetChars: number
    totalChars: number
    kept: number
    candidateCount: number
    dropped: number
    /**
     * v0.23: rules preserved on the handoff but NOT spent in the prompt.
     *
     * Reported separately so "the prompt got smaller" can never be confused with "a
     * rule was thrown away". `dropped` remains the only field that means loss.
     */
    archived: number
  }
  /**
   * v0.14: how many migrations deep this target is (1 = a direct child of a
   * first-generation source). Injected into the target so the model can SEE that
   * it is itself a migration product, and used by the chain guard to refuse a
   * re-graft during the first `graftTargetGraceTurns` completed turns.
   */
  generation: number
  taskStatus: string[]
  subagentReports: string[]
  /** v7.0 B1: work the still-open turn already finished, as pointers. */
  openTurnCarryover?: OpenTurnCarryover
  totalTapeChars: number
  warnings: string[]
}

/** Tool result for graft_slice_and_inject. */
export interface GraftReport {
  ok: true
  sourceSessionId: string
  newSessionId: string
  cwd: string
  boundarySeq: number
  sourceEventCount: number
  /** v7.0: the goal actually injected, so callers can reuse it (e.g. sidebar titles). */
  goal: string
  goalSource: GraftTape['goalSource']
  turns: number
  recentTurnCount: number
  /** v7.0: replays that actually made it into the tape (window minus drops). */
  recentInjectedCount: number
  olderTurnCount: number
  /** v6.3: the retained-turn depth chosen for this slice, and why. */
  adaptiveDepth: { depth: number; mode: 'debug' | 'generation' | 'balanced'; reason: string }
  injected: {
    system: number
    goal: number
    title: number
    oldSummary: number
    taskStatus: number
    subagentReports: number
    tape: number
    pending: number
    /** v7.0: the remaining block kinds, so parts always sum to `total`. */
    workspaceFiles: number
    openTurn: number
    omittedTurns: number
    readback: number
    total: number
  }
  pointers: {
    total: number
    recent: number
    older: number
    olderToolNames: string[]
  }
  constraints: string[]
  constraintSource: 'llm' | 'regex-fallback'
  /**
   * v0.19: whether the created target was STARTED, and through which channel.
   *
   * A migration that produces a session nobody wakes has not finished the job the
   * user asked for, so the outcome is part of the report rather than a log line.
   */
  ignition?: IgnitionResult
  /** v0.14 D2: how many migrations deep the created target is (1 = first hop). */
  generation: number
  workspace: {
    attached: boolean
    id: string | null
  }
  eventSeqRange: {
    first: number
    last: number
  }
  sourceTemplate: GraftSource
  skeleton: {
    turn: number
    step: number
    closed: boolean
  }
  durability: {
    attached: boolean
    appended: number
    barrier: 'sessionPersistence.handle.flush'
    verified: boolean
  }
  retired: {
    source: boolean
  }
  warnings: string[]
}

/** Tool result for graft_read_result. */
export interface GraftReadResult {
  found: boolean
  seq: number
  text: string | null
  truncated: boolean
  totalChars: number
  /** Present when the caller asked for a numbered line range. */
  lineRange?: { start: number; end: number; totalLines: number }
  /**
   * v7.4 P1-1: the author of a `user/message` payload.
   *
   * `'user'` is a human. Anything else (`plugin:graft-replay`, `runtime-context`,
   * `time-context`, `skill-catalog`, `tool-jobs`, …) is machinery, and a reader
   * must not treat it as an instruction from the user.
   */
  sourceKind?: string
}

// ===========================================================================
// Small helpers
// ===========================================================================

export function graftError(code: string, message: string): Error & { code: string } {
  const error = new Error(`[${code}] ${message}`) as Error & { code: string }
  error.name = 'GraftError'
  error.code = code
  return error
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw graftError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value
}

function asSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw graftError('INVALID_ARGUMENT', `${field} must be a non-negative safe integer`)
  }
  return value
}

function asFiniteInteger(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw graftError('INVALID_CONFIG', `${field} must be a finite number`)
  }
  return Math.max(0, Math.trunc(value))
}

/**
 * v7.4: exported so a test can assert on DEFAULTS directly.
 *
 * The defaults are the plugin's public contract (an operator reads the README to
 * learn what happens when a field is omitted), so they should be testable without
 * constructing a whole migration.
 */
export function normalizeConfig(config: GraftConfig | undefined): Required<GraftConfig> {
  const input = isRecord(config) ? config : {}
  return {
    recentTurns: asFiniteInteger(input.recentTurns, 5, 'recentTurns'),
    adaptiveDepth: input.adaptiveDepth === undefined ? true : input.adaptiveDepth === true,
    adaptiveDepthMin: asFiniteInteger(input.adaptiveDepthMin, 3, 'adaptiveDepthMin'),
    adaptiveDepthMax: asFiniteInteger(input.adaptiveDepthMax, 8, 'adaptiveDepthMax'),
    graftMode: input.graftMode === 'confirm' ? 'confirm' : 'silent',
    confirmTtlMs: asFiniteInteger(input.confirmTtlMs, 600_000, 'confirmTtlMs'),
    maxTurnChars: asFiniteInteger(input.maxTurnChars, 0, 'maxTurnChars'),
    maxTotalChars: asFiniteInteger(input.maxTotalChars, 0, 'maxTotalChars'),
    oldTurnSummaryChars: asFiniteInteger(input.oldTurnSummaryChars, 600, 'oldTurnSummaryChars'),
    retireSource: input.retireSource === undefined ? true : input.retireSource === true,
    verifyReadBack: input.verifyReadBack === undefined ? true : input.verifyReadBack === true,
    skeletonTurn: asFiniteInteger(input.skeletonTurn, 1, 'skeletonTurn'),
    skeletonStep: asFiniteInteger(input.skeletonStep, 1, 'skeletonStep'),
    autoGraft: input.autoGraft === true,
    autoGraftAtRatio: asRatio(input.autoGraftAtRatio, 0.75, 'autoGraftAtRatio'),
    // v7.6: on by default. 70% leaves the model a 5% margin to close what it is
    // writing; the 75% hard cutoff remains the fallback for an ignored nudge.
    modelDrivenGraft: input.modelDrivenGraft === undefined ? true : input.modelDrivenGraft === true,
    modelDrivenGraftAtRatio: asRatio(input.modelDrivenGraftAtRatio, 0.7, 'modelDrivenGraftAtRatio'),
    // v0.13 GUARD: on unless explicitly disabled. The boundary is not a tuning
    // knob; "off" exists so a differential test can prove what changed.
    workspaceRedline: input.workspaceRedline === undefined ? true : input.workspaceRedline === true,
    // v0.14 GUARD: on unless explicitly disabled. Like the red line, "off" exists
    // for a differential test, not for tuning.
    commandGuard: input.commandGuard === undefined ? true : input.commandGuard === true,
    safetyMode:
      input.safetyMode === 'strict' || input.safetyMode === 'autonomous' ? input.safetyMode : 'balanced',
    watermarkMode: input.watermarkMode === 'fixed' ? 'fixed' : 'dynamic',
    growthSampleTurns: asFiniteInteger(input.growthSampleTurns, 6, 'growthSampleTurns'),
    growthReserveTurns: asFiniteInteger(input.growthReserveTurns, 2, 'growthReserveTurns'),
    growthTokensPerTurn: asFiniteInteger(input.growthTokensPerTurn, DEFAULT_GROWTH_TOKENS_PER_TURN, 'growthTokensPerTurn'),
    constraintBudgetChars: asFiniteInteger(input.constraintBudgetChars, CONSTRAINT_BUDGET_CHARS, 'constraintBudgetChars'),
    // v0.19: on by default — a handoff that waits for a human is not a handoff.
    igniteTarget: input.igniteTarget === undefined ? true : input.igniteTarget === true,
    ignitionMode: input.ignitionMode === 'steer' ? 'steer' : 'queue',
    ignitionPrompt:
      typeof input.ignitionPrompt === 'string' && input.ignitionPrompt.trim().length > 0
        ? input.ignitionPrompt.trim()
        : '',
    memoryDir: typeof input.memoryDir === 'string' && input.memoryDir.trim().length > 0 ? input.memoryDir.trim() : '',
    skillsDir: typeof input.skillsDir === 'string' && input.skillsDir.trim().length > 0 ? input.skillsDir.trim() : '',
    contextWindowTokens: asFiniteInteger(input.contextWindowTokens, 0, 'contextWindowTokens'),
    autoGraftIdPrefix:
      typeof input.autoGraftIdPrefix === 'string' && input.autoGraftIdPrefix.trim().length > 0
        ? input.autoGraftIdPrefix.trim()
        : 'auto-graft',
    autoGraftSessionIds: Array.isArray(input.autoGraftSessionIds)
      ? input.autoGraftSessionIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
      : [],
    autoGraftKeepAliveMs: asFiniteInteger(input.autoGraftKeepAliveMs, 0, 'autoGraftKeepAliveMs'),
    graftTargetGraceTurns: asFiniteInteger(input.graftTargetGraceTurns, 2, 'graftTargetGraceTurns'),
    taskBoundaryMaxDeferTurns: asFiniteInteger(input.taskBoundaryMaxDeferTurns, 1, 'taskBoundaryMaxDeferTurns'),
    // v7.4 (decision 2): off unless asked. See the config doc for why n=1 is not
    // enough evidence to make this the default.
    autoAdaptiveTier: input.autoAdaptiveTier === true,
    // v7.4 P4-3: archived forks never reach the sidebar by themselves, because
    // the client only learns about sessions from `session/created`, which fires
    // for published sessions only. Announcing them is on by default.
    registerArchivedForks: input.registerArchivedForks === undefined ? true : input.registerArchivedForks === true,
    dataDir:
      typeof input.dataDir === 'string' && input.dataDir.trim().length > 0 ? input.dataDir.trim() : '',
    constraintProvider:
      typeof input.constraintProvider === 'string' && input.constraintProvider.trim().length > 0
        ? input.constraintProvider.trim()
        : '',
    constraintModel:
      typeof input.constraintModel === 'string' && input.constraintModel.trim().length > 0
        ? input.constraintModel.trim()
        : '',
  }
}

function asRatio(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw graftError('INVALID_CONFIG', `${name} must be a number in (0, 1]`)
  }
  return value
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

function normalizeText(text: string): string {
  // Preserve code-block indentation and blank lines: recent turns are supposed
  // to be high-fidelity, not flattened prose. Only normalize line endings and
  // trim the outer edges.
  return text.replace(/\r\n/gu, '\n').trim()
}

interface Truncation {
  text: string
  truncated: boolean
  originalLength: number
}

/**
 * v0.23 — NO MORE FREE-TEXT TRUNCATION MARKERS.
 *
 * The old shape appended `…[graft truncated N chars]…` INTO the body. That is a
 * sentence placed inside a value, and it breaks three things at once:
 *
 *   1. STRUCTURE. Anything that treats the value as data — a JSON body, a code block,
 *      a file excerpt — is now corrupt. A `...[已省略 N 行]` line inserted into JSON is
 *      precisely what makes a downstream `JSON.parse` fail, and the failure is
 *      attributed to the reader rather than to the writer that inserted it.
 *   2. FIDELITY. The marker is indistinguishable from content a model might have
 *      written. A reader cannot tell "the tool cut this" from "the document says this".
 *   3. REVERSIBILITY. Once the count is inline, nothing can recover the boundary.
 *
 * So truncation is now expressed as an XML ATTRIBUTE on a wrapper, which is inert:
 * a parser skips an unknown attribute, a human sees an honest boundary, and no
 * character of the marker is ever mistaken for payload.
 *
 *   <file_content truncated_lines="120" original_lines="480">…kept text…</file_content>
 *
 * The `Truncation.truncated` / `originalLength` fields stay, because callers already
 * branch on them and the STRUCTURED facts are what a caller should be using.
 */
function truncateEnd(text: string, limit: number): Truncation {
  if (limit <= 0 || text.length <= limit) return { text, truncated: false, originalLength: text.length }
  // A bare slice: no marker injected into the value. The caller that needs to declare
  // the cut has the structured fields and `wrapTruncated()` below.
  return {
    text: text.slice(0, Math.max(0, limit)),
    truncated: true,
    originalLength: text.length,
  }
}

function truncateMiddle(text: string, limit: number): Truncation {
  if (limit <= 0 || text.length <= limit) return { text, truncated: false, originalLength: text.length }
  const head = Math.max(1, Math.floor(limit * 0.6))
  const tail = Math.max(0, limit - head)
  // Head and tail are joined WITHOUT a separator in the middle: the absent region is
  // declared by `wrapTruncated()`, not by a fake line inside the text.
  return {
    text: text.slice(0, head) + (tail > 0 ? text.slice(-tail) : ''),
    truncated: true,
    originalLength: text.length,
  }
}

/**
 * Wrap a truncated body so the CUT is declared outside the payload.
 *
 * `<file_content truncated_lines="N" original_chars="M">` is inert to every parser
 * that does not know the element, and unambiguous to the ones that do. `countLines`
 * is overridable because different callers truncate by chars, turns, or records.
 */
function wrapTruncated(text: string, original: number, originalLines?: number): string {
  const kept = text.split('\n').length
  const dropped = Math.max(0, (originalLines ?? original) - kept)
  const attr = originalLines === undefined ? `original_chars="${original}"` : `original_lines="${originalLines}"`
  return `<file_content truncated_lines="${dropped}" ${attr}>\n${text}\n</file_content>`
}

/** Strip Markdown enough to make an older-turn first paragraph readable as prose. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^#{1,6}\s*/gmu, '')
    .replace(/^>\s?/gmu, '')
    .replace(/^[-*+]\s+/gmu, '')
    .replace(/^\d+\.\s+/gmu, '')
    .replace(/(?<!\w)[*_~]{1,3}|[*_~]{1,3}(?!\w)/gu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\|/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function firstParagraph(text: string, limit: number): Truncation {
  const blocks = text
    .split(/\n\s*\n/gu)
    .map((block) => block.trim())
    .filter(Boolean)
  const chosen = blocks.find((block) => block.length >= 20) ?? blocks[0] ?? ''
  return truncateEnd(chosen.replace(/\s+/gu, ' ').trim(), limit)
}

function textOfMessage(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * v5.2: pointers are prose now, and they sit inline inside the assistant's
 * sentence rather than on their own line. Detection therefore scans the whole
 * text: both the legacy bracketed form and the humanized "（注：… seq=N）"
 * form name a seq the reader can hand to graft_read_result, which is the
 * stable signal in either shape.
 */
const POINTER_INLINE_PATTERN = /\[tool name=[^\]]*seq=\d+[^\]]*\]|graft_read_result[^)]*seq=\d+/gu

/**
 * The full sentence a tool pointer occupies, including any wrapper the
 * humanized form added. Removing only the inner `graft_read_result(...)` text
 * leaves dangling prose like "需要细节时用 ）", so the sentence goes as a unit.
 */
/**
 * v6.0: pointer sentences are first-person recollections, e.g.
 * "（回顾：刚才我已经调用 read_file 完成了这一步…读 seq=9）".
 * Matching the whole parenthetical keeps the tool name readable AND removes the
 * sentence cleanly from prose — matching only the inner call would leave a
 * dangling "…读 ）".
 */
/**
 * v7.0: every shape a tool pointer can take, including the downgraded one.
 *
 * `（历史记录：使用了当前环境不支持的工具 X…）` was missing. It is what
 * `describeUnavailableTool()` writes when the target lacks a tool (F3), and
 * without it the older-turn index counted ZERO pointers on any slice whose
 * tools had been downgraded — the index then claimed "no tools in this span"
 * while the tape was full of them. Measured on the real fixture with a
 * two-entry registry: pointerCount 342, olderPointerCount 0.
 */
const POINTER_SENTENCE_PATTERN =
  /（回顾：[^）]*）|（注：[^）]*）|（历史记录：[^）]*）|\[tool name=[^\]]*seq=\d+[^\]]*\]|^-\s*[^\s(（]+\(seq=\d+(?:,\d+!?)*\)(?:\s*\(unavailable here\))?|前面提到的那些细节都还留着[^\n]*|如果上面提到的细节不够[^\n]*/gmu

function pointerSentences(text: string): string[] {
  return text.match(POINTER_SENTENCE_PATTERN) ?? []
}

function proseWithoutPointers(text: string): string {
  return text.replace(POINTER_SENTENCE_PATTERN, ' ').replace(/[ \t]{2,}/gu, ' ').trim()
}

function stripLeadingLabel(text: string): string {
  return text.replace(/^(当前假设|假设|已排除|排除|下一步|接下来)\s*[：:]\s*/u, '').trim()
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function pickSentence(sentences: string[], pattern: RegExp, fallback: string): string {
  for (const sentence of sentences) {
    if (pattern.test(sentence)) return stripLeadingLabel(sentence)
  }
  return fallback
}

/**
 * v7.4 P4-2: the shape of a plan sentence is in its FIRST characters.
 *
 * Matching a keyword anywhere is what produced "我接下来需要 源码里还有一行注释
 * 直接声明该设计（L4799）：*\"Since retireSource runs later…\"*" — the word
 * "runs" satisfied the old /run/ test inside a quotation, so a citation became
 * the next action. A real plan announces itself: 下一步 / 接下来 / 待办 / next.
 */
const PLAN_LEAD_PATTERN =
  /^\s*(?:[-*•]\s*)?(?:下一步|接下来|随后|待办|接着|然后|现在先|现在需要|还需要|需要先|next\b|then\b)/iu

/** Keywords that mark a sentence as an absolute constraint worth carrying across a reset. */
const CONSTRAINT_PATTERN =
  /(必须|禁止|绝对|不能|不得|不许|务必|第\s*\d+\s*行|CHECKSUM_42|如果|则|除非|仅有|只有|否则|优先|\bmust\b|\bnever\b|\bforbidden\b|\bline\s+\d+\b|\bdo not\b|\bdon't\b|\bcannot\b|\brequired\b|\bconstraint\b|\bif\b|\bthen\b|\bunless\b|\bonly\b|\bprefer\b|\balways\b|\bbefore\s+you\b|\bend\s+every\b)/iu

function isConstraintSentence(sentence: string): boolean {
  return CONSTRAINT_PATTERN.test(sentence)
}

/**
 * v3.2: extract hard constraints from every user message, with turn 1 first.
 * This is deliberately independent of the assistant summary: the original
 * constraint is usually in the user message, not in what the assistant chose
 * to summarize.
 */
const ACTION_PATTERN =
  /(\bdo\b|\bdon't\b|\bdo not\b|\bmust\b|\bnever\b|\bcannot\b|\bcan't\b|\bshould\b|\bwrite\b|\buse\b|\bignore\b|\binclude\b|\bsend\b|\bask\b|\bend\b|\breply\b|\bchoose\b|\bpick\b|\breport\b|\balways\b|\bonly\b|\bbefore\b|\bafter\b|\bavoid\b|\bkeep\b|\badd\b|\bremove\b|\bcall\b|\brun\b|\breturn\b|\bshow\b|\bwait\b|\bdraft\b|\bleave\b|\bmake\b|\bset\b|\bensure\b|\bprefer\b|\bexclude\b|必须|禁止|不要|不能|不得|务必|请|写|使用|忽略|包含|发送|询问|结束|回复|选择|优先|仅|只)/iu

const IMPERATIVE_START =
  /^(请|必须|禁止|不要|不能|不得|务必|\bdo\b|\bdon't\b|\bdo not\b|\bmust\b|\bnever\b|\balways\b|\bonly\b|\bwrite\b|\buse\b|\bignore\b|\binclude\b|\bsend\b|\bask\b|\bend\b|\breply\b|\bchoose\b|\bpick\b|\breport\b|\bavoid\b|\bkeep\b|\badd\b|\bremove\b|\bcall\b|\brun\b|\breturn\b|\bshow\b|\bwait\b|\bdraft\b|\bleave\b|\bmake\b|\bset\b|\bensure\b|\bprefer\b|\bexclude\b)/iu

const SESSION_SCOPE_PATTERN = /(for the rest of this session|for the rest of the session|standing constraint|this session|整个会话|本次会话|后续所有轮次)/iu

function isQuestionLike(text: string): boolean {
  if (/^(do not|don't|does not|did not)\b/iu.test(text)) return false
  return /[?？]\s*$/u.test(text) || /^(what|why|how|who|when|where|which|is|are|can|could|would|should|do|does|did)\b/iu.test(text)
}

function tokenSet(text: string): Set<string> {  return new Set((text.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/gu) ?? []))
}

function nearDuplicate(a: string, b: string): boolean {
  const left = tokenSet(a)
  const right = tokenSet(b)
  if (left.size === 0 || right.size === 0) return normalizedEqual(a, b)
  let overlap = 0
  for (const token of left) if (right.has(token)) overlap += 1
  return overlap / Math.max(left.size, right.size) >= 0.9
}

function normalizedEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * v4.3: extract hard constraints with precision filters.
 *
 * - reject sentences shorter than 10 or longer than 800 chars
 * - reject questions and sentences without an imperative/action cue
 * - drop near-duplicates
 * - if there are more than 8 candidates, rank by hard/imperative/action
 *   score and keep the best 8 in original order
 */
/**
 * v6.1: DSH injects delegation boilerplate into a subagent's user turn:
 * "Your parent agent id is \"...\". Before you finish, send your result to that
 * agent with send_message({...})".
 *
 * That is a one-shot instruction for the subagent's own turn, not a standing
 * constraint. Carrying it into a top-level target made the migrated session call
 * send_message against an agent it does not belong to, which fails with
 * SubagentError "belongs to another parent session".
 *
 * The migration strips lineage on purpose, so this text must not survive either.
 */
const DELEGATION_NOISE_PATTERN =
  /(your parent agent id|parent agent id is|send your result to that agent|send_message\(\s*\{\s*agent_id|self-contained result|the parent shares your workspace|does not automatically receive your transcript)/iu

/**
 * v0.13: a ONE-OFF ACTION instruction is not a constraint.
 *
 * Measured live: a source session's user message opened with
 *
 *   1. 删除危险脚本：立刻删除 D:\持久层能力架构\repair-log.cjs，绝不能让这个无备份、
 *      强制覆盖的脚本再跑一次。
 *
 * The extractor kept it — it is imperative, action-shaped, specific and long, so it
 * scored well — and the migrated target in the same workspace still carried
 * "删除 repair-log.cjs" inside its HARD CONSTRAINTS block long after that file was
 * gone. A rule that names ONE artifact and ONE act is a TASK STEP: it is safe to
 * follow exactly once, and after that it is a loaded gun pointed at whatever the
 * path points to next.
 *
 * The distinction the filter draws is not "destructive or not" (a standing rule may
 * well forbid something destructive) but "does it GENERALIZE". A sentence that names
 * a concrete file/path and a mutating verb, and carries no standing cue
 * (必须/禁止/绝不/每次/任何/never/always/only …), did not generalize.
 */
const ONE_OFF_ACTION_VERB =
  /(删除|删掉|移除|清空|清理|重命名|改名|覆盖|回滚|恢复|撤销|\brm\b|\bdel\b|\bdelete\b|\bremove\b|\bdrop\b|\brevert\b|\brollback\b|\broll back\b|\brename\b|\boverwrite\b|\bunlink\b)/iu
const CONCRETE_ARTIFACT =
  /([\w\u4e00-\u9fff.@-]+\.(?:cjs|mjs|js|jsx|ts|tsx|py|rb|go|rs|java|json|jsonl|md|txt|log|yml|yaml|toml|ini|exe|dll|ps1|bat|cmd|sh|zip|tar|gz|lock)\b)|([A-Za-z]:[\\/][^\s，。；、"'）)]+)|([\w.-]+\/[\w./-]+)/u

/**
 * The exemption: a prohibition that *governs the act itself*.
 *
 * "绝对禁止在没有备份的情况下删除任何脚本" is durable and must survive. The window is
 * deliberately short (12 chars) and the act list deliberately narrow, because the
 * polluted sentence above contains 绝不 too — "绝不能让这个无备份、强制覆盖的脚本再跑
 * 一次" — and a cue-anywhere-in-the-sentence test would keep the very instruction
 * this filter exists to drop. The cue must sit ON the act, not merely near it.
 */
const DESTRUCTIVE_ACT = /(删除|删掉|移除|清空|清理|\brm\b|\bdel\b|\bdelete\b|\bremove\b|\bdrop\b|\bunlink\b)/iu
const STANDING_PROHIBITION =
  /(禁止|严禁|绝不|不要|不得|不能|务必|必须|每次|任何|一律|永远|始终|never|always|must|do not|don't|only)[^。；\n]{0,12}?(删除|删掉|移除|清空|清理|\brm\b|\bdel\b|\bdelete\b|\bremove\b|\bdrop\b|\bunlink\b)/iu

function isOneOffAction(text: string): boolean {
  if (STANDING_PROHIBITION.test(text)) return false
  if (!ONE_OFF_ACTION_VERB.test(text)) return false
  return CONCRETE_ARTIFACT.test(text)
}

/**
 * v0.18 module 3: HARD CONSTRAINTS are preserved COMPLETELY, or the handoff aborts.
 *
 * THE DEFECT THIS REPLACES
 *
 * The old selection was `candidates.slice(0, 8)` plus an 8000-character running
 * total with a bare `break`. Both are silent: a twelfth standing rule, or a ninth
 * one, simply was not in the goal message the target read, and nothing anywhere
 * said so. The failure mode is the one the block exists to prevent — the model
 * summarises "the main constraints" and drops exactly the rule it is about to
 * violate — except the plugin was doing it first, at extraction time.
 *
 * The replacement states a CAPACITY instead of a count and never truncates a
 * rule's text: everything that qualifies as a standing rule is ranked, packed in
 * score order, and whatever does not fit becomes an ABORT (`GRAFT_ABORTED`), not a
 * shorter list. Capacity is a config knob, so the answer to "we have more rules
 * than that" is a number an operator can raise, deliberately.
 */
export const CONSTRAINT_BUDGET_CHARS = 8000

export interface ConstraintCandidate {
  text: string
  index: number
  score: number
  /**
   * v0.23: RED LINE vs STANDING RULE.
   *
   * A red line is a prohibition that survives everything: it is short, absolute, and
   * losing it risks damage. A standing rule is durable but contextual ("when writing
   * SKILL.md, always include when_to_use"). Both must be preserved; only the red lines
   * belong in the PROMPT, because the prompt is a budget spent on every turn.
   */
  tier?: 'redline' | 'standing'
}

export interface ConstraintDrop {
  text: string
  chars: number
  reason: 'budget'
}

export interface ConstraintSelection {
  constraints: string[]
  /** Rules that qualified but did not fit. Non-empty means: do not ship. */
  dropped: ConstraintDrop[]
  budgetChars: number
  totalChars: number
  candidateCount: number
  /**
   * v0.23: the rules that are preserved but do NOT go in the prompt.
   *
   * The 27-item constraint list the user objected to was not wrong INFORMATION — it
   * was wrong PLACEMENT. Every rule was carried into the prompt, so the prompt grew
   * with the project and the model had to read a changelog to find its boundaries.
   *
   * The fix is not deletion. These rules still ride the handoff (the ledger and the
   * task board), where they are read when someone actually needs them. Only the
   * `constraints` array — the red lines — enters the prompt.
   */
  archived: string[]
  /** How many red lines survived the cap. Equals `constraints.length` after selection. */
  redlineCount: number
}

/**
 * v0.23 — HOW MANY RED LINES MAY ENTER THE PROMPT.
 *
 * Five, because that is roughly as many absolute prohibitions as a reader can hold in
 * working memory while also doing the task. Past that, rules stop being read and start
 * being scrolled: a prompt with 27 constraints is a prompt whose constraints are
 * decoration.
 *
 * This is a PROMPT budget, not a preservation budget. Nothing is deleted — see
 * `ConstraintSelection.archived`. The distinction matters: the earlier design refused
 * to ship at all when a rule did not fit, which kept every rule but made a long-lived
 * project unsliceable; this design keeps every rule and ships the most load-bearing
 * ones in the slot that is actually read.
 */
export const CONSTRAINT_PROMPT_MAX = 5

/** Absolute, unqualified prohibitions: the ones that belong in the prompt. */
const REDLINE_PATTERN =
  /(绝对|严禁|绝不允许|绝不得|永远不要|一律|红线|never|under no circumstances|must not|do not ever)/iu

/**
 * A red line is SHORT and ABSOLUTE. Length matters because a red line that needs a
 * paragraph to explain is a policy, not a line, and the prompt is the wrong home for
 * a policy.
 */
function isRedline(text: string): boolean {
  if (text.length > 160) return false
  return REDLINE_PATTERN.test(text)
}

/** Pack ranked constraints into the declared capacity. Pure, so it is testable. */
export function selectConstraints(
  candidates: readonly ConstraintCandidate[],
  budgetChars: number = CONSTRAINT_BUDGET_CHARS,
): ConstraintSelection {
  const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? Math.trunc(budgetChars) : CONSTRAINT_BUDGET_CHARS
  const ranked = [...candidates].sort((left, right) => right.score - left.score || left.index - right.index)

  /**
   * v0.23: two passes, because the two budgets answer different questions.
   *
   * PASS 1 picks the prompt's red lines: absolute prohibitions first, capped at
   * CONSTRAINT_PROMPT_MAX, and still inside the character budget. If there are not
   * enough absolute prohibitions to fill the cap, the highest-scoring remaining rules
   * fill it — a project with three red lines should still see its most load-bearing
   * standing rule, or the prompt would be emptier than it needs to be.
   *
   * PASS 2 preserves EVERYTHING ELSE into `archived`, which rides the handoff but not
   * the prompt. `dropped` now means only what could not be preserved even there,
   * which is the only thing that should abort a handoff.
   */
  const redlines: ConstraintCandidate[] = []
  const archived: ConstraintCandidate[] = []
  const dropped: ConstraintDrop[] = []
  let total = 0

  const explicit = ranked.filter((candidate) => candidate.tier === 'redline' || isRedline(candidate.text))
  const rest = ranked.filter((candidate) => !(candidate.tier === 'redline' || isRedline(candidate.text)))
  const promptOrder = [...explicit, ...rest]

  const chosen = new Set<ConstraintCandidate>()
  for (const candidate of promptOrder) {
    if (redlines.length >= CONSTRAINT_PROMPT_MAX) break
    // No per-item truncation: a rule cut mid-sentence is a rule nobody can obey.
    if (total + candidate.text.length > budget) {
      // It cannot go in the PROMPT, but it is still preserved below.
      continue
    }
    redlines.push(candidate)
    chosen.add(candidate)
    total += candidate.text.length
  }

  // Everything not chosen for the prompt: preserved, not discarded.
  for (const candidate of ranked) {
    if (chosen.has(candidate)) continue
    archived.push(candidate)
  }

  // Kept rules are re-ordered to their original position, so the target reads them
  // in the order the user wrote them rather than by score.
  redlines.sort((left, right) => left.index - right.index)
  archived.sort((left, right) => left.index - right.index)
  return {
    constraints: redlines.map((candidate) => candidate.text),
    archived: archived.map((candidate) => candidate.text),
    redlineCount: redlines.length,
    dropped,
    budgetChars: budget,
    totalChars: total,
    candidateCount: candidates.length,
  }
}

export function assertConstraintsPreserved(selection: ConstraintSelection, context = ''): void {
  if (selection.dropped.length === 0) return
  const sample = selection.dropped
    .slice(0, 3)
    .map((item) => `"${item.text.slice(0, 60)}${item.text.length > 60 ? '…' : ''}"(${item.chars} chars)`)
    .join('、')
  throw graftError(
    'GRAFT_ABORTED',
    `constraints truncated: ${selection.dropped.length} of ${selection.candidateCount} standing rule(s) do not fit ` +
      `constraintBudgetChars=${selection.budgetChars} (used ${selection.totalChars}). ${sample}` +
      `${context.length === 0 ? '' : ` [${context}]`}. ` +
      'A handoff with a shortened rule set is not shippable: raise constraintBudgetChars, or retire the rules that no longer apply.',
  )
}

export function extractConstraintsDetailed(
  events: readonly SessionEventLike[],
  budgetChars: number = CONSTRAINT_BUDGET_CHARS,
): ConstraintSelection {
  const candidates: ConstraintCandidate[] = []
  let index = 0
  for (const event of events) {
    if (event.type !== 'user/message') continue
    // v7.0: inherit the constraints a PRIOR graft recorded.
    //
    // This used to skip anything whose source.kind was not 'user', which meant a
    // generation-2 graft could not see the constraints a generation-1 graft had
    // written. The rules were present in the log, in our own handoff message, and
    // were dropped on every hop — the exact "multi-generation amnesia" the
    // provenance anchor is meant to point at. Reading our own recorded block is
    // not the same as trusting a replay as user intent (that is P5, and it is
    // handled where replays are assembled, not here).
    if (isGraftAuthored(event.data?.source)) {
      const recorded = constraintBlockOf(textOfMessage(event.data))
      if (recorded.length > 0) {
        for (const constraint of recorded) {
          candidates.push({ text: constraint, index: index++, score: 100 })
        }
      }
      continue
    }
    if (event.data?.source?.kind !== 'user') continue
    const text = textOfMessage(event.data)
    if (text.length === 0) continue
    // v0.19: the plugin's own ignition prompt is not something the user said.
    //
    // The physical-ignition call admits a real `user/message` (the host admits it
    // through the same channel the composer uses), so by source kind alone it looks
    // like human intent. It is not: it is a bootstrap we wrote. Carrying it into a
    // HARD CONSTRAINTS block would let a later generation treat "继续执行任务" as a
    // standing rule the human declared — the exact confusion the P5 marker exists
    // to prevent, one channel over.
    if (isIgnitionText(text)) continue
    // Filtering happens per sentence: a user message can legitimately carry a
    // real standing rule next to harness preamble.
    const messageScope = SESSION_SCOPE_PATTERN.test(text)
    for (const sentence of splitSentences(text)) {
      const normalized = sentence.replace(/\s+/gu, ' ').trim()
      if (normalized.length < 10 || normalized.length > 800) continue
      if (normalized.includes('[redacted')) continue
      if (DELEGATION_NOISE_PATTERN.test(normalized)) continue
      // v0.13: "delete D:\X\repair-log.cjs" is a step, not a rule. See isOneOffAction.
      if (isOneOffAction(normalized)) continue
      const hasKeyword = isConstraintSentence(normalized)
      const hasImperative = IMPERATIVE_START.test(normalized)
      if (!hasKeyword && !hasImperative) continue
      if (isQuestionLike(normalized)) continue
      if (!ACTION_PATTERN.test(normalized)) continue
      if (candidates.some((candidate) => nearDuplicate(candidate.text, normalized))) continue
      const hard = /(\bmust\b|\bnever\b|\bdon't\b|\bdo not\b|\bcannot\b|\balways\b|\bonly\b|必须|禁止|绝对|不能|不得|务必)/iu.test(normalized) ? 2 : 0
      const imperative = /^(请|必须|禁止|不要|不能|不得|务必|\bdo\b|\bdon't\b|\bdo not\b|\bmust\b|\bnever\b|\balways\b|\bonly\b|\bwrite\b|\buse\b|\bignore\b|\binclude\b|\bsend\b|\bask\b|\bend\b|\breply\b)/iu.test(normalized) ? 2 : 0
      const actionHits = (normalized.match(ACTION_PATTERN) ?? []).length
      const lengthBonus = normalized.length >= 20 && normalized.length <= 240 ? 1 : 0
      const scopeBonus = (messageScope ? 6 : 0) + (SESSION_SCOPE_PATTERN.test(normalized) ? 4 : 0)
      candidates.push({ text: normalized, index: index++, score: hard + imperative + actionHits + lengthBonus + scopeBonus })
    }
  }
  return selectConstraints(candidates, budgetChars)
}

/**
 * v0.18: the compatibility shape. Callers that only need the strings keep this;
 * the LOSS REPORT is available through `extractConstraintsDetailed`, and the
 * migration path uses that one so a dropped rule can never go unnoticed.
 */
export function extractConstraints(events: readonly SessionEventLike[], budgetChars?: number): string[] {
  return extractConstraintsDetailed(events, budgetChars).constraints
}

const LLM_CONSTRAINT_PROMPT = [
  'You are a system-level constraint extractor.',
  'From the user inputs below, extract only long-lived, globally effective hard rules and constraints',
  '(for example: do not use a feature, global naming rules, required output formats).',
  'Do NOT extract one-off requests to generate long content (for example: write an article, write a long script).',
  'Do NOT extract one-off ACTION instructions, even when they are imperative and specific: "delete D:\\project\\repair-log.cjs", "remove the file X", "run Z once", "revert that change" are TASK STEPS. They are safe to follow exactly once and become wrong the moment the target no longer exists.',
  'Extract a destructive action ONLY when the user states it as a standing rule that generalizes (for example "never delete X without a backup", "绝对禁止在没有备份的情况下删除任何脚本"). If in doubt, DROP it.',
  'Do NOT extract discussion, questions, feature requests, goals, observations, or "please help me" requests.',
  'Do NOT extract harness delegation boilerplate (for example "your parent agent id is ...", "send your result to that agent", send_message instructions).',
  'Only extract rules the user explicitly makes global or standing (for example: always/never/only/must/do not).',
  'Return only a JSON array of strings. If there are no hard constraints, return [].',
].join('\n')

export interface LlmConstraintResult {
  constraints: string[]
  source: 'llm' | 'regex-fallback'
  error?: string
}

/**
 * v5.0: one cheap LLM call selects semantic standing constraints. The regex
 * extractor remains the fallback whenever the model/service/JSON fails.
 */
export async function llmExtractConstraints(
  ctx: PluginContextLike,
  events: readonly SessionEventLike[],
  settings: Required<GraftConfig>,
): Promise<LlmConstraintResult> {
  const fallback = (error?: string): LlmConstraintResult => ({
    constraints: extractConstraints(events),
    source: 'regex-fallback',
    ...(error === undefined ? {} : { error }),
  })
  const llm = ctx.get('llm')
  if (!isRecord(llm) || typeof llm.stream !== 'function') return fallback('llm service unavailable')
  const sourceTemplate = extractSourceTemplate(events)
  const provider = settings.constraintProvider || sourceTemplate.provider || 'deepseek-account'
  const model = settings.constraintModel || sourceTemplate.model || 'deepseek-flash'
  const userTexts: string[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    const text = textOfMessage(event.data).replace(/\s+/gu, ' ').trim()
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    userTexts.push(truncateEnd(text, 2000).text)
  }
  if (userTexts.length === 0) return { constraints: [], source: 'llm' }
  const selected = [...userTexts.slice(0, 5), ...userTexts.slice(-15)]
  const input = selected.map((text, index) => `--- user input ${index + 1} ---\n${text}`).join('\n\n')
  let lastError = 'llm extraction failed'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const stream = llm.stream({
      provider,
      model,
      system: LLM_CONSTRAINT_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      maxTokens: 1200,
      ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? { signal: AbortSignal.timeout(45_000) }
        : {}),
    })
    let raw = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(chunk.reason.failure?.message ?? 'llm finish error')
      }
    }
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start < 0 || end <= start) throw new Error('llm returned no JSON array')
    const parsed = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed)) throw new Error('llm JSON is not an array')
    const out: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const normalized = item.replace(/\s+/gu, ' ').trim()
      if (normalized.length < 10 || normalized.length > 800) continue
      const strong = /(\bmust\b|\bnever\b|\bdon't\b|\bdo not\b|\bonly\b|\balways\b|\bcannot\b|必须|禁止|不要|不得|只能|务必|始终|绝不)/iu.test(normalized)
      const noise = /(请帮我|能不能|是否|有没有|如何|为什么|我想|我希望|需要|希望|\?|？)/iu.test(normalized)
      const imperative = /^(write|use|ignore|include|send|ask|end|reply|choose|pick|report|avoid|keep|add|remove|call|run|return|show|wait|draft|leave|make|set|ensure|prefer|exclude)\b/iu.test(normalized)
      if (DELEGATION_NOISE_PATTERN.test(normalized)) continue
      if (noise && !strong) continue
      if (!strong && !imperative) continue
      if (out.some((existing) => nearDuplicate(existing, normalized))) continue
      out.push(normalized)
      if (out.length >= 8) break
    }
    return { constraints: out, source: 'llm' }
    } catch (error) {
      lastError = String((error as any)?.message ?? error)
    }
  }
  return fallback(lastError)
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
 * v7.5: the node plan — a coarser layer than the todo list.
 *
 * WHY IT EXISTS
 *
 * `[Task Status]` is a snapshot the model wrote itself: it drifts, it gets
 * forgotten, and when it is 4,000 events old it still reads as "the plan". What a
 * resumed window needs first is not "12 items left" but "I am in phase 2, blocked
 * on X". That sentence is recoverable even from a stale todo list plus the most
 * recent failure, and it is the one thing a reader cannot reconstruct cheaply.
 *
 * SOURCE DISCIPLINE
 *
 * Three descending layers, and **no layer means no block**:
 *   L1  阶段 N: / Phase N / 第 N 步 prefixes in `todo_write`  (deterministic)
 *   L2  a ≥3-item numbered list in the assistant's own text  (heuristic)
 *   L3  ≥4 plain todos, rendered as 节点 (not 阶段)          (coarse fallback)
 * Inventing a roadmap is worse than omitting one: the reader acts on it.
 */
export interface RoadmapPhase {
  label: string
  status: 'done' | 'active' | 'pending'
}

export interface PhaseRoadmap {
  /** What the items are called. L3 says 节点 because it did not find phases. */
  unit: '阶段' | '节点'
  phases: RoadmapPhase[]
  currentNode?: string
  blocker?: { tool?: string; text: string; seq?: number }
  origin: 'todos' | 'assistant-plan' | 'mixed'
  capturedAtSeq: number
  ageEvents?: number
  ageTurns?: number
}

const PHASE_PREFIX = /^(?:阶段|Phase)\s*([0-9]+)\s*[:：]\s*(.+)$/iu
const STEP_CN = /^第\s*([0-9]+)\s*步\s*[:：]?\s*(.+)$/u
const STEP_EN = /^Step\s*([0-9]+)\s*[:：]\s*(.+)$/iu
const TODO_LINE = /^- \[(x| )\]\s*(.+)$/u
const PLAN_ITEM = /^\s*(?:(?:[0-9]+)[.)、]|[-*•])\s+(\S.*)$/u
const CARDINAL_ORDER: readonly RegExp[] = [PHASE_PREFIX, STEP_CN, STEP_EN]

/** Split one rendered todo line back into `{ done, text }`. */
export function parseTodoLine(line: string): { done: boolean; text: string } | undefined {
  const match = TODO_LINE.exec(line.trim())
  if (match === null) return undefined
  return { done: match[1] === 'x', text: match[2].trim() }
}

/** `阶段 2: 补测试` → `{ n: 2, label: '补测试' }`; undefined when unprefixed. */
export function phaseKeyOf(text: string): { n: number; label: string } | undefined {
  for (const pattern of CARDINAL_ORDER) {
    const match = pattern.exec(text.trim())
    if (match === null) continue
    const n = Number(match[1])
    if (!Number.isFinite(n)) continue
    return { n, label: match[2].trim() }
  }
  return undefined
}

/** Numbered/bulleted runs of ≥3 consecutive lines in one assistant message. */
function planBlocksOf(events: readonly SessionEventLike[]): Array<{ seq: number; labels: string[] }> {
  const blocks: Array<{ seq: number; labels: string[] }> = []
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const text = textOfMessage(event.data?.message)
    if (text.length === 0) continue
    let inFence = false
    let run: string[] = []
    const flush = (): void => {
      if (run.length >= 3) blocks.push({ seq: Number(event.seq), labels: run.slice(0, 5) })
      run = []
    }
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.trimEnd()
      if (/^\s*```/u.test(line)) {
        inFence = !inFence
        flush()
        continue
      }
      if (inFence) continue
      const match = PLAN_ITEM.exec(line)
      if (match === null) {
        flush()
        continue
      }
      const label = match[1].replace(/\*\*/gu, '').trim()
      if (label.length === 0) {
        flush()
        continue
      }
      run.push(label.slice(0, 60))
    }
    flush()
  }
  return blocks
}

/** The current node, phrased by the assistant ("正在进行… / 卡在…"). */
function currentNodeFromProse(events: readonly SessionEventLike[]): string | undefined {
  const pattern = /(正在进行|正在做|当前在|卡在|卡住|blocked on|in progress)/iu
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    for (const sentence of splitSentences(textOfMessage(event.data?.message))) {
      if (pattern.test(sentence)) return truncateEnd(sentence.replace(/\s+/gu, ' ').trim(), 80).text
    }
  }
  return undefined
}

/**
 * Build the roadmap, or `undefined` when nothing worth calling a plan exists.
 *
 * `scene` is the same last-step scene the pending state uses; the blocker is
 * dropped when a *later* tool result succeeded, because "blocked on an error that
 * was already fixed" is worse than saying nothing.
 */
export function extractPhaseRoadmap(
  events: readonly SessionEventLike[],
  taskState: TaskState,
  scene: LastStepScene = {},
): PhaseRoadmap | undefined {
  const lastSeq = events.length > 0 ? Number(events[events.length - 1]?.seq ?? 0) : 0
  const lastTurn = (() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'turn/start') {
        const value = Number(event.data?.turn)
        if (Number.isFinite(value)) return value
      }
    }
    return 0
  })()
  const todoItems = taskState.todos.map(parseTodoLine).filter((item): item is { done: boolean; text: string } => item !== undefined)
  const openTodos = taskState.openTodos

  // --- L1: phase prefixes in the todo list ---------------------------------
  const grouped = new Map<number, { labels: string[]; done: boolean; incomplete: string[] }>()
  for (const item of todoItems) {
    const key = phaseKeyOf(item.text)
    if (key === undefined) continue
    const entry = grouped.get(key.n) ?? { labels: [], done: true, incomplete: [] }
    entry.labels.push(key.label)
    if (!item.done) {
      entry.done = false
      entry.incomplete.push(key.label)
    }
    grouped.set(key.n, entry)
  }
  if (grouped.size > 0) {
    const ordered = [...grouped.entries()].sort((a, b) => a[0] - b[0])
    const firstOpen = ordered.findIndex(([, entry]) => !entry.done)
    const phases: RoadmapPhase[] = ordered.map(([n, entry], index) => ({
      label: `阶段 ${n} ${truncateEnd(entry.labels[0] ?? '', 40).text}`.trim(),
      status: entry.done ? 'done' : index === firstOpen ? 'active' : 'pending',
    }))
    const activeEntry = firstOpen >= 0 ? ordered[firstOpen][1] : undefined
    return {
      unit: '阶段',
      phases,
      ...(activeEntry === undefined
        ? {}
        : { currentNode: truncateEnd(activeEntry.incomplete[0] ?? activeEntry.labels[0] ?? '', 80).text }),
      ...blockerOf(events, scene),
      origin: 'todos',
      capturedAtSeq: taskState.todoSeq ?? lastSeq,
      ...(taskState.todoAgeEvents === undefined ? {} : { ageEvents: taskState.todoAgeEvents }),
      ...(taskState.todoAgeTurns === undefined ? {} : { ageTurns: taskState.todoAgeTurns }),
    }
  }

  // --- L2: a numbered plan in the assistant's own words --------------------
  const blocks = planBlocksOf(events)
  if (blocks.length > 0) {
    const block = blocks[blocks.length - 1]
    const phases: RoadmapPhase[] = block.labels.map((label, index) => ({
      // The assistant wrote a list, not statuses. Only the position is a fact:
      // with an open todo list, the first open item is the active node.
      label: truncateEnd(label, 40).text,
      status: index === 0 ? 'active' : 'pending',
    }))
    const current = openTodos[0] ?? currentNodeFromProse(events)
    return {
      unit: '阶段',
      phases,
      ...(current === undefined ? {} : { currentNode: truncateEnd(current, 80).text }),
      ...blockerOf(events, scene),
      origin: openTodos.length > 0 ? 'mixed' : 'assistant-plan',
      capturedAtSeq: block.seq,
      ...(lastSeq > block.seq ? { ageEvents: lastSeq - block.seq } : {}),
      ...(lastTurn === 0 ? {} : { ageTurns: Math.max(0, lastTurn - 1) }),
    }
  }

  // --- L3: plain todos, called 节点 so nothing is over-claimed -------------
  if (todoItems.length >= 4) {
    const slice = todoItems.slice(0, 5)
    const firstOpen = slice.findIndex((item) => !item.done)
    return {
      unit: '节点',
      phases: slice.map((item, index) => ({
        label: truncateEnd(item.text, 40).text,
        status: item.done ? 'done' : index === firstOpen ? 'active' : 'pending',
      })),
      ...(firstOpen >= 0 ? { currentNode: truncateEnd(slice[firstOpen].text, 80).text } : {}),
      ...blockerOf(events, scene),
      origin: 'todos',
      capturedAtSeq: taskState.todoSeq ?? lastSeq,
      ...(taskState.todoAgeEvents === undefined ? {} : { ageEvents: taskState.todoAgeEvents }),
      ...(taskState.todoAgeTurns === undefined ? {} : { ageTurns: taskState.todoAgeTurns }),
    }
  }

  return undefined
}

/** The blocker, unless a later successful tool result already moved past it. */
function blockerOf(
  events: readonly SessionEventLike[],
  scene: LastStepScene,
): { blocker?: { tool?: string; text: string; seq?: number } } {
  if (scene.failingTool === undefined && scene.errorText === undefined) return {}
  let lastResultSeq = -1
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const seq = Number(event.seq)
    if (Number.isFinite(seq) && seq > lastResultSeq) lastResultSeq = seq
  }
  if (scene.errorSeq !== undefined && lastResultSeq > scene.errorSeq) return {}
  const text = (scene.errorText ?? '').replace(/\s+/gu, ' ').trim()
  if (text.length === 0) return {}
  return {
    blocker: {
      ...(scene.failingTool === undefined ? {} : { tool: scene.failingTool }),
      text: truncateEnd(text, 120).text,
      ...(scene.errorSeq === undefined ? {} : { seq: scene.errorSeq }),
    },
  }
}

const MARK = { done: '✅', active: '◐', pending: '○' } as const

/** Render the block. Hard cap 600 chars: it must not outrank the pending state. */
export function renderPhaseRoadmap(roadmap: PhaseRoadmap): string {
  const head = (() => {
    const age =
      roadmap.ageEvents === undefined
        ? ''
        : roadmap.ageEvents >= 500
          ? `，此后又过 ${roadmap.ageEvents} 个事件——可能已过期`
          : `，此后又过 ${roadmap.ageEvents} 个事件`
    return `[Phase Roadmap]（快照 seq=${roadmap.capturedAtSeq}${age}）`
  })()
  const lines = [head]
  for (const phase of roadmap.phases) {
    const suffix = phase.status === 'active' ? ' — 正在进行' : ''
    lines.push(`- ${truncateEnd(phase.label, 60).text} ${MARK[phase.status]}${suffix}`)
  }
  if (roadmap.currentNode !== undefined && roadmap.currentNode.length > 0) {
    lines.push(`当前节点：${truncateEnd(roadmap.currentNode, 100).text}`)
  }
  if (roadmap.blocker !== undefined) {
    const tool = roadmap.blocker.tool === undefined ? '' : `${roadmap.blocker.tool}：`
    const seq = roadmap.blocker.seq === undefined ? '' : `（seq=${roadmap.blocker.seq}）`
    lines.push(`卡点：${tool}${roadmap.blocker.text}${seq}`)
  }
  if (roadmap.unit === '节点') lines.push('（未检测到阶段前缀，以上按清单顺序称为节点）')
  return truncateEnd(lines.join('\n'), 600).text
}

function summaryWithConstraints(prose: string, limit: number): { text: string; truncated: boolean } {
  const sentences = splitSentences(prose)
  const priority = sentences.filter((sentence) => isConstraintSentence(sentence))
  const rest = sentences.filter((sentence) => !isConstraintSentence(sentence))
  const ordered = [...priority, ...rest]
  if (ordered.length === 0) return { text: '', truncated: false }
  const raw = ordered.join(' ')
  return truncateEnd(raw, limit)
}

// ===========================================================================
// Phase 1 — Boundary location and template extraction
// ===========================================================================

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

/**
 * v7.4 P0-3b: a slice needs one closed turn, but it must not throw away the open
 * one. A caller that cannot slice still needs to know the difference between
 * "no durable boundary at all" and "the boundary exists and there is extra work
 * after it".
 */
export function hasClosedTurn(events: readonly SessionEventLike[]): boolean {
  return events.some((event) => event.type === 'turn/end')
}

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

/**
 * Phase 1: record a legal producer-owned assistant source.
 *
 * v2.1 calls the field data.source; in the released v4 envelope it is
 * data.message.source. Both are accepted. The retired {kind:'plugin'} wrapper
 * is refused; plugin:<name> is the legal migration namespace. replayState is
 * never copied: the synthetic content has no matching replay envelope.
 */
export function extractSourceTemplate(events: readonly SessionEventLike[]): GraftSource {
  let found: GraftSource | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const source = event.data?.message?.source ?? event.data?.source
    if (!isRecord(source)) continue
    const kind = source.kind
    if (typeof kind !== 'string' || kind.length === 0 || kind === 'plugin') continue
    const template: GraftSource = { kind }
    if (typeof source.provider === 'string' && source.provider.length > 0) template.provider = source.provider
    if (typeof source.model === 'string' && source.model.length > 0) template.model = source.model
    found = template
  }
  return found ?? { kind: 'plugin:graft', provider: 'unknown', model: 'unknown' }
}

// ===========================================================================
// Phase 2 — Event extraction and tape assembly
// ===========================================================================

interface CallRecord {
  callId: string
  name: string
  turn: number
  step: number
  callSeq: number
  resultSeq?: number
  /** Whether the tool result carried an error, for humanized pointer text. */
  isError?: boolean
  /** Exit code parsed from a failed shell result, when present. */
  exitCode?: number
}

interface AssistantRecord {
  seq: number
  text: string
  callIds: string[]
  pointers: string[]
}

/**
 * v5.2: a fenced block large enough to blow the tape budget.
 *
 * The first ten lines are kept inline so the reader still sees what the block
 * is; the rest is recoverable through `graft_read_result({seq, lineRange})`.
 */
export interface CodeBlockPointer {
  seq: number
  startLine: number
  endLine: number
  preview: string
  pointer: string
}

const CODEBLOCK_MAX_LINES = 200
const CODEBLOCK_MAX_CHARS = 8000
const CODEBLOCK_PREVIEW_LINES = 10

function lineCount(text: string): number {
  let count = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

function firstLines(text: string, count: number): string {
  const lines: string[] = []
  let start = 0
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text.charCodeAt(index) !== 10) continue
    lines.push(text.slice(start, index))
    start = index + 1
    if (lines.length >= count) break
  }
  return lines.join('\n')
}

/**
 * Replace oversized fenced code blocks with a readable pointer.
 *
 * Only text the assistant wrote directly is considered. A block produced by
 * `write_file`/`edit` already has a tool pointer, and rewriting it here would
 * duplicate that indirection.
 *
 * Line numbers in the pointer are ABSOLUTE within the assistant message, so
 * the same numbers can be handed straight to `graft_read_result.lineRange`.
 * A block starting on message line 12 reports `lines=12-313`, not `1-302`;
 * relative numbering silently shifts every later read.
 */
export function pointerizeCodeBlocks(
  text: string,
  seq: number,
  sourceSessionId = '<sourceSessionId>',
): { text: string; pointers: CodeBlockPointer[] } {
  const pointers: CodeBlockPointer[] = []
  if (text.length === 0) return { text, pointers }
  const pattern = /```[^\n]*\n([\s\S]*?)```/gu
  const output = text.replace(pattern, (match: string, body: string, offset: number) => {
    // `body` keeps the newline that precedes the closing fence; that newline
    // terminates the last content line rather than starting a new one, so the
    // content line count must drop it. Counting it would report one extra line
    // and shift every later read.
    const content = body.endsWith('\n') ? body.slice(0, -1) : body
    const bodyLines = lineCount(content)
    if (bodyLines <= CODEBLOCK_MAX_LINES && match.length <= CODEBLOCK_MAX_CHARS) return match
    // The message line on which this block's body starts.
    const bodyStartLine = lineCount(text.slice(0, offset + (match.indexOf('\n') + 1)))
    const bodyEndLine = bodyStartLine + bodyLines - 1
    const preview = firstLines(content, CODEBLOCK_PREVIEW_LINES)
    const pointer =
      `[codeblock seq=${seq} lines=${bodyStartLine}-${bodyEndLine} preview]\n${preview}\n` +
      `…[${Math.max(0, bodyLines - CODEBLOCK_PREVIEW_LINES)} more lines; call ` +
      `graft_read_result({"sourceSessionId":"${sourceSessionId}","seq":${seq},` +
      `"lineRange":{"start":${bodyStartLine},"end":${bodyEndLine}}})]`
    pointers.push({ seq, startLine: bodyStartLine, endLine: bodyEndLine, preview, pointer })
    return pointer
  })
  return { text: output, pointers }
}

/** Extract one numbered line range from a text body, 1-based and inclusive. */
export function sliceLines(text: string, start: number, end: number): string {
  const lines = text.split('\n')
  const from = Math.max(1, start)
  const to = Math.min(lines.length, end)
  if (to < from) return ''
  return lines.slice(from - 1, to).join('\n')
}

interface TurnDraft {
  turn: number
  assistant: AssistantRecord[]
  /** v7.0: the user's own words that opened this turn, in order. */
  user: { seq: number; text: string }[]
}

/**
 * v7.0 (borrowed from dsh-rollover-snapshot): stop untrusted text from forging structure.
 *
 * `verbatimConversation` in rollover-snapshot renders user text with
 * `neutralizeHeadings()` for a measured reason: a user message can contain
 * "## Handoff" or "### 接下来", and a replay that quotes it verbatim lets that
 * text become a *section of our own layout*. The reader then cannot tell where
 * our structure ends and their text begins — the same false-certainty failure,
 * moved from truncation to forgery.
 *
 * The graft tape is a different shape (role-prefixed replay lines, not Markdown
 * sections), so the attack surface is narrower, but the same rule applies: a
 * quoted line must never look like a header of the surrounding document.
 *
 * Escaping only the structural lines, never the whole block, is deliberate —
 * escaping everything is what turned a real checkpoint's own table of contents
 * into \\`\\## 你与用户说的\\`, which reads as damage on every crossing.
 */
const FORGED_HEADING = /^\s{0,3}(?:#{1,6}\s|<\/?h[1-6][^>]*>)/iu
const FORGED_FENCE = /^\s{0,3}(?:```|~~~)/u
const FORGED_RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u

function neutralizeStructure(text: string): string {
  const lines = text.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/u)
  let inFence = false
  return lines
    .map((line) => {
      if (FORGED_FENCE.test(line)) {
        inFence = !inFence
        // A fence inside quoted text must not open a block in our layout.
        return `\\${line.trimStart()}`
      }
      if (inFence) return line
      if (FORGED_HEADING.test(line) || FORGED_RULE.test(line)) {
        return `\\${line.trimStart()}`
      }
      return line
    })
    .join('\n')
}

interface GoalResult {
  goal: string
  source: GraftTape['goalSource']
}

/**
 * v7.0 A4: the goal is the LATEST intent, not the earliest.
 *
 * v6.x took the first user message of length >= 12 that did not start with `/`.
 * On a long session that is the opening brief — which the user has usually
 * superseded three times by the time the context fills. The target then
 * confidently resumes work the user abandoned forty turns ago, and the freshest
 * instruction (the one that actually matters) is nowhere in the injection.
 *
 * The newest substantive user message is the right anchor: it is the last thing
 * the user asked for, and everything after it is the assistant's response to it.
 *
 * "Substantive" is the hard part. Measured on session-legacy-fixture, the last four
 * user turns were literally "请继续" — a bare steer, with the actual intent
 * living in the turn *before* it. Taking the newest message blindly would make
 * the goal "请继续", which is worse than the opening brief. So a bare
 * continuation is skipped and the search walks backwards to the last message
 * that actually said what to do.
 */
function extractGoal(events: readonly SessionEventLike[]): GoalResult {
  const humans = events.filter(
    (event) => event.type === 'user/message' && event.data?.source?.kind === 'user' && textOfMessage(event.data).length > 0,
  )
  const bareAcknowledgement =
    /^(请?继续(吧|工作|推进)?|继续|好的?|可以|嗯+|行|ok|okay|go on|continue|yes|y|proceed|go)[\s.!。！?？]*$/iu
  /**
   * A steer with a throwaway prefix: "考验，请继续", "好，继续吧", "OK go on".
   *
   * Measured, not guessed: session-legacy-fixture's final six user messages were
   * "请继续", "考验，请继续", "请继续" x4. A naive "skip bare acknowledgements"
   * rule stops at "考验，请继续" and makes that the goal — a six-character phrase
   * that says nothing about what to build. The real instruction is the last
   * message with actual content, however far back it sits.
   */
  const steeredAcknowledgement =
    /^[^，,。.！!？?\s]{1,12}[，,、]\s*(请?继续|继续吧?|往下|接着来?|继续干)[\s.!。！?？]*$/iu
  const substantive = (text: string): boolean => {
    const trimmed = text.trim()
    if (trimmed.length < 2) return false
    if (trimmed.startsWith('/')) return false
    if (/^background (job|subagent)\b/iu.test(trimmed)) return false
    if (bareAcknowledgement.test(trimmed)) return false
    if (steeredAcknowledgement.test(trimmed)) return false
    // A short phrase that is mostly punctuation/steering carries no goal.
    if (trimmed.length < 8 && /^(请|继续|再|来|开始|试试)/u.test(trimmed)) return false
    return true
  }
  // v7.0 P2: anchor on the last few substantive messages, not one.
  //
  // A single anchor is a single point of failure. Measured on the real corpus,
  // the newest substantive message is sometimes a narrow correction ("把第 42 行的
  // 常量改成 43") that only makes sense on top of the two before it. Taking it
  // alone hands the target a task with no context; taking the three together
  // hands it the shape of the current work.
  //
  // Newest first, up to three, then flipped back into chronological order so the
  // goal reads as a progression rather than a countdown.
  const anchors: string[] = []
  for (let index = humans.length - 1; index >= 0 && anchors.length < 3; index -= 1) {
    const event = humans[index]
    if (!isRecord(event.data)) continue
    const sourceKind = typeof event.data?.source?.kind === 'string' ? event.data.source.kind : 'user'
    if (sourceKind !== 'user') continue
    // v7.0 P5: a replay is our own writing, not the user's words.
    //
    // This check must come BEFORE the text test but it is written after the
    // sourceKind gate on purpose: `plugin:graft-replay` already fails
    // `sourceKind !== 'user'`, so in practice this line never fires for a replay.
    // It is kept as an explicit assertion of the invariant — and it is the reason
    // the ordering below matters. A previous revision relied on the sourceKind
    // gate alone while the goal extractor accepted `plugin:*` sources from the
    // inherited-constraints path, which let a prior generation's handoff prose
    // become this generation's "当前要做的事".
    if (isGraftAuthored(event.data?.source)) continue
    const text = textOfMessage(event.data)
    if (!substantive(text)) continue
    const normalized = normalizeText(text)
    if (anchors.some((existing) => nearDuplicate(existing, normalized))) continue
    anchors.push(normalized)
  }
  if (anchors.length > 0) {
    const ordered = anchors.reverse()
    const joined = ordered.map((line) => truncateEnd(line, 1600).text).join('\n')
    return { goal: truncateEnd(joined, 4000).text, source: 'user' }
  }
  const human = humans[0]
  if (human) {
    return { goal: truncateEnd(normalizeText(textOfMessage(human.data)), 4000).text, source: 'user' }
  }
  const anyUser = events.find((event) => event.type === 'user/message' && textOfMessage(event.data).length > 0)
  if (anyUser) {
    return { goal: truncateEnd(normalizeText(textOfMessage(anyUser.data)), 4000).text, source: 'fallback-user' }
  }
  const assistant = events.find((event) => event.type === 'assistant/message' && textOfMessage(event.data?.message).length > 0)
  if (assistant) {
    return { goal: truncateEnd(normalizeText(textOfMessage(assistant.data?.message)), 4000).text, source: 'assistant' }
  }
  return { goal: 'Continue the migrated work.', source: 'placeholder' }
}

/**
 * v5.2 拟人化：把一条工具调用写成一句陈述，而不是裸标签。
 *
 * 轻量模型（Flash 一类）会把 `[tool name=write]` 当成待执行的指令或未完成的
 * 调用，从而复读或试图重放。写成"注：此处调用了 write 工具…"后，它是叙述的
 * 一部分，模型只需要理解发生过什么。
 *
 * 可回读的 seq 仍然保留在句子里，需要细节时模型可以调 graft_read_result。
 */
/**
 * v6.4 F4: current artifact index.
 *
 * The blind test on a 73-turn real session exposed the real gap: the target knew
 * WHAT HAPPENED but not WHERE THINGS LIVE NOW. The model then spent its first
 * actions running `ls` to rediscover a disk state the source already knew.
 *
 * This collects the paths the source actually wrote or edited, newest first, so
 * the target can act on files instead of hunting for them.
 */
export interface WorkspaceFile {
  path: string
  action: 'write' | 'edit'
  seq: number
  /** Set when the source re-edited the same path later. */
  writes: number
  /** Set when the newest write/edit for this path came back as an error. */
  failed?: boolean
}

const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'create_file', 'apply_patch', 'str_replace_editor'])

function pathFromToolArguments(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  for (const key of ['file_path', 'path', 'filePath', 'target_file', 'filename']) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** Every distinct path the source wrote, plus how many there were before the cap. */
export interface WorkspaceIndex {
  files: WorkspaceFile[]
  total: number
}

export function extractWorkspaceIndex(events: readonly SessionEventLike[], limit = 20): WorkspaceIndex {
  const byPath = new Map<string, WorkspaceFile & { callSeq: number }>()
  // v7.4b: the block tells the reader "用 graft_read_result 按 seq 回读" — so the
  // seq it prints must be one that tool can OPEN.
  //
  // Measured on `handoff-demo`: every entry cited a `tool/call` seq
  // (e.g. 14888), and reading it answered "No payload at seq 14888"; the
  // readable payload was the `tool/result` one event later (14889). A pointer
  // that cannot be followed is worse than no pointer — it teaches the target
  // that the block is unreliable.
  const resultSeqByCallId = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    const callId = message?.toolCallId ?? message?.source?.callId ?? event.data?.toolCallId
    if (typeof callId === 'string' && callId.length > 0) resultSeqByCallId.set(callId, Number(event.seq))
  }
  const callBySeq = new Map<string, { path: string; seq: number }>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const name = String(event.data?.name ?? '')
    if (!WRITE_TOOL_NAMES.has(name)) continue
    let args: unknown
    try {
      args = JSON.parse(String(event.data?.arguments ?? '{}'))
    } catch {
      continue
    }
    const path = pathFromToolArguments(args)
    if (path === undefined) continue
    const action: WorkspaceFile['action'] = name === 'edit' ? 'edit' : 'write'
    const callSeq = Number(event.seq)
    const callId = String(event.data?.callId ?? '')
    // The result's seq is what graft_read_result can open; fall back to the call
    // seq when the call never came back (interrupted, or cut at the boundary).
    const seq = resultSeqByCallId.get(callId) ?? callSeq
    if (callId.length > 0) callBySeq.set(callId, { path, seq: callSeq })
    const existing = byPath.get(path)
    if (existing === undefined) {
      byPath.set(path, { path, action, seq, callSeq, writes: 1 })
    } else {
      existing.seq = seq
      existing.callSeq = callSeq
      existing.action = action
      existing.writes += 1
      // A newer attempt supersedes an older failure.
      delete existing.failed
    }
  }
  // A call that came back as an error did not put a file on disk. Presenting it
  // as a path the target can read is a claim the target cannot check, so it is
  // marked instead of dropped: the pointer is still historically true.
  //
  // Field convention is the one the rest of this file already uses for results
  // (`message.toolCallId ?? message.source.callId`, `message.isError`): a real
  // v4 log carries the ids and the error flag INSIDE `data.message`, so reading
  // `data.toolCallId` here would compile, pass a hand-written fixture, and never
  // fire on a real log.
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    const callId = message?.toolCallId ?? message?.source?.callId ?? event.data?.toolCallId
    if (typeof callId !== 'string' || callId.length === 0) continue
    const isError = message?.isError === true || event.data?.isError === true || event.data?.error !== undefined
    if (!isError) continue
    const call = callBySeq.get(callId)
    if (call === undefined) continue
    const entry = byPath.get(call.path)
    if (entry !== undefined && entry.callSeq === call.seq) entry.failed = true
  }
  const all = [...byPath.values()]
    .map(({ callSeq, ...rest }) => rest as WorkspaceFile)
    .sort((a, b) => b.seq - a.seq)
  return { files: all.slice(0, Math.max(1, limit)), total: all.length }
}

export function extractWorkspaceState(events: readonly SessionEventLike[], limit = 20): WorkspaceFile[] {
  return extractWorkspaceIndex(events, limit).files
}

/**
 * v0.17: strip HOST NOISE from anything that crosses into a migrated session.
 *
 * The audit that motivated this: a session's own tool output recorded the
 * machine it happened to run on — `C:\Users\<user>\AppData\...`, `/home/...`,
 * `/tmp/...` — and a filesystem sweep of a drive root. Those bytes are real
 * history, but they are not *this project's* history, and they are actively
 * harmful in a tape: they teach the next session that the profile directory is
 * part of its workspace, and they hand it paths it cannot resolve. The workspace
 * red line tells a model not to go there; this stops the tape from *showing* it
 * the way.
 *
 * Two rules, because the two cases differ:
 *
 *   1. a paragraph that names only host paths is REPLACED by a marker — the
 *      reader learns something was elided instead of quietly receiving less;
 *   2. a paragraph that names host paths AND project paths keeps its project
 *      content and has the host tokens redacted, because dropping it would lose
 *      work that actually happened here.
 *
 * The marker is deliberate: a silent deletion in a verbatim replay is the exact
 * "unmarked hole" failure the per-turn budget rules exist to prevent.
 */
export const HOST_NOISE_MARKER = '[宿主环境噪音，已过滤]'
export const HOST_PATH_MARKER = '[宿主路径已过滤]'
export const FOLDED_OUTPUT_MARKER = '[命令输出已折叠]'

/** Host-owned locations. Narrow on purpose: a project path under `D:\` is not noise. */
const HOST_PATH_PATTERN =
  /[A-Za-z]:[\\/]Users[\\/][^\s"',;)]*|\bAppData\b|(?:\/home\/|\/tmp\/|\/var\/folders\/)[^\s"',;)]*|%(?:APPDATA|LOCALAPPDATA|USERPROFILE)%|\$env:(?:APPDATA|LOCALAPPDATA|USERPROFILE)\b|[A-Za-z]:[\\/]Windows[\\/][^\s"',;)]*|\b[A-Za-z]:[\\/](?=$|[\s"',;)])|~[\\/](?=$|[\s"',;)])/iu

/** A sweep of a whole volume, as opposed to a search inside the workspace. */
const GLOBAL_SEARCH_PATTERN =
  /\brg\b[^\n]{0,40}\s\/(?:\s|$)|\b(?:Get-ChildItem|gci|dir|ls|find|grep|findstr|Select-String)\b[^\n]{0,60}(?:\s\/\s|[A-Za-z]:[\\/](?:\s|$))|\b(?:find|du|grep)\b[^\n]{0,30}\s\/(?:\s|$)|-Recurse[^\n]{0,40}[A-Za-z]:[\\/](?:\s|$)/iu

function isProjectPath(candidate: string, cwd: string): boolean {
  if (cwd.length === 0) return false
  const normalize = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
  const target = normalize(candidate)
  const root = normalize(cwd)
  return target.length > 0 && root.length > 0 && (target === root || target.startsWith(`${root}/`))
}

/**
 * @param text anything headed for the tape, the pending state or the workspace block
 * @param cwd the source session's working directory: the only path that is NOT noise
 */
export function stripHostNoise(text: string, cwd = ''): string {
  const input = typeof text === 'string' ? text : ''
  if (input.length === 0) return input
  // Paragraphs, so a redaction cannot silently merge two unrelated statements.
  const paragraphs = input.split(/\n{2,}/u)
  const cleaned = paragraphs.map((paragraph) => {
    if (paragraph.trim().length === 0) return paragraph
    const hasHostPath = HOST_PATH_PATTERN.test(paragraph)
    const hasGlobalSearch = GLOBAL_SEARCH_PATTERN.test(paragraph)
    if (!hasHostPath && !hasGlobalSearch) return paragraph
    // Does this paragraph also carry something that belongs to the project?
    const projectPaths = (paragraph.match(/(?:[A-Za-z]:[\\/]|\/)[^\s"',;)]+/gu) ?? []).filter((candidate) =>
      isProjectPath(candidate, cwd),
    )
    const keepBecauseProject = projectPaths.length > 0
    if (hasGlobalSearch && !keepBecauseProject) return FOLDED_OUTPUT_MARKER
    if (!keepBecauseProject) return HOST_NOISE_MARKER
    return paragraph.replace(new RegExp(HOST_PATH_PATTERN.source, 'giu'), HOST_PATH_MARKER)
  })
  return cleaned.join('\n\n')
}

/**
 * Render the block. A failed tool result for a written path is reported as an
 * unverified write: claiming success for a call that errored would be a lie the
 * target cannot detect.
 */
export function renderWorkspaceState(files: readonly WorkspaceFile[], cwd: string, total = files.length): string {
  if (files.length === 0) return ''
  const lines = ['[Workspace Files]']
  lines.push(`本次窗口内我写过/改过的文件（按最近一次操作排序，工作目录 ${cwd}）：`)
  for (const file of files) {
    const rel = file.path.startsWith(cwd) ? file.path.slice(cwd.length).replace(/^[\\/]+/u, '') : file.path
    const times = file.writes > 1 ? ` ×${file.writes}` : ''
    const status = file.failed === true ? '，最近一次报错，未确认落盘' : ''
    lines.push(`- ${rel}（最近一次：${file.action}${times}，seq=${file.seq}${status}）`)
  }
  // A capped list that says nothing about the cap reads as "this is everything".
  if (total > files.length) {
    lines.push(
      `本次窗口共有 ${total} 个文件，这里只列最近 ${files.length} 个；更早的同样能用 graft_read_result 按 seq 回读。`,
    )
  }
  lines.push('以上是写入记录，不是磁盘校验结果；需要内容时用 graft_read_result 按 seq 回读，不要再盲目列目录。')
  // v0.17: the index lists PATHS. A host path here would be the one place the
  // target is told, "this is part of your workspace", for a file it can never open.
  return stripHostNoise(lines.join('\n'), cwd)
}

/**
 * v6.4 F3: pointer downgrade for tools the target does not have.
 *
 * A source-only tool (a plugin that is no longer mounted) would otherwise be
 * named in a pointer sentence, and a literal-minded model tries to call it.
 * The history is still real, so the pointer stays — it just stops pretending the
 * tool is callable here.
 */
export function describeUnavailableTool(name: string, resultSeq: number, isError: boolean): string {
  const suffix = isError ? '（当时这次调用还报了错）' : ''
  return `（历史记录：使用了当前环境不支持的工具 ${name}${suffix}；原始输出仍可用 graft_read_result 读 seq=${resultSeq}）`
}
/**
 * v7.4 P4-1（方案 B）：回顾句是元数据，不是散文。
 *
 * 真机实测：一个 3,955 字符的重放块里，31 条「（回顾：刚才我已经调用 pwsh…）」
 * 占了 2,387 字符（60%），却只承载两个事实——工具名和 seq。更糟的是它们把时序
 * 埋掉了：每行读起来一模一样，读者看不出"pwsh 连着跑了二十次、read 只跑了三次"。
 *
 * 紧凑形式把同一次连续调用只写一次工具名，按顺序列出 seq：
 *
 *   - pwsh(seq=364,372,380) · read(seq=388)
 *
 * 行序就是时序；`!` 标记那次调用报了错。单个 seq 的粒度和旧句式完全一样，
 * 需要原文时仍然用 graft_read_result 读。
 */
/**
 * v7.4b: name how the open-turn carryover was built.
 *
 * The block is not a single message: it is the last paragraph of each step's
 * assistant text (reasoning dropped) plus tool pointers. Saying so is the
 * difference between "I remember what I said" and "I am reading a montage".
 */
export function carryoverAssemblyNote(carryover: { assistantText: string }): string {
  const paragraphs = carryover.assistantText
    .trim()
    .split(/\n{2,}/u)
    .filter((paragraph) => paragraph.trim().length > 0)
  if (paragraphs.length === 0) {
    // v7.4c: the open turn may hold only the user's instruction (watermark hit
    // before the model answered). Do not claim there is assistant prose.
    return '（断点块：这一轮尚未结束，源会话还没有产出助手正文）'
  }
  if (paragraphs.length < 2) {
    return '（断点块：这一轮尚未结束，正文取自断点前最后一步）'
  }
  return `（断点块：下面 ${paragraphs.length} 段正文按时间拼接自断点前各步的最终段落，不是一条完整消息）`
}

export function renderPointerLines(items: readonly PointerItem[]): string {
  const runs: { name: string; seqs: string[]; unavailable: boolean }[] = []
  for (const item of [...items].sort((left, right) => left.seq - right.seq)) {
    const last = runs[runs.length - 1]
    const unavailable = item.unavailable === true
    if (last !== undefined && last.name === item.name && last.unavailable === unavailable) {
      last.seqs.push(`${item.seq}${item.isError === true ? '!' : ''}`)
      continue
    }
    runs.push({
      name: item.name,
      seqs: [`${item.seq}${item.isError === true ? '!' : ''}`],
      unavailable,
    })
  }
  return runs
    .map((run) => `- ${run.name}(seq=${run.seqs.join(',')})${run.unavailable ? ' (unavailable here)' : ''}`)
    .join('\n')
}

/**
 * v6.2: PendingState is built from the todo list first, prose second.
 *
 * Free-text extraction produced garbage on a real log. A test name like
 * "An expired token is rejected and removed from sessions" matched the
 * "已排除" regex, and a markdown heading "## Tests" matched "接下来", so the
 * injected state read: "我刚刚排除了 An expired token …。接下来我需要 ## Tests。"
 * That is worse than saying nothing.
 *
 * The model's own todo_write is authoritative: the first unchecked item IS the
 * next action. Prose is only a fallback, and it refuses markdown structure,
 * test names, and anything that is not a sentence.
 */
const MARKDOWN_NOISE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|`{3}|~{3})/u
const TEST_NAME_NOISE = /\b(test_|tests?_\w|unittest|pytest|assert|Ran \d+ tests?)/iu

/** Strip a leading label such as "下一步：" so the clause reads naturally. */
function stripLabel(value: string): string {
  return value
    .replace(/^\s*[-*•]?\s*(当前假设|假设|已排除|排除|下一步|接下来|结论|判断)\s*[：:]\s*/u, '')
    .replace(/^\s*[-*•]\s*/u, '')
    .trim()
}

function looksLikeProsePlan(sentence: string): boolean {
  const text = sentence.trim()
  if (text.length < 8 || text.length > 300) return false
  if (MARKDOWN_NOISE.test(text)) return false
  if (TEST_NAME_NOISE.test(text)) return false
  // A sentence needs some natural-language shape, not just an identifier.
  if (!/[\u4e00-\u9fff]/u.test(text) && !/\s/u.test(text)) return false
  return true
}

/**
 * v7.0 P9: the natural-language close that replaced the removed wake directive.
 *
 * Declared before its user so the module has no use-before-definition risk even
 * when a bundler hoists differently.
 */
const CONTINUE_NUDGE = '直接接着刚才的工作继续即可。'

/**
 * v7.3: name the retrieval path at the end of the pending state.
 *
 * The read-back index lists ~24 recent pointers. A reader that wants something
 * older needs to know a search exists — otherwise "the index does not mention it"
 * reads as "it is not there", and the model re-runs the command instead. Naming
 * the tool costs one sentence and turns a dead end into a two-step lookup.
 */
const SEARCH_HINT =
  '如果有不确定的报错或历史代码，请使用 graft_search_history 搜索，再用 graft_read_result 查看原文。'

/**
 * v7.0 P12: build the trailing read-back index.
 *
 * Sources of seq, in the order a reader is likely to want them:
 *   - tool results behind the replay pointers (the expensive ones to re-run)
 *   - user messages (cheap to quote, but the ones the model should echo exactly)
 *
 * Newest first within each group: a resumed window acts on recent work, which is
 * the same reason the older-turn index names the tail of its range.
 *
 * The index is capped and says so. A silently truncated index reads as
 * "these are all the pointers", which is the false-certainty failure the
 * workspace block was already fixed for.
 */
function collectReadbackIndex(
  tape: GraftTape,
  events: readonly SessionEventLike[],
  limit = 24,
): string[] {
  const byTurn = new Map<number, GraftTapeTurn>()
  for (const turn of tape.turns) byTurn.set(turn.turn, turn)
  const pointerSeq = new Map<number, string>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    const callId = message?.toolCallId ?? message?.source?.callId
    if (typeof callId !== 'string') continue
    pointerSeq.set(Number(event.seq), typeof message === 'string' ? '' : String(callId))
  }
  // Reuse the pointer sentences the tape already produced: they are the exact
  // wording the model just read, so the index matches what it is indexing.
  const rows: { seq: number; label: string }[] = []
  const seen = new Set<number>()
  for (const turn of [...tape.turns].reverse()) {
    for (const pointer of pointerSentences(turn.replay ?? turn.text)) {
      // v7.4 P4-1: a compact run names the tool once and lists every seq.
      const compact = /^-\s*([A-Za-z0-9_.:-]+)\(seq=([^)]+)\)/u.exec(pointer)
      const seqText = compact?.[2] ?? /seq=(\d+)/u.exec(pointer)?.[1]
      if (seqText === undefined) continue
      // v7.3.1: name every pointer shape, including the downgraded one.
      //
      // Missing the `（历史记录：…工具 X…）` branch here is what turned the whole
      // index into anonymous `Turn 5 · tool` rows when F3 downgraded the tape —
      // an index with no tool names gives a reader no reason to fetch anything.
      // The downgrade decision itself is fixed at the source (scope-correct
      // lookup); this branch keeps the index readable even when a genuine
      // downgrade happens.
      const name =
        compact?.[1] ??
        /调用\s*([A-Za-z0-9_.-]+)/u.exec(pointer)?.[1] ??
        /tools? name=([^\s]+)/u.exec(pointer)?.[1] ??
        /不支持的工具\s+([A-Za-z0-9_.-]+)/u.exec(pointer)?.[1] ??
        'tool'
      // Mark a downgraded pointer as such: "read (unavailable)" tells the reader
      // the original output is still fetchable while the tool itself is not.
      const downgraded = /历史记录：/u.test(pointer) || /\(unavailable here\)/u.test(pointer)
      for (const part of seqText.split(',')) {
        const seq = Number(part.replace(/!$/u, '').trim())
        if (!Number.isFinite(seq) || seen.has(seq)) continue
        seen.add(seq)
        rows.push({ seq, label: `Turn ${turn.turn} · ${name}${downgraded ? ' (unavailable here)' : ''}` })
        if (rows.length >= limit) break
      }
      if (rows.length >= limit) break
    }
    if (rows.length >= limit) break
  }
  for (const turn of [...tape.turns].reverse()) {
    if (rows.length >= limit) break
    if ((turn.userTexts ?? []).length === 0) continue
    if (seen.has(turn.firstSeq)) continue
    seen.add(turn.firstSeq)
    const head = (turn.userTexts?.[0] ?? '').replace(/\s+/gu, ' ').slice(0, 28)
    rows.push({ seq: turn.firstSeq, label: `Turn ${turn.turn} · 用户原话「${head}…」` })
  }
  if (rows.length === 0) return []
  const lines = rows.map((row) => `- seq=${row.seq}  ${row.label}`)
  const total = tape.pointerCount + tape.turns.reduce((sum, turn) => sum + (turn.userTexts ?? []).length, 0)
  if (total > rows.length) {
    lines.push(`- （共 ${total} 处可回读，这里按最近优先列 ${rows.length} 条；完整原文按 seq 取）`)
  }
  return lines
}

/**
 * v7.0 P1-2: background work that will NOT follow the user into the target.
 *
 * A graft copies the conversation; it cannot copy a running process. Jobs and
 * subagents are owned by the live agent loop, and when the source session is
 * retired those children keep running (or get torn down) with their results
 * going to a session the user has left. The target then waits for a report that
 * will never arrive, or — worse — re-runs work that is still in flight.
 *
 * Detection is from the log, not from the jobs service: `job/registered` and
 * `job/settled` are already paired per job id in the durable record, so this
 * needs no live handle and works identically for a cold slice.
 */
export interface OpenBackgroundWork {
  jobs: string[]
  subagents: string[]
}

export function extractOpenBackgroundWork(events: readonly SessionEventLike[]): OpenBackgroundWork {
  const jobs = new Map<string, string>()
  const subagents = new Map<string, string>()
  for (const event of events) {
    const data = event.data
    if (!isRecord(data)) continue
    if (event.type === 'job/registered') {
      const id = typeof data.jobId === 'string' ? data.jobId : ''
      if (id.length === 0) continue
      const label = typeof data.label === 'string' && data.label.length > 0 ? data.label : id
      jobs.set(id, label)
      continue
    }
    if (event.type === 'job/settled') {
      const id = typeof data.jobId === 'string' ? data.jobId : ''
      if (id.length > 0) jobs.delete(id)
      continue
    }
    // A spawned subagent's lifetime is visible through its own events: the
    // task id appears on creation and again on settlement.
    if (event.type === 'subagent/start') {
      const id = typeof data.id === 'string' ? data.id : typeof data.taskId === 'string' ? data.taskId : ''
      if (id.length === 0) continue
      subagents.set(id, typeof data.label === 'string' && data.label.length > 0 ? data.label : id)
      continue
    }
    if (event.type === 'subagent/end') {
      const id = typeof data.id === 'string' ? data.id : typeof data.taskId === 'string' ? data.taskId : ''
      if (id.length > 0) subagents.delete(id)
    }
  }
  return { jobs: [...jobs.values()], subagents: [...subagents.values()] }
}

/**
 * One line stating what did not come across, or `''` when nothing is running.
 *
 * Stated as a fact with a count and the consequence, because the failure this
 * prevents is the target waiting:
 * "there are 2 jobs still running; their output will not arrive here."
 */
function renderOpenWorkNotice(open: OpenBackgroundWork): string {
  const total = open.jobs.length + open.subagents.length
  if (total === 0) return ''
  const parts: string[] = []
  if (open.jobs.length > 0) parts.push(`${open.jobs.length} 个后台作业`)
  if (open.subagents.length > 0) parts.push(`${open.subagents.length} 个子代理`)
  const names = [...open.jobs, ...open.subagents].slice(0, 5).join('、')
  const more = total > 5 ? ` 等 ${total} 项` : ''
  return (
    `源会话里还有 ${parts.join('和')}仍在运行（${names}${more}）；` +
    '它们不会被迁移，结果也不会自动回到这里。需要那些结果时，回到源会话查看，或重新发起。'
  )
}

/**
 * v7.0: read the constraint list back out of a handoff message we wrote.
 *
 * The block the goal message carries is:
 *
 *   HARD CONSTRAINTS（从源会话用户消息中抽取，逐条有效，不可协商）:
 *   1. [ ] …
 *   2. [ ] …
 *
 * Parsing our own format (rather than re-running the heuristic over the whole
 * block) keeps the inherited list byte-identical to what the previous generation
 * was given: no re-scoring, no re-filtering, no slow drift across hops.
 */
function constraintBlockOf(text: string): string[] {
  const marker = 'HARD CONSTRAINTS'
  const start = text.indexOf(marker)
  if (start < 0) return []
  const lines = text.slice(start).split(/\r?\n/u)
  const out: string[] = []
  for (const line of lines.slice(1)) {
    const match = /^\s*\d+\.\s*(?:\[[ x]?\]\s*)?(.+)$/u.exec(line)
    if (match !== null) {
      const value = match[1].trim()
      if (value.length > 0) out.push(value)
      continue
    }
    // The list ends at the first non-item, non-blank line.
    if (line.trim().length === 0) continue
    if (out.length > 0) break
  }
  return out
}

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

function renderConstraintProvenance(provenance: ConstraintProvenance): string {
  const generation =
    provenance.generationsBack === 1 ? '上一代会话' : `第 ${provenance.generationsBack} 代会话`
  return (
    `核心约束最早记录在${generation}（${provenance.sessionId}，seq=${provenance.seq}）。` +
    '上面列出的约束是它们的最新副本；如果这里的表述和回读结果冲突，以后读到的原文为准。'
  )
}

/**
 * v7.0: a one-line, concrete account of what the LAST step actually touched.
 *
 * Why this exists — the "zero replay" trade-off:
 *
 * Once the tape drops to 0-1 turns, the target no longer reads the last exchange.
 * Everything it knows about the immediate situation comes from the structured
 * blocks. A pending state that only says "I need to continue pushing <goal>"
 * gives it the task but not the scene: which file was open, which function was
 * being changed, what the failure actually said. The model then re-explores to
 * rebuild that scene, which is exactly the cost the tape was supposed to avoid.
 *
 * So this extracts the three facts that make a scene: the most recent file
 * touched, the most recent tool that produced an error, and the error's own
 * words. All three come from the log, so they are facts, not paraphrase.
 */
export interface LastStepScene {
  file?: string
  action?: string
  failingTool?: string
  errorText?: string
  /** v7.2: the seq of the failing tool/result, so the error can be traced back. */
  errorSeq?: number
  /** v7.2: the failing result's full text (bounded), for inline display. */
  errorBody?: string
  /** v7.2: whether `errorBody` had to be cut. */
  errorTruncated?: boolean
}

export function extractLastStepScene(events: readonly SessionEventLike[]): LastStepScene {
  const scene: LastStepScene = {}
  // Collect call metadata FIRST, in forward order.
  //
  // The backward scan below hits a `tool/result` before the `tool/call` that
  // produced it (call seq 1737, result seq 1738), so a single reverse pass sees
  // an empty name map and reports the tool as "tool". Two passes cost one extra
  // linear read of an array that is already in memory, and they are correct.
  const toolNames = new Map<string, string>()
  const callArgs = new Map<string, unknown>()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
    if (callId.length === 0) continue
    const name = typeof event.data?.name === 'string' ? event.data.name : ''
    if (name.length > 0) toolNames.set(callId, name)
    const raw = event.data?.arguments
    if (typeof raw === 'string') {
      try {
        callArgs.set(callId, JSON.parse(raw))
      } catch {
        // Arguments that are not JSON cannot name a path; skip them.
      }
    }
  }
  // Newest first: the scene is the most recent moment, not the whole history.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    const callId = message?.toolCallId ?? message?.source?.callId
    const name = typeof callId === 'string' ? toolNames.get(callId) ?? '' : ''
    const text = textOfMessage(message)
    const isError = message?.isError === true || event.data?.error !== undefined
    if (isError && scene.failingTool === undefined) {
      scene.failingTool = name.length > 0 ? name : 'tool'
      // Keep the first line that carries each of the usual tripwires; a bare
      // "exit code 1" is less useful than the assertion message above it.
      const line =
        text
          .split(/\r?\n/u)
          .map((candidate) => candidate.trim())
          .find((candidate) => /error|失败|exception|assert|not found|cannot|exit code/iu.test(candidate)) ??
        text.split(/\r?\n/u)[0] ??
        ''
      scene.errorText = truncateEnd(line.replace(/\s+/gu, ' '), 180).text
      // v7.2: keep the whole failure body, not just the one matched line.
      //
      // During continuous debugging the thing a resumed window needs is the
      // error's own words — the stack, the assertion, the offending path. A
      // 180-char gist forces it to go fetch the seq, which is exactly the lookup
      // this block exists to save. Bounded at 2000 chars and marked when cut, so
      // the reader knows the difference between "that is the error" and "that is
      // the first part of the error".
      const body = text.trim()
      scene.errorSeq = Number(event.seq)
      if (body.length > 2000) {
        scene.errorBody = body.slice(0, 2000)
        scene.errorTruncated = true
      } else {
        scene.errorBody = body
        scene.errorTruncated = false
      }
    }
    if (scene.file === undefined && WRITE_TOOL_NAMES.has(name)) {
      const path = pathFromToolArguments(callId === undefined ? undefined : callArgs.get(String(callId)))
      if (path !== undefined) {
        scene.file = path
        scene.action = name
      }
    }
    if (scene.file !== undefined && scene.failingTool !== undefined) break
  }
  return scene
}

/**
 * v7.0: render the scene as one sentence of first-person recall.
 *
 * Stated as memory ("I was just…"), not as a label, because a label invites the
 * model to treat it as an instruction; a recollection invites it to continue.
 */
/**
 * v7.2: render the scene, then inline the failure's own text.
 *
 * The one-line summary names what failed; the body below is what it SAID. Both
 * are needed for continuous debugging: the summary tells the reader where to
 * look, the body saves it the round trip. Without the body, "the last pwsh call
 * failed" is a fact the model must spend a tool call to expand — on every single
 * migration, which is exactly when it can least afford one.
 *
 * The body is fenced so a stack trace containing markdown cannot restructure the
 * pending state, and labelled with its seq so the reader can still reach the
 * original if the 2000-char cut removed the part it needed.
 */
function renderLastStepScene(scene: LastStepScene): string {
  const parts: string[] = []
  if (scene.file !== undefined) {
    const verb = scene.action === 'write' ? '写' : '改'
    parts.push(`最后一步我在${verb} ${scene.file}`)
  }
  if (scene.failingTool !== undefined) {
    const detail = scene.errorText === undefined || scene.errorText.length === 0 ? '' : `，报错是「${scene.errorText}」`
    parts.push(`最后跑的 ${scene.failingTool} 失败了${detail}`)
  }
  const summary = parts.length === 0 ? '' : `${parts.join('；')}。`
  if (scene.errorBody === undefined || scene.errorBody.length === 0) return summary
  const body = neutralizeStructure(scene.errorBody)
  const cut = scene.errorTruncated === true ? '\n…[已截断]' : ''
  const header =
    scene.errorSeq === undefined
      ? '最后一条报错原文：'
      : `最后一条报错原文（seq=${scene.errorSeq}）：`
  const block = `${header}\n${body}${cut}`
  // The caller joins the scene with the following line, so the block must end
  // with its own terminator. Without it the error's last line ran straight into
  // "我接下来需要…", and a stack trace's final frame read as part of the plan.
  const terminated = /[。.!！?？:：\n]$/u.test(block) ? block : `${block}。`
  return summary.length === 0 ? terminated : `${summary}\n\n${terminated}`
}

/**
 * v7.4b (硬约束 4): the breakpoint outranks the todo list when they disagree.
 *
 * The pending state opens with `openTodos[0]` because a written plan is the
 * most authoritative statement of intent — but a todo list is a snapshot taken
 * BEFORE the cut, and the open turn after it may already have performed the
 * first item. Measured on `handoff-demo`: the list said
 * "用 graft_prepare 真机体检…" while the carryover ended with
 * `graft_prepare(seq=14965)` and the model's own "提交" line. A reader that
 * trusts the list re-issues a side-effecting tool that already ran — for
 * `graft_commit` that is a second migration of the same session.
 *
 * So: when the open-turn tail names the tool the first open todo names, say so
 * instead of hiding it. The instruction stays; the doubt is attached to it.
 */
export function staleTodoHint(
  openTodo: string | undefined,
  lastOpenCall: { readonly tool: string; readonly seq: number } | undefined,
): string | undefined {
  if (openTodo === undefined || lastOpenCall === undefined) return undefined
  const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '')
  const tool = squash(lastOpenCall.tool)
  if (tool.length === 0 || !squash(openTodo).includes(tool)) return undefined
  return `断点前我刚发出过 ${lastOpenCall.tool}(seq=${lastOpenCall.seq})，这一项可能已经做完了——先核对它的结果，不要直接重跑。`
}

function buildPendingState(
  lastTurnText: string,
  goal: string,
  sourceSessionId: string | undefined,
  pointerCount: number,
  openTodos: readonly string[] = [],
  scene: LastStepScene = {},
  lastOpenCall?: { readonly tool: string; readonly seq: number },
  todoFreshness?: { readonly todoSeq?: number; readonly newerSuccesses: number },
  /**
   * v0.32 P1: a todo_write exists even when it has no open items.
   *
   * The fallback below reads the last turn's prose, which is a different claim
   * from "the model's written list is finished". On a long session that prose can
   * still name an older plan, and the board presented it as the next action. A
   * finished written plan must be stated as finished, not recycled.
   */
  hasWrittenPlan = false,
): string {
  const lines: string[] = []

  // v7.0: the scene comes FIRST when the tape is short.
  //
  // With zero or one replayed turn, this line is the only thing that says where
  // the work physically stopped. Putting it after the goal would bury the one
  // concrete fact under the most abstract one.
  const sceneText = renderLastStepScene(scene)
  if (sceneText.length > 0) lines.push(sceneText)

  if (openTodos.length > 0) {
    // Authoritative path: the model already wrote down what remains.
    const next = openTodos[0].replace(/\s+/gu, ' ').trim()
    lines.push(`我接下来需要立刻执行：${truncateEnd(next, 260).text}。`)
    const stale = staleTodoHint(next, lastOpenCall)
    if (stale !== undefined) lines.push(stale)
    if (openTodos.length > 1) {
      const rest = openTodos
        .slice(1, 4)
        .map((item) => truncateEnd(item.replace(/\s+/gu, ' ').trim(), 120).text)
      lines.push(`再往后还有：${rest.join('；')}。`)
    }
    // v7.5: a list written before N successful calls is a CLAIM, not the current state.
    //
    // Measured on a live handoff: the pending said "立刻执行：推送 v0.8.0（等确认）" while the
    // push had already happened. The list was stale; nothing on screen said so.
    if (todoFreshness !== undefined && todoFreshness.newerSuccesses >= 3 && todoFreshness.todoSeq !== undefined) {
      lines.push(
        `（清单写于 seq=${todoFreshness.todoSeq}，之后又有 ${todoFreshness.newerSuccesses} 次成功的工具调用——` +
          '某项可能已完成，先核对再重跑。）',
      )
    }
  } else if (hasWrittenPlan) {
    // v0.32 P1: the model's latest write exists and has nothing open. Say that.
    // Falling through to prose here is how an older "P1-1/P1-2"-style plan got
    // presented as the current next action.
    lines.push('我写的待办清单已全部完成；接下来按「这个会话的任务」做最后验证与收尾。')
  } else {
    // Fallback: prose, but only sentences that survive the noise filter.
    const prose = proseWithoutPointers(lastTurnText)
    const sentences = splitSentences(prose)
    const excluded = pickSentence(
      sentences,
      /(排除|放弃|不再|否决|ruled out|rejected|not viable|dead end|does not work)/iu,
      '',
    )
    // v7.4 P4-2: anchor the plan pattern at the SENTENCE LEAD.
    //
    // The old pattern matched the substring anywhere, so an English aside like
    // "since retireSource runs later" scored as a plan and the pending state read
    // "我接下来需要 源码里还有一行注释直接声明该设计（L4799）…". A plan sentence
    // announces itself at the front; a citation or an aside does not.
    const next = pickSentence(sentences, PLAN_LEAD_PATTERN, '')
    const excludedText = looksLikeProsePlan(excluded) ? stripLabel(excluded) : ''
    const nextText = looksLikeProsePlan(next) ? stripLabel(next) : ''
    if (excludedText.length > 0) lines.push(`我刚刚排除了 ${truncateEnd(excludedText, 260).text}。`)
    if (nextText.length > 0) {
      // v7.4 P4-2: a conditional is a PRECONDITION, not an action.
      //
      // "我接下来需要 如果 X 就 Y。" glues an if-clause onto a declarative frame:
      // ungrammatical, and — worse — it reads as an order to do X now. The
      // natural form foregrounds the action and demotes the condition:
      // "我接下来需要继续推进，前提是 …".
      const cut = truncateEnd(nextText, 260).text
      if (/^(?:如果|若|假如|假设|要是|除非|一旦)/u.test(cut)) {
        lines.push(
          `我接下来需要继续推进，前提是 ${cut.replace(/^(?:如果|若|假如|假设|要是|除非|一旦)\s*/u, '')}。`,
        )
      } else {
        lines.push(`我接下来需要 ${cut}。`)
      }
    } else {
      // v7.0: do NOT quote the goal here.
      //
      // The goal is multi-anchor since P2 (up to three joined messages, with
      // newlines). Wrapping it in 「…」 produced a wall of quoted text that read
      // as damaged prose and repeated what the goal message already says. The
      // goal lives one message above; this line only has to point at it.
      // v7.3.1: point at the goal by its honest label.
      //
      // The goal is the session's task, which may already be substantially done.
      // This line only fires when the model left NO open todo, so "continue the
      // task" is the only available next action — but it must name the same label
      // the goal message uses, or the reference dangles.
      lines.push('我接下来需要按上面「这个会话的任务」继续推进，并验证结果。')
    }
  }

  // v7.2: join with newlines, not with ''.
  //
  // The concatenation was fine while every line was a short sentence. Since the
  // scene can now carry a multi-line error body, `join('')` ran the stack trace's
  // last frame straight into the next sentence ("at test.ts:3我接下来需要…"),
  // which reads as one broken line and makes the plan look like part of the error.
  let text = lines.join('\n')
  if (sourceSessionId !== undefined && pointerCount > 0) {
    text += `\n\n前面提到的那些细节都还留着。如果哪一步需要原文，我就用 graft_read_result，sourceSessionId 传 ${sourceSessionId}，seq 传回忆句里写的编号。`
  }
  // v7.0 P9: the directive became a sentence in the assistant's own voice.
  //
  // A separate "系统强制指令" block told the reader it was looking at a system
  // document. The same intent, phrased as the last beat of an inner monologue,
  // keeps the recency position inside the conversation instead of outside it.
  if (text.length > 0) text += `\n\n${SEARCH_HINT}\n${CONTINUE_NUDGE}`
  return text
}

// ===========================================================================
// v0.19 module 1 — SEMANTIC STATE, not a log (the instruction card)
// ===========================================================================

/**
 * v0.19: what the source session's LAST RESULT was, stated as one verifiable line.
 *
 * THE DEFECT THIS REPLACES
 *
 * The tape used to hand the open turn over more or less whole: the assistant's
 * narration, every pointer line, and — through `renderLastStepScene` — the failing
 * tool's FULL error body, up to 2000 characters of stack trace. On this project's
 * own slices that was the single largest source of text the target could neither
 * act on nor verify, and it carried the old house's problems into the new context:
 * a target that opens by reading a resolved stack trace starts by fixing something
 * that is already fixed.
 *
 * What a resumed worker actually needs is two facts and one pointer:
 *
 *   [最终结果] git commit e8da8f6 成功（seq=14821）
 *   [下一步] …（未执行的那一个动作）
 *   [停泊点] Turn 47 已完成 · 指针 340 处可回读
 *
 * Everything else is history, and history is reachable by seq. So it is DROPPED,
 * and the drop is declared (`discarded`) rather than silent — the same discipline
 * the omitted-turn declaration uses.
 */
export type SemanticOutcomeKind = 'commit' | 'push' | 'test-pass' | 'artifact' | 'tool-ok'

export interface SemanticOutcome {
  /** One line, e.g. `git commit e8da8f6 成功`. */
  text: string
  kind: SemanticOutcomeKind
  /** The seq of the evidence, so the claim is checkable rather than trusted. */
  seq: number
  tool: string
}

export interface SemanticNextAction {
  text: string
  source: 'todo' | 'user' | 'plan' | 'unresolved-error' | 'goal'
  seq?: number
  blockedByError?: true
}

/** Evidence of what the slimming threw away. The point of the module, not a metric. */
export interface SemanticDiscard {
  /** Failing results whose body is no longer inlined. */
  errorBodies: number
  /** Errors superseded by a later success: dropped entirely. */
  resolvedErrors: number
  /** Assistant narration characters dropped from the open turn. */
  narrationChars: number
  /** Pointer lines dropped from the open turn (they live in the read-back index). */
  pointerLines: number
}

export interface SemanticState {
  outcome?: SemanticOutcome
  /** The newest failure that NOTHING later succeeded past. */
  unresolvedError?: { text: string; seq: number; tool: string }
  next?: SemanticNextAction
  discarded: SemanticDiscard
}

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

/**
 * v0.19: the scene without its error body.
 *
 * `extractLastStepScene` keeps the whole failure on purpose (it is evidence, and a
 * caller may render it). The INJECTION must not: see `extractSemanticState`.
 */
export function slimScene(scene: LastStepScene): LastStepScene {
  return {
    ...(scene.file === undefined ? {} : { file: scene.file }),
    ...(scene.action === undefined ? {} : { action: scene.action }),
  }
}

const CARD_HEADER = '## 交接指令卡（第一轮只要读这里）'
/** Total budget for the card. Past this the card is the thing that needs slimming. */
export const INSTRUCTION_CARD_MAX_CHARS = 1400

/**
 * v0.20: the card is a TASK BOARD, not a paragraph.
 *
 * v0.19 distilled the tape correctly but rendered the result as prose: one line of
 * result, one paragraph of next-action, one line of stop point. A model reading
 * prose has to DERIVE the board — which of these is done, which is running, which
 * has not started — and that derivation is exactly where a resumed session drifts
 * into re-doing finished work.
 *
 * A board states the four columns explicitly, in the order a worker asks them:
 *
 *   · 原始用户要求  what was asked (the axis everything else is measured against)
 *   · ✅ 已完成      the verifiable result, with its seq
 *   · 🔄 进行中      what is actually in flight right now
 *   · ⏭️ 待开始      the next action, and only that
 *
 * `renderInstructionCard` stays as the single renderer; the board is what it
 * renders. Splitting it into a second function would create two formats that drift.
 */
export interface TaskBoardInput {
  /** The user's original ask, already extracted (goal). */
  request: string
  /** The verifiable final result, if any. */
  outcome?: SemanticOutcome
  /** What is in flight: the open turn's unfinished state, if any. */
  inProgress?: string
  /** The next actions, in order. First one is the immediate next step. */
  pending: readonly string[]
  /**
   * v0.32 P1: a todo_write exists even when every item is completed.
   *
   * The empty-pending fallback below is for a session that never wrote a plan.
   * A finished written plan is a different fact and must be rendered as such.
   */
  hasWrittenPlan?: boolean
  stopPoint: { turn?: number; boundarySeq?: number }
  sourceSessionId?: string
  pointerCount: number
  /** The unresolved blocker, if one exists. */
  unresolvedError?: { text: string; seq: number; tool: string }
  discarded: SemanticDiscard
  /** Pre-rendered extra prose (exclusion notes, artifact reuse, …). */
  notes?: readonly string[]
  /** v1.0.2: the goal in force NOW — the original ask is kept as the audit trail. */
  currentGoal?: string
  /** v1.0.2: how many recorded goal changes exist (0 = the goal never moved). */
  goalRevisions?: number
  /**
   * v0.23 P2: what the filesystem ACTUALLY says, measured at handoff time.
   *
   * The ✅ column is assembled from the source conversation — which means it reports
   * what the model SAID it did. "git commit e8da8f6 成功" is a claim; the board
   * presented it as a fact, and a target that trusts it builds on a commit that may
   * not exist, on a branch that may be three edits behind, or on a repo that was never
   * initialised.
   *
   * So the handoff now runs a cheap, read-only probe (`git status`, `git log -1`, a
   * directory listing) and prints the result as its OWN section, labelled as measured.
   * The board's claims stay claims; this section is the referee. When the two
   * disagree, a target can see the disagreement without being told to look for it.
   */
  verification?: BoardVerification
}

/** The measured facts. Absent = not probed (no cwd, no git, probe failed). */
export interface BoardVerification {
  /** Absolute directory the probe ran in. */
  cwd: string
  /** `git rev-parse --short HEAD`, or undefined when not a repo. */
  head?: string
  /** `git log -1 --pretty=%s`, the subject of HEAD. */
  subject?: string
  /** Whether the working tree is dirty, and how many paths. */
  dirty?: { tracked: number; untracked: number }
  /** Number of entries in the working directory root. */
  entries?: number
  /** Why the probe could not run, when it could not. */
  unavailable?: string
  /** Unix ms when the probe ran. */
  at: number
}

/**
 * 「进行中」is the column v0.19 did not have.
 *
 * A handoff cut mid-turn has work that is neither DONE (no result yet) nor PENDING
 * (it was already started). Folding it into 待开始 makes the target restart it;
 * folding it into 已完成 makes the target assume it landed. The open turn's own
 * instruction is the only honest source, so it becomes this column verbatim.
 */
/**
 * v0.23 P2 — MEASURE WHAT THE FILESYSTEM SAYS, AT HANDOFF TIME.
 *
 * Read-only, bounded, and failure-tolerant by construction: the handoff must never
 * fail because a `git` binary is missing. A probe that cannot answer records WHY in
 * `unavailable`, because "could not check" and "checked, clean" are different facts
 * and the board must not present them the same way.
 *
 * Why these three probes and no more:
 *   - `rev-parse HEAD` + `log -1` establish WHICH commit the directory is on. That is
 *     the exact claim a board makes ("commit e8da8f6 成功") and the exact thing that
 *     can be a hallucination.
 *   - `status --porcelain` answers "is the work on disk actually committed". A board
 *     that says "done" while 12 files are uncommitted is the common real failure.
 *   - a root listing size is the cheap sanity check that the directory the target will
 *     open is the one the source was working in.
 *
 * Each runs with a short timeout: this happens inside a migrate call, and a hung git
 * process would hold the handoff hostage. Any error is data, not a throw.
 */
export function verifyWorkspace(cwd: string, now: number = Date.now()): BoardVerification {
  const run = (args: string[]): string | undefined => {
    try {
      const out = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      return String(out).trim()
    } catch {
      // Not a repo, git absent, timed out, permission denied: all the same to us.
      return undefined
    }
  }

  let entries: number | undefined
  try {
    entries = readdirSync(cwd).length
  } catch {
    entries = undefined
  }

  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    return { cwd: '(未记录)', unavailable: '源会话没有可用的工作目录', at: now, ...(entries === undefined ? {} : { entries }) }
  }

  const head = run(['rev-parse', '--short', 'HEAD'])
  if (head === undefined) {
    return {
      cwd,
      ...(entries === undefined ? {} : { entries }),
      unavailable: '不是 git 仓库，或没有任何提交',
      at: now,
    }
  }

  const subject = run(['log', '-1', '--pretty=%s'])
  let dirty: { tracked: number; untracked: number } | undefined
  const status = run(['status', '--porcelain'])
  if (status !== undefined) {
    const lines = status.split('\n').filter((line) => line.trim().length > 0)
    // `??` is the porcelain prefix for untracked; everything else is a tracked change.
    dirty = {
      tracked: lines.filter((line) => !line.startsWith('??')).length,
      untracked: lines.filter((line) => line.startsWith('??')).length,
    }
  }

  return {
    cwd,
    head,
    ...(subject === undefined || subject.length === 0 ? {} : { subject }),
    ...(dirty === undefined ? {} : { dirty }),
    ...(entries === undefined ? {} : { entries }),
    at: now,
  }
}

const BOARD_COLUMNS = {
  request: '原始用户要求',
  done: '✅ 已完成',
  doing: '🔄 进行中',
  todo: '⏭️ 待开始',
} as const

export function renderTaskBoard(input: TaskBoardInput): string {
  const lines: string[] = [`## 交接任务看板（第一轮只要读这里）`]
  const request = input.request.replace(/\s+/gu, ' ').trim()
  lines.push(
    `**${BOARD_COLUMNS.request}**：${request.length === 0 ? '（未提取到明确要求，见 goal 消息）' : truncateEnd(request, 300).text}`,
  )

  /**
   * v1.0.2 — THE GOAL IN FORCE, NEXT TO THE GOAL IT STARTED FROM.
   *
   * Both lines are kept on purpose: the original ask is the audit trail (what the human
   * actually wanted), and `currentGoal` is the instruction. Showing only the first is
   * how a chain dragged a narrowed task back to a goal nobody wanted any more; showing
   * only the second hides that the work changed direction at all.
   */
  const currentGoal = input.currentGoal === undefined ? '' : input.currentGoal.replace(/\s+/gu, ' ').trim()
  if (currentGoal.length > 0 && currentGoal !== request) {
    lines.push('', `**当前目标**：${truncateEnd(currentGoal, 300).text}`)
  }
  const revisions = typeof input.goalRevisions === 'number' ? input.goalRevisions : 0
  if (revisions > 0) {
    lines.push(
      '',
      `> ⚠️ 目标曾发生过 ${revisions} 次演进：上面的「原始用户要求」是最初的，**当前目标**才是要做的。演进留痕见 transferred.json 的 goal_evolution。`,
    )
  }

  // ✅ 已完成 — the verifiable result, WITH its seq. An empty board is stated as
  // empty rather than omitted: a missing column reads as "unknown", an explicit
  // "none" reads as "nothing has landed yet", and those are different instructions.
  lines.push('', `**${BOARD_COLUMNS.done}**`)
  if (input.outcome === undefined) {
    lines.push('- 尚无已经验证完成的收尾动作（无提交 / 测试通过 / 落盘证据）。')
  } else {
    lines.push(`- ${input.outcome.text}（seq=${input.outcome.seq}）`)
  }

  // 🔄 进行中 — the open turn, stated as work in flight.
  lines.push('', `**${BOARD_COLUMNS.doing}**`)
  const doing = input.inProgress === undefined ? '' : input.inProgress.replace(/\s+/gu, ' ').trim()
  if (doing.length === 0) {
    lines.push('- 无（断点落在一个已闭合的轮次之间）。')
  } else {
    lines.push(`- ${truncateEnd(doing, 300).text}`)
  }

  // ⏭️ 待开始 — the next action FIRST, rest after. This is the column the ignition
  // prompt points at, so its first item has to be the real next step.
  lines.push('', `**${BOARD_COLUMNS.todo}**`)
  const pending = input.pending.map((item) => item.replace(/\s+/gu, ' ').trim()).filter((item) => item.length > 0)
  if (pending.length === 0) {
    // v0.32 P1: "the written list is finished" is NOT "there is no plan".
    lines.push(
      input.hasWrittenPlan === true
        ? '- 待办清单已全部完成；按上面的「原始用户要求」做最后验证与收尾。'
        : '- 按上面的「原始用户要求」继续推进，并验证结果。',
    )
  } else {
    for (const item of pending.slice(0, 4)) lines.push(`- ${truncateEnd(item, 200).text}`)
    if (pending.length > 4) lines.push(`- 其余 ${pending.length - 4} 项按清单顺序处理。`)
  }

  if (input.unresolvedError !== undefined) {
    // ONE line, with the seq. The body stays in the log, one tool call away.
    lines.push(
      '',
      `**⚠️ 唯一未决阻塞**：${input.unresolvedError.tool} 失败：${input.unresolvedError.text}` +
        `（原文 seq=${input.unresolvedError.seq}；只有后续工作确实卡在它上面时才去读）`,
    )
  }

  for (const note of input.notes ?? []) {
    const trimmed = note.trim()
    if (trimmed.length > 0) lines.push('', trimmed)
  }

  /**
   * v0.23 P2 — THE REFEREE.
   *
   * Everything above is a CLAIM assembled from the conversation. This section is
   * what the filesystem said when asked, and it is labelled as such so the two are
   * never read as the same kind of statement.
   *
   * Rendered even when the probe failed, because "we could not check" is information
   * a target must have: it changes whether the ✅ column may be trusted.
   */
  const v = input.verification
  if (v !== undefined) {
    lines.push('', `**🔍 物理验证（${v.cwd}）**`)
    if (v.unavailable !== undefined) {
      lines.push(`- 未能验证：${v.unavailable}。上面「已完成」是会话里的陈述，未经文件系统确认。`)
    } else {
      if (v.head !== undefined) {
        lines.push(`- git HEAD：\`${v.head}\`${v.subject === undefined ? '' : ` — ${truncateEnd(v.subject, 80).text}`}`)
      } else {
        lines.push('- git：当前目录不是仓库，或没有提交。')
      }
      if (v.dirty !== undefined) {
        const total = v.dirty.tracked + v.dirty.untracked
        lines.push(
          total === 0
            ? '- 工作区：干净（无未提交改动）。'
            : `- 工作区：**有未提交改动**（已跟踪 ${v.dirty.tracked}，未跟踪 ${v.dirty.untracked}）。上面的结论可能基于磁盘上尚未提交的内容。`,
        )
      }
      if (v.entries !== undefined) lines.push(`- 目录根：${v.entries} 个条目。`)
    }
  }

  const stop: string[] = []
  if (input.stopPoint.turn !== undefined) stop.push(`Turn ${input.stopPoint.turn} 已完成`)
  if (input.stopPoint.boundarySeq !== undefined && input.stopPoint.boundarySeq > 0) {
    stop.push(`边界 seq=${input.stopPoint.boundarySeq}`)
  }
  if (input.pointerCount > 0) stop.push(`可回读指针 ${input.pointerCount} 处`)
  if (input.sourceSessionId !== undefined && input.sourceSessionId.length > 0) {
    stop.push(`sourceSessionId=${input.sourceSessionId}`)
  }
  if (stop.length > 0) lines.push('', `**停泊点**：${stop.join(' · ')}`)

  // v0.20: say WHICH TOOL opens the evidence.
  //
  // The board states seq numbers, so it must name the reader for them. v0.19 got
  // this from the prose body's read-back reminder; the board drops that prose, so
  // without this line the target is given coordinates and no way to use them.
  if (input.pointerCount > 0 && input.sourceSessionId !== undefined && input.sourceSessionId.length > 0) {
    lines.push(
      `需要原文时用 graft_read_result(sourceSessionId="${input.sourceSessionId}", seq=…)，` +
        '或用 graft_search_history 先搜后读；不要靠猜。',
    )
  }

  const drops: string[] = []
  if (input.discarded.resolvedErrors > 0) drops.push(`${input.discarded.resolvedErrors} 条已解决的报错`)
  // `errorBodies` counts failures whose BODY is no longer inlined — and that
  // includes the one kept as the blocker, whose body became a single line. So it is
  // NOT reduced by the kept one: "the stack trace was dropped" and "the failure was
  // dropped" are different facts, and this line reports the first.
  if (input.discarded.errorBodies > 0) drops.push(`${input.discarded.errorBodies} 段报错正文（只保留一行摘要）`)
  if (input.discarded.narrationChars > 0) drops.push(`${input.discarded.narrationChars} 字符中间叙述`)
  if (input.discarded.pointerLines > 0) drops.push(`${input.discarded.pointerLines} 行过程指针`)
  if (drops.length > 0) {
    lines.push('', `**已按语义瘦身**：丢弃 ${drops.join('、')}；需要时按上面的 seq 回读原文。`)
  }
  lines.push('', BOARD_TRAILER)

  const text = lines.join('\n')
  // v0.23: the cut is declared in an ATTRIBUTE on a wrapper, never as a bracket line
  // inside the board. `…[看板已到上限]` was a sentence in the middle of the
  // instruction card — indistinguishable from the model's own text, and enough to
  // corrupt any consumer that treated the card as structured data.
  return text.length <= INSTRUCTION_CARD_MAX_CHARS
    ? text
    : wrapTruncated(truncateEnd(text, INSTRUCTION_CARD_MAX_CHARS).text, text.length)
}

/**
 * v0.20: the board's own closing instruction.
 *
 * Deliberately inside the board and not only in the ignition prompt: the ignition
 * prompt is admitted ONCE, while the board is re-read on every turn (it lives in
 * the pending state). A rule that only exists in a one-shot message expires with
 * that message.
 */
export const BOARD_TRAILER =
  '旧会话的历史执行日志和临时错误无需理会——它们只作为回读证据保留。请直接执行上面「⏭️ 待开始」里的待办项。'

export interface InstructionCardInput {
  semantic: SemanticState
  /** The next-action prose (already rendered, already slimmed). */
  body: string
  stopPoint: { turn?: number; boundarySeq?: number }
  sourceSessionId?: string
  pointerCount: number
  /** v0.20: the user's original ask, for the board's first column. */
  request?: string
  /** v0.20: what the open turn already started, for the 进行中 column. */
  inProgress?: string
  /** v0.20: further next actions (openTodos), after the prose body. */
  pending?: readonly string[]
  /**
   * v0.32 P1: a written todo list exists, even when every item is completed.
   *
   * Without this flag an empty `pending` makes the card say "continue the task",
   * which is indistinguishable from "the model's list is finished" — and the
   * prose fallback it used to take could resurrect an older plan.
   */
  hasWrittenPlan?: boolean
  /**
   * v0.23 P2: the measured workspace facts, or the reason they could not be measured.
   *
   * Supplied by the caller rather than probed here, so the card stays a pure renderer
   * (testable without a filesystem) and the probe runs ONCE per handoff rather than
   * once per card render.
   */
  verification?: BoardVerification
  /** v1.0.2: the goal in force NOW (may differ from the original ask). */
  currentGoal?: string
  /** v1.0.2: how many recorded goal changes exist (0 = the goal never moved). */
  goalRevisions?: number
}

/**
 * v0.20: the card, rendered as a board.
 *
 * The prose body produced by `buildPendingState` is still where the "what stopped
 * me and what is the exclusion" nuance lives, so it is carried as a note rather
 * than discarded — but it no longer decides the card's SHAPE. Shape decides
 * behaviour: four labelled columns survive being skimmed, a paragraph does not.
 */
export function renderInstructionCard(input: InstructionCardInput): string {
  const unresolved = input.semantic.unresolvedError
  const pending: string[] = []
  for (const item of input.pending ?? []) {
    const trimmed = item.replace(/\s+/gu, ' ').trim()
    if (trimmed.length > 0 && !pending.includes(trimmed)) pending.push(trimmed)
  }
  const notes: string[] = []
  // The prose body used to BE the card. Now the columns carry the next action, the
  // result and the breakpoint, so most of it is duplication — and a board that
  // restates itself is longer without being clearer. What does not survive in any
  // column is the EXCLUSION ("我刚刚排除了 X") and the read-back reminder, so those
  // lines are lifted out and the rest is dropped.
  //
  // v0.20: the body's own "我接下来需要 X" line is the next action when the model
  // never wrote a todo list, so it MOVES INTO the ⏭️ column instead of being
  // dropped. Dropping it would leave the board with "继续推进" as its only plan —
  // strictly less information than v0.19 had.
  const proseNext: string[] = []
  for (const line of input.body.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const next = /^我接下来需要\s*(?:继续推进，前提是\s*)?(.+?)。?$/u.exec(trimmed)
    if (next !== null && next[1].trim().length > 0) {
      proseNext.push(next[1].trim())
      continue
    }
    // v0.32 P1: the ⏭️ column already carries these when the model wrote a list.
    // Keeping them duplicated the plan inside the same card.
    if ((pending.length > 0 || input.hasWrittenPlan === true) && /^再往后还有[：:]/u.test(trimmed)) continue
    if (input.hasWrittenPlan === true && /^我写的待办清单已全部完成/u.test(trimmed)) continue
    // Stated by 停泊点 / the trailer already.
    if (/^前面提到的那些细节都还留着/u.test(trimmed)) continue
    if (/^如果有不确定的报错或历史代码/u.test(trimmed)) continue
    if (/^直接接着刚才的工作继续即可/u.test(trimmed)) continue
    // Stated by the board's own footer already.
    if (trimmed.startsWith(BOARD_TRAILER)) continue
    notes.push(trimmed)
  }
  // The written plan wins when it exists; the body's line is the fallback.
  // v0.32 P1: a finished written plan is NOT replaced by prose — that fallback
  // could resurrect an older plan, which is the stale-board failure.
  const boardPending =
    pending.length > 0 ? pending : input.hasWrittenPlan === true ? [] : proseNext
  return renderTaskBoard({
    request: input.request ?? '',
    ...(input.semantic.outcome === undefined ? {} : { outcome: input.semantic.outcome }),
    ...(input.inProgress === undefined ? {} : { inProgress: input.inProgress }),
    pending: boardPending,
    ...(input.hasWrittenPlan === true ? { hasWrittenPlan: true } : {}),
    stopPoint: input.stopPoint,
    ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
    pointerCount: input.pointerCount,
    ...(unresolved === undefined ? {} : { unresolvedError: unresolved }),
    discarded: input.semantic.discarded,
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.currentGoal === undefined ? {} : { currentGoal: input.currentGoal }),
    ...(input.goalRevisions === undefined ? {} : { goalRevisions: input.goalRevisions }),
    notes,
  })
}

// ===========================================================================
// v0.19 module 2 — PHYSICAL IGNITION (the target starts itself)
// ===========================================================================

/**
 * v0.19: after the target is durable, START IT — do not wait for a human.
 *
 * THE GAP THIS CLOSES
 *
 * Everything up to v0.18 produced a target that was correct and INERT. It had the
 * goal, the tape, the instruction card and the constraints — and it sat there
 * until somebody clicked it. Meanwhile the session it replaced was already
 * retired, so the work stopped at the exact moment the handoff succeeded. The
 * plugin's own escape hatch (`selfSliceBootstrap`: "无需等待用户确认") was a
 * message to the target, and a message to a target nobody started is not a
 * mechanism.
 *
 * The Host has the channel: `sessionController.prompt(request, signal)` —
 * "Admit one prompt after explicitly resuming its Session". It is what the Web
 * composer calls, it resumes a COLD session from persistence, and it is therefore
 * also what a plugin must use to make a cold target run. This module calls it
 * once, after the target's `flush()` and after the retirement transaction, and
 * records what happened.
 *
 * IDEMPOTENCE AND HONESTY
 *
 *  - The intent is written to `.graft-pending-ignition.json` BEFORE the call and
 *    removed only after it succeeds. A crash between the two leaves a retry.
 *  - A retry first asks the target's own log whether the ignition prompt is
 *    already there. A prompt that was admitted but not acknowledged must not be
 *    admitted twice: a queued duplicate would make the target read the same
 *    instruction as two turns of user intent.
 *  - A failure never fails the migration. The session exists and is loadable; the
 *    outcome is reported (`ignition`) and audited (`ignite` / `ignite-failed`).
 */
export const IGNITION_MARKER = '[dsh-graft-slice 点火]'

/**
 * v0.20: the wake-up says WHICH part of the tape to act on.
 *
 * v0.19 woke the target but left it to work out that the replayed history is
 * context, not assignment. A model handed a tape of a debugging session will often
 * start by re-reading the last stack trace — the very thing the slimming removed
 * from the board. So the prompt names the board as the instruction source and the
 * tape as evidence, and explicitly relieves the target of the old log's temporary
 * errors.
 *
 * Kept in sync with `BOARD_TRAILER` on purpose, but stated in both places: the
 * ignition prompt is the FIRST thing the target reads, and the board is what it
 * re-reads every turn. Either one alone leaves a gap.
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

/** How many activation rounds a failed ignition is retried before giving up. */
export const IGNITION_MAX_ATTEMPTS = 3
/** A prompt that has not been admitted in this long is retried next activation. */
const IGNITION_TIMEOUT_MS = 20_000

// `PLUGIN_DIR` is declared further down, so this path is resolved lazily: reading
// it at module-evaluation time would throw before the module finished loading.
let pendingIgnitionPath = ''

function ignitionPath(): string {
  return pendingIgnitionPath.length > 0 ? pendingIgnitionPath : join(PLUGIN_DIR, '.graft-pending-ignition.json')
}

const pendingIgnitions = new Map<string, PendingIgnition>()
/**
 * v0.21: sources already told about a rollback, in this process.
 *
 * Both the single-shot path and the queue path can reach the rollback for the same
 * migration; without this, the user gets the same notice twice and reads it as two
 * separate failures.
 */
const rollbackNoticed = new Set<string>()

export function buildIgnitionPrompt(settings: Pick<Required<GraftConfig>, 'ignitionPrompt'>): string {
  const custom = settings.ignitionPrompt.trim()
  if (custom.length === 0) return DEFAULT_IGNITION_PROMPT
  return custom.startsWith(IGNITION_MARKER) ? custom : `${IGNITION_MARKER} ${custom}`
}

/** Is this user message the plugin's own ignition, rather than something a human typed? */
export function isIgnitionText(text: string): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(IGNITION_MARKER)
}

export function loadPendingIgnitions(ctx: PluginContextLike | undefined): void {
  try {
    for (const value of readJsonArray(ignitionPath())) {
      if (!isRecord(value)) continue
      const targetId = typeof value.targetId === 'string' ? value.targetId : ''
      if (targetId.length === 0) continue
      pendingIgnitions.set(targetId, {
        targetId,
        sourceSessionId: typeof value.sourceSessionId === 'string' ? value.sourceSessionId : '',
        at: Number(value.at ?? 0),
        attempts: Number(value.attempts ?? 0),
      })
    }
  } catch (error) {
    try {
      ctx?.logger?.warn?.(`[dsh-graft-slice] cannot read ${ignitionPath()}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not block activation.
    }
  }
}

function persistPendingIgnitions(ctx: PluginContextLike | undefined): void {
  try {
    mkdirSync(dirname(ignitionPath()), { recursive: true })
    writeJsonAtomic(ignitionPath(), [...pendingIgnitions.values()])
  } catch (error) {
    try {
      ctx?.logger?.warn?.(`[dsh-graft-slice] cannot write ${ignitionPath()}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the migration result.
    }
  }
}

export function getPendingIgnitions(): ReadonlyMap<string, PendingIgnition> {
  return pendingIgnitions
}

/**
 * v0.22 P0: per-TARGET ignition bookkeeping, keyed by targetId.
 *
 * THE ROUTING BUG THIS PREVENTS
 *
 * "Already ignited" used to be decided only by re-reading the target's log. That is
 * correct but not sufficient: two grafts that finish within the same tick both read
 * "not ignited" before either prompt lands, so both call `prompt` — and a target that
 * receives the same instruction twice reads it as two separate turns of user intent.
 *
 * Worse, any state shared across targets (a single "last ignited id", a boolean) would
 * let session A's admission mark session B as already started: A's instruction is
 * effectively delivered to nobody while B never gets one. So this map is keyed by the
 * TARGET and every read/write names that key explicitly — there is no code path that
 * consults ignition state without saying which target it is about.
 */
const ignitionAdmissions = new Map<string, { at: number; promptChars: number }>()

/** Has THIS target been admitted an ignition prompt in this process? */
export function hasIgnitionAdmission(targetId: string): boolean {
  return ignitionAdmissions.has(targetId)
}

/** Record that a prompt was admitted for THIS target (never for another one). */
export function markIgnitionAdmission(targetId: string, promptChars: number): void {
  ignitionAdmissions.set(targetId, { at: Date.now(), promptChars })
}

/** Test/diagnostic view: the admissions recorded in this process, per target. */
export function getIgnitionAdmissions(): ReadonlyMap<string, { at: number; promptChars: number }> {
  return ignitionAdmissions
}

/**
 * Does this error mean "that session is not there", as opposed to "I could not read it"?
 *
 * 0.2.2's Remote error code is `session/not-found` — hyphenated — so the old
 * `/not found/` test missed the exact case it was written for.
 */
const SESSION_MISSING = /session\/not[\s_-]?found|not[\s_-]found|enoent|no such/iu

/** Does the target's own log already carry the ignition prompt? */
async function alreadyIgnited(ctx: PluginContextLike, targetId: string): Promise<boolean> {
  // The in-process admission is checked FIRST: it is the only signal that covers the
  // window between "prompt accepted" and "prompt visible in the target's log".
  if (ignitionAdmissions.has(targetId)) return true
  try {
    const raw = await ctx.sessionQuery.readSession(targetId)
    const events = Array.isArray((raw as any)?.events) ? ((raw as any).events as SessionEventLike[]) : []
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      if (isIgnitionText(textOfMessage(event.data))) return true
    }
    return false
  } catch (error) {
    const message = String((error as any)?.message ?? error)
    // Two different failures, two different answers:
    //  - the session does not exist -> it was certainly not ignited; prompt (the
    //    resume inside `prompt` is what creates the live agent);
    //  - anything else (transient I/O, a service proxy that refuses reads) -> UNKNOWN.
    //
    // v0.32 P0: an unknown used to return `true`, i.e. "already ignited". That turned a
    // failed READ into a reported SUCCESS, so the queue entry was deleted and the target
    // was never woken — the silent no-op this module promises never to produce. (It also
    // explains a real `ignite … ok (already ignited)` audit line for a target whose log
    // had no ignition event: the not-found test did not match `session/not-found`, the
    // Remote's hyphenated code.) Unknown must now be reported as a failure so the
    // durable intent survives to the next activation.
    if (SESSION_MISSING.test(message)) return false
    throw new Error(`cannot read target log: ${message}`)
  }
}

/**
 * v0.19: the one call that turns a durable artifact into a running worker.
 *
 * Channels are tried in order and REPORTED: `sessionController.prompt` is the Host
 * service (what the composer uses); `remote.session.prompt` is the same operation
 * through the generated Remote namespace, for a composition where only that face is
 * mounted. No channel means the capability is absent, which is reported as such —
 * never as a silent no-op.
 */
/**
 * v0.32 P0 — THE 0.2.2 SIGNAL CONTRACT, WHICH v0.31 VIOLATED.
 *
 * In 0.2.2-rc.1 `sessionController.prompt(request, signal)` takes the AbortSignal as a
 * REQUIRED second argument and touches it on the first line
 * (`signal.throwIfAborted()`, for caller cancellation before prompt admission).
 * v0.31 passed `undefined` there, so every ignition died before the prompt was ever
 * admitted:
 *
 *   sessionController.prompt: Cannot read properties of undefined (reading 'throwIfAborted')
 *
 * The target stayed durable and permanently inert, the source was already retired, and
 * the only trace was one audit line — the "no auto wake-up" the user saw. The signal is
 * now built for every channel, and its abort is also the timeout, so a prompt that never
 * settles leaves an ABORTED signal behind instead of a dangling promise race.
 */
function ignitionDeadline(): { signal: AbortSignal; release: () => void; expired: Promise<never> } {
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
  // The race loser's rejection must not surface as an unhandled one when the prompt
  // settled first and `release()` cleared the timer.
  expired.catch(() => {})
  return { signal: controller.signal, release: () => clearTimeout(timer), expired }
}

/**
 * Is the target already RUNNING, as the Host itself defines it?
 *
 * Used only on the retry path. A retried ignition must never re-instruct a target that
 * is already live: either our earlier prompt did land (and its marker is in the log) or
 * a human opened the target and took over. Prompting again in that window reads to the
 * target as the same instruction given twice, and treating it as a failure would fire
 * the rollback that resurrects a retired source.
 */
async function targetAlreadyLive(ctx: PluginContextLike, targetId: string): Promise<boolean> {
  try {
    const service = (ctx.get as any)?.('sessionController')
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
 * Only meaningful on the retry path, and only when the mark recorded how many events
 * the tape had. A cold target that nobody touched still ends exactly at that count.
 */
async function targetAlreadyDriven(ctx: PluginContextLike, targetId: string): Promise<boolean> {
  const mark = graftTargets.get(targetId)
  if (mark === undefined || typeof mark.seedEvents !== 'number') return false
  try {
    const raw = await ctx.sessionQuery.readSession(targetId)
    const events = Array.isArray((raw as any)?.events) ? ((raw as any).events as unknown[]) : []
    return events.length > mark.seedEvents
  } catch {
    return false
  }
}

export async function igniteTargetSession(
  ctx: PluginContextLike,
  settings: Required<GraftConfig>,
  targetId: string,
  sourceSessionId: string,
  options: { retry?: boolean } = {},
): Promise<IgnitionResult> {
  if (!settings.igniteTarget) return { attempted: false, ok: false, reason: 'igniteTarget=false' }
  const prompt = buildIgnitionPrompt(settings)
  // v0.32: the retry path asks the HOST for liveness FIRST, because a target that is
  // running makes the log read below unreliable (a live log mid-turn can fail replay
  // validation), and "I could not read it" must not become "it was never woken".
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
    if (await alreadyIgnited(ctx, targetId)) {
      return { attempted: false, ok: true, alreadyIgnited: true, promptChars: prompt.length }
    }
  } catch (error) {
    // v0.32: an unreadable log is UNKNOWN, and an unknown is reported as a failure so
    // the queued intent survives — never as "already ignited".
    return {
      attempted: false,
      ok: false,
      reason: String((error as any)?.message ?? error),
      promptChars: prompt.length,
    }
  }
  if (options.retry === true && (await targetAlreadyDriven(ctx, targetId))) {
    return {
      attempted: false,
      ok: true,
      alreadyIgnited: true,
      channel: 'graft-targets.seedEvents',
      reason: 'target already driven past its seed',
      promptChars: prompt.length,
    }
  }
  const request = (): Record<string, unknown> => ({
    requestId: `graft-ignite-${targetId}-${Date.now().toString(36)}`,
    sessionId: targetId,
    mode: settings.ignitionMode,
    content: [{ type: 'text', text: prompt }],
  })
  const channels: Array<[string, (signal: AbortSignal) => Promise<unknown>]> = []
  const service = (() => {
    try {
      return (ctx.get as any)?.('sessionController')
    } catch {
      return undefined
    }
  })()
  if (isRecord(service) && typeof (service as any).prompt === 'function') {
    // v0.32: the signal is the second argument the Host requires, not an optional extra.
    channels.push(['sessionController.prompt', (signal) => (service as any).prompt(request(), signal)])
  }
  const remote = (() => {
    try {
      return (ctx.get as any)?.('remote')
    } catch {
      return undefined
    }
  })()
  const remoteSession = isRecord(remote) ? (remote as any).session : undefined
  if (remoteSession !== undefined && typeof remoteSession.prompt === 'function') {
    channels.push(['remote.session.prompt', (signal) => remoteSession.prompt(request(), signal)])
  }
  if (channels.length === 0) {
    return {
      attempted: false,
      ok: false,
      reason: 'no ignition channel: ctx.sessionController.prompt is not mounted',
    }
  }
  const failures: string[] = []
  const { signal, release, expired } = ignitionDeadline()
  try {
    for (const [label, run] of channels) {
      try {
        const settled = await Promise.race([run(signal), expired])
        const accepted = isRecord(settled) ? (settled as any).accepted !== false : true
        if (accepted) {
          // v0.22 P0: record the admission for THIS target before returning, so a second
          // concurrent attempt cannot slip through the window before the prompt is
          // visible in the target's own log.
          markIgnitionAdmission(targetId, prompt.length)
          return { attempted: true, ok: true, channel: label, promptChars: prompt.length }
        }
        failures.push(`${label}: prompt was not accepted`)
      } catch (error) {
        failures.push(`${label}: ${describePromptFailure(error, signal)}`)
      }
    }
  } finally {
    release()
  }
  return { attempted: true, ok: false, reason: failures.join(' | '), promptChars: prompt.length }
}

/**
 * v0.32: say WHY the prompt died, in the one line the audit keeps.
 *
 * A bare `AbortError` hides the interesting case: the Host aborted because the session
 * was busy or its writer was held, which is retryable, versus our own deadline, which
 * is not a fact about the target at all.
 */
function describePromptFailure(error: unknown, signal: AbortSignal): string {
  const message = String((error as any)?.message ?? error)
  if (signal.aborted) {
    const reason = (signal as any).reason
    const why = typeof reason === 'string' ? reason : String((reason as any)?.message ?? 'deadline')
    return `${message} (aborted: ${why})`
  }
  return message
}

/**
 * v0.19: queue -> ignite -> clear. The durable intent is what makes a crash
 * between "the target is on disk" and "the target is running" recoverable.
 */
export async function attemptIgnition(
  ctx: PluginContextLike,
  settings: Required<GraftConfig>,
  sourceSessionId: string,
  targetId: string,
  options: { retry?: boolean } = {},
): Promise<IgnitionResult> {
  if (!settings.igniteTarget) return { attempted: false, ok: false, reason: 'igniteTarget=false' }
  const existing = pendingIgnitions.get(targetId)
  pendingIgnitions.set(targetId, {
    targetId,
    sourceSessionId,
    at: existing?.at ?? Date.now(),
    attempts: existing?.attempts ?? 0,
  })
  persistPendingIgnitions(ctx)
  const result = await igniteTargetSession(ctx, settings, targetId, sourceSessionId, options)
  if (result.ok) {
    pendingIgnitions.delete(targetId)
    persistPendingIgnitions(ctx)
  } else {
    const entry = pendingIgnitions.get(targetId)
    if (entry !== undefined) {
      pendingIgnitions.set(targetId, { ...entry, attempts: entry.attempts + 1 })
      persistPendingIgnitions(ctx)
    }
  }
  try {
    appendGraftAudit({
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

/**
 * v0.21 P0 — the DOUBLE-BLIND ROLLBACK.
 *
 * THE FAILURE THIS PREVENTS, AND WHY IT IS THE WORST ONE
 *
 * The migration retires the source BEFORE it ignites the target, because the whole
 * point is that the user stops typing into a session that is about to be replaced.
 * So for a window the system is deliberately one-sided: the source is frozen and
 * the target is the only way forward.
 *
 * If the ignition then fails — no channel, a throwing prompt, a 20s timeout, three
 * activation rounds of the same — that window never closes. The source is retired,
 * so its pre-step returns `{kind:'reject'}` and the user cannot continue there; the
 * target is durable but inert, so nothing happens there either. Both sessions are
 * alive on disk and NEITHER accepts work. That is the double-blind state: not a lost
 * migration, a lost SESSION.
 *
 * So the last resort is an UN-RETIRE: put the source back exactly as it was before
 * the migration (out of `.retired.json`, out of `.transferred.json`, and out of the
 * in-memory sets), tell it in its own log why it is back, and let the user retry.
 *
 * Deliberately NOT attempted when the target did wake up: a rollback that fires on
 * a successful ignition would resurrect a session the user has already left, which
 * is the "two divergent targets" failure the retirement machinery exists to stop.
 */
export const ROLLBACK_NOTICE_MARKER = '[dsh-graft-slice 回滚]'

export const ROLLBACK_NOTICE =
  `${ROLLBACK_NOTICE_MARKER} 由于新会话点火失败，已为您自动回滚到当前会话，请重试切片。`

/**
 * v0.21 P0: the TRUE un-retire.
 *
 * `persistRetiredStore(ctx, [id])` is not enough, and the reason is subtle: the write
 * path is a read-modify-write that ADOPTS the file's contents back into memory (which
 * is correct for merging two processes' retirements). So a removal that runs before
 * the file is rewritten can be undone by that same adopt pass on the next write — the
 * id comes back from disk and the session is frozen again, durably, on the next
 * restart. The rollback would look successful in memory and be a no-op on disk.
 *
 * This function does the removal in the only order that holds: remove from the file
 * under the lock, and make the in-memory set agree with the file afterwards.
 */
function unRetireDurably(ctx: PluginContextLike, sessionId: string): boolean {
  let restored = false
  try {
    mkdirSync(dirname(retiredStorePath), { recursive: true })
    withFileLock(retiredStorePath, () => {
      const remaining = new Set(
        ledgerArray(retiredStorePath).filter((value): value is string => typeof value === 'string'),
      )
      remaining.delete(sessionId)
      writeLedgerAtomic(retiredStorePath, [...remaining].sort())
      // The memory set is made to AGREE with the file, not merged into: after an
      // explicit removal, "the file does not have it" is the authoritative answer.
      retiredSessions.delete(sessionId)
      restored = !remaining.has(sessionId)
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] un-retire write failed for ${sessionId}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the rollback result.
    }
    return false
  }
  try {
    mkdirSync(dirname(transferredStorePath), { recursive: true })
    withFileLock(transferredStorePath, () => {
      const remaining = { ...(ledgerRecord(transferredStorePath) as Record<string, unknown>) }
      delete remaining[sessionId]
      writeLedgerAtomic(transferredStorePath, remaining)
      transferredSessions.delete(sessionId)
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] un-retire transfer write failed for ${sessionId}: ${String((error as any)?.message ?? error)}`,
      )
    } catch {
      // Logging must not change the rollback result.
    }
  }
  // Belt and braces for the in-memory gate the pre-step actually reads.
  //
  // The pre-step consults FOUR per-session marks, not just the two ledgers: the
  // retired set, the transferred map, the auto-graft STATE machine, and the deferred
  // graft queue. Clearing only the ledgers leaves `autoGraftStates === 'done'`, which
  // returns `reason: 'Transferred'` forever — the session would be un-retired on disk
  // and still frozen in the running process, which is the same double-blind one layer
  // down.
  retiredSessions.delete(sessionId)
  transferredSessions.delete(sessionId)
  autoGraftStates.delete(sessionId)
  autoGraftInFlight.delete(sessionId)
  pendingGraftSources.delete(sessionId)
  pendingConfirms.delete(sessionId)
  // The "this id is a target we created" mark belongs to the TARGET, and a rollback
  // ends that relationship: the source is a plain session again and must not inherit
  // the target's grace-window protection.
  graftTargets.delete(sessionId)
  return restored || !retiredSessions.has(sessionId)
}

export interface IgnitionRollback {
  attempted: boolean
  sourceRestored: boolean
  noticeAppended: boolean
  /** Target left in place and marked, so it is visible but not picked up. */
  targetId: string
  reason?: string
}

/**
 * v0.21: undo a migration whose target never started.
 *
 * Order matters: the ledgers are restored FIRST, because an in-memory-only rollback
 * dies on the next restart and leaves the user exactly as stuck as before.
 */
export async function rollbackFailedIgnition(
  ctx: PluginContextLike,
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
    retiredSessions.delete(sourceSessionId)
    transferredSessions.delete(sourceSessionId)
    // v0.21: durable, in the order that survives a restart — see `unRetireDurably`.
    out.sourceRestored = unRetireDurably(ctx, sourceSessionId)
  } catch (error) {
    out.reason = `${reason}; ledger rollback failed: ${String((error as any)?.message ?? error)}`
  }
  // Tell the human, in the session they will actually be looking at. A rollback that
  // is only visible in an audit file reads as "nothing happened, try again" — and
  // repeating the same failed migration is the wrong next move.
  //
  // v0.21: written at most ONCE per source. Both the single-shot path (this call
  // exhausted the budget) and the queue path (a restart found the budget spent) can
  // reach here for the same migration, and two identical notices read as two
  // separate failures.
  if (rollbackNoticed.has(sourceSessionId)) {
    out.noticeAppended = true
  } else {
    try {
      const live = ctx.sessions.get(sourceSessionId) as any
      if (live !== undefined && typeof live.append === 'function') {
        live.append('developer/message', {
          turn: 0,
          step: 0,
          message: {
            id: `graft-rollback-${sourceSessionId}-${Date.now().toString(36)}`,
            role: 'developer',
            content: [{ type: 'text', text: ROLLBACK_NOTICE }],
          },
        })
        rollbackNoticed.add(sourceSessionId)
        out.noticeAppended = true
      }
    } catch (error) {
      out.reason = `${out.reason ?? reason}; notice failed: ${String((error as any)?.message ?? error)}`
    }
  }
  // The target stays on disk — it may be perfectly good and just un-wakeable — but it
  // must not look like the session to continue. A title is visible and survives a
  // reload; the retirement of the source is what actually stops the split.
  //
  // The target is a DURABLE artifact, not a live session: nobody has resumed it, which
  // is the whole problem. So the mark is appended through sessionPersistence when a
  // live handle is absent, and a failure to mark is reported rather than hidden.
  try {
    const target = ctx.sessions.get(targetId) as any
    if (target !== undefined && typeof target.append === 'function') {
      target.append('session/title', {
        title: `[点火失败] ${targetId}`,
        messageSeqs: [],
        source: { kind: 'user' },
      })
    } else {
      const persistence = (ctx.get as any)?.('sessionPersistence')
      if (isRecord(persistence) && typeof persistence.open === 'function') {
        const handle = await persistence.open(targetId)
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
    appendGraftAudit({
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
 * v0.21: has this target exhausted its ignition budget?
 *
 * `IGNITION_MAX_ATTEMPTS` activation rounds is the contract the user asked for (20s
 * timeout x 3). Kept as a predicate so the rollback decision is testable without
 * waiting for a timer.
 */
export function ignitionExhausted(entry: PendingIgnition | undefined): boolean {
  return entry !== undefined && entry.attempts >= IGNITION_MAX_ATTEMPTS
}

export interface IgnitionAttemptWithRollback extends IgnitionResult {
  /** Present when the attempt exhausted its budget and the source was restored. */
  rollback?: IgnitionRollback
}

/**
 * v0.19: consume the queue — one activation, one attempt per pending target.
 *
 * Called at the end of `apply()`. It retries what a crash or a missing channel left
 * behind, and it GIVES UP after `IGNITION_MAX_ATTEMPTS` instead of retrying forever:
 * a target nobody can start is a fact to report, not a loop.
 *
 * v0.21: giving up now means ROLLING BACK. Before this, "gave up" deleted the queue
 * entry and left the source retired — the double-blind state, permanently.
 */
export async function resumePendingIgnitions(
  ctx: PluginContextLike,
  settings: Required<GraftConfig>,
): Promise<Array<{ targetId: string; ok: boolean; reason?: string; rollback?: IgnitionRollback }>> {
  const out: Array<{ targetId: string; ok: boolean; reason?: string; rollback?: IgnitionRollback }> = []
  for (const entry of [...pendingIgnitions.values()]) {
    if (!settings.igniteTarget) break
    if (ignitionExhausted(entry)) {
      pendingIgnitions.delete(entry.targetId)
      persistPendingIgnitions(ctx)
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
    out.push({ targetId: entry.targetId, ok: result.ok, ...(result.reason === undefined ? {} : { reason: result.reason }) })
  }
  return out
}

/**
 * v7.0 A1/A2: render one turn as a replay of the real conversation flow.
 *
 * Why not prose: v6.x flattened each turn into a paragraph of assistant
 * narration with tool pointers woven in. The target read "I did X, then Y" — a
 * work log — and had to infer what it had been asked. Worse, the user's actual
 * instruction was not present at all, so a directive like "only change the CSS,
 * never touch the JSX" left no trace and was violated on the next edit.
 *
 * The replay keeps the two roles distinct, because that distinction is what
 * carries intent:
 *
 *   [Turn 4]  ← the turn number is the anchor for graft_read_result
 *   【用户】…verbatim…
 *   【我】…assistant text, with tool pointers inline…
 *
 * Tool results stay as pointers rather than bodies. That is deliberate: the
 * pointer names a seq, and re-reading a full result is one tool call away,
 * while carrying every body would spend the budget that the verbatim user text
 * needs.
 */
/**
 * Test-only entry point for the goal extractor.
 *
 * `extractGoal` stays module-private because it is an implementation detail of
 * `buildTape`; veiling it behind a named export keeps the unit test honest
 * (it exercises the real function, not a copy) without widening the plugin's
 * public surface for production callers.
 */
export function extractGoalForTest(events: readonly SessionEventLike[]): GoalResult {
  return extractGoal(events)
}

/**
 * v7.0 (adopted from dsh-rollover-snapshot): render one turn with a reachable seq.
 *
 * rollover-snapshot renders its verbatim block as
 * `- User (seq 118): ...` / `- Assistant (seq 121): ...` — every quoted line
 * names the seq that can be handed straight to `history`. The graft tape
 * previously printed only `[Turn 12]`, which tells the reader WHERE in the
 * conversation it is but not HOW to read the original.
 *
 * The distinction matters: a reader who wants the full tool output behind a
 * replay line has no way to ask for it, so it either guesses or re-runs the
 * work. Naming the seq turns every replay line into a retrieval handle, at the
 * cost of about ten characters.
 *
 * `neutralizeStructure` guards the quoted text: a user message containing
 * "## Handoff" or "```" must not become a section of our own layout.
 */
function renderReplayTurn(
  turn: number,
  userTexts: readonly string[],
  assistantText: string,
  userSeq?: number,
  assistantSeq?: number,
): string {
  const lines: string[] = [`[Turn ${turn}]`]
  for (const userText of userTexts) {
    const trimmed = userText.trim()
    if (trimmed.length === 0) continue
    const at = userSeq === undefined ? '' : ` (seq ${userSeq})`
    lines.push(`【用户${at}】${neutralizeStructure(trimmed)}`)
  }
  const body = assistantText.trim()
  if (body.length > 0) {
    const at = assistantSeq === undefined ? '' : ` (seq ${assistantSeq})`
    lines.push(`【我${at}】${neutralizeStructure(body)}`)
  }
  return lines.join('\n')
}

/**
 * Phase 2: extract closed turns up to the boundary.
 *
 * assistant/chunk, turn/*, step/*, assistant/attempt are not tape material.
 * assistant/message contributes text. tool/call + tool/result become pointer
 * text embedded in the adjacent assistant body; tool/result is never emitted
 * as its own event later.
 */
export function buildTape(
  events: readonly SessionEventLike[],
  boundary: GraftBoundary,
  config: GraftConfig,
  sourceSessionId?: string,
  openTodos: readonly string[] = [],
  availableTools?: ReadonlySet<string>,
  /**
   * v0.23 P2: the workspace the card's physical-verification section describes.
   *
   * Optional and injected rather than read from `process.cwd()`: `buildTape` is a
   * pure function over a log, and a renderer that silently probed whatever directory
   * the HOST happened to be in would report the truth about the WRONG project — worse
   * than reporting nothing. Absent = no verification section, which the card states
   * honestly.
   */
  workspaceCwd?: string,
  /**
   * v0.32 P1: a todo_write exists, even when every item is already completed.
   *
   * "no open items" and "no written plan" are different states. Conflating them
   * made the board fall back to prose, which could quote a plan from an older
   * turn — the "old P1-1/P1-2" symptom — instead of reporting that the written
   * plan is finished.
   */
  hasWrittenPlan = false,
): GraftTape {
  const sliced = events.filter((event) => Number(event.seq) <= boundary.boundarySeq)
  const calls = new Map<string, CallRecord>()
  const turns = new Map<number, TurnDraft>()
  let currentTurn: number | undefined
  /** v7.0 P5: how many of our own replays were seen and refused (reported, not silent). */
  let replayedMessagesSkipped = 0

  const ensureTurn = (turn: number): TurnDraft => {
    let draft = turns.get(turn)
    if (draft === undefined) {
      draft = { turn, assistant: [], user: [] }
      turns.set(turn, draft)
    }
    return draft
  }

  for (const event of sliced) {
    if (event.type === 'turn/start') {
      currentTurn = asSafeInteger(event.data?.turn, 'turn/start.turn')
      ensureTurn(currentTurn)
      continue
    }
    if (event.type === 'user/message') {
      // v6.3: attachments must not vanish. A user message that carried an image
      // or file becomes a natural-language pointer on the current turn.
      const pointers = extractAttachmentPointers(event.data?.message)
      if (pointers.length > 0) {
        const turnValue =
          typeof event.data?.turn === 'number' && Number.isSafeInteger(event.data.turn)
            ? event.data.turn
            : currentTurn
        if (typeof turnValue === 'number') {
          const draft = ensureTurn(turnValue)
          let target = draft.assistant[draft.assistant.length - 1]
          if (target === undefined) {
            target = { seq: Number(event.seq), text: '', callIds: [], pointers: [], toolPointers: [] }
            draft.assistant.push(target)
          }
          for (const pointer of pointers) {
            if (!target.pointers.includes(pointer)) target.pointers.push(pointer)
          }
        }
      }
      // v7.0 A1/A2: keep the user's own words.
      //
      // v6.x dropped this branch entirely (`continue` after attachments), so a
      // target inherited the assistant's narration but never the instruction it
      // was answering. Measured on session-legacy-fixture: 42 substantive user
      // messages in, 1 recoverable from the tape. The model was reading a work
      // log of a conversation it could not see.
      //
      // Only genuine user turns are replayed. Two shapes are excluded because
      // they are host plumbing, not intent: `runtime-context` snapshots (cwd,
      // sandbox policy, time) and the compaction checkpoint, whose replacement
      // message is a summary rather than something the user said.
      // v7.0 P5: a replay is never evidence of what the user said.
      //
      // The check must come FIRST, before the sourceKind test below, because a
      // replay is a `plugin:graft-replay` message and would otherwise be
      // rejected as "host plumbing" — which is right by accident, not by
      // intent. Stating it separately keeps the rule legible: it is not that we
      // ignore plugin messages in general, it is that OUR OWN recordings are
      // not the conversation.
      if (isGraftAuthored(event.data?.source)) {
        replayedMessagesSkipped += 1
        continue
      }
      const source = event.data?.source
      const sourceKind = typeof source?.kind === 'string' ? source.kind : 'user'
      const hostAuthored =
        sourceKind !== 'user' || (typeof source?.kind === 'string' && source.kind === 'compact-checkpoint')
      if (!hostAuthored) {
        const userText = normalizeText(textOfMessage(event.data) ?? '').trim()
        if (userText.length > 0) {
          const turnValue =
            typeof event.data?.turn === 'number' && Number.isSafeInteger(event.data.turn)
              ? event.data.turn
              : currentTurn
          if (typeof turnValue === 'number') {
            ensureTurn(turnValue).user.push({ seq: Number(event.seq), text: userText })
          }
        }
      }
      continue
    }
    if (event.type === 'assistant/message') {
      const turnValue = event.data?.turn ?? currentTurn
      if (typeof turnValue !== 'number' || !Number.isSafeInteger(turnValue)) continue
      const draft = ensureTurn(turnValue)
      const message = event.data?.message
      const text = textOfMessage(message)
      const callIds: string[] = []
      const content = Array.isArray(message?.content) ? message.content : []
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool-call') continue
        if (typeof block.id !== 'string' || block.id.length === 0) continue
        callIds.push(block.id)
        const existing = calls.get(block.id)
        calls.set(block.id, {
          callId: block.id,
          name: typeof block.name === 'string' && block.name.length > 0 ? block.name : existing?.name ?? 'unknown',
          turn: turnValue,
          step: typeof event.data?.step === 'number' ? event.data.step : existing?.step ?? 0,
          callSeq: existing?.callSeq ?? Number(event.seq),
          ...(existing?.resultSeq === undefined ? {} : { resultSeq: existing.resultSeq }),
        })
      }
      draft.assistant.push({
        seq: Number(event.seq),
        text,
        callIds,
        pointers: [],
        toolPointers: [],
      })
      continue
    }
    if (event.type === 'tool/call') {
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : undefined
      if (callId === undefined || callId.length === 0) continue
      const existing = calls.get(callId)
      calls.set(callId, {
        callId,
        name: typeof event.data?.name === 'string' && event.data.name.length > 0 ? event.data.name : existing?.name ?? 'unknown',
        turn: typeof event.data?.turn === 'number' ? event.data.turn : existing?.turn ?? currentTurn ?? 0,
        step: typeof event.data?.step === 'number' ? event.data.step : existing?.step ?? 0,
        callSeq: existing?.callSeq ?? Number(event.seq),
        ...(existing?.resultSeq === undefined ? {} : { resultSeq: existing.resultSeq }),
      })
      continue
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message
      const callId = message?.toolCallId ?? message?.source?.callId
      if (typeof callId !== 'string' || callId.length === 0) continue
      const existing = calls.get(callId)
      const resultText = textOfMessage(message)
      const isError =
        message?.isError === true ||
        event.data?.error !== undefined ||
        /^\s*(error|dsh:\s*error)\b/iu.test(resultText)
      const exitMatch = /exit\s*(?:code)?\s*[:=]?\s*(\d{1,3})\b/iu.exec(resultText)
      calls.set(callId, {
        callId,
        name: existing?.name ?? 'unknown',
        turn: typeof event.data?.turn === 'number' ? event.data.turn : existing?.turn ?? currentTurn ?? 0,
        step: typeof event.data?.step === 'number' ? event.data.step : existing?.step ?? 0,
        callSeq: existing?.callSeq ?? Number(event.seq),
        resultSeq: Number(event.seq),
        ...(isError ? { isError: true } : {}),
        ...(isError && exitMatch !== null ? { exitCode: Number(exitMatch[1]) } : {}),
      })
    }
  }

  // Embed pointers only where a real result exists; an unresolved call is not
  // turned into an orphan tool/result and does not create a fake seq.
  for (const call of calls.values()) {
    if (call.resultSeq === undefined) continue
    // v6.4 F3: a tool the target does not have must not be advertised as
    // callable. The history is real, so the pointer survives in downgraded form.
    const draft = turns.get(call.turn)
    if (draft === undefined) continue
    let target =
      [...draft.assistant].reverse().find((assistant) => assistant.callIds.includes(call.callId)) ??
      draft.assistant[draft.assistant.length - 1]
    if (target === undefined) {
      target = { seq: call.callSeq, text: '', callIds: [], pointers: [], toolPointers: [] }
      draft.assistant.push(target)
    }
    // v7.4 P4-1: keep the pointer structured; the prose is rendered once per run.
    if (!target.toolPointers.some((item) => item.seq === call.resultSeq)) {
      target.toolPointers.push({
        name: call.name,
        seq: call.resultSeq,
        ...(call.isError === true ? { isError: true } : {}),
        ...(availableTools !== undefined && !availableTools.has(call.name) ? { unavailable: true } : {}),
      })
    }
  }

  const tapeTurns: GraftTapeTurn[] = []
  let pointerCount = 0
  const ordered = [...turns.values()].sort((left, right) => left.turn - right.turn)
  for (const draft of ordered) {
    const pieces: string[] = []
    let assistantMessages = 0
    let turnPointers = 0
    const seqs: number[] = []
    for (const user of draft.user) seqs.push(user.seq)
    for (const assistant of draft.assistant) {
      assistantMessages += 1
      seqs.push(assistant.seq)
      turnPointers += assistant.pointers.length + assistant.toolPointers.length
      // Oversized inline code becomes a pointer; the full body stays in the
      // source log and is recoverable through graft_read_result lineRange.
      const pointerized = pointerizeCodeBlocks(assistant.text.trim(), assistant.seq, sourceSessionId)
      turnPointers += pointerized.pointers.length
      const body = pointerized.text
      // v7.4 P4-1（方案 B）: tool pointers collapse into one line per contiguous
      // run; attachment pointers stay as their own sentences.
      const pointers = [renderPointerLines(assistant.toolPointers), ...assistant.pointers]
        .filter((line) => line.length > 0)
        .join('\n')
      const piece = [body, pointers].filter(Boolean).join('\n\n')
      if (piece.length > 0) pieces.push(piece)
    }
    const text = normalizeText(pieces.join('\n\n'))
    const userTexts = draft.user.map((entry) => entry.text)
    // v7.0 A1/A2: a turn with neither side is nothing to replay.
    if (text.length === 0 && userTexts.length === 0) continue
    pointerCount += turnPointers
    tapeTurns.push({
      turn: draft.turn,
      text,
      assistantMessages,
      pointers: turnPointers,
      firstSeq: seqs.length > 0 ? Math.min(...seqs) : 0,
      lastSeq: seqs.length > 0 ? Math.max(...seqs) : 0,
      userTexts,
      assistantText: text,
      replay: renderReplayTurn(
        draft.turn,
        userTexts,
        text,
        draft.user[0]?.seq,
        draft.assistant[0]?.seq,
      ),
    })
  }

  const goal = extractGoal(sliced)
  const lastTurnText = tapeTurns.length > 0 ? tapeTurns[tapeTurns.length - 1].text : ''
  // v7.4b (硬约束 4): what the OPEN turn had already sent when the tape was cut.
  //
  // Only calls past the boundary count: earlier ones belong to closed turns and
  // are already reflected in the todo snapshot's own state.
  let lastOpenCall: { tool: string; seq: number } | undefined
  for (const event of events) {
    if (Number(event.seq) <= boundary.boundarySeq) continue
    if (event.type !== 'tool/call') continue
    const name = typeof event.data?.name === 'string' ? event.data.name : ''
    if (name.length > 0) lastOpenCall = { tool: name, seq: Number(event.seq) }
  }
  // v7.5: how many SUCCESSFUL tool calls happened after the todo snapshot was written.
  const todoFreshness = (() => {
    let todoSeq: number | undefined
    let todoCallId = ''
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'tool/call' && event.data?.name === 'todo_write') {
        todoSeq = Number(event.seq)
        todoCallId = typeof event.data?.callId === 'string' ? event.data.callId : ''
        break
      }
    }
    if (todoSeq === undefined) return undefined
    let newerSuccesses = 0
    for (const event of events) {
      if (event?.type !== 'tool/result') continue
      if (Number(event.seq) <= todoSeq) continue
      const callId = event.data?.message?.source?.callId ?? event.data?.message?.toolCallId
      // The todo_write result itself is not "work done after the snapshot".
      if (todoCallId.length > 0 && callId === todoCallId) continue
      if (event.data?.message?.isError === true || event.data?.error !== undefined) continue
      newerSuccesses += 1
    }
    return { todoSeq, newerSuccesses }
  })()

  const pendingBody = buildPendingState(
    lastTurnText,
    goal.goal,
    sourceSessionId,
    pointerCount,
    openTodos,
    // v7.0: the scene is read from the FULL log, not the sliced part.
    //
    // The last concrete step usually happens in the OPEN turn — the one the
    // boundary deliberately excludes — so reading `sliced` reported "nothing
    // happened recently" precisely when the most recent action was the one
    // that mattered. The scene is a fact about the source session, not about
    // what the tape chose to replay.
    //
    // v0.19: ...and then SLIMMED. The file/action pair says where the pen stopped
    // in one clause; the failure body that used to ride along was up to 2000
    // characters of another session's stack trace. The unresolved failure still
    // appears — once, as one line with its seq, in the instruction card.
    slimScene(extractLastStepScene(events)),
    lastOpenCall,
    todoFreshness,
    hasWrittenPlan,
  )
  // 硬约束 7: provenance for inherited constraints goes FIRST in the pending
  // state, ahead of every other line a reader might act on.
  const constraintAnchor = inheritedConstraintAnchor(events, sourceSessionId)
  // v7.6 (Model-Driven): the target boots itself.
  //
  // A grafted session whose first move is "waiting for the user" throws away the
  // handoff: the direction was already approved, and the pending state describes
  // exactly where the work stopped. This line is the standing instruction to keep
  // going, and it sits at the BOTTOM of the pending state because it is the last
  // thing the reader sees before acting.
  //
  // The chunk is protected from budget trimming (`protectedKinds` includes
  // pending-state), so "forced" holds even on a tight tape.
  const selfSliceBootstrap =
    config.modelDrivenGraft === false
      ? undefined
      : '[系统提示] 你刚刚完成了一次自我切片。请直接接着“当前任务”继续执行，无需等待用户确认。'
  // v7.8 artifact reuse: a node that WROTE a file has already produced it. Naming
  // the paths here is cheaper than any number of "do not duplicate" reminders: the
  // target reads them instead of regenerating the same module from scratch.
  const writtenArtifacts: string[] = []
  for (const event of sliced) {
    if (event?.type !== 'tool/call') continue
    const name = String(event.data?.name ?? '')
    if (name !== 'write' && name !== 'edit') continue
    try {
      const args = JSON.parse(String(event.data?.arguments ?? '{}')) as { file_path?: unknown }
      if (typeof args.file_path === 'string' && args.file_path.length > 0 && !writtenArtifacts.includes(args.file_path)) {
        writtenArtifacts.push(args.file_path)
      }
    } catch {
      // A non-JSON argument is simply not a known artifact.
    }
  }
  const artifactNote =
    writtenArtifacts.length === 0
      ? undefined
      : `已完成节点产物：${writtenArtifacts.slice(-3).join('、')}；后续请直接 read 复用，避免重复生成。`
  // v7.9: if the model ignored the 70% nudge and was cut at the hard watermark,
  // the target must know the interruption was forced, not planned.
  const forcedCutNote = noteForcedCut(sourceSessionId)
  // v0.19: the semantic state and the instruction card.
  //
  // The card is what the target reads in its first turn: the source's final
  // result, the one next action, the stop point, and — when there is one — the
  // single unresolved failure as a LINE WITH A SEQ rather than as a body. The
  // counts in `discarded` make the slimming visible instead of silent.
  //
  // The scan covers the FULL log, not `sliced`: the newest result and the newest
  // unresolved failure usually live in the OPEN turn, which the boundary excludes
  // from the tape — and those are exactly the two facts the card exists to state.
  // v0.20: the 进行中 column is the open turn's own unfinished instruction.
  //
  // Read here (in buildTape) rather than in buildInjectionPlan because the CARD is
  // built here; the carryover CHUNK is built later and reuses the same extractor,
  // so the two cannot disagree about what was in flight.
  const openTurnForBoard = extractOpenTurnCarryover(events, boundary.boundarySeq, sourceSessionId)
  const openTurnInstruction =
    openTurnForBoard === undefined || openTurnForBoard.userTexts.length === 0
      ? undefined
      : truncateEnd(
          openTurnForBoard.userTexts
            .map((text) => text.replace(/\s+/gu, ' ').trim())
            .filter((text) => text.length > 0)
            .join(' / '),
          300,
        ).text
  const semantic = extractSemanticState(events)
  // v0.20: the open turn's narration and pointer lines ARE dropped by the slimming,
  // so they must be COUNTED here or the board's disclosure line silently reports
  // less than was actually thrown away. (v0.19 wired these through a variable that a
  // later edit removed; the counts stayed at zero and the disclosure vanished.)
  if (openTurnForBoard !== undefined) {
    if (openTurnForBoard.userTexts.length > 0) {
      semantic.discarded.narrationChars += openTurnForBoard.assistantText.trim().length
      semantic.discarded.pointerLines += openTurnForBoard.pointers.length
    } else if (openTurnForBoard.assistantText.trim().length > 0) {
      // No new instruction: the whole open turn is history. Nothing was replayed,
      // so nothing was "dropped" — it was never a handoff fact to begin with.
    }
  }
  // v0.20: the board's 进行中 / 待开始 columns come from different places.
  //
  //   进行中 = what the OPEN turn already started (its unfinished user instruction)
  //   待开始 = the openTodos list, which is the model's own written plan
  //
  // Neither is invented: both were already available, they were just flattened into
  // one prose paragraph where "started but not finished" and "not started yet"
  // became indistinguishable.
  /**
   * v1.0.2: a goal that evolved in the SOURCE travels with the handoff.
   *
   * Read from the persisted record rather than from the rendered board text, so a
   * hand-edited board cannot fake an evolution (and a crash between render and write
   * cannot lose one).
   */
  const sourceMark =
    sourceSessionId === undefined || sourceSessionId.length === 0 ? undefined : graftTargets.get(sourceSessionId)
  const sourceMarkGoal = {
    ...(sourceMark?.currentGoal === undefined ? {} : { currentGoal: sourceMark.currentGoal }),
    revisions: Array.isArray(sourceMark?.goalEvolution) ? sourceMark.goalEvolution.length : 0,
  }
  const instructionCard = renderInstructionCard({
    semantic,
    body: pendingBody,
    request: goal.goal,
    // v1.0.2: a source that evolved its goal hands the EVOLVED one down, plus the count.
    ...(sourceMarkGoal.currentGoal === undefined ? {} : { currentGoal: sourceMarkGoal.currentGoal }),
    ...(sourceMarkGoal.revisions > 0 ? { goalRevisions: sourceMarkGoal.revisions } : {}),
    ...(openTurnInstruction === undefined ? {} : { inProgress: openTurnInstruction }),
    pending: openTodos,
    ...(hasWrittenPlan ? { hasWrittenPlan: true } : {}),
    stopPoint: {
      ...(typeof boundary.lastTurn === 'number' ? { turn: boundary.lastTurn } : {}),
      ...(typeof boundary.boundarySeq === 'number' ? { boundarySeq: boundary.boundarySeq } : {}),
    },
    ...(sourceSessionId === undefined || sourceSessionId.length === 0 ? {} : { sourceSessionId }),
    pointerCount,
    /**
     * v0.23 P2: probe ONCE, here, and hand the result to the renderer.
     *
     * The ✅ column is assembled from the conversation, so it reports what the model
     * said it did. This is the only part of the card that is measured, and it is what
     * lets a target notice that "commit e8da8f6 成功" and the actual HEAD disagree.
     *
     * A probe failure is not a handoff failure: `verifyWorkspace` never throws, and an
     * unmeasurable workspace is rendered as "could not verify" rather than omitted —
     * the difference changes how much the rest of the card may be trusted.
     */
    ...(() => {
      if (typeof workspaceCwd !== 'string' || workspaceCwd.trim().length === 0) return {}
      try {
        return { verification: verifyWorkspace(workspaceCwd) }
      } catch {
        return {}
      }
    })(),
  })
  const pendingStateText = [constraintAnchor, instructionCard, forcedCutNote, artifactNote, selfSliceBootstrap]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n\n')
  return {
    boundary,
    sourceTemplate: extractSourceTemplate(sliced),
    turns: tapeTurns,
    goal: goal.goal,
    goalSource: goal.source,
    phase: 'handoff',
    pendingStateText,
    pointerCount,
    semantic,
    ...(replayedMessagesSkipped === 0 ? {} : { replayedMessagesSkipped }),
  }
}

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
  if (goals.length === 0 && humanOrigins.length > 0) {
    // v7.4b: point at the EARLIEST human statement, not the newest copy.
    //
    // The constraints are harvested from several user messages across the
    // session (measured: seq 2282, 3474, 6592, 7420 on session-source-demo), then
    // rendered into the target's goal as a numbered block. The reader needs the
    // place where the rule was first written, so a re-assertion later on cannot
    // masquerade as the origin.
    const first = humanOrigins[0]
    return (
      `[高优锚点] 核心约束源自第 1 代会话（${sourceSessionId}），seq=${first.seq}，必要时请优先回读。` +
      `\n下面这段 HARD CONSTRAINTS 是插件从用户原话抽取的副本，不是这一代用户刚刚说的；` +
      `要确认原话，用 graft_read_result(sourceSessionId, ${first.seq})。`
    )
  }
  if (goals.length === 0) return undefined
  const goal = goals[goals.length - 1]
  const generation = goals.length
  return (
    `[高优锚点] 核心约束源自第 ${generation} 代会话（${sourceSessionId}），seq=${goal.seq}，必要时请优先回读。` +
    `\n当前是第 ${generation + 1} 代。下面这段 HARD CONSTRAINTS 是逐代复制来的文本，不是这一代用户刚刚说的；` +
    `要确认原话，用 graft_read_result(sourceSessionId, ${goal.seq})。`
  )
}

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

  const turns = Math.max(1, windowTurns)
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

/**
 * v6.3 module 2: media and attachment pointers.
 *
 * DSH stores an uploaded image/file as a content block carrying a host path.
 * The tape keeps text only, so without this the migrated model is blind to
 * everything the user uploaded. Each such block becomes one natural-language
 * sentence naming the path, which the target can then read with a normal file
 * tool (or graft_read_result, if the pointer names a seq).
 */
const ATTACHMENT_KINDS = new Set(['image', 'file', 'attachment', 'document', 'audio', 'video'])

function attachmentPointer(block: Record<string, any>): string | undefined {
  const kind = String(block.type ?? '')
  if (!ATTACHMENT_KINDS.has(kind)) return undefined
  const path =
    (typeof block.path === 'string' && block.path) ||
    (typeof block.hostPath === 'string' && block.hostPath) ||
    (typeof block.url === 'string' && block.url) ||
    (isRecord(block.source) && typeof block.source.path === 'string' && block.source.path) ||
    (isRecord(block.attachment) && typeof block.attachment.path === 'string' && block.attachment.path) ||
    ''
  const id =
    (typeof block.id === 'string' && block.id) ||
    (typeof block.ref === 'string' && block.ref) ||
    (isRecord(block.attachment) && typeof block.attachment.id === 'string' && block.attachment.id) ||
    ''
  const label = kind === 'image' ? '图片' : kind === 'audio' ? '音频' : kind === 'video' ? '视频' : '文件'
  const target = String(path || id)
  if (target.length === 0) return `（回顾：用户在此处上传了一个${label}，但记录里没有留下可读取的路径）`
  const name = typeof block.name === 'string' && block.name.length > 0 ? `（${block.name}）` : ''
  return `（回顾：用户在此处上传了一个${label}${name}，保存路径为：${target}，必要时请直接读取该路径）`
}

/** Collect attachment pointers from one user message. */
export function extractAttachmentPointers(message: unknown): string[] {
  if (!isRecord(message)) return []
  const content = Array.isArray(message.content) ? message.content : []
  const out: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const pointer = attachmentPointer(block)
    if (pointer !== undefined && !out.includes(pointer)) out.push(pointer)
  }
  return out
}

/** Build the bounded injection plan from a validated source log snapshot. */
export function buildInjectionPlan(
  log: SessionLogSnapshotLike,
  config: GraftConfig,
  constraintsOverride?: readonly string[],
  constraintSource: 'llm' | 'regex-fallback' = 'regex-fallback',
  /** v6.4 F3: tools the target actually has; undefined means "assume all". */
  availableTools?: ReadonlySet<string>,
  /** v7.0 B1: set false to omit the open-turn carryover (tests, legacy callers). */
  options?: { includeOpenTurn?: boolean },
): GraftPlan {
  const settings = normalizeConfig(config)
  const events = Array.isArray(log.events) ? log.events : []
  const boundary = locateBoundary(events)
  // v6.2: the model's own todo list is the authoritative next-action source.
  const taskStateForPending = extractTaskState(events)
  // v6.3: pick the retained-turn depth from the source's own shape.
  const adaptive = settings.adaptiveDepth
    ? calculateAdaptiveDepth(events, settings)
    : { depth: settings.recentTurns, mode: 'balanced' as const, reason: 'adaptiveDepth=false' }

  /**
   * v7.4 (decision 2): the task-state tier, when the operator opted in.
   *
   * `calculateAdaptiveDepth` reads the SHAPE of recent turns (tool density, error
   * ratio, code ratio) — a proxy for what kind of conversation this is. This reads
   * something else: whether the work sits at a clean stopping point. They answer
   * different questions, and the task state is the one that decides whether the
   * last turn's *method* is worth replaying.
   *
   * Measured on this project (same source session, same instruction, same model):
   *   A tier (0 turns): 42 steps, 19 file reads,  0 `plugin_manager` calls
   *   B tier (1 turn) :  9 steps,  1 file read,   3 `plugin_manager` calls
   * The replayed turn carried "I verified with plugin_manager", and that one fact
   * removed almost all of the rediscovery.
   *
   * When `autoAdaptiveTier` is on it WINS over `adaptiveDepth`: it is explicit and
   * task-derived, while the other is a shape-based guess.
   */
  const tierDecision = (() => {
    if (settings.autoAdaptiveTier !== true) return undefined
    const boundaryState = checkTaskBoundary(events, taskStateForPending.openTodos)
    const tier: 'A' | 'B' = boundaryState.shouldDefer ? 'B' : 'A'
    return {
      tier,
      depth: tier === 'B' ? 1 : 0,
      reason: boundaryState.shouldDefer
        ? `unfinished work (${boundaryState.reason}) → replay 1 turn for the method`
        : `clean stopping point (${boundaryState.reason}) → replay nothing; the index holds every pointer`,
    }
  })()
  const effectiveSettings =
    tierDecision === undefined
      ? { ...settings, recentTurns: adaptive.depth }
      : { ...settings, recentTurns: tierDecision.depth }
  // v0.23 P2: resolve the workspace BEFORE building the tape, so the card's
  // verification section describes the project the source was working in. Reading it
  // after the fact is what would let the probe report on the wrong directory.
  const cwd = log.session?.cwd
  const tape = buildTape(
    events,
    boundary,
    effectiveSettings,
    typeof log.session?.id === 'string' ? log.session.id : undefined,
    taskStateForPending.openTodos,
    availableTools,
    typeof cwd === 'string' ? cwd : undefined,
    taskStateForPending.todoSeq !== undefined,
  )
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolutePath(cwd)) {
    throw graftError(
      'MISSING_CWD',
      `source session ${String(log.session?.id)} has no absolute cwd; cross-session tool pointers require an exact cwd`,
    )
  }

  const warnings: string[] = []
  // v0.18 module 3: the rule set is packed to a declared CAPACITY, and the build
  // refuses to continue when a qualified rule does not fit. This is the single
  // choke point every path shares (graft_prepare, graft_commit, the auto path),
  // so there is no builder that can ship a shortened block.
  const constraintSelection: ConstraintSelection =
    constraintsOverride !== undefined
      ? selectConstraints(
          [...constraintsOverride].map((text, index) => ({ text, score: 100, index })),
          settings.constraintBudgetChars,
        )
      : extractConstraintsDetailed(log.events, settings.constraintBudgetChars)
  assertConstraintsPreserved(constraintSelection, `source=${String(log.session?.id ?? '?')}`)
  const constraints = constraintSelection.constraints
  const taskState = extractTaskState(log.events)
  const recentCount = Math.min(effectiveSettings.recentTurns, tape.turns.length)
  const recentSlice = tape.turns.slice(tape.turns.length - recentCount)
  const olderSlice = tape.turns.slice(0, tape.turns.length - recentCount)

  // v7.0 P1 x A3: decide which "recent" turns actually survive BEFORE the older
  // index is computed.
  //
  // The two rules interact and the earlier ordering got it wrong. `older` was
  // fixed at "everything before the recent window", and P1 later dropped
  // individual recent turns that exceeded `maxTurnChars`. A dropped turn then
  // belonged to neither list: it was announced in `[已省略 …]` but its pointers
  // were still counted in the total and attributed to nothing. On the real
  // fixture (Turn 1 = 10,959 chars, maxTurnChars 6000) that produced
  // `older: 0` while 342 pointers existed — the report claimed there was
  // nothing older to read back while the omission notice said there was.
  //
  // Fixing the order makes the accounts meet: a turn is either replayed
  // verbatim, or it is old, and every old turn's pointers appear in the index.
  const oversizedRecent = recentSlice.filter(
    (turn) => settings.maxTurnChars > 0 && (turn.replay ?? turn.text).length > settings.maxTurnChars,
  )
  const recent = recentSlice.filter((turn) => !oversizedRecent.includes(turn))
  const older = [...olderSlice, ...oversizedRecent]

  // v7.0 A3: older turns become metadata, not prose.
  //
  // v6.x ran `summaryWithConstraints()` over each old turn's de-pointerized
  // prose and kept up to `oldTurnSummaryChars` (600) per turn. On a 40-turn
  // session that spent more than 20k characters of budget describing work the
  // target can neither see nor verify — and every one of those characters was
  // taken from the *recent* turns, which are the only ones it can act on.
  //
  // The old prose was also unreliably wrong: it was regex-squeezed assistant
  // narration, so it read as confident summary while losing the user's ask.
  //
  // A compact index is strictly better: it states what happened, how much of it,
  // and the seq range needed to read the real thing. Cheap, honest, and it keeps
  // the freed budget for the verbatim recent window.
  const olderToolNames = new Set<string>()
  let olderPointerCount = 0
  let olderUserMessageCount = 0
  for (const turn of older) {
    const pointers = pointerSentences(turn.text)
    for (const pointer of pointers) {
      olderPointerCount += 1
      // Every pointer shape names the tool, but in a different place:
      //   legacy      [tool name=read_file seq=9 …]
      //   recollection 刚才我已经调用 read_file 完成了这一步…
      //   downgraded  使用了当前环境不支持的工具 spawn_teammate；…
      // The downgraded form (v6.4 F3) was missing here, so a slice whose tools
      // had been downgraded reported "342 tool calls" while naming none of them.
      const legacy = pointer.match(/^\[tool name=([^\s]+) seq=/u)
      const compact = pointer.match(/^-\s*([A-Za-z0-9_.:-]+)\(seq=/u)
      const humanized = pointer.match(/调用\s*([A-Za-z0-9_.-]+)\s*(?:时|完成|工具|报错)/u)
      const downgraded = pointer.match(/不支持的工具\s+([A-Za-z0-9_.-]+)/u)
      const name = compact?.[1] ?? legacy?.[1] ?? humanized?.[1] ?? downgraded?.[1]
      if (name !== undefined) olderToolNames.add(name)
    }
    olderUserMessageCount += (turn.userTexts ?? []).length
  }

  const olderLines: string[] = []
  if (older.length > 0) {
    const first = older[0]
    const last = older[older.length - 1]
    const span = older.length === 1 ? `Turn ${first.turn}` : `Turn ${first.turn}-${last.turn}`
    const toolPart = olderPointerCount > 0 ? `，${olderPointerCount} 次工具调用` : ''
    const userPart = olderUserMessageCount > 0 ? `，${olderUserMessageCount} 条用户指令` : ''
    olderLines.push(
      `- [历史片段: ${span}，共 ${older.length} 轮${userPart}${toolPart}；` +
        `原文按 seq=${first.firstSeq}-${last.lastSeq} 用 graft_read_result 回查]`,
    )
    if (olderToolNames.size > 0) {
      olderLines.push(`  涉及工具: ${[...olderToolNames].sort().join(', ')}`)
    }
  }
  const olderTruncated = false

  const chunks: GraftInjectionChunk[] = []
  // v7.0 B1: the open turn is placed first — it is the most recent work, and a
  // budget squeeze must not be the thing that hides it.
  //
  // v0.19 SLIMMING: the chunk stops carrying the turn "more or less whole".
  //
  // It used to hold the assistant's narration verbatim plus every pointer line the
  // turn produced. Both are history: the narration is a work log the target cannot
  // act on, and the pointers already exist, deduplicated and grouped, in the
  // read-back index. What must survive verbatim is the ONE thing that carries
  // intent and that no later block repeats: the user's un-executed instruction.
  //
  // So the carryover becomes that instruction (bounded), its pointers' COORDINATES,
  // and a declared count of what was dropped. The old house's problems do not
  // travel; its unfinished ask does.
  const openTurnCarryover =
    options?.includeOpenTurn === false
      ? undefined
      : extractOpenTurnCarryover(events, boundary.boundarySeq, typeof log.session?.id === 'string' ? log.session.id : undefined)
  // v7.4c: `userTexts` counts as content on its own.
  //
  // The watermark can fire immediately after the user sends a decision and
  // before the model answers: the open turn then holds a `user/message` and
  // nothing else. The extractor returned that instruction, but this guard only
  // looked at pointers and assistant text, so the whole carryover chunk was
  // discarded. The target then read the PREVIOUS round as "the task" — the
  // exact failure the carryover exists to prevent.
  if (openTurnCarryover !== undefined && openTurnCarryover.userTexts.length > 0) {
    const instruction = truncateEnd(
      openTurnCarryover.userTexts.map((text) => neutralizeStructure(text.trim())).filter((text) => text.length > 0).join('\n'),
      900,
    ).text
    if (instruction.length > 0) {
      const dropped: string[] = []
      if (openTurnCarryover.assistantText.trim().length > 0) {
        dropped.push(`${openTurnCarryover.assistantText.trim().length} 字符中间叙述`)
      }
      if (openTurnCarryover.pointers.length > 0) {
        dropped.push(`${openTurnCarryover.pointers.length} 行过程指针`)
      }
      // v0.19: the POINTERS' coordinates stay even though their prose does not.
      //
      // Dropping a pointer line without keeping its seq would make the work
      // unreachable — the tape's whole contract is that every claim has a seq you
      // can open. A bare number list costs ~20 characters and keeps that contract
      // while removing the prose the target cannot act on.
      const seqList = [...openTurnCarryover.pointers]
        .sort((left, right) => left.seq - right.seq)
        .map((item) => `${item.seq}${item.isError === true ? '!' : ''}`)
      const coordinates =
        seqList.length === 0
          ? ''
          : `\n（本轮过程指针：seq=${seqList.slice(0, 16).join(',')}` +
            `${seqList.length > 16 ? ` …共 ${seqList.length} 处` : ''}；正文按 seq 回读）`
      chunks.push({
        kind: 'open-turn-carryover',
        // v7.0 B4: no "交接瞬间" narration. The label states the turn and what is
        // missing; a reader resuming work does not need to be told a boundary
        // happened, only which turn this is and that unfinished work is absent.
        text:
          `[Turn ${openTurnCarryover.turn} · 进行中 · 未执行的用户指令]\n` +
          `${instruction}` +
          coordinates +
          (dropped.length === 0 ? '' : `\n（已按语义瘦身：丢弃 ${dropped.join('、')}）`),
        truncated: false,
      })
    }
  }
  // Assistant work with no new instruction is history, not a handoff fact: it
  // produces no chunk at all. The read-back index already points at every seq it
  // produced, so nothing becomes unreachable by dropping the prose.
  if (olderLines.length > 0) {
    chunks.push({
      kind: 'old-summary',
      text: `[历史片段索引]\n${olderLines.join('\n')}`,
      truncated: olderTruncated,
    })
  }
  // v7.5: the node plan sits ABOVE the status snapshot.
  //
  // Order is the whole point. `[Task Status]` answers "what is left"; this block
  // answers "where am I and what is in the way". A resumed reader needs the
  // second question first — and when the todo list is stale, the roadmap is the
  // only block that still points at the current phase.
  const roadmap = extractPhaseRoadmap(events, taskState, extractLastStepScene(events))
  if (roadmap !== undefined) {
    chunks.push({
      kind: 'phase-roadmap',
      text: renderPhaseRoadmap(roadmap),
      truncated: false,
    })
  }
  if (taskState.todos.length > 0) {
    // v7.4: state the snapshot's age instead of implying it is current.
    //
    // Measured on a real 44-turn session: the last `todo_write` sat at seq 9269
    // while the slice boundary was 13413 — 4,144 events and eleven turns later.
    // The target read that finished list as the live plan, re-verified completed
    // work, and only understood the drift after the user pointed at it.
    //
    // The plugin cannot invent a fresher list. It CAN refuse to imply that an old
    // one is current, and name the seq to read if the reader wants to check.
    const age = taskState.todoAgeEvents ?? 0
    const stale = age >= 500
    const ageLine = stale
      ? `（此列表快照于 seq=${taskState.todoSeq}` +
        (taskState.todoAgeTurns === undefined ? '' : `，约 ${taskState.todoAgeTurns} 轮前`) +
        `，此后又有 ${age} 个事件——可能已过期，按需用 graft_read_result 回读 seq=${taskState.todoSeq} 附近确认）`
      : ''
    chunks.push({
      kind: 'task-status',
      text: `[Task Status]${ageLine}\n${taskState.todos.join('\n')}`,
      truncated: false,
    })
  }
  if (taskState.subagentReports.length > 0) {
    // v7.2: in a debug slice, subagent reports are the first thing to go.
    //
    // They are the least actionable block during continuous debugging: a
    // delegated agent's summary describes work that already finished, while the
    // target is trying to fix the thing that just broke. Keeping them spends
    // budget that the pending state — which now inlines the actual failure text —
    // needs more.
    //
    // A genuinely short report stays: if a subagent said one sentence, that
    // sentence may be the whole answer, and dropping it would trade signal for a
    // heuristic.
    const reportsText = `[Subagent Reports]\n${taskState.subagentReports.join('\n')}`
    const keepInDebug = reportsText.length <= 400
    if (adaptive.mode !== 'debug' || keepInDebug) {
      chunks.push({
        kind: 'subagent-reports',
        text: reportsText,
        truncated: false,
      })
    } else {
      warnings.push(
        `subagent-reports dropped in debug mode (${reportsText.length} chars > 400); budget goes to the pending state`,
      )
    }
  }
  // v6.4 F4: tell the target where things live now, not just what happened.
  const workspace = extractWorkspaceIndex(events, 20)
  const workspaceFiles = workspace.files
  const workspaceText = renderWorkspaceState(workspaceFiles, cwd, workspace.total)
  if (workspaceText.length > 0) {
    chunks.push({ kind: 'workspace-files', text: workspaceText, truncated: false })
  }
  // v7.0 P1-2: state plainly what did not come across.
  //
  // Placed high in importance (it is pushed before the replays) because it is a
  // correction to the target's implicit assumption that it now sees everything.
  // A target that believes it has the whole picture will wait for a subagent
  // report or a job result that is going to a session nobody is reading.
  const openWork = extractOpenBackgroundWork(events)
  const openWorkText = renderOpenWorkNotice(openWork)
  if (openWorkText.length > 0) {
    chunks.push({
      kind: 'open-work',
      text: `[未随迁移带走的后台工作]\n${openWorkText}`,
      truncated: false,
    })
  }
  // v7.0 P1: a turn is kept whole or not at all.
  //
  // v6.x ran each recent turn through `truncateMiddle()` when it exceeded
  // `maxTurnChars`. That produced a replay whose middle was gone: the user's
  // instruction survived, the assistant's conclusion survived, and the actual
  // work vanished between two ellipses — with no marker saying so. A model
  // reading it cannot tell a short answer from a truncated one, which is the
  // same false-certainty failure the budget rules exist to avoid.
  //
  // Dropping the OLDEST recent turn entirely is strictly better: what remains is
  // verbatim, and the omission is declared at the top with the seq range needed
  // to read it back. The reader learns "turns 3-5 happened, here is how to see
  // them" instead of "here is a turn with a hole in it".
  const droppedTurns: GraftTapeTurn[] = [...oversizedRecent]
  for (const turn of oversizedRecent) {
    warnings.push(
      `turn ${turn.turn} dropped whole (${(turn.replay ?? turn.text).length} chars > maxTurnChars ${settings.maxTurnChars})`,
    )
  }
  /** v7.0 P1: turns removed by the TOTAL budget pass, tracked by firstSeq. */
  const droppedByBudgetSeq: number[] = []
  for (const turn of recent) {
    chunks.push({
      kind: 'recent-turn',
      text: turn.replay ?? turn.text,
      turn: turn.turn,
      truncated: false,
    })
  }
  // The omission declaration is emitted after BOTH budget passes, so a turn
  // removed for either reason is reported exactly once (see below).
  // v7.0 P12: one read-back index at the end, instead of pointers scattered
  // through the narration.
  //
  // Every replay line already names its own seq, and every tool pointer names
  // one too. Scattered through the text, though, they are only discoverable by
  // reading everything — a reader who wants "the failing test output" has to
  // scan the whole replay to find which pointer it was.
  //
  // A single trailing block turns the question around: here is everything you
  // can read back, grouped by kind, with the seq you need. The prose above stays
  // prose; retrieval becomes a lookup instead of a hunt.
  const readback = collectReadbackIndex(tape, events)
  if (readback.length > 0) {
    chunks.push({
      kind: 'readback-index',
      text: `[可回读索引] 需要原文时用 graft_read_result(sourceSessionId, seq)：\n${readback.join('\n')}`,
      truncated: false,
    })
  }
  // v7.0: the cross-generation anchor, appended to the index it belongs to.
  //
  // Deliberately part of this block, not a new one: it is a pointer, and a
  // pointer belongs with the pointers. It is also placed AFTER the listing so a
  // reader scanning the index sees it as its conclusion.
  const sourceGeneration = graftGenerationOf(typeof log.session?.id === 'string' ? log.session.id : '')
  const provenance =
    typeof log.session?.id === 'string'
      ? findConstraintProvenance(events, log.session.id, sourceGeneration)
      : undefined
  if (readback.length > 0) {
    const index = chunks.find((chunk) => chunk.kind === 'readback-index')
    if (index !== undefined) {
      // v7.3: name the previous session in the chain, at the TOP of the index.
      //
      // The provenance line at the bottom says "the constraints came from
      // generation N, seq=Y". That is enough to know a rule's ancestry, and not
      // enough to FIND an old error: the target still needs to know which session
      // id to pass to graft_search_history. By generation 3-4 the current
      // sourceSessionId points at a tape that no longer contains the earliest
      // failure, so a search against it returns nothing and looks like "it was
      // never there".
      //
      // One line, constant size, and it names the exact id a search can target.
      const parent = graftTargets.get(
        typeof log.session?.id === 'string' ? log.session.id : '',
      )
      const chain: string[] = []
      if (typeof log.session?.id === 'string') chain.push(`当前：${log.session.id}`)
      if (parent !== undefined) {
        chain.push(`上一代：${parent.sourceSessionId}`)
      }
      if (chain.length > 1) {
        index.text =
          `[历史链追溯] ${chain.join('　')}\n` +
          '更早的报错或代码可能只存在于上一代会话；用 graft_search_history 时把 sourceSessionId 换成它再搜。\n' +
          index.text
      }
      if (provenance !== undefined) {
        index.text += `\n\n${renderConstraintProvenance(provenance)}`
      }
    }
  }
  chunks.push({
    kind: 'pending-state',
    text: tape.pendingStateText,
    truncated: false,
  })

  if (settings.maxTotalChars > 0) {
    // v7.0: budget by priority, not by equal shares — and never by cutting a
    // turn in half.
    //
    // Two rules compose here:
    //   1. Priority decides WHO gets dropped: an old-turn index is worth
    //      sacrificing long before the most recent exchange.
    //   2. P1 decides HOW: a `recent-turn` is atomic. It is either kept whole or
    //      removed whole and counted in the omitted-turns declaration. Cutting
    //      its middle is what produced replays with the work missing between two
    //      ellipses and nothing saying so.
    //
    // Non-turn chunks (indexes, file lists, subagent reports) may still be
    // middle-truncated: they are pointers and lists, where a shortened form is
    // still an honest pointer, and their omission notice is the truncation mark.
    const protectedKinds = new Set<GraftInjectionChunk['kind']>(['pending-state', 'open-turn-carryover'])
    /**
     * v7.0 P8: chunks that survive whole or not at all.
     *
     * `recent-turn` is atomic because a half-cut exchange reads as a complete
     * one (P1). `task-status` is atomic for the same class of reason: a todo
     * list truncated mid-way still *looks* like the todo list, and the reader
     * has no way to know items are missing — so it concludes the remaining work
     * is what it sees. Losing it whole is honest; losing half of it is not.
     *
     * Dropping it whole is safe because it is redundant with the protected
     * pending state: `buildPendingState` already receives `openTodos`, so the
     * unchecked items a resumed model must act on survive there. The
     * `task-status` block carries the *full* checklist, which is nice to have
     * and not worth a misleading partial.
     */
    const atomicKinds = new Set<GraftInjectionChunk['kind']>(['recent-turn', 'task-status'])
    /**
     * v7.0 P8: survival order, HIGHEST FIRST.
     *
     * This array is not a preference list; it is the order in which material is
     * kept when the budget runs out, and every position is a claim about what a
     * resumed model can reconstruct.
     *
     * The rule that fixes the order: **the breakpoint beats the state.**
     *
     * A `recent-turn` is the only chunk that cannot be rebuilt. It is the actual
     * exchange — what the user asked, what the assistant answered — and once it
     * is dropped the target has no way to know it existed except the seq range
     * in the omission notice. A `task-status` block is a todo list: it is a
     * *summary of state* that the source's own `todo_write` call still carries,
     * and the model can re-read it (or simply re-derive it from the workspace).
     * Dropping one costs a tool call; dropping the other costs the thread.
     *
     * So `task-status` sits BELOW `recent-turn` even though it is smaller and
     * "feels" more organised. Smaller is not the same as more valuable: a cheap
     * summary must not outlive the conversation it summarises.
     *
     * Measured cost of getting this backwards (before the fix, budget 700):
     * `task-status` survived at 187 chars while `recent-turn` fell from 4 to 2.
     * That is exactly inverted — the list of todos outlived the instructions
     * that produced it.
     */
    const priority: GraftInjectionChunk['kind'][] = [
      'readback-index',
      'recent-turn',
      'open-work',
      'task-status',
      'workspace-files',
      'old-summary',
      'subagent-reports',
      'omitted-turns',
    ]
    const rank = (chunk: GraftInjectionChunk): number => {
      if (protectedKinds.has(chunk.kind)) return -1
      const index = priority.indexOf(chunk.kind)
      // `recent-turn` is ranked by recency: the newest turn outranks an older one.
      if (chunk.kind === 'recent-turn') {
        const position = chunks.filter((candidate) => candidate.kind === 'recent-turn').indexOf(chunk)
        return index * 1000 - position
      }
      return index * 1000
    }
    const ordered = [...chunks].sort((left, right) => rank(left) - rank(right))
    let remaining = settings.maxTotalChars
    // Protected chunks are never trimmed by this pass; pending-state already has
    // its own limit below.
    for (const chunk of ordered) {
      if (protectedKinds.has(chunk.kind)) continue
      if (remaining <= 0) {
        if (atomicKinds.has(chunk.kind)) {
          const turn = chunk.turn === undefined ? undefined : recent.find((entry) => entry.turn === chunk.turn)
          if (turn !== undefined) droppedByBudgetSeq.push(turn.firstSeq)
          chunk.text = ''
          continue
        }
        chunk.text = ''
        chunk.truncated = true
        continue
      }
      if (chunk.text.length <= remaining) {
        remaining -= chunk.text.length
        continue
      }
      if (atomicKinds.has(chunk.kind)) {
        // Whole or nothing. Zero-length text removes it from the filtered list.
        const turn = chunk.turn === undefined ? undefined : recent.find((entry) => entry.turn === chunk.turn)
        if (turn !== undefined) droppedByBudgetSeq.push(turn.firstSeq)
        chunk.text = ''
        continue
      }
      const result = truncateMiddle(chunk.text, remaining)
      chunk.text = result.text
      chunk.truncated = true
      warnings.push(`${chunk.kind}${chunk.turn === undefined ? '' : ` turn ${chunk.turn}`} truncated by total budget`)
      remaining = 0
    }
    const pending = chunks.find((chunk) => chunk.kind === 'pending-state')
    if (pending !== undefined) {
      const pendingLimit = Math.max(1, settings.maxTotalChars)
      if (pending.text.length > pendingLimit) {
        const result = truncateMiddle(pending.text, pendingLimit)
        pending.text = result.text
        pending.truncated = true
        warnings.push('pending-state text truncated by total budget')
      }
    }
  }

  // v7.0 P1: whatever the two budget passes removed must be declared.
  // The single-turn pass and the total-budget pass drop turns for different
  // reasons, but the reader only needs one answer: which turns are missing and
  // what seq range reads them back.
  const omittedTurns = [
    ...droppedTurns,
    ...droppedByBudgetSeq
      .map((seq) => recent.find((turn) => turn.firstSeq === seq))
      .filter((turn): turn is GraftTapeTurn => turn !== undefined),
  ]
  const uniqueOmitted = [...new Map(omittedTurns.map((turn) => [turn.turn, turn])).values()].sort(
    (left, right) => left.turn - right.turn,
  )
  const declarationIndex = chunks.findIndex((chunk) => chunk.kind === 'omitted-turns')
  if (declarationIndex >= 0) chunks.splice(declarationIndex, 1)
  if (uniqueOmitted.length > 0) {
    const first = uniqueOmitted[0]
    const last = uniqueOmitted[uniqueOmitted.length - 1]
    const span = uniqueOmitted.length === 1 ? `Turn ${first.turn}` : `Turn ${first.turn}-${last.turn}`
    const reason =
      droppedTurns.length > 0 && droppedByBudgetSeq.length > 0
        ? '单轮预算与总预算'
        : droppedTurns.length > 0
          ? '单轮预算'
          : '总预算'
    chunks.unshift({
      kind: 'omitted-turns',
      /**
       * v0.23: the declaration is an XML element, not a bracket sentence.
       *
       * `[已省略 Turn X-Y：N 轮因…整段丢弃]` read as CONTENT — a line inside the tape
       * that a reader could mistake for the conversation itself, and a bracket phrase
       * any strict consumer (a JSON body, a fenced block) would treat as payload.
       * `<omitted_turns span="…" count="…" recoverable="true">` puts the same facts in
       * attributes, where they are inert to a parser and unambiguous to a human.
       */
      text:
        `<omitted_turns span="${span}" count="${uniqueOmitted.length}" reason="${reason}" recoverable="true">\n` +
        `需回查时用 graft_read_result 按 seq=${first.firstSeq}-${last.lastSeq} 读取原文。\n` +
        `</omitted_turns>`,
      truncated: false,
    })
  }

  // v0.17: ONE choke point for the whole tape.
  //
  // Every chunk — replays, the pending state, the workspace index, subagent
  // reports, the read-back index — leaves through here, so host noise cannot
  // enter by a path someone forgot to wrap. Patching each builder would have
  // guaranteed that the next builder forgets.
  const cleanedChunks = chunks.map((chunk) => ({ ...chunk, text: stripHostNoise(chunk.text, cwd) }))
  const filtered = cleanedChunks.filter((chunk) => chunk.text.length > 0)
  // v0.14: the chain depth of the target this plan will create. Read from the
  // source's own mark, so generation 3 stays generation 3 across a restart.
  const sourceId = typeof (log as any)?.session?.id === 'string' ? String((log as any).session.id) : ''
  const generation = sourceId.length === 0 ? 1 : graftGenerationOf(sourceId) + 1
  return {
    cwd,
    boundary,
    sourceTemplate: tape.sourceTemplate,
    goal: tape.goal,
    goalSource: tape.goalSource,
    phase: tape.phase,
    chunks: filtered,
    // v7.0: two different questions, two different fields.
    //
    // `recentTurnCount` is the WINDOW depth the slice chose — the number of
    // trailing turns it intended to replay. `recentInjectedCount` is how many of
    // them actually survived the per-turn budget. Conflating them was how the
    // report lost the distinction: it said "0 recent turns" for a slice whose
    // window was 2 and whose two turns were each too large to keep.
    recentTurnCount: recentCount,
    recentInjectedCount: recent.length,
    olderTurnCount: older.length,
    adaptiveDepth: adaptive,
    // v7.4 (decision 2): present only when autoAdaptiveTier made the choice, so a
    // reader can tell "the tier was decided" from "the configured depth was used".
    ...(tierDecision === undefined ? {} : { adaptiveTier: tierDecision }),
    workspaceFiles,
    pointerCount: tape.pointerCount,
    olderPointerCount,
    olderToolNames: [...olderToolNames],
    constraints,
    constraintSource,
    constraintIntegrity: {
      budgetChars: constraintSelection.budgetChars,
      totalChars: constraintSelection.totalChars,
      kept: constraints.length,
      candidateCount: constraintSelection.candidateCount,
      dropped: constraintSelection.dropped.length,
      // v0.23: preserved on the handoff, deliberately kept OUT of the prompt.
      archived: constraintSelection.archived.length,
    },
    // v0.14: injected (see goalMessage) and used by the chain guard.
    generation,
    taskStatus: taskState.todos,
    ...(openTurnCarryover === undefined ? {} : { openTurnCarryover }),
    subagentReports: taskState.subagentReports,
    totalTapeChars: filtered.reduce((total, chunk) => total + chunk.text.length, 0),
    warnings,
  }
}

// ===========================================================================
// Phase 3 — Skeleton and message injection
// ===========================================================================

/**
 * v5.2 拟人化：目标写成自然语言，而不是给模型一段 JSON 去解析。
 *
 * 旧格式把 `{"kind":"persistent-capability-seed",...}` 放进 user/message，
 * 轻量模型会对着括号发呆、或把字段名当指令复读。改成一段陈述 + 列表。
 */
/**
 * v0.21 P1: the machine-readable provenance of a handoff.
 *
 * THE QUESTION IT ANSWERS
 *
 * "This target is behaving oddly — where did it actually come from?" The pipeline has
 * always stated the chain depth and the source id as PROSE, which a human can read and
 * a program cannot. When a target is polluted, or when a later generation needs to be
 * re-cut from the true origin, the coordinates must be exact: which session, which
 * boundary seq, which generation.
 *
 * Shape: one HTML comment. It renders as nothing in a UI (so it cannot leak into what
 * the user sees), it greps as one line, and it is stable enough to be parsed by a
 * future tool that wants to walk the chain backwards.
 */
export const IDENTITY_METADATA_MARKER = 'graft-identity'

export interface GraftIdentity {
  sourceSessionId: string
  boundarySeq: number
  generation: number
  cwd?: string
  at?: string
}

export function renderIdentityMetadata(identity: GraftIdentity): string {
  const payload: Record<string, unknown> = {
    sourceSessionId: identity.sourceSessionId,
    boundarySeq: identity.boundarySeq,
    generation: identity.generation,
  }
  if (identity.cwd !== undefined && identity.cwd.length > 0) payload.cwd = identity.cwd
  if (identity.at !== undefined && identity.at.length > 0) payload.at = identity.at
  return `<!-- ${IDENTITY_METADATA_MARKER}: ${JSON.stringify(payload)} -->`
}

/** Read the provenance back out of a message (or any text that carries the block). */
export function parseIdentityMetadata(text: string): GraftIdentity | undefined {
  if (typeof text !== 'string') return undefined
  const match = new RegExp(`<!--\\s*${IDENTITY_METADATA_MARKER}:\\s*(\\{.*?\\})\\s*-->`, 'u').exec(text)
  if (match === null) return undefined
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>
    const sourceSessionId = typeof parsed.sourceSessionId === 'string' ? parsed.sourceSessionId : ''
    const boundarySeq = Number(parsed.boundarySeq)
    const generation = Number(parsed.generation)
    if (sourceSessionId.length === 0 || !Number.isFinite(boundarySeq) || !Number.isFinite(generation)) return undefined
    return {
      sourceSessionId,
      boundarySeq,
      generation,
      ...(typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? { cwd: parsed.cwd } : {}),
      ...(typeof parsed.at === 'string' && parsed.at.length > 0 ? { at: parsed.at } : {}),
    }
  } catch {
    // A malformed block is "no metadata", never a crash on the read path.
    return undefined
  }
}

function goalMessage(
  cwd: string,
  goal: string,
  phase: string,
  messageId: string,
  sourceSessionId: string,
  hasWorkspaceFiles = false,
  constraints: readonly string[] = [],
  /** v0.13: the workspace boundary block, already rendered ('' = guard disabled). */
  redlineBlock = '',
  /**
   * v0.14: the chain depth of this target. Injected so the model can SEE that it
   * is itself a migration product — the chain failure mode ("a target grafts
   * again because it was created") is invisible to a session that does not know
   * it is generation 2.
   */
  generation = 1,
  /** v0.21 P1: the boundary the tape was cut at, for the identity metadata. */
  boundarySeqForIdentity = 0,
): Record<string, any> {
  // v7.0 B4: read as a continuation, not as a handoff notice.
  //
  // v6.x opened with "【系统交接】上一段对话因为上下文满载，已经由系统安全接管
  // 到这里。" and closed with "请顺接前文的思路直接继续，不必从头开始，也不必
  // 复述这段说明。" Between them sat three more lines explaining the mechanism
  // (where you are, that records still exist, that a file block is below).
  //
  // Every one of those lines describes the HANDOFF rather than the WORK. The
  // target that reads them starts by orienting itself to a system event; the
  // target that reads only what the user last said and what is still open starts
  // by answering it. The acceptance criterion is "looks like a continuous
  // conversation, not an outline" — a preamble about being relocated is the
  // single largest source of outline-ness in the whole injection.
  //
  // What replaces it: the workspace as a fact (one line, because the model must
  // resolve relative paths), the current goal as the user's own words, and the
  // constraints. Nothing addresses the reader about the migration itself.
  // v7.3.1: do not call this "当前要做的事" (the thing to do NOW).
  //
  // Measured on the live desktop. A source session had asked the agent to look up
  // jet hub, then spent five turns finishing that work (4 of 5 todos completed).
  // The goal extractor correctly captured the ORIGINAL request, but the label
  // promised it was current:
  //
  //   当前要做的事：帮我看看jet hub这个插件最新版本，以及找个…插件市场
  //   [Task Status]  … [x] 升级… [x] 安装… [x] 配置… [x] 启用… [ ] 重启后验证
  //   [pending]      我接下来需要立刻执行：重启 DSH 后验证 Discover 页…
  //
  // The target read a task that was already DONE as its assignment and re-ran the
  // research; the user's report was "the new session behaves like re-learning the
  // content". The information to do otherwise was present — the label contradicted
  // it.
  //
  // "这个会话的任务" states the session's task without asserting it is next. The
  // next action is the pending state's job, and it always speaks in the present:
  // "我接下来需要立刻执行：<open todo>". One owner per claim.
  const lines = [
    `工作目录 ${cwd}。`,
    '',
    `这个会话的任务：${goal}`,
    '',
    `graft_generation: ${generation}（第 ${generation} 代迁移产物${generation === 1 ? '：由原始会话直接切片' : ''}）`,
  ]
  // v0.21 P1: the IDENTITY METADATA, in the PendingState.
  //
  // Why this is worth a block of its own: the pipeline has always carried the chain
  // depth as PROSE ("graft_generation: 3（第 3 代迁移产物）") and the source id in a
  // sentence, and neither survives a machine reader. When a target turns out to be
  // poisoned — the tape carried the wrong error, the boundary was wrong, the
  // constraints were inherited from a session that no longer exists — the questions
  // are exact: WHICH session, WHICH boundary seq, WHICH generation. Answering them
  // from prose means a human re-reading a log; answering them from a machine-readable
  // line means `graft_read_result` can be pointed at the exact coordinates.
  //
  // Deliberately HTML-comment shaped so it renders as nothing in a UI, and
  // deliberately one line so a reader can grep it.
  lines.push('', renderIdentityMetadata({ sourceSessionId, boundarySeq: boundarySeqForIdentity, generation, cwd }))
  // v0.14 CHAIN GUARD: state the re-graft prohibition in the durable channel too.
  // The tool layer refuses it (see autoGraftIfNeeded); saying it here is what stops
  // the model from *asking* for a slice on its very first turn.
  if (generation >= 1) {
    lines.push(
      `迁移纪律：本会话完成前 ${GRAFT_CHAIN_GRACE_TURNS} 轮之前不得再触发切片；先把手上的任务推进到明确的停泊点，再考虑交接。`,
    )
  }
  // v7.0 C1: constraints live HERE, not in the system head.
  //
  // The host replaces surface node 0 with its own rendered prompt on the
  // target's first live step (SystemPromptProjection.project). A constraint
  // block appended to the system message therefore survived only until the
  // model's first request — the defence existed in the log and was dead by the
  // time anything read it. A `user/message` is never rewritten that way.
  //
  // The enumeration is deliberately mechanical: the failure mode this guards
  // against is a model that summarises "the main constraints" and silently
  // drops the one it was about to violate.
  if (constraints.length > 0) {
    lines.push(
      '',
      'HARD CONSTRAINTS（从源会话用户消息中抽取，逐条有效，不可协商）:',
      ...constraints.map((constraint, index) => `${index + 1}. [ ] ${constraint}`),
      '',
      'If asked about constraints or progress, you MUST enumerate every single item above without skipping or summarizing.',
    )
  }
  if (sourceSessionId.length > 0) {
    // Stated as a capability, not as an apology for having lost context:
    // earlier turns are indexed above by seq, and this is where the full text
    // lives. One line, no reassurance.
    lines.push('', `更早的原文在源会话 ${sourceSessionId}，按上面索引里的 seq 用 graft_read_result 取。`)
  }
  if (hasWorkspaceFiles) {
    lines.push('', '写过/改过的文件见下方 [Workspace Files]，不需要重新列目录。')
  }
  // v0.13 GUARD: the durable copy of the workspace boundary.
  //
  // The system head is a throwaway node — the host overwrites it on the target's
  // first live step — so a red line parked there never reaches the model. This
  // user/message does, and it is the same channel the HARD CONSTRAINTS use.
  if (redlineBlock.length > 0) lines.push('', redlineBlock)
  return {
    id: messageId,
    role: 'user',
    content: [{ type: 'text', text: lines.join('\n') }],
    // v7.0 P5: marked, so a later graft never reads this back as a real user
    // turn. Without it, generation 2 replays generation 1's copy of the
    // conversation, and each hop moves further from what was actually said.
    source: { kind: GRAFT_REPLAY_SOURCE_KIND },
  }
}

/**
 * v5.2 标题清洗：提取到的"目标"有时是整段 JSON 或带方括号的原始载荷。
 * 那种标题在侧边栏里不可读，直接回退成时间戳形式。
 */
/**
 * v6.1: the sidebar title must distinguish two migrations of the same source.
 *
 * Two targets created from one session produced byte-identical titles, so the
 * second looked like it had vanished from the sidebar — it was there, hiding
 * under the first one's name. A per-target suffix makes them distinguishable.
 */
function sessionTitleForGoal(goal: string, targetSessionId?: string): string {
  // v7.0: callers reach this with a possibly-absent goal (a report field that
  // was not populated, a legacy caller). Coercing here keeps the sidebar title
  // safe without every call site guarding the same thing.
  const normalized = String(goal ?? '').replace(/\s+/gu, ' ').trim()
  const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ')
  // v6.0：宁可回退到时间戳，也绝不让半个 JSON 括号出现在侧边栏。
  const looksStructured =
    normalized.length === 0 ||
    /[{}[\]"]/u.test(normalized) ||
    /"kind"\s*:/u.test(normalized) ||
    /kind\s*:\s*persistent/u.test(normalized) ||
    /persistent-capability-seed/u.test(normalized) ||
    /^[\[{]/.test(normalized)
  // The id tail is what makes two targets of one source distinct.
  const suffix =
    typeof targetSessionId === 'string' && targetSessionId.length > 6
      ? ` · ${targetSessionId.slice(-6).replace(/^[-_]+/u, '')}`
      : ''
  if (looksStructured) return `[接续] ${stamp}${suffix}`
  const head = Array.from(normalized).slice(0, 18).join('')
  return `[接续] ${head || '会话交接'}${suffix}`
}

/**
 * v7.0 C1: the system head must carry NOTHING that has to survive.
 *
 * Verified against DSH source (`dsh-agent-loop`, `SystemPromptProjection`):
 *
 *   project(rendered, { inHistory, startsSeries }) {
 *     const head = nodes[0]
 *     if (!inHistory || startsSeries || rendered.length === 0) {
 *       const updates = nodes.slice(1).filter(n => n.text !== '').map(n => replace(n.seq, ''))
 *       if (head.text !== rendered) updates.push(replace(head.seq, rendered))   // <-- node 0 REPLACED
 *       return updates
 *     }
 *   }
 *
 * So on the target's first live step the host overwrites surface node 0 with its
 * own rendered system prompt, and clears any extra system nodes. Anything grafted
 * into the system head — including the HARD CONSTRAINTS block this file used to
 * append there — is destroyed before the model ever reads it.
 *
 * The schema forces the choice: `system/message` must source `kind: 'system-prompt'`,
 * and `deriveMessages()` emits it as `role: 'system'`, so it can never ride along
 * as a durable user turn. The only structure that survives is node 0 holding a
 * throwaway marker, with every payload moved to non-system surfaces.
 *
 * Constraints now travel in the goal `user/message` (see goalMessage), which the
 * host does not rewrite.
 */
function systemMessage(
  text: string,
  skeletonTurn: number,
  skeletonStep: number,
  messageId: string,
): Record<string, any> {
  return {
    turn: skeletonTurn,
    step: skeletonStep,
    message: {
      id: messageId,
      role: 'system',
      content: [{ type: 'text', text }],
      source: { kind: 'system-prompt' },
    },
  }
}

function assistantMessage(
  text: string,
  source: GraftSource,
  skeletonTurn: number,
  skeletonStep: number,
  messageId: string,
): Record<string, any> {
  return {
    turn: skeletonTurn,
    step: skeletonStep,
    message: {
      id: messageId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source,
    },
    // v2.1: synthetic or rewritten text has no model stream. Empty is the
    // value both the seed and restore gates accept; copying a source stream
    // would make content and stream disagree.
    stream: [],
  }
}

function assertLogOnly(event: SessionEventLike, type: string): void {
  if (event.surfaceOp !== undefined) {
    throw graftError('RED_LINE_SKELETON_SURFACE', `${type} must not carry surfaceOp`)
  }
  if (event.sourceEventSeqs !== undefined) {
    throw graftError('RED_LINE_SKELETON_SURFACE', `${type} must not carry sourceEventSeqs`)
  }
}

function assertMessageSurface(event: SessionEventLike, type: string): void {
  if (event.surfaceOp !== 'append') {
    throw graftError('RED_LINE_MESSAGE_SURFACE', `${type} must carry { surfaceOp: 'append' }`)
  }
  if (type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
    throw graftError('RED_LINE_ASSISTANT_SOURCE_EVENTS', 'assistant/message must not carry sourceEventSeqs')
  }
}

/**
 * v0.32 (0.2.2 P0): build the tape as plain `SessionEvent` objects.
 *
 * DSH 0.2.2 moved `Session.append()` behind the store lifecycle: `prepare()`
 * returns a session that is read-only until `enter()` + `announce()` publish it,
 * and appending before that throws `cannot append outside a SessionStore`.
 *
 * This plugin must keep the target COLD. Publishing it into the live store would
 * make a later `agents.resume()` collide with the live entry (see the client
 * announcement note in `graftSliceAndInjectUnlocked`), and an unannounced entry
 * is exactly the half-live target that broke DSH restart recovery before.
 *
 * So the tape is materialised from the PUBLIC event contract instead: events are
 * contiguous from seq 0, a surface event carries `surfaceOp: 'append'`, and a
 * log-only event carries neither surface field. That is the same shape the old
 * `Session.append()` produced; only the store-owned writer is gone.
 */
function materializeTape(
  events: ReadonlyArray<{ type: string; data: Record<string, any>; surface: boolean }>,
  createdAt: number,
): SessionEventLike[] {
  return events.map((item, index) => {
    const event: SessionEventLike = {
      type: item.type,
      seq: index,
      time: createdAt + index,
      data: item.data,
      ...(item.surface ? { surfaceOp: 'append' as const } : {}),
    }
    if (!item.surface) {
      assertLogOnly(event, item.type)
      return event
    }
    assertMessageSurface(event, item.type)
    if (item.type === 'system/message') {
      if (event.sourceEventSeqs !== undefined) {
        throw graftError('RED_LINE_SYSTEM_SOURCE_EVENTS', 'system/message must not carry sourceEventSeqs')
      }
      if (event.data?.message?.role !== 'system') {
        throw graftError('RED_LINE_SYSTEM_ROLE', 'system/message data.message.role must be system')
      }
      if (event.data?.message?.source?.kind !== 'system-prompt') {
        throw graftError('RED_LINE_SYSTEM_SOURCE', 'system/message source.kind must be system-prompt')
      }
      if (!Array.isArray(event.data?.message?.content) || event.data.message.content.length === 0) {
        throw graftError('RED_LINE_SYSTEM_CONTENT', 'system/message must have non-empty content')
      }
      return event
    }
    if (item.type === 'assistant/message') {
      if (!Array.isArray(event.data?.stream) || event.data.stream.length !== 0) {
        throw graftError('RED_LINE_ASSISTANT_STREAM', 'assistant/message stream must be []')
      }
      if (event.data?.message?.role !== 'assistant') {
        throw graftError('RED_LINE_ASSISTANT_ROLE', 'assistant/message data.message.role must be assistant')
      }
      const sourceKind = event.data?.message?.source?.kind
      if (typeof sourceKind !== 'string' || sourceKind.length === 0 || sourceKind === 'plugin') {
        throw graftError('RED_LINE_SOURCE_KIND', 'assistant/message source.kind must be producer-owned, not plugin')
      }
    }
    return event
  })
}

function sourceForReport(source: GraftSource): GraftSource {
  const copy: GraftSource = { kind: source.kind }
  if (source.provider !== undefined) copy.provider = source.provider
  if (source.model !== undefined) copy.model = source.model
  return copy
}

/**
 * A handoff session is a new top-level session, never a subagent/fork child.
 * The real v4 header names the parent `parentSession`; older drafts used
 * `parentSessionId`, and `lineage` is checked defensively for compatibility.
 */
function assertTopLevelHeader(header: SessionHeaderLike): void {
  const candidate = header as any
  const hasLineage =
    candidate.parentSession !== undefined ||
    candidate.parentSessionId !== undefined ||
    candidate.lineage !== undefined ||
    candidate.origin === 'subagent' ||
    (typeof candidate.delegationDepth === 'number' && candidate.delegationDepth !== 0)
  if (hasLineage) {
    throw graftError('LINEAGE_NOT_EMPTY', 'GRAFT_ERROR: lineage must be empty')
  }
  if (candidate.isSeeded !== false) {
    throw graftError('SEEDED_HEADER', 'GRAFT_ERROR: migrated header must be unseeded')
  }
}

/** Build the full event list in memory and enforce every red line before any I/O. */
function injectionSource(plan: GraftPlan, settings: Required<GraftConfig>): GraftSource {
  if (plan.sourceTemplate.kind === 'model') return plan.sourceTemplate
  // DSH's runtime validator requires injected assistant messages to carry a
  // model source. Sources that contain no assistant turn (for example a
  // single-turn RULER haystack) fall back to the configured extractor model.
  return {
    kind: 'model',
    provider: settings.constraintProvider || 'deepseek-account',
    model: settings.constraintModel || 'deepseek-flash',
  }
}

/**
 * v5.2: the runtime knobs DSH itself records as durable intent.
 *
 * These are NOT `request/header`. A `request/header` is one model call's epoch
 * header: copying it into another session forges a request that never happened
 * and corrupts restore. The events below are what DSH appends when the user
 * changes a knob, and every one of them is folded by a registered projection:
 *
 *   model/selection    -> api-session-controller `modelSelection`
 *   permission/preset  -> permission-presets `permissions`
 *   sandbox/mode       -> permission-presets `permissions`
 *   approval/policy    -> permission-presets `permissions`
 *
 * Writing them at seed time makes the target resume with the source's chosen
 * model and permission posture, using the same mechanism the UI uses.
 */
export interface RuntimeIntent {
  model?: { provider: string; model: string; reasoningEffort?: string }
  permission?: { preset: string }
  sandbox?: { mode: string }
  approval?: { policy: string }
}

export function extractRuntimeIntent(events: readonly SessionEventLike[]): RuntimeIntent {
  const intent: RuntimeIntent = {}
  for (const event of events) {
    if (event.type === 'model/selection') {
      const provider = event.data?.provider
      const model = event.data?.model
      if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
        intent.model = {
          provider,
          model,
          ...(typeof event.data?.reasoningEffort === 'string' && event.data.reasoningEffort.length > 0
            ? { reasoningEffort: event.data.reasoningEffort }
            : {}),
        }
      }
      continue
    }
    if (event.type === 'permission/preset') {
      if (typeof event.data?.preset === 'string' && event.data.preset.length > 0) intent.permission = { preset: event.data.preset }
      continue
    }
    if (event.type === 'sandbox/mode') {
      if (typeof event.data?.mode === 'string' && event.data.mode.length > 0) intent.sandbox = { mode: event.data.mode }
      continue
    }
    if (event.type === 'approval/policy') {
      if (typeof event.data?.policy === 'string' && event.data.policy.length > 0) intent.approval = { policy: event.data.policy }
    }
  }
  return intent
}

function buildInjectionEvents(
  plan: GraftPlan,
  settings: Required<GraftConfig>,
  newSessionId: string,
  sourceSessionId: string,
  runtimeIntent?: RuntimeIntent,
  /** v7.0 P1-1: the SOURCE log, scanned for an active `goal/change` to carry. */
  goalSourceEvents?: readonly SessionEventLike[],
): Array<{
  type: string
  data: Record<string, any>
  surface: boolean
}> {
  const turn = settings.skeletonTurn
  const step = settings.skeletonStep
  if (!Number.isSafeInteger(turn) || turn < 0) throw graftError('INVALID_CONFIG', 'skeletonTurn must be a non-negative safe integer')
  if (!Number.isSafeInteger(step) || step < 0) throw graftError('INVALID_CONFIG', 'skeletonStep must be a non-negative safe integer')
  if (plan.chunks.length === 0) throw graftError('EMPTY_PLAN', 'injection plan contains no assistant chunks')

  const events: Array<{ type: string; data: Record<string, any>; surface: boolean }> = []
  // v0.13 GUARD: rendered once, used in both channels (see workspaceRedline).
  const redlineBlock = settings.workspaceRedline ? workspaceRedline(plan.cwd) : ''
  events.push({ type: 'turn/start', data: { turn }, surface: false })
  events.push({ type: 'step/start', data: { turn, step }, surface: false })
  // v4 restore requires the first surface node to be a protected system head.
  // Appending the resumed agent's system prompt after user/assistant nodes is
  // rejected with "system/message requires a protected first surface head".
  //
  // v7.0 C1: this node is a throwaway. The host replaces it on the target's
  // first live step, so no constraint or instruction is placed here.
  events.push({
    type: 'system/message',
    data: systemMessage(redlineBlock.length > 0 ? migrationSystemPrompt(plan.cwd) : MIGRATION_SYSTEM_PROMPT, turn, step, `graft-${newSessionId}-system`),
    surface: true,
  })
  events.push({
    type: 'user/message',
    data: goalMessage(
      plan.cwd,
      plan.goal,
      plan.phase,
      `graft-${newSessionId}-goal`,
      sourceSessionId,
      plan.workspaceFiles.length > 0,
      plan.constraints,
      redlineBlock,
      plan.generation,
      // v0.21 P1: the boundary seq travels in the identity metadata, so a later
      // reader can re-cut from the exact origin instead of hunting for it.
      Number(plan.boundary?.boundarySeq ?? 0),
    ),
    surface: true,
  })
  // A durable, human-readable title for the sidebar. Log-only: it is not a
  // surface event, so it cannot affect the protected system head.
  events.push({
    type: 'session/title',
    data: {
      title: sessionTitleForGoal(plan.goal, newSessionId),
      // v7.3 CRITICAL: an EMPTY `messageSeqs` requires `source.kind: 'user'`.
      //
      // Verified against the host's own v3→v4 validator
      // (`dsh-session-format-v3-to-v4`, `titleSources`):
      //
      //   if (event.type === "session/title"
      //       && references.length === 0 !== (data.source.kind === "user"))
      //     throw new SessionFormatError(
      //       "session/title messageSeqs must be empty exactly for a user title")
      //
      //   for (const value of references) {
      //     const source = events[seq]
      //     if (seen.has(seq) || source?.type !== "user/message"
      //         || source.data.source.kind !== "user")
      //       throw new SessionFormatError(
      //         "… messageSeqs must cite distinct earlier human user/message events")
      //   }
      //
      // A graft target contains NO human user message — its only user/message is
      // the plugin-authored goal (`plugin:graft-replay`). So there is no seq this
      // title could legally cite, and the ONLY valid shape is empty refs paired
      // with `kind: 'user'`. Writing `kind: 'fallback'` here produced a title the
      // host refuses to load, which made EVERY target unopenable: 285 corrupt
      // sessions in the live store before this was found.
      messageSeqs: [],
      source: { kind: 'user' },
    },
    surface: false,
  })
  for (const [index, chunk] of plan.chunks.entries()) {
    events.push({
      type: 'assistant/message',
      data: assistantMessage(
        chunk.text,
        injectionSource(plan, settings),
        turn,
        step,
        `graft-${newSessionId}-${index}`,
      ),
      surface: true,
    })
  }
  // v7.0 P9: the wake directive is gone.
  //
  // v6.0 appended a final assistant block: "系统强制指令：不要复述上文，不要总结
  // 你读到了什么，也不要描述你打算怎么做。立刻根据上面「接下来我需要……」那一句，
  // 调用相应工具执行第一个动作。"
  //
  // It was written for a tape that read as a work log, where the model needed to
  // be told not to summarise it. The tape is now a replay of 【用户】/【我】
  // turns, so the natural next token IS a reply to the last user message — the
  // directive has nothing left to correct.
  //
  // What it still does is cost: it occupies the recency position that belongs to
  // the conversation, and it announces "you are reading a system document",
  // which is precisely the outline feel the replay was built to remove. The
  // natural-language nudge now lives at the end of the pending state, inside the
  // assistant's own voice.
  events.push({ type: 'step/end', data: { turn, step }, surface: false })
  events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, surface: false })
  // Runtime intent last, after the closed turn, exactly where DSH writes it:
  // these are log-only knob records folded by the modelSelection/permissions
  // projections, never a forged model request.
  if (runtimeIntent !== undefined) {
    if (runtimeIntent.permission !== undefined) {
      events.push({ type: 'permission/preset', data: runtimeIntent.permission, surface: false })
    }
    if (runtimeIntent.sandbox !== undefined) {
      events.push({ type: 'sandbox/mode', data: runtimeIntent.sandbox, surface: false })
    }
    if (runtimeIntent.approval !== undefined) {
      events.push({ type: 'approval/policy', data: runtimeIntent.approval, surface: false })
    }
    if (runtimeIntent.model !== undefined) {
      events.push({ type: 'model/selection', data: runtimeIntent.model, surface: false })
    }
  }
  // v7.0 P1-1: carry the source's active goal across the migration.
  //
  // A DSH goal is not external state — it is a `goal/change` EVENT appended to
  // the session log (verified in `dsh-goal`: `agent.session.append("goal/change",
  // change)`). The graft slices the log up to the last `turn/end` and copies only
  // SURFACE events, so every `goal/change` — being log-only and typically written
  // outside the retained window — is dropped. The target then resumes with no
  // active goal even though the source had one.
  //
  // The event shape is copied verbatim from the source's newest change record,
  // with `updatedAt` advanced so the target's own clock ordering holds. The
  // projection reads the latest `goal/change` per session, so appending one here
  // establishes the goal for the target without touching the goal service.
  const goalChange = extractActiveGoalChange(goalSourceEvents ?? [])
  if (goalChange !== undefined) {
    events.push({ type: 'goal/change', data: goalChange, surface: false })
  }
  return events
}

function assertColdLog(
  cold: SessionLogSnapshotLike,
  cwd: string,
  expectedTypes: readonly string[],
  skeletonTurn: number,
  skeletonStep: number,
): void {
  if (Number(cold.inheritedEventCount ?? 0) !== 0) {
    throw graftError('COLD_READ_MISMATCH', `cold-read inheritedEventCount is ${String(cold.inheritedEventCount)}, expected 0`)
  }
  if (cold.session?.cwd !== cwd) {
    throw graftError(
      'COLD_READ_MISMATCH',
      `cold-read cwd ${JSON.stringify(cold.session?.cwd)} is not the exact source cwd ${JSON.stringify(cwd)}`,
    )
  }
  assertTopLevelHeader(cold.session)
  const events = Array.isArray(cold.events) ? cold.events : []
  if (events.length !== expectedTypes.length) {
    throw graftError(
      'COLD_READ_MISMATCH',
      `cold-read event count ${events.length} does not match written count ${expectedTypes.length}`,
    )
  }
  for (const [index, event] of events.entries()) {
    if (Number(event.seq) !== index) {
      throw graftError('COLD_READ_MISMATCH', `cold-read event ${index} has seq ${String(event.seq)}`)
    }
    if (event.type !== expectedTypes[index]) {
      throw graftError(
        'COLD_READ_MISMATCH',
        `cold-read event ${index} is ${event.type}, expected ${expectedTypes[index]}`,
      )
    }
    if (event.type === 'tool/result') {
      throw graftError('RED_LINE_TOOL_RESULT', 'cold-read log contains a standalone tool/result')
    }
    if (event.type === 'turn/start') {
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        throw graftError('RED_LINE_SKELETON_SURFACE', 'turn/start carries surface metadata in the cold-read log')
      }
      if (event.data?.turn !== skeletonTurn) {
        throw graftError('COLD_READ_MISMATCH', `turn/start has turn ${String(event.data?.turn)}, expected ${skeletonTurn}`)
      }
      continue
    }
    if (event.type === 'step/start') {
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        throw graftError('RED_LINE_SKELETON_SURFACE', 'step/start carries surface metadata in the cold-read log')
      }
      if (event.data?.turn !== skeletonTurn || event.data?.step !== skeletonStep) {
        throw graftError('COLD_READ_MISMATCH', 'step/start does not match the configured skeleton')
      }
      continue
    }
    if (event.type === 'step/end') {
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        throw graftError('RED_LINE_SKELETON_SURFACE', 'step/end carries surface metadata in the cold-read log')
      }
      if (event.data?.turn !== skeletonTurn || event.data?.step !== skeletonStep) {
        throw graftError('COLD_READ_MISMATCH', 'step/end does not match the configured skeleton')
      }
      continue
    }
    if (event.type === 'turn/end') {
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        throw graftError('RED_LINE_SKELETON_SURFACE', 'turn/end carries surface metadata in the cold-read log')
      }
      if (event.data?.turn !== skeletonTurn) {
        throw graftError('COLD_READ_MISMATCH', 'turn/end does not match the configured skeleton')
      }
      continue
    }
    if (event.type === 'system/message') {
      if (event.surfaceOp !== 'append') {
        throw graftError('RED_LINE_MESSAGE_SURFACE', 'system/message is not an append surface event')
      }
      if (event.sourceEventSeqs !== undefined) {
        throw graftError('RED_LINE_SYSTEM_SOURCE_EVENTS', 'system/message carries sourceEventSeqs')
      }
      if (event.data?.turn !== skeletonTurn || event.data?.step !== skeletonStep) {
        throw graftError('COLD_READ_MISMATCH', 'system/message does not match the open skeleton step')
      }
      if (event.data?.message?.role !== 'system') {
        throw graftError('RED_LINE_SYSTEM_ROLE', 'system/message data.message.role is not system')
      }
      if (event.data?.message?.source?.kind !== 'system-prompt') {
        throw graftError('RED_LINE_SYSTEM_SOURCE', 'system/message source.kind is not system-prompt')
      }
      continue
    }
    if (event.type === 'session/title') {
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        throw graftError('RED_LINE_TITLE_SURFACE', 'session/title must not carry surface metadata')
      }
      if (typeof event.data?.title !== 'string' || event.data.title.length === 0) {
        throw graftError('RED_LINE_TITLE_EMPTY', 'session/title must carry a non-empty title')
      }
      // v7.3 CRITICAL: enforce the host's real title rule.
      //
      // The cold-log validator checked only "non-empty" and "no surface metadata",
      // which is why 285 corrupt targets passed 181 tests and were then rejected by
      // the host on load. The rule, copied from
      // `dsh-session-format-v3-to-v4/titleSources`:
      //
      //   empty messageSeqs  <=>  source.kind === 'user'
      //   non-empty          =>  every seq cites an EARLIER user/message whose
      //                          source.kind === 'user' (a human message)
      //
      // A graft target has no human message, so the only valid shape is empty refs
      // with `kind: 'user'`. Checking it here makes a regression fail locally
      // instead of producing a session the host cannot open.
      const titleRefs = Array.isArray(event.data?.messageSeqs) ? event.data.messageSeqs : []
      const titleSourceKind =
        typeof event.data?.source?.kind === 'string' ? event.data.source.kind : undefined
      if ((titleRefs.length === 0) !== (titleSourceKind === 'user')) {
        throw graftError(
          'RED_LINE_TITLE_SOURCE',
          'session/title messageSeqs must be empty exactly for a user title (empty refs require source.kind "user")',
        )
      }
      if (titleRefs.length > 0) {
        const seenTitleRefs = new Set<number>()
        for (const value of titleRefs) {
          const refSeq = Number(value)
          if (!Number.isSafeInteger(refSeq) || refSeq >= Number(event.seq)) {
            throw graftError('RED_LINE_TITLE_REF', `session/title cites seq ${String(value)}, which is not earlier`)
          }
          if (seenTitleRefs.has(refSeq)) {
            throw graftError('RED_LINE_TITLE_REF', `session/title cites seq ${refSeq} twice`)
          }
          seenTitleRefs.add(refSeq)
          const cited = events.find((candidate) => Number(candidate.seq) === refSeq)
          if (cited === undefined || cited.type !== 'user/message') {
            throw graftError('RED_LINE_TITLE_REF', `session/title cites seq ${refSeq}, which is not a user/message`)
          }
          if (cited.data?.source?.kind !== 'user') {
            throw graftError(
              'RED_LINE_TITLE_REF',
              `session/title cites seq ${refSeq}, whose source.kind is not "user" (not a human message)`,
            )
          }
        }
      }
      continue
    }
    if (event.type === 'user/message') {
      if (event.surfaceOp !== 'append') {
        throw graftError('RED_LINE_MESSAGE_SURFACE', 'user/message is not an append surface event')
      }
      continue
    }
    if (
      event.type === 'model/selection' ||
      event.type === 'permission/preset' ||
      event.type === 'sandbox/mode' ||
      event.type === 'approval/policy' ||
      event.type === 'goal/change'
    ) {
      // Runtime-intent knobs and the carried goal: log-only, folded by their
      // projections. They must never carry surface metadata.
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        throw graftError('RED_LINE_SKELETON_SURFACE', `${event.type} must not carry surface metadata`)
      }
      continue
    }
    if (event.type === 'assistant/message') {
      if (event.surfaceOp !== 'append') {
        throw graftError('RED_LINE_MESSAGE_SURFACE', 'assistant/message is not an append surface event')
      }
      if (event.sourceEventSeqs !== undefined) {
        throw graftError('RED_LINE_ASSISTANT_SOURCE_EVENTS', 'assistant/message carries sourceEventSeqs')
      }
      if (!Array.isArray(event.data?.stream) || event.data.stream.length !== 0) {
        throw graftError('RED_LINE_ASSISTANT_STREAM', 'assistant/message stream is not []')
      }
      if (event.data?.turn !== skeletonTurn || event.data?.step !== skeletonStep) {
        throw graftError('COLD_READ_MISMATCH', 'assistant/message does not match the open skeleton step')
      }
      const kind = event.data?.message?.source?.kind
      if (typeof kind !== 'string' || kind.length === 0 || kind === 'plugin') {
        throw graftError('RED_LINE_SOURCE_KIND', 'assistant/message source is not producer-owned')
      }
    }
  }

  const surfaceEvents = events.filter(
    (event) => event.type === 'system/message' || event.type === 'user/message' || event.type === 'assistant/message',
  )
  if (surfaceEvents[0]?.type !== 'system/message') {
    throw graftError('RED_LINE_SYSTEM_HEAD', 'the first surface event must be a system/message')
  }
}

/**
 * v7.0 P1-1: the newest `goal/change` record from a source log, if any.
 *
 * Only a change that leaves an ACTIVE goal is carried: a `clear`/`complete`
 * operation at the tail means the source had no goal, and copying it would
 * resurrect one the user already finished.
 */
function extractActiveGoalChange(events: readonly SessionEventLike[]): Record<string, unknown> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'goal/change') continue
    const data = event.data
    if (!isRecord(data)) return undefined
    const operation = typeof data.operation === 'string' ? data.operation : ''
    // A terminal record means "there is no goal any more".
    if (/^(clear|complete|abandon|block)$/iu.test(operation)) return undefined
    const goal = data.goal
    if (!isRecord(goal)) return undefined
    const objective = goal.objective
    if (typeof objective !== 'string' || objective.trim().length === 0) return undefined
    // Copy the record as-is and refresh the mutation time: the goal service
    // clamps backward wall-clock movement, so an older `updatedAt` on a newer
    // event would be rejected as a stale mutation.
    return {
      ...data,
      updatedAt: Math.max(
        Date.now(),
        typeof data.updatedAt === 'number' ? data.updatedAt : 0,
      ),
    }
  }
  return undefined
}


// ===========================================================================
// Phase 4 — durable write, retirement and fallback read
// ===========================================================================

const retiredSessions = new Set<string>()
const transferredSessions = new Map<string, { newSessionId: string; at: number; reason: string }>()
const autoGraftInFlight = new Set<string>()
const autoGraftStates = new Map<string, 'idle' | 'grafting' | 'done'>()
const transitionCards = new Set<string>()
const inFlight = new Set<string>()

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
let retiredStorePath = join(PLUGIN_DIR, '.retired.json')
let transferredStorePath = join(PLUGIN_DIR, '.transferred.json')
/** v7.0: persisted graft-target marks (chain guard + protection across restarts). */
let graftTargetsPath = join(PLUGIN_DIR, '.graft-targets.json')
/**
 * v7.4 P0-2: the durable transaction journal, one file per in-flight migration.
 *
 * The old `.incomplete` breadcrumb was a single overwritten file that NOTHING ever
 * read: a crash left it lying there and the next start behaved as if the failed
 * migration had never happened. It could not answer the two questions recovery
 * needs — "which target was being built?" and "how far did it get?" — and because
 * it was one file, two concurrent migrations would erase each other's evidence.
 *
 * One file per SOURCE session fixes both: the name identifies the migration, and
 * the record carries the stage reached.
 */
let txnDirPath = join(PLUGIN_DIR, '.txn')
/** The context captured by `configureRetiredStore`, reused by later store writes. */
let storeCtx: PluginContextLike | undefined
function ctxForStores(): PluginContextLike | undefined {
  return storeCtx
}
let storeScope = 'plugin-dir'

/**
 * Resolve the profile-private directory that owns the retirement stores.
 *
 * Isolation matters: `.retired.json` decides which sessions a pre-step gate
 * refuses. Sharing one file across profiles (or across work-spaces in one
 * profile) lets a test retirement silently block a real session.
 *
 * Resolution order:
 *   1. `ctx.paths.data`   — the profile's declared data dir, when the service
 *                           is mounted (it is not in every profile).
 *   2. `DSH_PROFILE_DIR`  — the launcher's own profile directory.
 *   3. `DSH_HOME/profiles/<DSH_PROFILE>` — same value, derived by hand.
 *   4. the plugin directory — last resort, logged as a warning because it is
 *      shared by every profile that loads this plugin.
 */
function resolveStoreDir(ctx: PluginContextLike, explicit?: string): { dir: string; scope: string } {
  if (typeof explicit === 'string' && explicit.length > 0) {
    return { dir: explicit, scope: 'config.dataDir' }
  }
  let paths: unknown
  try {
    paths = typeof ctx.get === 'function' ? ctx.get('paths') : undefined
  } catch {
    // Cordis service proxies may reject undeclared property reads.
    paths = undefined
  }
  if (isRecord(paths) && typeof paths.data === 'string' && paths.data.length > 0) {
    return { dir: paths.data, scope: 'paths.data' }
  }
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    return { dir: join(profileDir, 'data', 'dsh-graft-slice'), scope: 'DSH_PROFILE_DIR' }
  }
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (typeof home === 'string' && home.length > 0) {
    const suffix = typeof profile === 'string' && profile.length > 0 ? ['profiles', profile] : ['plugin-data']
    return { dir: join(home, ...suffix, 'data', 'dsh-graft-slice'), scope: 'DSH_HOME' }
  }
  return { dir: PLUGIN_DIR, scope: 'plugin-dir' }
}

/** Load durable retirement IDs. Missing/corrupt files never block activation. */
function configureRetiredStore(ctx: PluginContextLike, settings: Required<GraftConfig>): void {
  const resolved = resolveStoreDir(ctx, settings.dataDir)
  const dataDir = resolved.dir
  storeScope = resolved.scope
  storeCtx = ctx
  retiredStorePath = join(dataDir, '.retired.json')
  transferredStorePath = join(dataDir, '.transferred.json')
  graftTargetsPath = join(dataDir, '.graft-targets.json')
  txnDirPath = join(dataDir, '.txn')
  constraintSectionsPath = join(dataDir, '.graft-constraint-sections.json')
  pendingConstraintsPath = join(dataDir, '.pending-constraints.json')
  // v0.19: the ignition queue lives with the rest of the per-profile state, so a
  // crash between "target durable" and "target running" is recoverable per profile.
  pendingIgnitionPath = join(dataDir, '.graft-pending-ignition.json')
  draftsPath = join(dataDir, '.graft-drafts.json')
  preparedStorePath = join(dataDir, '.graft-prepared.json')
  leftoversStorePath = join(dataDir, '.graft-leftovers.json')
  autoGraftSuppressedPath = join(dataDir, '.auto-graft-suppressed.json')
  // v1.1 OBSERVER: the follower pointer. Same directory, same isolation as the
  // retirement ledger, because it is the same kind of fact: "which session is this
  // one's successor".
  observerBindingsPath = join(dataDir, 'observer-bindings.json')
  // Create the profile-private directory up front: it proves the location is
  // writable at activation time instead of failing mid-migration, and it makes
  // the isolation target observable.
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot create ${dataDir}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not block activation.
    }
  }
  if (storeScope === 'plugin-dir') {
    try {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] state is shared across profiles at ${dataDir}. Set config.dataDir per profile to isolate retirement and drafts.`,
      )
    } catch {
      // Logging must not block activation.
    }
  }
  // v0.18: both ledgers are read through the epoch-aware reader. A ledger from a
  // newer writer, or a torn one, is REFUSED rather than half-understood.
  for (const [path, label] of [
    [transferredStorePath, 'transferred'],
    [retiredStorePath, 'retired'],
  ] as const) {
    const defect = ledgerDefectOf(path)
    if (defect !== undefined) {
      try {
        ctx.logger?.warn?.(
          `[dsh-graft-slice] ${label} ledger at ${path} is not trustworthy this round (${defect}); ` +
            'its entries are ignored until a complete write lands (versions must not read half a record).',
        )
      } catch {
        // Logging must not block activation.
      }
    }
  }
  try {
    const parsed = ledgerRecord(transferredStorePath)
    if (isRecord(parsed)) {
      for (const [id, value] of Object.entries(parsed)) {
        if (!isRecord(value) || typeof value.newSessionId !== 'string') continue
        transferredSessions.set(id, {
          newSessionId: value.newSessionId,
          at: typeof value.at === 'number' ? value.at : 0,
          reason: typeof value.reason === 'string' ? value.reason : `已转移至新会话 ${value.newSessionId}`,
        })
      }
    }
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${transferredStorePath}: ${String((error as any)?.message ?? error)}`)
      } catch {
        // Logging must not block activation.
      }
    }
  }
  try {
    const parsed = ledgerArray(retiredStorePath)
    for (const id of parsed) {
      if (typeof id === 'string' && id.length > 0) retiredSessions.add(id)
    }
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${retiredStorePath}: ${String((error as any)?.message ?? error)}`)
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

/**
 * v5.2 补丁二：后台 LLM 约束提取。
 *
 * 迁移关键路径只用正则 FAST_CONSTRAINTS：LLM 调用随源历史增长而变慢，放在
 * 关键路径上会直接推高「触发到看到新会话」的延迟。
 *
 * 流程：迁移完成 → 后台跑 LLM → 成功后暂存 pending 约束 → target 下一次
 * pre-step 以 developer/message 静默注入一次。
 *
 * 失败时保留正则结果，不回滚迁移：约束质量下降是次要问题，迁移已经成功。
 */
interface PendingConstraintPayload {
  sourceSessionId: string
  targetSessionId: string
  constraints: string[]
  source: 'llm'
  extractedAt: number
}

/**
 * v6.0 补丁一：草稿捕获。
 *
 * 用户在旧会话被拦截的那一瞬间正在输入的内容，不应该凭空消失。
 * 拦截时捕获，写盘；target 第一次收到输入时把草稿和新输入合并成一条，
 * 然后立刻删除——只生效一次。
 */
interface DraftPayload {
  sourceSessionId: string
  targetSessionId: string
  text: string
  capturedAt: number
}

const draftPayloads = new Map<string, DraftPayload>()
let draftsLoaded = false

/**
 * v7.0 (adopted from dsh-rollover-snapshot): report constraints that went missing.
 *
 * rollover-snapshot's measured finding is the reason this exists: across four
 * production sessions, *every* context crossing lost rules while the checkpoint
 * grew, and one crossing dropped a user's "do not install into the real
 * desktop" constraint. The summary looked healthier (more text) while being less
 * correct.
 *
 * The graft builder never drops a declared rule, but "the builder is correct" is
 * exactly the assumption that failed there. The rules can shrink for reasons
 * outside the builder: the LLM constraint refiner returns a shorter set, a
 * config change narrows the source, an async refinement lands after the fact.
 * Nothing else in the pipeline compares generation N-1 with generation N.
 *
 * Comparison is on normalized text (whitespace collapsed, lowercased) because a
 * reflowed rule is still the same rule; a rule whose *number* changed is a
 * different rule and does not count as drift.
 */
export interface ConstraintDrift {
  constraint: string
  previousSessionId: string
}

export function verifyHardConstraints(
  previousConstraints: readonly string[],
  nextConstraints: readonly string[],
  previousSessionId: string,
): ConstraintDrift[] {
  const normalize = (text: string): string => text.replace(/\s+/gu, ' ').trim().toLowerCase()
  const next = new Set(nextConstraints.map(normalize).filter((line) => line.length > 0))
  const drift: ConstraintDrift[] = []
  const seen = new Set<string>()
  for (const constraint of previousConstraints) {
    const line = normalize(constraint)
    if (line.length === 0 || seen.has(line)) continue
    seen.add(line)
    if (next.has(line)) continue
    drift.push({ constraint, previousSessionId })
  }
  return drift
}

/**
 * v7.0 P0-5: the constraints this plugin keeps rendering into a target's system
 * prompt, keyed by target session id.
 *
 * Separate from `pendingConstraints` (which is a one-shot queued refinement):
 * this map is the durable, every-request source of truth for a target's standing
 * rules. It is in-memory because the goal `user/message` already persists the
 * same list — a restart loses this map and the section renders `''`, while the
 * goal message still carries the constraints, so nothing is lost, only
 * re-hardened once the session is grafted again.
 */
const targetConstraintSections = new Map<string, { constraints: string[]; at: number }>()

/**
 * v7.2: persist the standing-constraint sections.
 *
 * They were in-memory, which made the compaction shield evaporate on restart: the
 * `systemPrompt.section` renderer reads this map, found nothing, and returned `''`
 * — so the target resumed with its constraints only in the goal `user/message`,
 * which is exactly the surface `/compact` can shadow. A shield that a restart
 * removes is not a shield.
 *
 * Written on every new target and read once at activation, next to the other
 * store files so profile isolation is unchanged.
 */
let constraintSectionsPath = join(PLUGIN_DIR, '.graft-constraint-sections.json')

/**
 * v7.2: atomic write — temp file in the same directory, then rename.
 *
 * `writeFileSync(target)` truncates first and writes second, so a crash (or a
 * killed host during a migration) leaves a half-written JSON file. Every reader
 * here tolerates a parse failure by falling back to empty state, which silently
 * discards the very records that were being written — a corrupt retired set means
 * a retired session comes back, a corrupt constraint set means the shield is gone.
 *
 * `rename` is atomic on the same volume on both NTFS and POSIX, so a reader either
 * sees the old file or the new one, never a partial one.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

/**
 * v7.7: one lock per state file, and MERGE (never overwrite) on write.
 *
 * THE BUG THIS CLOSES
 *
 * Every state file used to be written as "serialise my in-memory map and rename
 * it over the old file". `rename` is atomic, so no reader ever saw a torn file —
 * but atomicity is not isolation. Two sessions (two processes, or two agents in
 * one process) each hold a PARTIAL view of `.retired.json`, and the last writer
 * silently replaces the other's entries. Measured consequence in the field:
 * session B's retirement vanished, so B was resurrected after a restart and
 * grafted a second time (two divergent targets), while A saw "already
 * transferred" and reported a false SOURCE_DRIFT.
 *
 * The lock is a directory: `mkdirSync` fails with EEXIST on every platform we
 * ship, which makes it the one primitive that is atomic without a native addon.
 * A lock older than `staleMs` is stolen, because a crashed process must not pin
 * the store forever.
 */
const LOCK_SETTLE_MS = 12
const LOCK_TIMEOUT_MS = 8_000
const LOCK_STALE_MS = 30_000

/**
 * v0.14 CHAIN GUARD: completed turns a fresh target is immune to re-grafting.
 *
 * Two turns is the smallest window that covers the real failure: a target is
 * seeded with a large tape, its provider-usage figure is inherited from the
 * source, and the very first request already sits above the 75% hard cutoff.
 * Without this, generation 2 creates generation 3 before the user has typed
 * anything, and each hop buries the original intent one level deeper.
 */
const GRAFT_CHAIN_GRACE_TURNS = 2

export interface GraftAuditEntry {
  at: string
  kind:
    | 'lock-wait'
    | 'lock-stale'
    | 'lock-owner-mismatch'
    | 'lock-reclaimed'
    | 'command-blocked'
    | 'chain-guard'
    | 'model-nudge'
    | 'nudge-escalation'
    | 'force-graft'
    | 'target-created'
  file?: string
  sessionId?: string
  targetSessionId?: string
  ratio?: number
  waitedMs?: number
  detail?: string
}

/**
 * v7.7: an append-only audit next to the state files.
 *
 * The model-driven nudge is delivered through pre-step `messages`, which the host
 * never logs. Without this file there is no way to prove after the fact that a
 * nudge fired, at what ratio, or that a lock actually contended. One JSON line
 * per event; the write is locked because two processes may append at once.
 */
export function appendGraftAudit(entry: GraftAuditEntry): void {
  const base = dirname(retiredStorePath)
  try {
    mkdirSync(base, { recursive: true })
    const path = join(base, '.graft-audit.jsonl')
    withFileLock(
      path,
      () => {
        appendFileSync(path, JSON.stringify({ ...entry, pid: process.pid }) + '\n', 'utf8')
      },
      { timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_STALE_MS, label: 'audit', silent: true },
    )
  } catch {
    // Audit is evidence, never a gate: a failed line must not change the outcome.
  }
}

/** Block the current thread without burning a core (Atomics.wait is a real sleep). */
function sleepSync(ms: number): void {
  try {
    const waitArray = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(waitArray, 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // last-resort spin
    }
  }
}

function lockDirFor(path: string): string {
  return `${path}.lock`
}

/**
 * Acquire one file lock. Returns the release function (idempotent).
 *
 * `label` is only for the audit line ("which lock did we wait on?"), so an
 * operator can tell a ledger wait from an audit wait.
 */
export function acquireFileLock(
  path: string,
  options: { timeoutMs?: number; staleMs?: number; label?: string; silent?: boolean; leaseMs?: number } = {},
): () => void {
  const lock = lockDirFor(path)
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const label = options.label ?? basename(path)
  // The audit file must never audit its own acquisition: that recursion re-enters
  // this function while the audit lock is still held and deadlocks the thread.
  const silent = options.silent === true
  // v7.8: a lock is OWNED, not merely claimed. The owner file carries a random
  // token; release verifies it, so a late writer cannot delete a lock that was
  // stolen and re-acquired by someone else. The same file is the lease: while the
  // holder is alive it is rewritten every leaseMs/2, so waiters can tell "slow"
  // from "dead".
  const leaseMs = options.leaseMs ?? 30_000
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`
  const ownerFile = join(lock, 'owner')
  const writeOwner = (): void => {
    try {
      writeFileSync(ownerFile, JSON.stringify({ token, pid: process.pid, at: Date.now() }), 'utf8')
    } catch {
      // The lock dir exists; a missing owner file only costs precise stealing.
    }
  }
  const readOwner = (): { token?: string; at?: number } => {
    try {
      return JSON.parse(readFileSync(ownerFile, 'utf8')) as { token?: string; at?: number }
    } catch {
      return {}
    }
  }
  const started = Date.now()
  let reported = false
  for (;;) {
    try {
      mkdirSync(lock)
      writeOwner()
      let renewal: ReturnType<typeof setInterval> | undefined
      if (leaseMs > 0) {
        renewal = setInterval(writeOwner, Math.max(100, Math.floor(leaseMs / 2)))
        // A renewal timer must never keep the host process alive.
        ;(renewal as unknown as { unref?: () => void }).unref?.()
      }
      const held = Date.now() - started
      if (!silent && held > LOCK_SETTLE_MS) {
        appendGraftAudit({ at: new Date().toISOString(), kind: 'lock-wait', file: label, waitedMs: held })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        if (renewal !== undefined) clearInterval(renewal)
        // Owner check: only the holder may remove the lock.
        const owner = readOwner()
        if (owner.token !== undefined && owner.token !== token) {
          appendGraftAudit({
            at: new Date().toISOString(),
            kind: 'lock-owner-mismatch',
            file: label,
            detail: 'release refused: the lock was re-acquired by another owner',
          })
          return
        }
        try {
          rmSync(lock, { recursive: true, force: true })
        } catch {
          // A lock we cannot remove is reported by the next waiter as stale.
        }
      }
    } catch (error) {
      if ((error as any)?.code !== 'EEXIST') throw error
    }
    // Stale detection: a killed process leaves the directory behind, and its
    // lease stops being renewed. Prefer the lease timestamp over the dir mtime,
    // because the dir mtime cannot be renewed without unlinking the lock.
    try {
      const owner = readOwner()
      const leaseAt = Number.isFinite(Number(owner.at)) ? Number(owner.at) : statSync(lock).mtimeMs
      if (Date.now() - leaseAt > staleMs) {
        rmSync(lock, { recursive: true, force: true })
        appendGraftAudit({ at: new Date().toISOString(), kind: 'lock-stale', file: label, detail: 'stolen after staleMs' })
        continue
      }
    } catch {
      continue // the holder released between EEXIST and stat: retry immediately
    }
    const waited = Date.now() - started
    if (waited > timeoutMs) {
      throw graftError(
        'STATE_LOCK_TIMEOUT',
        `could not acquire the ${label} lock within ${timeoutMs}ms; another graft is still writing state`,
      )
    }
    if (!silent && !reported && waited > LOCK_SETTLE_MS) {
      reported = true
      appendGraftAudit({ at: new Date().toISOString(), kind: 'lock-wait', file: label, waitedMs: waited, detail: 'waiting' })
    }
    sleepSync(LOCK_SETTLE_MS)
  }
}

/** Run `fn` while holding the lock for `path`. */
export function withFileLock<T>(
  path: string,
  fn: () => T,
  options: { timeoutMs?: number; staleMs?: number; label?: string; silent?: boolean; leaseMs?: number } = {},
): T {
  const release = acquireFileLock(path, options)
  try {
    return fn()
  } finally {
    release()
  }
}

/**
 * The per-source lock: two processes must never build two targets for one source.
 *
 * The state-file locks protect the LEDGERS; this protects the MIGRATION. Without
 * it, concurrent prepare/commit for the same session can both pass the boundary
 * check (the source has not moved), both write a target, and both retire — which
 * is how one source ends up with two divergent continuations.
 */
export function acquireSourceLock(sessionId: string): () => void {
  const path = join(dirname(retiredStorePath), `.lock-source-${encodeURIComponent(sessionId)}`)
  return acquireFileLock(path, { timeoutMs: 60_000, staleMs: 120_000, leaseMs: 30_000, label: `source:${sessionId}` })
}

// ===========================================================================
// v0.18 (shared defence) — the ledger EPOCH
// ===========================================================================

/**
 * v0.18: the epoch stamped into `.retired.json` and `.transferred.json`.
 *
 * THE DEFECT THIS CLOSES (cross-process state, not cross-plugin cosmetics)
 *
 * `rename` makes each individual write atomic, so a reader never sees half a
 * buffer. It says nothing about whether the RECORD is complete or whether the
 * reader understands the writer. The two plugins share these files and are
 * released separately: a `dsh-memory` from an older build reads a
 * `.transferred.json` written by a newer one, recognises `{ newSessionId }` in
 * what is now a differently-shaped document (or does not recognise it at all),
 * and either harvests from a half-understood record or silently sees an empty
 * ledger. dsh-memory then attributes a skill to a source whose handoff it only
 * partly understood — "generating skills from half a record", which is exactly
 * what the audit named.
 *
 * So the payload gets an ENVELOPE with an integer epoch, and the reader:
 *
 *   - epoch === LEDGER_EPOCH   → trust the payload
 *   - epoch <  LEDGER_EPOCH    → trust it (an older reader/writer shape we still speak)
 *   - epoch >  LEDGER_EPOCH    → REFUSE and wait for a retry (a newer writer)
 *   - envelope without payload → REFUSE (torn)
 *   - no envelope at all       → epoch 1, the legacy bare array/object
 *
 * The last rule is what makes this a migration instead of a flag day: a ledger
 * written by v0.17 is still read correctly, and is upgraded in place on the next
 * write.
 */
export const LEDGER_EPOCH = 2

export interface LedgerEnvelope {
  epoch: number
  at: string
  pid: number
  payload: unknown
}

export type LedgerDefect = 'unreadable' | 'torn' | 'future-epoch'

export interface LedgerRead {
  /** 0 = absent/unreadable, 1 = a bare legacy payload, 2+ = an envelope epoch. */
  epoch: number
  payload: unknown
  /** Present when `payload` must not be used. */
  defect?: LedgerDefect
}

export function readLedger(path: string): LedgerRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { epoch: 0, payload: undefined, defect: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { epoch: 0, payload: undefined, defect: 'unreadable' }
  }
  if (isRecord(parsed) && 'epoch' in parsed) {
    const epoch = Number((parsed as Record<string, unknown>).epoch)
    if (!Number.isFinite(epoch) || epoch <= 0) return { epoch: 0, payload: undefined, defect: 'torn' }
    if (epoch > LEDGER_EPOCH) return { epoch, payload: undefined, defect: 'future-epoch' }
    if (!('payload' in parsed)) return { epoch, payload: undefined, defect: 'torn' }
    const payload = (parsed as Record<string, unknown>).payload
    if (payload === undefined || payload === null) return { epoch, payload: undefined, defect: 'torn' }
    return { epoch, payload }
  }
  return { epoch: 1, payload: parsed }
}

/** The epoch of a ledger file: 0 absent, 1 legacy, 2+ envelope. */
export function readLedgerEpoch(path: string): number {
  return readLedger(path).epoch
}

/**
 * The usable payload of a ledger file, whatever shape wrote it.
 *
 * Exported because the disk-only tools (`scripts/debug-status.mjs`,
 * `scripts/prune-ghosts.mjs`) and the tests read the same files: one unwrap
 * implementation, not five.
 */
export function readLedgerPayload(path: string): unknown {
  const read = readLedger(path)
  return read.defect === undefined || read.defect === 'unreadable' ? read.payload : undefined
}

/** A defect worth telling the operator about, or undefined when the file is fine. */
export function ledgerDefectOf(path: string): LedgerDefect | undefined {
  const read = readLedger(path)
  // An absent file is the normal first-run state, not a defect.
  return read.defect === 'unreadable' ? undefined : read.defect
}

function ledgerArray(path: string): unknown[] {
  const read = readLedger(path)
  if (read.defect !== undefined && read.defect !== 'unreadable') return []
  return Array.isArray(read.payload) ? read.payload : []
}

function ledgerRecord(path: string): Record<string, unknown> {
  const read = readLedger(path)
  if (read.defect !== undefined && read.defect !== 'unreadable') return {}
  return isRecord(read.payload) ? read.payload : {}
}

function writeLedgerAtomic(path: string, payload: unknown): void {
  const envelope: LedgerEnvelope = {
    epoch: LEDGER_EPOCH,
    at: new Date().toISOString(),
    pid: process.pid,
    payload,
  }
  writeJsonAtomic(path, envelope)
}

function readJsonArray(path: string): unknown[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readJsonRecord(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function persistConstraintSections(ctx: PluginContextLike | undefined): void {
  if (ctx === undefined) return
  try {
    mkdirSync(dirname(constraintSectionsPath), { recursive: true })
    withFileLock(constraintSectionsPath, () => {
      const payload = readJsonRecord(constraintSectionsPath) as Record<string, { constraints: string[]; at: number }>
      for (const [id, entry] of targetConstraintSections) {
        const existing = payload[id]
        if (existing === undefined || Number(entry.at ?? 0) >= Number(existing.at ?? 0)) payload[id] = entry
      }
      for (const [id, entry] of Object.entries(payload)) {
        if (isRecord(entry) && Array.isArray(entry.constraints) && !targetConstraintSections.has(id)) {
          targetConstraintSections.set(id, entry as never)
        }
      }
      writeJsonAtomic(constraintSectionsPath, payload)
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] cannot write ${constraintSectionsPath}: ${String((error as any)?.message ?? error)}`,
      )
    } catch {
      // Logging must not change the migration result.
    }
  }
}

function loadConstraintSections(ctx: PluginContextLike): void {
  try {
    const parsed = JSON.parse(readFileSync(constraintSectionsPath, 'utf8'))
    if (!isRecord(parsed)) return
    for (const [id, value] of Object.entries(parsed)) {
      if (!isRecord(value) || !Array.isArray(value.constraints)) continue
      const constraints = value.constraints.filter((item: unknown): item is string => typeof item === 'string')
      if (constraints.length === 0) continue
      targetConstraintSections.set(id, {
        constraints,
        at: typeof value.at === 'number' ? value.at : 0,
      })
    }
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(
          `[dsh-graft-slice] cannot read ${constraintSectionsPath}: ${String((error as any)?.message ?? error)}`,
        )
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

/**
 * v7.0 P0-5: sessions that already received the in-band constraint reminder.
 *
 * One per process. The system-prompt section is the durable channel; this is the
 * one-shot fallback for a host (or a start-up ordering) where the section was
 * not registered. Repeating it every step would make a standing rule read like
 * a nag and cost the recency position on every request.
 */
const constraintsReasserted = new Set<string>()

/**
 * v0.14 D1: sessions that already received the workspace red line through the
 * pre-step `messages` channel. Same discipline as `constraintsReasserted`: the
 * system-prompt section is the durable channel, this is the one-shot in-band
 * fallback for a host where the section could not be registered.
 */
const guardReasserted = new Set<string>()

const pendingConstraints = new Map<string, PendingConstraintPayload>()
const constraintsApplied = new Set<string>()
let pendingConstraintsPath = join(PLUGIN_DIR, '.pending-constraints.json')
let draftsPath = join(PLUGIN_DIR, '.graft-drafts.json')
/** v7.4 P1-2: reviewed-but-not-committed slices live here. */
let preparedStorePath = join(PLUGIN_DIR, '.graft-prepared.json')
/**
 * v7.4: sessions resumed from retirement, and when their auto-graft grace ends.
 *
 * Without this, "undo the migration" is a two-step loop: resume, speak once, get
 * migrated again. The log does not shrink on resume, so the watermark is still
 * over the ratio the moment the user types.
 */
const autoGraftSuppressedUntil = new Map<string, number>()
const AUTO_GRAFT_RESUME_GRACE_MS = 30 * 60_000
let autoGraftSuppressedPath = join(PLUGIN_DIR, '.auto-graft-suppressed.json')
/**
 * v1.1 OBSERVER — the follower pointer.
 *
 * The绑定 is deliberately NOT part of the graft target mark: a target mark describes a
 * tape (when it was sliced, how many events it was seeded with), while this describes a
 * RELATIONSHIP that must survive its tape being retired. Keeping them apart is what makes
 * "the observer follows the main session" a pointer update instead of a second migration.
 */
let observerBindingsPath = join(PLUGIN_DIR, 'observer-bindings.json')
const constraintsInFlight = new Set<string>()

function persistPendingConstraints(ctx: PluginContextLike): void {
  try {
    mkdirSync(dirname(pendingConstraintsPath), { recursive: true })
    const payload = [...pendingConstraints.entries()].map(([targetId, value]) => ({ targetId, ...value }))
    writeJsonAtomic(pendingConstraintsPath, payload)
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${pendingConstraintsPath}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the migration result.
    }
  }
}

/**
 * v7.4b: durable audit of targets left behind by an interrupted migration.
 *
 * WHY A FILE AND NOT A TITLE
 *
 * `markTargetBroken` writes a `[损坏]` title, but only to a LIVE session handle.
 * A target that failed before cold verification is cold: the host exposes no
 * `open(id,'write')` here, so the plugin cannot relabel it. What it CAN do is
 * keep a ledger of "these ids exist and are not a finished handoff", and say so
 * in the next review. Measured on the L1/L2 crash scenarios: after a kill at
 * `TARGET_FLUSHED` the leftover is a complete-looking session with no mark,
 * which is exactly what a user would mistake for the handoff.
 */
export interface LeftoverTarget {
  targetId: string
  sourceSessionId: string
  stage: string
  reason: string
  at: string
}

const leftoverTargets = new Map<string, LeftoverTarget>()
const LEFTOVER_CAP = 20

let leftoversStorePath = join(PLUGIN_DIR, '.graft-leftovers.json')

function persistLeftovers(ctx: PluginContextLike): void {
  try {
    mkdirSync(dirname(leftoversStorePath), { recursive: true })
    writeJsonAtomic(leftoversStorePath, [...leftoverTargets.values()])
  } catch (error) {
    try {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] cannot write ${leftoversStorePath}: ${String((error as any)?.message ?? error)}`,
      )
    } catch {
      // Logging must not change the migration result.
    }
  }
}

export function loadLeftovers(ctx: PluginContextLike): void {
  try {
    const parsed = JSON.parse(readFileSync(leftoversStorePath, 'utf8'))
    if (!Array.isArray(parsed)) return
    for (const item of parsed) {
      if (!isRecord(item)) continue
      if (typeof item.targetId !== 'string' || item.targetId.length === 0) continue
      leftoverTargets.set(item.targetId, {
        targetId: item.targetId,
        sourceSessionId: typeof item.sourceSessionId === 'string' ? item.sourceSessionId : '',
        stage: typeof item.stage === 'string' ? item.stage : 'unknown',
        reason: typeof item.reason === 'string' ? item.reason : '',
        at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
      })
    }
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(
          `[dsh-graft-slice] cannot read ${leftoversStorePath}: ${String((error as any)?.message ?? error)}`,
        )
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

function recordLeftover(
  ctx: PluginContextLike,
  record: { targetId: string; sourceSessionId: string; stage: string; reason: string },
): void {
  leftoverTargets.set(record.targetId, { ...record, at: new Date().toISOString() })
  if (leftoverTargets.size > LEFTOVER_CAP) {
    const ordered = [...leftoverTargets.values()].sort((a, b) => a.at.localeCompare(b.at))
    for (const stale of ordered.slice(0, ordered.length - LEFTOVER_CAP)) leftoverTargets.delete(stale.targetId)
  }
  persistLeftovers(ctx)
}

/** One line for the review: a leftover is NOT a usable handoff. */
export function leftoverWarningLine(): string | undefined {
  if (leftoverTargets.size === 0) return undefined
  const ids = [...leftoverTargets.keys()].slice(0, 5).join(', ')
  const more = leftoverTargets.size > 5 ? ` 等 ${leftoverTargets.size} 个` : ''
  return (
    `注意：有 ${leftoverTargets.size} 个未完成的迁移残留（${ids}${more}），` +
    `它们看起来能续接，但不是这次交接——不要从它们继续，也不要再切同一个源。`
  )
}

function persistDrafts(ctx: PluginContextLike): void {
  try {
    mkdirSync(dirname(draftsPath), { recursive: true })
    writeJsonAtomic(draftsPath, [...draftPayloads.values()])
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${draftsPath}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the migration result.
    }
  }
}

function loadDrafts(ctx: PluginContextLike): void {
  if (draftsLoaded) return
  draftsLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(draftsPath, 'utf8'))
    if (!Array.isArray(parsed)) return
    for (const item of parsed) {
      if (!isRecord(item)) continue
      if (typeof item.targetSessionId !== 'string' || typeof item.text !== 'string') continue
      if (item.text.trim().length === 0) continue
      draftPayloads.set(item.targetSessionId, {
        sourceSessionId: typeof item.sourceSessionId === 'string' ? item.sourceSessionId : '',
        targetSessionId: item.targetSessionId,
        text: item.text,
        capturedAt: typeof item.capturedAt === 'number' ? item.capturedAt : 0,
      })
    }
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${draftsPath}: ${String((error as any)?.message ?? error)}`)
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

/** The last human text in a pre-step message list, or undefined. */
function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'user') continue
    const text = textOfMessage(message)
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * v7.5: the node-plan wake-up.
 *
 * Delivered through the pre-step `messages` channel — the same one the standing
 * constraints use — so it never writes to the log and never consumes a step
 * number. It is a HINT, not a gate: the model may ignore it and keep working.
 *
 * Pacing is deliberately conservative (the user asked for "no nagging"):
 *   - at most once per user turn (a new user message starts a new turn);
 *   - at least PLAN_NUDGE_COOLDOWN_TURNS turns between two nudges;
 *   - only when there is a real signal: the task announces phases but the todo
 *     list has no `阶段 N:` prefixes, or the list has ≥3 open items and is 500+
 *     events stale (the drift this whole block exists to survive).
 */
const PLAN_NUDGE_TEXT =
  '[系统提示] 这是长任务：请先制定或更新你的节点计划（Node Plan）——阶段 → 当前节点 → 卡点。写进 todo_write 时用「阶段 1:」前缀，切片会原样带走。'
/**
 * v7.8: the PRE-PLANNING nudge.
 *
 * A long task that already has 4+ open todos but no phase structure is running
 * before it has a plan. The cost is paid later, at the handoff: the target gets a
 * flat todo list with no notion of which node it is in. This fires before that.
 */
const PLAN_PHASE_TEXT =
  '[系统提示] 请先分析当前任务，制定阶段节点（Phase），并明确每个节点的完成标准，使用 todo_write 保存。'
const PLAN_NUDGE_COOLDOWN_TURNS = 3

interface PlanNudgeState {
  userKey: string
  turns: number
  nudged: boolean
  lastNudgeTurn: number
}

const planNudgeStates = new Map<string, PlanNudgeState>()

/** How many `1.` / `2.` style steps the user's own text carries. */
function countNumberedSteps(text: string): number {
  let count = 0
  for (const line of text.split(/\r?\n/u)) if (/^\s*[0-9]+[.)、]/u.test(line)) count += 1
  return count
}

function takePlanNudge(
  ctx: PluginContextLike,
  agentId: string,
  messages: unknown,
): Array<Record<string, unknown>> {
  const userText = lastUserText(messages)
  if (userText === undefined) return []
  const state = planNudgeStates.get(agentId) ?? { userKey: '', turns: 0, nudged: false, lastNudgeTurn: -100 }
  const key = userText.trim().slice(0, 160)
  if (key !== state.userKey) {
    state.userKey = key
    state.turns += 1
    state.nudged = false
  }
  planNudgeStates.set(agentId, state)
  if (state.nudged) return []
  if (state.turns - state.lastNudgeTurn < PLAN_NUDGE_COOLDOWN_TURNS) return []

  // The live handle keeps the in-memory log: cheaper than readSession (which
  // decodes the whole zstd file), and bounded to the recent window.
  const live = (() => {
    try {
      return (ctx.get('sessions') as any)?.get?.(agentId) as any
    } catch {
      return undefined
    }
  })()
  if (live === undefined || typeof live.snapshotEvents !== 'function') return []
  let events: readonly SessionEventLike[] = []
  try {
    const seq = Number(live.seq)
    events = Number.isFinite(seq) && seq > 3000 ? live.snapshotEvents(seq - 3000) : live.snapshotEvents(0)
  } catch {
    return []
  }
  if (events.length === 0) return []

  const taskState = extractTaskState(events)
  const hasPhasePrefixes = taskState.todos.some((line) => {
    const item = parseTodoLine(line)
    return item !== undefined && phaseKeyOf(item.text) !== undefined
  })
  const phaseIntent = /(阶段|Phase|里程碑|roadmap)/iu.test(userText) || countNumberedSteps(userText) >= 3
  const drift = taskState.openTodos.length >= 3 && (taskState.todoAgeEvents ?? 0) >= 500
  // v7.8: no plan, already deep. Four open items without a phase prefix is the
  // shape of a task improvised step by step.
  const unplannedLongTask = taskState.openTodos.length > 3 && !hasPhasePrefixes
  if (!(phaseIntent && !hasPhasePrefixes) && !drift && !unplannedLongTask) return []

  state.nudged = true
  state.lastNudgeTurn = state.turns
  return [
    {
      id: `graft-plan-${agentId}-${state.turns}`,
      role: 'user',
      content: [{ type: 'text', text: unplannedLongTask ? PLAN_PHASE_TEXT : PLAN_NUDGE_TEXT }],
      source: { kind: GRAFT_REPLAY_SOURCE_KIND },
    },
  ]
}

/**
 * v7.6 (Model-Driven): the 70% "you may hand over yourself" nudge.
 *
 * WHY A NUDGE AND NOT A KILL
 *
 * The system used to cut at 75% regardless of what the model was doing. Inside a
 * long implementation step that is a physical interruption: the sentence being
 * written, and the tool call just issued, are lost. Five points of margin turns
 * an involuntary kill into a decision the model can make at a safe point.
 *
 * DISCIPLINE (same as the plan nudge):
 *   - delivered through the pre-step `messages` channel: no log write, no step
 *     number consumed, therefore no lifecycle risk;
 *   - at most ONE per turn, whatever the step count;
 *   - only in the [modelDrivenGraftAtRatio, autoGraftAtRatio) window — above the
 *     ceiling the hard cutoff runs and never reaches this code.
 */
const MODEL_DRIVEN_NUDGE_LEAD = '[系统提示] 当前上下文水位已达'
const MODEL_DRIVEN_NUDGE_BODY =
  '如果你觉得当前任务需要跨阶段进行，请先调用 graft_prepare 查看交接单；确认无误后，调用 graft_slice_and_inject 进行自我切片。'

/** agentId -> the `turn` whose nudge was already sent. */
const modelDrivenNudgeTurns = new Map<string, number>()

/**
 * v7.9: sessions that were nudged at 70% and kept working anyway.
 *
 * The nudge is advisory, but "advisory" must not mean "ignorable until the
 * process is cut mid-write". After the nudge, the first pre-step proves the model
 * started another step; that step gets ONE hard instruction ("水位告急…切走") and
 * the session is marked. If the model still ignores it, the 75% cutoff runs with
 * the mark, and the target's pending state records that the cut was forced.
 */
const watermarkEscalations = new Map<string, { at: number; ratio: number; sinceSeq: number }>()
const watermarkEscalated = new Set<string>()
const forcedCutMarks = new Map<string, { ratio: number; at: number }>()

const GRAFT_HANDOVER_TOOLS = new Set(['graft_prepare', 'graft_slice_and_inject', 'graft_commit'])

const WATERMARK_URGENT_TEXT =
  '水位告急：70% 预警后你又开始了新的工具调用。请立刻调用 graft_prepare 和 graft_slice_and_inject 切走，不要开始新的工具调用。'

function takeWatermarkEscalation(ctx: PluginContextLike, agentId: string, payload: any): any[] {
  const pending = watermarkEscalations.get(agentId)
  if (pending === undefined || watermarkEscalated.has(agentId)) return []
  watermarkEscalated.add(agentId)
  // The nudge is advisory only if the model is still free to obey. A handover
  // call AFTER the nudge is obedience: do not accuse a session that is already
  // preparing its own slice.
  let obeyed = false
  try {
    const live = ctx.sessions.get(agentId) as any
    if (live !== undefined && typeof live.snapshotEvents === 'function') {
      const events = live.snapshotEvents(pending.sinceSeq) as Array<{ type?: string; seq?: number; data?: any }>
      obeyed = events.some(
        (event) => event?.type === 'tool/call' && GRAFT_HANDOVER_TOOLS.has(String(event.data?.name ?? '')),
      )
    }
  } catch {
    // Reading the log is best-effort; failing it must not suppress the warning.
  }
  if (obeyed) return []
  const turn = Number(payload?.turn)
  appendGraftAudit({
    at: new Date().toISOString(),
    kind: 'nudge-escalation',
    sessionId: agentId,
    detail: `urgent handover instruction after the 70% nudge${Number.isFinite(turn) ? ` (turn ${turn})` : ''}`,
  })
  return [
    {
      id: `graft-watermark-urgent-${agentId}-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: `[系统提示] ${WATERMARK_URGENT_TEXT}` }],
      source: { kind: GRAFT_REPLAY_SOURCE_KIND },
    },
  ]
}

/** Consume (once) the forced-cut mark for a source being sliced. */
function noteForcedCut(sourceSessionId?: string): string | undefined {
  if (sourceSessionId === undefined) return undefined
  const mark = forcedCutMarks.get(sourceSessionId)
  if (mark === undefined) return undefined
  forcedCutMarks.delete(sourceSessionId)
  return `[系统提示] 模型拒绝提前切走（70% 预警后仍继续调用工具），导致在 ${Math.round(mark.ratio * 100)}% 水位被强制中断。`
}

function takeModelDrivenNudge(
  ctx: PluginContextLike,
  settings: Required<GraftConfig>,
  agentId: string,
  payload: any,
  watermark: TokenWatermark | undefined,
  hardCutoffRatio: number | undefined,
  /** v0.18: the derived pair for this session; absent only for a legacy caller. */
  thresholds?: WatermarkThresholds,
): Array<Record<string, unknown>> {
  if (!settings.modelDrivenGraft) return []
  if (watermark === undefined) return []
  const floor = thresholds?.warnAt ?? settings.modelDrivenGraftAtRatio
  // No forced cutoff for THIS session (autoGraft off, or excluded by the
  // allowlist) → the model is the only exit; the nudge lasts until the window
  // is genuinely full.
  const ceiling = hardCutoffRatio ?? 1
  if (!(watermark.ratio >= floor && watermark.ratio < ceiling)) return []
  const turn = Number(payload?.turn)
  const turnKey = Number.isFinite(turn) ? turn : Number(payload?.step) || 0
  if (modelDrivenNudgeTurns.get(agentId) === turnKey) return []
  modelDrivenNudgeTurns.set(agentId, turnKey)
  const pct = Math.min(99, Math.max(1, Math.round(watermark.ratio * 100)))
  // Evidence: pre-step messages are never written to the session log, so the
  // audit line is the only durable proof that the nudge fired and at what ratio.
  appendGraftAudit({
    at: new Date().toISOString(),
    kind: 'model-nudge',
    sessionId: agentId,
    ratio: Number(watermark.ratio.toFixed(4)),
    detail: `turn ${turnKey}`,
  })
  // v7.9: arm the escalation. The next pre-step means the model started another
  // step instead of handing over; that step gets the hard instruction. The seq
  // recorded here lets that check tell obedience (a graft_* call after the nudge)
  // from refusal.
  let sinceSeq = 0
  try {
    const live = ctx.sessions.get(agentId) as any
    if (live !== undefined && typeof live.snapshotEvents === 'function') {
      const events = live.snapshotEvents(0) as Array<{ seq?: number }>
      sinceSeq = Number(events.at(-1)?.seq ?? 0)
    }
  } catch {
    // A missing log is not a reason to withhold the nudge.
  }
  watermarkEscalations.set(agentId, { at: Date.now(), ratio: watermark.ratio, sinceSeq })
  return [
    {
      id: `graft-model-nudge-${agentId}-${turnKey}`,
      role: 'user',
      content: [{ type: 'text', text: `${MODEL_DRIVEN_NUDGE_LEAD} ${pct}%。${MODEL_DRIVEN_NUDGE_BODY}` }],
      source: { kind: GRAFT_REPLAY_SOURCE_KIND },
    },
  ]
}

function loadPendingConstraints(ctx: PluginContextLike): void {
  try {
    const parsed = JSON.parse(readFileSync(pendingConstraintsPath, 'utf8'))
    if (!Array.isArray(parsed)) return
    for (const item of parsed) {
      if (!isRecord(item)) continue
      if (typeof item.targetId !== 'string' || !Array.isArray(item.constraints)) continue
      const constraints = item.constraints.filter((value: unknown): value is string => typeof value === 'string')
      if (constraints.length === 0) continue
      pendingConstraints.set(item.targetId, {
        sourceSessionId: typeof item.sourceSessionId === 'string' ? item.sourceSessionId : '',
        targetSessionId: item.targetId,
        constraints,
        source: 'llm',
        extractedAt: typeof item.extractedAt === 'number' ? item.extractedAt : 0,
      })
    }
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${pendingConstraintsPath}: ${String((error as any)?.message ?? error)}`)
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

/** Persist the retirement set; a failed write is reported but never blocks a migration. */
function persistRetiredStore(ctx: PluginContextLike, remove: readonly string[] = [], strict = false): void {
  try {
    mkdirSync(dirname(retiredStorePath), { recursive: true })
    withFileLock(retiredStorePath, () => {
      // v7.7: read-modify-write under the lock. Serialising the in-memory set and
      // renaming it over the file is what let two sessions erase each other.
      const merged = new Set<string>(
        ledgerArray(retiredStorePath).filter((value): value is string => typeof value === 'string'),
      )
      for (const id of remove) merged.delete(id)
      for (const id of retiredSessions) {
        if (!remove.includes(id)) merged.add(id)
      }
      // Adopt the other writer's retirements; otherwise this process keeps
      // accepting a session the other one already closed.
      for (const id of merged) retiredSessions.add(id)
      writeLedgerAtomic(retiredStorePath, [...merged].sort())
    })
  } catch (error) {
    // v7.8: commit-critical writes must FAIL, not warn. A retirement that is only
    // half-written is worse than no retirement: the source stays usable while the
    // in-memory state says it is gone.
    if (strict) throw error
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${retiredStorePath}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the migration result.
    }
  }
}

/**
 * The first surface node injected into every migrated session.
 *
 * v4 restore requires a protected system head: a later `system/message`
 * appended by the resumed agent is rejected with
 * `system/message requires a protected first surface head` unless the very
 * first surface node is a system message. The v2.1 skeleton did not include
 * one; this minimal prompt supplies the head without copying the source
 * runtime context.
 */
/**
 * v7.0 P2-1: the system prompt must describe the pointers that actually exist.
 *
 * The old second line taught the model to look for
 * `[tool name=xx seq=YY expand_result(...)]` — the v5.2 bracketed form. Since
 * v6.0 the tape writes first-person recollections instead:
 *
 *   （回顾：刚才我已经调用 write 完成了这一步，结果已折叠…读 seq=1234）
 *
 * So the instruction described a shape that appears nowhere in the injected
 * history. A literal-minded model either never recognises a pointer (and then
 * fabricates the missing output) or keeps hunting for a bracket that is not
 * there. The rule survives; only its example is corrected to the real form, and
 * both forms are named so a legacy tape still matches.
 *
 * What is deliberately NOT here: anything that must survive. The host replaces
 * surface node 0 on the target's first live step (v7.0 C1), so constraints and
 * goals live in the goal `user/message`, not in this prompt.
 */
const MIGRATION_SYSTEM_PROMPT = [
  'You are a helpful assistant continuing a migrated coding session. Follow the injected goal and history.',
  // v7.4 P4-1（方案 B）: the tape now writes compact runs, e.g.
  //   - pwsh(seq=364,372,380) · read(seq=398)
  // One line per contiguous run of the same tool; the seqs are in time order,
  // "!" marks the call that came back as an error, "(unavailable here)" means
  // the target does not have that tool mounted. The legacy shapes are still
  // named so an older tape still matches.
  'Tool output is folded into compact pointer lines such as "- pwsh(seq=364,372,380) · read(seq=398)" — one line per contiguous run of the same tool, seqs in time order; a "!" after a seq means that call came back as an error, and "(unavailable here)" means the tool is not mounted in this session. Older tapes may use the long form "（回顾：…）" or the bracketed form [tool name=xx seq=YY]; both mean the same thing. When you need the actual output behind one of those seq numbers to make a decision, call graft_read_result(sourceSessionId, seq). NEVER guess or fabricate a tool result.',
  'Do NOT read the source session log directly via shell or other tools unless graft_read_result fails. Use graft_read_result to fetch pointer contents.',
  'If asked about constraints or progress, you MUST enumerate every single item without skipping or summarizing.',
  "If you encounter a 'SetNamedSecurityInfoW failed' error, the workspace is in restricted mode. Ask the user to run with danger-full-access or use non-destructive read-only tools.",
].join('\n\n')

/**
 * v0.13 GUARD: the workspace boundary, stated as a red line.
 *
 * WHY IT EXISTS (measured live, from the post-mortem of a handoff storm)
 *
 * A migrated session was asked about a file it could not find in its own tree. With
 * no explicit boundary it did what a general-purpose agent does: it widened the
 * search — the profile directory, `AppData`, then the drive roots — turn after turn,
 * and produced confident summaries of a filesystem it had merely listed. Nothing in
 * the injected tape said where "here" ended, so "look harder" was unbounded.
 *
 * The tape already names exactly one working directory, so the cheapest correct
 * answer is to state it, together with what to do INSTEAD of widening: look in the
 * current directory, or ask. The path is interpolated from the session log header
 * (`plan.cwd`), never from model output, so it cannot be talked out of the boundary.
 *
 * It is injected twice on purpose: in the migration system prompt, and in the goal
 * `user/message`. The host replaces surface node 0 with its own rendered prompt on
 * the target's first live step (see `systemMessage`), so a guard that only lives in
 * the system head is dead before the model reads it.
 */
export function workspaceRedline(cwd: string): string {
  const root = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : '(工作目录未记录)'
  return [
    `【红线警告】你的工作目录严格限定为 ${root}。严禁执行任何针对 C 盘、AppData 或全局根目录的搜索（如 rg /）。如果遇到找不到文件的情况，请只在当前目录下用 ls 或 dir 查找。`,
    '同一路径被拒绝或找不到之后，不要换写法重试、不要向外层目录扩散搜索、不要凭目录列表猜测文件内容；请把结论和缺口报告给用户。',
  ].join('\n')
}

/** The migration system node: the base instruction plus the workspace boundary. */
export function migrationSystemPrompt(cwd: string): string {
  return [MIGRATION_SYSTEM_PROMPT, workspaceRedline(cwd)].join('\n\n')
}

function persistTransferredStore(ctx: PluginContextLike, remove: readonly string[] = [], strict = false): void {
  try {
    mkdirSync(dirname(transferredStorePath), { recursive: true })
    withFileLock(transferredStorePath, () => {
      const merged = ledgerRecord(transferredStorePath) as Record<string, { newSessionId: string; at: number; reason: string }>
      for (const id of remove) delete merged[id]
      for (const [id, value] of transferredSessions) {
        if (remove.includes(id)) continue
        const existing = merged[id]
        // Newest wins: a later transfer of the same source is the real one.
        if (existing === undefined || Number(value.at ?? 0) >= Number(existing.at ?? 0)) merged[id] = value
      }
      for (const [id, value] of Object.entries(merged)) {
        if (value === null || typeof value !== 'object' || typeof value.newSessionId !== 'string') continue
        const current = transferredSessions.get(id)
        if (current === undefined || Number(value.at ?? 0) > Number(current.at ?? 0)) transferredSessions.set(id, value)
      }
      writeLedgerAtomic(transferredStorePath, merged)
    })
  } catch (error) {
    if (strict) throw error
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${transferredStorePath}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the migration result.
    }
  }
}

/**
 * v7.8: retirement is a TWO-FILE transaction.
 *
 * The source is retired only when BOTH `.retired.json` and `.transferred.json`
 * say so. Writing one and warning about the other leaves a state where the
 * sidebar says "transferred", the ledger says "retirable", and the next pre-step
 * graft the same source again. So: snapshot both files, write both strictly, and
 * on ANY failure restore both and roll the in-memory sets back before throwing.
 * The `.txn` journal is not cleared here — a caller that throws leaves it for
 * recovery, which is exactly what it is for.
 */
function commitRetirementAtomic(ctx: PluginContextLike, sourceId: string, newId: string): void {
  const lockPath = join(dirname(retiredStorePath), '.retirement')
  const release = acquireFileLock(lockPath, { timeoutMs: 30_000, staleMs: 60_000, label: 'retirement' })
  const snapshot = (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
  const restore = (path: string, text: string | undefined): void => {
    try {
      if (text === undefined) rmSync(path, { force: true })
      else writeFileSync(path, text, 'utf8')
    } catch {
      // A restore that fails is reported by the thrown error below.
    }
  }
  const beforeRetired = snapshot(retiredStorePath)
  const beforeTransferred = snapshot(transferredStorePath)
  try {
    persistRetiredStore(ctx, [], true)
    persistTransferredStore(ctx, [], true)
  } catch (error) {
    restore(retiredStorePath, beforeRetired)
    restore(transferredStorePath, beforeTransferred)
    retiredSessions.delete(sourceId)
    transferredSessions.delete(sourceId)
    throw graftError(
      'RETIREMENT_WRITE_FAILED',
      `retirement rolled back after a state write failed: ${String((error as any)?.message ?? error)}`,
    )
  } finally {
    release()
  }
}

/** Test/diagnostic view of source→target transfers. */
export function getTransferredSessions(): ReadonlyMap<string, { newSessionId: string; at: number; reason: string }> {
  return transferredSessions
}

/** Test/diagnostic view of the in-memory retired set. */
export function getRetiredSessions(): ReadonlySet<string> {
  return retiredSessions
}

/** Clear the in-memory retired set. Intended for tests and explicit operator resets. */
export function resetRetiredSessions(): void {
  retiredSessions.clear()
  transferredSessions.clear()
  autoGraftInFlight.clear()
  autoGraftStates.clear()
  transitionCards.clear()
  graftTargets.clear()
  leftoverTargets.clear()
  // v7.0: these are per-session state too. Leaving them behind makes a reset
  // partial, so a later test (or an operator's explicit reset) sees a session
  // that is still marked as "already overflowed" or "already redirected".
  overflowRetries.clear()
  deferredOverflowTargets.clear()
  pendingConfirms.clear()
  pendingGraftSources.clear()
  constraintsApplied.clear()
  constraintsInFlight.clear()
  targetConstraintSections.clear()
  constraintsReasserted.clear()
  guardReasserted.clear()
  watermarkCache.clear()
  taskBoundaryDeferrals.clear()
  // v7.6: the per-turn nudge mark is session state too; a reset that kept it
  // would silence the 70% warning for the first turn of the next test.
  modelDrivenNudgeTurns.clear()
  // v7.9: the escalation/forced-cut marks are session state; a stale mark would
  // inject "水位告急" into an unrelated session and mislabel a planned handover.
  watermarkEscalations.clear()
  watermarkEscalated.clear()
  forcedCutMarks.clear()
  // v0.21: the ignition queue and the rollback notice ledger are session state too.
  // A reset that kept them would (a) leave a stale "already noticed" mark that
  // suppresses the next rollback's notice, and (b) leave a queued ignition that
  // fires against a session the reset just un-retired.
  pendingIgnitions.clear()
  rollbackNoticed.clear()
  // v0.22: the per-target admission marks are session state too. A reset that kept
  // them would make the next attempt on a reused target id a silent no-op.
  ignitionAdmissions.clear()
  // v7.4: a reset must also drop the resume grace, or a test that resumes a
  // session poisons every later test that expects the watermark to fire.
  autoGraftSuppressedUntil.clear()
  graftTargets.clear()
}

/** Test/diagnostic view of graft-target marks (v7.0 C2). */
export function getGraftTargets(): ReadonlyMap<string, GraftTargetMark> {
  return graftTargets
}

/**
 * v0.21: drop the "this id is a target we created" marks.
 *
 * Exported for tests and for an operator who deliberately repurposes an id. The marks
 * are what protect a fresh target from re-grafting itself, so clearing them is an
 * explicit act rather than something a reset does implicitly — except in the test
 * reset, where a leaked mark makes the next case behave differently from an isolated
 * run and hides a real regression.
 */
export function clearGraftTargetsForTest(): void {
  graftTargets.clear()
}

/**
 * v7.3: undo a retirement — the "regret pill".
 *
 * A migration is a judgement call made at 60% context by a plugin, and sometimes
 * the judgement is wrong: the tape lost the one detail that mattered, or the user
 * simply wants the old window back. Without a way out, a bad migration is
 * permanent and the only recourse is editing JSON on disk by hand.
 *
 * This is the supported way out. It removes the session from the retired set and
 * from the transfer map, forgets the chain-guard mark and the overflow latch, and
 * persists all of it, so the session becomes usable again on the next pre-step.
 *
 * What it deliberately does NOT do: delete the target. The target may already
 * hold work, and silently destroying it to "undo" would be a worse surprise than
 * the one being repaired. The caller decides what to do with it.
 */
/**
 * v7.3.1: the title a session carried BEFORE this plugin marked it.
 *
 * When a graft retires its source, the plugin rewrites the source's sidebar title
 * to `[已转移] → <target>`. That marker is a signpost, and it is only true while
 * the source is actually retired. Undoing the retirement must take the signpost
 * down, or the source keeps claiming it moved — which is worse than a stale
 * label: the source and the target become indistinguishable in the sidebar, and
 * opening the source looks like "the target is just the old session renamed".
 *
 * The original title is recoverable from the log itself: the newest
 * `session/title` that this plugin did NOT write. Its cited seqs are re-validated
 * against the host rule (earlier, `user/message`, human source) before reuse; if
 * they do not hold, the text is restored with empty refs, which is always legal.
 */
const PLUGIN_TITLE_MARKERS = ['[已转移]', '[损坏]', '[已恢复]']

function restorableTitle(
  events: readonly SessionEventLike[],
): { title: string; messageSeqs: number[] } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'session/title') continue
    const title = typeof event.data?.title === 'string' ? event.data.title : ''
    if (title.length === 0) continue
    if (PLUGIN_TITLE_MARKERS.some((marker) => title.startsWith(marker))) continue
    // Re-validate the refs before reusing them: the host rejects a title that
    // cites anything other than an earlier human message.
    const refs = Array.isArray(event.data?.messageSeqs) ? event.data.messageSeqs : []
    const valid = refs.every((value) => {
      const seq = Number(value)
      const cited = events.find((candidate) => Number(candidate.seq) === seq)
      return (
        Number.isSafeInteger(seq) &&
        seq < Number(event.seq) &&
        cited?.type === 'user/message' &&
        cited.data?.source?.kind === 'user'
      )
    })
    return { title, messageSeqs: valid ? refs.map(Number) : [] }
  }
  return undefined
}

export function resumeSession(
  ctx: PluginContextLike | undefined,
  sessionId: string,
): { resumed: boolean; wasRetired: boolean; wasTransferred: boolean; targetSessionId?: string } {
  const wasRetired = retiredSessions.has(sessionId)
  const transfer = transferredSessions.get(sessionId)
  retiredSessions.delete(sessionId)
  transferredSessions.delete(sessionId)
  // Clear every latch that would otherwise reject the session on its next step.
  deferredOverflowTargets.delete(sessionId)
  overflowRetries.delete(sessionId)
  autoGraftStates.delete(sessionId)
  pendingGraftSources.delete(sessionId)
  pendingConfirms.delete(sessionId)
  // v7.4: and give it a grace window, or the next single message grafts it again.
  autoGraftSuppressedUntil.set(sessionId, Date.now() + AUTO_GRAFT_RESUME_GRACE_MS)
  // Forget that it was a target, so the chain guard does not keep protecting it.
  graftTargets.delete(sessionId)

  const target = ctx ?? ctxForStores()
  if (target !== undefined) {
    // v7.7: removals must be EXPLICIT. The merge-on-write path unions the disk
    // file with memory, so a plain write here would resurrect the session the
    // caller just resumed.
    persistRetiredStore(target, [sessionId])
    persistTransferredStore(target, [sessionId])
    persistGraftTargetStore(target, [sessionId])
    persistAutoGraftSuppression(target)
    // v7.3.1: take the `[已转移]` signpost down.
    //
    // This runs even when the session was not currently retired, so the call is
    // idempotent: re-running it on an already-resumed session still repairs a
    // marker left by an earlier version.
    try {
      const live = (target.get?.('sessions') as any)?.get?.(sessionId)
      if (live !== undefined && typeof live.append === 'function') {
        const events = typeof live.snapshotEvents === 'function' ? live.snapshotEvents(0) : []
        const restored = restorableTitle(events)
        const current = [...events].reverse().find((event: any) => event?.type === 'session/title')
        const currentTitle = typeof current?.data?.title === 'string' ? current.data.title : ''
        const needsRestore = PLUGIN_TITLE_MARKERS.some((marker) => currentTitle.startsWith(marker))
        if (needsRestore || restored !== undefined) {
          live.append('session/title', {
            title: restored?.title ?? `[已恢复] ${sessionId}`,
            messageSeqs: restored?.messageSeqs ?? [],
            // Empty refs must pair with 'user'; non-empty refs cite human messages,
            // so 'fallback' is the correct companion and matches the host's own form.
            source: { kind: (restored?.messageSeqs.length ?? 0) > 0 ? 'fallback' : 'user' },
          })
        }
      }
    } catch (error) {
      try {
        target.logger?.warn?.(
          `[dsh-graft-slice] could not restore the title for ${sessionId}: ${String((error as any)?.message ?? error)}`,
        )
      } catch {
        // The title is cosmetic; never let it fail the resume.
      }
    }
    try {
      target.logger?.info?.(
        `[dsh-graft-slice] resumed ${sessionId} (wasRetired=${wasRetired}, wasTransferred=${transfer !== undefined})`,
      )
    } catch {
      // Logging must not change the outcome.
    }
  }
  return {
    resumed: wasRetired || transfer !== undefined,
    wasRetired,
    wasTransferred: transfer !== undefined,
    ...(transfer === undefined ? {} : { targetSessionId: transfer.newSessionId }),
  }
}

/**
 * v7.0 C2: derive a tape budget from the model's real context window.
 *
 * `maxTotalChars: 0` means "no cap", and that is the shipped default. It is
 * safe for a hand-run `graft_slice_and_inject` where a human watches the result,
 * but it is unsafe for `autoGraft`: the tape is copied into a NEW session, and
 * a tape larger than the window means the target is born already over budget —
 * which is exactly the condition that re-triggers a graft and starts the chain.
 *
 * CJK counts ~1 token per char, Latin ~1 per 4, so 0.5 token/char is a
 * deliberately pessimistic conversion: the derived budget errs small.
 */
/**
 * v7.3: derive a character budget from a token window.
 *
 * The previous formula was `Math.floor(contextWindow * ratio / 0.5)`, i.e. it
 * multiplied by two. That was written for a mixed Latin corpus where a token is
 * ~4 characters, and it is exactly wrong for Chinese: 1 CJK character is ~1
 * token, so "half the window in characters" is half the window in TOKENS on a
 * Chinese tape — but the old formula turned a 200k window into a 200k-character
 * budget, which on Chinese content is 200k tokens, i.e. the whole window with no
 * headroom left for the system prompt, tools, or the reply.
 *
 * Measured on this machine: a 2,300-character Chinese sample prices at ~2,300
 * tokens under the same heuristic the plugin uses (1 per CJK char, 1 per 4 Latin
 * chars). So the honest conversion at ratio r is:
 *
 *     chars ≈ tokens * r        (CJK worst case, 1 char = 1 token)
 *
 * Using the CJK worst case for every corpus is deliberate: it errs small, and a
 * budget that errs small is a budget that cannot overflow the target. A Latin
 * tape will simply get a budget it does not need — the tape is built first and
 * the budget only trims, so the unused headroom costs nothing.
 */
export function deriveAutoTapeBudget(contextWindow: number, ratio = 0.5): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0
  const safeRatio = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.5
  return Math.max(0, Math.floor(contextWindow * safeRatio))
}

// ===========================================================================
// v0.18 module 2 — the DYNAMIC watermark
// ===========================================================================

/**
 * v0.18: what one handoff COSTS, measured before deciding WHEN to run one.
 *
 * THE DEFECT THIS REPLACES
 *
 * `modelDrivenGraftAtRatio: 0.70` and `autoGraftAtRatio: 0.75` were constants. They
 * encode one implicit assumption — that a graft costs roughly the same fraction of
 * every window — and that assumption is false at both ends of the range. On a
 * 1M-token window a 6k-token handoff is free and 0.75 is needlessly early; on a
 * 16k-token window the same handoff plus one more turn with a tool result cannot
 * fit in the 25% the constant leaves, so the migration is attempted and fails —
 * `graft_prepare` reads a log, the model call comes back, and the write is refused
 * because the window filled during the handoff itself. "Migrating at 90% of a
 * window that a graft needs 12% of is not late, it is impossible."
 *
 * So the thresholds are DERIVED:
 *
 *     safeCeiling = 1 - (fixed + package + growthReserve) / windowLimit
 *
 * and the fixed ratios survive in exactly two places: as the LATEST point we ever
 * cut (`WATERMARK_HARD_CEILING`, the measured turn-stopping point — a dynamic
 * value is not license to migrate later than the host can survive), and verbatim
 * under `watermarkMode: 'fixed'` for the differential test that proves this
 * module is what moved the line.
 */
export const GRAFT_FIXED_COST_TOKENS = 6000
export const DEFAULT_GROWTH_TOKENS_PER_TURN = 1200
/** The historical `autoGraftAtRatio`: the latest ratio this plugin will ever cut at. */
export const WATERMARK_HARD_CEILING = 0.75
/**
 * The earliest ratio a dynamic calculation may pull the cutoff to.
 *
 * A floor exists because "the estimate does not fit" must not become "migrate at
 * 8%". Below this the honest answer is not an earlier cut but a visible
 * `feasible: false` (the console and the debug panel report it) — the operator
 * either raises `contextWindowTokens`' assumptions or moves to a larger window.
 */
export const WATERMARK_HARD_FLOOR = 0.5
/** Never let the nudge land on top of the cutoff: the model needs a window to act in. */
export const WATERMARK_MIN_GAP = 0.02
/** Default distance between the nudge and the hard cutoff. */
export const WATERMARK_NUDGE_MARGIN = 0.05
/**
 * Characters per token for the handoff package ECHO.
 *
 * The package is mostly paths, seq numbers, JSON and code, so 4 chars/token is
 * the conservative end for Latin text and still generous for CJK prose. The tape
 * itself is not re-priced here: this term is the cost of the source seeing the
 * plan/review round trip, not the cost of the target's seeded history.
 */
const REVIEW_CHARS_PER_TOKEN = 4

export interface GraftCostInput {
  /** Tokens the `graft_prepare` -> `graft_commit` round trip costs the SOURCE. */
  fixedTokens?: number
  /** Characters of plan/review text the source echoes during that round trip. */
  packageChars?: number
  /** Tokens one completed turn adds near the ceiling (the growth prediction). */
  growthPerTurnTokens?: number
  /** How many turns of growth headroom to reserve. */
  reserveTurns?: number
}

export interface GraftCostEstimate {
  windowLimit: number
  fixedTokens: number
  packageChars: number
  packageTokens: number
  growthPerTurnTokens: number
  reserveTurns: number
  growthReserveTokens: number
  totalTokens: number
  /** `totalTokens / windowLimit`; 0 when the window is unknown. */
  ratio: number
}

export function estimateGraftCost(windowLimit: number, input: GraftCostInput = {}): GraftCostEstimate {
  const limit = Number.isFinite(windowLimit) && windowLimit > 0 ? Math.trunc(windowLimit) : 0
  const int = (value: unknown, fallback: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : fallback
  const fixedTokens = int(input.fixedTokens, GRAFT_FIXED_COST_TOKENS)
  const packageChars = int(input.packageChars, deriveAutoTapeBudget(limit, 0.5))
  const growthPerTurnTokens = int(input.growthPerTurnTokens, DEFAULT_GROWTH_TOKENS_PER_TURN)
  const reserveTurns = int(input.reserveTurns, 2)
  const packageTokens = Math.ceil(packageChars / REVIEW_CHARS_PER_TOKEN)
  const growthReserveTokens = growthPerTurnTokens * reserveTurns
  const totalTokens = fixedTokens + packageTokens + growthReserveTokens
  return {
    windowLimit: limit,
    fixedTokens,
    packageChars,
    packageTokens,
    growthPerTurnTokens,
    reserveTurns,
    growthReserveTokens,
    totalTokens,
    ratio: limit > 0 ? totalTokens / limit : 0,
  }
}

export interface WatermarkThresholds {
  mode: 'fixed' | 'dynamic'
  /** Ratio at which the model is nudged to hand over on its own terms. */
  warnAt: number
  /** Ratio at which the system force-grafts regardless. */
  hardAt: number
  windowLimit: number
  estimatedGraftCost: number
  growthReserveTokens: number
  /** `1 - estimatedGraftCost / windowLimit`, before the ceiling/floor clamp. */
  safeCeiling: number
  /** False when even the floor cannot absorb the handoff; reported, never hidden. */
  feasible: boolean
  reason: string
}

function round4(value: number): number {
  return Number(value.toFixed(4))
}

function clampRatio(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return high
  return Math.min(high, Math.max(low, value))
}

export interface WatermarkOptions {
  warnMargin?: number
  hardCeiling?: number
  hardFloor?: number
  minGap?: number
}

/**
 * v0.18: the two ratios, derived from a window and an estimated handoff cost.
 *
 * `estimatedGraftCost` is a token COUNT (not a ratio), because that is the unit
 * the caller can actually measure — see `estimateGraftCost`.
 */
export function calculateSafeWatermark(
  windowLimit: number,
  estimatedGraftCost: number,
  options: WatermarkOptions = {},
): WatermarkThresholds {
  const limit = Number.isFinite(windowLimit) && windowLimit > 0 ? windowLimit : 0
  const cost = Number.isFinite(estimatedGraftCost) && estimatedGraftCost > 0 ? estimatedGraftCost : 0
  const hardCeiling = options.hardCeiling ?? WATERMARK_HARD_CEILING
  const hardFloor = options.hardFloor ?? WATERMARK_HARD_FLOOR
  const minGap = options.minGap ?? WATERMARK_MIN_GAP
  const warnMargin = options.warnMargin ?? WATERMARK_NUDGE_MARGIN
  if (limit === 0) {
    return {
      mode: 'dynamic',
      warnAt: round4(Math.max(0.01, hardCeiling - warnMargin)),
      hardAt: round4(hardCeiling),
      windowLimit: 0,
      estimatedGraftCost: cost,
      growthReserveTokens: 0,
      safeCeiling: round4(hardCeiling),
      feasible: false,
      reason: 'context window unknown; falling back to the hard ceiling',
    }
  }
  const safeCeiling = 1 - cost / limit
  const hardAt = round4(clampRatio(safeCeiling, hardFloor, hardCeiling))
  const warnAt = round4(clampRatio(hardAt - warnMargin, 0.05, hardAt - minGap))
  const feasible = safeCeiling >= hardFloor
  const reason = safeCeiling >= hardCeiling
    ? `cost ${cost} of ${limit} fits below the ceiling (${round4(safeCeiling)}); cutoff stays at ${hardCeiling}`
    : feasible
      ? `cost ${cost} of ${limit} = ${round4(cost / limit)} of the window; cutoff pulled to ${hardAt}`
      : `cost ${cost} of ${limit} = ${round4(cost / limit)} of the window does not fit the floor ${hardFloor}; cutoff held at ${hardAt} and the handoff may still fail`
  return {
    mode: 'dynamic',
    warnAt,
    hardAt,
    windowLimit: limit,
    estimatedGraftCost: cost,
    growthReserveTokens: 0,
    safeCeiling: round4(safeCeiling),
    feasible,
    reason,
  }
}

/**
 * v0.18: the thresholds a session is actually governed by.
 *
 * `watermarkMode: 'fixed'` returns the configured ratios verbatim — the old
 * behaviour, kept so a differential test can show that the DYNAMIC branch is what
 * changed a decision rather than some unrelated edit.
 */
export function effectiveWatermarks(
  settings: Required<GraftConfig>,
  watermark?: { contextWindow?: number; tokens?: number },
): WatermarkThresholds {
  const windowLimit = Number(
    watermark?.contextWindow && watermark.contextWindow > 0
      ? watermark.contextWindow
      : settings.contextWindowTokens,
  )
  if (settings.watermarkMode === 'fixed') {
    return {
      mode: 'fixed',
      warnAt: round4(settings.modelDrivenGraftAtRatio),
      hardAt: round4(settings.autoGraftAtRatio),
      windowLimit: Number.isFinite(windowLimit) && windowLimit > 0 ? windowLimit : 0,
      estimatedGraftCost: 0,
      growthReserveTokens: 0,
      safeCeiling: round4(settings.autoGraftAtRatio),
      feasible: true,
      reason: 'watermarkMode=fixed: using modelDrivenGraftAtRatio / autoGraftAtRatio verbatim',
    }
  }
  const cost = estimateGraftCost(
    Number.isFinite(windowLimit) && windowLimit > 0 ? windowLimit : 0,
    {
      growthPerTurnTokens: settings.growthTokensPerTurn,
      reserveTurns: settings.growthReserveTurns,
    },
  )
  const thresholds = calculateSafeWatermark(cost.windowLimit, cost.totalTokens)
  return { ...thresholds, growthReserveTokens: cost.growthReserveTokens }
}


/**
 * Phase 4: retire the source for the live `agent/pre-step` waterfall.
 * Retirement never writes to the source log; it is an in-memory gate.
 */
export function isRetired(sessionId: string): boolean {
  return retiredSessions.has(sessionId)
}

/**
 * v7.4b: refuse to migrate a source that was already migrated, unless told twice.
 *
 * Retirement exists so one conversation cannot grow two divergent targets. This
 * project's own ledger shows it happening anyway: `session-source-demo` produced
 * three targets (`auto-graft-demo-1`, `auto-graft-demo-2`,
 * `handoff-demo`) because the manual path never consulted the
 * retired/transferred ledger — only the auto path did.
 *
 * `graft_resume_session` stays the sanctioned undo: it clears the flag, and the
 * session becomes slicable again with no extra argument.
 */
export function assertResliceAllowed(sessionId: string, allowReslice: boolean): void {
  if (allowReslice) return
  const transferred = transferredSessions.get(sessionId)
  if (transferred !== undefined) {
    throw graftError(
      'SOURCE_ALREADY_MIGRATED',
      `source ${sessionId} was already migrated to ${transferred.newSessionId}; ` +
        `pass allowReslice: true to slice it again, or call graft_resume_session to undo that migration`,
    )
  }
  if (isRetired(sessionId)) {
    throw graftError(
      'SOURCE_ALREADY_MIGRATED',
      `source ${sessionId} is retired: it already handed off to a target; ` +
        `pass allowReslice: true to slice it again, or call graft_resume_session to undo the migration`,
    )
  }
}

/**
 * Slice a source session and create a durable, cold-resumable handoff session.
 *
 * Red lines enforced here:
 *   - no ctx.sessions.fork()
 *   - skeleton events carry no surfaceOp and no sourceEventSeqs
 *   - user/message and assistant/message carry { surfaceOp: 'append' }
 *   - assistant/message carries stream: [] and no sourceEventSeqs
 *   - no standalone tool/result event
 *   - open turn refused before any write
 */
/**
 * v7.4 P1-2：两阶段切片（prepare / commit），取代单步 confirm。
 *
 * confirm 模式只问"要不要迁移"，用户看不到磁带里装了什么——目标对不对、进度到哪、
 * 约束是否完整、还剩什么没做。选错的代价是一整轮工作被送到一个不能用的窗口里。
 *
 * 所以拆成两步：
 *   graft_prepare  只读、不写盘、不退休：产出一份可审阅的切片摘要 + 内容哈希。
 *   graft_commit   提交前校验三件事：preparedId 未过期、哈希仍是用户看过的那个、
 *                  源会话的最后一个 seq 没有变（否则用户审的是旧切片）。
 *
 * 哈希覆盖 goal / pending-state / 约束 / 每一轮重放文本——也就是用户真正读到的部分。
 */
export interface PreparedSlice {
  preparedId: string
  sourceSessionId: string
  targetSessionId: string
  boundarySeq: number
  sourceLastSeq: number
  digest: string
  createdAt: number
  goal: string
  pendingStateText: string
  constraints: string[]
  turnCount: number
  pointerCount: number
  tapeChars: number
  review: string
  /** v7.4: the reviewed chunk bodies, for tail-vs-history comparison at commit. */
  chunks?: Array<{ kind: string; text: string }>
}

const preparedSlices = new Map<string, PreparedSlice>()
/** How long a reviewed slice stays commit-able. */
const PREPARED_TTL_MS = 30 * 60 * 1000

function sliceDigest(_input: {
  goal: string
  pendingStateText: string
  constraints: readonly string[]
  turns: readonly { turn: number; text: string }[]
}): string {
  // Retained for callers that already hold turns; digestOfPlan covers the tape.
  return createHash('sha256').update(JSON.stringify(_input)).digest('hex')
}

function digestOfPlan(plan: any): string {
  // v7.4 P1-2: hash exactly what the user reviews — the goal plus every injected
  // chunk (`buildInjectionPlan` exposes the tape as chunks, not as turns, so an
  // earlier draft that hashed `plan.turns` hashed an empty array and every plan
  // digested the same way).
  const chunks = Array.isArray(plan?.chunks)
    ? plan.chunks.map((chunk: any) => [String(chunk?.kind ?? ''), String(chunk?.text ?? '')])
    : []
  const constraints: string[] = Array.isArray(plan?.constraints) ? plan.constraints.map(String) : []
  return createHash('sha256')
    .update(JSON.stringify({ goal: String(plan?.goal ?? ''), constraints, chunks }))
    .digest('hex')
}

async function readSourceForPreview(ctx: PluginContextLike, sourceSessionId: string): Promise<any> {
  const raw = await ctx.sessionQuery.readSession(sourceSessionId)
  if (!isRecord(raw) || !Array.isArray(raw.events)) {
    throw graftError('RED_LINE_SOURCE_UNREADABLE', `session "${sourceSessionId}" could not be read`)
  }
  return raw
}

export async function prepareSlice(
  ctx: PluginContextLike,
  config: GraftConfig,
  sourceSessionId: string,
  targetSessionId?: string,
): Promise<PreparedSlice> {
  const settings = normalizeConfig(config)
  const sourceId = asNonEmptyString(sourceSessionId, 'sourceSessionId')
  const raw = await readSourceForPreview(ctx, sourceId)
  if (!hasClosedTurn(raw.events)) {
    throw graftError('NO_CLOSED_TURN', `session "${sourceId}" has no closed turn yet; nothing to review`)
  }
  const plan = buildInjectionPlan(raw, settings)
  const digest = digestOfPlan(plan)
  const sourceLastSeq = Number(raw.events.at(-1)?.seq ?? 0)
  const boundarySeq = Number(plan?.boundary?.boundarySeq ?? 0)
  // v7.4 P1-2: the tape is exposed as `chunks`, so read the review material from
  // there. Reading `plan.turns`/`plan.pendingStateText` (which do not exist on
  // this object) produced an empty review and a digest over nothing.
  const chunks: any[] = Array.isArray(plan?.chunks) ? plan.chunks : []
  const constraints: string[] = Array.isArray(plan?.constraints) ? plan.constraints.map(String) : []
  const pendingStateText = String(
    chunks.find((chunk) => chunk?.kind === 'pending-state')?.text ?? '',
  )
  const goal = String(plan?.goal ?? '')
  const tapeChars = Number(plan?.totalTapeChars ?? 0)
  const turnCount = Number(plan?.recentTurnCount ?? 0)

  const preparedId = `prep-${digest.slice(0, 12)}-${Date.now().toString(36)}`
  const target = typeof targetSessionId === 'string' && targetSessionId.length > 0
    ? targetSessionId
    : autoTargetId(settings)

  const review = [
    `准备就绪：切片来自 ${sourceId}（最后一轮 Turn ${plan?.boundary?.lastTurn ?? '?'}，边界 seq=${boundarySeq}）。`,
    '',
    `目标会话 id：${target}`,
    `重放轮数：${turnCount} 轮 / ${tapeChars} 字符；可回读指针 ${Number(plan?.pointerCount ?? 0)} 处`,
    `注入块：${chunks.map((chunk) => `${String(chunk?.kind ?? '?')}(${String(chunk?.text ?? '').length})`).join(' · ')}`,
    '',
    '【目标】',
    goal.slice(0, 600),
    '',
    '【进度与下一步】',
    pendingStateText.slice(0, 900),
    '',
    constraints.length > 0 ? `【约束 ${constraints.length} 条】\n- ${constraints.slice(0, 10).join('\n- ')}` : '【约束】无',
    '',
    ...(leftoverWarningLine() === undefined ? [] : ['', leftoverWarningLine()]),
    `切片哈希：${digest}`,
    `preparedId：${preparedId}（30 分钟内可用 graft_commit 提交）`,
  ].join('\n')

  const entry: PreparedSlice = {
    preparedId,
    sourceSessionId: sourceId,
    targetSessionId: target,
    boundarySeq,
    sourceLastSeq,
    digest,
    createdAt: Date.now(),
    goal,
    pendingStateText,
    constraints,
    turnCount,
    pointerCount: Number(plan?.pointerCount ?? 0),
    tapeChars,
    review,
    // v7.4: keep the chunk bodies so commit can tell a stale TAIL (expected while
    // the session slices itself) from a changed HISTORY (a real reason to refuse).
    chunks: (Array.isArray(plan?.chunks) ? plan.chunks : []).map((chunk: any) => ({
      kind: String(chunk?.kind ?? ''),
      text: String(chunk?.text ?? ''),
    })),
  }
  preparedSlices.set(preparedId, entry)
  persistPrepared()
  return entry
}

export async function commitPreparedSlice(
  ctx: PluginContextLike,
  config: GraftConfig,
  preparedId: string,
  expectedDigest: string,
): Promise<GraftReport> {
  const settings = normalizeConfig(config)
  loadPrepared()
  const entry = preparedSlices.get(preparedId)
  if (entry === undefined) {
    throw graftError('PREPARED_UNKNOWN', `no prepared slice "${preparedId}"; call graft_prepare first`)
  }
  if (Date.now() - entry.createdAt > PREPARED_TTL_MS) {
    preparedSlices.delete(preparedId)
    persistPrepared([preparedId])
    throw graftError('PREPARED_EXPIRED', `prepared slice "${preparedId}" is older than 30 minutes; prepare again`)
  }
  if (typeof expectedDigest !== 'string' || expectedDigest.length === 0) {
    throw graftError('SLICE_DIGEST_REQUIRED', 'graft_commit needs the digest shown by graft_prepare')
  }
  if (expectedDigest !== entry.digest) {
    throw graftError('SLICE_DIGEST_MISMATCH', `digest does not match the prepared slice (${entry.digest.slice(0, 12)}…)`)
  }
  // Rebuild from the source as it is NOW.
  //
  // v7.4: the hard invariant is the BOUNDARY, not the last seq.
  //
  // Comparing `lastSeq` made the two-phase path unusable for the case it exists
  // for: a session slicing ITSELF. Every tool call during the review appends
  // events, so the last seq always moves and commit always refuses. Observed
  // immediately on the first self-slice attempt: 14578 -> 14583, refused.
  //
  // The boundary is what the tape's structure depends on: it fixes which turns are
  // replayed, which are indexed, and the seq range of the read-back index. Events
  // appended after it belong to the OPEN turn and only affect the carryover and
  // the pending state — the live tail, which is expected to move.
  //
  // So: a moved boundary invalidates the review (the user approved a different
  // slice); a moved tail does not, and is reported instead of silently accepted.
  const raw = await readSourceForPreview(ctx, entry.sourceSessionId)
  const boundaryNow = locateBoundary(raw.events).boundarySeq
  if (boundaryNow !== entry.boundarySeq) {
    throw graftError(
      'SOURCE_DRIFT',
      `the source closed another turn since the review (boundary ${entry.boundarySeq} -> ${boundaryNow}); prepare again`,
    )
  }
  const rebuilt = buildInjectionPlan(raw, settings)
  // The tail may have grown while the user was reading. Name what changed rather
  // than pretending it did not.
  //
  // v7.4: compare BY POSITION, not by kind. `recent-turn` (and `subagent-reports`)
  // legitimately appear several times, so a `Map<kind, text>` keeps only the last
  // one and reports every earlier occurrence as changed — a false mismatch that
  // refused every commit with "differs in recent-turn, recent-turn, recent-turn".
  const tailKinds = new Set(['open-turn-carryover', 'pending-state', 'workspace-files', 'task-status', 'open-work', 'phase-roadmap'])
  const before = Array.isArray(entry.chunks) ? entry.chunks : []
  const after = Array.isArray(rebuilt?.chunks) ? rebuilt.chunks : []
  // v7.4b: compare the STABLE chunks against each other, ignoring tail chunks on
  // BOTH sides.
  //
  // Comparing positionally over the full list looked correct while the tail chunk
  // already existed in both tapes (live case: carryover 277 → 370). It breaks the
  // moment the open turn gains its FIRST chunk — e.g. the model writes one
  // paragraph before committing: `open-turn-carryover` appears at the front and
  // every later position shifts by one, so recent-turn/readback-index are
  // reported as changed and a legitimate tail refresh is refused.
  const isTail = (chunk: { kind?: unknown }): boolean => tailKinds.has(String(chunk.kind ?? '').replace(/#\d+$/u, ''))
  const stableBefore = before.filter((chunk) => !isTail(chunk))
  const stableAfter = after.filter((chunk) => !isTail(chunk))
  const changed: string[] = []
  if (stableBefore.length !== stableAfter.length) {
    const describe = (list: Array<{ kind: string }>): string => list.map((chunk) => chunk.kind).join('|')
    throw graftError(
      'SLICE_DIGEST_MISMATCH',
      `the slice rebuilt from the source has a different structure` +
        ` (reviewed: ${describe(before)}; rebuilt: ${describe(after)}); prepare again`,
    )
  }
  for (let index = 0; index < stableBefore.length; index += 1) {
    const a = stableBefore[index]
    const b = stableAfter[index]
    if (String(a.kind) !== String(b.kind) || String(a.text) !== String(b.text)) {
      changed.push(String(b.kind))
    }
  }
  // The tail is allowed to move, but every move must be named.
  for (const kind of tailKinds) {
    const a = before.find((chunk) => String(chunk.kind).replace(/#\d+$/u, '') === kind)
    const b = after.find((chunk) => String(chunk.kind).replace(/#\d+$/u, '') === kind)
    if (a === undefined && b === undefined) continue
    if (a === undefined || b === undefined || String(a.text) !== String(b.text)) changed.push(kind)
  }
  const stableChanged = changed.filter((kind) => !tailKinds.has(kind.replace(/#\d+$/u, '')))
  if (stableChanged.length > 0) {
    // v7.4: name BOTH structures. "differs in recent-turn, recent-turn, recent-turn"
    // is unactionable — a reader cannot tell a shifted layout from changed text.
    const describe = (list: Array<{ kind: string }>): string => list.map((chunk) => chunk.kind).join('|')
    throw graftError(
      'SLICE_DIGEST_MISMATCH',
      `the slice rebuilt from the source differs from the reviewed one in ${[...new Set(stableChanged)].join(', ')}` +
        ` (reviewed: ${describe(before)}; rebuilt: ${describe(after)}); prepare again`,
    )
  }
  const tailRefreshed = changed.length > 0
  // v7.4b: the review approved a specific tape; a refreshed tail means we wrote
  // something newer. That has to reach the CALLER (the model/UI reading the tool
  // result), not just the host log.
  //
  // Measured on `handoff-demo`: prepare reviewed `open-turn-carryover(277)`,
  // then the model wrote one more paragraph before calling commit, so the tape
  // written to disk carried 370 chars of carryover. The result still said
  // "Committed the reviewed slice to handoff-demo." — a silent difference
  // between what was approved and what was committed.
  const tailRefresh = tailRefreshed
    ? {
        kinds: [...new Set(changed)],
        reviewedChars: before
          .filter((chunk) => tailKinds.has(chunk.kind.replace(/#\d+$/u, '')))
          .reduce((sum, chunk) => sum + String(chunk.text ?? '').length, 0),
        committedChars: after
          .filter((chunk) => tailKinds.has(chunk.kind.replace(/#\d+$/u, '')))
          .reduce((sum, chunk) => sum + String(chunk.text ?? '').length, 0),
      }
    : undefined

  // v7.7: serialise only the WRITE phase. The verification above is read-only;
  // a second process that raced us to this point loses here, visibly, instead of
  // creating a second target.
  const releaseSource = acquireSourceLock(entry.sourceSessionId)
  let report: GraftReport
  try {
    refreshMigrationLedgers()
    assertResliceAllowed(entry.sourceSessionId, false)
    report = await graftSliceAndInjectUnlocked(ctx, config, entry.sourceSessionId, entry.targetSessionId)
    preparedSlices.delete(preparedId)
    persistPrepared([preparedId])
  } finally {
    releaseSource()
  }
  // v7.4: surface that the live tail moved during the review, so the caller knows
  // the committed tape is fresher than what it approved — not silently different.
  if (tailRefreshed) {
    try {
      ctx.logger?.info?.(
        `[dsh-graft-slice] commit refreshed the live tail while the review was open (${[...new Set(changed)].join(', ')})`,
      )
    } catch {
      // Reporting must not change the result.
    }
  }
  return tailRefresh === undefined ? report : { ...report, tailRefreshed: tailRefresh }
}

function loadPrepared(): void {
  if (preparedStorePath.length === 0) return
  try {
    const parsed = JSON.parse(readFileSync(preparedStorePath, 'utf8'))
    if (!isRecord(parsed)) return
    for (const [id, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue
      if (typeof value.digest !== 'string' || typeof value.sourceSessionId !== 'string') continue
      preparedSlices.set(id, {
        preparedId: id,
        sourceSessionId: value.sourceSessionId,
        targetSessionId: typeof value.targetSessionId === 'string' ? value.targetSessionId : '',
        boundarySeq: Number(value.boundarySeq ?? 0),
        sourceLastSeq: Number(value.sourceLastSeq ?? 0),
        digest: value.digest,
        createdAt: Number(value.createdAt ?? 0),
        goal: String(value.goal ?? ''),
        pendingStateText: String(value.pendingStateText ?? ''),
        constraints: Array.isArray(value.constraints) ? value.constraints.map(String) : [],
        turnCount: Number(value.turnCount ?? 0),
        pointerCount: Number(value.pointerCount ?? 0),
        tapeChars: Number(value.tapeChars ?? 0),
        review: String(value.review ?? ''),
        // v7.4: chunks must survive the round-trip. This loader rebuilds the entry
        // field by field, so a field missing from this list is silently dropped —
        // and a dropped `chunks` makes commit compare against an empty `before`,
        // which reports EVERY stable block as changed and refuses a valid commit.
        chunks: Array.isArray(value.chunks)
          ? value.chunks
              .filter((chunk: any) => isRecord(chunk))
              .map((chunk: any) => ({ kind: String(chunk.kind ?? ''), text: String(chunk.text ?? '') }))
          : undefined,
      })
    }
  } catch {
    // A missing or corrupt prepared store only costs the pending review.
  }
}

function persistPrepared(remove: readonly string[] = []): void {
  if (preparedStorePath.length === 0) return
  try {
    const payload: Record<string, PreparedSlice> = {}
    mkdirSync(dirname(preparedStorePath), { recursive: true })
    withFileLock(preparedStorePath, () => {
      // v7.7: union with what the other process prepared. Overwriting here made a
      // concurrent prepare vanish, and the matching commit then reported
      // PREPARED_UNKNOWN / a digest mismatch that looked like source drift.
      const onDisk = readJsonRecord(preparedStorePath) as Record<string, PreparedSlice>
      for (const [id, entry] of Object.entries(onDisk)) {
        if (remove.includes(id)) continue
        if (entry === null || typeof entry !== 'object' || typeof entry.digest !== 'string') continue
        payload[id] = entry
      }
      for (const [id, entry] of preparedSlices) {
        if (remove.includes(id)) continue
        const existing = payload[id]
        if (existing === undefined || Number(entry.createdAt ?? 0) >= Number(existing.createdAt ?? 0)) {
          payload[id] = entry
        }
      }
      for (const id of remove) preparedSlices.delete(id)
      writeJsonAtomic(preparedStorePath, payload)
    })
  } catch {
    // Best effort: a lost prepared slice is recoverable by preparing again.
  }
}

/** v7.4: keep the resume grace across restarts, or a restart re-enables the trap. */
function persistAutoGraftSuppression(ctx: PluginContextLike, remove: readonly string[] = []): void {
  try {
    mkdirSync(dirname(autoGraftSuppressedPath), { recursive: true })
    withFileLock(autoGraftSuppressedPath, () => {
      const merged = readJsonRecord(autoGraftSuppressedPath) as Record<string, number>
      for (const id of remove) {
        delete merged[id]
        autoGraftSuppressedUntil.delete(id)
      }
      for (const [id, until] of autoGraftSuppressedUntil) {
        if (!Number.isFinite(until)) continue
        // The later deadline wins: a resume grant is never shortened by a stale writer.
        if (!Number.isFinite(Number(merged[id])) || Number(until) > Number(merged[id])) merged[id] = until
      }
      for (const [id, until] of Object.entries(merged)) {
        if (Number.isFinite(Number(until))) autoGraftSuppressedUntil.set(id, Number(until))
      }
      writeJsonAtomic(autoGraftSuppressedPath, merged)
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] cannot write ${autoGraftSuppressedPath}: ${String((error as any)?.message ?? error)}`,
      )
    } catch {
      // A failed write only shortens the grace window; it must not fail a resume.
    }
  }
}

function loadAutoGraftSuppression(): void {
  try {
    const parsed = JSON.parse(readFileSync(autoGraftSuppressedPath, 'utf8'))
    if (!isRecord(parsed)) return
    const now = Date.now()
    for (const [id, until] of Object.entries(parsed)) {
      if (typeof until !== 'number' || !Number.isFinite(until)) continue
      if (until > now) autoGraftSuppressedUntil.set(id, until)
    }
  } catch {
    // Missing or corrupt: an empty suppression set is the safe default only if
    // auto-graft is off; with it on, the resume grace is re-armed on each resume.
  }
}

/**
 * v7.7: re-read the migration ledgers from disk.
 *
 * In-memory `retiredSessions` / `transferredSessions` describe THIS process.
 * When a second process retires a source, the first only learns it from the file.
 * Every entry into the migration path therefore refreshes first — under the
 * per-source lock — so "was this already handed off?" is answered by the disk,
 * not by a stale local view.
 */
export function refreshMigrationLedgers(): void {
  for (const id of ledgerArray(retiredStorePath)) {
    if (typeof id === 'string' && id.length > 0) retiredSessions.add(id)
  }
  for (const [id, value] of Object.entries(ledgerRecord(transferredStorePath))) {
    if (isRecord(value) && typeof value.newSessionId === 'string' && !transferredSessions.has(id)) {
      transferredSessions.set(id, value as never)
    }
  }
}

export interface SliceOptions {
  sourceSnapshot?: { session: any; events: any[] }
  /** Runtime knobs read from the full log; a truncated snapshot cannot carry them. */
  runtimeIntent?: RuntimeIntent
  /** Background constraint refinement supplied by apply(); keeps the migration non-blocking. */
  refineConstraints?: (sourceSessionId: string, targetSessionId: string, events: readonly SessionEventLike[]) => void
  /**
   * v7.3.1: the agent that invoked the graft, used as the tool-availability
   * scope when the source has no live agent. Without any scope the lookup falls
   * back to the GLOBAL view, which omits preset-scoped tools and therefore
   * downgrades every pointer in the tape.
   */
  callingAgent?: unknown
  /** v7.7: the caller passed the reslice gate; the wrapper re-checks it under the lock. */
  allowReslice?: boolean
  /**
   * v7.7: run the already-migrated gate inside the lock. Tool callers set this;
   * internal callers (auto-graft, overflow recovery) retire the source themselves
   * just before slicing, so the gate would refuse their own reservation.
   */
  gateReslice?: boolean
}

/**
 * v7.7: the public entry, serialised per source.
 *
 * Two processes that both decide to graft one source must not both succeed: that
 * is exactly how one conversation grows two divergent continuations. The lock
 * plus the disk refresh below make the second caller lose cleanly
 * (`SOURCE_ALREADY_MIGRATED`) instead of writing an orphan target.
 */
export async function graftSliceAndInject(
  ctx: PluginContextLike,
  config: GraftConfig,
  sourceSessionId: string,
  newSessionId: string,
  signal?: AbortSignal,
  options?: SliceOptions,
): Promise<GraftReport> {
  const release = acquireSourceLock(sourceSessionId)
  try {
    refreshMigrationLedgers()
    if (options?.gateReslice === true && options?.allowReslice !== true) assertResliceAllowed(sourceSessionId, false)
    return await graftSliceAndInjectUnlocked(ctx, config, sourceSessionId, newSessionId, signal, options)
  } finally {
    release()
  }
}

async function graftSliceAndInjectUnlocked(
  ctx: PluginContextLike,
  config: GraftConfig,
  sourceSessionId: string,
  newSessionId: string,
  signal?: AbortSignal,
  options?: SliceOptions,
): Promise<GraftReport> {
  const settings = normalizeConfig(config)
  const sourceId = asNonEmptyString(sourceSessionId, 'sourceSessionId')
  const newId = asNonEmptyString(newSessionId, 'newSessionId')
  if (sourceId === newId) {
    throw graftError('SAME_SESSION', 'sourceSessionId and newSessionId must differ')
  }
  if (inFlight.has(newId)) {
    throw graftError('DUPLICATE_IN_FLIGHT', `a graft for newSessionId ${newId} is already in flight`)
  }

  // Preflight: never overwrite a live or persisted identity.
  if (ctx.sessions.get(newId) !== undefined) {
    throw graftError('SESSION_EXISTS', `session ${newId} is already live`)
  }
  const persistence = ctx.get('sessionPersistence')
  if (!isRecord(persistence) || typeof persistence.create !== 'function') {
    throw graftError(
      'PERSISTENCE_REQUIRED',
      'ctx.sessionPersistence is not mounted; a bare ctx.sessions.create session is not durable and cannot be cold-resumed',
    )
  }
  if (typeof persistence.stat === 'function') {
    const existing = await persistence.stat(newId)
    if (existing !== undefined && existing !== null) {
      throw graftError('SESSION_EXISTS', `session ${newId} already exists in durable storage`)
    }
  }

  inFlight.add(newId)
  try {
    // Phase 1 + 2: read, validate, locate boundary, build tape and plan.
    const raw = options?.sourceSnapshot ?? await ctx.sessionQuery.readSession(sourceId)
    if (options?.sourceSnapshot !== undefined && raw.session?.id !== sourceId) {
      throw graftError('SOURCE_MISMATCH', 'sourceSnapshot header does not match sourceSessionId')
    }
    if (!Array.isArray(raw.events)) {
      throw graftError('INVALID_SOURCE', `source session ${sourceId} returned no event array`)
    }
    // v6.1: a subagent session is not a user session.
    //
    // It has no independent goal, it inherits DSH's delegation boilerplate
    // ("send your result to that agent"), and migration deliberately strips
    // lineage — so any such instruction becomes an illegal action for a
    // top-level target. Real E2E produced exactly that: the migrated session
    // called send_message against an agent it does not belong to.
    const sourceHeader = (raw.session ?? {}) as any
    const sourceOrigin = sourceHeader.origin
    const sourceDepth = sourceHeader.delegationDepth
    const isSubagent =
      sourceOrigin === 'subagent' ||
      (typeof sourceDepth === 'number' && sourceDepth > 0) ||
      sourceHeader.parentSession !== undefined ||
      sourceHeader.parentSessionId !== undefined
    if (isSubagent) {
      throw graftError(
        'GRAFT_REFUSED',
        'GRAFT_REFUSED: source is a subagent session (origin=' +
          String(sourceOrigin ?? 'none') +
          ', delegationDepth=' +
          String(sourceDepth ?? 0) +
          '). Subagent sessions have no independent goal and carry delegation-only ' +
          'instructions that are illegal for a top-level target. Migrate the top-level session instead.',
      )
    }

    // v5.2 补丁二：关键路径只用正则，LLM 提取移交后台。
    // 同步等待会随源历史增长而变慢，直接推高「触发到新会话」的延迟。
    const fastConstraints = extractConstraints(raw.events)
    // v7.0 P0-1: probe the tool registry through its REAL contract.
    //
    // The previous version called `ctx.get('tools').list()`. That method does
    // not exist — `ToolService` exposes `get(name, scope?)`, `schemas(scope?)`,
    // `register`, `restrict`, `guard`, `execute`, `presentAs`, `executionMode`.
    // The `typeof tools.list !== 'function'` guard therefore returned `undefined`
    // on every real host, and `availableTools === undefined` means "assume all
    // tools are available" — so F3 downgrade never fired in production. The
    // unit tests passed because the fixture provided a `list()` that the host
    // does not have: a defence that existed only in the harness.
    //
    // `schemas()` is the right call rather than a single `get()` per pointer:
    // it returns the scope-visible set in one pass, which is exactly the
    // question "which tools can the target actually call".
    // v7.3.1 CRITICAL: resolve availability in the RIGHT scope, and never
    // downgrade on an incomplete view.
    //
    // Measured on the live desktop. The previous call was `tools.schemas()` with
    // no scope, and the contract says: "the viewing scope (the agent); omitted =
    // the GLOBAL view". Core tools are registered per-AGENT scope (through the
    // preset), so the global view listed almost none of the tools the source had
    // actually used. Every pointer was therefore marked
    // `（历史记录：使用了当前环境不支持的工具 X…）`, and because the readback
    // index's name extractor did not recognise that shape, the whole index
    // collapsed to:
    //
    //   - seq=360  Turn 5 · tool
    //   - seq=364  Turn 5 · tool
    //
    // A target reading that has no reason to fetch anything, so it re-explored
    // the filesystem with pwsh/read instead of retrieving. The scope bug did not
    // merely mislabel pointers; it destroyed the retrieval path the whole design
    // depends on.
    //
    // Two changes, because either alone is insufficient:
    //   1. ask in the SOURCE agent's scope (the target inherits its preset, so
    //      that scope is the honest proxy for what the target will see);
    //   2. cross-check every name the projection did not list through
    //      `get(name, scope)` before concluding it is absent. A scope-filtered
    //      projection is not evidence of absence; the old code treated it as
    //      such. A downgrade now requires BOTH lookups to fail.
    const availableTools = (() => {
      try {
        const tools = ctx.get('tools') as any
        if (tools === undefined || tools === null) return undefined
        const scope = (() => {
          try {
            const agents = ctx.get('agents') as any
            const source = typeof agents?.get === 'function' ? agents.get(sourceSessionId) : undefined
            if (source !== undefined) return source
          } catch {
            // Fall through to the calling scope.
          }
          return options?.callingAgent
        })()
        const names = new Set<string>()
        // Preferred: the model-facing projection for that scope.
        if (typeof tools.schemas === 'function') {
          const schemas = scope === undefined ? tools.schemas() : tools.schemas(scope)
          for (const entry of Array.isArray(schemas) ? schemas : []) {
            const name = typeof entry === 'string' ? entry : entry?.name
            if (typeof name === 'string' && name.length > 0) names.add(name)
          }
        }
        // Independent check for every tool the source actually called. This is
        // bounded by the number of DISTINCT tool names, not by the number of
        // calls, and it is what stops an incomplete projection from producing a
        // false "this tool does not exist".
        if (typeof tools.get === 'function') {
          const used = new Set<string>()
          for (const event of raw.events) {
            if (event.type !== 'tool/call') continue
            const name = typeof event.data?.name === 'string' ? event.data.name : ''
            if (name.length > 0) used.add(name)
          }
          for (const name of used) {
            if (names.has(name)) continue
            const resolved = scope === undefined ? tools.get(name) : tools.get(name, scope)
            if (resolved !== undefined) names.add(name)
          }
        }
        // An empty set means "we could not see anything", not "nothing exists".
        // Returning it would downgrade every pointer in the tape.
        return names.size > 0 ? names : undefined
      } catch {
        return undefined
      }
    })()
    const plan = buildInjectionPlan(raw, settings, fastConstraints, 'regex-fallback', availableTools)
    const runtimeIntent = options?.runtimeIntent ?? extractRuntimeIntent(raw.events)
    const events = buildInjectionEvents(plan, settings, newId, sourceId, runtimeIntent, raw.events)
    const types = events.map((event) => event.type)
    // v7.3.1 CRITICAL: carry the EFFECTIVE agent preset, not the header's initial
    // one.
    //
    // Measured on the live desktop. The source session's header said
    // `agentPreset: 'standard'`, but at seq 9 it emitted
    //
    //   agent-preset/selected { agentPreset: 'cordis' }
    //
    // and every later `request/header` listed 40-41 tools INCLUDING
    // `plugin_manager`, `plugin_market` and `cordis_inspect_*`. Those tools come
    // from the `cordis` preset. Copying only the header resumed the target under
    // `standard`, so it had 37 tools and was missing exactly the four the task
    // needed ("check the plugin installation"). The target's own reasoning said
    // so: "plugin_manager isn't in my tool list".
    //
    // The header is immutable creation metadata; `agent-preset/selected` is the
    // durable record of a preset change. The LAST such event is the current
    // preset, so that is what must be carried.
    const sourceAgentPreset = (() => {
      let selected: string | undefined
      for (const event of raw.events) {
        if (event?.type !== 'agent-preset/selected') continue
        const value = (event.data as any)?.agentPreset
        if (typeof value === 'string' && value.length > 0) selected = value
      }
      if (selected !== undefined) return selected
      const fromHeader = (raw.session as any)?.agentPreset
      return typeof fromHeader === 'string' && fromHeader.length > 0 ? String(fromHeader) : undefined
    })()

    // Phase 3: prepare a detached zero-inheritance session. This is the same
    // primitive sessions.create() calls internally, but it does not enter the
    // live store; a later agents.resume() can therefore open it for write.
    const prepared = ctx.sessions.prepare(newId, {
      meta: { cwd: plan.cwd, ...(sourceAgentPreset === undefined ? {} : { agentPreset: sourceAgentPreset }) },
    })
    if (ctx.sessions.get(newId) !== undefined) {
      throw graftError('SESSION_LEAKED_LIVE', `session ${newId} unexpectedly entered the live store`)
    }
    if (prepared.header.cwd !== plan.cwd) {
      throw graftError('CWD_MISMATCH', 'prepared session cwd is not the exact source cwd')
    }
    assertTopLevelHeader(prepared.header)

    // Phase 3: BUILD AND VALIDATE IN MEMORY, before touching durable storage.
    //
    // v7.4 P0-1a, the real fix. The previous order was create → append → flush →
    // verify, and the verify step had no cleanup. Cleanup cannot save it either:
    // the host's `SessionPersistence` contract exposes only `create`/`open`/
    // `flush`/`stat`/`list` — there is NO delete, so `discardPartialTarget` can
    // only log "the id stays reserved". An artifact that failed verification
    // would therefore stay on disk forever, listed but unopenable.
    //
    // The only reliable guarantee is that an invalid tape never gets written. The
    // whole tape is materialised in memory (see `materializeTape`), run through
    // the SAME `assertColdLog` the reader uses, and only then handed to the
    // persistence layer.
    // v0.32 P0 (DSH 0.2.2): the prepared session is read-only; appending to it is
    // what raised `cannot append outside a SessionStore`. Materialise the tape
    // from the public event contract and keep the target COLD. Persistence below
    // is still the only writer: `sessionPersistence.create` + `handle.append`.
    const headerCreatedAt = Number(prepared.header.createdAt)
    const snapshot = materializeTape(events, Number.isFinite(headerCreatedAt) ? headerCreatedAt : Date.now())
    if (snapshot.length !== events.length) {
      throw graftError('APPEND_COUNT_MISMATCH', `materialised tape has ${snapshot.length} events, expected ${events.length}`)
    }
    // Pre-write validation. Same function the cold reader uses, same rules: an
    // invalid title, a broken turn/step skeleton, or a stray surface op fails HERE,
    // while the cost of failing is zero.
    assertColdLog(
      { inheritedEventCount: 0, session: prepared.header, events: snapshot },
      plan.cwd,
      types,
      settings.skeletonTurn,
      settings.skeletonStep,
    )

    // v7.4 P0-2: journal the intent BEFORE reserving the id.
    //
    // Write-ahead is what makes recovery possible: a process killed right after
    // `create()` has a record saying which source was migrating and that a target
    // may exist, so the next start can mark it instead of presenting it as usable.
    writeGraftTxn(ctx, {
      sourceSessionId: sourceId,
      targetSessionId: newId,
      state: 'PREPARING',
      stage: 'persistence.create',
      updatedAt: new Date().toISOString(),
    })

    // Phase 3 + 4: only now take write ownership and make it durable.
    const handle = await persistence.create(prepared.header, { inheritedEventCount: 0, ...(signal === undefined ? {} : { signal }) })
    let failed: unknown
    try {
      await handle.append(snapshot)
      // The spec's ctx.sessions.flush() is a live-store barrier; a detached
      // prepared session is rejected by liveEntryFor(). The handle flush is the
      // durability barrier for this artifact and close() releases the writer
      // ownership so a later resume can open it.
      await handle.flush()
      await handle.close()
      writeGraftTxn(ctx, {
        sourceSessionId: sourceId,
        targetSessionId: newId,
        state: 'TARGET_FLUSHED',
        stage: 'persistence.flush',
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      failed = error
      try {
        await handle.close()
      } catch {
        // Preserve the primary failure.
      }
      // v7.0 P0-4: a failed flush must not leave a half-written target behind.
      //
      // `create()` reserves the id immediately, so by the time `append` or
      // `flush` throws, a header — and possibly a partial event log — is already
      // on disk under the target's name. Since `retireSource` runs later, the
      // source stays alive, but the target id is now OCCUPIED by a corrupt
      // artifact. The user sees a session in the sidebar that cannot resume, and
      // a retry with the same id fails with SESSION_EXISTS.
      //
      // The host exposes no `delete` on SessionPersistence, so cleanup is
      // best-effort and layered:
      //   1. `discardPrepared` (if the store offers it) drops the reservation.
      //   2. `persistence.remove`/`delete` (if a backend offers one) removes the
      //      artifact.
      //   3. The prepared session is detached, so dropping the in-memory handle
      //      is enough to keep it out of the live store.
      // Whatever refuses to go is reported, because a silent failure here is how
      // a phantom session survives a migration that claimed to fail.
      // v7.2: mark the wreckage BEFORE trying to remove it.
      //
      // Cleanup is best-effort (the host exposes no delete on SessionPersistence),
      // so a failed target can survive. When it does, it must not look resumable:
      // a `[损坏]` title and a breadcrumb are what stop a user from opening it and
      // concluding the migration "half worked".
      //
      // Order matters — mark first, then discard. If the process dies between the
      // two, the mark is what remains, which is the safe direction.
      //
      // v7.4 P0-2: the breadcrumb is now a real transaction record (see
      // `.txn/`), so recovery after a restart is possible instead of merely
      // informative.
      markTargetBroken(ctx, newId, String((error as any)?.message ?? error), {
        sourceSessionId: sourceId,
        stage: 'persistence.flush',
      })
      await discardPartialTarget(ctx, newId)
      throw error
    } finally {
      if (failed === undefined) {
        // close() already ran on the success path; this is intentionally empty.
      }
    }

    // Phase 4: cold-read verification of what was ACTUALLY persisted.
    //
    // The tape was already validated in memory before the write, so a failure here
    // means the persistence round-trip corrupted it — rare, and not something the
    // plugin can undo: the host exposes no delete. What it CAN do is make sure the
    // wreckage cannot be mistaken for a usable session, and keep the source alive.
    let verified = false
    if (settings.verifyReadBack) {
      try {
        const cold = await ctx.sessionQuery.readSession(newId)
        assertColdLog(cold, plan.cwd, types, settings.skeletonTurn, settings.skeletonStep)
        verified = true
        writeGraftTxn(ctx, {
          sourceSessionId: sourceId,
          targetSessionId: newId,
          state: 'COLD_VERIFIED',
          stage: 'cold-read',
          updatedAt: new Date().toISOString(),
        })
      } catch (error) {
        plan.warnings.push(`cold verification failed; target marked broken: ${String((error as any)?.message ?? error)}`)
        markTargetBroken(ctx, newId, `冷读校验失败：${String((error as any)?.message ?? error)}`, {
          sourceSessionId: sourceId,
          stage: 'cold-read',
        })
        await discardPartialTarget(ctx, newId)
        throw error
      }
    }

    // Mount the detached artifact into the source workspace group so the
    // sidebar does not show it as "未分组". The registry is optional in
    // headless/base-only profiles; a failure is a warning, not a lost handoff.
    let workspaceAttached = false
    let workspaceId: string | null = null
    const workspaceRegistry = ctx.get('workspaceRegistry')
    if (isRecord(workspaceRegistry) && typeof workspaceRegistry.resolveByPath === 'function') {
      try {
        let workspace = await workspaceRegistry.resolveByPath(plan.cwd)
        if (workspace === undefined && typeof workspaceRegistry.create === 'function') {
          workspace = await workspaceRegistry.create(plan.cwd)
        }
        if (isRecord(workspace) && typeof workspace.attachSession === 'function') {
          await workspace.attachSession(newId)
          workspaceAttached = true
          workspaceId = typeof workspace.id === 'string' ? workspace.id : null
        }
      } catch (error) {
        plan.warnings.push(`workspace attach failed: ${String((error as any)?.message ?? error)}`)
      }
    }

    // v7.3.1: announce the new session to the CLIENT.
    //
    // The Web UI learns about sessions exclusively from `api-session/added`,
    // which `dsh-api-session-controller` emits on `session/created` — i.e. only
    // for sessions PUBLISHED into the live store:
    //
    //   ctx.on("session/created", (session) => {
    //     ctx.emit("api-session/added", this.listState.summaryFor(session));
    //   });
    //
    // This plugin deliberately creates targets through `sessionPersistence`
    // instead, because publishing them would BREAK resumability: resume does
    // `persistence.open(id, "write")` and then the agent factory's
    // `sessions.enter(session)`, which throws when the id is already in the
    // store. A published target would be visible and unopenable — the exact
    // failure this plugin has already been through once.
    //
    // So the target stays cold and we emit the notification ourselves.
    // `dsh-api-remotes` forwards this event to peers, keyed by
    // `resources.session = (summary) => summary.sessionId`, and the client
    // applies it through `handleSessionAdded` -> `mergeSummary`.
    //
    // The payload is field-for-field what the host's own `summarizeCold(record)`
    // produces for a persisted session, with `projections` omitted: the client
    // only calls `applyListBlock` when that field is present, and a hand-built
    // projection frame is not worth risking the user's sidebar for. The title
    // gap is covered by the source session's `[已转移] → <id>` marker, which
    // names this session.
    //
    // Best-effort: an absent `emit` (older host) or a refused emit must never
    // turn a completed handoff into a failure.
    try {
      const emit = (ctx as any).emit
      if (typeof emit === 'function') {
        const createdAt = Date.now()
        emit('api-session/added', {
          sessionId: newId,
          // summarizeCold: updatedAt = max(createdAt, metadata.lastPromptAt ?? 0)
          updatedAt: createdAt,
          agentAvailable: false,
          formatStatus: 'current',
          running: false,
          blank: false,
          ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
        })
      }
    } catch (error) {
      plan.warnings.push(`client announcement failed: ${String((error as any)?.message ?? error)}`)
    }

    const retired = settings.retireSource
    // v7.0 C2: remember that this id is OUR target, so the auto path cannot
    // graft it again merely because its seeded tape already sits above the
    // ratio. Marked before retirement so a crash mid-way still leaves the mark.
    markGraftTarget(newId, sourceId, Array.isArray(snapshot) ? snapshot.length : undefined, plan.goal)
    // v7.0 P0-5: register the durable, every-request constraint section for
    // this target. The goal message carries the same list; the section is the
    // copy that compaction cannot reach.
    if (plan.constraints.length > 0) {
      targetConstraintSections.set(newId, { constraints: [...plan.constraints], at: Date.now() })
      persistConstraintSections(ctxForStores())
    }
    if (retired) {
      retiredSessions.add(sourceId)
      // v1.0.2: the goal in force travels WITH the retirement record, so the audit trail
      // of an evolved goal survives even if the target's own mark is later cleaned up.
      const createdTarget = graftTargets.get(newId)
      transferredSessions.set(sourceId, {
        newSessionId: newId,
        at: Date.now(),
        reason: `已转移至新会话 ${newId}`,
        ...(createdTarget?.currentGoal === undefined ? {} : { currentGoal: createdTarget.currentGoal }),
        ...(createdTarget?.goalEvolution === undefined ? {} : { goalEvolution: createdTarget.goalEvolution }),
      } as any)
      // v7.8: both ledgers or neither. A partial retirement is a second target
      // waiting to happen.
      commitRetirementAtomic(ctx, sourceId, newId)
      // v7.4 P0-2: the source is now retired AND durable, so the migration is
      // committed and the journal entry has served its purpose.
      writeGraftTxn(ctx, {
        sourceSessionId: sourceId,
        targetSessionId: newId,
        state: 'COMMITTED',
        stage: 'retire',
        updatedAt: new Date().toISOString(),
      })
      clearGraftTxn(sourceId)
      // Best-effort in-session redirect notice. DSH exposes no cross-session
      // focus API here; a title event is visible in the sidebar and survives
      // a reload, while pre-step blocks further input.
      try {
        const live = ctx.sessions.get(sourceId) as any
        if (live !== undefined && typeof live.append === 'function') {
          live.append('session/title', {
            title: `[已转移] → ${newId}`,
            messageSeqs: [],
            source: { kind: 'user' },
          })
        }
      } catch (error) {
        plan.warnings.push(`old-session redirect title failed: ${String((error as any)?.message ?? error)}`)
      }
    }
    // The migration reached its end without retiring (retireSource: false). The
    // journal entry is still finished, so a later start must not "recover" it.
    clearGraftTxn(sourceId)

    /**
     * v1.1 OBSERVER — FOLLOW THE POINTER, inside this transfer's `source:main` lock.
     *
     * The observer does NOT get a tape and is NOT retired: only the binding moves. So
     * there is no second boundary to compute, no second retirement to commit and nothing
     * for ignition to wait on — which is exactly why this cannot deadlock against the
     * retirement transaction that just committed. A failure here is reported, never fatal:
     * a stale pointer is repairable, a blocked main session is not.
     */
    /**
     * v1.2 DECOUPLED: dsh-observer owns the follower pointer.
     *
     * This plugin only REPORTS that a transfer committed. It must not know whether an
     * observer exists, where it lives, or how it follows — a listener-less profile is the
     * normal case, and an absent listener is not an error.
     */
    try {
      ;(ctx as any).emit?.('graft/session-transferred', {
        sourceSessionId: sourceId,
        newSessionId: newId,
        at: Date.now(),
      })
    } catch (error) {
      plan.warnings.push(`transfer event failed: ${String((error as any)?.message ?? error)}`)
    }

    try {
      ctx.logger?.info?.(
        `[dsh-graft-slice] grafted ${sourceId} -> ${newId}: ${events.length} events, boundary seq ${plan.boundary.boundarySeq}`,
      )
    } catch {
      // Logging must never change the migration result.
    }

    const firstSeq = 0
    const lastSeq = events.length - 1
    // v0.19 PHYSICAL IGNITION: the artifact is durable (handle.flush() above) and
    // the retirement transaction has committed, so this is the exact moment the
    // target becomes a session the host can resume. Ask the host to start it.
    //
    // v0.21 P0: an ignition that fails here is NOT the end of the story. The first
    // attempt failing is normal (a channel that is not mounted yet, a cold session
    // the host has not opened); what must never happen is the LAST attempt failing
    // while the source stays retired. That is the double-blind state, and it is
    // handled below and in `resumePendingIgnitions`.
    let ignition = await attemptIgnition(ctx, settings, sourceId, newId)
    // The queue records the attempt; if this single call already exhausted the
    // budget (e.g. the timeout path is instant), roll back now rather than leaving
    // the user blocked until the next activation.
    if (!ignition.ok && ignitionExhausted(pendingIgnitions.get(newId))) {
      const rollback = await rollbackFailedIgnition(
        ctx,
        sourceId,
        newId,
        ignition.reason ?? 'ignition failed',
      )
      pendingIgnitions.delete(newId)
      persistPendingIgnitions(ctx)
      ignition = { ...ignition, rollback }
    }
    if (!ignition.ok) {
      try {
        ctx.logger?.warn?.(
          `[dsh-graft-slice] ignition ${ignition.attempted ? 'failed' : 'skipped'} for ${newId}: ` +
            `${ignition.reason ?? 'unknown'}; ` +
            (ignition.rollback?.sourceRestored === true
              ? `source ${sourceId} was RESTORED (not left retired)`
              : 'the target is durable and queued for a retry'),
        )
      } catch {
        // Logging must not change the migration result.
      }
    }
    // v5.2 补丁二：迁移已经落盘并可用，LLM 精修在后台进行。
    // 这里刻意不 await：它不该影响「用户看到新会话」的时间。
    options?.refineConstraints?.(sourceId, newId, raw.events)
    return {
      ok: true,
      sourceSessionId: sourceId,
      newSessionId: newId,
      cwd: plan.cwd,
      goal: plan.goal,
      goalSource: plan.goalSource,
      boundarySeq: plan.boundary.boundarySeq,
      sourceEventCount: raw.events.length,
      turns: plan.recentTurnCount + plan.olderTurnCount,
      recentTurnCount: plan.recentTurnCount,
      recentInjectedCount: plan.recentInjectedCount,
      olderTurnCount: plan.olderTurnCount,
      adaptiveDepth: plan.adaptiveDepth,
      injected: {
        system: 1,
        goal: 1,
        title: 1,
        oldSummary: plan.chunks.filter((chunk) => chunk.kind === 'old-summary').length,
        taskStatus: plan.chunks.filter((chunk) => chunk.kind === 'task-status').length,
        phaseRoadmap: plan.chunks.filter((chunk) => chunk.kind === 'phase-roadmap').length,
        subagentReports: plan.chunks.filter((chunk) => chunk.kind === 'subagent-reports').length,
        tape: plan.chunks.filter((chunk) => chunk.kind === 'recent-turn').length,
        pending: plan.chunks.filter((chunk) => chunk.kind === 'pending-state').length,
        // v7.0: the remaining chunk kinds, so the report's parts always sum to
        // its total. A report whose arithmetic silently omits a block is how a
        // reader concludes a block was not injected.
        workspaceFiles: plan.chunks.filter((chunk) => chunk.kind === 'workspace-files').length,
        openTurn: plan.chunks.filter((chunk) => chunk.kind === 'open-turn-carryover').length,
        omittedTurns: plan.chunks.filter((chunk) => chunk.kind === 'omitted-turns').length,
        readback: plan.chunks.filter((chunk) => chunk.kind === 'readback-index').length,
        total: 3 + plan.chunks.length,
      },
      pointers: {
        total: plan.pointerCount,
        recent: plan.pointerCount - plan.olderPointerCount,
        older: plan.olderPointerCount,
        olderToolNames: plan.olderToolNames,
      },
      constraints: plan.constraints,
      constraintSource: plan.constraintSource,
      // v0.19: whether the new session was actually STARTED, and through which
      // channel. A handoff that produced a session nobody wakes is a fact the
      // caller must see, not a detail to discover by staring at the sidebar.
      ignition,
      // v0.14 D2: the chain depth of the created target, so a caller can see it
      // without reading the target's log first.
      generation: plan.generation,
      taskStatus: plan.taskStatus,
      subagentReports: plan.subagentReports,
      workspace: {
        attached: workspaceAttached,
        id: workspaceId,
      },
      eventSeqRange: { first: firstSeq, last: lastSeq },
      sourceTemplate: sourceForReport(plan.sourceTemplate),
      skeleton: { turn: settings.skeletonTurn, step: settings.skeletonStep, closed: true },
      durability: {
        attached: true,
        appended: events.length,
        barrier: 'sessionPersistence.handle.flush',
        verified,
      },
      retired: { source: retired },
      warnings: plan.warnings,
    }
  } finally {
    inFlight.delete(newId)
  }
}

/** Extract one tool/result payload from a source log, as specified in v2.1. */
export function extractToolResultText(event: SessionEventLike): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const message = event.data?.message
  const blocks = Array.isArray(message?.content) ? message.content : []
  const toolBlocks = blocks.filter((block: any) => block?.type === 'tool-result')
  const target = toolBlocks.length > 0 ? toolBlocks : blocks
  const text = target
    .flatMap((block: any) => (block?.type === 'tool-result' && Array.isArray(block.content) ? block.content : [block]))
    .map((block: any) => block?.text)
    .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
  return text.length > 0 ? text : ''
}

/**
 * v7.3: search a source session's log by substring or regular expression.
 *
 * Why this is the missing half of the "read it back by seq" design:
 *
 * `graft_read_result` answers "what is at seq N". Nothing answered "which seq
 * mentions AssertionError". So the read-back philosophy only worked for a reader
 * that already knew the number — which, after a migration, it never does. The
 * injected index names the *recent* pointers (capped at 24) and the oldest
 * constraint block; everything else was reachable in principle and unreachable in
 * practice. A target that needed an older error had to guess seq numbers or
 * re-run the command.
 *
 * Scope is deliberately the two payload-bearing event types: `assistant/message`
 * (reasoning and answers) and `tool/result` (command output, diffs, test logs).
 * Those are what a reader searches for. Adding user messages would mostly return
 * the goal it already has; adding tool calls would return commands it can see in
 * the pointers.
 */
export interface GraftSearchHit {
  seq: number
  /** v7.4 P1-1: `user/message` joined the searchable set. */
  type: 'assistant/message' | 'tool/result' | 'user/message'
  /** Match position in characters, for a reader who wants to look around it. */
  offset: number
  /** Up to 50 characters either side of the match, whitespace-collapsed. */
  preview: string
  /** Total characters in the matched event, so the reader knows what it is buying. */
  totalChars: number
  /** How many times the query occurs in this event (v7.3). */
  matchCount: number
  /**
   * v7.4 P1-1: the author of a `user/message`, always `'user'` here.
   *
   * Present only for user messages, because only they have this ambiguity: the
   * same event type carries this plugin's goal and the host's runtime context.
   * The gate above excludes everything that is not a human, so a hit with this
   * field set is genuinely something the user typed.
   */
  sourceKind?: string
}

export interface GraftSearchResult {
  found: boolean
  query: string
  /** True when the query was parsed as a regular expression. */
  regex: boolean
  /** Total individual matches across the log, before `limit` was applied. */
  totalMatches: number
  /** v7.3: how many distinct EVENTS matched. This is what `limit` caps. */
  totalHits: number
  /** True when `totalHits` exceeded the returned hits. */
  truncated: boolean
  hits: GraftSearchHit[]
  /** Set when the query was meant as a regex but could not be compiled. */
  error?: string
}

const SEARCH_PREVIEW_RADIUS = 50

/** Collapse whitespace so a preview stays one readable line. */
function previewAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SEARCH_PREVIEW_RADIUS)
  const end = Math.min(text.length, index + length + SEARCH_PREVIEW_RADIUS)
  const body = text.slice(start, end).replace(/\s+/gu, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

export async function graftSearchHistory(
  ctx: PluginContextLike,
  sourceSessionId: string,
  query: string,
  limit = 10,
  useRegex = false,
): Promise<GraftSearchResult> {
  const sourceId = asNonEmptyString(sourceSessionId, 'sourceSessionId')
  const needle = asNonEmptyString(query, 'query')
  const cap = Math.max(1, Math.min(100, asSafeInteger(limit, 'limit')))

  let matcher: RegExp
  if (useRegex) {
    try {
      matcher = new RegExp(needle, 'giu')
    } catch (error) {
      // A malformed pattern is a caller mistake, not a crash: report it so the
      // model can retry with a literal search instead of losing the session.
      return {
        found: false,
        query: needle,
        regex: true,
        totalMatches: 0,
        truncated: false,
        hits: [],
        error: `invalid regular expression: ${String((error as any)?.message ?? error)}`,
      }
    }
  } else {
    // Literal search: escape every metacharacter so "a.b(" is a substring, not a
    // pattern. Case-insensitive because log text casing varies by tool.
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    matcher = new RegExp(escaped, 'giu')
  }

  const raw = await ctx.sessionQuery.readSession(sourceId)
  const hits: GraftSearchHit[] = []
  let totalMatches = 0
  let totalHits = 0

  for (const event of raw.events) {
    const type = event.type
    if (type !== 'assistant/message' && type !== 'tool/result' && type !== 'user/message') continue
    // v7.4 P1-1: user/message is searchable ONLY when a human wrote it.
    //
    // The user's own words are the one thing a resumed target cannot reconstruct
    // from anything else: "绝对不能使用 import re" lives in a `user/message`, and
    // before this change `graft_search_history('import re')` returned zero hits.
    // The goal summary may have truncated exactly the clause that mattered.
    //
    // But a `user/message` is not automatically a human's: this plugin writes the
    // goal into one (`plugin:graft-replay`), and the host injects runtime context,
    // time context, skill catalogs and job reports into the same event type. Letting
    // those through would make the search answer "the user said X" when the user
    // said nothing of the kind — the exact class of mistake v7.0 P5 fixed for
    // replays. Only `kind === 'user'` is a human.
    let sourceKind: string | undefined
    if (type === 'user/message') {
      sourceKind = typeof event.data?.source?.kind === 'string' ? event.data.source.kind : undefined
      if (sourceKind !== 'user') continue
    }
    // Each event type carries its text in a different place:
    //   tool/result   → data.message (a tool payload; several possible shapes)
    //   assistant     → data.message
    //   user/message  → data ITSELF is the message (no `.message` wrapper)
    // Getting this wrong returns empty text, which reads as "no match" rather than
    // as a bug — the first version of this change did exactly that.
    const text =
      type === 'tool/result'
        ? extractToolResultText(event) ?? ''
        : type === 'user/message'
          ? textOfMessage(event.data)
          : textOfMessage(event.data?.message)
    if (text.length === 0) continue
    matcher.lastIndex = 0
    let match: RegExpExecArray | null
    // v7.3: ONE hit per event, not one per match.
    //
    // Measured on the live host: a query of "jet hub" returned limit=5 results
    // that were ALL `seq=152`, because that one event (a grep dump) contained the
    // phrase 24 times. Every result slot went to the same event, so the reader
    // learned nothing about the other 23 matching events — the index stopped
    // doing the one thing it exists for, which is telling you WHERE to look.
    //
    // `limit` now caps distinct events. `matchCount` keeps the density visible, so
    // "this event mentions it 24 times" is still information rather than a reason
    // to repeat the same row.
    let matchCount = 0
    let first: { index: number; length: number } | undefined
    while ((match = matcher.exec(text)) !== null) {
      totalMatches += 1
      matchCount += 1
      if (first === undefined) first = { index: match.index, length: Math.max(1, match[0].length) }
      // A zero-length match would spin forever on patterns like "(?:)".
      if (match[0].length === 0) matcher.lastIndex += 1
      if (matcher.lastIndex > text.length) break
    }
    if (matchCount === 0 || first === undefined) continue
    totalHits += 1
    if (hits.length < cap) {
      hits.push({
        seq: Number(event.seq),
        type,
        offset: first.index,
        preview: previewAround(text, first.index, first.length),
        totalChars: text.length,
        matchCount,
        // Only present for user/message, where it is always 'user' by the gate
        // above. Its absence on the other types is meaningful: those were not
        // authored by a human.
        ...(sourceKind === undefined ? {} : { sourceKind }),
      })
    }
  }

  return {
    found: hits.length > 0,
    query: needle,
    regex: useRegex,
    totalMatches,
    totalHits,
    // Truncation is about EVENTS withheld, since that is what limit caps now.
    truncated: totalHits > hits.length,
    hits,
  }
}

/**
 * Fallback reader for a tool pointer. It bypasses the native tool-layer
 * authorization by reading the source log directly; it does not write.
 */
export async function graftReadResult(
  ctx: PluginContextLike,
  sourceSessionId: string,
  seq: number,
  maxChars = 100000,
  lineRange?: { start: number; end: number },
): Promise<GraftReadResult> {
  const sourceId = asNonEmptyString(sourceSessionId, 'sourceSessionId')
  const targetSeq = asSafeInteger(seq, 'seq')
  const raw = await ctx.sessionQuery.readSession(sourceId)
  // A pointer may name a tool/result (tool pointer), an assistant/message
  // (codeblock pointer), or — v7.4 P1-1 — a user/message, which is where the
  // user's own constraints live.
  const event = raw.events.find(
    (candidate) =>
      Number(candidate.seq) === targetSeq &&
      (candidate.type === 'tool/result' ||
        candidate.type === 'assistant/message' ||
        candidate.type === 'user/message'),
  )
  if (event === undefined) {
    return { found: false, seq: targetSeq, text: null, truncated: false, totalChars: 0 }
  }
  // v7.4 P1-1: label the author of a user/message.
  //
  // Reading is allowed for every author — the log is a fact and hiding it would be
  // dishonest. What must never happen is a reader mistaking this plugin's goal, or
  // the host's runtime context, for something the user said. So the payload carries
  // the source kind and the renderer states it; the text itself stays verbatim.
  const sourceKind =
    event.type === 'user/message' && typeof event.data?.source?.kind === 'string'
      ? event.data.source.kind
      : undefined
  let text =
    event.type === 'tool/result'
      ? extractToolResultText(event) ?? ''
      : event.type === 'user/message'
        ? textOfMessage(event.data)
        : textOfMessage(event.data?.message)
  if (lineRange !== undefined) {
    const start = asSafeInteger(lineRange.start, 'lineRange.start')
    const end = asSafeInteger(lineRange.end, 'lineRange.end')
    const total = lineCount(text)
    return {
      found: true,
      seq: targetSeq,
      text: sliceLines(text, start, end),
      truncated: false,
      totalChars: text.length,
      lineRange: { start, end, totalLines: total },
      ...(sourceKind === undefined ? {} : { sourceKind }),
    }
  }
  const limit = asFiniteInteger(maxChars, 100000, 'maxChars')
  if (limit > 0 && text.length > limit) {
    return {
      found: true,
      seq: targetSeq,
      text: text.slice(0, limit),
      truncated: true,
      totalChars: text.length,
      ...(sourceKind === undefined ? {} : { sourceKind }),
    }
  }
  return {
    found: true,
    seq: targetSeq,
    text,
    truncated: false,
    totalChars: text.length,
    ...(sourceKind === undefined ? {} : { sourceKind }),
  }
}

// ===========================================================================
// Host plugin surface
// ===========================================================================

/** Agent event used for retirement. */
export const PRE_STEP_EVENT = 'agent/pre-step'
/** Agent event reserved for a later turn-boundary hook. */
export const TURN_STOPPING_EVENT = 'agent/turn-stopping'

/** Placeholder marker for the optional turn-stopping hook. No logic is attached. */
export const TURN_STOPPING_PLACEHOLDER = {
  installed: true,
  todo: 'connect handoff finalization / retired-set cleanup at the turn boundary later',
} as const

/**
 * Register the tools and hooks.
 *
 * `apply` is the Cordis/DSh entry; `activate` is exported as the spec-requested
 * alias. Both are synchronous: registration must finish before the plugin is
 * considered active.
 */
function estimateTokensFromText(text: string): number {
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/gu) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

export interface TokenWatermark {
  tokens: number
  contextWindow: number
  ratio: number
  /**
   * v7.0 P0-2: which mechanism produced this number.
   *
   * `tokenMeter` is the host's fold and the only one comparable with the
   * compaction engine's own threshold. `incremental` is this plugin's fold over
   * the live log, which consumes only newly appended events. `usage` is real
   * provider data read from a full snapshot (detached session). `estimate` is a
   * character-count guess. Logging the source is what makes "why did it migrate
   * at 60%?" answerable after the fact.
   */
  source: 'tokenMeter' | 'incremental' | 'usage' | 'estimate'
}

/**
 * v7.0: per-session incremental fold state for the watermark.
 *
 * `scannedUpTo` is the event count the cached figures were computed at, so a
 * later call only consumes the tail. Cleared by `resetRetiredSessions()`.
 */
const watermarkCache = new Map<
  string,
  { scannedUpTo: number; contextWindow: number; usageTokens: number }
>()

/**
 * v4.0 / v7.0 P0-2: token pressure, measured by the HOST first.
 *
 * The plugin used to compute this itself: read `contextWindow` from the last
 * `request/context`, read `usage.inputTokens` from the last `assistant/message`,
 * and if neither existed, estimate from a character count. That estimate is a
 * different number from the one the host's compaction engine acts on
 * (`tokenMeter.measure()` prices per surface node, reuses provider usage only
 * when the request envelope matches, and re-prices the whole surface
 * otherwise). Two owners of one session disagreeing about "how full is it" is
 * how a plugin migrates at 60% while the engine thinks it is at 43%.
 *
 * The order below is deliberate:
 *
 *   1. `ctx.tokenMeter.measure(session)` — the authoritative measurement. The
 *      session must be LIVE for this (the meter folds over a Session object, not
 *      a snapshot), so it is skipped when the session is not in the store.
 *   2. Provider usage + context window from the log — still real data, just not
 *      the host's fold. Used when the meter is absent or the session is detached.
 *   3. Character estimate — last resort, and it says so in the returned source.
 *
 * The `source` field is not decoration: a migration log that cannot say which
 * of the three produced the number is unauditable.
 */
export async function readTokenWatermark(
  ctx: PluginContextLike,
  sourceSessionId: string,
  settings: Required<GraftConfig>,
): Promise<TokenWatermark | undefined> {
  // --- 1. the host's own measurement -------------------------------------
  try {
    const meter = ctx.get?.('tokenMeter')
    const live = ctx.get?.('sessions')?.get?.(sourceSessionId)
    if (meter !== undefined && meter !== null && typeof meter.measure === 'function' && live !== undefined) {
      const measurement = meter.measure(live)
      const total = Number(measurement?.totalTokens)
      const window = Number(
        live?.requestContext?.()?.contextWindow ?? 0,
      )
      const contextWindow = settings.contextWindowTokens > 0 ? settings.contextWindowTokens : window
      if (Number.isFinite(total) && total > 0 && Number.isFinite(contextWindow) && contextWindow > 0) {
        return { tokens: total, contextWindow, ratio: total / contextWindow, source: 'tokenMeter' }
      }
    }
  } catch {
    // Fall through: a meter that throws must not stop the migration check.
  }

  // --- 2. incremental fold over the LIVE log -----------------------------
  //
  // The old path called `ctx.sessionQuery.readSession()` on every pre-step, which
  // replays and validates the ENTIRE log — O(n) per step, on a session that is
  // already the largest thing in the process. That is the wrong complexity for a
  // check that runs before every model request.
  //
  // When the session is live we can fold incrementally instead: keep the cached
  // watermark per session plus the log length it was computed at, and on each
  // call consume only the events appended since. The two facts that matter
  // (newest `contextWindow`, newest provider usage) are both "last one wins", so
  // an incremental fold is exact, not an approximation.
  //
  // The full read stays as the fallback for a detached session, where there is
  // no live log to fold and the snapshot is the only source.
  const liveForFold = (() => {
    try {
      return ctx.get?.('sessions')?.get?.(sourceSessionId)
    } catch {
      return undefined
    }
  })()
  if (liveForFold !== undefined && typeof liveForFold.snapshotEvents === 'function') {
    try {
      const events = liveForFold.snapshotEvents(0) as readonly SessionEventLike[]
      const cached = watermarkCache.get(sourceSessionId)
      let contextWindow = cached?.contextWindow ?? 0
      let usageTokens = cached?.usageTokens ?? 0
      let from = cached?.scannedUpTo ?? 0
      // A shorter log than we remember means the store was replaced (restore,
      // migration, HMR). Recompute from scratch rather than trusting the fold.
      if (cached !== undefined && events.length < cached.scannedUpTo) {
        contextWindow = 0
        usageTokens = 0
        from = 0
      }
      for (let index = from; index < events.length; index += 1) {
        const event = events[index]
        if (event?.type === 'request/context') {
          const window = Number(event.data?.contextWindow)
          if (Number.isFinite(window) && window > 0) contextWindow = window
          continue
        }
        if (event?.type === 'assistant/message') {
          const usage = event.data?.usage
          const candidate =
            typeof usage?.inputTokens === 'number'
              ? usage.inputTokens
              : typeof usage?.totalTokens === 'number'
                ? usage.totalTokens
                : 0
          if (candidate > 0) usageTokens = candidate
        }
      }
      watermarkCache.set(sourceSessionId, { scannedUpTo: events.length, contextWindow, usageTokens })
      const effectiveWindow = settings.contextWindowTokens > 0 ? settings.contextWindowTokens : contextWindow
      if (usageTokens > 0 && Number.isFinite(effectiveWindow) && effectiveWindow > 0) {
        return {
          tokens: usageTokens,
          contextWindow: effectiveWindow,
          ratio: usageTokens / effectiveWindow,
          source: 'incremental',
        }
      }
    } catch {
      // Fall through to the full read.
    }
  }

  let snapshot: any
  try {
    snapshot = await ctx.sessionQuery.readSession(sourceSessionId)
  } catch {
    return undefined
  }
  const events: any[] = Array.isArray(snapshot?.events) ? snapshot.events : []
  if (events.length === 0) return undefined
  let contextWindow = 0
  for (const event of events) {
    if (event.type === 'request/context' && typeof event.data?.contextWindow === 'number' && event.data.contextWindow > 0) {
      contextWindow = event.data.contextWindow
    }
  }
  if (settings.contextWindowTokens > 0) contextWindow = settings.contextWindowTokens
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  let usageTokens = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    const candidate =
      typeof usage?.inputTokens === 'number'
        ? usage.inputTokens
        : typeof usage?.totalTokens === 'number'
          ? usage.totalTokens
          : 0
    if (candidate > 0) {
      usageTokens = candidate
      break
    }
  }
  // --- 2. provider usage, when the log carries one ------------------------
  if (usageTokens > 0) {
    return { tokens: usageTokens, contextWindow, ratio: usageTokens / contextWindow, source: 'usage' }
  }
  // --- 3. character estimate, last resort --------------------------------
  const text = events
    .map((event) => {
      const message = event.data?.message ?? event.data
      return textOfMessage(message) || String(event.data?.arguments ?? '')
    })
    .join('\n')
  const tokens = Math.max(usageTokens, estimateTokensFromText(text))
  return { tokens, contextWindow, ratio: tokens / contextWindow, source: 'estimate' }
}

function autoTargetId(settings: Required<GraftConfig>): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `${settings.autoGraftIdPrefix}-${suffix}`
}

// ===========================================================================
// v7.4 P0-2: the graft transaction journal
// ===========================================================================

export type GraftTxnState = 'PREPARING' | 'TARGET_FLUSHED' | 'COLD_VERIFIED' | 'COMMITTED'

export interface GraftTxnRecord {
  sourceSessionId: string
  targetSessionId: string
  state: GraftTxnState
  /** The stage that produced the current record, for a readable recovery log. */
  stage: string
  updatedAt: string
  /** Present once something went wrong; recovery reports it. */
  error?: string
}

/**
 * Why a journal and not just ordering.
 *
 * Ordering already guarantees the one thing that matters most: the source is
 * retired LAST, so a crash anywhere earlier leaves the source usable. That is the
 * invariant `sourceUsable ∨ targetUsable`, and it holds without any journal.
 *
 * What ordering cannot do is clean up. A process killed between `create()` and
 * `flush()` leaves a reserved id with a partial log; between `flush()` and
 * retirement it leaves a complete-but-unretired target. Neither is visible to the
 * next start unless something durable says "this was in flight". That is the
 * journal's only job.
 */
function txnFileFor(sourceSessionId: string): string {
  // The id is already restricted to safe characters by asNonEmptyString + the
  // host's id policy; encode anyway so a future host that permits other shapes
  // cannot escape the directory.
  return join(txnDirPath, `${encodeURIComponent(sourceSessionId)}.json`)
}

function writeGraftTxn(ctx: PluginContextLike | undefined, record: GraftTxnRecord): void {
  if (ctx === undefined) return
  try {
    mkdirSync(txnDirPath, { recursive: true })
    writeJsonAtomic(txnFileFor(record.sourceSessionId), record)
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write transaction record: ${String((error as any)?.message ?? error)}`)
    } catch {
      // The journal must never change a migration's outcome.
    }
  }
}

function clearGraftTxn(sourceSessionId: string): void {
  try {
    rmSync(txnFileFor(sourceSessionId), { force: true })
  } catch {
    // A stuck record is reported by the next recovery pass, not swallowed.
  }
}

/**
 * Mark a half-built target so it cannot be mistaken for a usable session.
 *
 * The host exposes no delete on `SessionPersistence`, so "discard" is advisory.
 * The durable, always-available mark is the session's own title: `[损坏]` is what
 * a user sees in the sidebar, and it survives everything.
 */
function markTargetBroken(
  ctx: PluginContextLike,
  targetId: string,
  reason: string,
  extra: { sourceSessionId?: string; stage?: string } = {},
): void {
  try {
    const live = (ctx.get('sessions') as any)?.get?.(targetId)
    if (live !== undefined && typeof live.append === 'function') {
      live.append('session/title', {
        title: `[损坏] 迁移未完成 ${targetId}`,
        messageSeqs: [],
        // v7.3: empty refs require 'user' — see buildInjectionEvents.
        source: { kind: 'user' },
      })
    }
  } catch {
    // A mark that cannot be written must not replace the primary failure.
  }
  if (extra.sourceSessionId !== undefined) {
    writeGraftTxn(ctx, {
      sourceSessionId: extra.sourceSessionId,
      targetSessionId: targetId,
      state: 'PREPARING',
      stage: extra.stage ?? 'unknown',
      updatedAt: new Date().toISOString(),
      error: reason,
    })
    recordLeftover(ctx, {
      targetId,
      sourceSessionId: extra.sourceSessionId,
      stage: extra.stage ?? 'unknown',
      reason,
    })
  }
}

/**
 * v7.4 P0-2: recover every migration that did not reach COMMITTED.
 *
 * The recovery direction is fixed and deliberately boring: **make the source
 * usable and make the target honest.**
 *
 *   - Never retire a source on the basis of a partial record.
 *   - Never resurrect a target; if one exists it is marked `[损坏]` so the sidebar
 *     stops presenting it as a choice.
 *   - Always delete the record, so the next start does not repeat the work.
 *
 * Running this twice is a no-op the second time, which is what makes it safe to
 * call on every activation.
 */
export function recoverGraftTransactions(ctx: PluginContextLike): { scanned: number; rolledBack: string[] } {
  const rolledBack: string[] = []
  let files: string[] = []
  try {
    files = readdirSync(txnDirPath).filter((name) => name.endsWith('.json'))
  } catch (error) {
    // v7.4b: an ABSENT directory means "nothing was interrupted" — the normal
    // first start. Anything else (a missing import, a permission denial) used to
    // be swallowed here and reported as "0 records", which is indistinguishable
    // from a clean start. That is exactly how a `readdirSync` that was never
    // imported survived a whole release: every journal was ignored and every
    // crash looked like a clean start. Name the failure; activation still runs.
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(
          `[dsh-graft-slice] transaction scan failed (${String((error as any)?.code ?? 'unknown')}): ` +
            `${String((error as any)?.message ?? error)}; path ${txnDirPath}`,
        )
      } catch {
        // Logging must not block activation.
      }
    }
    return { scanned: 0, rolledBack }
  }
  for (const file of files) {
    const path = join(txnDirPath, file)
    let record: GraftTxnRecord
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (!isRecord(parsed) || typeof parsed.sourceSessionId !== 'string') throw new Error('malformed record')
      record = parsed as unknown as GraftTxnRecord
    } catch {
      // A corrupt journal entry cannot describe a migration we can repair; drop it.
      try {
        rmSync(path, { force: true })
      } catch {
        // Ignore: the next pass retries.
      }
      continue
    }
    if (record.state === 'COMMITTED') {
      // The migration finished; the record is merely stale.
      try {
        rmSync(path, { force: true })
      } catch {
        // Ignore.
      }
      continue
    }
    // Roll back.
    try {
      // A source must never stay retired because of an unfinished migration.
      if (retiredSessions.has(record.sourceSessionId) || transferredSessions.has(record.sourceSessionId)) {
        resumeSession(ctx, record.sourceSessionId)
      }
      // A target that exists is not a session we may present as usable.
      if (typeof record.targetSessionId === 'string' && record.targetSessionId.length > 0) {
        markTargetBroken(ctx, record.targetSessionId, record.error ?? `interrupted at ${record.stage}`, {
          sourceSessionId: record.sourceSessionId,
          stage: record.stage,
        })
        void discardPartialTarget(ctx, record.targetSessionId)
      }
      rolledBack.push(record.sourceSessionId)
      ctx.logger?.warn?.(
        `[dsh-graft-slice] rolled back an interrupted migration ${record.sourceSessionId} → ${record.targetSessionId} (state ${record.state}, stage ${record.stage})`,
      )
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] rollback of ${record.sourceSessionId} failed: ${String((error as any)?.message ?? error)}`,
      )
    } finally {
      // Even a failed rollback removes the record: retrying the same broken
      // artifact on every start is worse than leaving it marked.
      try {
        rmSync(path, { force: true })
      } catch {
        // Ignore.
      }
    }
  }
  return { scanned: files.length, rolledBack }
}

/**
 * v7.0 P0-4: best-effort removal of a target that failed to become durable.
 *
 * Called only from the failure path of the persistence write, so the goal is
 * narrow: leave no artifact that pretends to be a resumable session.
 *
 * `create()` reserves the id immediately, so by the time `append` or `flush`
 * throws, a header — and possibly a partial event log — already exists on disk
 * under the target's name. The source stays alive (retirement runs later), but
 * the target id is now OCCUPIED by a corrupt artifact: the sidebar shows a
 * session that cannot resume, and a retry with the same id fails with
 * SESSION_EXISTS.
 *
 * Every step is optional and independently guarded. A backend that offers none
 * of these leaves the reservation in place, which is reported rather than
 * hidden — the caller already throws the original error, and a phantom session
 * is the kind of thing that only surfaces days later as a mysterious ENOENT.
 */
async function discardPartialTarget(ctx: PluginContextLike, targetId: string): Promise<void> {
  const notes: string[] = []
  const persistence = (() => {
    try {
      return ctx.get('sessionPersistence') as any
    } catch {
      return undefined
    }
  })()
  const sessions = (() => {
    try {
      return ctx.get('sessions') as any
    } catch {
      return undefined
    }
  })()
  // 1. The prepared reservation, if the backend exposes a discard.
  for (const method of ['discardPrepared', 'discard', 'forget']) {
    if (persistence === undefined || typeof persistence[method] !== 'function') continue
    try {
      await persistence[method](targetId)
      notes.push(`persistence.${method}`)
    } catch (error) {
      notes.push(`persistence.${method} failed: ${String((error as any)?.message ?? error)}`)
    }
    break
  }
  // 2. A durable artifact, if the backend offers a removal.
  for (const method of ['remove', 'delete']) {
    if (persistence === undefined || typeof persistence[method] !== 'function') continue
    try {
      await persistence[method](targetId)
      notes.push(`persistence.${method}`)
    } catch (error) {
      notes.push(`persistence.${method} failed: ${String((error as any)?.message ?? error)}`)
    }
    break
  }
  // 3. A live-store entry, if one was ever published.
  if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(targetId) !== undefined) {
    for (const method of ['remove', 'delete', 'dispose']) {
      if (typeof sessions[method] !== 'function') continue
      try {
        await sessions[method](targetId)
        notes.push(`sessions.${method}`)
      } catch (error) {
        notes.push(`sessions.${method} failed: ${String((error as any)?.message ?? error)}`)
      }
      break
    }
  }
  try {
    ctx.logger?.warn?.(
      notes.length === 0
        ? `[dsh-graft-slice] failed target ${targetId} could not be removed (no delete API on this host); the id stays reserved`
        : `[dsh-graft-slice] discarded failed target ${targetId} (${notes.join(', ')})`,
    )
  } catch {
    // Logging must not replace the primary failure.
  }
}

/**
 * v4.0: automatic graft at the turn-stopping watermark. The graft is deferred
 * until the current turn/end is durable; OPEN_TURN is retried briefly.
 */

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
export interface HarborState {
  safe: boolean
  reason: string
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

export function checkSafeHarbor(events: readonly SessionEventLike[]): HarborState {
  const openCalls = new Set<string>()
  let streaming = false

  for (const event of events) {
    if (event.type === 'tool/call') {
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
      if (callId.length > 0) openCalls.add(callId)
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

  if (openCalls.size > 0) {
    return {
      safe: false,
      reason: `${openCalls.size} tool call(s) still awaiting a result`,
    }
  }
  if (streaming) {
    return { safe: false, reason: 'an assistant response is still streaming' }
  }
  return { safe: true, reason: 'quiet boundary' }
}

/**
 * v6.3 module 4: confirmation valve.
 *
 * Silent migration is the right default, but a user mid-sentence can be
 * startled by a context switch. In 'confirm' mode the watermark only arms a
 * question; the migration itself waits for explicit agreement.
 */
interface PendingConfirm {
  targetId: string
  askedAt: number
  ratio: number
}

const pendingConfirms = new Map<string, PendingConfirm>()
/** v6.3 module 1: sessions that hit a busy step and must retry at turn/end. */
const pendingGraftSources = new Set<string>()

/**
 * v7.0 P6: sessions whose request overflowed once already.
 *
 * The retry the host performs after a successful recovery must not become a
 * migration loop: if the freshly built tape is itself larger than the window,
 * the retried request overflows again, and a second migration would produce the
 * same tape. One attempt per session is the honest limit — the second overflow
 * is surfaced to the caller instead of being papered over.
 */
const overflowRetries = new Set<string>()

/**
 * v7.0 P6: overflow recoveries that produced a target but deliberately did NOT
 * retire the source.
 *
 * The retry has to run in the source session, so retirement cannot happen
 * before it. These entries are consumed by the source's next `agent/pre-step`,
 * which is the earliest moment the user can be redirected to the target.
 */
const deferredOverflowTargets = new Map<string, string>()

/**
 * v7.3: per-session count of task-boundary deferrals.
 *
 * The cap exists so a session whose "task" never reaches a clean boundary — an
 * expected failure, a flaky test, a red the user decided to live with — still
 * migrates. Without it, the probe converts "wait for a good moment" into "never
 * move", which is worse than cutting in an awkward place.
 */
const taskBoundaryDeferrals = new Map<string, number>()

/** The provider failure code that means "this request does not fit". */
const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'

/**
 * v7.0 C2: sessions this plugin CREATED as a graft target.
 *
 * Why this exists — the chain-migration failure:
 *
 * `autoGraftIfNeeded` only refused sessions in `retiredSessions` /
 * `transferredSessions`. A freshly created target is in neither: it is a brand
 * new id nobody retired. But the watermark is computed from
 * `assistant/message.usage.inputTokens`, and a target is seeded with a tape that
 * can already be large. So the moment a target's first real request reports a
 * ratio at or above `autoGraftAtRatio`, the plugin grafts the target into
 * another target — before the user has typed anything.
 *
 * Each hop resets the session but carries the same tape, so the next hop can
 * trip the same threshold again. That is an unbounded migration chain, and
 * every link buries the original intent one generation deeper.
 *
 * The guard is deliberately a *generation* counter, not a boolean: a target may
 * legitimately be grafted once more after it has done real work, but it must
 * never be grafted as a direct consequence of being created.
 */
interface GraftTargetMark {
  /** The session this target was created from. */
  sourceSessionId: string
  /** When the target was created, epoch ms. */
  createdAt: number
  /** How many migrations deep this session already is. */
  generation: number
  /**
   * v0.32: how many events the slice itself wrote.
   *
   * The retry path needs to tell "this target was never woken" from "somebody already
   * drove it" — a human opening the session between the failed ignition and the next
   * start is the common case. Growth past this count is the only evidence the plugin
   * has, and it is exact: the tape is written contiguously from seq 0 and nothing else
   * writes to a cold target.
   */
  seedEvents?: number
  /**
   * v1.0.2 — THE GOAL IN FORCE FOR THIS TARGET, which is not necessarily the one the
   * chain started with.
   *
   * "Never drift" and "never evolve" are not the same rule. A long handoff chain kept
   * re-seeding the ORIGINAL ask forever, so a target that had legitimately narrowed or
   * redirected the work was pulled back to a goal nobody wanted any more. The original
   * ask stays on the board (it is the audit trail); this field is what the target acts on.
   */
  currentGoal?: string
  /**
   * v1.0.2 — every recorded goal change, oldest first.
   *
   * `{ at, from, to, reason }`, appended by `graft_update_goal`. Written down so a new
   * target can SEE that the goal moved and why, instead of silently inheriting whatever
   * the previous generation happened to believe.
   */
  goalEvolution?: Array<{ at: number; from: string; to: string; reason: string }>
}

const graftTargets = new Map<string, GraftTargetMark>()

/** Sessions already grafted at least once; a target inherits source generation + 1. */
function graftGenerationOf(sessionId: string): number {
  return graftTargets.get(sessionId)?.generation ?? 0
}

function markGraftTarget(sessionId: string, sourceSessionId: string, seedEvents?: number, goal?: string): void {
  // v1.0.2: the goal travels down the chain unless the source already evolved it.
  const inherited = graftTargets.get(sourceSessionId)?.currentGoal
  const currentGoal = inherited !== undefined && inherited.length > 0 ? inherited : goal
  graftTargets.set(sessionId, {
    sourceSessionId,
    createdAt: Date.now(),
    generation: graftGenerationOf(sourceSessionId) + 1,
    ...(typeof seedEvents === 'number' && seedEvents > 0 ? { seedEvents } : {}),
    ...(currentGoal === undefined || currentGoal.length === 0 ? {} : { currentGoal }),
    ...(inherited === undefined ? {} : { goalEvolution: graftTargets.get(sourceSessionId)?.goalEvolution }),
  })
  // v7.0: persist the mark.
  //
  // The in-memory map is rebuilt empty on every start, so a target created
  // before a restart became an ordinary session afterwards — precisely the one
  // session the chain guard exists for. The store file is the same `dataDir`
  // the retired/transferred sets already use, so isolation is unchanged.
  persistGraftTargetStore(ctxForStores())
}

/**
 * v7.0: the graft-target marks, persisted alongside the retired/transferred sets.
 *
 * Written on every new target (small, bounded by the number of migrations this
 * profile has performed) and read once at activation.
 */
function persistGraftTargetStore(ctx: PluginContextLike | undefined, remove: readonly string[] = []): void {
  if (ctx === undefined) return
  try {
    mkdirSync(dirname(graftTargetsPath), { recursive: true })
    withFileLock(graftTargetsPath, () => {
      const merged = readJsonRecord(graftTargetsPath) as Record<string, GraftTargetMark>
      for (const id of remove) delete merged[id]
      for (const [id, mark] of graftTargets) merged[id] = mark
      for (const [id, mark] of Object.entries(merged)) {
        if (mark !== null && typeof mark === 'object' && typeof mark.sourceSessionId === 'string' && !graftTargets.has(id)) {
          graftTargets.set(id, mark)
        }
      }
      writeJsonAtomic(graftTargetsPath, merged)
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${graftTargetsPath}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the migration result.
    }
  }
}

/**
 * v1.1 OBSERVER — THE FOLLOWER POINTER, and why it is a pointer instead of a second tape.
 *
 * Mutual graft was rejected on purpose (副会话Observer-架构方案-v0.1.md §2): two sessions
 * retiring each other is four waiting cycles — retire-waits-retire, two source locks,
 * half-read logs, recursive ignition. A follower never retires, so none of those cycles
 * exist: the observer's identity is this record, and a transfer only rewrites it.
 */
interface ObserverBindings {
  /** mainSessionId -> observerSessionId */
  bindings: Record<string, string>
  /** observerSessionId -> mainSessionId (reverse index, so a monitor finds its target) */
  reverse: Record<string, string>
  /**
   * A ONE-SHOT focus request written inside the transfer's critical section. The console
   * reads it and calls `uiWorkspace.openSession` once, then acks — the only way a Host-side
   * handoff can pull a Desktop window, because `uiWorkspace` is a CLIENT service.
   */
  focus: { sessionId: string; at: number } | null
}

const observerBindings: ObserverBindings = { bindings: {}, reverse: {}, focus: null }

function loadObserverBindings(ctx: PluginContextLike): void {
  try {
    const parsed = JSON.parse(readFileSync(observerBindingsPath, 'utf8'))
    if (!isRecord(parsed)) return
    if (isRecord(parsed.bindings)) {
      for (const [mainId, observerId] of Object.entries(parsed.bindings)) {
        if (typeof observerId === 'string' && observerId.length > 0) observerBindings.bindings[mainId] = observerId
      }
    }
    if (isRecord(parsed.reverse)) {
      for (const [observerId, mainId] of Object.entries(parsed.reverse)) {
        if (typeof mainId === 'string' && mainId.length > 0) observerBindings.reverse[observerId] = mainId
      }
    }
    if (isRecord(parsed.focus) && typeof parsed.focus.sessionId === 'string' && parsed.focus.sessionId.length > 0) {
      observerBindings.focus = {
        sessionId: parsed.focus.sessionId,
        at: typeof parsed.focus.at === 'number' ? parsed.focus.at : 0,
      }
    }
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${observerBindingsPath}: ${String((error as any)?.message ?? error)}`)
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

function persistObserverBindings(ctx: PluginContextLike | undefined): void {
  if (ctx === undefined) return
  try {
    mkdirSync(dirname(observerBindingsPath), { recursive: true })
    withFileLock(observerBindingsPath, () => {
      writeJsonAtomic(observerBindingsPath, JSON.parse(JSON.stringify(observerBindings)))
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${observerBindingsPath}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the migration result.
    }
  }
}

/** The observer bound to a main session, if any. */
function observerOf(mainSessionId: string): string {
  const observerId = observerBindings.bindings[mainSessionId]
  return typeof observerId === 'string' ? observerId : ''
}

/** The main session an observer follows, if any. */
function mainOfObserver(observerSessionId: string): string {
  const mainSessionId = observerBindings.reverse[observerSessionId]
  return typeof mainSessionId === 'string' ? mainSessionId : ''
}

/** True when this session is a FOLLOWER, i.e. it must never itself be sliced. */
function isObserverSession(sessionId: string): boolean {
  return mainOfObserver(sessionId).length > 0
}

function bindObserver(ctx: PluginContextLike | undefined, mainSessionId: string, observerSessionId: string): void {
  observerBindings.bindings[mainSessionId] = observerSessionId
  observerBindings.reverse[observerSessionId] = mainSessionId
  persistObserverBindings(ctx)
}

function unbindObserver(ctx: PluginContextLike | undefined, mainSessionId: string): string {
  const observerId = observerOf(mainSessionId)
  delete observerBindings.bindings[mainSessionId]
  if (observerId.length > 0) delete observerBindings.reverse[observerId]
  persistObserverBindings(ctx)
  return observerId
}

/**
 * v1.1 — THE TRANSFER FOLLOWS THE POINTER, inside the caller's `source:main` lock.
 *
 * Called after the new target is durable. Three things only:
 *   1. rewrite the binding old-main -> new-main (the observer keeps its own id);
 *   2. file a one-shot focus request so a Desktop window can follow the handoff;
 *   3. drop the old reverse entry, so `mainOfObserver` never answers with a retired id.
 *
 * It NEVER prompts, never waits for the observer and never blocks ignition: a slow
 * observer must not be able to delay the main session's start.
 */
function rebindObserverOnTransfer(
  ctx: PluginContextLike | undefined,
  oldMainSessionId: string,
  newMainSessionId: string,
): { followed: boolean; observerSessionId: string } {
  const observerId = observerOf(oldMainSessionId)
  if (observerId.length === 0) return { followed: false, observerSessionId: '' }
  delete observerBindings.bindings[oldMainSessionId]
  observerBindings.bindings[newMainSessionId] = observerId
  observerBindings.reverse[observerId] = newMainSessionId
  observerBindings.focus = { sessionId: newMainSessionId, at: Date.now() }
  persistObserverBindings(ctx)
  return { followed: true, observerSessionId: observerId }
}

/** The console consumes the focus request exactly once. */
function takeObserverFocus(ctx: PluginContextLike | undefined): { sessionId: string; at: number } | null {
  const focus = observerBindings.focus
  if (focus === null) return null
  observerBindings.focus = null
  persistObserverBindings(ctx)
  return focus
}

function loadGraftTargetStore(ctx: PluginContextLike): void {
  try {
    const parsed = JSON.parse(readFileSync(graftTargetsPath, 'utf8'))
    if (!isRecord(parsed)) return
    for (const [id, value] of Object.entries(parsed)) {
      if (!isRecord(value) || typeof value.sourceSessionId !== 'string') continue
      graftTargets.set(id, {
        sourceSessionId: value.sourceSessionId,
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
        generation: typeof value.generation === 'number' ? value.generation : 1,
        // v1.0.2: these three used to be DROPPED on load, so a restart forgot both the
        // wake-evidence watermark (seedEvents) and the goal the chain had evolved to.
        ...(typeof value.seedEvents === 'number' && value.seedEvents > 0 ? { seedEvents: value.seedEvents } : {}),
        ...(typeof value.currentGoal === 'string' && value.currentGoal.length > 0 ? { currentGoal: value.currentGoal } : {}),
        ...(Array.isArray(value.goalEvolution) ? { goalEvolution: value.goalEvolution as GraftTargetMark['goalEvolution'] } : {}),
      })
    }
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${graftTargetsPath}: ${String((error as any)?.message ?? error)}`)
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

/**
 * Whether a session must not be grafted right now because it IS a graft target.
 *
 * A target is protected for a grace window measured in *completed turns* rather
 * than wall-clock time: the dangerous case is "the first request already crosses
 * the ratio", which happens inside the first turn regardless of how long the
 * user takes to type. After the grace turns elapse the session is an ordinary
 * session again and may migrate on its own merits.
 */
function isProtectedGraftTarget(
  sessionId: string,
  events: readonly SessionEventLike[] | undefined,
  graceTurns: number,
): boolean {
  const mark = graftTargets.get(sessionId)
  if (mark === undefined) return false
  if (graceTurns <= 0) return false
  if (events === undefined) return true
  const completed = events.filter((event) => event.type === 'turn/end').length
  return completed <= graceTurns
}

function isConfirmAffirmative(text: string): boolean {
  const normalized = text.replace(/\s+/gu, '').trim()
  if (normalized.length === 0) return false
  return /^(确认|确定|同意|好|可以|是|yes|y|ok|sure|go|proceed|continue|doit)$/iu.test(normalized)
}

async function autoGraftIfNeeded(
  ctx: PluginContextLike,
  settings: Required<GraftConfig>,
  sourceSessionId: string,
  options?: {
    targetId?: string
    ignoreTransferGuard?: boolean
    /** v6.3: set when the user answered the confirm prompt. */
    confirmed?: boolean
    /**
     * v0.14 D2: bypass the CHAIN guard (the fresh-target grace window).
     *
     * Never passed by the automatic paths, and not by the manual tool either: only
     * a caller that has already decided the chain is acceptable — a test, or an
     * operator-directed recovery — sets it.
     */
    forceSlice?: boolean
    /** Supplied by apply(): the background refinement lives in that closure. */
    refineConstraints?: (
      sourceSessionId: string,
      targetSessionId: string,
      events: readonly SessionEventLike[],
    ) => void
  },
): Promise<GraftReport | undefined> {
  if (!settings.autoGraft) return undefined
  if (options?.ignoreTransferGuard !== true) {
    if (retiredSessions.has(sourceSessionId) || transferredSessions.has(sourceSessionId)) return undefined
  }
  // v7.0 C2 / v0.14 D2: a target must never be grafted as a consequence of being
  // created. Checked before the watermark so a large seeded tape cannot bootstrap
  // a chain.
  //
  // v0.14 FIX: this check used to be nested inside `ignoreTransferGuard !== true`
  // — and BOTH automatic callers (the forced 75% fallback and the confirmed
  // prompt) pass `ignoreTransferGuard: true` to bypass the retired/transferred
  // refusal. So the chain guard was skipped precisely on the path that fires
  // without a human: a freshly created target whose seeded tape already sits
  // above 0.75 was force-grafted again on its first request, forever. Bypassing
  // the TRANSFER guard is not permission to bypass the CHAIN guard; only an
  // explicit `forceSlice` (tests, and a deliberate operator action) does that.
  if (options?.forceSlice !== true) {
    const targetEvents = (() => {
      const live = ctx.sessions.get(sourceSessionId) as any
      if (live !== undefined && typeof live.snapshotEvents === 'function') return live.snapshotEvents(0) as SessionEventLike[]
      return undefined
    })()
    if (isProtectedGraftTarget(sourceSessionId, targetEvents, settings.graftTargetGraceTurns)) {
      appendGraftAudit({
        at: new Date().toISOString(),
        kind: 'chain-guard',
        sessionId: sourceSessionId,
        detail: `refused re-graft of generation ${graftGenerationOf(sourceSessionId)} inside the ${settings.graftTargetGraceTurns}-turn grace window`,
      })
      ctx.logger?.info?.(
        `[dsh-graft-slice] refusing to re-graft a graft target (${sourceSessionId}); generation ${graftGenerationOf(sourceSessionId)}`,
      )
      return undefined
    }
  }
  if (autoGraftInFlight.has(sourceSessionId) || inFlight.has(sourceSessionId)) return undefined
  // v7.4: a session the user just brought back must not be killed again by the
  // very next message.
  //
  // Measured twice on this project: `graft_resume_session` clears the retirement,
  // the user says one sentence, and the watermark — still ≥0.75 because the log
  // never shrank — grafts it straight back into a NEW target and retires it
  // again. From the user's side the undo simply does not work.
  const suppressedUntil = autoGraftSuppressedUntil.get(sourceSessionId)
  if (suppressedUntil !== undefined) {
    if (Date.now() < suppressedUntil) {
      ctx.logger?.info?.(
        `[dsh-graft-slice] auto-graft suppressed for a resumed session ${sourceSessionId} until ${new Date(suppressedUntil).toISOString()}`,
      )
      return undefined
    }
    autoGraftSuppressedUntil.delete(sourceSessionId)
    try {
      persistAutoGraftSuppression(ctx, [sourceSessionId])
    } catch {
      // A stale record only suppresses once more; it is not worth failing here.
    }
  }
  autoGraftInFlight.add(sourceSessionId)
  try {
    const watermark = await readTokenWatermark(ctx, sourceSessionId, settings)
    if (watermark === undefined) return undefined
    // v0.18: the cutoff is DERIVED from the window and the estimated cost of the
    // handoff itself (see `calculateSafeWatermark`), not read from a constant.
    // `watermarkMode: 'fixed'` restores the historical ratios exactly.
    const thresholds = effectiveWatermarks(settings, watermark)
    if (watermark.ratio < thresholds.hardAt) return undefined

    // v6.3 module 1: never cut a half-finished step.
    const snapshotForHarbor = (() => {
      const live = ctx.sessions.get(sourceSessionId) as any
      if (live !== undefined && typeof live.snapshotEvents === 'function') return live.snapshotEvents(0)
      return undefined
    })()
    if (snapshotForHarbor !== undefined) {
      const harbor = checkSafeHarbor(snapshotForHarbor)
      if (!harbor.safe) {
        // Arm the retry; the next turn/end is a quiet boundary by construction.
        pendingGraftSources.add(sourceSessionId)
        ctx.logger?.info?.(
          `[dsh-graft-slice] safe-harbor: deferring graft for ${sourceSessionId} (${harbor.reason})`,
        )
        return undefined
      }
      // v7.3: the semantic gate. A quiet log can still be the middle of a task.
      //
      // Bounded deferral: after `taskBoundaryMaxDeferTurns` attempts the watermark
      // wins. A permanently red test (expected, flaky, or one the user chose to
      // ignore) must not pin a session at the watermark forever — "wait for a
      // clean boundary" degrades into "never migrate" the moment one never comes.
      const boundary = checkTaskBoundary(
        snapshotForHarbor,
        extractTaskState(snapshotForHarbor).openTodos,
      )
      if (boundary.shouldDefer) {
        const deferred = (taskBoundaryDeferrals.get(sourceSessionId) ?? 0) + 1
        taskBoundaryDeferrals.set(sourceSessionId, deferred)
        if (deferred <= settings.taskBoundaryMaxDeferTurns) {
          pendingGraftSources.add(sourceSessionId)
          ctx.logger?.info?.(
            `[dsh-graft-slice] task-boundary: deferring graft for ${sourceSessionId} ` +
              `(${boundary.reason}; attempt ${deferred}/${settings.taskBoundaryMaxDeferTurns})`,
          )
          return undefined
        }
        ctx.logger?.warn?.(
          `[dsh-graft-slice] task-boundary: waited ${deferred} attempt(s) for ${sourceSessionId}; migrating anyway`,
        )
      }
      taskBoundaryDeferrals.delete(sourceSessionId)
      pendingGraftSources.delete(sourceSessionId)
    }

    // v6.3 module 4: in confirm mode the watermark only asks; it does not act.
    if (settings.graftMode === 'confirm' && options?.confirmed !== true) {
      const existing = pendingConfirms.get(sourceSessionId)
      if (existing === undefined) {
        pendingConfirms.set(sourceSessionId, {
          targetId: autoTargetId(settings),
          askedAt: Date.now(),
          ratio: watermark.ratio,
        })
        ctx.logger?.info?.(
          `[dsh-graft-slice] confirm mode: waiting for user agreement before grafting ${sourceSessionId}`,
        )
      }
      return undefined
    }

    const targetId = options?.targetId ?? autoTargetId(settings)
    const live = ctx.sessions.get(sourceSessionId) as any
    let sourceSnapshot: { session: any; events: any[] } | undefined
    let runtimeIntent: RuntimeIntent | undefined
    if (live !== undefined && typeof live.snapshotEvents === 'function') {
      const events = live.snapshotEvents(0)
      // Read the knobs from the FULL log: DSH writes these log-only records
      // after the last turn/end.
      runtimeIntent = extractRuntimeIntent(events)
      // v7.4 P0-3b: hand the log over as it is.
      //
      // The turn that is running when the watermark fires is the most recent
      // work in the session, and its user message is the breakpoint. The old
      // code truncated the snapshot at the last turn/end, which made
      // `extractOpenTurnCarryover` see an empty tail — so an entire round,
      // including the instruction that started it, vanished from the tape and
      // the target re-read the PREVIOUS round as "the task". `locateBoundary`
      // still cuts the skeleton at the last closed turn; the open turn rides
      // along in the carryover block, which is injected first.
      if (hasClosedTurn(events)) sourceSnapshot = { session: live.header, events }
    }
    if (sourceSnapshot === undefined) {
      const raw = await ctx.sessionQuery.readSession(sourceSessionId)
      runtimeIntent = extractRuntimeIntent(raw.events)
      if (!hasClosedTurn(raw.events)) return undefined
      sourceSnapshot = { session: raw.session, events: raw.events }
    }
    // v7.0 C2: an unattended graft must never produce a tape the target cannot
    // hold. `maxTotalChars: 0` (the shipped default) is fine when a human runs
    // the tool by hand, but in auto mode an over-window tape is what bootstraps
    // the migration chain. Derive a cap from the real window unless the operator
    // already set a tighter one.
    const derivedBudget = deriveAutoTapeBudget(watermark.contextWindow)
    const autoTotalChars =
      settings.maxTotalChars > 0 && (derivedBudget <= 0 || settings.maxTotalChars < derivedBudget)
        ? settings.maxTotalChars
        : derivedBudget
    if (autoTotalChars > 0 && derivedBudget > 0 && settings.maxTotalChars === 0) {
      ctx.logger?.info?.(
        `[dsh-graft-slice] auto-graft derived maxTotalChars=${autoTotalChars} from contextWindow=${watermark.contextWindow}`,
      )
    }
    const report = await graftSliceAndInject(
      ctx,
      { ...settings, retireSource: true, maxTotalChars: autoTotalChars },
      sourceSessionId,
      targetId,
      undefined,
      {
        sourceSnapshot,
        ...(runtimeIntent === undefined ? {} : { runtimeIntent }),
        ...(options?.refineConstraints === undefined ? {} : { refineConstraints: options.refineConstraints }),
      },
    )
    ctx.logger?.info?.(
      `[dsh-graft-slice] auto-grafted ${sourceSessionId} -> ${targetId} at ${(watermark.ratio * 100).toFixed(1)}% (${watermark.tokens}/${watermark.contextWindow})`,
    )
    return report
  } catch (error) {
    if ((error as any)?.code === 'OPEN_TURN') {
      // The turn-stopping hook fires just before turn/end is appended.
      autoGraftInFlight.delete(sourceSessionId)
      await new Promise((resolve) => setTimeout(resolve, 600))
      return autoGraftIfNeeded(ctx, settings, sourceSessionId)
    }
    ctx.logger?.warn?.(`[dsh-graft-slice] auto-graft skipped: ${String((error as any)?.message ?? error)}`)
    return undefined
  } finally {
    autoGraftInFlight.delete(sourceSessionId)
  }
}

/**
 * v7.4 P4-3: give archived forks a sidebar entry.
 *
 * `sessions.fork` writes a copy but never PUBLISHES it, and the Web UI learns
 * about sessions exclusively from `api-session/added`, which the host emits on
 * `session/created` — i.e. for published sessions only. So a fork kept as an
 * experiment sample is loadable, resumable, and invisible. Measured on this
 * project: `baseline-fork-demo` (1,200 events, on disk, absent from the sidebar).
 *
 * Targets are excluded on purpose: they have their own announcement path, and a
 * target is protected from re-grafting by a grace window that an "archive"
 * announcement would only muddy.
 */
async function attachSessionToWorkspace(
  ctx: PluginContextLike,
  sessionId: string,
  cwd: string | undefined,
): Promise<boolean> {
  if (cwd === undefined || cwd.length === 0) return false
  const registry = ctx.get('workspaceRegistry')
  if (!isRecord(registry) || typeof registry.resolveByPath !== 'function') return false
  try {
    let workspace = await (registry.resolveByPath as (path: string) => Promise<unknown>)(cwd)
    if (workspace === undefined && typeof registry.create === 'function') {
      workspace = await (registry.create as (path: string) => Promise<unknown>)(cwd)
    }
    if (isRecord(workspace) && typeof workspace.attachSession === 'function') {
      await (workspace.attachSession as (id: string) => Promise<unknown>)(sessionId)
      return true
    }
  } catch {
    // Best effort: an unregistered workspace must not cost the announcement.
  }
  return false
}

export async function registerArchivedForks(
  ctx: PluginContextLike,
  settings: Required<GraftConfig>,
): Promise<number> {
  if (settings.registerArchivedForks !== true) return 0
  const query = ctx.get('sessionQuery') as any
  if (!isRecord(query) || typeof query.listSessions !== 'function') return 0
  let records: unknown
  try {
    records = await query.listSessions()
  } catch (error) {
    ctx.logger?.warn?.(
      `[dsh-graft-slice] cannot list sessions for fork registration: ${String((error as any)?.message ?? error)}`,
    )
    return 0
  }
  if (!Array.isArray(records)) return 0
  const emit = (ctx as any).emit
  let announced = 0
  for (const record of records) {
    if (!isRecord(record)) continue
    const header = isRecord(record.header) ? record.header : undefined
    const id = typeof header?.id === 'string' ? header.id : undefined
    if (id === undefined) continue
    if (record.live === true) continue
    if (graftTargets.has(id)) continue
    // Only fork-shaped ids: a cold ordinary session the host already knows about
    // must not be re-announced as an archive.
    if (!/-fork-/u.test(id)) continue
    const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
    await attachSessionToWorkspace(ctx, id, cwd)
    if (typeof emit !== 'function') continue
    try {
      emit('api-session/added', {
        sessionId: id,
        // summarizeCold: updatedAt = max(createdAt, metadata.lastPromptAt ?? 0)
        updatedAt: typeof header?.createdAt === 'number' ? header.createdAt : Date.now(),
        agentAvailable: false,
        formatStatus: typeof record.formatStatus === 'string' ? record.formatStatus : 'current',
        running: false,
        blank: false,
        ...(cwd === undefined ? {} : { cwd }),
      })
      announced += 1
    } catch {
      // A refused emit must not abort the sweep.
    }
  }
  return announced
}

// ===========================================================================
// v0.14 GUARD RAILS — the tool-layer defences and the debug panel
// ===========================================================================

/**
 * The tools whose arguments are a COMMAND. Only these are scanned: a guard that
 * inspects every tool's arguments would deny a `write` whose file *content*
 * happens to contain "rm -rf", which is a false positive with real cost.
 */
const COMMAND_TOOL_NAMES = new Set([
  'pwsh',
  'powershell',
  'shell',
  'bash',
  'sh',
  'cmd',
  'terminal',
  'exec',
  'run_command',
  'run',
])

/** Search/enumeration verbs: these are what turn a path into a filesystem sweep. */
const SEARCH_VERB =
  /\b(?:rg|ripgrep|grep|findstr|select-string|sls|get-childitem|gci|dir|ls|find|where\.exe|get-item|resolve-path|tree)\b/iu
/** Destructive verbs. Grouped so the workspace-confinement rule can exempt them. */
const DESTRUCTIVE_VERB =
  /\b(?:rm|del|erase|rd|rmdir|remove-item|ri|del|format|diskpart|mkfs|shutdown|stop-computer|clear-disk)\b/iu
/** Recursion/force flags that turn a delete into an unbounded one. */
const RECURSIVE_FLAG = /(?:-recurse\b|\/s\b|-r\b|-rf\b|-fr\b|--recursive\b|\/q\b|-force\b)/iu
/**
 * A path that escapes any workspace: a drive root, `/`, a home shortcut, or an
 * environment root. Deliberately narrow — `C:\Users\<user>\project\src` is NOT
 * here, because reading a specific path is legitimate; sweeping a root is not.
 *
 * Split in two on purpose: one regex with six alternatives and lookaheads is how
 * a guard acquires a typo that silently matches nothing.
 */
const ESCAPING_ROOT =
  /\b[A-Za-z]:[\\/](?=$|[\s"'),;])|(?:^|[\s"'=(,])\/(?=$|[\s"'),;])|~[\\/]?(?=$|[\s"'),;])|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|windir)%|\$env:(?:USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|windir)\b/iu
/** The system directories every Windows profile has, and `AppData` anywhere. */
const SYSTEM_DIR =
  /[A-Za-z]:[\\/](?:Users|Windows|Program Files(?: \(x86\))?|ProgramData)(?=$|[\\/\s"'),;])|(?:^|[\s"'=(,\\\/])AppData(?=$|[\\/\s"'),;])/iu

function escapesWorkspace(text: string): boolean {
  return ESCAPING_ROOT.test(text) || SYSTEM_DIR.test(text)
}

function commandTextOf(args: unknown): string {
  if (typeof args === 'string') return args
  if (args === null || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['command', 'cmd', 'script', 'code', 'input', 'args', 'arguments']) {
    const value = record[key]
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) parts.push(value.filter((item) => typeof item === 'string').join(' '))
  }
  return parts.join('\n')
}

/**
 * Expand the environment shortcuts a destructive command may hide behind, so the
 * confinement check sees a real path. Only the roots the guard cares about;
 * anything unknown is left as-is and treated as "not provably inside".
 */
function expandKnownRoots(text: string): string {
  return text
    .replace(/%USERPROFILE%/giu, () => homedir())
    .replace(/\$env:USERPROFILE\b/giu, () => homedir())
    .replace(/%APPDATA%/giu, () => join(homedir(), 'AppData', 'Roaming'))
    .replace(/\$env:APPDATA\b/giu, () => join(homedir(), 'AppData', 'Roaming'))
    .replace(/%LOCALAPPDATA%/giu, () => join(homedir(), 'AppData', 'Local'))
    .replace(/\$env:LOCALAPPDATA\b/giu, () => join(homedir(), 'AppData', 'Local'))
}

/** Path-ish tokens of a command, for the confinement check. */
function pathTokensOf(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/(?:[A-Za-z]:[\\/]|\/|~[\\/]?|\.{1,2}[\\/])[^\s"'`,;)|&]+/gu)) out.push(match[0])
  return out
}

function isInsideWorkspace(target: string, workspace: string): boolean {
  if (workspace.length === 0) return false
  // A relative target is, by definition, relative to the session's directory.
  // `..` is not: it leaves the workspace, and "not provably inside" must not read
  // as "inside" for a recursive delete.
  if (!/^(?:[A-Za-z]:[\\/]|\/|~)/u.test(target)) return !/^\.\.[\\/]|^\.\.$/u.test(target)
  const normalize = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
  const normalizedTarget = normalize(target)
  const normalizedWorkspace = normalize(workspace)
  if (normalizedTarget.length === 0 || normalizedWorkspace.length === 0) return false
  return normalizedTarget === normalizedWorkspace || normalizedTarget.startsWith(`${normalizedWorkspace}/`)
}

export interface CommandVerdict {
  /** `deny` is enforced by the tool guard; `warn` is reported and allowed. */
  decision: 'deny' | 'warn'
  code: 'GLOBAL_SEARCH' | 'DESTRUCTIVE_COMMAND'
  reason: string
}

/**
 * v0.18: the RISK CLASS the scanner reports, separated from the DECISION the
 * policy makes about it.
 *
 * The audit's point was that a string matcher was doing two jobs at once: deciding
 * what a command IS, and deciding whether to block it. The first is evidence (and
 * regexes are fine for it); the second is policy, and policy belongs in one table
 * an operator can read and change. Splitting them is also what makes the modes
 * testable: `strict` and `autonomous` differ in the decision table only.
 */
export type CommandRisk = 'safe' | 'unknown' | 'destructive'

export interface CommandAssessment {
  risk: CommandRisk
  code?: 'GLOBAL_SEARCH' | 'DESTRUCTIVE_COMMAND'
  reason?: string
}

export type SafetyMode = 'strict' | 'balanced' | 'autonomous'
export type PolicyDecision = 'allow' | 'ask' | 'deny'

/**
 * The decision table, in one place.
 *
 * - `destructive` is denied in strict and balanced. In `autonomous` it becomes an
 *   ASK rather than an allow: a mode may lower the ceremony, but no mode silently
 *   executes an unbounded delete.
 * - `unknown` (a mutating verb we cannot prove is confined) is denied unless the
 *   operator chose `autonomous`. "Cannot prove it is fine" is not "fine".
 * - `safe` is allowed everywhere: a policy that blocks ordinary work is a policy
 *   that gets switched to `autonomous` and then protects nothing.
 */
export function policyDecision(risk: CommandRisk, mode: SafetyMode): PolicyDecision {
  if (risk === 'safe') return 'allow'
  if (risk === 'destructive') return mode === 'autonomous' ? 'ask' : 'deny'
  return mode === 'autonomous' ? 'allow' : 'deny'
}

/**
 * v0.18: classify a command by risk, without deciding what to do about it.
 *
 * Deliberately NOT a richer taxonomy: every extra class is a class someone must
 * keep calibrated, and the two that matter operationally are "provably confined"
 * and "provably unbounded". Everything else is `unknown`, and `unknown` fails
 * closed outside `autonomous`.
 */
export function classifyAgentCommand(command: string, workspace = ''): CommandAssessment {
  const raw = typeof command === 'string' ? command : ''
  if (raw.trim().length === 0) return { risk: 'safe' }
  const text = expandKnownRoots(raw)

  if (DESTRUCTIVE_VERB.test(text)) {
    const escaping = escapesWorkspace(text)
    const recursive = RECURSIVE_FLAG.test(text)
    const workspaceKnown = workspace.trim().length > 0
    const targets = pathTokensOf(text)
    const outsideWorkspace =
      workspaceKnown && targets.length > 0 && targets.every((target) => !isInsideWorkspace(target, workspace))
    if (escaping || (recursive && outsideWorkspace)) {
      return {
        risk: 'destructive',
        code: 'DESTRUCTIVE_COMMAND',
        reason:
          'DESTRUCTIVE_COMMAND：该命令是递归/强制的破坏性删除，且目标落在工作区之外或指向系统根目录。' +
          `当前工作区：${workspaceKnown ? workspace : '(未知)'}。` +
          '如果确实需要清理，请把目标限制在工作区内并给出确切路径（例如相对路径 .\\build），或让用户确认后手动执行。',
      }
    }
    // A destructive verb we cannot place: `rm -rf` with a relative bare name is
    // ordinary, `Remove-Item -Recurse <unknown absolute>` is not provable either way.
    if (recursive && !workspaceKnown) {
      return {
        risk: 'unknown',
        code: 'DESTRUCTIVE_COMMAND',
        reason: 'DESTRUCTIVE_COMMAND：无法确认目标是否在工作区内（工作目录未知），请给出确切路径或确认后执行。',
      }
    }
    return { risk: 'safe' }
  }

  if (SEARCH_VERB.test(text) && escapesWorkspace(text)) {
    return {
      risk: 'destructive',
      code: 'GLOBAL_SEARCH',
      reason:
        'GLOBAL_SEARCH：禁止针对盘符根目录 / AppData / 用户目录 / 全局根（如 rg / 、Get-ChildItem -Recurse）的搜索。' +
        `当前工作区：${workspace.trim().length > 0 ? workspace : '(未知)'}。` +
        '找不到文件时请只在当前目录用 ls / dir 查找，或直接询问用户；不要换写法重试、不要向外层目录扩散。',
    }
  }
  return { risk: 'safe' }
}

/**
 * @deprecated v0.18: kept because callers and tests name it, and because `deny`
 * remains its only verdict. New code asks `classifyAgentCommand` and lets the
 * configured `safetyMode` decide.
 */
export function scanAgentCommand(command: string, workspace = ''): CommandVerdict | undefined {
  const assessment = classifyAgentCommand(command, workspace)
  if (assessment.risk !== 'destructive' || assessment.reason === undefined) return undefined
  return { decision: 'deny', code: assessment.code ?? 'DESTRUCTIVE_COMMAND', reason: assessment.reason }
}

export interface CommandPolicyVerdict {
  risk: CommandRisk
  decision: PolicyDecision
  code?: 'GLOBAL_SEARCH' | 'DESTRUCTIVE_COMMAND'
  /** Present whenever the decision is not `allow`: the message the agent sees. */
  reason?: string
}

/**
 * v0.18: classify, then decide — the two jobs the string matcher used to do at once.
 *
 * v0.19: `ask` is no longer expressed as a refusal.
 *
 * The live contract settles what v0.18 could only work around: `tools/pre-execute`
 * is a waterfall whose decision is
 * `{kind:'allow'} | {kind:'deny', reason} | {kind:'cancel'} | {kind:'ask', reason?, displayReason?}`,
 * and "missing approval support turns `ask` into denial" — fail-closed for free.
 * `tools.guard()`, by contrast, can only return a denial string.
 *
 * So the two decisions use the two channels they belong to: `deny` goes to the
 * guard (monotonic: no later guard can force-allow it), and `ask` goes to the
 * waterfall as a real approval prompt. Collapsing the two into "deny with an
 * instruction to ask the user" made the user do the plugin's job.
 */
export function evaluateCommandPolicy(
  command: string,
  workspace = '',
  mode: SafetyMode = 'balanced',
): CommandPolicyVerdict {
  const assessment = classifyAgentCommand(command, workspace)
  const decision = policyDecision(assessment.risk, mode)
  if (decision === 'allow') {
    return {
      risk: assessment.risk,
      decision,
      ...(assessment.code === undefined ? {} : { code: assessment.code }),
    }
  }
  if (decision === 'deny') {
    return {
      risk: assessment.risk,
      decision,
      ...(assessment.code === undefined ? {} : { code: assessment.code }),
      reason:
        assessment.reason ??
        `该命令无法被证明是安全的（risk=${assessment.risk}，safetyMode=${mode}），已拒绝执行。`,
    }
  }
  return {
    risk: assessment.risk,
    decision,
    ...(assessment.code === undefined ? {} : { code: assessment.code }),
    reason:
      `${assessment.reason ?? `该命令风险等级为 ${assessment.risk}。`}` +
      `（safetyMode=${mode}：此类命令不会被自动放行，需要用户当场确认。）`,
  }
}

/**
 * v0.14 D1/D6: the command scanner, the enforcement point of both the workspace
 * red line and the destructive-command rule.
 *
 * Deliberately NOT "no C:\ paths": reading `C:\Users\<user>\.dsh\...` is ordinary
 * work, and a guard that denies it will be switched off within a day. What is
 * denied is the SWEEP (a search verb aimed at a root / system directory) and the
 * UNBOUNDED DELETE (a destructive verb combined with recursion, aimed at a root
 * or at something that is not provably inside the session's workspace).
 */
/**
 * v0.14 D5: process-level lock reclamation.
 *
 * The lock is a directory with an `owner` file (token + pid + lease). The normal
 * paths already steal a lock after `staleMs`, but a crashed writer leaves the
 * directory behind until SOMEONE contends for it — and a state file nobody is
 * writing right now is exactly when no one contends. So activation sweeps them.
 *
 * Safety rule: a lock whose owner pid is ALIVE is never touched, no matter how
 * old. Removing a live holder's lock is how two writers end up on one ledger.
 */
export interface LockEntry {
  path: string
  label: string
  pid?: number
  alive?: boolean
  ageMs: number
  action: 'kept' | 'reclaimed' | 'kept-unknown'
}

export function scanAndReclaimLocks(dirs: readonly string[], dryRun = false): LockEntry[] {
  const out: LockEntry[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir.length === 0) continue
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.lock')) continue
      const path = join(dir, name)
      if (seen.has(path)) continue
      seen.add(path)
      let ageMs = 0
      try {
        ageMs = Date.now() - statSync(path).mtimeMs
      } catch {
        continue
      }
      const owner = (() => {
        try {
          const parsed = JSON.parse(readFileSync(join(path, 'owner'), 'utf8')) as { pid?: number }
          return Number.isFinite(Number(parsed?.pid)) ? Number(parsed.pid) : undefined
        } catch {
          return undefined
        }
      })()
      const alive = owner === undefined ? undefined : isProcessAlive(owner)
      const label = name.replace(/\.lock$/u, '')
      if (alive === true) {
        out.push({ path, label, pid: owner, alive, ageMs, action: 'kept' })
        continue
      }
      // A live holder is sacred; a dead one is debris. With no pid at all, only an
      // obviously abandoned directory (older than the stale window) is removed.
      const reclaim = alive === false || (owner === undefined && ageMs > LOCK_STALE_MS)
      if (!reclaim) {
        out.push({ path, label, ...(owner === undefined ? {} : { pid: owner }), alive, ageMs, action: 'kept-unknown' })
        continue
      }
      if (!dryRun) {
        try {
          rmSync(path, { recursive: true, force: true })
        } catch (error) {
          out.push({ path, label, ...(owner === undefined ? {} : { pid: owner }), alive, ageMs, action: 'kept-unknown' })
          continue
        }
        appendGraftAudit({
          at: new Date().toISOString(),
          kind: 'lock-reclaimed',
          file: label,
          ...(owner === undefined ? {} : { detail: `owner pid ${owner} is gone; reclaimed at activation` }),
          ...(owner === undefined ? { detail: `no owner pid; abandoned for ${Math.round(ageMs / 1000)}s` } : {}),
        })
      }
      out.push({ path, label, ...(owner === undefined ? {} : { pid: owner }), alive, ageMs, action: 'reclaimed' })
    }
  }
  return out
}

/** Is this pid a live process we are not allowed to signal? EPERM means "alive". */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as any)?.code === 'EPERM'
  }
}

/**
 * The working directory of an agent, for the confinement half of the guard.
 *
 * `workingDirectory.get(session)` is the host's own answer (it owns the effective
 * directory, including a user's later `cd`); the session header is the durable
 * fallback. An empty result is honest — the caller then skips the
 * "outside the workspace" rule instead of guessing a boundary.
 */
function workspaceOfAgent(ctx: PluginContextLike, agentId: string): string {
  if (typeof agentId !== 'string' || agentId.length === 0) return ''
  try {
    const session = ctx.get?.('sessions')?.get?.(agentId)
    if (session === undefined || session === null) return ''
    const wd = ctx.get?.('workingDirectory')
    if (isRecord(wd) && typeof wd.get === 'function') {
      const value = wd.get(session)
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    const header = (session as any)?.header
    if (isRecord(header) && typeof header.cwd === 'string' && header.cwd.trim().length > 0) return header.cwd.trim()
    const direct = (session as any)?.cwd
    return typeof direct === 'string' ? direct.trim() : ''
  } catch {
    return ''
  }
}

/** Where the debug panel reads the memory store from (never written by us). */
function resolveMemoryPaths(settings: Required<GraftConfig>): { memoryDir: string; skillsDir: string } {
  const memoryDir = settings.memoryDir.length > 0 ? settings.memoryDir : join(dirname(retiredStorePath), '.dsh-memory')
  const skillsDir = settings.skillsDir.length > 0 ? settings.skillsDir : join(homedir(), '.agents', 'skills')
  return { memoryDir, skillsDir }
}

export interface DebugStatusInput {
  sessionId?: string
  workspace?: string
  section?: 'all' | 'watermark' | 'locks' | 'memory'
  watermark?: TokenWatermark
  settings: Required<GraftConfig>
  generation?: number
  graceTurnsRemaining?: number
  locks?: readonly LockEntry[]
  /** v0.14 D5: what the activation sweep found and did. */
  lockCleanup?: readonly LockEntry[]
  retired?: readonly string[]
  transferred?: ReadonlyArray<{ id: string; newSessionId: string; at: number }>
  targets?: ReadonlyArray<{ id: string; generation: number; sourceSessionId: string; createdAt: number }>
  txns?: ReadonlyArray<{ name: string; state?: string; sourceSessionId?: string; targetSessionId?: string; updatedAt?: string }>
  memory?: { memoryDir: string; skillsDir: string }
}

/**
 * v0.14: the debug panel payload. Pure: every fact is passed in, so the same
 * function serves the tool (live data) and `scripts/debug-status.mjs` (disk only).
 */
export function collectDebugStatus(input: DebugStatusInput): Record<string, unknown> {
  const section = input.section ?? 'all'
  const settings = input.settings
  const out: Record<string, unknown> = { ok: true, section }

  if (section === 'all' || section === 'watermark') {
    const watermark = input.watermark
    // v0.18: the two ratios are DERIVED, so the panel reports the derivation as
    // well as the numbers — "why did the cutoff move to 0.61?" is answered here.
    const thresholds = effectiveWatermarks(settings, watermark)
    const warnAt = thresholds.warnAt
    const hardAt = thresholds.hardAt
    out.watermark = watermark === undefined
      ? {
          available: false,
          reason: 'no live session or no usage/context record for it',
          warnAt,
          hardAt,
          watermarkMode: thresholds.mode,
          thresholdReason: thresholds.reason,
        }
      : {
          available: true,
          tokens: watermark.tokens,
          contextWindow: watermark.contextWindow,
          ratio: Number(watermark.ratio.toFixed(4)),
          percent: Number((watermark.ratio * 100).toFixed(2)),
          source: watermark.source,
          warnAt,
          hardAt,
          watermarkMode: thresholds.mode,
          estimatedGraftCost: thresholds.estimatedGraftCost,
          safeCeiling: thresholds.safeCeiling,
          feasible: thresholds.feasible,
          thresholdReason: thresholds.reason,
          toWarnRatio: Number((warnAt - watermark.ratio).toFixed(4)),
          toWarnTokens: Math.max(0, Math.round(watermark.contextWindow * (warnAt - watermark.ratio))),
          toHardRatio: Number((hardAt - watermark.ratio).toFixed(4)),
          toHardTokens: Math.max(0, Math.round(watermark.contextWindow * (hardAt - watermark.ratio))),
          state:
            watermark.ratio >= hardAt
              ? 'over-hard-cutoff'
              : watermark.ratio >= warnAt
                ? 'over-warn-line'
                : 'below-warn-line',
        }
    out.chain = {
      generation: input.generation ?? 0,
      graceTurns: GRAFT_CHAIN_GRACE_TURNS,
      graceTurnsRemaining: input.graceTurnsRemaining ?? 0,
      reGraftBlocked: (input.graceTurnsRemaining ?? 0) > 0,
    }
  }

  if (section === 'all' || section === 'locks') {
    const entries = input.locks ?? []
    out.locks = {
      held: entries.map((entry) => ({
        label: entry.label,
        path: entry.path,
        pid: entry.pid ?? null,
        alive: entry.alive ?? null,
        ageMs: entry.ageMs,
        action: entry.action,
      })),
      reclaimedAtActivation: (input.lockCleanup ?? []).filter((entry) => entry.action === 'reclaimed').map((entry) => entry.label),
    }
    out.transactions = {
      pending: (input.txns ?? []).map((txn) => ({ ...txn })),
      retiredCount: (input.retired ?? []).length,
      retiredRecent: (input.retired ?? []).slice(-10),
      transferredCount: (input.transferred ?? []).length,
      graftTargetsCount: (input.targets ?? []).length,
      graftTargetsRecent: (input.targets ?? []).slice(-10).map((target) => ({
        id: target.id,
        generation: target.generation,
        sourceSessionId: target.sourceSessionId,
        createdAt: new Date(target.createdAt).toISOString(),
      })),
    }
  }

  if (section === 'all' || section === 'memory') {
    out.memory = input.memory === undefined
      ? { available: false, reason: 'memoryDir/skillsDir not resolvable' }
      : collectMemoryStoreStatus(input.memory.memoryDir, input.memory.skillsDir, input.workspace)
  }
  return out
}

/**
 * v0.14: read the memory store read-only, and — with `workspace` — say which
 * records are "dirty" from that workspace's point of view: written elsewhere, or
 * written with no provenance at all (the records the isolation gate refuses).
 */
export function collectMemoryStoreStatus(
  memoryDir: string,
  skillsDir: string,
  workspace?: string,
): Record<string, unknown> {
  const wanted = typeof workspace === 'string' ? workspace.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase() : ''
  const readJsonl = (file: string): Array<Record<string, unknown>> => {
    try {
      return readFileSync(join(memoryDir, file), 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {
            return undefined
          }
        })
        .filter((record): record is Record<string, unknown> => record !== undefined)
    } catch {
      return []
    }
  }
  const classify = (records: Array<Record<string, unknown>>): { matched: number; foreign: number; unscoped: number; dirty: Array<Record<string, unknown>> } => {
    if (wanted.length === 0) return { matched: 0, foreign: 0, unscoped: 0, dirty: [] }
    let matched = 0
    let foreign = 0
    let unscoped = 0
    const dirty: Array<Record<string, unknown>> = []
    for (const record of records) {
      const scope = String(record.scope ?? '').toLowerCase()
      const recorded = String(record.workspace ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
      if (scope === 'global') continue
      if (recorded.length === 0) {
        unscoped += 1
        if (dirty.length < 10) dirty.push({ kind: record.kind ?? 'record', reason: 'no workspace recorded (legacy)', text: String(record.text ?? record.symptom ?? '').slice(0, 80) })
        continue
      }
      if (recorded === wanted) matched += 1
      else {
        foreign += 1
        if (dirty.length < 10) dirty.push({ kind: record.kind ?? 'record', reason: `recorded in ${record.workspace}`, text: String(record.text ?? record.symptom ?? '').slice(0, 80) })
      }
    }
    return { matched, foreign, unscoped, dirty }
  }

  const skills: Array<{ name: string; scope: string; workspace: string }> = []
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(skillsDir, entry.name, 'SKILL.md')
      try {
        const text = readFileSync(path, 'utf8')
        skills.push({
          name: entry.name,
          scope: (text.match(/^scope:\s*(.+)$/mu)?.[1] ?? 'project').trim().toLowerCase(),
          workspace: (text.match(/^workspace:\s*(.+)$/mu)?.[1] ?? '').trim(),
        })
      } catch {
        // A skill directory without a readable SKILL.md is not a skill.
      }
    }
  } catch {
    // An absent skills directory means "no skills yet", not a failure.
  }

  const negatives = readJsonl('negatives.jsonl').map((record) => ({ ...record, kind: 'negative' }))
  const facts = readJsonl('facts.jsonl').map((record) => ({ ...record, kind: 'fact' }))
  const experiences = readJsonl('experiences.jsonl').map((record) => ({ ...record, kind: 'experience' }))
  const suggestions = readJsonl('suggestions.jsonl')

  const skillScope = (scope: string): boolean => scope === 'global'
  const skillDirty = (skill: { name: string; scope: string; workspace: string }): boolean => {
    if (wanted.length === 0) return false
    if (skillScope(skill.scope)) return false
    const recorded = skill.workspace.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
    return recorded !== wanted
  }
  const dirtySkills = wanted.length === 0 ? [] : skills.filter(skillDirty)

  return {
    available: true,
    memoryDir,
    skillsDir,
    counts: {
      skills: skills.length,
      negatives: negatives.length,
      facts: facts.length,
      experiences: experiences.length,
      suggestions: suggestions.length,
    },
    // Without a workspace this is a plain inventory; with one, "dirty" means
    // "this record would be REFUSED by the isolation gate for this workspace".
    ...(wanted.length === 0
      ? {}
      : {
          workspace: wanted,
          skillsInWorkspace: {
            matched: skills.length - dirtySkills.length,
            dirty: dirtySkills.length,
            unscoped: skills.filter((skill) => skill.scope !== 'global' && skill.workspace.trim().length === 0).length,
            dirtyList: dirtySkills.slice(0, 10).map((skill) => ({ name: skill.name, reason: skill.workspace.trim().length === 0 ? 'no workspace recorded (legacy)' : `recorded in ${skill.workspace}` })),
          },
          negativeRecords: classify(negatives),
          factRecords: classify(facts),
          experienceRecords: classify(experiences),
        }),
  }
}

// ===========================================================================
// v0.16 CONSOLE — live configuration and status for the Web panel
// ===========================================================================

/**
 * The keys the console may write. A whitelist, not "any key": the console's job
 * is to make the common knobs reachable without hand-editing, not to become a
 * general config editor that can silently produce an invalid patch.
 */
export const CONSOLE_BOOLEAN_KEYS = ['modelDrivenGraft', 'autoGraft', 'workspaceRedline', 'commandGuard', 'igniteTarget'] as const
export const CONSOLE_RATIO_KEYS = ['modelDrivenGraftAtRatio', 'autoGraftAtRatio'] as const
/**
 * v0.18: the enumerated knobs. Adding them here is what keeps the v0.18 policy and
 * watermark modes switchable from the panel — a mode that can only be changed by
 * editing YAML is a mode that stays at its default for everyone.
 */
export const CONSOLE_ENUM_KEYS: Readonly<Record<string, readonly string[]>> = {
  safetyMode: ['strict', 'balanced', 'autonomous'],
  watermarkMode: ['fixed', 'dynamic'],
  ignitionMode: ['queue', 'steer'],
}
/** v0.18: the integer knobs, with the range a value must fall in. */
export const CONSOLE_INTEGER_KEYS: Readonly<Record<string, { min: number; max: number }>> = {
  growthTokensPerTurn: { min: 0, max: 100_000 },
  growthReserveTurns: { min: 0, max: 50 },
  constraintBudgetChars: { min: 500, max: 200_000 },
}

export const CONSOLE_WRITABLE_KEYS: readonly string[] = [
  ...CONSOLE_BOOLEAN_KEYS,
  ...CONSOLE_RATIO_KEYS,
  ...Object.keys(CONSOLE_ENUM_KEYS),
  ...Object.keys(CONSOLE_INTEGER_KEYS),
]

export interface ConsoleSetting {
  key: string
  value: boolean | number | string
}

/**
 * Parse one `key value` line from the console or a slash command.
 *
 * Returns a reason instead of throwing: the caller is a UI button, and "why did
 * nothing happen" has to be printable.
 */
export function parseConsoleSetting(rawInput: string): { setting: ConsoleSetting; error?: never } | { setting?: never; error: string } {
  const parts = String(rawInput ?? '').trim().split(/\s+/u).filter((part) => part.length > 0)
  if (parts.length < 2) {
    return { error: `需要两个参数：<key> <value>；可写键：${CONSOLE_WRITABLE_KEYS.join(', ')}` }
  }
  const key = parts[0]
  const raw = parts[1].toLowerCase()
  if ((CONSOLE_BOOLEAN_KEYS as readonly string[]).includes(key)) {
    if (raw !== 'true' && raw !== 'false') return { error: `${key} 只接受 true / false（收到 ${parts[1]}）` }
    return { setting: { key, value: raw === 'true' } }
  }
  if ((CONSOLE_RATIO_KEYS as readonly string[]).includes(key)) {
    const value = Number(raw)
    // The ratio is a fraction of the window. Above the hard cutoff nothing would
    // ever migrate; at zero every request would, which is indistinguishable from
    // a crash loop. Both ends are refused rather than "clamped silently".
    if (!Number.isFinite(value) || value <= 0 || value >= 1) return { error: `${key} 必须是 0 与 1 之间的小数（例如 0.70）` }
    return { setting: { key, value: Math.round(value * 100) / 100 } }
  }
  const allowed = CONSOLE_ENUM_KEYS[key]
  if (allowed !== undefined) {
    if (!allowed.includes(raw)) return { error: `${key} 只接受 ${allowed.join(' / ')}（收到 ${parts[1]}）` }
    return { setting: { key, value: raw } }
  }
  const range = CONSOLE_INTEGER_KEYS[key]
  if (range !== undefined) {
    const value = Number(raw)
    if (!Number.isFinite(value) || !Number.isInteger(value)) return { error: `${key} 必须是整数（收到 ${parts[1]}）` }
    if (value < range.min || value > range.max) return { error: `${key} 必须在 ${range.min} 与 ${range.max} 之间（收到 ${value}）` }
    return { setting: { key, value } }
  }
  return { error: `未知的配置键 ${key}；可写键：${CONSOLE_WRITABLE_KEYS.join(', ')}` }
}

/**
 * Pure patch builder for `configEditor.edit`: the `current` object is the row's
 * raw override and a matching override REPLACES the whole config, so spreading it
 * is what keeps the keys the console does not manage.
 */
export function withConsoleSetting(
  current: Record<string, unknown>,
  setting: ConsoleSetting,
): Record<string, unknown> {
  return { ...current, [setting.key]: setting.value }
}

/**
 * The plugin id used to find our own Loader row. The override must be written to
 * the SAME row the profile patch declares, or the console would create a second
 * row and the value would fight the patch layer.
 */
export const CONSOLE_PATCH_ID = 'dsh-graft-slice'

export interface ConsoleRow {
  sessionId: string
  cwd: string
  tokens: number
  contextWindow: number
  percent: number
  source: string
  /** Tokens still available before the nudge / before the hard cutoff. */
  toWarnTokens: number
  toHardTokens: number
  state: string
  generation: number
  graceTurnsRemaining: number
  /** v0.18: the ratios THIS row was judged by (derived, not configured). */
  warnAt: number
  hardAt: number
}

export interface GraftConsoleState {
  config: {
    modelDrivenGraft: boolean
    autoGraft: boolean
    modelDrivenGraftAtRatio: number
    autoGraftAtRatio: number
    workspaceRedline: boolean
    commandGuard: boolean
    graftTargetGraceTurns: number
    /** v0.18: which table the command guard uses, and how the ratios are derived. */
    safetyMode: SafetyMode
    watermarkMode: 'fixed' | 'dynamic'
    constraintBudgetChars: number
    growthTokensPerTurn: number
    growthReserveTurns: number
    /** v0.19: physical ignition, and how its prompt is admitted. */
    igniteTarget: boolean
    ignitionMode: 'queue' | 'steer'
  }
  /**
   * v0.19: targets that are durable but were NOT started (no channel, or a failed
   * call). The panel must be able to answer "did the new session wake up?".
   */
  pendingIgnitions: Array<{ targetId: string; sourceSessionId: string; attempts: number; at: number }>
  /**
   * v0.18: what a handoff costs in THIS session, and the pair that follows from it.
   * Present even when no session is live (it is priced off the configured window),
   * so the panel can explain the numbers before there is anything to plot.
   */
  thresholds: WatermarkThresholds & { estimate: GraftCostEstimate | null }
  rows: ConsoleRow[]
  /**
   * v0.28 P0 — EVERY LIVE SESSION, INDEPENDENT OF WHETHER IT HAS A WATERMARK.
   *
   * `rows` only contains sessions with a measurable token watermark, because a row
   * without a percentage cannot be plotted. The panel used `rows.length === 0` as its
   * definition of "no active session", so on any host where `readTokenWatermark`
   * returns undefined — a fresh build, a session that has not sent a message yet,
   * a provider that does not report usage — the panel concluded there was nothing
   * open and offered no selector at all.
   *
   * The client cannot fix that: it has no way to enumerate sessions (the CLIENT
   * `sessions` service has no `list()`, and `useSessions` returns only what the owner
   * chose to project). The HOST has `sessions.list()`, so the list is produced HERE and
   * shipped with the state.
   */
  sessions: Array<{ sessionId: string; cwd: string; hasWatermark: boolean }>
  generatedAt: string
}

export function apply(ctx: PluginContextLike, config: GraftConfig = {}): void {
  const settings = normalizeConfig(config)
  configureRetiredStore(ctx, settings)
  // v0.14 D5: reclaim locks left by dead processes BEFORE anything reads state.
  // A crashed writer's `.lock` directory is invisible until someone contends for
  // that file, and a clean start contends for nothing.
  try {
    lastLockCleanup = scanAndReclaimLocks([dirname(retiredStorePath), PLUGIN_DIR])
    const reclaimed = lastLockCleanup.filter((entry) => entry.action === 'reclaimed')
    if (reclaimed.length > 0) {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] reclaimed ${reclaimed.length} dead lock(s): ${reclaimed.map((entry) => entry.label).join(', ')}`,
      )
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-graft-slice] lock sweep failed: ${String((error as any)?.message ?? error)}`)
  }
  // v7.0: the chain guard must survive a restart, so its marks are durable.
  loadGraftTargetStore(ctx)
  // v1.1: so must the follower pointer — a restart must not orphan an observer.
  loadObserverBindings(ctx)
  // v7.2: so must the compaction shield. A section that only exists in memory
  // disappears on restart, leaving the constraints reachable by `/compact`.
  loadConstraintSections(ctx)
  loadPendingConstraints(ctx)
  // v0.19: ignition intents a crash (or a missing channel) left behind. Consumed
  // below, once the services this needs are actually resolvable.
  loadPendingIgnitions(ctx)
  loadDrafts(ctx)
  loadLeftovers(ctx)
  loadAutoGraftSuppression()
  // v7.4 P0-2: roll back migrations that never reached COMMITTED.
  //
  // Runs AFTER the retired/transferred stores are loaded, because rollback must
  // know whether the interrupted migration had already retired its source. It
  // runs on every activation, and is idempotent: a clean start finds no records.
  try {
    const recovery = recoverGraftTransactions(ctx)
    lastRecovery = recovery
    if (recovery.scanned > 0) {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] transaction recovery: scanned ${recovery.scanned}, rolled back ${recovery.rolledBack.length}` +
          (recovery.rolledBack.length > 0 ? ` (${recovery.rolledBack.join(', ')})` : ''),
      )
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-graft-slice] transaction recovery failed: ${String((error as any)?.message ?? error)}`)
  }
  // v7.4 P4-3: archived forks are invisible until someone announces them.
  void registerArchivedForks(ctx, settings).catch((error) => {
    ctx.logger?.warn?.(
      `[dsh-graft-slice] archived-fork registration failed: ${String((error as any)?.message ?? error)}`,
    )
  })
  // v0.19: retry what a crash or a missing channel left un-ignited. Fire-and-forget:
  // activation must not wait on another session's agent resuming, and the durable
  // queue means a second failure is simply retried on the next start.
  void resumePendingIgnitions(ctx, settings)
    .then((results) => {
      const failed = results.filter((item) => !item.ok)
      if (failed.length > 0) {
        ctx.logger?.warn?.(
          `[dsh-graft-slice] ignition retry: ${failed.length} target(s) still not started ` +
            `(${failed.map((item) => `${item.targetId}: ${item.reason ?? 'unknown'}`).join('; ')})`,
        )
      }
    })
    .catch((error) => {
      ctx.logger?.warn?.(`[dsh-graft-slice] ignition retry failed: ${String((error as any)?.message ?? error)}`)
    })
  const captured = new Map<string, unknown>()
  for (const service of ['sessionPersistence', 'workspaceRegistry', 'paths', 'sessionQuery', 'sessions', 'agents']) {
    try {
      captured.set(service, ctx.get(service))
    } catch {
      // Optional service or inactive proxy.
    }
  }
/**
 * Background LLM refinement of the fast regex constraints.
 *
 * Never throws: a failure leaves the regex constraints in place, which is a
 * quality regression at worst, not a broken migration. The result is queued
 * for the target's next pre-step rather than appended now, because the target
 * is a detached artifact at this point — there is no live session to append to.
 */
async function refineConstraintsInBackground(
  ctx: PluginContextLike,
  settings: Required<GraftConfig>,
  sourceSessionId: string,
  targetSessionId: string,
  events: readonly SessionEventLike[],
): Promise<void> {
  if (constraintsInFlight.has(targetSessionId)) return
  constraintsInFlight.add(targetSessionId)
  try {
    const result = await llmExtractConstraints(ctx, events, settings)
    if (result.source !== 'llm' || result.constraints.length === 0) return
    // The fast regex set is already in the target's system head. Replacing it
    // with a shorter LLM set silently drops rules the user never revoked, so
    // the two are unioned instead: LLM adds precision, regex keeps coverage.
    const baseline = extractConstraints(events)
    const merged: string[] = []
    for (const item of [...result.constraints, ...baseline]) {
      const normalized = item.replace(/\s+/gu, ' ').trim()
      if (normalized.length === 0) continue
      if (merged.some((existing) => nearDuplicate(existing, normalized))) continue
      merged.push(normalized)
    }
    if (result.constraints.length < baseline.length) {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] LLM returned ${result.constraints.length} constraint(s) but regex found ${baseline.length}; keeping the union`,
      )
    }
    // v7.0 (adopted from dsh-rollover-snapshot): verify the generation-to-
    // generation handoff instead of trusting the builder.
    //
    // The union above is a local guarantee: it cannot lose a rule that the
    // regex extractor still finds. It says nothing about the set that was
    // *already committed to the target's goal message* a moment earlier. If a
    // config change, a preset, or a differently-shaped refinement produces a
    // narrower set than the one already injected, the target ends up carrying
    // fewer rules than its own first message claimed, and nothing would notice.
    //
    // rollover-snapshot measured exactly this: every crossing lost rules while
    // the checkpoint grew. The comparison is cheap and independent, so it runs
    // on every refinement.
    const drift = verifyHardConstraints(baseline, merged, sourceSessionId)
    if (drift.length > 0) {
      for (const item of drift) {
        ctx.logger?.warn?.(
          `[dsh-graft-slice] constraint drift: "${item.constraint}" was declared in ${item.previousSessionId} but is absent from the refined set`,
        )
      }
    }
    pendingConstraints.set(targetSessionId, {
      sourceSessionId,
      targetSessionId,
      constraints: merged,
      source: 'llm',
      extractedAt: Date.now(),
    })
    persistPendingConstraints(ctx)
    ctx.logger?.info?.(
      `[dsh-graft-slice] async constraints ready for ${targetSessionId}: ${result.constraints.length} item(s)`,
    )
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-graft-slice] async constraint extraction failed: ${String((error as any)?.message ?? error)}`)
  } finally {
    constraintsInFlight.delete(targetSessionId)
  }
}

/**
 * v6.0 补丁一：拦截旧会话前，把用户正在输入的内容存下来。
 *
 * 只在真正会 reject 的分支调用。空文本、已捕获过的来源都不重复写。
 */
function captureDraft(ctx: PluginContextLike, sourceId: string, targetId: string, messages: unknown): void {
  // v6.4 F2: this was `isRecord(ctx) === false && false` — always false, so the
  // guard never fired and the "defence" was decorative. It must reject a missing
  // context, which is what the intent always was.
  if (isRecord(ctx) === false) return
  const text = lastUserText(messages)
  if (text === undefined) return
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  // v7.0 P1-4: a steering word is not a draft.
  //
  // The draft channel exists to save something the user was TYPING when the
  // session was cut off — an unfinished thought. In confirm mode the message
  // that triggers the migration is literally "确认". Carrying that into the
  // target produces a session whose first message is
  //
  //   [系统提示：用户在上一个会话被拦截前，正在输入：「确认」]
  //   [用户新输入：「继续。」]
  //
  // which reads as the user having asked for the same thing twice, and trains
  // them to ignore the notice. Same rule as the goal extractor: a bare
  // acknowledgement or a slash command carries steering, not content.
  if (isSteeringOnly(trimmed)) return
  const existing = draftPayloads.get(targetId)
  if (existing !== undefined && existing.text === trimmed) return
  draftPayloads.set(targetId, {
    sourceSessionId: sourceId,
    targetSessionId: targetId,
    text: trimmed,
    capturedAt: Date.now(),
  })
  try {
    mkdirSync(dirname(draftsPath), { recursive: true })
    writeJsonAtomic(draftsPath, [...draftPayloads.values()])
  } catch {
    // A failed capture must never block the rejection itself.
  }
}

/**
 * v7.0 P1-4: whether a message is only steering.
 *
 * Deliberately narrow. It matches a short message (<= 12 chars after trimming
 * trailing punctuation) whose entire content is an acknowledgement, a
 * continuation, or a slash command. Anything longer is real content even if it
 * opens with "好，" — a user who writes "好，但是别动 JSX" is asking for
 * something, and dropping it would lose a constraint.
 */
function isSteeringOnly(text: string): boolean {
  const compact = text.replace(/[\s。.!！?？,，、~～]+$/gu, '').trim()
  if (compact.length === 0) return true
  if (compact.startsWith('/')) return true
  if (compact.length > 12) return false
  return /^(请?继续|继续吧?|好的?|可以|行|嗯+|是|对|确认|确定|同意|开始|ok|okay|yes|y|sure|go|proceed|continue|doit)$/iu.test(
    compact,
  )
}

/**
 * v6.0 补丁一：把草稿和 target 的新输入合并成一条消息，然后删除草稿。
 *
 * 只生效一次：拿到就删，避免用户每轮都看到同一段旧草稿。
 */
function takeDraftMerge(agentId: string, messages: unknown): { messages: any[] } | undefined {
  const draft = draftPayloads.get(agentId)
  if (draft === undefined) return undefined
  draftPayloads.delete(agentId)
  persistDrafts(ctx)
  const current = lastUserText(messages) ?? ''
  const merged = [
    `[系统提示：用户在上一个会话被拦截前，正在输入：「${draft.text}」]`,
    `[用户新输入：「${current.trim().length === 0 ? '继续' : current.trim()}」]`,
    '',
    '请把这两段当成同一个连续意图来处理。',
  ].join('\n')
  const injected = {
    id: `graft-draft-${agentId}` as any,
    role: 'user',
    content: [{ type: 'text', text: merged }],
    source: { kind: 'user' },
  }
  return { messages: [injected] }
}

/**
 * Inject queued constraints into the target exactly once.
 *
 * The message goes in as `developer/message` — a system-level instruction the
 * UI renders as context, not as conversation — so the user's next prompt is
 * not preceded by a wall of policy text they did not write.
 */
/**
 * v5.2 补丁二：把后台提取的约束注入 target 的下一轮。
 *
 * 走的是 DSH 自己的注入通道——`agent/pre-step` 返回的 `messages`，与
 * `dsh-session-reference` 注入跨会话快照的方式一致。写日志事件会撞上 v4 的
 * step 序号约束（自己开 step 会让 agent loop 的 step/start 被拒），而
 * `messages` 只影响这一次请求，不改持久化生命周期。
 *
 * 返回追加的消息数组；调用方把它拼进 pre-step 的结果。
 */
function takePendingConstraintMessages(agentId: string): any[] {
  if (constraintsApplied.has(agentId)) return []
  const payload = pendingConstraints.get(agentId)
  if (payload === undefined || payload.constraints.length === 0) return []
  constraintsApplied.add(agentId)
  pendingConstraints.delete(agentId)
  persistPendingConstraints(ctx)
  ctx.logger?.info?.(`[dsh-graft-slice] injecting ${payload.constraints.length} async constraint(s) into ${agentId}`)
  return [
    {
      id: `graft-constraints-${agentId}` as any,
      // Pre-step messages are projected as user/message, and DSH requires the
      // developer role to travel with a developer/message event instead. A user
      // message carrying an explicit system-note header is the shape a pre-step
      // listener can legitimately deliver.
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            '[系统提示] 这个会话从旧会话继承了以下长期约束，请在整个会话中遵守：',
            ...payload.constraints.map((item, index) => `${index + 1}. ${item}`),
          ].join('\n'),
        },
      ],
      source: { kind: 'user' },
    },
  ]
}

  const stableCtx = {
    ...ctx,
    get(name: string) {
      const cached = captured.get(name)
      if (cached !== undefined) return cached
      // Late-bound services (for example workspaceRegistry, which activates
      // after sessionPersistence) were absent when this closure was built.
      // Fall back to the live context so the auto path sees the same services
      // the manual tool path sees.
      try {
        return (ctx as any).get(name)
      } catch {
        return undefined
      }
    },
    sessions: ctx.sessions,
    sessionQuery: captured.get('sessionQuery') ?? (ctx as any).sessionQuery,
    logger: ctx.logger,
  } as PluginContextLike
  if (settings.autoGraft && settings.autoGraftKeepAliveMs > 0) {
    // Headless drivers may tear down immediately after turn/end; this keeps
    // the event loop long enough for the asynchronous graft to finish.
    setTimeout(() => {}, settings.autoGraftKeepAliveMs)
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
function validateAppendIsLifecycleSafe(
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
function openStepOf(events: readonly any[]): { turn: number; step: number } | undefined {
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
function continuationTitle(targetTitle: string | undefined, targetId: string): string {
  const head = (targetTitle ?? '').replace(/^\[接续\]\s*/u, '').trim()
  if (head.length === 0) return `[接续] → ${targetId}`
  return `[接续] ${head}`
}

async function appendTransitionCard(
  agentId: string,
  targetId: string,
  targetTitle?: string,
): Promise<void> {
  if (transitionCards.has(agentId)) return
  try {
    const sessions = ctx.get('sessions')
    const live = isRecord(sessions) && typeof sessions.get === 'function' ? sessions.get(agentId) : undefined
    if (!isRecord(live) || typeof live.snapshotEvents !== 'function' || typeof live.append !== 'function') return

    const events = Array.from(live.snapshotEvents(0) as readonly any[])

    // Rule 2: no open step means no card. Never fabricate one.
    const open = openStepOf(events)
    if (open === undefined) return

    // v7.0 B4: the card is a door sign, not a report.
    //
    // The old card listed the timestamp, what was preserved, and a "please go to
    // the new session" line — three facts the reader did not need, wrapped around
    // the one they did. It also read as a system notice, which is exactly the
    // "handoff paper" feel this release is trying to remove.
    //
    // What a person returning to this window needs is: (1) this window is spent,
    // (2) where the work continued. Everything else is noise inside a window that
    // can no longer accept input anyway.
    const card = {
      type: 'developer/message',
      data: {
        turn: open.turn,
        step: open.step,
        message: {
          id: `graft-transition-${agentId}` as any,
          role: 'developer',
          content: [
            {
              type: 'text',
              text: ['任务已无缝流转至新窗口，请前往继续。', '', `→ ${targetId}`].join('\n'),
            },
          ],
          source: { kind: 'system-prompt' },
        },
      },
    }
    // Rule 4: refuse the write if the projected sequence would be illegal.
    const safety = validateAppendIsLifecycleSafe(events, card)
    if (!safety.ok) {
      ctx.logger?.warn?.(`[dsh-graft-slice] transition card skipped: ${safety.reason}`)
      return
    }

    live.append('developer/message', card.data, { surfaceOp: 'append' })
    // v7.0 B4: the sidebar title stays a continuation of the SAME task rather
    // than announcing an administrative event. "已交接" told the user a system
    // thing happened; the goal head tells them what they were doing.
    live.append('session/title', {
      title: continuationTitle(targetTitle, targetId),
      messageSeqs: [],
      source: { kind: 'user' },
    })
    await sessions.flush?.(live)
    transitionCards.add(agentId)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-graft-slice] transition card failed: ${String((error as any)?.message ?? error)}`)
  }
}


  ctx.on(PRE_STEP_EVENT, async (payload: any, next: any) => {
    let agentId = payload?.agent?.id
    if (typeof agentId !== 'string') {
      const agents = ctx.get('agents')
      const current = isRecord(agents) && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined
      agentId = isRecord(current) && typeof current.id === 'string' ? current.id : undefined
    }
    // v7.6: measured here when the auto-graft check already read it, and once
    // more below when only the nudge needs it. `readTokenWatermark` folds
    // incrementally, so the second read costs the appended tail, not the log.
    let watermarkForNudge: TokenWatermark | undefined
    /**
     * v0.14 D2: true while this session is a fresh graft target inside its grace
     * window. Computed once and used by BOTH automatic paths (the 70% nudge and
     * the 75% fallback), because "do not graft yourself again yet" has to hold
     * for the nudge too — otherwise the model is invited to do exactly what the
     * chain guard is about to refuse.
     */
    let chainProtected = false
    /** v0.14 D1: the one-shot red-line message for this session (see below). */
    const guardMessages: any[] = []
    /**
     * v7.6: whether the hard cutoff applies to THIS session (autoGraft on, and
     * not excluded by the allowlist). The nudge ceiling depends on it: a session
     * with no cutoff has no rescue line behind the nudge.
     */
    let autoGraftApplies = false
    if (typeof agentId === 'string') {
      // v5.2 补丁二：后台约束通过 pre-step 的 messages 注入，见下方 takePendingConstraintMessages。
      /**
       * v7.0 P0-5 (second half): re-assert the target's constraints in-band.
       *
       * The system-prompt section is the structural guarantee — it cannot be
       * compacted. This is the belt-and-braces copy for the case the section is
       * unavailable: an older host without `systemPrompt.section`, or a process
       * that started before this plugin registered it.
       *
       * It is a `developer/message` delivered through pre-step `messages`, which
       * is the one channel that reaches the model without touching the log (and
       * therefore without consuming a step number — writing an event here would
       * collide with the v4 step ordering, the bug that once corrupted a log).
       *
       * Delivered once per session per process, not every step: repeating a
       * standing rule every turn trains the reader to skip it.
       */
      /**
       * v0.14 D1: the highest-priority warning, injected through pre-step.
       *
       * The instruction that motivated this: with no explicit boundary, "find the
       * file" becomes "widen the search" — profile directory, AppData, then the
       * drive roots — turn after turn, with confident summaries of a filesystem
       * that was only listed. The tool guard refuses those commands; this makes
       * the refusal predictable instead of surprising, and covers the paths the
       * guard deliberately allows (a specific read under C:\).
       *
       * Once per session per process: a rule repeated every step is a rule the
       * reader learns to skip. Delivered as a `user/message` through pre-step
       * `messages`, the one channel that reaches the model without writing a log
       * event (and therefore without colliding with the v4 step ordering).
       */
      if (settings.workspaceRedline && !guardReasserted.has(agentId)) {
        guardReasserted.add(agentId)
        const cwd = workspaceOfAgent(stableCtx, agentId) || process.cwd()
        const generation = graftGenerationOf(agentId)
        // COLLECTED, never returned early: the branches above and below this point
        // decide whether this session still exists (retired / transferred /
        // grafting). A guard that returns here would answer "enter" for a session
        // that is about to be rejected, which is a behaviour change, not a guard.
        guardMessages.push({
          id: `graft-guard-${agentId}` as any,
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '[系统提示·最高优先级] 工作目录红线：',
                workspaceRedline(cwd),
                '',
                '破坏性命令红线：禁止 rm -rf /、Remove-Item -Recurse 指向盘符根目录 / 用户目录 / 工作区之外的路径；',
                '本地护栏会在工具层直接拒绝这类命令（不是提醒，是拒绝），不要换写法重试。',
                ...(generation > 0
                  ? ['', `迁移纪律：本会话是第 ${generation} 代迁移产物，完成前 ${GRAFT_CHAIN_GRACE_TURNS} 轮之前不得再触发切片。`]
                  : []),
              ].join('\n'),
            },
          ],
          source: { kind: GRAFT_REPLAY_SOURCE_KIND },
        })
      }
      if (!constraintsReasserted.has(agentId)) {
        const standing = targetConstraintSections.get(agentId)
        if (standing !== undefined && standing.constraints.length > 0) {
          constraintsReasserted.add(agentId)
          const existing = Array.isArray(payload?.messages) ? payload.messages : []
          return {
            kind: 'enter',
            messages: [
              ...existing,
              {
                id: `graft-standing-${agentId}` as any,
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: [
                      '[系统提示] 本次任务的硬约束（来自用户原话，始终有效，不因上下文压缩而失效）：',
                      ...standing.constraints.map((constraint, index) => `${index + 1}. ${constraint}`),
                      '',
                      'If asked about constraints or progress, enumerate every item above without skipping or summarizing.',
                    ].join('\n'),
                  },
                ],
                source: { kind: GRAFT_REPLAY_SOURCE_KIND },
              },
            ],
          }
        }
      }
      // v7.0 P6: an overflow recovery built a target but left this session
      // alive so the host could retry the failed request. The retry has now
      // happened, so this is the earliest moment the user can be redirected.
      //
      // Checked BEFORE the `done` branch: recovery sets state to 'done' (the
      // session is migrated as far as it is concerned), but the redirect is
      // deferred, so the deferred entry is the more specific fact.
      const deferredTarget = deferredOverflowTargets.get(agentId)
      if (deferredTarget !== undefined) {
        deferredOverflowTargets.delete(agentId)
        autoGraftStates.set(agentId, 'done')
        captureDraft(ctx, agentId, deferredTarget, payload?.messages)
        await appendTransitionCard(agentId, deferredTarget)
        return {
          kind: 'reject',
          reason: `上下文溢出后已转移至新会话 ${deferredTarget}`,
          newSessionId: deferredTarget,
        }
      }
      const state = autoGraftStates.get(agentId) ?? 'idle'
      if (state === 'grafting') {
        return { kind: 'reject', reason: 'Grafting in progress' }
      }
      if (state === 'done') {
        const doneTransfer = transferredSessions.get(agentId)
        if (doneTransfer !== undefined) captureDraft(ctx, agentId, doneTransfer.newSessionId, payload?.messages)
        await appendTransitionCard(agentId, doneTransfer?.newSessionId ?? '新会话')
        return {
          kind: 'reject',
          reason: 'Transferred',
          ...(doneTransfer === undefined ? {} : { newSessionId: doneTransfer.newSessionId }),
        }
      }
      const transferred = transferredSessions.get(agentId)
      if (transferred !== undefined) {
        autoGraftStates.set(agentId, 'done')
        captureDraft(ctx, agentId, transferred.newSessionId, payload?.messages)
        await appendTransitionCard(agentId, transferred.newSessionId)
        return { kind: 'reject', reason: transferred.reason, newSessionId: transferred.newSessionId }
      }
      if (retiredSessions.has(agentId)) {
        await appendTransitionCard(agentId, '新会话')
        return { kind: 'reject', reason: '该会话已退休；请在新会话继续。' }
      }
      // v6.3 module 4: finish a pending confirmation before anything else.
      const confirm = pendingConfirms.get(agentId)
      if (confirm !== undefined && Date.now() - confirm.askedAt > settings.confirmTtlMs) {
        pendingConfirms.delete(agentId)
      } else if (confirm !== undefined) {
        const answer = lastUserText(payload?.messages)
        if (answer !== undefined && isConfirmAffirmative(answer)) {
          pendingConfirms.delete(agentId)
          autoGraftStates.set(agentId, 'grafting')
          retiredSessions.add(agentId)
          transferredSessions.set(agentId, {
            newSessionId: confirm.targetId,
            at: Date.now(),
            reason: `已转移至新会话 ${confirm.targetId}`,
          })
          persistRetiredStore(stableCtx)
          persistTransferredStore(stableCtx)
          try {
            const report = await autoGraftIfNeeded(stableCtx, settings, agentId, {
              targetId: confirm.targetId,
              ignoreTransferGuard: true,
              confirmed: true,
              refineConstraints: (src, tgt, evs) => {
                void refineConstraintsInBackground(stableCtx, settings, src, tgt, evs)
              },
            })
            if (report === undefined) throw new Error('confirmed graft produced no target')
            autoGraftStates.set(agentId, 'done')
            await appendTransitionCard(agentId, report.newSessionId, sessionTitleForGoal(report.goal, report.newSessionId))
            return {
              kind: 'reject',
              reason: `已按确认迁移至新会话 ${report.newSessionId}`,
              newSessionId: report.newSessionId,
            }
          } catch (error) {
            autoGraftStates.set(agentId, 'idle')
            retiredSessions.delete(agentId)
            transferredSessions.delete(agentId)
            // v7.7: pass the ids explicitly. The merge-on-write path unions the
            // disk file with memory, so a plain write here would resurrect the
            // reservation this rollback is undoing.
            persistRetiredStore(stableCtx, [agentId])
            persistTransferredStore(stableCtx, [agentId])
            ctx.logger?.warn?.(`[dsh-graft-slice] confirmed graft failed: ${String((error as any)?.message ?? error)}`)
          }
        } else if (answer !== undefined && answer.trim().length > 0) {
          // Any other answer cancels the prompt; the watermark can ask again later.
          pendingConfirms.delete(agentId)
        }
      }

      // v0.14 D2: is this session a fresh graft target inside its grace window?
      // Read before the watermark so the answer also governs the 70% nudge: a
      // target in grace must not be invited to slice itself, and must not be
      // force-cut at 75% by the very pressure its seeded tape inherited.
      chainProtected = (() => {
        const live = stableCtx.sessions.get(agentId) as any
        const events =
          live !== undefined && typeof live.snapshotEvents === 'function'
            ? (live.snapshotEvents(0) as SessionEventLike[])
            : undefined
        return isProtectedGraftTarget(agentId, events, settings.graftTargetGraceTurns)
      })()

      // Evidence, not enforcement: the two branches below withhold the nudge and
      // the forced cut for a protected target. Record WHY, so "it sat at 80% and
      // nothing happened" is answerable from the audit file instead of empty.
      if (chainProtected && (autoGraftStates.get(agentId) ?? 'idle') === 'idle') {
        const watermark = await readTokenWatermark(stableCtx, agentId, settings)
        watermarkForNudge = watermark
        if (watermark !== undefined && watermark.ratio >= effectiveWatermarks(settings, watermark).warnAt) {
          appendGraftAudit({
            at: new Date().toISOString(),
            kind: 'chain-guard',
            sessionId: agentId,
            ratio: Number(watermark.ratio.toFixed(4)),
            detail: `fresh target (generation ${graftGenerationOf(agentId)}): nudge and autoGraft withheld inside the ${settings.graftTargetGraceTurns}-turn grace window`,
          })
        }
      }

      autoGraftApplies =
        settings.autoGraft &&
        !chainProtected &&
        (settings.autoGraftSessionIds.length === 0 || settings.autoGraftSessionIds.includes(agentId))
      if (autoGraftApplies && state === 'idle') {
        const watermark = await readTokenWatermark(stableCtx, agentId, settings)
        watermarkForNudge = watermark
        const thresholds = watermark === undefined ? undefined : effectiveWatermarks(settings, watermark)
        if (watermark !== undefined && thresholds !== undefined && watermark.ratio >= thresholds.hardAt) {
          // v6.3 module 4: confirm mode asks here; the answer arrives next step.
          if (settings.graftMode === 'confirm' && !pendingConfirms.has(agentId)) {
            pendingConfirms.set(agentId, {
              targetId: autoTargetId(settings),
              askedAt: Date.now(),
              ratio: watermark.ratio,
            })
            return {
              kind: 'reject',
              reason:
                '上下文即将满载，是否由系统进行无缝迁移？（回复"确认"立刻迁移，其它回复取消）',
            }
          }
          if (settings.graftMode === 'confirm') {
            // A prompt is already open; let the turn proceed so the user can answer.
            return { kind: 'enter', messages: Array.isArray(payload?.messages) ? payload.messages : [] }
          }
          const targetId = autoTargetId(settings)
          // v7.9: was this cut forced by an ignored nudge? The target's pending
          // state must say so, or the next generation reads a mid-write stop as
          // a planned handover.
          if (watermarkEscalations.has(agentId) || watermarkEscalated.has(agentId)) {
            forcedCutMarks.set(agentId, { ratio: watermark.ratio, at: Date.now() })
          }
          autoGraftStates.set(agentId, 'grafting')
          // Force the old session closed BEFORE creating the target. During
          // the async graft, every later pre-step sees 'grafting' or the
          // persisted transfer and is rejected.
          retiredSessions.add(agentId)
          transferredSessions.set(agentId, {
            newSessionId: targetId,
            at: Date.now(),
            reason: `已转移至新会话 ${targetId}`,
          })
          persistRetiredStore(stableCtx)
          persistTransferredStore(stableCtx)
          try {
            const report = await autoGraftIfNeeded(stableCtx, settings, agentId, {
              targetId,
              ignoreTransferGuard: true,
              refineConstraints: (src, tgt, evs) => {
                void refineConstraintsInBackground(stableCtx, settings, src, tgt, evs)
              },
            })
            if (report === undefined) throw new Error('auto graft produced no target')
            autoGraftStates.set(agentId, 'done')
            appendGraftAudit({
              at: new Date().toISOString(),
              kind: 'force-graft',
              sessionId: agentId,
              targetSessionId: report.newSessionId,
              ratio: Number(watermark.ratio.toFixed(4)),
              detail: 'autoGraft fallback',
            })
            await appendTransitionCard(agentId, report.newSessionId, sessionTitleForGoal(report.goal, report.newSessionId))
            return {
              kind: 'reject',
              reason: `已自动迁移至新会话 ${report.newSessionId}`,
              newSessionId: report.newSessionId,
            }
          } catch (error) {
            autoGraftStates.set(agentId, 'idle')
            retiredSessions.delete(agentId)
            transferredSessions.delete(agentId)
            persistRetiredStore(stableCtx, [agentId])
            persistTransferredStore(stableCtx, [agentId])
            try {
              ctx.logger?.warn?.(`[dsh-graft-slice] auto-graft failed and rolled back: ${String((error as any)?.message ?? error)}`)
            } catch {
              // logging must not change the decision
            }
          }
        }
      }
    }
    if (typeof next === 'function') {
      const decision = await next()
      if (typeof agentId !== 'string' || !isRecord(decision) || decision.kind === 'reject') return decision
      const base = Array.isArray(decision.messages) ? decision.messages : []
      // v6.0 补丁一：草稿优先合并，让"被截断的那句话"接上用户的新输入。
      const merged = takeDraftMerge(agentId, base)
      const messages = merged === undefined ? base : [...base, ...merged.messages]
      const extra = takePendingConstraintMessages(agentId)
      // v7.5: the node-plan hint rides the same channel (and the same discipline:
      // once, quiet, non-blocking).
      const planExtra = takePlanNudge(ctx, agentId, payload?.messages)
      // v7.6: the model-driven handover nudge. Between the nudge line and the
      // hard cutoff the model decides; above the cutoff the auto-graft branch
      // has already returned and this code is never reached.
      if (settings.modelDrivenGraft && watermarkForNudge === undefined) {
        watermarkForNudge = await readTokenWatermark(stableCtx, agentId, settings)
      }
      const nudgeThresholds =
        watermarkForNudge === undefined ? undefined : effectiveWatermarks(settings, watermarkForNudge)
      const modelExtra =
        !chainProtected && settings.modelDrivenGraft
          ? takeModelDrivenNudge(
              stableCtx,
              settings,
              agentId,
              payload,
              watermarkForNudge,
              autoGraftApplies && nudgeThresholds !== undefined ? nudgeThresholds.hardAt : undefined,
              nudgeThresholds,
            )
          : []
      // v7.9: the nudge was ignored (the model started another step). One hard
      // instruction, once, before the hard cutoff has to do it for the model.
      // Never in the same step as the nudge: the model just received its one
      // chance and has not had the time to act on it.
      const urgentExtra = modelExtra.length > 0 ? [] : takeWatermarkEscalation(stableCtx, agentId, payload)
      const appended = [...guardMessages, ...extra, ...planExtra, ...modelExtra, ...urgentExtra]
      if (appended.length === 0) return merged === undefined ? decision : { ...decision, messages }
      return { ...decision, messages: [...messages, ...appended] }
    }
    return { kind: 'enter', messages: Array.isArray(payload?.messages) ? payload.messages : [] }
  })

  /**
   * v7.0 P0-3: the deferred-graft consumer.
   *
   * The deadlock this closes, stated precisely:
   *
   * `autoGraftIfNeeded` runs from `agent/pre-step`. If the watermark is over
   * threshold but the session is NOT at a safe harbour (a tool call is still
   * pending, or the model is streaming), it records the session in
   * `pendingGraftSources` and returns — "retry at the next quiet boundary".
   *
   * But nothing consumed that set. `pre-step` only runs at the START of a step,
   * and a session that is mid-tool-call at the last pre-step may never see
   * another one: the turn ends, the user does not send anything, and the session
   * sits over the ratio forever. The first anyone hears about it is the provider
   * refusing the next request.
   *
   * `agent/turn-stopping` is the host's own "the model owes no further response"
   * boundary — no live tool calls, no pending steering. That is exactly the
   * quiet moment the deferral was waiting for. Running the retry here (rather
   * than from a timer) means the graft still happens inside a legitimate turn
   * lifecycle, and it happens once, because the set is consumed on use.
   *
   * The listener is `serial`, so it may await; errors are contained because a
   * failing retry must not abort the turn that is closing.
   */
  ctx.on(TURN_STOPPING_EVENT, async (payload: any) => {
    const agentId = typeof payload?.agent?.id === 'string' ? payload.agent.id : undefined
    if (agentId === undefined) return
    if (!pendingGraftSources.has(agentId)) return
    if (autoGraftStates.get(agentId) === 'grafting' || autoGraftStates.get(agentId) === 'done') return
    if (!settings.autoGraft) return
    if (settings.autoGraftSessionIds.length > 0 && !settings.autoGraftSessionIds.includes(agentId)) return
    // Consume BEFORE attempting: a retry that throws must not be re-entered on
    // every subsequent turn-stopping for the rest of the session.
    pendingGraftSources.delete(agentId)
    try {
      const report = await autoGraftIfNeeded(stableCtx, settings, agentId, {
        refineConstraints: (src, tgt, evs) => {
          void refineConstraintsInBackground(stableCtx, settings, src, tgt, evs)
        },
      })
      if (report !== undefined) {
        autoGraftStates.set(agentId, 'done')
        ctx.logger?.info?.(
          `[dsh-graft-slice] deferred graft completed at turn-stopping: ${agentId} -> ${report.newSessionId}`,
        )
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] deferred graft at turn-stopping failed: ${String((error as any)?.message ?? error)}`,
      )
    }
  })

  /**
   * v7.0 P6: overflow recovery — the case pre-step cannot catch.
   *
   * Every other migration path in this file is opportunistic: pre-step looks at
   * the watermark and decides whether to act *before* a request. That works
   * while the estimate roughly tracks reality, and fails exactly when it matters
   * most — the provider itself says "this request is too large". No amount of
   * pre-step checking runs after the fact.
   *
   * `agent/request-error` is the host's own recovery seam. Verified against
   * `dsh-agent-loop`:
   *
   *   const action = await this.dispatch.waterfall("agent/request-error", {
   *     turn, step, provider, failure: finish.failure, retryPolicy, signal,
   *   }, () => Promise.resolve(undefined))
   *   if (action?.kind !== "retry") throw new LlmError(...)
   *   continue                                    // <-- the request is re-sent
   *
   * So returning `{ kind: 'retry' }` after the surface has been rewritten makes
   * the host re-issue the same step against the new, smaller history. That is
   * precisely the "migrate, then retry" the requirement asks for, using the
   * host's contract rather than fighting it.
   *
   * Ordering matters and is enforced here: graft FIRST, then retry. A retry
   * returned before a successful graft would simply overflow again, and the
   * host's own `maxOverflowRetries` would burn on a loop that never shrinks.
   */
  ctx.on('agent/request-error', async (payload: any, next: any) => {
    const failure = payload?.failure
    const code = typeof failure?.code === 'string' ? failure.code : ''
    if (code !== CONTEXT_WINDOW_EXCEEDED) return next()
    if (payload?.signal?.aborted === true) return next()

    const agentId = typeof payload?.agent?.id === 'string' ? payload.agent.id : undefined
    if (agentId === undefined) return next()

    // Asked to retry once already and still overflowing: the tape itself is
    // larger than the window, and another migration would produce the same
    // result. Report and let the host surface the original failure.
    if (overflowRetries.has(agentId)) {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] overflow recovery already attempted for ${agentId}; not migrating again`,
      )
      return next()
    }

    const live = stableCtx.get('sessions')?.get?.(agentId)
    const events = isRecord(live) && typeof live.snapshotEvents === 'function'
      ? (live.snapshotEvents(0) as SessionEventLike[])
      : undefined
    if (events === undefined) return next()

    // Reuse the same safe-harbour rule as the pressure path: a half-finished
    // step is not a boundary, even under overflow.
    const harbor = checkSafeHarbor(events)
    if (!harbor.safe) {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] overflow recovery deferred for ${agentId}: ${harbor.reason}`,
      )
      return next()
    }

    overflowRetries.add(agentId)
    const targetId = autoTargetId(settings)
    // NOTE: the source is NOT retired here.
    //
    // The pressure path retires before creating the target, because the whole
    // point is to move the user to the new session immediately. Overflow
    // recovery is different: it has to hand the CURRENT step back to the host
    // with `{ kind: 'retry' }`, and a retired session's next pre-step returns
    // `{ kind: 'reject' }` — which would abort the very request we are trying
    // to rescue. So the retirement marker is deferred to the target's own
    // pre-step, where it belongs anyway.

    try {
      // B1 applies here too: an overflow almost always happens inside an open
      // turn that has already produced results, and those are the most recent
      // work in the session.
      //
      // v7.4 P0-3b: and for that exact reason the snapshot must NOT be cut at
      // the last turn/end. Cutting there is what emptied the carryover block
      // and let the source's newest round disappear from the tape.
      if (!hasClosedTurn(events)) throw new Error('no closed turn to slice for overflow recovery')
      const sourceSnapshot = { session: (live as any).header, events }
      const derived = deriveAutoTapeBudget(
        (() => {
          const contextWindow = events
            .filter((event) => event.type === 'request/context')
            .map((event) => Number(event.data?.contextWindow))
            .filter((value) => Number.isFinite(value) && value > 0)
            .at(-1)
          return contextWindow ?? settings.contextWindowTokens
        })(),
      )
      // retireSource stays false: the source must remain usable for the retry.
      const report = await graftSliceAndInject(
        stableCtx,
        { ...settings, retireSource: false, maxTotalChars: derived > 0 ? derived : settings.maxTotalChars },
        agentId,
        targetId,
        undefined,
        { sourceSnapshot, runtimeIntent: extractRuntimeIntent(events) },
      )
      // Mark the transfer (not a retirement) so the next pre-step redirects the
      // user to the target instead of failing with "session retired".
      deferredOverflowTargets.set(agentId, report.newSessionId)
      autoGraftStates.set(agentId, 'done')
      await appendTransitionCard(agentId, report.newSessionId, sessionTitleForGoal(report.goal, report.newSessionId))
      ctx.logger?.info?.(
        `[dsh-graft-slice] overflow recovery: ${agentId} -> ${report.newSessionId}; retrying the request`,
      )
      // The host re-issues the same step. The retry reads the same log — which
      // is why the graft must not have mutated it — and now fits, because the
      // target exists and the pressure path will route there next turn.
      return { kind: 'retry' }
    } catch (error) {
      overflowRetries.delete(agentId)
      autoGraftStates.set(agentId, 'idle')
      ctx.logger?.warn?.(
        `[dsh-graft-slice] overflow recovery failed and rolled back: ${String((error as any)?.message ?? error)}`,
      )
      return next()
    }
  })


  /**
   * v7.0 P0-5: constraints live in a system-prompt SECTION, not in the surface.
   *
   * This is the only place compaction cannot reach.
   *
   * Verified against DSH source:
   *
   *   selectCompactableRange(session, measurement, retainTokens) {
   *     const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1
   *     ...
   *     return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }
   *   }
   *
   * The range always starts at index >= 1, and `systemPrompt.section()` is not a
   * surface node at all — it is rendered into the prompt that `systemHead`
   * occupies. So a section is structurally immune: no retention budget, no
   * `retainTokens`, no `/compact`, and no overflow path can drop it.
   *
   * Why this matters even though `compaction-basic` runs with `auto: false`:
   *   - `/compact` (command-compact) still calls the manual path on demand;
   *   - another profile or a future bundle may mount a compaction backend;
   *   - `compactionRegion` can be invoked by any plugin.
   * A constraint that survives only because a config flag is off is not
   * protected; it is merely un-attacked so far.
   *
   * Scope: only sessions this plugin CREATED. The section text is computed per
   * request from that session's own stored constraints, so a normal session
   * renders `''` and pays nothing.
   */
  const registerConstraintSection = (): void => {
    const systemPrompt = (() => {
      try {
        return ctx.get('systemPrompt') as any
      } catch {
        return undefined
      }
    })()
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
      ctx.logger?.warn?.(
        '[dsh-graft-slice] ctx.systemPrompt.section() unavailable; constraints stay in the goal message only',
      )
      return
    }
    const order =
      typeof systemPrompt.getSectionOrder === 'function'
        ? Number(systemPrompt.getSectionOrder('PLAN_POLICY')) || 0
        : 0
    systemPrompt.section({
      name: 'graft:constraints',
      order,
      text: (context: any) => {
        const sessionId =
          typeof context?.agent?.session?.id === 'string' ? context.agent.session.id : undefined
        if (sessionId === undefined) return ''
        const entry = targetConstraintSections.get(sessionId)
        if (entry === undefined || entry.constraints.length === 0) return ''
        // Read as a standing rule of this workspace, not as migration narration:
        // the target must treat these as always-true, and must not be reminded
        // every turn that it was once relocated.
        return [
          '## Standing constraints for this work',
          'These were declared by the user and remain in force for the whole task:',
          ...entry.constraints.map((constraint, index) => `${index + 1}. ${constraint}`),
          'If asked about constraints or progress, enumerate every item above without skipping or summarizing.',
        ].join('\n')
      },
    })
  }
  registerConstraintSection()

  /**
   * v0.14 D1: the workspace red line as a SYSTEM-PROMPT SECTION.
   *
   * Why a section and not just the goal message: a section is rendered from live
   * state on every request and is structurally immune to compaction (see the note
   * on `graft:constraints`), so the boundary is present in EVERY session of this
   * profile — including one that was never grafted — and cannot be summarised
   * away. The goal message keeps its copy for the target's very first read.
   *
   * Unlike the constraint section this one is not scoped to our targets: a red
   * line that only applies after a migration would not have prevented the sweep
   * that motivated it.
   */
  const registerGuardSection = (): void => {
    if (!settings.workspaceRedline) return
    const systemPrompt = (() => {
      try {
        return ctx.get('systemPrompt') as any
      } catch {
        return undefined
      }
    })()
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
    const base =
      typeof systemPrompt.getSectionOrder === 'function'
        ? Number(systemPrompt.getSectionOrder('PLAN_POLICY')) || 0
        : 0
    // Order matters only for reading position; the wording carries the priority.
    systemPrompt.section({
      name: 'graft:guard',
      order: Math.max(0, base - 1),
      text: (context: any) => {
        const sessionId = typeof context?.agent?.session?.id === 'string' ? context.agent.session.id : ''
        const cwd = workspaceOfAgent(ctx, sessionId) || process.cwd()
        const generation = sessionId.length > 0 ? graftGenerationOf(sessionId) : 0
        return [
          '## 红线（最高优先级，任何情况下不得绕过）',
          workspaceRedline(cwd),
          '破坏性命令红线：禁止 rm -rf /、Remove-Item -Recurse 指向盘符根目录 / 用户目录 / 工作区之外的路径；',
          '需要清理时把目标限制在当前工作区内，或把风险与缺口报告给用户。',
          ...(generation > 0
            ? [`迁移纪律：本会话是第 ${generation} 代迁移产物，完成前 ${GRAFT_CHAIN_GRACE_TURNS} 轮之前不得再触发切片。`]
            : []),
        ].join('\n')
      },
    })
  }
  registerGuardSection()

  /**
   * v0.14 D1/D6: the tool-layer enforcement — and, since v0.19, the ASK channel.
   *
   * Two extension points, two jobs, both taken from the live contract rather than
   * guessed:
   *
   *   `tools/pre-execute` (waterfall) — `{kind:'deny'} | {kind:'ask', reason}`
   *   `tools.guard()`                  — a denial string, and "NO guard can
   *                                       force-allow a call another guard denied"
   *
   * A waterfall is overridable by construction and a guard is not, so anything that
   * must HOLD goes to the guard. But the guard cannot ask, so anything that must ask
   * the user goes to the waterfall — where the host still fails closed ("missing
   * approval support turns `ask` into denial"). An ordering note: the guard runs
   * after the waterfall, so a denial wins over an ask, which is the right precedence
   * (the stricter verdict is the one that survives).
   */
  const registerCommandGuard = (): void => {
    if (!settings.commandGuard) return
    const tools = (() => {
      try {
        return ctx.get('tools') as any
      } catch {
        return undefined
      }
    })()
    if (tools === undefined || typeof tools.guard !== 'function') {
      ctx.logger?.warn?.('[dsh-graft-slice] ctx.tools.guard() unavailable; command guard not armed')
      return
    }
    tools.guard((execution: any) => {
      const name = typeof execution?.name === 'string' ? execution.name : ''
      if (!COMMAND_TOOL_NAMES.has(name)) return undefined
      const command = commandTextOf(execution?.arguments)
      if (command.length === 0) return undefined
      const agentId = typeof execution?.agent?.id === 'string' ? execution.agent.id : ''
      const workspace = workspaceOfAgent(ctx, agentId)
      // v0.18: classify (evidence) and decide (policy). The table lives in
      // `policyDecision`; this call site only reports what the operator chose.
      const verdict = evaluateCommandPolicy(command, workspace, settings.safetyMode)
      // v0.19: `ask` is NOT the guard's verdict — the waterfall owns it (see
      // registerCommandAsk). The guard only enforces the decisions that must HOLD.
      if (verdict.decision !== 'deny' || verdict.reason === undefined) return undefined
      try {
        appendGraftAudit({
          at: new Date().toISOString(),
          kind: 'command-blocked',
          ...(agentId.length === 0 ? {} : { sessionId: agentId }),
          detail:
            `${verdict.code ?? verdict.risk}/safetyMode=${settings.safetyMode}: ` +
            command.replace(/\s+/gu, ' ').slice(0, 200),
        })
      } catch {
        // The audit line is evidence; the denial must not depend on it.
      }
      return verdict.reason
    })
  }
  registerCommandGuard()

  /**
   * v0.19: the ASK channel.
   *
   * `tools.guard()` can only deny, so v0.18 encoded "ask" as a refusal that told the
   * agent to go get confirmation — which made the user do the plugin's job. The
   * waterfall can return `{kind:'ask', reason, displayReason}` and the host turns
   * that into a real approval prompt; if the deployment has no approval support it
   * degrades to denial, which is exactly the fail-closed behaviour wanted.
   *
   * Precedence note: the guard runs AFTER this waterfall, so a `deny` still beats an
   * `ask`. The stricter verdict is the one that survives.
   */
  const registerCommandAsk = (): void => {
    if (!settings.commandGuard) return
    ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
      const name = typeof exec?.name === 'string' ? exec.name : ''
      if (!COMMAND_TOOL_NAMES.has(name)) return next()
      const command = commandTextOf(exec?.arguments)
      if (command.length === 0) return next()
      // Only `autonomous` can produce an `ask`; in strict/balanced this is a no-op
      // pass-through and the guard denies.
      if (settings.safetyMode !== 'autonomous') return next()
      const agentId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      const workspace = workspaceOfAgent(ctx, agentId)
      const verdict = evaluateCommandPolicy(command, workspace, settings.safetyMode)
      if (verdict.decision !== 'ask') return next()
      try {
        appendGraftAudit({
          at: new Date().toISOString(),
          kind: 'command-asked',
          ...(agentId.length === 0 ? {} : { sessionId: agentId }),
          detail:
            `${verdict.code ?? verdict.risk}/safetyMode=${settings.safetyMode}: ` +
            command.replace(/\s+/gu, ' ').slice(0, 200),
        })
      } catch {
        // Evidence only; the prompt must not depend on it.
      }
      const reason = verdict.reason ?? '这类命令需要你当场确认后才会执行。'
      return { kind: 'ask', reason, displayReason: { en: reason, 'zh-CN': reason } }
    })
  }
  registerCommandAsk()

  /**
   * v0.16 CONSOLE: the Host half of the Web panel.
   *
   * The problem this removes is not "the config is hard to find" — it is that
   * changing it meant editing a YAML file and restarting the host, so the knobs
   * were effectively frozen during a session. The panel needs two things from the
   * Host: a live status read, and a config WRITE that does not restart anything.
   *
   * Both are exposed as COMMANDS, for three reasons:
   *   1. it is the Client-callable Host entry point the UI rules name
   *      (`ctx.remote.commands.execute`), so the panel and the slash command use
   *      one implementation rather than two;
   *   2. the write goes through `configEditor.edit`, which persists the override
   *      into the profile patch and reconciles the Loader — the value survives a
   *      restart because it IS the config, not a shadow copy in plugin memory;
   *   3. `/graft-console` is usable from the composer immediately, before any
   *      panel is open, which is the honest fallback if a client bundle is stale.
   */
  const consoleState = async (): Promise<GraftConsoleState> => {
    const rows: ConsoleRow[] = []
    const sessions = (() => {
      try {
        return (stableCtx as any).get('sessions') as any
      } catch {
        return undefined
      }
    })()
    /**
     * v0.28 P0: collect the live sessions FIRST, independently of watermarks.
     *
     * Two different questions were being answered by one list:
     *   "which sessions can I plot?"        -> `rows`, needs a watermark
     *   "which sessions can I act on?"      -> `sessions`, needs only an id
     * The panel needs the second one to render its selector, and `rows` was silently
     * answering it. Any session without a measurable watermark (fresh, no message yet,
     * provider silent) vanished from the panel entirely.
     */
    const liveSessions: Array<{ sessionId: string; cwd: string; hasWatermark: boolean }> = []
    if (isRecord(sessions) && typeof sessions.list === 'function') {
      for (const agent of sessions.list() as any[]) {
        const sessionId = typeof agent?.id === 'string' ? agent.id : ''
        if (sessionId.length === 0) continue
        const watermark = await readTokenWatermark(stableCtx, sessionId, settings)
        liveSessions.push({
          sessionId,
          cwd: workspaceOfAgent(stableCtx, sessionId),
          hasWatermark: watermark !== undefined,
        })
        // Only a measurable session gets a ROW; every session gets an ENTRY above.
        if (watermark === undefined) continue
        const rowThresholds = effectiveWatermarks(settings, watermark)
        const mark = graftTargets.get(sessionId)
        const completed = (() => {
          const live = (stableCtx as any).sessions?.get?.(sessionId) as any
          if (live === undefined || typeof live.snapshotEvents !== 'function') return undefined
          return (live.snapshotEvents(0) as SessionEventLike[]).filter((event) => event.type === 'turn/end').length
        })()
        rows.push({
          sessionId,
          cwd: workspaceOfAgent(stableCtx, sessionId),
          tokens: watermark.tokens,
          contextWindow: watermark.contextWindow,
          percent: Number((watermark.ratio * 100).toFixed(2)),
          source: watermark.source,
          toWarnTokens: Math.max(
            0,
            Math.round(watermark.contextWindow * (rowThresholds.warnAt - watermark.ratio)),
          ),
          toHardTokens: Math.max(
            0,
            Math.round(watermark.contextWindow * (rowThresholds.hardAt - watermark.ratio)),
          ),
          state:
            watermark.ratio >= rowThresholds.hardAt
              ? 'over-hard-cutoff'
              : watermark.ratio >= rowThresholds.warnAt
                ? 'over-warn-line'
                : 'below-warn-line',
          warnAt: rowThresholds.warnAt,
          hardAt: rowThresholds.hardAt,
          generation: mark?.generation ?? 0,
          graceTurnsRemaining:
            completed === undefined || mark === undefined ? 0 : Math.max(0, settings.graftTargetGraceTurns - completed),
        })
      }
    }
    rows.sort((left, right) => right.percent - left.percent)
    // v0.18: the thresholds are derived per window, so the panel shows the pair
    // that governs the HIGHEST session and the cost model behind it, rather than
    // two constants the operator cannot reconcile with what the rows say.
    const representative = rows[0]
    const thresholds = effectiveWatermarks(
      settings,
      representative === undefined
        ? undefined
        : { contextWindow: representative.contextWindow },
    )
    const cost = estimateGraftCost(thresholds.windowLimit, {
      growthPerTurnTokens: settings.growthTokensPerTurn,
      reserveTurns: settings.growthReserveTurns,
    })
    return {
      config: {
        modelDrivenGraft: settings.modelDrivenGraft,
        autoGraft: settings.autoGraft,
        modelDrivenGraftAtRatio: settings.modelDrivenGraftAtRatio,
        autoGraftAtRatio: settings.autoGraftAtRatio,
        workspaceRedline: settings.workspaceRedline,
        commandGuard: settings.commandGuard,
        graftTargetGraceTurns: settings.graftTargetGraceTurns,
        safetyMode: settings.safetyMode,
        watermarkMode: settings.watermarkMode,
        constraintBudgetChars: settings.constraintBudgetChars,
        growthTokensPerTurn: settings.growthTokensPerTurn,
        growthReserveTurns: settings.growthReserveTurns,
        igniteTarget: settings.igniteTarget,
        ignitionMode: settings.ignitionMode,
      },
      thresholds: { ...thresholds, estimate: thresholds.windowLimit > 0 ? cost : null },
      rows,
      // v0.19: "the target is durable but nobody started it" is a state the panel
      // has to be able to show, not a log line the operator has to go find.
      pendingIgnitions: [...pendingIgnitions.values()].map((entry) => ({
        targetId: entry.targetId,
        sourceSessionId: entry.sourceSessionId,
        attempts: entry.attempts,
        at: entry.at,
      })),
      // v0.28 P0: the list the panel renders its selector from.
      sessions: liveSessions,
      /**
       * v1.1 OBSERVER: the follower bindings plus a one-shot focus request. The console
       * is the only place that can act on it, because `uiWorkspace.openSession` is a
       * CLIENT service and the Host cannot call it.
       */
      observer: {
        bindings: { ...observerBindings.bindings },
        reverse: { ...observerBindings.reverse },
        focus: observerBindings.focus === null ? null : { ...observerBindings.focus },
      },
      generatedAt: new Date().toISOString(),
    }
  }

  const writeConsoleSetting = async (rawInput: string): Promise<{ ok: boolean; text: string }> => {
    const parsed = parseConsoleSetting(rawInput)
    if (parsed.setting === undefined) return { ok: false, text: parsed.error }
    const editor = (() => {
      try {
        return (stableCtx as any).get('configEditor') as any
      } catch {
        return undefined
      }
    })()
    if (!isRecord(editor) || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
      return {
        ok: false,
        text: 'configEditor 服务不可用：本次改动没有落盘。请手动修改 profile 的 cordis.patch.yml（这是本轮之前唯一的办法）。',
      }
    }
    const entry = (editor.entries() as any[]).find(
      (row) => row?.patchId === CONSOLE_PATCH_ID || row?.id === CONSOLE_PATCH_ID,
    )
    if (entry === undefined) {
      return { ok: false, text: `找不到 ${CONSOLE_PATCH_ID} 的配置行；profile 里可能尚未声明该行。` }
    }
    try {
      await editor.edit(entry, (current: Record<string, unknown>) => withConsoleSetting(current ?? {}, parsed.setting))
    } catch (error) {
      return { ok: false, text: `写入失败：${String((error as any)?.message ?? error)}` }
    }
    return {
      ok: true,
      text: `已保存 ${parsed.setting.key}=${parsed.setting.value}（无需重启：下一次 pre-step 就按新值判断）`,
    }
  }

  const registerConsole = (): void => {
    const commands = (() => {
      try {
        return (stableCtx as any).get('commands') as any
      } catch {
        return undefined
      }
    })()
    if (!isRecord(commands) || typeof commands.register !== 'function') {
      ctx.logger?.warn?.('[dsh-graft-slice] ctx.commands unavailable; the console is only reachable through its tools')
      return
    }
    commands.register({
      name: 'graft-console',
      description: '读取转生控制台状态（开关、水位、距 70%/75% 还差多少 token）。Read the graft console state.',
      handler: async () => ({ kind: 'success' as const, text: JSON.stringify(await consoleState()) }),
    })
    commands.register({
      name: 'graft-console-set',
      description:
        '修改转生开关/水位并存盘（无需重启）：<key> <value>，例如 modelDrivenGraftAtRatio 0.70。' +
        'Set a graft knob live, e.g. `/graft-console-set autoGraft false`.',
      input: { hint: '<modelDrivenGraft|autoGraft|modelDrivenGraftAtRatio|autoGraftAtRatio> <value>' },
      handler: async (invocation: any) => {
        const result = await writeConsoleSetting(String(invocation?.rawInput ?? ''))
        return { kind: result.ok ? ('success' as const) : ('error' as const), text: result.text }
      },
    })
    commands.register({
      name: 'graft-observer-create',
      description:
        '为当前（或指定）会话召唤一个跟随它的副脑会话（观察者）。Creates a bound observer session and records the follower pointer.',
      input: { hint: '[mainSessionId]' },
      handler: async (invocation: any) => {
        const requested = String(invocation?.rawInput ?? '').trim()
        const mainSessionId =
          requested.length > 0 ? requested : typeof invocation?.agent?.id === 'string' ? invocation.agent.id : ''
        if (mainSessionId.length === 0) {
          return { kind: 'error' as const, text: '没有可绑定的主会话 id：请在会话里执行，或传入 mainSessionId。' }
        }
        const existing = observerOf(mainSessionId)
        if (existing.length > 0) {
          return { kind: 'success' as const, text: `该会话已有副脑：${existing}（未重复创建）。` }
        }
        const controller = (() => {
          try {
            return (stableCtx as any).get('sessionController') as any
          } catch {
            return undefined
          }
        })()
        if (!isRecord(controller) || typeof controller.create !== 'function') {
          return { kind: 'error' as const, text: 'sessionController.create 不可用：当前宿主不支持创建会话。' }
        }
        const cwd = workspaceOfAgent(stableCtx, mainSessionId)
        try {
          const created = await controller.create(cwd.length > 0 ? { cwd } : {})
          const observerSessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
          if (observerSessionId.length === 0) {
            return { kind: 'error' as const, text: `会话创建返回了空 id：${JSON.stringify(created)}` }
          }
          bindObserver(ctxForStores(), mainSessionId, observerSessionId)
          // The mission is one short queued message: the observer needs its role, not a
          // context dump. A failure to send it must not lose the binding.
          try {
            const abort = new AbortController()
            await controller.prompt(
              {
                requestId: `observer-mission-${Date.now()}`,
                sessionId: observerSessionId,
                mode: 'queue',
                content: [
                  {
                    type: 'text',
                    text:
                      `[副脑启动] 你被绑定为会话 ${mainSessionId} 的观察者（跟随者）。` +
                      '职责：读主会话日志、澄清需求、在控制台可见地提出方案；不直接改代码。' +
                      '主会话转生后你会收到新的绑定目标，身份不变。',
                  },
                ],
              },
              abort.signal,
            )
          } catch (error) {
            try {
              ctx.logger?.warn?.(`[dsh-graft-slice] observer mission prompt failed: ${String((error as any)?.message ?? error)}`)
            } catch {
              // Logging must not lose the binding that was just written.
            }
          }
          return {
            kind: 'success' as const,
            text: `已召唤副脑 ${observerSessionId}，绑定到 ${mainSessionId}。`,
          }
        } catch (error) {
          return { kind: 'error' as const, text: `创建副脑失败：${String((error as any)?.message ?? error)}` }
        }
      },
    })
    commands.register({
      name: 'graft-observer-focus-ack',
      description: '控制台已消费一次焦点牵引请求。Acknowledge the one-shot focus request.',
      handler: async () => {
        takeObserverFocus(ctxForStores())
        return { kind: 'success' as const, text: 'focus-acked' }
      },
    })
  }
  registerConsole()

  ctx.tools.register({
    name: 'graft_slice_and_inject',
    description:
      'Create a durable, zero-inheritance handoff session from a finished source session. ' +
      'Slices through the last turn/end, injects a goal seed, older-turn summaries, the last N turns verbatim, ' +
      'and a first-person pending state into one closed turn/step skeleton. ' +
      'After the target is durable it is IGNITED (sessionController.prompt) so it starts working without a human; ' +
      'the report carries `ignition` and a failed ignition is queued for retry, never a silent no-op. ' +
      'Refuses an open turn, a missing source cwd, a duplicate target id, or a source without a closed turn. ' +
      'Never forks and never writes standalone tool/result events.',
    parameters: {
      type: 'object',
      properties: {
        sourceSessionId: {
          type: 'string',
          description: 'Finished source session id. Its last turn must be closed by turn/end.',
        },
        newSessionId: {
          type: 'string',
          description: 'New session id to create. Must not be live or persisted already; must differ from the source.',
        },
        allowReslice: {
          type: 'boolean',
          description:
            'Slice a source that was already migrated (retired or transferred). Default false — ' +
            're-slicing a handed-off conversation is how two divergent targets appear.',
        },
      },
      required: ['sourceSessionId', 'newSessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sourceSessionId: { type: 'string' },
          newSessionId: { type: 'string' },
          cwd: { type: 'string' },
          boundarySeq: { type: 'number' },
          sourceEventCount: { type: 'number' },
          turns: { type: 'number' },
          recentTurnCount: { type: 'number' },
          olderTurnCount: { type: 'number' },
          adaptiveDepth: {
            type: 'object',
            properties: {
              depth: { type: 'number' },
              mode: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['depth', 'mode', 'reason'],
            additionalProperties: false,
          },
          injected: { type: 'object' },
          pointers: { type: 'object' },
          constraints: { type: 'array' },
          taskStatus: { type: 'array' },
          subagentReports: { type: 'array' },
          workspace: { type: 'object' },
          eventSeqRange: { type: 'object' },
          sourceTemplate: { type: 'object' },
          skeleton: { type: 'object' },
          durability: { type: 'object' },
          retired: { type: 'object' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'sourceSessionId', 'newSessionId', 'cwd', 'durability'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args: any, exec: any) => {
      if (!isRecord(args)) throw graftError('INVALID_ARGUMENT', 'arguments must be an object')
      const sourceSessionId = asNonEmptyString(args.sourceSessionId, 'sourceSessionId')
      assertResliceAllowed(sourceSessionId, args.allowReslice === true)
      return graftSliceAndInject(
        ctx,
        settings,
        sourceSessionId,
        asNonEmptyString(args.newSessionId, 'newSessionId'),
        exec?.signal,
        {
          // v7.3.1: the calling agent is the tool-availability scope of last
          // resort. Resolving tools with no scope reads the GLOBAL view, which
          // omits preset-scoped tools and downgraded every pointer in the tape.
          callingAgent: exec?.agent,
          // v7.7: the wrapper re-checks this under the per-source lock, so the
          // allowReslice decision is not made only against stale local state.
          gateReslice: true,
          allowReslice: args.allowReslice === true,
          refineConstraints: (src, tgt, evs) => {
            void refineConstraintsInBackground(ctx, settings, src, tgt, evs)
          },
        },
      )
    },
  })

  /**
   * v7.3: the regret pill, exposed as a tool.
   *
   * Migrations are judgement calls. When one is wrong — the tape lost the detail
   * that mattered, or the user simply wants the old window back — this undoes the
   * retirement without hand-editing `.retired.json`. The target is NOT deleted:
   * it may already hold work, and destroying it to "undo" would be a second
   * surprise on top of the first.
   */
  ctx.tools.register({
    name: 'graft_resume_session',
    description:
      'Undo a migration: remove a session from the retired/transferred sets so it can be used again. ' +
      'Use this when a handoff turned out to be wrong and the earlier conversation should continue. ' +
      'The handoff target is left untouched — it may already hold work.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The retired source session id to bring back.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          resumed: { type: 'boolean' },
          wasRetired: { type: 'boolean' },
          wasTransferred: { type: 'boolean' },
          targetSessionId: { type: 'string' },
        },
        required: ['resumed', 'wasRetired', 'wasTransferred'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => {
        if (value?.resumed !== true) {
          return [{ type: 'text', text: 'That session was not retired or transferred; nothing to undo.' }]
        }
        const parts = [
          `Resumed ${String(_args && (typeof _args === 'object') ? (_args as any).sessionId : 'the session')}.`,
        ]
        if (typeof value?.targetSessionId === 'string') {
          parts.push(`The handoff target ${value.targetSessionId} was left as it is.`)
        }
        return [{ type: 'text', text: parts.join(' ') }]
      },
    },
    execute: async (args: any) => {
      if (!isRecord(args)) throw graftError('INVALID_ARGUMENT', 'arguments must be an object')
      return resumeSession(ctx, asNonEmptyString(args.sessionId, 'sessionId'))
    },
  })

  /**
   * v7.4 P1-2：两阶段切片。graft_prepare 只读；graft_commit 才写。
   *
   * 单步 confirm 只问"要不要迁移"，用户看不到磁带内容；目标对不对、进度到哪、
   * 约束是否完整、还剩什么，全都不可见。选错的代价是一整轮工作送进一个不能用的窗口。
   */
  ctx.tools.register({
    name: 'graft_prepare',
    description:
      'Stage a slice WITHOUT writing, publishing or retiring anything, and return a reviewable summary: ' +
      'the goal, the progress, the constraints, what is still open, and a content hash. Show that summary ' +
      'to the user. If they approve, call graft_commit with the returned preparedId and digest. Nothing ' +
      'is migrated until commit, and a review older than 30 minutes expires.',
    parameters: {
      type: 'object',
      properties: {
        sourceSessionId: {
          type: 'string',
          description: 'The session whose log should be sliced.',
        },
        targetSessionId: {
          type: 'string',
          description: 'Optional id for the future target; one is generated when omitted.',
        },
        allowReslice: {
          type: 'boolean',
          description:
            'Slice a source that was already migrated (retired or transferred). Default false — ' +
            're-slicing a handed-off conversation is how two divergent targets appear.',
        },
      },
      required: ['sourceSessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          preparedId: { type: 'string' },
          digest: { type: 'string' },
          sourceSessionId: { type: 'string' },
          targetSessionId: { type: 'string' },
          boundarySeq: { type: 'integer' },
          sourceLastSeq: { type: 'integer' },
          turnCount: { type: 'integer' },
          pointerCount: { type: 'integer' },
          tapeChars: { type: 'integer' },
          review: { type: 'string' },
        },
        required: ['preparedId', 'digest', 'review'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [
        { type: 'text', text: String(value?.review ?? 'prepared') },
      ],
    },
    execute: async (args: any) => {
      if (!isRecord(args)) throw graftError('INVALID_ARGUMENT', 'arguments must be an object')
      const sourceSessionId = asNonEmptyString(args.sourceSessionId, 'sourceSessionId')
      assertResliceAllowed(sourceSessionId, args.allowReslice === true)
      return prepareSlice(
        ctx,
        settings,
        sourceSessionId,
        typeof args.targetSessionId === 'string' && args.targetSessionId.length > 0 ? args.targetSessionId : undefined,
      )
    },
  })

  ctx.tools.register({
    name: 'graft_commit',
    description:
      'Commit a slice staged by graft_prepare. Verifies that the prepared id is still fresh, that the digest ' +
      'still matches what the user reviewed, and that the source session has not moved on. Only then does it ' +
      'create the target, cold-verify it, and (when configured) retire the source.',
    parameters: {
      type: 'object',
      properties: {
        preparedId: { type: 'string', description: 'The id returned by graft_prepare.' },
        digest: { type: 'string', description: 'The digest shown by graft_prepare, echoed back.' },
      },
      required: ['preparedId', 'digest'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sourceSessionId: { type: 'string' },
          newSessionId: { type: 'string' },
          cwd: { type: 'string' },
          boundarySeq: { type: 'integer' },
          turns: { type: 'integer' },
          constraints: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'newSessionId'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => {
        const parts = [`Committed the reviewed slice to ${String(value?.newSessionId ?? 'the target')}.`]
        if (value?.tailRefreshed !== undefined) {
          const kinds = Array.isArray(value.tailRefreshed.kinds) ? value.tailRefreshed.kinds.join(', ') : 'the open turn'
          const before = Number(value.tailRefreshed.reviewedChars)
          const after = Number(value.tailRefreshed.committedChars)
          const delta =
            Number.isFinite(before) && Number.isFinite(after) ? ` (${before} → ${after} chars)` : ''
          parts.push(
            `Note: ${kinds} changed while the review was open${delta}; the committed tape is newer than the one you approved.`,
          )
        }
        if (Array.isArray(value?.warnings) && value.warnings.length > 0) {
          parts.push(`Warnings: ${value.warnings.length}.`)
        }
        return [{ type: 'text', text: parts.join(' ') }]
      },
    },
    execute: async (args: any) => {
      if (!isRecord(args)) throw graftError('INVALID_ARGUMENT', 'arguments must be an object')
      return commitPreparedSlice(
        ctx,
        settings,
        asNonEmptyString(args.preparedId, 'preparedId'),
        asNonEmptyString(args.digest, 'digest'),
      )
    },
  })

  ctx.tools.register({
    name: 'graft_search_history',
    description:
      'Search a source session log for text, and get back the seq numbers that match. Use this when you ' +
      'need something from the earlier conversation but do not know its seq: search for a keyword ' +
      '(an error string, a file name, a function name), then call graft_read_result with the seq of a hit. ' +
      'Searches assistant messages and tool results. Matching is case-insensitive; set `regex: true` to ' +
      'treat the query as a regular expression. Each hit includes ~50 characters of context either side.',
    parameters: {
      type: 'object',
      properties: {
        sourceSessionId: {
          type: 'string',
          description: 'Source session id whose log should be searched.',
        },
        query: {
          type: 'string',
          description: 'Text to find (case-insensitive substring), or a pattern when `regex` is true.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of hits to return. Defaults to 10.',
        },
        regex: {
          type: 'boolean',
          description: 'Treat `query` as a regular expression instead of a literal substring.',
        },
      },
      required: ['sourceSessionId', 'query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          query: { type: 'string' },
          regex: { type: 'boolean' },
          totalMatches: { type: 'number' },
          totalHits: { type: 'number' },
          truncated: { type: 'boolean' },
          error: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                seq: { type: 'number' },
                type: { type: 'string' },
                offset: { type: 'number' },
                preview: { type: 'string' },
                totalChars: { type: 'number' },
                matchCount: { type: 'number' },
                sourceKind: { type: 'string' },
              },
              required: ['seq', 'type', 'offset', 'preview', 'totalChars', 'matchCount'],
              additionalProperties: false,
            },
          },
        },
        required: ['found', 'query', 'regex', 'totalMatches', 'totalHits', 'truncated', 'hits'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => {
        if (typeof value?.error === 'string' && value.error.length > 0) {
          return [{ type: 'text', text: String(value.error) }]
        }
        if (value?.found !== true) {
          return [{ type: 'text', text: `No match for ${JSON.stringify(value?.query)} in that source session.` }]
        }
        const lines = (value.hits ?? []).map((hit: any) => {
          // Name the density: "×24" tells the reader this event is a bulk dump
          // rather than the one place the phrase was explained.
          const density = hit.matchCount > 1 ? ` ×${hit.matchCount}` : ''
          // v7.4 P1-1: mark a user message as the human's own words. A hit with
          // no source kind is a tool result or an assistant message; only this
          // one can be mistaken for an instruction, so only this one is labelled.
          const author = hit.sourceKind === 'user' ? ' [用户原话]' : ''
          return `seq=${hit.seq}  [${hit.type}]${author}${density}  ${hit.preview}`
        })
        if (value.truncated === true) {
          lines.push(
            `(showing ${(value.hits ?? []).length} of ${value.totalHits} matching events, ` +
              `${value.totalMatches} matches total; narrow the query or raise limit)`,
          )
        }
        lines.push('')
        lines.push('Read one with graft_read_result(sourceSessionId, seq).')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: any) => {
      if (!isRecord(args)) throw graftError('INVALID_ARGUMENT', 'arguments must be an object')
      const rawLimit = args.limit === undefined ? 10 : args.limit
      return graftSearchHistory(
        ctx,
        asNonEmptyString(args.sourceSessionId, 'sourceSessionId'),
        asNonEmptyString(args.query, 'query'),
        asSafeInteger(rawLimit, 'limit'),
        args.regex === true,
      )
    },
  })

  ctx.tools.register({
    name: 'graft_read_result',
    description:
      'Read one payload from a source session log by seq. Two pointer kinds are supported: a tool pointer ' +
      '(`[tool name=xx seq=YY ...]`) reads a tool/result, and a codeblock pointer (`[codeblock seq=YY lines=A-B]`) ' +
      'reads an assistant message. Pass `lineRange` for 1-based inclusive line access to an oversized body. ' +
      'This bypasses cross-session tool authorization and reads the source log directly.',
    parameters: {
      type: 'object',
      properties: {
        sourceSessionId: {
          type: 'string',
          description: 'Source session id that owns the tool result or assistant message.',
        },
        seq: {
          type: 'integer',
          minimum: 0,
          description: 'The seq printed in the tool or codeblock pointer.',
        },
        lineRange: {
          type: 'object',
          description: 'Optional 1-based inclusive line window, for codeblock pointers.',
          properties: {
            start: { type: 'integer', minimum: 1 },
            end: { type: 'integer', minimum: 1 },
          },
          required: ['start', 'end'],
          additionalProperties: false,
        },
      },
      required: ['sourceSessionId', 'seq'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          seq: { type: 'number' },
          text: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          truncated: { type: 'boolean' },
          totalChars: { type: 'number' },
          sourceKind: { type: 'string' },
          lineRange: {
            type: 'object',
            properties: {
              start: { type: 'number' },
              end: { type: 'number' },
              totalLines: { type: 'number' },
            },
            required: ['start', 'end', 'totalLines'],
            additionalProperties: false,
          },
        },
        required: ['found', 'seq', 'text', 'truncated', 'totalChars'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: any) => {
        if (value?.found !== true) {
          return [{ type: 'text', text: `No payload at seq ${String(value?.seq)} in that source session.` }]
        }
        const body = String(value.text ?? '')
        // v7.4 P1-1: state the author when it is not the model.
        //
        // A user/message authored by this plugin or by the host is still readable —
        // the log is a fact — but a reader that treats it as an instruction from the
        // user would be wrong, and it cannot tell without being told.
        const kind = typeof value?.sourceKind === 'string' ? value.sourceKind : undefined
        if (kind === undefined || kind === 'user') {
          const label = kind === 'user' ? '（用户原话，seq=' + String(value.seq) + '）\n' : ''
          return [{ type: 'text', text: label + body }]
        }
        return [
          {
            type: 'text',
            text: `（来源：${kind} —— 这是系统写的，不是用户说的）\n` + body,
          },
        ]
      },
    },
    execute: async (args: any) => {
      if (!isRecord(args)) throw graftError('INVALID_ARGUMENT', 'arguments must be an object')
      const range = isRecord(args.lineRange)
        ? {
            start: asSafeInteger(args.lineRange.start, 'lineRange.start'),
            end: asSafeInteger(args.lineRange.end, 'lineRange.end'),
          }
        : undefined
      return graftReadResult(
        ctx,
        asNonEmptyString(args.sourceSessionId, 'sourceSessionId'),
        asSafeInteger(args.seq, 'seq'),
        100000,
        range,
      )
    },
  })

  /**
   * v0.14 DEBUG PANEL: `graft_debug_status`.
   *
   * Three questions that used to require reading four files by hand:
   *   1. how full is this session, and how far from the 70% nudge / 75% cutoff;
   *   2. is any state lock held, is any migration transaction unfinished, and how
   *      many sessions are retired;
   *   3. what does the memory store hold, and — with `workspace` — which records
   *      the isolation gate would REFUSE for that path ("dirty data").
   *
   * Read-only by construction: the lock sweep runs in `dryRun`, and the memory
   * panel only reads files (`dsh-memory` is never imported, and never written).
   */
  /**
   * v1.0.2 — the model may REWRITE the goal it is working toward.
   *
   * The board used to anchor a chain to the ask that started it, which punished a
   * legitimate narrowing: "先修 P0" evolving into "现在做发布" was read as drift and the
   * next generation was dragged back. The fix is not "forget the original" — it is
   * "record the change". So this tool only rewrites the CURRENT goal, and every rewrite
   * appends `{ at, from, to, reason }` to `goal_evolution`, which the next board prints
   * as "目标曾发生过 N 次演进".
   *
   * It writes the record of the CALLING session (`exec.agent.id`), so it can never
   * rewrite somebody else's goal from a tool call.
   */
  ctx.tools.register({
    name: 'graft_update_goal',
    description:
      'Rewrite the goal THIS session acts on, and record why. The original ask is kept; each change is ' +
      'appended to goal_evolution so the next generation sees that the goal moved. Use it when the work has ' +
      'legitimately narrowed or redirected — not to escape a constraint.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The new goal, one or two sentences, in the user\'s language.' },
        reason: { type: 'string', description: 'Why the goal changed. Recorded verbatim (trimmed to 300 chars).' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    execute: async (args: { goal?: unknown; reason?: unknown }, exec: any) => {
      const goal = String(args?.goal ?? '').replace(/\s+/gu, ' ').trim()
      if (goal.length === 0) return { ok: false, error: 'goal must be a non-empty string' }
      if (goal.length > 2000) return { ok: false, error: 'goal is too long (max 2000 characters)' }
      const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      if (sessionId.length === 0) {
        return { ok: false, error: 'no calling session: this tool rewrites the CURRENT session\'s goal record' }
      }
      const mark = graftTargets.get(sessionId)
      if (mark === undefined) {
        return {
          ok: false,
          error:
            'this session has no graft goal record (it was not created by a slice), so there is nothing to rewrite',
        }
      }
      const from = typeof mark.currentGoal === 'string' ? mark.currentGoal : ''
      if (from === goal) {
        return { ok: true, unchanged: true, currentGoal: goal, revisions: (mark.goalEvolution ?? []).length }
      }
      const reason = String(args?.reason ?? '').replace(/\s+/gu, ' ').trim()
      const evolution = [
        ...(Array.isArray(mark.goalEvolution) ? mark.goalEvolution : []),
        { at: Date.now(), from, to: goal, reason: reason.length === 0 ? '(未说明原因)' : reason.slice(0, 300) },
      ]
      graftTargets.set(sessionId, { ...mark, currentGoal: goal, goalEvolution: evolution })
      persistGraftTargetStore(ctxForStores())
      return {
        ok: true,
        sessionId,
        currentGoal: goal,
        previousGoal: from,
        revisions: evolution.length,
        note: '新目标已落盘；下一次切片的看板会显示它，并注明「目标曾发生过 N 次演进」。',
      }
    },
  })

  /**
   * v1.1 OBSERVER — the tool surface.
   *
   * The console COMMANDS are the UI's channel, but a tool is what the MODEL can call and
   * what the test harness can reach, so both live here and the commands delegate. The
   * follower never gets a tape: `graft_observer_create` only creates a session and writes
   * the pointer.
   */
  const createObserverFor = async (mainSessionId: string): Promise<{ ok: boolean; observerSessionId: string; text: string }> => {
    if (mainSessionId.length === 0) {
      return { ok: false, observerSessionId: '', text: '没有可绑定的主会话 id：请在会话里执行，或传入 mainSessionId。' }
    }
    if (isObserverSession(mainSessionId)) {
      return { ok: false, observerSessionId: '', text: '这是一个副脑会话：它跟随主会话，不能再给它召唤副脑。' }
    }
    const existing = observerOf(mainSessionId)
    if (existing.length > 0) return { ok: true, observerSessionId: existing, text: `该会话已有副脑：${existing}（未重复创建）。` }
    const controller = (() => {
      try {
        return (stableCtx as any).get('sessionController') as any
      } catch {
        return undefined
      }
    })()
    if (!isRecord(controller) || typeof controller.create !== 'function') {
      return { ok: false, observerSessionId: '', text: 'sessionController.create 不可用：当前宿主不支持创建会话。' }
    }
    try {
      const cwd = workspaceOfAgent(stableCtx, mainSessionId)
      const created = await controller.create(cwd.length > 0 ? { cwd } : {})
      const observerSessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      if (observerSessionId.length === 0) {
        return { ok: false, observerSessionId: '', text: `会话创建返回了空 id：${JSON.stringify(created)}` }
      }
      bindObserver(ctxForStores(), mainSessionId, observerSessionId)
      try {
        const abort = new AbortController()
        await controller.prompt(
          {
            requestId: `observer-mission-${Date.now()}`,
            sessionId: observerSessionId,
            mode: 'queue',
            content: [
              {
                type: 'text',
                text:
                  `[副脑启动] 你被绑定为会话 ${mainSessionId} 的观察者（跟随者）。` +
                  '职责：读主会话日志、澄清需求、在控制台可见地提出方案；不直接改代码。' +
                  '主会话转生后你会收到新的绑定目标，身份不变。',
              },
            ],
          },
          abort.signal,
        )
      } catch (error) {
        try {
          ctx.logger?.warn?.(`[dsh-graft-slice] observer mission prompt failed: ${String((error as any)?.message ?? error)}`)
        } catch {
          // The binding is already durable; a missing mission message is cosmetic.
        }
      }
      return { ok: true, observerSessionId, text: `已召唤副脑 ${observerSessionId}，绑定到 ${mainSessionId}。` }
    } catch (error) {
      return { ok: false, observerSessionId: '', text: `创建副脑失败：${String((error as any)?.message ?? error)}` }
    }
  }

  ctx.tools.register({
    name: 'graft_observer_create',
    description:
      'Summon a bound observer (副脑) for a session: creates an ordinary session, records the follower pointer in ' +
      'observer-bindings.json and sends it a one-line mission. The observer is NEVER retired and NEVER sliced — a ' +
      'transfer only rewrites its pointer, which is what keeps the pair deadlock-free.',
    parameters: {
      type: 'object',
      properties: {
        mainSessionId: { type: 'string', description: 'Session to observe. Default: the calling session.' },
      },
      additionalProperties: false,
    },
    execute: async (args: { mainSessionId?: unknown }, exec: any) => {
      const explicit = typeof args?.mainSessionId === 'string' ? args.mainSessionId.trim() : ''
      const mainSessionId = explicit.length > 0 ? explicit : typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      return createObserverFor(mainSessionId)
    },
  })

  ctx.tools.register({
    name: 'graft_observer_status',
    description:
      'Read the follower pointer (who observes whom), plus any pending focus request. Read-only. ' +
      'ackFocus consumes that one-shot request, and exists so the console can say "I have moved the window".',
    parameters: {
      type: 'object',
      properties: {
        ackFocus: { type: 'boolean', description: 'Consume the pending focus request (the console already acted on it).' },
      },
      additionalProperties: false,
    },
    execute: async (args: { ackFocus?: unknown }) => {
      const pending = observerBindings.focus
      if (args?.ackFocus === true) takeObserverFocus(ctxForStores())
      return {
        ok: true,
        bindings: { ...observerBindings.bindings },
        reverse: { ...observerBindings.reverse },
        focus: pending === null ? null : { ...pending },
        ...(args?.ackFocus === true ? { focusConsumed: true } : {}),
      }
    },
  })

  ctx.tools.register({
    name: 'graft_debug_status',
    description:
      'Diagnose this profile from inside a session: token watermark versus the 70% nudge and 75% cutoff, ' +
      'held state locks / unfinished .txn migrations / retired-session count, and the dsh-memory store ' +
      '(skills, negatives, observations). Pass `workspace` to list the memory records that the workspace ' +
      'isolation gate would refuse for that path. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'watermark', 'locks', 'memory'],
          description: 'Which panel to return. Default all.',
        },
        sessionId: {
          type: 'string',
          description: 'Session to measure the watermark for. Default: the session calling this tool.',
        },
        workspace: {
          type: 'string',
          description:
            'Absolute path used by the memory panel to classify records as same-workspace / foreign / unscoped.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: any) => [
        { type: 'text' as const, text: JSON.stringify(value, null, 2).slice(0, 12000) },
      ],
    },
    execute: async (args: any, exec: any) => {
      const requested = isRecord(args) && typeof args.section === 'string' ? args.section : 'all'
      const section = requested === 'watermark' || requested === 'locks' || requested === 'memory' ? requested : 'all'
      const explicitSession = isRecord(args) && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      const sessionId = explicitSession.length > 0
        ? explicitSession
        : typeof exec?.agent?.id === 'string'
          ? exec.agent.id
          : ''
      const explicitWorkspace = isRecord(args) && typeof args.workspace === 'string' ? args.workspace.trim() : ''

      const watermark = sessionId.length > 0 ? await readTokenWatermark(stableCtx, sessionId, settings) : undefined
      const generation = sessionId.length > 0 ? graftGenerationOf(sessionId) : 0
      const graceRemaining = (() => {
        if (sessionId.length === 0) return 0
        const live = stableCtx.sessions.get(sessionId) as any
        const events =
          live !== undefined && typeof live.snapshotEvents === 'function'
            ? (live.snapshotEvents(0) as SessionEventLike[])
            : undefined
        if (!isProtectedGraftTarget(sessionId, events, settings.graftTargetGraceTurns)) return 0
        const completed = events === undefined ? 0 : events.filter((event) => event.type === 'turn/end').length
        return Math.max(0, settings.graftTargetGraceTurns - completed)
      })()

      // dryRun: a diagnostic must not mutate state. What activation DID reclaim is
      // reported separately from lastLockCleanup.
      const locks = scanAndReclaimLocks([dirname(retiredStorePath), PLUGIN_DIR], true)
      const txns = (() => {
        try {
          return readdirSync(txnDirPath)
            .filter((name) => name.endsWith('.json'))
            .map((name) => {
              try {
                const record = JSON.parse(readFileSync(join(txnDirPath, name), 'utf8')) as Record<string, unknown>
                return {
                  name,
                  ...(typeof record.state === 'string' ? { state: record.state } : {}),
                  ...(typeof record.stage === 'string' ? { stage: record.stage } : {}),
                  ...(typeof record.sourceSessionId === 'string' ? { sourceSessionId: record.sourceSessionId } : {}),
                  ...(typeof record.targetSessionId === 'string' ? { targetSessionId: record.targetSessionId } : {}),
                  ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
                }
              } catch {
                return { name, state: 'unreadable' }
              }
            })
        } catch {
          return []
        }
      })()

      return collectDebugStatus({
        section,
        ...(sessionId.length === 0 ? {} : { sessionId }),
        ...(explicitWorkspace.length === 0
          ? sessionId.length > 0 && workspaceOfAgent(stableCtx, sessionId).length > 0
            ? { workspace: workspaceOfAgent(stableCtx, sessionId) }
            : {}
          : { workspace: explicitWorkspace }),
        ...(watermark === undefined ? {} : { watermark }),
        settings,
        generation,
        graceTurnsRemaining: graceRemaining,
        locks,
        lockCleanup: lastLockCleanup,
        retired: [...retiredSessions],
        transferred: [...transferredSessions.entries()].map(([id, value]) => ({
          id,
          newSessionId: value.newSessionId,
          at: value.at,
        })),
        targets: [...graftTargets.entries()].map(([id, mark]) => ({
          id,
          generation: mark.generation,
          sourceSessionId: mark.sourceSessionId,
          createdAt: mark.createdAt,
        })),
        txns,
        memory: resolveMemoryPaths(settings),
      })
    },
  })
}

/** Spec-requested alias for hosts that look for activate(ctx). */
export const activate = apply

// ===========================================================================
// Structural runtime types (erased by the build; kept for TypeScript readers)
// ===========================================================================

interface SessionEventLike {
  type: string
  seq: number
  time?: number
  data?: any
  surfaceOp?: any
  sourceEventSeqs?: any
}

interface SessionHeaderLike {
  id: string
  cwd?: string
  createdAt?: number
  isSeeded?: boolean
  [key: string]: any
}

interface SessionLogSnapshotLike {
  session: SessionHeaderLike
  inheritedEventCount?: number
  events: SessionEventLike[]
}

interface PreparedSessionLike {
  id: string
  header: SessionHeaderLike
  seq: number
  append(type: string, data: any, opts?: any): SessionEventLike
  snapshotEvents(from?: number): readonly SessionEventLike[]
}

interface SessionHandleLike {
  append(events: readonly SessionEventLike[], options?: any): Promise<void>
  flush(options?: any): Promise<void>
  close(): Promise<void>
}

interface SessionPersistenceLike {
  create(header: SessionHeaderLike, options?: any): Promise<SessionHandleLike>
  stat?(id: string): Promise<unknown | undefined>
}

interface SessionStoreLike {
  get(id: string): { id: string } | undefined
  prepare(id: string, options?: any): PreparedSessionLike
}

interface SessionQueryLike {
  readSession(id: string): Promise<SessionLogSnapshotLike>
}

interface ToolRegistryLike {
  register(definition: any): () => void
}

interface PluginContextLike {
  tools: ToolRegistryLike
  sessions: SessionStoreLike
  sessionQuery: SessionQueryLike
  get(name: string): any
  on(name: string, listener: (...args: any[]) => any, options?: any): () => void
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
    error?: (message: string) => void
  }
}

/** Test-only: where the durable stores currently resolve. */
let lastRecovery: { scanned: number; rolledBack: string[] } | undefined

/**
 * v0.14 D5: what the activation lock sweep found and did, so the debug panel can
 * show the reclamation without re-running it.
 */
let lastLockCleanup: LockEntry[] = []

/** Test-only: the lock sweep of the last activation in this process. */
export function debugLastLockCleanup(): LockEntry[] {
  return lastLockCleanup
}

/** Test-only: the recovery result of the last activation in this process. */
export function debugLastRecovery(): { scanned: number; rolledBack: string[] } | undefined {
  return lastRecovery
}

export function debugStorePaths(): { txnDir: string; prepared: string; retired: string } {
  return { txnDir: txnDirPath, prepared: preparedStorePath, retired: retiredStorePath }
}
