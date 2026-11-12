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
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * v1.3 REFACTOR — stateless helpers live in `src/utils/serialize.ts` and are INLINED
 * into index.js by `scripts/build.mjs` (the entry stays one file). Behaviour is
 * unchanged: same bodies, same codes, same messages.
 */
import {
  asFiniteInteger,
  asNonEmptyString,
  asSafeInteger,
  clampRatio,
  graftError,
  isRecord,
  truncateEnd,
  truncateMiddle,
} from './utils/serialize.js'
import { formatAuditLine } from './utils/logger.js'
import type { GraftAuditEntry } from './utils/logger.js'
/**
 * v1.3 batch 2: the file lock lives in src/core/txn.ts. Its audit sink is INJECTED
 * (`setAuditSink`) rather than imported there, so the dependency stays one-way.
 */
import {
  DEFAULT_GROWTH_TOKENS_PER_TURN,
  GRAFT_FIXED_COST_TOKENS,
  WATERMARK_HARD_CEILING,
  WATERMARK_HARD_FLOOR,
  WATERMARK_MIN_GAP,
  WATERMARK_NUDGE_MARGIN,
  calculateSafeWatermark,
  deriveAutoTapeBudget,
  effectiveWatermarks,
  estimateGraftCost,
  estimateTokensFromText,
  readTokenWatermark,
  textOfMessage,
  watermarkCache,
} from './core/watermark.js'
import type { GraftCostEstimate, GraftCostInput, SessionEventLike, TokenWatermark, WatermarkOptions, WatermarkThresholds } from './core/watermark.js'
export {
  calculateSafeWatermark,
  deriveAutoTapeBudget,
  effectiveWatermarks,
  estimateGraftCost,
  estimateTokensFromText,
  readTokenWatermark,
  textOfMessage,
  GRAFT_FIXED_COST_TOKENS,
  DEFAULT_GROWTH_TOKENS_PER_TURN,
  WATERMARK_HARD_CEILING,
  WATERMARK_HARD_FLOOR,
  WATERMARK_MIN_GAP,
  WATERMARK_NUDGE_MARGIN,
}
/**
 * v7.7 TASK-STATE LAYER: the log-reading gates live in `src/core/task-state.ts`.
 *
 * Bare re-export, not `export ... from`: the bundler inlines the module into one scope, so a
 * surviving relative specifier would ship a path that does not exist (see scripts/bundle.mjs).
 */
import { checkSafeHarbor, checkTaskBoundary, extractTaskState, splitSentences } from './core/task-state.js'
import type { HarborState, TaskBoundaryState, TaskState } from './core/task-state.js'
export { checkSafeHarbor, checkTaskBoundary, extractTaskState }
export type { HarborState, TaskBoundaryState, TaskState }
import { ledgerRecord, readJsonRecord, readLedger, readLedgerPayload, writeJsonAtomic, writeLedgerAtomic } from './core/ledger.js'
import type { LedgerDefect } from './core/ledger.js'
import { LEDGER_EPOCH } from './core/ledger.js'
/**
 * Re-exported because it is the plugin's public surface: tests and the disk-only scripts
 * import these from index.js. The bundler inlines ledger.ts, so a BARE export is correct
 * here — `export ... from` would keep a runtime specifier that does not exist.
 */
export { readLedger, readLedgerPayload, readLedgerEpoch, LEDGER_EPOCH }
/**
 * P1-2: the cross-plugin LAYOUT CONTRACT. Re-exported for the same reason as the ledger readers —
 * the tests import from `index.js`, and the bundler inlines `core/layout.ts`, so a bare export is the
 * form that survives.
 */
import {
  GRAFT_LEDGER_FILES,
  GRAFT_LEDGER_LAYOUT_VERSION,
  LAYOUT_MANIFEST_FILE,
  LayoutUnsupportedError,
  MEMORY_LAYOUT_FILES,
  MEMORY_LAYOUT_VERSION,
  assertLayoutSupported,
  readLayoutManifest,
  writeLayoutManifest,
} from './core/layout.js'
export {
  GRAFT_LEDGER_FILES,
  GRAFT_LEDGER_LAYOUT_VERSION,
  LAYOUT_MANIFEST_FILE,
  LayoutUnsupportedError,
  MEMORY_LAYOUT_FILES,
  MEMORY_LAYOUT_VERSION,
  assertLayoutSupported,
  readLayoutManifest,
  writeLayoutManifest,
}
import {
  LOCK_SETTLE_MS,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  acquireFileLock,
  lockDirFor,
  lockTraceReset,
  lockTraceSnapshot,
  setAuditSink,
  sleepSync,
  withFileLock,
} from './core/txn.js'
/**
 * ── THE LOCK COUNTER IS EXPORTED, AND THAT IS A DELIBERATE CONTRACT CHANGE ──────────────────────
 *
 * `lockTraceSnapshot` / `lockTraceReset` are the T2f instrument: with `DSH_LOCK_TRACE=1` they report
 * how many times a turn takes a lock and on which files. They were written into `core/txn.ts` and then
 * were NOT reachable from the bundle — the count came back as "not observable", which for a
 * measurement is the same as a missing row.
 *
 * The alternative was to keep them private and re-measure by editing code, i.e. by changing the thing
 * under measurement. Exporting two read-only functions is cheaper and more honest, and it is exactly
 * what the export-surface gate exists to make VISIBLE rather than accidental: this commit carries
 * `[export-change]`, and the baseline records 182 instead of 180.
 *
 * Neither function does anything when `DSH_LOCK_TRACE` is unset, so the shipped behaviour is unchanged.
 */
export { lockTraceReset, lockTraceSnapshot }

/**
 * v1.4 — THE PLUGIN'S PRIVATE STATE LIVES IN ONE MODULE (`src/core/state.ts`).
 *
 * Every collection here is process-local bookkeeping this plugin owns: the retirement ledgers
 * mirrored in memory, the auto-graft queue, the goal chain, the constraint carry-over, and the
 * ignition records. They were declared in this file, thousands of lines apart, which made "what does
 * this plugin remember?" a question you answered by grepping 12 000 lines.
 *
 * DECLARING THEM ELSEWHERE CHANGES NOTHING AT RUNTIME. The bundle inlines every module into one
 * scope, so these are the same `Map`/`Set` objects either way — same identity, same mutations. What
 * changes is that the boundary is now a fact of the file layout: exactly one module can name them.
 *
 * WHAT DID *NOT* MOVE, AND WHY: the store PATHS (`retiredStorePath`, `txnDirPath`, …). An imported
 * binding is read-only in the importer, and `configureRetiredStore` REASSIGNS those paths when a
 * profile is resolved — moving them would silently pin every store to the plugin directory instead of
 * the profile. Collections are only mutated, never rebound, which is why they are safe to move.
 */
import {
  PLUGIN_DIR,
  LEFTOVER_CAP,
  autoGraftInFlight,
  autoGraftStates,
  autoGraftSuppressedUntil,
  constraintsApplied,
  constraintsInFlight,
  constraintsReasserted,
  deferredOverflowTargets,
  draftPayloads,
  forcedCutMarks,
  graftTargets,
  guardReasserted,
  ignitionAdmissions,
  inFlight,
  leftoverTargets,
  modelDrivenNudgeTurns,
  overflowRetries,
  pendingConfirms,
  pendingConstraints,
  pendingGraftSources,
  pendingIgnitions,
  planNudgeStates,
  rememberPlanNudge,
  preparedSlices,
  retiredSessions,
  rollbackNotices,
  rollbackNoticed,
  targetConstraintSections,
  taskBoundaryDeferrals,
  transferredSessions,
  transitionCards,
  watermarkEscalated,
  watermarkEscalations,
} from './core/state.js'
import type { GraftTargetMark, LeftoverTarget, PlanNudgeState, PreparedSlice } from './core/state.js'

/**
 * ── THE STORE LAYER (S3-P4) ─────────────────────────────────────────────────────────────────────
 *
 * `createStoreLayer` resolves the profile's store directory and returns ONE frozen path set; it imports
 * nothing from this file (the structural types it needs live in `core/gateway-types.ts`, moved there in
 * P0 precisely so this import cannot close a cycle). `fallbackDir` is supplied here rather than computed
 * inside the layer: in TS source the layer's `import.meta.url` is `src/core/`, while the bundle inlines
 * it beside this file — the fallback must agree with the bundle, which is what ships.
 */
import { createStoreLayer } from './core/store-layer.js'
import type { StoreLayer, StorePaths } from './core/store-layer.js'

/** Re-exported: part of the plugin's public surface (tests import it). */
export { graftError }
/**
 * v1.3 batch 2: the lock primitives moved to src/core/txn.ts but stay re-exported here —
 * the plugin's public surface must not change because a file moved.
 */
export { acquireFileLock, withFileLock, sleepSync, lockDirFor, LOCK_STALE_MS, LOCK_TIMEOUT_MS }
/**
 * v2.2.0: the audit sink is re-exported so a caller (and a test) can observe WHY a lock was
 * reclaimed. The stale rule now probes the holder's pid instead of trusting the timestamp,
 * and the one case where that probe is deliberately overridden (`lock-stale-forced`, after
 * the pid-reuse cap) must be visible rather than inferred from a missing file.
 */
export { setAuditSink }
export type { GraftAuditEntry }

/**
 * v7.6 — THE IGNITION BLOCK MOVED TO `src/core/ignition.ts` (723 lines out of this file).
 *
 * THE SPLIT, AND WHY IT LANDS THERE
 *
 * The question asked of every line was: is this a fact about talking to a host, or a fact about graft's
 * own bookkeeping?
 *
 *   → `dsh-paradise` owns the CHANNEL: marker, prompt text, AbortSignal-as-timeout, the two channels,
 *     "an unreadable log is UNKNOWN rather than already-done". Identical in spirit to what the observer
 *     needs, so it belongs to the layer.
 *
 *   → `src/core/ignition.ts` owns the POLICY: the per-TARGET admission map (so two grafts finishing in
 *     the same tick cannot both prompt), the retry's liveness checks, the durable pending queue, and the
 *     rollback that un-retires a source. All of it reads graft's own state, and none of it means
 *     anything to another plugin.
 *
 * THE STATE MOVED TO `src/core/state.ts` LATER, not in this step. v7.6 left the maps here; the v1.4
 * pass declared them in one module so the plugin's private bookkeeping has a boundary a second plugin
 * can see at a glance. Nothing about HOW they are reached changed: this file imports them, mutates them,
 * and `ignition.ts` still receives them through the same injected resolver — the one-way shape
 * `core/txn.ts` uses for its audit sink, for the same reason (the bundler inlines both into one scope,
 * where a reverse import is a temporal-dead-zone crash rather than a build error).
 *
 * SIGNATURES DID NOT CHANGE. Seven of these functions are called by four test files and by the
 * activation path; a `deps` argument would have meant editing 21 test cases for a refactor whose whole
 * promise is to be invisible. The resolver is registered at the END of this file, once every declaration
 * exists, and every signature stays as it was.
 */
import {
  DEFAULT_IGNITION_PROMPT,
  IGNITION_MARKER,
  IGNITION_MAX_ATTEMPTS,
  ROLLBACK_NOTICE,
  ROLLBACK_NOTICE_MARKER,
  alreadyIgnited,
  attemptIgnition,
  buildIgnitionPrompt,
  describePromptFailure,
  igniteTargetSession,
  ignitionDeadline,
  ignitionExhausted,
  isIgnitionText,
  loadPendingIgnitions,
  persistPendingIgnitions,
  resumePendingIgnitions,
  rollbackFailedIgnition,
  setIgnitionDepsResolver,
  takeRollbackNotice,
} from './core/ignition.js'
import type { IgnitionDeps, IgnitionResult, IgnitionRollback, PendingIgnition } from './core/ignition.js'

export {
  DEFAULT_IGNITION_PROMPT,
  IGNITION_MARKER,
  IGNITION_MAX_ATTEMPTS,
  ROLLBACK_NOTICE,
  ROLLBACK_NOTICE_MARKER,
  alreadyIgnited,
  attemptIgnition,
  buildIgnitionPrompt,
  describePromptFailure,
  igniteTargetSession,
  ignitionDeadline,
  ignitionExhausted,
  isIgnitionText,
  loadPendingIgnitions,
  persistPendingIgnitions,
  resumePendingIgnitions,
  rollbackFailedIgnition,
  takeRollbackNotice,
}
export type { IgnitionResult, IgnitionRollback, PendingIgnition }

/**
 * THE IGNITION STATE LIVES IN `src/core/state.ts`.
 *
 * It stayed behind when the ignition FUNCTIONS moved to `core/ignition.ts` in v7.6 because code this
 * file still owns reads it: the pre-step gate consults `ignitionAdmissions`, the debug-status tool
 * serialises `pendingIgnitions`, and `configureRetiredStore` resets all of them. The declarations now
 * live with every other piece of the plugin's private state; this file imports them (see the block at
 * the top of the module) and `core/ignition.ts` still reaches them through the injected resolver.
 */
/** Where the pending-ignition queue is persisted; set by `configureRetiredStore`. */
/**
 * v7.6 — THE HOST-SHAPE LAYER MOVED TO `src/core/host-shape.ts` (~900 lines out of this file).
 *
 * WHAT LEFT: the identity metadata, the four message constructors, `materializeTape` with its surface
 * assertions, `buildInjectionEvents`, `assertColdLog`, `extractActiveGoalChange`, and the system-head
 * prompt with its workspace red line.
 *
 * WHAT STAYED, DELIBERATELY: `buildTape`, `buildInjectionPlan` and everything they call — the goal, the
 * board, the constraints, the carryover, the codeblock pointerisation. Those decide WHAT a handoff says,
 * which is graft's policy, not the runtime's shape. The dependency count is what settled it: the plan
 * builders touch 59 outside symbols including live state; the shape layer touches 11, and after this move
 * all eleven are TYPES plus one `const` string.
 *
 * EVERY SYMBOL IS RE-EXPORTED because it is the plugin's public surface: the test suite imports these
 * names from index.js, and a file move must not rename anything.
 */
import {
  GRAFT_CHAIN_GRACE_TURNS,
  IDENTITY_METADATA_MARKER,
  MIGRATION_SYSTEM_PROMPT,
  assertColdLog,
  assertLogOnly,
  assertMessageSurface,
  assertSessionSummary,
  assertTopLevelHeader,
  buildInjectionEvents,
  extractActiveGoalChange,
  extractRuntimeIntent,
  injectionSource,
  materializeTape,
  migrationSystemPrompt,
  parseIdentityMetadata,
  renderIdentityMetadata,
  workspaceRedline,
} from './core/host-shape.js'
import type { GraftIdentity } from './core/host-shape.js'
export {
  GRAFT_CHAIN_GRACE_TURNS,
  IDENTITY_METADATA_MARKER,
  MIGRATION_SYSTEM_PROMPT,
  assertColdLog,
  assertLogOnly,
  assertMessageSurface,
  assertSessionSummary,
  assertTopLevelHeader,
  buildInjectionEvents,
  extractActiveGoalChange,
  extractRuntimeIntent,
  injectionSource,
  materializeTape,
  migrationSystemPrompt,
  parseIdentityMetadata,
  renderIdentityMetadata,
  workspaceRedline,
}
export type { GraftIdentity }

/** Cordis plugin name. */
/* ── THE TEST-SEAM SURFACE ────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS IS: exported readers and resets that exist because the TEST SUITES must observe state the
 * plugin keeps to itself — the retirement/transfer ledgers, the graft-target marks, the ignition
 * admission table, the workspace snapshot. None of them is a feature and none is called by production
 * code (`verify-bundle`/`scripts` measure that: see below).
 *
 * THE SEAMS THIS MODULE SURFACE PINS (`test/v103-seam-inventory.test.mjs`):
 *   `getTransferredSessions`, `getRetiredSessions`, `getGraftTargets`, `getPendingIgnitions`,
 *   `hasIgnitionAdmission`, `markIgnitionAdmission`, `getIgnitionAdmissions`,
 *   `extractWorkspaceState`, `clearGraftTargetsForTest`, `extractGoalForTest`,
 *   `resetRetiredSessions`, `resetParadiseWriteCache`.
 *   (Until 2026-11-08 this list also carried three `debug*` readers with NO consumer at all —
 *   `debugLastLockCleanup`, `debugLastRecovery`, `debugStorePaths`. 批次 3 第 2 组 deleted them; the
 *   module variables they read stayed, because the lock sweep and the recovery pass still write them.)
 *
 * THEY ARE NOT PUBLIC API. A change here is not a breaking change.
 *
 * `scanAgentCommand` IS NOT ONE OF THEM, and the distinction is the useful part of this note: it is
 * referenced by `scripts/check-docs.mjs` and named in README, so it is a DOCS-GATE contract, not a
 * test seam. Deleting it as "test-only" would break the documentation checker.
 *
 * WHY THE LOCK HERE IS A SUBSET: this entry exports 185 names. Pinning all of them would be noise, so
 * the rule is proportionate and stated: **the full surface is pinned where it is small enough to read
 * (16 names in dsh-observer, 31 in dsh-memory); the seam-shaped subset is pinned where the entry is a
 * monolith.** The rule it enforces is the same everywhere: a seam cannot appear by accident, and
 * giving a test-only export a production-sounding name is what the convention check refuses.
 */
export const name = 'dsh-graft-slice'

/**
 * v7.7 — THE PHYSICAL WRITE GOES THROUGH `dsh-paradise`.
 *
 * `ensureParadiseWrite` resolves the layer LAZILY (a static bare import would survive into this
 * single-file bundle and make an absent package fatal at load, before any test could say why), caches the
 * answer including a failure, and returns a NAMED refusal instead of throwing.
 * `PARADISE_WRITE_MISSING_CONSEQUENCE` is the one sentence every caller prints, so a user sees the same
 * instruction wherever the gap is reported.
 */
import {
  PARADISE_WRITE_MISSING_CONSEQUENCE,
  ensureParadiseWrite,
  hasParadiseWriteProvider,
  paradiseSpecifiers,
  resetParadiseWriteCache,
  setParadiseWriteProvider,
  unavailableWriteBinding,
} from './core/paradise-write.js'
import type { ParadiseWriteBinding, ParadiseWriteProvider } from './core/paradise-write.js'

/**
 * THE HOST GATEWAY — the seam that lets this plugin run where there is no host.
 *
 * Exported from the plugin entry (not only from `core/`) because the consumer that needs it imports the
 * PLUGIN: a bare-machine runner binds an adapter and then calls the migration entry point. Without this
 * export it would have to reach into internals, which is how a seam becomes an accident.
 */
import { hasHostGateway, resolveGateway, setHostGateway } from './core/host-gateway.js'
import type { HostGateway } from './core/host-gateway.js'
export { hasHostGateway, setHostGateway }
export type { HostGateway }

/**
 * v7.7 — THE BRIDGE'S PUBLIC SURFACE.
 *
 * WHY THESE ARE EXPORTED AND NOT MERELY IMPORTED: the degradation path is the interesting one, and it
 * is the one a test (or an operator replacing the layer mid-session) must be able to exercise. Without
 * `resetParadiseWriteCache` there is no way to ask "what happens if the layer is absent NOW?" — and
 * that question is exactly how a silent fallback would hide. `paradiseSpecifiers` is exported so the
 * resolution ORDER is assertable rather than assumed, and `unavailableWriteBinding` so a caller can
 * prime the real failure shape instead of inventing one.
 */
export {
  PARADISE_WRITE_MISSING_CONSEQUENCE,
  ensureParadiseWrite,
  hasParadiseWriteProvider,
  paradiseSpecifiers,
  resetParadiseWriteCache,
  setParadiseWriteProvider,
  unavailableWriteBinding,
}
export type { ParadiseWriteBinding, ParadiseWriteProvider }

/**
 * Hard service dependencies. sessionPersistence is required for a durable
 * handoff: a bare ctx.sessions.create session is not persisted in rc.5.
 */
export const inject = ['tools', 'sessions', 'sessionQuery', 'sessionPersistence']

// ===========================================================================
// Public types
// ===========================================================================

export type { GraftConfig } from './core/graft-config.js'

/** Producer-owned message source. Falls back to the legal `plugin:graft` namespace. */
export type { GraftBoundary, GraftSource, GraftTape, GraftTapeTurn } from './core/tape-shape.js'

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
 *
 * v7.6: DECLARED IN `core/host-shape.ts` (which cannot import it without a cycle), and imported +
 * re-exported here so the constant still has exactly ONE definition in the bundle.
 */
import { GRAFT_REPLAY_SOURCE_KIND } from './core/host-shape.js'
import { CONSTRAINT_PATTERN, STANDING_PROHIBITION } from './contracts/model-wording.js'
import { shapeOfConstraint } from './core/constraint-shape.js'
export { GRAFT_REPLAY_SOURCE_KIND }

/** Whether a message source was written by this plugin's replay injector. */
import { isGraftAuthored, isHumanAuthored } from './core/message-source.js'

export { isGraftAuthored, isHumanAuthored }

/**
 * v7.4b (硬约束 8): a message the HUMAN actually typed.
 *
 * `role: "user"` is not evidence of a human. The standing-constraint
 * re-assertion, the skill catalog, the time stamp and the runtime snapshot all
 * arrive with that role; the plugin's own replays do too. The only strict test
 * is the source kind, so exactly one value qualifies. Everything else is an
 * injection and must never be read as an instruction.
 */

/**
 * One tape turn after extraction.
 *
 * v7.0: a turn is now a *replay script*, not a prose blob. `text` remains the
 * rendered legacy form (kept for older callers and for the pending-state
 * builder), while `replay` carries the structured user → assistant → pointer
 * flow the target actually re-reads.
 */

/** Result of phase one. */

/** Result of phase two, before chunk budgeting. */

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
    /**
     * v1.7.0 — WHAT THE MEMORY STORE ALREADY KNOWS.
     *
     * A handoff replays what the SOURCE SESSION did. It says nothing about what the ORGANISATION
     * learned: the SKILL.md that describes the working method, or the negative that records why the
     * obvious approach fails. Those live in `dsh-memory`, and without this chunk every new session
     * rediscovers them — which is the exact cost the memory layer exists to avoid.
     *
     * It is a SEPARATE kind rather than being folded into `pending-state` because the two have
     * different lifetimes: pending state is about THIS task, memory is about every task before it.
     * Mixing them would make a slice's context budget hide which one it starved.
     */
    | 'memory-context'
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
// v1.3 (first batch): graftError / isRecord / asNonEmptyString / asSafeInteger /
// asFiniteInteger / truncateEnd / truncateMiddle / clampRatio / Truncation moved to
// src/utils/serialize.ts, imported at the top of this file. Bodies unchanged.

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
    /**
     * v2.2.0 (audit F1): RECORD WHETHER THE COUNT WAS ASKED FOR OR DEFAULTED.
     *
     * `input.recentTurns` being present and finite looks like the whole test, and it is not —
     * because `normalizeConfig` is called MORE THAN ONCE on the same value. `apply()` normalizes
     * the operator's config and passes it down; `buildInjectionPlan` then calls `normalizeConfig`
     * again on that result, at which point the DEFAULT it wrote (5) is indistinguishable from a
     * value the operator named, and everything downstream treats it as explicit.
     *
     * So an already-normalized input is recognized and its verdict CARRIED OVER, instead of being
     * re-derived. The marker is `recentTurnsExplicit` itself: it exists only on normalized configs.
     * Without this, `apply()` with no `recentTurns` at all would report "explicit" and the adaptive
     * depth would stop working for everybody.
     *
     * The rule stated plainly: EXPLICITNESS IS A PROPERTY OF THE CALLER'S INPUT, and it must survive
     * being passed through this function more than once.
     */
    recentTurnsExplicit:
      input.recentTurnsExplicit !== undefined
        ? input.recentTurnsExplicit === true
        : input.recentTurns !== undefined && Number.isFinite(Number(input.recentTurns)),
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
    /**
     * 10 minutes by default. `asFiniteInteger` maps a non-numeric/absent value to the fallback, so the
     * documented "0 / Infinity disables it" is handled at the COMPARISON site (`checkSafeHarbor` treats
     * `<= 0` and `Infinity` as "no limit") rather than by special-casing the parser.
     */
    harborOpenCallMaxAgeMs: asFiniteInteger(input.harborOpenCallMaxAgeMs, 600_000, 'harborOpenCallMaxAgeMs'),
    /**
     * `'never'` keeps today's behaviour exactly: no focus transfer from this plugin. `'always'` and
     * `'manual-only'` are ACCEPTED AND RECORDED but **not implemented** — see TD-10. Recording them
     * rather than rejecting them lets a profile declare its intent, and the config is validated so a typo
     * cannot silently fall back.
     */
    focusAfterGraft:
      input.focusAfterGraft === 'always' || input.focusAfterGraft === 'manual-only'
        ? input.focusAfterGraft
        : 'never',
    // v0.9.5 (TD-11): parsed and carried, wired to NOTHING. Both values behave identically
    // today; the field exists so the intended shape is on record before it is built.
    handoverEditable: input.handoverEditable === true,
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

import { nearDuplicate, normalizeText, normalizedEqual, tokenSet } from './core/text-normalize.js'

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


/**
 * v5.2: pointers are prose now, and they sit inline inside the assistant's
 * sentence rather than on their own line. Detection therefore scans the whole
 * text: both the legacy bracketed form and the humanized "（注：… seq=N）"
 * form name a seq the reader can hand to graft_read_result, which is the
 * stable signal in either shape.
 */
const POINTER_INLINE_PATTERN = /\[tool name=[^\]]*seq=\d+[^\]]*\]|graft_read_result[^)]*seq=\d+/gu

function pointerSentences(text: string): string[] {
  return text.match(POINTER_SENTENCE_PATTERN) ?? []
}

// CONSTRAINT_PATTERN: 单一出处 = src/contracts/model-wording.ts（契约名 WIDE_CONSTRAINT）

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
 *   1. 删除危险脚本：立刻删除 <workspace>\repair-log.cjs，绝不能让这个无备份、
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
// STANDING_PROHIBITION: 单一出处 = src/contracts/model-wording.ts（契约名 PROHIBITION_PLUS_ACT）

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

/**
 * ── A CONSTRAINT REJECTED FOR ITS SHAPE, NOT FOR ITS SIZE ────────────────────────────────────────
 *
 * `dropped` means "qualified but did not fit the budget" — a CAPACITY problem the caller can fix by
 * raising the knob. This is a different thing: the text is not a sentence at all (a JSON fragment, a
 * table row, a term list). Reporting both through one field would invite "raise the budget" as the
 * answer to garbage, which is exactly the reasoning that let five fragments into seven generations.
 *
 * Keeping it separate is also the "no silent dropping" rule: every rejected item is recorded with its
 * code, so a reader can audit what the filter ate.
 */
export interface ConstraintShapeDrop {
  text: string
  /** `S1_JSON` … `S6_SEPARATORS`, from `core/constraint-shape.ts`. */
  code: string
  why: string
  /** Where the text was seen: extraction, inheritance, session acceptance, or the section ledger. */
  stage: 'extract' | 'inherit' | 'accept' | 'ledger'
}

export interface ConstraintSelection {
  constraints: string[]
  /** Rules that qualified but did not fit. Non-empty means: do not ship. */
  dropped: ConstraintDrop[]
  /**
   * Text rejected because it is not a standalone sentence. NOT a budget problem: raising
   * `constraintBudgetChars` must not bring these back.
   */
  droppedByShape: ConstraintShapeDrop[]
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
  /**
   * ── B2: THE PROMPT SLOT'S TICKET MUST BE AS STRICT AS EXTRACTION ─────────────────────────────
   *
   * Extraction and slot allocation used to judge the same text by two different standards: extraction
   * asked "does it look like a rule", allocation asked "is it short and does it contain 绝对/never".
   * A pasted keyword list satisfies the SECOND perfectly — it is short and made of exactly those
   * words. So even a correct extraction gate would be defeated here: garbage that slipped through one
   * layer would occupy the five prompt slots reserved for red lines.
   *
   * One predicate, used by both. `shapeOfConstraint` is not a second opinion; it is the same one.
   */
  if (shapeOfConstraint(text).broken) return false
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
    droppedByShape: [],
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

/**
 * ── THE READ-BACK INVARIANT (B4) ────────────────────────────────────────────────────────────────
 *
 * `readBack ⊆ extracted ∪ droppedByShape`: every inherited constraint is either kept or recorded.
 *
 * Why this is an ASSERTION and not a test-only check: the two ways it can be violated are both
 * silent. Add a path that pushes an inherited rule into the pool without judging it, and garbage
 * travels again; add a path that discards one, and a user's rule disappears with no record. Neither
 * shows up in the output of a healthy run — only in a corpus that happens to contain the case.
 */
function assertReadBackAccounted(selection: ConstraintSelection, shapeDrops: readonly ConstraintShapeDrop[]): void {
  const droppedTexts = new Set(shapeDrops.map((drop) => drop.text))
  const keptTexts = new Set([...selection.constraints, ...selection.archived])
  const inheritedDrops = shapeDrops.filter((drop) => drop.stage === 'inherit')
  for (const drop of inheritedDrops) {
    if (keptTexts.has(drop.text)) {
      throw graftError(
        'INTERNAL_INVARIANT',
        `read-back invariant violated: "${drop.text.slice(0, 60)}" was both rejected (${drop.code}) and kept`,
      )
    }
  }
}

export function extractConstraintsDetailed(
  events: readonly SessionEventLike[],
  budgetChars: number = CONSTRAINT_BUDGET_CHARS,
): ConstraintSelection {
  const candidates: ConstraintCandidate[] = []
  /** Everything the shape gate rejected, with its code. Never silently discarded. */
  const droppedByShape: ConstraintShapeDrop[] = []
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
          /**
           * ── B3: A CONSTRAINT READ BACK FROM AN EARLIER GENERATION IS RE-JUDGED ────────────────
           *
           * This is the ONLY place where damage becomes permanent: `score: 100` puts an inherited
           * rule straight into the pool, above everything the current turn produces. Measured on the
           * live ledger, five fragments entered here in generation 8 and would have been copied into
           * every generation after it, never re-read and never re-judged.
           *
           * ── WHY THIS DOES NOT CONTRADICT v7.0 ("do not rescore, or it drifts per generation") ──
           *
           * v7.0 forbids RESCORING, because a score is a RELATIVE IMPORTANCE and relative order would
           * drift as the word lists change. This is not a score: "is `"绝对约束（…）：",` a sentence at
           * all?" has the same answer in generation 1 and generation 8 — it is a property of the text,
           * not of the chain. **Correction is allowed; re-ranking is not.** The score stays 100.
           */
          const inheritedShape = shapeOfConstraint(constraint)
          if (inheritedShape.broken) {
            droppedByShape.push({
              text: constraint,
              code: inheritedShape.code ?? 'S1_JSON',
              why: inheritedShape.why ?? '',
              stage: 'inherit',
            })
            continue
          }
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
      /**
       * ── B1: THE STRUCTURAL GATE, AND WHY IT SITS HERE ─────────────────────────────────────────
       *
       * Placed BEFORE the keyword test on purpose. A pasted report is made of constraint vocabulary,
       * so every word-based test downstream would accept it — running the shape check first is what
       * makes the outcome independent of how many emphasis words the fragment happens to contain.
       *
       * The rejection is RECORDED, not merely skipped: `droppedByShape` is what lets a reader answer
       * "why did my rule disappear" without re-running the extractor by hand.
       */
      const shape = shapeOfConstraint(normalized)
      if (shape.broken) {
        droppedByShape.push({ text: normalized, code: shape.code ?? 'S1_JSON', why: shape.why ?? '', stage: 'extract' })
        continue
      }
      const hasKeyword = isConstraintSentence(normalized)
      const hasImperative = IMPERATIVE_START.test(normalized)
      if (!hasKeyword && !hasImperative) continue
      if (isQuestionLike(normalized)) continue
      if (!ACTION_PATTERN.test(normalized)) continue
      if (candidates.some((candidate) => nearDuplicate(candidate.text, normalized))) continue
      const hard = /(\bmust\b|\bnever\b|\bdon't\b|\bdo not\b|\bcannot\b|\balways\b|\bonly\b|必须|禁止|绝对|不能|不得|务必)/iu.test(normalized) ? 2 : 0
      /**
       * ── v0.9.7: THIS USED TO BE A SECOND, TRUNCATED COPY OF `IMPERATIVE_START` ─────────────────
       *
       * The line here was an inline `^(请|必须|禁止|…|\bend\b|\breply\b)` — a 165-character prefix of
       * the 351-character `IMPERATIVE_START` declared above. Measured (`_scratch/measure-1359-1680.mjs`):
       *
       *     common prefix   = 164 chars  → 46.7% of the original
       *     verbs dropped   = 19  (add avoid call choose draft end ensure exclude keep
       *                            leave make pick prefer remove report return run set show wait)
       *
       * So the same sentence was asked "are you an imperative opening?" TWICE and could get two
       * answers: the GATE at `hasImperative` used the full list, this SCORER used the truncated one.
       * `prefer X` passed the gate and then earned +0 instead of +2 — measured score 3 vs 5, a 2-point
       * deficit on a scale of 1..7, in the number that decides which rules fill a fixed prompt budget.
       *
       * It is ONE question. It now has ONE list.
       */
      const imperative = IMPERATIVE_START.test(normalized) ? 2 : 0
      const actionHits = (normalized.match(ACTION_PATTERN) ?? []).length
      const lengthBonus = normalized.length >= 20 && normalized.length <= 240 ? 1 : 0
      const scopeBonus = (messageScope ? 6 : 0) + (SESSION_SCOPE_PATTERN.test(normalized) ? 4 : 0)
      candidates.push({ text: normalized, index: index++, score: hard + imperative + actionHits + lengthBonus + scopeBonus })
    }
  }
  const selection = selectConstraints(candidates, budgetChars)
  /**
   * Carried on the SELECTION, not thrown away: the caller renders the handoff, and a dropped rule it
   * cannot see is a rule the user cannot argue with.
   */
  const combined: ConstraintSelection = {
    ...selection,
    droppedByShape: [...selection.droppedByShape, ...droppedByShape],
  }
  /**
   * ── B4: THE INVARIANT — readBack ⊆ extracted ∪ droppedByShape ─────────────────────────────────
   *
   * Everything that came back from an earlier generation must either enter the pool or appear in
   * `droppedByShape`. There is no third path. Without this assertion a future edit could add a
   * shortcut that quietly pushes an inherited rule into `candidates` (or quietly discards one), and
   * nothing would notice: both directions are invisible in the output.
   *
   * It runs in production, not only in tests, because the failure it guards is a SILENT one. The cost
   * is one Set over a few dozen short strings, on a path that runs once per handoff.
   */
  assertReadBackAccounted(combined, droppedByShape)
  return combined
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
 * v7.7: `TaskState` / `extractTaskState` and the todo + report helpers moved to
 * `src/core/task-state.ts`. Re-exported below, so every existing importer is unaffected.
 */

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
  /**
   * ── v7.4 P4-1 tool pointers, which the INTERFACE forgot ────────────────────────────────────────
   *
   * `tsc` reported seven diagnostics (2551 ×4, 2561 ×3) all saying the same thing:
   * `Property 'toolPointers' does not exist on type 'AssistantRecord'. Did you mean 'pointers'?`
   *
   * ── THE RUNTIME WAS ALWAYS RIGHT; THE DECLARATION WAS BEHIND IT ─────────────────────────────────
   *
   * Measured before editing: `toolPointers` appears 7 times in this file, and every place that PUSHES
   * an assistant record initialises it — 3 sites write `pointers: [], toolPointers: []`. So the field
   * existed on every object the code ever built, and `target.toolPointers.some(...)` never threw.
   * The only thing missing was the type, which is why nothing ever failed: `stripTypeScriptTypes`
   * erases the interface, and tests exercise the objects, not the declaration.
   *
   * That makes this the mirror image of the `goal-extraction` defect: there a real export was missing
   * and the code still worked by accident; here a real field was undeclared and the code worked on
   * purpose. Both were invisible to tests, and both are what `tsc --noEmit` is for.
   *
   * Type narrowed to what the constructor pushes: `{ name, seq, isError?, unavailable? }`.
   */
  toolPointers: Array<{
    name: string
    seq: number
    isError?: boolean
    unavailable?: boolean
  }>
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

import { currentDagNode, extractGoal, objectiveOf } from './core/goal-extraction.js'
import type { GoalLayer, GoalResult } from './core/goal-extraction.js'

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
/**
 * ── C1: WHERE THE GOAL COMES FROM, IN PRIORITY ORDER ────────────────────────────────────────────
 *
 * The goal field's semantics were never defined, and the same omission caused two measured failures:
 * a FINISHED initial request labelled 「当前要做的事」 (the target re-did the whole task), and a pasted
 * REPORT rendered as 「原始用户要求」 (the target answered a report it was never given).
 *
 * The ruling settles it: the goal is the session's TASK, then the STRUCTURE it sits in, and only then
 * a guess from the transcript. The three layers carry different things and are never blended:
 *
 *   task       goal/change objective — what the session was set to do
 *   structure  the DAG's current node and blocker — where it is, ONE node only
 *   transcript the last substantive human messages — a fallback, arrives with a seq pointer
 *
 * \`goalLayer\` records WHICH layer answered, so a reader (and a test) can tell a declared objective from
 * an inferred one. Without it, "the goal is X" is indistinguishable from "I guessed X".
 */

/**
 * Layer 1: the session's own objective.
 *
 * \`extractActiveGoalChange\` already answers "is there an ACTIVE goal", and it deliberately returns
 * undefined for a clear/complete/abandon tail — a finished goal must not be resurrected as this
 * session's task. That is exactly what layer 1 needs, so it is reused rather than re-derived.
 */

/**
 * Layer 2: the DAG's current node — ONE node, as a boundary.
 *
 * Hard rule 1 in code: this returns a single line. Node bodies (a full SKILL.md, historical
 * observations, the dependency chain) are NOT carried. A node is a signpost, not luggage; dragging its
 * contents into the goal message spends the target's window on structure instead of work.
 *
 * \`memory_graph_read\` renders nodes as \`- [Node] id — title\` inside a phase block. This takes the
 * first node whose title does not already say done/completed, which is "current" by the graph's own
 * ordering, and keeps only id + title.
 */


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
export function extractGoalForTest(events: readonly SessionEventLike[], dagText?: string): GoalResult {
  return extractGoal(events, dagText)
}

/**
 * C1 hard rule 1 is exercised through `extractGoalForTest` (see the `dagText` parameter), so it needs
 * no export of its own: `verify-bundle` keeps the surface at 182.
 */

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
  /**
   * TD-11: the pending list came from the model's `handover`, not from the transcript.
   *
   * Threaded as a boolean rather than as the list itself: the caller has already substituted the
   * items into `openTodos`, and the board only needs to know how to LABEL them.
   */
  pendingFromModel = false,
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
  //
  // v0.9.3: the generation comes from the MARK, not from counting blocks. Same source as
  // `plan.generation` -> `goalMessage`'s `graft_generation`, so the card and the goal of one
  // handoff cannot disagree about which generation this is.
  //
  // Read HERE rather than threaded in as a new `buildTape` parameter: the mark of the source
  // session is a fact about the log we were handed, and a caller-supplied number could be
  // wrong in a way this function could not detect. `buildTape` stays a pure function of
  // (events, config, sourceSessionId) — the state lookup is the same one `findConstraintProvenance`
  // already does a few lines up.
  const anchorGeneration =
    sourceSessionId !== undefined && sourceSessionId.length > 0 ? graftGenerationOf(sourceSessionId) : 0
  const constraintAnchor = inheritedConstraintAnchor(events, sourceSessionId, anchorGeneration)
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
    // C1: provenance travels with the text; a transcript guess is labelled as one.
    ...(goal.goalLayer === undefined ? {} : { goalLayer: goal.goalLayer }),
    ...(goal.supersededBy === undefined ? {} : { supersededBy: goal.supersededBy }),
    // v1.0.2: a source that evolved its goal hands the EVOLVED one down, plus the count.
    ...(sourceMarkGoal.currentGoal === undefined ? {} : { currentGoal: sourceMarkGoal.currentGoal }),
    ...(sourceMarkGoal.revisions > 0 ? { goalRevisions: sourceMarkGoal.revisions } : {}),
    ...(openTurnInstruction === undefined ? {} : { inProgress: openTurnInstruction }),
    pending: openTodos,
    ...(pendingFromModel ? { pendingSource: 'model' as const } : {}),
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
/**
 * v1.7.0 — RENDER WHAT THE MEMORY STORE KNOWS, FOR A HANDOFF.
 *
 * WHY THIS BELONGS IN A SLICE AT ALL
 *
 * A handoff replays what the SOURCE SESSION did. It cannot say what the organisation already
 * learned — the SKILL.md describing the working method, or the negative recording why the obvious
 * approach fails. Those live in `dsh-memory`, and without them every new session rediscovers what
 * an old one paid for. That rediscovery is the cost the memory layer exists to remove, so a slice
 * that omits it is handing off a task with its history but without its lessons.
 *
 * WHY THE RENDERER IS PURE AND TAKES PLAIN DATA
 *
 * `dsh-graft-slice` does not depend on `dsh-memory` — importing it would make the slicer unable to
 * run without a memory store, which is the coupling both plugins avoid. So the caller recalls and
 * passes the hits in; this function only formats them.
 */
export interface MemoryContextInput {
  /** Skills worth carrying: the working method for this kind of task. */
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly title: string; readonly when?: string }>
  /** Negatives worth carrying: what already went wrong, so it is not repeated. */
  readonly negatives?: ReadonlyArray<{ readonly title: string; readonly detail?: string }>
  /** Facts worth carrying. Kept short — they are context, not instructions. */
  readonly facts?: ReadonlyArray<{ readonly title: string }>
  /** Per-item character cap for the detail line. Default 160. */
  readonly maxDetailChars?: number
}

/**
 * Format memory hits as an injection block, or return `undefined` when there is nothing to say.
 *
 * RETURNING `undefined` FOR AN EMPTY SET IS DELIBERATE: an empty "MEMORY CONTEXT" heading reads as
 * "memory was consulted and knew nothing", which is a different (and misleading) signal from "memory
 * was not consulted for this slice". The caller only adds the chunk when this returns text.
 */
export function renderMemoryContext(input: MemoryContextInput): string | undefined {
  const skills = input.skills ?? []
  const negatives = input.negatives ?? []
  const facts = input.facts ?? []
  if (skills.length === 0 && negatives.length === 0 && facts.length === 0) return undefined
  const cap = Math.max(40, Math.trunc(input.maxDetailChars ?? 160))
  const lines: string[] = ['## MEMORY CONTEXT（历史沉淀，不是本次任务的要求）', '']

  if (skills.length > 0) {
    lines.push('### 已知做法（来自技能库，直接复用，不要重新发明）')
    for (const skill of skills) {
      const when = skill.when === undefined || skill.when.length === 0 ? '' : `　适用：${skill.when.slice(0, cap)}`
      lines.push(`- \`${skill.name}\` — ${skill.title.slice(0, cap)}${when}`)
    }
    lines.push('')
  }

  if (negatives.length > 0) {
    lines.push('### 已知失败（这些做法已经试过并且失败，不要重复）')
    for (const negative of negatives) {
      const detail = negative.detail === undefined || negative.detail.length === 0 ? '' : `　→ ${negative.detail.slice(0, cap)}`
      lines.push(`- ${negative.title.slice(0, cap)}${detail}`)
    }
    lines.push('')
  }

  if (facts.length > 0) {
    lines.push('### 相关事实')
    for (const fact of facts) lines.push(`- ${fact.title.slice(0, cap)}`)
    lines.push('')
  }

  lines.push('这些是历史沉淀，与上方 HARD CONSTRAINTS 不冲突；若冲突，以 HARD CONSTRAINTS 为准。')
  return lines.join('\n')
}

/**
 * TD-11: the content the MODEL supplies for a handoff, via `graft_prepare`'s `handover`.
 *
 * ── WHY THERE ARE EXACTLY TWO FIELDS, AND WHAT IS EXCLUDED ───────────────────────────────────
 *
 * No `goal`. TD-18 gives `goal` a three-layer definition (objective > dag-node > transcript).
 * A second writer for the same field would re-introduce precisely the "which one wins"
 * ambiguity that ruling removed — and that ambiguity has already cost one incident
 * (ANALYSIS-BRIEF §4.4: a finished request labelled "current", so the target redid it).
 *
 * **No `constraints`, permanently.** A constraint parameter would let the model write a red line
 * straight into the handoff, bypassing `shapeOfConstraint` and `droppedByShape` — the audit chain
 * the whole constraint pipeline is built around. Constraints may only enter by extraction from
 * the source log, or by inheritance, and both go through the shape judge. The model cannot
 * author a red line. That is not a size limit; it is the boundary.
 *
 * `pending` and `notes` are safe because they share no field with any tool-derived fact:
 * `pending` replaces the 待开始 column and is LABELLED as model-supplied where it renders, and
 * `notes` is its own labelled section. Neither can be read as a measured fact.
 */
export interface ModelHandover {
  /** Replaces the 待开始 column. Labelled 「模型提供」 in the heading. */
  readonly pending?: readonly string[]
  /** Appended to the pending-state block as a labelled section. */
  readonly notes?: readonly string[]
}

export function buildInjectionPlan(
  log: SessionLogSnapshotLike,
  config: GraftConfig,
  constraintsOverride?: readonly string[],
  constraintSource: 'llm' | 'regex-fallback' = 'regex-fallback',
  /** v6.4 F3: tools the target actually has; undefined means "assume all". */
  availableTools?: ReadonlySet<string>,
  /** v7.0 B1: set false to omit the open-turn carryover (tests, legacy callers). */
  options?: {
    includeOpenTurn?: boolean
    /**
     * v1.7.0: what the memory store already knows, rendered into the handoff.
     *
     * Passed as plain data on purpose: `dsh-graft-slice` must run without `dsh-memory` installed,
     * so the caller recalls and this function only formats. Absent means "no memory consulted",
     * which produces no chunk at all — not an empty heading claiming memory knew nothing.
     */
    memoryContext?: MemoryContextInput
    /**
     * TD-11: content the model supplied for THIS handoff (`graft_prepare`'s `handover`).
     *
     * See `ModelHandover`: no `goal` (TD-18 owns that field) and no `constraints` (the model
     * may not author a red line). `pending` replaces the transcript list; `notes` is appended.
     */
    handover?: ModelHandover
  },
): GraftPlan {
  const settings = normalizeConfig(config)
  const events = Array.isArray(log.events) ? log.events : []
  const boundary = locateBoundary(events)
  /** v1.7.0: memory hits for this handoff, rendered later as its own chunk. */
  const memoryContext = options?.memoryContext
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
  /**
   * ── AUDIT F1: AN EXPLICIT COUNT IS AN INSTRUCTION, NOT A GUESS TO REFINE ────────────────────────
   *
   * WHAT WAS WRONG. This used to be:
   *
   *     tierDecision === undefined
   *       ? { ...settings, recentTurns: adaptive.depth }     // unconditional
   *       : { ...settings, recentTurns: tierDecision.depth }
   *
   * `settings.recentTurns` — a documented field, present in `cordis.patch.yml` with its own comment
   * — was replaced by a SHAPE-BASED GUESS with no notice and no way to tell. Measured on three source
   * lengths with recentTurns = 1 / 2 / 5: byte-identical tapes every time.
   *
   * WHY IT LOOKED FINE IN TESTS. `adaptiveDepth=false` makes `adaptive.depth` fall back to
   * `settings.recentTurns`, at which point the override is an identity. So the parameter "worked"
   * only when the operator turned off the very feature that ignores it.
   *
   * THE PRECEDENCE, NOW STATED AS THREE EXPLICIT CASES — each override is an OPT-IN:
   *
   *   1. `autoAdaptiveTier` is ON. It defaults to FALSE, so turning it on is a deliberate act, and it
   *      reads task state (a fact) rather than conversation shape (a guess). It wins, as before.
   *   2. `recentTurns` was EXPLICITLY set. The operator named a number; no heuristic refines it.
   *   3. Neither — then `adaptiveDepth` decides, which is exactly what "I did not say" should mean.
   *
   * Note that case 1 outranking case 2 is the pre-existing, documented contract (a v7.4 test pins
   * it): two deliberate opt-ins, where the more specific one wins. The bug being fixed was the
   * DEFAULT heuristic silently outranking an explicit value — not the precedence itself.
   */
  const explicitTurns = settings.recentTurnsExplicit === true
  const effectiveSettings =
    tierDecision === undefined
      ? explicitTurns
        ? { ...settings, recentTurns: settings.recentTurns }
        : { ...settings, recentTurns: adaptive.depth }
      : { ...settings, recentTurns: tierDecision.depth }
  // v0.23 P2: resolve the workspace BEFORE building the tape, so the card's
  // verification section describes the project the source was working in. Reading it
  // after the fact is what would let the probe report on the wrong directory.
  const cwd = log.session?.cwd
  // TD-11: the model may have stated what comes next. Only non-empty strings count — a blank or
  // whitespace-only entry is not a statement and must not shadow the transcript list.
  const handoverPending = (options?.handover?.pending ?? [])
    .map((item) => String(item).replace(/\s+/gu, ' ').trim())
    .filter((item) => item.length > 0)
  const handoverNotes = (options?.handover?.notes ?? [])
    .map((item) => String(item).replace(/\s+/gu, ' ').trim())
    .filter((item) => item.length > 0)
  /**
   * TD-11 rule 3: the model's own words get their OWN labelled section, so nothing it says can be
   * read as a measured fact. They are never merged into a tool-derived column.
   */
  const handoverNotesBlock =
    handoverNotes.length === 0
      ? ''
      : `\n\n**模型提供的内容（不是工具测量的事实）**\n${handoverNotes.map((note) => `- ${note}`).join('\n')}`
  const tape = buildTape(
    events,
    boundary,
    effectiveSettings,
    typeof log.session?.id === 'string' ? log.session.id : undefined,
    // TD-11: a model-supplied `pending` REPLACES the transcript-derived list. This is the one
    // place the model outranks the log, and it is deliberate: `openTodos` is read from the
    // model's OWN earlier todo_write — the very thing it may be correcting at handoff time.
    // The substitution is labelled in the board (`pendingSource`), never silent.
    handoverPending.length > 0 ? handoverPending : taskStateForPending.openTodos,
    availableTools,
    typeof cwd === 'string' ? cwd : undefined,
    taskStateForPending.todoSeq !== undefined,
    handoverPending.length > 0,
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
    // TD-11: the model's `notes` ride this chunk as a labelled section. Putting them here rather
    // than in a chunk kind of their own keeps the chunk union and its priority list unchanged —
    // and they are still hashed by `digestOfPlan`, because chunks are what it hashes.
    text: tape.pendingStateText + handoverNotesBlock,
    truncated: false,
  })

  /**
   * v1.7.0 — MEMORY CONTEXT GOES AFTER PENDING STATE, BEFORE THE BUDGET PASS.
   *
   * AFTER pending state because pending state is about THIS task and outranks accumulated history;
   * BEFORE the budget pass so the memory block can be trimmed by the same rules as everything else
   * rather than escaping the budget and pushing real context out.
   *
   * `memoryContext` is optional plain data, so a slicer running with no memory store behaves exactly
   * as it did before — no import, no new failure mode, no empty heading.
   */
  if (memoryContext !== undefined) {
    const text = renderMemoryContext(memoryContext)
    if (text !== undefined) chunks.push({ kind: 'memory-context', text, truncated: false })
  }
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


// ===========================================================================
// Phase 4 — durable write, retirement and fallback read
// ===========================================================================

/**
 * The in-memory mirrors of the ledgers, and the auto-graft queue, are declared in
 * `src/core/state.ts` and imported at the top of this module. What stays here is the
 * LOCATION of each store: these are `let` because `configureRetiredStore` reassigns them
 * once a profile or `dataDir` is resolved, and an imported binding could not be reassigned.
 */
/** v7.0: persisted graft-target marks (chain guard + protection across restarts). */
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
/**
 * ── THE STORE LAYER HANDLE (S3-P4) ──────────────────────────────────────────────────────────────
 *
 * One frozen handle replaces thirteen module-level `let`s. It is `undefined` until `apply()` assembles
 * it, and `storePaths()` THROWS in that state rather than returning an empty string: the old `let`s
 * defaulted to `PLUGIN_DIR`, so a call before assembly wrote into the package directory silently.
 *
 * ── WHY THE THROW CARRIES `PERSISTENCE_REQUIRED` ────────────────────────────────────────────────
 *
 * Measured regression: the first version threw a plain `Error`, which pre-empted the documented refusal
 * of a bare deployment. `dsh-paradise/test/host-independence-seams.test.mjs` asserts that calling
 * `graftSliceAndInject` with an EMPTY ctx fails with `code === 'PERSISTENCE_REQUIRED'` — the assertion
 * exists so that "this deployment has no gateway" is never confused with "the plugin is broken".
 *
 * Reaching a store before `apply()` means exactly the same thing from the caller's side: there is no
 * persistence binding in this deployment. Same refusal, same code, still loud.
 */
let storeLayer: StoreLayer | undefined

function storePaths(): StorePaths {
  if (storeLayer === undefined) {
    const error = graftError(
      'PERSISTENCE_REQUIRED',
      'the graft store layer is not assembled: apply() has not run in this deployment, so there is no ' +
        'store directory to read or write',
    )
    throw error
  }
  return storeLayer.paths
}

/** The context captured at assembly time, or `undefined` when the layer was built without one. */
function storeCtxOf(): PluginContextLike | undefined {
  return storeLayer?.ctx
}
/** Load durable retirement IDs. Missing/corrupt files never block activation. */
function configureRetiredStore(ctx: PluginContextLike, settings: Required<GraftConfig>): void {
  /**
   * ── THE SINGLE ASSEMBLY POINT (S3-P4) ──────────────────────────────────────────────────────────
   *
   * Thirteen module-level `let`s used to be assigned here, one per path. They are now ONE frozen
   * handle produced by `core/store-layer.ts`, which is the module `test/v133` diffs against a golden
   * file recorded from the OLD implementation. Two things follow, and both are deliberate:
   *
   *   * `fallbackDir` is passed in from HERE, not computed inside the layer. In TS source the layer's
   *     `import.meta.url` is `src/core/`, while the bundle inlines it beside `index.ts` — two different
   *     answers for the one branch that every profile shares.
   *   * the layer is REBUILT on each assembly, never cached: the second profile must not inherit the
   *     first profile's directory.
   */
  storeLayer = createStoreLayer(ctx, {
    ...(settings.dataDir === '' ? {} : { dataDir: settings.dataDir }),
    fallbackDir: PLUGIN_DIR,
  })

  const dataDir = storePaths().dir
  /**
   * P1-2: PUBLISH THIS DIRECTORY'S LAYOUT, so `dsh-memory` can REFUSE rather than guess.
   *
   * That reader opens `.retired.json` and `.transferred.json` by name, and a missing file has always
   * meant "nothing retired yet" — so a rename HERE would read to it as an empty history, with no
   * error on either side. `.layout.json` is what turns that silence into a named refusal.
   *
   * Written when the store directory is RESOLVED, not on the first ledger write: the contract has to
   * exist before anyone reads, or the first read of a fresh directory is unversioned by construction.
   * `writeLayoutManifest` is idempotent by content, so a reload does not touch the directory's mtime.
   */
  try {
    writeLayoutManifest(dataDir, {
      layout: GRAFT_LEDGER_LAYOUT_VERSION,
      producer: 'dsh-graft-slice',
      files: GRAFT_LEDGER_FILES,
    })
  } catch {
    // A directory that cannot be stamped is still usable. The other side then sees an absent
    // manifest and proceeds — the pre-P1-2 behaviour — which is the safe direction for a failed
    // marker: refusing to write a ledger because a marker could not be written would be worse.
  }
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
  if (storePaths().scope === 'plugin-dir') {
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
    [storePaths().transferred, 'transferred'],
    [storePaths().retired, 'retired'],
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
    const parsed = ledgerRecord(storePaths().transferred)
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
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${storePaths().transferred}: ${String((error as any)?.message ?? error)}`)
      } catch {
        // Logging must not block activation.
      }
    }
  }
  try {
    const parsed = ledgerArray(storePaths().retired)
    for (const id of parsed) {
      if (typeof id === 'string' && id.length > 0) retiredSessions.add(id)
    }
  } catch (error) {
    if ((error as any)?.code !== 'ENOENT') {
      try {
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${storePaths().retired}: ${String((error as any)?.message ?? error)}`)
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

/**
 * v5.2 补丁二：后台 LLM 约束提取的载荷形状（`PendingConstraintPayload`）声明在
 * `src/core/state.ts` —— 与它一起生活的队列也在那里。
 *
 * 迁移关键路径只用正则 FAST_CONSTRAINTS：LLM 调用随源历史增长而变慢，放在
 * 关键路径上会直接推高「触发到看到新会话」的延迟。
 *
 * 流程：迁移完成 → 后台跑 LLM → 成功后暂存 pending 约束 → target 下一次
 * pre-step 以 developer/message 静默注入一次。
 *
 * 失败时保留正则结果，不回滚迁移：约束质量下降是次要问题，迁移已经成功。
 */

/**
 * v6.0 补丁一：草稿捕获（`DraftPayload` / `draftPayloads` 同样声明在 `src/core/state.ts`）。
 *
 * 用户在旧会话被拦截的那一瞬间正在输入的内容，不应该凭空消失。
 * 拦截时捕获，写盘；target 第一次收到输入时把草稿和新输入合并成一条，
 * 然后立刻删除——只生效一次。
 */
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
 * v7.0 P0-5: the constraints this plugin keeps rendering into a target's system prompt are in
 * `src/core/state.ts` (`targetConstraintSections`); only the PATH below stays here.
 */

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
/** v1.3 batch 2: writeJsonAtomic moved to src/core/ledger.ts. */

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

/**
 * v0.14 CHAIN GUARD: completed turns a fresh target is immune to re-grafting.
 *
 * Two turns is the smallest window that covers the real failure: a target is
 * seeded with a large tape, its provider-usage figure is inherited from the
 * source, and the very first request already sits above the 75% hard cutoff.
 * Without this, generation 2 creates generation 3 before the user has typed
 * anything, and each hop buries the original intent one level deeper.
 */

// v1.3: the audit entry type and its one-line formatter live in src/utils/logger.ts.

/**
 * v7.7: an append-only audit next to the state files.
 *
 * The model-driven nudge is delivered through pre-step `messages`, which the host
 * never logs. Without this file there is no way to prove after the fact that a
 * nudge fired, at what ratio, or that a lock actually contended. One JSON line
 * per event; the write is locked because two processes may append at once.
 *
 * v1.0.0 P0 — ROTATION, because "append-only" was the whole design and nothing bounded it.
 *
 * The file only ever grew. `withFileLock` serialises writers but does not care how big the
 * target is, so a long-lived profile accumulates one line per audit event forever.
 *
 * The policy is archive-not-delete: an audit trail whose oldest half is silently dropped is
 * not an audit trail. Past `GRAFT_AUDIT_ROTATE_BYTES` the active file is RENAMED to a
 * timestamped sibling and a new active file starts; the newest `GRAFT_AUDIT_KEEP` archives
 * are kept. Rotation happens INSIDE the lock so two processes cannot both rotate, and its
 * failure does not stop the append — a rotation bug must not cost evidence.
 */
export const GRAFT_AUDIT_ROTATE_BYTES = 4 * 1024 * 1024
export const GRAFT_AUDIT_KEEP = 3

function rotateGraftAudit(path: string): void {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size < GRAFT_AUDIT_ROTATE_BYTES) return
  const base = dirname(path)
  const name = path.slice(base.length + 1)
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  try {
    renameSync(path, join(base, `${name}.${stamp}`))
  } catch {
    // Keep appending to the old file rather than losing the line.
    return
  }
  try {
    const prefix = `${name}.`
    const archives = readdirSync(base)
      .filter((entry) => entry.startsWith(prefix))
      .sort()
    for (const entry of archives.slice(0, Math.max(0, archives.length - GRAFT_AUDIT_KEEP))) {
      try {
        rmSync(join(base, entry), { force: true })
      } catch {
        /* a stuck archive is not worth failing the append */
      }
    }
  } catch {
    /* ignore */
  }
}

export function appendGraftAudit(entry: GraftAuditEntry): void {
  const base = dirname(storePaths().retired)
  try {
    mkdirSync(base, { recursive: true })
    const path = join(base, '.graft-audit.jsonl')
    withFileLock(
      path,
      () => {
        /** Rotate inside the lock: two processes must not both rotate the same file. */
        rotateGraftAudit(path)
        appendFileSync(path, formatAuditLine(entry, process.pid) + '\n', 'utf8')
      },
      { timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_STALE_MS, label: 'audit', silent: true },
    )
  } catch {
    // Audit is evidence, never a gate: a failed line must not change the outcome.
  }
}

/**
 * v1.3 batch 2: hand the audit writer to the lock module (src/core/txn.ts).
 *
 * Top-level on purpose — every lock acquisition happens later, at activation or on a tool
 * call, so the sink is installed before the first `withFileLock`.
 */
setAuditSink(appendGraftAudit)

/** Block the current thread without burning a core (Atomics.wait is a real sleep). */

/**
 * The per-source lock: two processes must never build two targets for one source.
 *
 * The state-file locks protect the LEDGERS; this protects the MIGRATION. Without
 * it, concurrent prepare/commit for the same session can both pass the boundary
 * check (the source has not moved), both write a target, and both retire — which
 * is how one source ends up with two divergent continuations.
 */
export function acquireSourceLock(sessionId: string): () => void {
  const path = join(dirname(storePaths().retired), `.lock-source-${encodeURIComponent(sessionId)}`)
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





/** The epoch of a ledger file: 0 absent, 1 legacy, 2+ envelope. */

/**
 * The usable payload of a ledger file, whatever shape wrote it.
 *
 * Exported because the disk-only tools (`scripts/debug-status.mjs`,
 * `scripts/prune-ghosts.mjs`) and the tests read the same files: one unwrap
 * implementation, not five.
 */

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



function readJsonArray(path: string): unknown[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** v1.3 batch 2: readJsonRecord moved to src/core/ledger.ts. */

function persistConstraintSections(ctx: PluginContextLike | undefined): void {
  if (ctx === undefined) return
  try {
    mkdirSync(dirname(storePaths().constraintSections), { recursive: true })
    withFileLock(storePaths().constraintSections, () => {
      const payload = readJsonRecord(storePaths().constraintSections) as Record<string, { constraints: string[]; at: number }>
      /**
       * ── A4: DO NOT WRITE FRAGMENTS INTO THE LEDGER ─────────────────────────────────────────────
       *
       * The ledger is what the NEXT generation reads back, so writing a fragment here is how one bad
       * turn becomes permanent damage (measured: 5 of 40 entries across 8 generations, all in the
       * newest one — the damage was born here).
       *
       * ── AND WHY EXISTING ENTRIES ARE NOT REWRITTEN ────────────────────────────────────────────
       *
       * The ledger is AUDIT EVIDENCE: it records what a previous build actually injected. Rewriting
       * it on activation would erase the proof that the bug existed, and would make the incident
       * unreproducible. So this filters on WRITE only; reads are filtered at A2 and B3, which is where
       * behaviour is decided. `graft_debug_status` still shows the historical entries.
       */
      for (const [id, entry] of targetConstraintSections) {
        const existing = payload[id]
        if (existing === undefined || Number(entry.at ?? 0) >= Number(existing.at ?? 0)) {
          const shaped = splitByShape(
            (entry as { constraints?: unknown }).constraints?.filter?.((value: unknown): value is string => typeof value === 'string') ?? [],
            'ledger',
          )
          if (shaped.dropped.length > 0) {
            ctx?.logger?.warn?.(
              `[dsh-graft-slice] not recording ${shaped.dropped.length} malformed constraint(s) for ${id}: ` +
                shaped.dropped.map((drop) => drop.code).join(','),
            )
          }
          payload[id] = { ...(entry as { at: number }), constraints: shaped.kept }
        }
      }
      for (const [id, entry] of Object.entries(payload)) {
        if (isRecord(entry) && Array.isArray(entry.constraints) && !targetConstraintSections.has(id)) {
          targetConstraintSections.set(id, entry as never)
        }
      }
      writeJsonAtomic(storePaths().constraintSections, payload)
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] cannot write ${storePaths().constraintSections}: ${String((error as any)?.message ?? error)}`,
      )
    } catch {
      // Logging must not change the migration result.
    }
  }
}

function loadConstraintSections(ctx: PluginContextLike): void {
  try {
    const parsed = JSON.parse(readFileSync(storePaths().constraintSections, 'utf8'))
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
          `[dsh-graft-slice] cannot read ${storePaths().constraintSections}: ${String((error as any)?.message ?? error)}`,
        )
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

/**
 * v7.0 P0-5 / v0.14 D1: `constraintsReasserted` and `guardReasserted` are the one-shot
 * in-band fallbacks for a host where the system-prompt section was not registered. Both
 * are declared in `src/core/state.ts` now; the rule they encode is unchanged — a standing
 * rule repeated every step reads like a nag and costs the recency position.
 */

/**
 * The paths below are the half of this block that CANNOT move to `src/core/state.ts`:
 * `configureRetiredStore` reassigns every one of them once a profile or `dataDir` is
 * resolved, and an imported binding is read-only in the importer.
 */
/** v7.4 P1-2: reviewed-but-not-committed slices live here. */
const AUTO_GRAFT_RESUME_GRACE_MS = 30 * 60_000
function persistPendingConstraints(ctx: PluginContextLike): void {
  try {
    mkdirSync(dirname(storePaths().pendingConstraints), { recursive: true })
    const payload = [...pendingConstraints.entries()].map(([targetId, value]) => ({ targetId, ...value }))
    writeJsonAtomic(storePaths().pendingConstraints, payload)
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${storePaths().pendingConstraints}: ${String((error as any)?.message ?? error)}`)
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
 *
 * The shape (`LeftoverTarget`), the map (`leftoverTargets`) and `LEFTOVER_CAP` are declared in
 * `src/core/state.ts`; the persistence below needs the path, so it stays here.
 */

function persistLeftovers(ctx: PluginContextLike): void {
  try {
    mkdirSync(dirname(storePaths().leftovers), { recursive: true })
    writeJsonAtomic(storePaths().leftovers, [...leftoverTargets.values()])
  } catch (error) {
    try {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] cannot write ${storePaths().leftovers}: ${String((error as any)?.message ?? error)}`,
      )
    } catch {
      // Logging must not change the migration result.
    }
  }
}

export function loadLeftovers(ctx: PluginContextLike): void {
  try {
    const parsed = JSON.parse(readFileSync(storePaths().leftovers, 'utf8'))
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
          `[dsh-graft-slice] cannot read ${storePaths().leftovers}: ${String((error as any)?.message ?? error)}`,
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
    mkdirSync(dirname(storePaths().drafts), { recursive: true })
    writeJsonAtomic(storePaths().drafts, [...draftPayloads.values()])
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${storePaths().drafts}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the migration result.
    }
  }
}

function loadDrafts(ctx: PluginContextLike): void {
  if (draftsLoaded) return
  draftsLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(storePaths().drafts, 'utf8'))
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
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${storePaths().drafts}: ${String((error as any)?.message ?? error)}`)
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

/** `PlanNudgeState` and `planNudgeStates` are declared in `src/core/state.ts`. */

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
  /**
   * v1.0.0 P0: `rememberPlanNudge` replaces the bare `.set`. It keeps the map under
   * `PLAN_NUDGE_CAP` by evicting the least-recently-written session. This collection had no
   * exit at all before — see the note in `core/state.ts`.
   */
  rememberPlanNudge(agentId, state)
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

/**
 * ── AUDIT ROUND 3 (P0-1/P0-3): THE NUDGE NOW SAYS WHAT TO PASS, AND WHERE TO GET IT ─────────────
 *
 * THE DEADLOCK THIS REMOVES. The old body said "call graft_prepare, then graft_slice_and_inject" and
 * stopped there. Both tools then demanded a `sourceSessionId` the model had no way to obtain, so the
 * measured behaviour was: the model went looking for something id-shaped, found an OLD session id
 * quoted inside a stored skill, passed it, and **sliced the wrong conversation successfully**. A loud
 * failure would have been strictly better.
 *
 * Three facts are now stated that were previously left to inference:
 *
 *   1. THE TOOLS CAN BE CALLED WITH NO ARGUMENTS. `graft_prepare()` means "prepare a slice of THIS
 *      session", which is what the nudge intends. Saying so removes the search entirely.
 *   2. IF AN ID IS WANTED ANYWAY, `graft_debug_status` RETURNS IT. That tool resolved the calling
 *      session all along; it just never printed it. Belt and braces, so the model has a reliable
 *      source even if it decides to pass one explicitly.
 *   3. 70–75% IS THE ONLY SELF-DRIVEN WINDOW. Above it the plugin force-migrates on its own. Without
 *      this, "you have time" and "you are about to be cut off" are indistinguishable — and a model
 *      that believes the second will do something hasty at a bad stopping point.
 */
const MODEL_DRIVEN_NUDGE_BODY =
  '如果你觉得当前任务需要跨阶段进行，请先调用 graft_prepare 查看交接单（**不需要任何参数**，省略 sourceSessionId 即表示"切本会话"）；' +
  '确认无误后，调用 graft_slice_and_inject 完成切片（同样可以不传参数）。' +
  '若确实需要显式指定会话 id，用 graft_debug_status 查询——它的输出里有 sessionId，' +
  '**不要凭记忆或从别的会话里抄一个 id**，那会切走别人的会话。'

/** The nudge/watermark state below is declared in `src/core/state.ts`; only the TEXT stays here. */
const GRAFT_HANDOVER_TOOLS = new Set(['graft_prepare', 'graft_slice_and_inject', 'graft_commit'])

/**
 * ── AUDIT ROUND 3 (P0-3): THE ESCALATION NOW NAMES THE WINDOW AND THE CALL SHAPE ────────────────
 *
 * Additions, each earning its place:
 *   - "这是留给你的最后一个窗口" states the boundary. The hard cutoff is automatic and the model is
 *     not told about it anywhere else, so silence here reads as "no deadline".
 *   - the explicit no-argument call shape, because at 71% there is no budget for the model to
 *     rediscover the signature or to go hunting for an id.
 */
const WATERMARK_URGENT_TEXT =
  '水位告急：70% 预警后你又开始了新的工具调用。请立刻切走，不要开始新的工具调用——' +
  '直接调用 graft_prepare 查看交接单（不传参数即可，省略 sourceSessionId 表示切本会话），' +
  '再用 graft_slice_and_inject 完成切片（同样可不传参数）。' +
  '这是模型自驱的最后窗口：再往上会被系统强制迁移，届时你正在写的这一步会直接丢失。' +
  '如果确实要显式传会话 id，先用 graft_debug_status 查，不要猜。'

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
  // Evidence: a pre-step message reaches the log only as an anonymous
  // `user/message` (its provenance rides in `source.kind`, not in the text), so
  // the audit line is the durable proof of WHICH nudge fired and at what ratio.
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
    const parsed = JSON.parse(readFileSync(storePaths().pendingConstraints, 'utf8'))
    if (!Array.isArray(parsed)) return
    for (const item of parsed) {
      if (!isRecord(item)) continue
      if (typeof item.targetId !== 'string' || !Array.isArray(item.constraints)) continue
      const strings = item.constraints.filter((value: unknown): value is string => typeof value === 'string')
      /**
       * ── A2: THE ONLY REPAIR DOOR FOR TEXT THAT IS ALREADY ON DISK ──────────────────────────────
       *
       * A queue written by an older build still holds whatever that build accepted. Filtering only at
       * injection time would repair the output but leave the file poisoned forever — and every
       * subsequent load would carry it again. Filtering HERE means one activation fixes the store.
       *
       * The dropped entries are logged but the file is NOT rewritten on load: the queue is audit
       * evidence (the review's instruction), so filtering changes what is USED, not what is KEPT.
       */
      const shaped = splitByShape(strings, 'accept')
      if (shaped.dropped.length > 0) {
        ctx.logger?.warn?.(
          `[dsh-graft-slice] ignoring ${shaped.dropped.length} malformed queued constraint(s) for ${String(item.targetId)}: ` +
            shaped.dropped.map((drop) => drop.code).join(','),
        )
      }
      const constraints = shaped.kept
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
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${storePaths().pendingConstraints}: ${String((error as any)?.message ?? error)}`)
      } catch {
        // Logging must not block activation.
      }
    }
  }
}

/** Persist the retirement set; a failed write is reported but never blocks a migration. */
function persistRetiredStore(ctx: PluginContextLike, remove: readonly string[] = [], strict = false): void {
  try {
    mkdirSync(dirname(storePaths().retired), { recursive: true })
    withFileLock(storePaths().retired, () => {
      // v7.7: read-modify-write under the lock. Serialising the in-memory set and
      // renaming it over the file is what let two sessions erase each other.
      const merged = new Set<string>(
        ledgerArray(storePaths().retired).filter((value): value is string => typeof value === 'string'),
      )
      for (const id of remove) merged.delete(id)
      for (const id of retiredSessions) {
        if (!remove.includes(id)) merged.add(id)
      }
      // Adopt the other writer's retirements; otherwise this process keeps
      // accepting a session the other one already closed.
      for (const id of merged) retiredSessions.add(id)
      writeLedgerAtomic(storePaths().retired, [...merged].sort())
    })
  } catch (error) {
    // v7.8: commit-critical writes must FAIL, not warn. A retirement that is only
    // half-written is worse than no retirement: the source stays usable while the
    // in-memory state says it is gone.
    if (strict) throw error
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${storePaths().retired}: ${String((error as any)?.message ?? error)}`)
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

function persistTransferredStore(ctx: PluginContextLike, remove: readonly string[] = [], strict = false): void {
  try {
    mkdirSync(dirname(storePaths().transferred), { recursive: true })
    withFileLock(storePaths().transferred, () => {
      const merged = ledgerRecord(storePaths().transferred) as Record<string, { newSessionId: string; at: number; reason: string }>
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
      writeLedgerAtomic(storePaths().transferred, merged)
    })
  } catch (error) {
    if (strict) throw error
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${storePaths().transferred}: ${String((error as any)?.message ?? error)}`)
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
  const lockPath = join(dirname(storePaths().retired), '.retirement')
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
  const beforeRetired = snapshot(storePaths().retired)
  const beforeTransferred = snapshot(storePaths().transferred)
  try {
    persistRetiredStore(ctx, [], true)
    persistTransferredStore(ctx, [], true)
  } catch (error) {
    restore(storePaths().retired, beforeRetired)
    restore(storePaths().transferred, beforeTransferred)
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
  /**
   * v1.0.0 P0: the PLAN-NUDGE state is session state for the same reason — and it was the
   * one collection this reset forgot. A stale entry would carry `turns`/`lastNudgeTurn`
   * from a finished session into whatever session next reuses the id, so the next plan
   * reminder could be silently suppressed (or fired far too early). The map also now has a
   * cap of its own; both exits are documented in `core/state.ts`.
   */
  planNudgeStates.clear()
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
  /**
   * v7.8: the QUEUE must be cleared with the ledger. A queued notice that outlived its reset would be
   * delivered into whatever session next reuses that id — a stale "your migration failed" arriving in
   * an unrelated conversation is worse than not arriving at all.
   */
  rollbackNotices.clear()
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

  const target = ctx ?? storeCtxOf()
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
 *
 * The shape and the map (`preparedSlices`) are declared in `src/core/state.ts`; they are re-exported
 * here because `PreparedSlice` is part of this plugin's public surface and a file move must not
 * rename or withdraw anything.
 */
export type { LeftoverTarget, PlanNudgeState, PreparedSlice } from './core/state.js'

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

function digestOfPlan(plan: any, handover?: ModelHandover): string {
  // v7.4 P1-2: hash exactly what the user reviews — the goal plus every injected
  // chunk (`buildInjectionPlan` exposes the tape as chunks, not as turns, so an
  // earlier draft that hashed `plan.turns` hashed an empty array and every plan
  // digested the same way).
  //
  // TD-11: `handover` is hashed EXPLICITLY, not merely through its effect on the chunks. If the
  // model's `pending` happened to equal the transcript list, the rendered text would be identical
  // and a chunk-only hash would collide — yet the review still differs, because the board then
  // says 「模型提供」. The digest is the fingerprint of what the user approved, provenance
  // included, so provenance is hashed.
  const chunks = Array.isArray(plan?.chunks)
    ? plan.chunks.map((chunk: any) => [String(chunk?.kind ?? ''), String(chunk?.text ?? '')])
    : []
  const constraints: string[] = Array.isArray(plan?.constraints) ? plan.constraints.map(String) : []
  const handoverDigest = {
    pending: (handover?.pending ?? []).map(String),
    notes: (handover?.notes ?? []).map(String),
  }
  return createHash('sha256')
    .update(JSON.stringify({ goal: String(plan?.goal ?? ''), constraints, chunks, handover: handoverDigest }))
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
  /**
   * TD-11: content the model supplies for this handoff. Optional — absent means the historical
   * behaviour, where everything is extracted from the log.
   */
  handover?: ModelHandover,
): Promise<PreparedSlice> {
  const settings = normalizeConfig(config)
  const sourceId = asNonEmptyString(sourceSessionId, 'sourceSessionId')
  const raw = await readSourceForPreview(ctx, sourceId)
  if (!hasClosedTurn(raw.events)) {
    throw graftError('NO_CLOSED_TURN', `session "${sourceId}" has no closed turn yet; nothing to review`)
  }
  const plan = buildInjectionPlan(raw, settings, undefined, 'regex-fallback', undefined,
    handover === undefined ? undefined : { handover })
  const digest = digestOfPlan(plan, handover)
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
  // TD-11: counted for the review label. The board's 待开始 column was already substituted by
  // `buildInjectionPlan`; here we only need the counts, to state WHAT the user is approving.
  const handoverPendingCount = (handover?.pending ?? []).filter((item) => String(item).trim().length > 0).length
  const handoverNoteCount = (handover?.notes ?? []).filter((item) => String(item).trim().length > 0).length

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
    // TD-11: the review must SAY that part of it came from the model. The user approves a digest,
    // so the provenance of what they are approving has to be on screen, not only in the data.
    ...(handoverPendingCount === 0 && handoverNoteCount === 0
      ? []
      : ['', `【本段由模型提供】待开始 ${handoverPendingCount} 条、备注 ${handoverNoteCount} 条（不是工具测量的事实）`]),
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
    // TD-11: kept on the record so `graft_commit`/debug tooling can tell that this review carried
    // model-supplied content, and which kind. The digest already covers it structurally.
    handoverPendingCount,
    handoverNoteCount,
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
  if (storePaths().prepared.length === 0) return
  try {
    const parsed = JSON.parse(readFileSync(storePaths().prepared, 'utf8'))
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
  if (storePaths().prepared.length === 0) return
  try {
    const payload: Record<string, PreparedSlice> = {}
    mkdirSync(dirname(storePaths().prepared), { recursive: true })
    withFileLock(storePaths().prepared, () => {
      // v7.7: union with what the other process prepared. Overwriting here made a
      // concurrent prepare vanish, and the matching commit then reported
      // PREPARED_UNKNOWN / a digest mismatch that looked like source drift.
      const onDisk = readJsonRecord(storePaths().prepared) as Record<string, PreparedSlice>
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
      writeJsonAtomic(storePaths().prepared, payload)
    })
  } catch {
    // Best effort: a lost prepared slice is recoverable by preparing again.
  }
}

/** v7.4: keep the resume grace across restarts, or a restart re-enables the trap. */
function persistAutoGraftSuppression(ctx: PluginContextLike, remove: readonly string[] = []): void {
  try {
    mkdirSync(dirname(storePaths().autoGraftSuppressed), { recursive: true })
    withFileLock(storePaths().autoGraftSuppressed, () => {
      const merged = readJsonRecord(storePaths().autoGraftSuppressed) as Record<string, number>
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
      writeJsonAtomic(storePaths().autoGraftSuppressed, merged)
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] cannot write ${storePaths().autoGraftSuppressed}: ${String((error as any)?.message ?? error)}`,
      )
    } catch {
      // A failed write only shortens the grace window; it must not fail a resume.
    }
  }
}

function loadAutoGraftSuppression(): void {
  try {
    const parsed = JSON.parse(readFileSync(storePaths().autoGraftSuppressed, 'utf8'))
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
  for (const id of ledgerArray(storePaths().retired)) {
    if (typeof id === 'string' && id.length > 0) retiredSessions.add(id)
  }
  for (const [id, value] of Object.entries(ledgerRecord(storePaths().transferred))) {
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
  /**
   * THE PREFLIGHT GOES THROUGH THE GATEWAY, so "is this id taken" has ONE answer on every host.
   *
   * WHAT IT REPLACED, and why the replacement is a transcription rather than a redesign: the inline
   * version asked `ctx.sessions.get(newId)` and then `persistence.stat(newId)`. The default gateway does
   * exactly that, in that order, with the same guard on `typeof stat === 'function'`.
   */
  const gateway = resolveGateway(ctx)
  if (await gateway.isTaken(newId)) {
    throw graftError('SESSION_EXISTS', `session ${newId} is already live or already in durable storage`)
  }
  /**
   * THE PERSISTENCE REQUIREMENT IS A PROPERTY OF THE GATEWAY, NOT OF THE PIPELINE.
   *
   * It used to be an unconditional check here: `ctx.sessionPersistence` missing meant "refuse". That
   * check is CORRECT for a host-context gateway (a bare `sessions.create` session is not durable) and
   * WRONG for a gateway that writes the file itself — it would refuse a deployment that can plainly do
   * the work. So the requirement moved onto the gateway, where it can be true or false.
   */
  if (gateway.writesThroughParadise) {
    const persistence = ctx.get('sessionPersistence')
    if (!isRecord(persistence) || typeof persistence.create !== 'function') {
      throw graftError(
        'PERSISTENCE_REQUIRED',
        'ctx.sessionPersistence is not mounted; a bare ctx.sessions.create session is not durable and cannot be cold-resumed',
      )
    }
  }

  inFlight.add(newId)
  try {
    // Phase 1 + 2: read, validate, locate boundary, build tape and plan.
    /**
     * THE SOURCE READ GOES THROUGH THE GATEWAY — unless the caller supplied a snapshot.
     *
     * `options.sourceSnapshot` bypasses the gateway on purpose: it exists so a caller that ALREADY holds
     * the log (a retry, a test, a replay) does not re-read it, and routing it through the gateway would
     * make a caller's own data subject to the gateway's availability.
     */
    const raw = options?.sourceSnapshot ?? (await gateway.readLog(sourceId))
    if (options?.sourceSnapshot === undefined && raw.readable !== true) {
      throw graftError('SOURCE_UNREADABLE', `源会话 ${sourceId} 的日志读不到（${raw.notes.join('; ') || 'no events'}）`)
    }
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

    /**
     * v7.7 — THE DURABLE WRITE GOES THROUGH `dsh-paradise`.
     *
     * WHAT THIS REPLACES: `ctx.sessions.prepare` + `sessionPersistence.create` + `handle.append` +
     * `handle.flush` + `handle.close`, plus the local rollback on failure. Those five calls are the
     * PHYSICAL layer — the exact set of host facts that the 彼岸层 exists to own so that two plugins
     * cannot drift apart on them.
     *
     * WHAT DID NOT MOVE, AND WHY
     *
     *   - THE TAPE ITSELF. `buildInjectionEvents` decides what a handoff SAYS: the replayed history,
     *     the task board, the constraints, the identity metadata. That is graft's policy, not a host
     *     fact — so the tape travels INTO the layer as `tape`, and the layer writes it verbatim after
     *     running its own shape validation.
     *   - THE PRE-WRITE VALIDATION. `assertColdLog` stays here and still runs FIRST. It is stricter than
     *     the protocol (it checks `sourceEventSeqs`, the assistant-echo stream shape, the skeleton
     *     numbering this plugin was configured with). The layer's validator is the floor; graft's is the
     *     ceiling, and a tape must clear both.
     *   - THE JOURNAL. `writeGraftTxn` is graft's own crash-recovery record: it says which source was
     *     migrating so the next start can mark a target instead of presenting it as usable. The layer
     *     knows nothing about source sessions being retired.
     */
    const prepared = { header: undefined as any }

    const headerCreatedAt = Number.isFinite(Number(raw?.session?.createdAt)) ? Number(raw.session.createdAt) : Date.now()
    const snapshot = materializeTape(events, headerCreatedAt)
    if (snapshot.length !== events.length) {
      throw graftError('APPEND_COUNT_MISMATCH', `materialised tape has ${snapshot.length} events, expected ${events.length}`)
    }
    // Pre-write validation, BEFORE the layer reserves anything. Failing here costs nothing.
    //
    // v7.7: the synthetic session must describe the header the layer is about to CREATE, not a
    // stub. `assertColdLog` re-checks the whole log shape including `assertTopLevelHeader` — which
    // requires `isSeeded === false` and no lineage. An earlier stub carrying only `cwd` therefore
    // failed this assertion on EVERY migration with `SEEDED_HEADER`, before a single byte was
    // written. The two facts asserted here are exactly the two the layer also enforces at
    // `prepare`: this is a brand-new top-level session with zero inherited events.
    assertColdLog(
      {
        inheritedEventCount: 0,
        session: { id: newId, cwd: plan.cwd, createdAt: headerCreatedAt, isSeeded: false },
        events: snapshot,
      } as any,
      plan.cwd,
      types,
      settings.skeletonTurn,
      settings.skeletonStep,
    )

    // v7.4 P0-2: journal the intent BEFORE reserving the id.
    //
    // Write-ahead is what makes recovery possible: a process killed right after the write has a record
    // saying which source was migrating and that a target may exist, so the next start can mark it
    // instead of presenting it as usable.
    writeGraftTxn(ctx, {
      sourceSessionId: sourceId,
      targetSessionId: newId,
      state: 'PREPARING',
      stage: 'paradise.create',
      updatedAt: new Date().toISOString(),
    })

    /* ── the write itself: ONE call, through the layer OR through the gateway ── */
    /**
     * WHY THERE ARE TWO WRITE PATHS AND NOT ONE.
     *
     * The layer's `session.create` is the CORRECT writer inside a host: it owns the tape shape, the seq
     * numbering, the system head, and the post-write verification, and reimplementing that here would put
     * a second copy of the host's write rules in a plugin.
     *
     * A gateway that writes its own files has none of those concerns — its "session" IS a `.jsonl` file —
     * and routing it through `ensureParadiseWrite` would make a bare machine depend on the host adapter
     * it exists to replace. So the gateway says which it needs, and the pipeline obeys.
     *
     * WHAT DOES NOT DIFFER: everything after this block. The tape, the boundary, the journal, the cold
     * verification and the receipt are identical on both paths — which is why the two can be trusted to
     * mean the same thing.
     */
    const created = await (async (): Promise<{ ok: boolean; stage: string; warnings: string[]; session?: { id: string; cwd: string }; error?: { code: string; stage: string; message: string } }> => {
      const tape = events.map((seed: any) => ({
        type: String(seed.type),
        data: seed.data as Record<string, any>,
        surface: seed.surface === true,
      }))
      if (!gateway.writesThroughParadise) {
        if (typeof gateway.writeTarget !== 'function') {
          return {
            ok: false,
            stage: 'gateway.writeTarget',
            warnings: [],
            error: {
              code: 'GATEWAY_CANNOT_WRITE',
              stage: 'gateway.writeTarget',
              message: '该网关声明不经过 paradise 写入，却没有提供 writeTarget —— 这是配置错误，不是降级',
            },
          }
        }
        /**
         * ── `plan.title` NEVER EXISTED, BUT THE INTENT DOES ───────────────────────────────────────
         *
         * `tsc` reported 2339 here (and at the two `title:` sites below): `Property 'title' does not
         * exist on type 'GraftPlan'`. Measured both directions:
         *   · `GraftPlan` (index.ts:575–640) has no `title` field;
         *   · `buildInjectionPlan` (index.ts:3836, 745 lines) never sets one — zero `title` properties
         *     in its return literal.
         *
         * So the old expression was `plan.title === undefined ? {} : { title: plan.title }` — always
         * `{}`, i.e. the target was NEVER given a title from this path. It read as a feature and was
         * dead code.
         *
         * The behaviour that shipped is "no title here", so that is what this now says. The derived
         * title on the other path (`[切片] ${sourceId}`) is untouched.
         */
        const written = await gateway.writeTarget({
          id: newId,
          cwd: plan.cwd,
          events: tape,
        })
        return {
          ok: written.ok,
          stage: written.stage,
          warnings: written.warnings,
          ...(written.ok ? { session: { id: newId, cwd: plan.cwd } } : {}),
          ...(written.error === undefined ? {} : { error: written.error }),
        }
      }
      const paradise = await ensureParadiseWrite(ctx)
      if (!paradise.ok || paradise.session === undefined) {
        return {
          ok: false,
          stage: 'paradise.resolve',
          warnings: [],
          error: {
            code: 'PARADISE_WRITE_UNAVAILABLE',
            stage: 'paradise.resolve',
            message: `${PARADISE_WRITE_MISSING_CONSEQUENCE}（${paradise.reason}）`,
          },
        }
      }
      /**
       * `plan.title` never existed (see the note above): the `??` fallback was therefore the ONLY
       * value this ever produced. Written directly so the code says what it does.
       */
      const viaLayer = await paradise.session.create({
        cwd: plan.cwd,
        title: `[切片] ${sourceId}`,
        id: newId,
        tape,
        ...(sourceAgentPreset === undefined ? {} : { inheritFrom: sourceId }),
        publish: false,
      })
      return {
        ok: viaLayer.ok,
        stage: viaLayer.stage,
        warnings: viaLayer.warnings,
        ...(viaLayer.session === undefined ? {} : { session: viaLayer.session }),
        ...(viaLayer.error === undefined ? {} : { error: viaLayer.error }),
      }
    })()
    if (!created.ok || created.session === undefined) {
      /**
       * A FAILED WRITE MUST NOT LOOK LIKE A HALF-WRITTEN ONE. The layer has already removed (or marked)
       * whatever it reserved, so this only has to journal the failure and re-throw — the previous
       * `discardPartialTarget` call is now the layer's job, and it verifies the absence with `stat`
       * instead of hoping.
       */
      markTargetBroken(ctx, newId, String(created.error?.message ?? 'write failed'), {
        sourceSessionId: sourceId,
        stage: `paradise.${created.stage}`,
      })
      throw graftError(
        created.error?.code ?? 'PARADISE_CREATE_FAILED',
        `切片写入失败@${created.stage}：${created.error?.message ?? '未知原因'}`,
      )
    }
    // The layer reports whether the cold read confirmed its own write. graft's own verify below is the
    // stricter, plugin-specific one that additionally checks the skeleton numbering it configured.
    const layerVerified = created.verified === true
    const layerWarnings: string[] = Array.isArray(created.warnings) ? created.warnings : []
    plan.warnings.push(...layerWarnings)

    writeGraftTxn(ctx, {
      sourceSessionId: sourceId,
      targetSessionId: newId,
      state: 'TARGET_FLUSHED',
      stage: 'paradise.flush',
      updatedAt: new Date().toISOString(),
    })
    // `prepared` is kept only for the fields read further down (`header.createdAt`); the layer owns the
    // real header now.
    prepared.header = { id: newId, cwd: plan.cwd, createdAt: headerCreatedAt }
    void layerVerified

    // Phase 4: cold-read verification of what was ACTUALLY persisted.
    //
    // The tape was already validated in memory before the write, so a failure here
    // means the persistence round-trip corrupted it — rare, and not something the
    // plugin can undo: the host exposes no delete. What it CAN do is make sure the
    // wreckage cannot be mistaken for a usable session, and keep the source alive.
    let verified = false
    if (settings.verifyReadBack) {
      try {
        /**
         * THE COLD READ-BACK GOES THROUGH THE GATEWAY TOO.
         *
         * THIS IS THE ONE READ THAT PROVES THE WRITE HAPPENED. Routing it through the same seam as the
         * source read is what makes a bare-machine gateway's verification mean something: it re-reads
         * the file it just wrote, by the same path, with no host in between.
         */
        const cold = await gateway.readLog(newId)
        /**
         * THE COMPARISON IS TAPE-TO-TAPE, SO A HEADER MUST BE REMOVED FIRST.
         *
         * `types` is derived from the tape (`materializeTape`), and the tape carries EVENTS ONLY — the
         * header is written separately by whoever owns the file. A reader that includes a `session` event
         * therefore has ONE MORE than the tape, and comparing them directly reports
         *
         *     cold-read event count 10 does not match written count 9
         *
         * on a write that was entirely correct.
         *
         * THE FIX IS A STRIP, NOT A LOOSER COMPARISON: relaxing the count check would let a lost event
         * slip through, which is the one thing this verification exists to catch.
         */
        const coldEvents = gateway.readLogIncludesHeader === true
          ? cold.events.filter((event) => event.type !== 'session')
          : cold.events
        assertColdLog(
          { ...cold, events: coldEvents, frameCount: coldEvents.length, framesDecoded: coldEvents.length, eventCount: coldEvents.length } as any,
          plan.cwd,
          types,
          settings.skeletonTurn,
          settings.skeletonStep,
        )
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
        /**
         * v7.7 — THE ROLLBACK GOES THROUGH THE LAYER.
         *
         * THE ORDER IS THE SAFETY: the mark above is written FIRST, so a process that dies between
         * these two steps leaves wreckage that cannot be mistaken for a usable session. The layer's
         * `deleteSession` then removes (or, if the host exposes no delete, re-marks) the artifact and
         * reports whether the absence was VERIFIED with `stat` — a claim this plugin used to make by
         * hoping.
         *
         * `void` is deliberate: a failed rollback must not replace the primary error. Losing the
         * original cold-read failure would leave a reader debugging the cleanup instead of the cause.
         */
        void rollbackTargetViaLayer(ctx, newId, `冷读校验失败：${String((error as any)?.message ?? error)}`)
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
        /**
         * ── WHY THIS ANNOTATION EXISTS: narrowing turned the failure branch into `never` ─────────
         *
         * `tsc` reported 2339 twice (`summary.sessionId`, `summary.updatedAt`) — not because the
         * fields are missing, but because the NEGATIVE branch had no type left:
         *
         *   `assertSessionSummary(payload): payload is { sessionId: string; updatedAt: number }`
         *
         * `updatedAt` here is `createdAt`, a `number`, and `sessionId` is a `string`, so this object
         * literal's static type ALREADY satisfies the predicate. TypeScript therefore narrows the
         * `true` branch of `if (!guard(summary))` to `never` — the branch that must REPORT the problem.
         *
         * Reproduced in isolation (three variants, `typescript` 5.9.3): an object literal that
         * satisfies the guard → `never`; the same value declared as `unknown`, or as a shape with
         * OPTIONAL fields → no diagnostic, and the report keeps working.
         *
         * ── THE TRAP THIS AVOIDS ─────────────────────────────────────────────────────────────────
         *
         * The tempting fix is `(summary as any).sessionId`, which deletes the evidence. The other is
         * dropping the guard, which deletes the check. The annotation keeps both: the runtime value is
         * byte-identical, the guard still runs, and the branch can still say what went wrong.
         *
         * The fields are optional ON PURPOSE: that is what tells the compiler "this might not satisfy
         * the predicate", which is exactly the real situation at runtime — `createdAt` can be NaN.
         */
        const summary: {
          sessionId?: string
          updatedAt?: number
          agentAvailable: boolean
          formatStatus: string
          running: boolean
          blank: boolean
          cwd?: string
        } = {
          sessionId: newId,
          // summarizeCold: updatedAt = max(createdAt, metadata.lastPromptAt ?? 0)
          updatedAt: createdAt,
          agentAvailable: false,
          formatStatus: 'current',
          running: false,
          blank: false,
          ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
        }
        /**
         * P1-3: the payload is a WIRE CONTRACT with the client (see `core/host-shape.ts`). A summary
         * the peer cannot key by is SKIPPED AND REPORTED, never emitted — and it is not a graft
         * failure either: the target is already durable and resumable at this point, so the worst
         * honest outcome is a reported sidebar gap, not an aborted handoff.
         */
        if (!assertSessionSummary(summary)) {
          plan.warnings.push(
            `client announcement skipped: unresolvable sessionId/updatedAt (sessionId=${JSON.stringify(summary.sessionId)})`,
          )
        } else {
          emit('api-session/added', summary)
        }
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
      persistConstraintSections(storeCtxOf())
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
        /**
         * THE SOURCE MARKER, THROUGH THE GATEWAY. A gateway with no live handles (a bare machine) simply
         * has nothing to append to — and returns quietly, which is the same outcome as a host whose
         * session is no longer live.
         */
        await gateway.markSourceTransferred?.(sourceId, `[已转移] → ${newId}`)
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
    let ignition = await attemptIgnition(ctx, settings, sourceId, newId, { cwd: plan.cwd })
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

/**
 * Register the tools and hooks.
 *
 * `apply` is the Cordis/DSh entry; `activate` is exported as the spec-requested
 * alias. Both are synchronous: registration must finish before the plugin is
 * considered active.
 */




function autoTargetId(settings: Required<GraftConfig>): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `${settings.autoGraftIdPrefix}-${suffix}`
}

/**
 * ── AUDIT ROUND 3 (P0-1): THE CALLING SESSION IS THE DEFAULT SOURCE ─────────────────────────────
 *
 * WHAT WAS WRONG, AND WHY IT WAS WORSE THAN A FAILURE.
 *
 * `graft_prepare` and `graft_slice_and_inject` required `sourceSessionId`, and the watermark nudge
 * told the model to call them. But NOTHING ever told the model its own session id — no tool returned
 * it, and the transcript does not contain it. So the model had to guess, and the measured outcome
 * was the dangerous one:
 *
 *     graft_prepare({})                        -> INVALID_ARGUMENT (blocked)
 *     graft_prepare({sourceSessionId:"current"}) -> session "current" not found
 *     graft_prepare({sourceSessionId:"<某个从别处抓来的旧会话 id>"}) -> SUCCEEDED
 *
 * That third id was scraped out of a stored skill's text — someone else's OLD session. The slice
 * succeeded and handed over the WRONG CONVERSATION, with no error anywhere. A silent wrong answer
 * beats a loud failure at being harmful.
 *
 * WHY THIS IS THE FIX AND NOT A NEW FEATURE: `graft_debug_status` ALREADY resolved exactly this way
 * (`:12786-12791` used `exec.agent.id`), so the correct pattern existed in the same file and simply
 * was not shared. Extracting it here is what makes the two call sites agree with the one that worked.
 *
 * THE ORDER IS DELIBERATE: explicit argument first (a caller may legitimately name another session —
 * that is how one session repairs another), then the calling agent. An empty result is a NAMED
 * refusal rather than a guess, because guessing is the failure being removed.
 */
function resolveSourceSessionId(explicit: unknown, exec: any): string {
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim()
  const calling = exec?.agent?.id
  if (typeof calling === 'string' && calling.trim().length > 0) return calling.trim()
  return ''
}

/** The calling session id, or '' when the host did not supply one. Used where only the caller makes sense. */
function callingSessionId(exec: any): string {
  const calling = exec?.agent?.id
  return typeof calling === 'string' ? calling.trim() : ''
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
  return join(storePaths().txnDir, `${encodeURIComponent(sourceSessionId)}.json`)
}

function writeGraftTxn(ctx: PluginContextLike | undefined, record: GraftTxnRecord): void {
  if (ctx === undefined) return
  try {
    mkdirSync(storePaths().txnDir, { recursive: true })
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
    files = readdirSync(storePaths().txnDir).filter((name) => name.endsWith('.json'))
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
            `${String((error as any)?.message ?? error)}; path ${storePaths().txnDir}`,
        )
      } catch {
        // Logging must not block activation.
      }
    }
    return { scanned: 0, rolledBack }
  }
  for (const file of files) {
    const path = join(storePaths().txnDir, file)
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
/**
 * v7.7 — roll back a target through the write layer, and NEVER replace the caller's error.
 *
 * The layer's `deleteSession` is the only rollback that can say "verified absent": it discards the
 * reservation, removes what it can, re-marks what it cannot, and answers with the `stat` result. The
 * older `discardPartialTarget` tried three methods and reported which ones threw — it could not tell
 * "removed" from "attempted".
 *
 * TWO THINGS ARE STILL THIS PLUGIN'S:
 *
 *   1. The ORDER. `markTargetBroken` ran before this call (see the cold-read catch), and the layer's
 *      own marking runs after the removal attempt. A crash in between therefore leaves a marked
 *      artifact, never a silent one.
 *   2. The DECISION TO IGNORE THE RESULT. A failed rollback must not mask the failure that caused it,
 *      so every outcome becomes a log line and the primary error keeps propagating.
 *
 * A missing layer is not an excuse to skip cleanup: resolution failures fall back to the old
 * best-effort path, which is the pre-v7.7 behaviour rather than a new failure mode.
 */
async function rollbackTargetViaLayer(ctx: PluginContextLike, targetId: string, why: string): Promise<void> {
  try {
    const paradise = await ensureParadiseWrite(ctx)
    if (!paradise.ok || typeof paradise.deletes !== 'function') {
      await discardPartialTarget(ctx, targetId)
      return
    }
    const rolled = await paradise.deletes(ctx, targetId, why)
    try {
      ctx.logger?.warn?.(
        rolled.removed
          ? `[dsh-graft-slice] rolled back failed target ${targetId} (${rolled.verified}${rolled.notes.length === 0 ? '' : `, ${rolled.notes.join(', ')}`})`
          : rolled.marked
            ? `[dsh-graft-slice] failed target ${targetId} could not be removed; it was MARKED so it cannot resume`
            : `[dsh-graft-slice] failed target ${targetId} could not be removed and could not be marked (${rolled.notes.join(', ') || 'no delete API on this host'})`,
      )
    } catch {
      // Logging must not replace the primary failure.
    }
  } catch (error) {
    try {
      ctx.logger?.warn?.(
        `[dsh-graft-slice] rollback of ${targetId} failed via the layer (${String((error as any)?.message ?? error)}); falling back to the local path`,
      )
    } catch {
      // Same.
    }
    await discardPartialTarget(ctx, targetId)
  }
}

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
 * v7.7: the Safe Harbor check and the task-boundary probe moved to `src/core/task-state.ts`
 * (`checkSafeHarbor` / `checkTaskBoundary` / `HarborState` / `TaskBoundaryState`).
 * Re-exported below — the call sites in this file are unchanged.
 */

/**
 * v6.3 module 4: confirmation valve.
 *
 * Silent migration is the right default, but a user mid-sentence can be
 * startled by a context switch. In 'confirm' mode the watermark only arms a
 * question; the migration itself waits for explicit agreement.
 *
 * The map (`pendingConfirms`), the busy-step retry set (`pendingGraftSources`), the
 * one-shot overflow guards (`overflowRetries`, `deferredOverflowTargets`) and the
 * per-session deferral counter (`taskBoundaryDeferrals`) are all declared in
 * `src/core/state.ts`. Their reasoning is preserved there, next to the declarations.
 */

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
 *
 * The mark's SHAPE (`GraftTargetMark`) and the map (`graftTargets`) live in `src/core/state.ts`
 * with the rest of this plugin's private state. Only the PERSISTENCE below stays here, because
 * it needs the store paths — which is exactly the split this module is for.
 */

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
  persistGraftTargetStore(storeCtxOf())
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
    mkdirSync(dirname(storePaths().graftTargets), { recursive: true })
    withFileLock(storePaths().graftTargets, () => {
      const merged = readJsonRecord(storePaths().graftTargets) as Record<string, GraftTargetMark>
      for (const id of remove) delete merged[id]
      for (const [id, mark] of graftTargets) merged[id] = mark
      for (const [id, mark] of Object.entries(merged)) {
        if (mark !== null && typeof mark === 'object' && typeof mark.sourceSessionId === 'string' && !graftTargets.has(id)) {
          graftTargets.set(id, mark)
        }
      }
      writeJsonAtomic(storePaths().graftTargets, merged)
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-graft-slice] cannot write ${storePaths().graftTargets}: ${String((error as any)?.message ?? error)}`)
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

function loadGraftTargetStore(ctx: PluginContextLike): void {
  try {
    const parsed = JSON.parse(readFileSync(storePaths().graftTargets, 'utf8'))
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
        ctx.logger?.warn?.(`[dsh-graft-slice] cannot read ${storePaths().graftTargets}: ${String((error as any)?.message ?? error)}`)
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
      /**
       * v0.9.3: the age limit is passed from CONFIG, and reaching it turns `safe` into `true` with a
       * reason naming how long it waited. That is the only place this session can recover once it goes
       * quiet — see `harborOpenCallMaxAgeMs` in the config docs.
       */
      const harbor = checkSafeHarbor(snapshotForHarbor, { openCallMaxAgeMs: settings.harborOpenCallMaxAgeMs })
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
      /** Same `never`-narrowing reason as the target path above: optional fields keep the report reachable. */
      const summary: {
        sessionId?: string
        updatedAt?: number
        agentAvailable: boolean
        formatStatus: string
        running: boolean
        blank: boolean
        cwd?: string
      } = {
        sessionId: id,
        // summarizeCold: updatedAt = max(createdAt, metadata.lastPromptAt ?? 0)
        updatedAt: typeof header?.createdAt === 'number' ? header.createdAt : Date.now(),
        agentAvailable: false,
        formatStatus: typeof record.formatStatus === 'string' ? record.formatStatus : 'current',
        running: false,
        blank: false,
        ...(cwd === undefined ? {} : { cwd }),
      }
      /**
       * P1-3: `header.createdAt` is the ONE field this sweep passes through uncoerced, and
       * `typeof NaN === 'number'` — so a damaged header produces a summary the client's `mergeSummary`
       * cannot key by. Skip THAT row and keep sweeping: one bad header must not hide every other
       * archived fork, and it must not be announced as a row that silently fails to appear.
       */
      if (!assertSessionSummary(summary)) {
        ctx.logger?.warn?.(
          `[dsh-graft-slice] archived fork ${JSON.stringify(id)} not announced: ` +
            `unresolvable sessionId/updatedAt (updatedAt=${String(summary.updatedAt)})`,
        )
        continue
      }
      emit('api-session/added', summary)
      announced += 1
    } catch {
      // A refused emit must not abort the sweep.
    }
  }
  return announced
}

import { classifyAgentCommand } from './core/command-guard.js'
import type { CommandAssessment, CommandRisk } from './core/command-guard.js'
export { classifyAgentCommand }
export type { CommandAssessment, CommandRisk }
import { evaluateCommandPolicy, policyDecision, scanAgentCommand } from './core/command-policy.js'
import type { CommandPolicyVerdict, CommandVerdict, PolicyDecision, SafetyMode } from './core/command-policy.js'
export { evaluateCommandPolicy, policyDecision, scanAgentCommand }
export type { CommandPolicyVerdict, CommandVerdict, PolicyDecision, SafetyMode }
import { FOLDED_OUTPUT_MARKER, HOST_NOISE_MARKER, HOST_PATH_MARKER, stripHostNoise } from './core/host-noise.js'
export { FOLDED_OUTPUT_MARKER, HOST_NOISE_MARKER, HOST_PATH_MARKER, stripHostNoise }
import { calculateAdaptiveDepth } from './core/adaptive-depth.js'
import type { AdaptiveDepthResult } from './core/adaptive-depth.js'
export { calculateAdaptiveDepth }
export type { AdaptiveDepthResult }
import { INSTRUCTION_CARD_MAX_CHARS, renderTaskBoard, BOARD_TRAILER } from './core/task-board.js'
import type { SemanticOutcomeKind, SemanticOutcome, SemanticDiscard, TaskBoardInput, BoardVerification } from './core/task-board.js'
export { INSTRUCTION_CARD_MAX_CHARS, renderTaskBoard, BOARD_TRAILER }
import { renderInstructionCard } from './core/instruction-card.js'
import type { SemanticNextAction, SemanticState, InstructionCardInput } from './core/instruction-card.js'
export { renderInstructionCard }
import { buildPendingState, neutralizeStructure, staleTodoHint } from './core/pending-state.js'
import type { LastStepScene } from './core/pending-state.js'
export { staleTodoHint }
export type { LastStepScene }
export type { SemanticNextAction, SemanticState, InstructionCardInput }
export type { SemanticOutcomeKind, SemanticOutcome, SemanticDiscard, TaskBoardInput, BoardVerification }

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
  const memoryDir = settings.memoryDir.length > 0 ? settings.memoryDir : join(dirname(storePaths().retired), '.dsh-memory')
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

  /**
   * ── AUDIT ROUND 3 (P0-1, the "how does the model learn its own id" half) ───────────────────────
   *
   * The caller's session id is reported AT THE TOP LEVEL, because it is the answer to the question
   * the watermark nudge creates and the transcript cannot answer: "which session am I?".
   *
   * `collectDebugStatus` ALREADY RECEIVED this value (the tool resolved it from `exec.agent.id`) and
   * simply never printed it — so the one tool that knew the answer kept it to itself, and the model
   * went looking in stored skills for something id-shaped. Measured consequence: a slice of a
   * different, older session, with no error.
   *
   * `resolvedFrom` is stated so a reader can tell "the host told us" from "an explicit argument was
   * passed" — those differ when a session is inspecting ANOTHER session on purpose.
   */
  if (input.sessionId !== undefined && input.sessionId.length > 0) {
    out.sessionId = input.sessionId
    out.sessionIdHint =
      'This is the session this tool call came from. Pass it as sourceSessionId to graft_prepare / ' +
      'graft_slice_and_inject when you mean "slice THIS session" — do not guess an id from memory ' +
      'or from a stored skill, and do not pass an id recorded in another session.'
  }

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
  /**
   * P1-2: THE LAYOUT GATE RUNS BEFORE ANY FILE IS OPENED.
   *
   * `readJsonl` below degrades every unreadable file to `[]`, which is right for a file that is
   * merely absent and wrong for a directory whose layout changed: the panel would print
   * `negatives: 0` for a store full of records, and nothing would say why. `.layout.json` — written by
   * `dsh-memory` at its activation — is the only thing that can tell those two apart.
   *
   * A refusal is REPORTED, never thrown out of the tool: this is the read-only debug panel, and
   * "the other plugin is a layout ahead" must not turn a status call into a failed tool call. The
   * panel says `available: false` with the reason, which is strictly more informative than the silent
   * zero it used to print.
   */
  try {
    assertLayoutSupported(memoryDir, { version: MEMORY_LAYOUT_VERSION, producer: 'dsh-memory' })
  } catch (error) {
    return {
      available: false,
      reason: 'LAYOUT_UNSUPPORTED',
      detail: String((error as any)?.message ?? error),
      memoryDir,
      skillsDir,
      counts: { skills: 0, negatives: 0, facts: 0, experiences: 0, suggestions: 0 },
    }
  }
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

/**
 * ── WHY THIS FUNCTION IS AT MODULE TOP LEVEL (it was inside `apply()` once) ─────────────────────
 *
 * It was first added directly above `takePendingConstraintMessages`, which is written at column 0
 * and therefore LOOKS top-level. It is not: that function is a CLOSURE inside `apply()` (it captures
 * `ctx`), so the helper inherited apply's scope. The two call sites inside apply worked; the two at
 * top level — `loadPendingConstraints` (A2) and `persistConstraintSections` (A4) — threw
 * `splitByShape is not defined`. A4's throw was swallowed by its own try/catch and only logged, so
 * the symptom appeared as "the shield must be written to disk" in v72-hardening rather than a crash.
 *
 * The lesson is not "indent carefully". It is that scope must be proven by the runtime (the runtime
 * said `typeof splitByShape === 'undefined'` at module end while the text said column 0), and that a
 * catch-all try/catch around a ledger write can hide a ReferenceError for an entire release.
 */

/**
 * ── A-FAMILY: ONE FILTER, FOUR SITES ────────────────────────────────────────────────────────────
 *
 * The shape judge is applied where a constraint is ACCEPTED or WRITTEN, not only where it is
 * extracted. Extraction is one door; a rule can also arrive from the pending queue, from an earlier
 * generation's ledger, or from a handoff block being rendered right now. Filtering only the first
 * door leaves the other three open — measured: the live contamination arrived through the ledger.
 *
 * Every call returns the survivors AND the rejects, so no path can drop something without a record.
 */
function splitByShape(
  texts: readonly string[],
  stage: ConstraintShapeDrop['stage'],
): { kept: string[]; dropped: ConstraintShapeDrop[] } {
  const kept: string[] = []
  const dropped: ConstraintShapeDrop[] = []
  for (const text of texts) {
    const verdict = shapeOfConstraint(text)
    if (verdict.broken) {
      dropped.push({ text, code: verdict.code ?? 'S1_JSON', why: verdict.why ?? '', stage })
      continue
    }
    kept.push(text)
  }
  return { kept, dropped }
}

export function apply(ctx: PluginContextLike, config: GraftConfig = {}): void {
  const settings = normalizeConfig(config)
  configureRetiredStore(ctx, settings)
  // v0.14 D5: reclaim locks left by dead processes BEFORE anything reads state.
  // A crashed writer's `.lock` directory is invisible until someone contends for
  // that file, and a clean start contends for nothing.
  //
  // ── `PLUGIN_DIR` HERE IS DELIBERATE — DO NOT REMOVE IT AS "LEFTOVER FROM P4" ─────────────────────
  //
  // Before P4 every store path defaulted to `join(PLUGIN_DIR, …)`, so a plugin that crashed BEFORE its
  // first assembly left `.lock` directories in the PACKAGE directory. Those locks are still on disk for
  // existing users, and the sweep below is the only thing that will ever clear them. The second element
  // is therefore kept on purpose and is NOT in the golden file's coverage (the golden pins where stores
  // are WRITTEN, not where stale locks are SWEPT).
  //
  // Removing it would strand those old locks forever — a deadlock that no test in this repo can see,
  // because a machine without a pre-P4 crash has no such file. Anything changing this line must be
  // reviewed by hand.
  try {
    lastLockCleanup = scanAndReclaimLocks([dirname(storePaths().retired), PLUGIN_DIR])
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
    mkdirSync(dirname(storePaths().drafts), { recursive: true })
    writeJsonAtomic(storePaths().drafts, [...draftPayloads.values()])
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
 * The message travels through pre-step `messages` as a USER-role message with a
 * `[系统提示]` header. That is a host constraint, not a style choice: DSH records
 * every pre-step message as a `user/message` event and its validator requires the
 * event type and the message role to agree, so a `developer` role here throws
 * `developer/message and developer role must occur together` and kills the step.
 * A real `developer/message` event can only be written directly, against an open
 * turn/step — which is the write this pre-step channel exists to avoid.
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
  /**
   * ── A1: FILTER BEFORE INJECTING, AND SAY HOW MANY WERE DROPPED ────────────────────────────────
   *
   * This is the door the live contamination used in generation 8: five fragments went out as
   * "[系统提示] 这个会话从旧会话继承了以下长期约束". The irony is worth naming — injecting garbage
   * *properly framed* is still injecting garbage, which is exactly the C2 note in the backlog.
   *
   * A message whose rules are ALL rejected is not sent at all: an empty "以下约束，请遵守：" block is
   * worse than silence, because a reader will look for rules that are not there.
   */
  const accepted = splitByShape(payload.constraints, 'accept')
  if (accepted.dropped.length > 0) {
    ctx.logger?.warn?.(
      `[dsh-graft-slice] dropped ${accepted.dropped.length} malformed inherited constraint(s) for ${agentId}: ` +
        accepted.dropped.map((drop) => `${drop.code}`).join(','),
    )
  }
  if (accepted.kept.length === 0) return []
  ctx.logger?.info?.(`[dsh-graft-slice] injecting ${accepted.kept.length} async constraint(s) into ${agentId}`)
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
            ...accepted.kept.map((item, index) => `${index + 1}. ${item}`),
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
       * It travels as a user-role `[系统提示]` message through pre-step `messages`.
       * That channel is the one place a listener can reach the model without
       * writing an event (and therefore without consuming a step number — writing
       * one here would collide with the v4 step ordering, the bug that once
       * corrupted a log). The role is FORCED: DSH records every pre-step message
       * as `user/message`, and its validator requires type and role to agree, so
       * a `developer` role here throws `developer/message and developer role must
       * occur together` and kills the session (measured at seq 1046).
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
      /**
       * v7.8 — THE ROLLBACK NOTICE RIDES THIS SAME CHANNEL.
       *
       * `rollbackFailedIgnition` used to write a `developer/message` with `{ turn: 0, step: 0 }` into
       * the source's log. That is not a real round and the host's resume-time format validation rejects
       * it — on the SOURCE session, the one the user is still working in. So the notice is queued
       * instead, and delivered here: `messages` reach the model without touching the persisted
       * lifecycle, consume no step, and cannot produce a format violation because nothing is written.
       *
       * Positioned right after `extra` on purpose: both are one-shot system notes to the model, and a
       * reader looking for "what does this plugin tell the session" finds them together.
       */
      const rollbackExtra = takeRollbackNotice(agentId)
      const rollbackMessages = rollbackExtra === undefined ? [] : [rollbackExtra]
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
      const appended = [...guardMessages, ...extra, ...rollbackMessages, ...planExtra, ...modelExtra, ...urgentExtra]
      /**
       * THE EMPTY CASE MEANS "NOTHING TO SAY", AND THE ROLLBACK NOTICE COUNTS AS SOMETHING.
       *
       * `appended.length === 0` returns the decision untouched — a fast path for the overwhelmingly
       * common turn where this plugin adds nothing. `rollbackMessages` is therefore part of the SAME
       * array: folding it in anywhere else (or appending it after this check) would deliver the notice
       * only on turns where some OTHER feature also fired, which is a notice that arrives at the wrong
       * time or never.
       */
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
    // step is not a boundary, even under overflow. v0.9.3: and the same age limit, or a session whose
    // tool call never returned could never recover from an overflow either.
    const harbor = checkSafeHarbor(events, { openCallMaxAgeMs: settings.harborOpenCallMaxAgeMs })
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
    /**
     * v1.2 P0 — THE SESSION-INDEPENDENT VARIANT, mirroring `memory-console-global`.
     *
     * The panel's data is global (knobs, thresholds, pending ignitions, session list), yet
     * the only variant that existed was the agent-scoped one. Executed against a real
     * session the host answered `{ ok: true }` and put the payload somewhere the bridge
     * could not see, which is exactly the "unrecognised shape" the panel reported.
     *
     * This variant takes no agent state at all, so its answer is always the JSON payload —
     * the same shape the memory console has been answering with all along.
     */
    commands.register({
      name: 'graft-console-global',
      description:
        '读取不依赖具体会话的转生控制台状态（开关、阈值、点火队列、会话列表）。Read the session-independent graft console state.',
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
          /**
           * AUDIT ROUND 3 (P0-1): the default is stated, and it is the ONLY default that can be
           * correct here. The model cannot know its own session id from the transcript, so requiring
           * it forced a guess — and the measured guess was a DIFFERENT, OLDER session, which sliced
           * the wrong conversation with no error. Omitting it now means "this session".
           */
          description:
            'Finished source session id. **Default: the session calling this tool.** Pass an explicit ' +
            'id only to slice a DIFFERENT session (e.g. repairing another one).',
        },
        newSessionId: {
          type: 'string',
          /**
           * AUDIT ROUND 3 (P0-2): optional, and generated the same way `autoGraft` generates it.
           *
           * `graft_prepare` has always accepted an omitted target ("one is generated when omitted"),
           * so requiring one here made the two tools disagree about the same decision — and forced
           * the model to invent an id for no reason.
           */
          description:
            'New session id to create. Optional — one is generated (same scheme as autoGraft) when ' +
            'omitted. Must not be live or persisted already; must differ from the source.',
        },
        allowReslice: {
          type: 'boolean',
          description:
            'Slice a source that was already migrated (retired or transferred). Default false — ' +
            're-slicing a handed-off conversation is how two divergent targets appear.',
        },
      },
      required: [],
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
      /**
       * AUDIT ROUND 3 (P0-1/P0-2): both ids now have the right defaults, and neither is a guess.
       *
       * The refusal is NAMED and says what to do, because the failure this replaces was a silent
       * wrong slice — a loud empty-argument error is strictly better than a successful slice of
       * somebody else's conversation.
       */
      const sourceSessionId = resolveSourceSessionId(args.sourceSessionId, exec)
      if (sourceSessionId.length === 0) {
        throw graftError(
          'INVALID_ARGUMENT',
          'sourceSessionId 缺失且宿主没有提供当前会话 id；请显式传入 sourceSessionId（可用 graft_debug_status 查询当前会话 id）',
        )
      }
      const newSessionId =
        typeof args.newSessionId === 'string' && args.newSessionId.trim().length > 0
          ? args.newSessionId.trim()
          : autoTargetId(settings)
      assertResliceAllowed(sourceSessionId, args.allowReslice === true)
      return graftSliceAndInject(
        ctx,
        settings,
        sourceSessionId,
        newSessionId,
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
          /**
           * AUDIT ROUND 3 (P0-1): this is the tool the watermark nudge tells the model to call, and
           * it used to demand an id the model had no way to obtain. See `resolveSourceSessionId`.
           */
          description:
            'The session whose log should be sliced. **Default: the session calling this tool.**',
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
        handover: {
          type: 'object',
          /**
           * TD-11: the model's own handoff content. Two fields, and the exclusions are the design
           * (see `ModelHandover`): no `goal` (TD-18 owns that field) and no `constraints` — a model
           * may not author a red line, because that would bypass `shapeOfConstraint`.
           *
           * `additionalProperties: false` is deliberate: an undeclared field must fail loudly
           * rather than be silently dropped, which is how a caller would come to believe it had
           * supplied a constraint.
           */
          description:
            'Optional content YOU supply for this handoff, overriding the extracted defaults. ' +
            '`pending` replaces the 待开始 column (labelled 「模型提供」 there); `notes` is appended ' +
            'as a labelled section. Constraints and the goal are NOT settable here on purpose: ' +
            'constraints may only be extracted from the source log (they pass a shape judge), and ' +
            'the goal comes from the session objective.',
          properties: {
            pending: {
              type: 'array',
              items: { type: 'string' },
              description: 'Next actions, in order. Replaces the transcript-derived 待开始 list.',
            },
            notes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Extra context for the target, rendered as its own labelled section.',
            },
          },
          additionalProperties: false,
        },
      },
      required: [],
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
    execute: async (args: any, exec: any) => {
      if (!isRecord(args)) throw graftError('INVALID_ARGUMENT', 'arguments must be an object')
      const sourceSessionId = resolveSourceSessionId(args.sourceSessionId, exec)
      if (sourceSessionId.length === 0) {
        throw graftError(
          'INVALID_ARGUMENT',
          'sourceSessionId 缺失且宿主没有提供当前会话 id；请显式传入 sourceSessionId（可用 graft_debug_status 查询当前会话 id）',
        )
      }
      assertResliceAllowed(sourceSessionId, args.allowReslice === true)
      /**
       * TD-11: read the optional `handover`. Only `pending` and `notes` are read; anything else
       * in the object is ignored rather than silently accepted (the schema already refuses
       * undeclared fields, so reaching here with one means a caller bypassed validation —
       * ignoring unknown keys is the fail-closed half of that pair).
       */
      const rawHandover = isRecord(args.handover) ? args.handover : undefined
      const asStringList = (value: unknown): string[] | undefined => {
        if (!Array.isArray(value)) return undefined
        const items = value.filter((item): item is string => typeof item === 'string')
        return items.length === 0 ? undefined : items
      }
      const handoverPending = rawHandover === undefined ? undefined : asStringList(rawHandover.pending)
      const handoverNotes = rawHandover === undefined ? undefined : asStringList(rawHandover.notes)
      const handover =
        handoverPending === undefined && handoverNotes === undefined
          ? undefined
          : {
              ...(handoverPending === undefined ? {} : { pending: handoverPending }),
              ...(handoverNotes === undefined ? {} : { notes: handoverNotes }),
            }
      return prepareSlice(
        ctx,
        settings,
        sourceSessionId,
        typeof args.targetSessionId === 'string' && args.targetSessionId.length > 0 ? args.targetSessionId : undefined,
        handover,
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
    /**
     * v1.4 P0 — THE OUTPUT CONTRACT IS MANDATORY on 0.2.2.
     *
     * Without it the whole ENTRY fails to activate:
     * `TypeError: tool "graft_update_goal" must declare output { schema, render, presentationMeta? }`
     * — and a failed entry takes the Web boot with it, so the app cannot start at all.
     * The schema is permissive on purpose: the tool's value is a small status object and the
     * host only needs to know it is an object.
     */
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          currentGoal: { type: 'string' },
          previousGoal: { type: 'string' },
          revisions: { type: 'number' },
          unchanged: { type: 'boolean' },
          note: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
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
      persistGraftTargetStore(storeCtxOf())
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
      //
      // `PLUGIN_DIR` is the same deliberate second directory as the activation sweep above: pre-P4 locks
      // live in the package root and this dry run must REPORT them, not silently forget them. Not covered
      // by the golden file (which pins written stores); a change here needs hand review.
      const locks = scanAndReclaimLocks([dirname(storePaths().retired), PLUGIN_DIR], true)
      const txns = (() => {
        try {
          return readdirSync(storePaths().txnDir)
            .filter((name) => name.endsWith('.json'))
            .map((name) => {
              try {
                const record = JSON.parse(readFileSync(join(storePaths().txnDir, name), 'utf8')) as Record<string, unknown>
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
import type { SessionHeaderLike, SessionLogSnapshotLike, PreparedSessionLike, SessionStoreLike, SessionQueryLike, ToolRegistryLike, PluginContextLike } from './core/gateway-types.js'
import { GraftConfig } from './core/graft-config.js'
import { GraftBoundary, GraftSource, GraftTape, GraftTapeTurn } from './core/tape-shape.js'
import { RuntimeIntent, sessionTitleForGoal, sourceForReport } from './core/host-shape.js'
import { readLedgerEpoch } from './core/ledger.js'
import { Truncation } from './utils/serialize.js'
import { POINTER_SENTENCE_PATTERN } from './core/pending-state.js'








interface SessionHandleLike {
  append(events: readonly SessionEventLike[], options?: any): Promise<void>
  flush(options?: any): Promise<void>
  close(): Promise<void>
}

interface SessionPersistenceLike {
  create(header: SessionHeaderLike, options?: any): Promise<SessionHandleLike>
  stat?(id: string): Promise<unknown | undefined>
}









/** Test-only: where the durable stores currently resolve. */
let lastRecovery: { scanned: number; rolledBack: string[] } | undefined

/**
 * v0.14 D5: what the activation lock sweep found and did, so the debug panel can
 * show the reclamation without re-running it.
 */
let lastLockCleanup: LockEntry[] = []

/**
 * WIRE `core/ignition.ts` TO THIS FILE'S STATE — at the END of the module, where every declaration exists.
 *
 * THREE THINGS ABOUT THIS THAT ARE NOT STYLE
 *
 *  1. IT MUST BE AT THE BOTTOM. `graftTargets` (~line 9870), `pendingGraftSources` and `pendingConfirms`
 *     are declared thousands of lines below `configureRetiredStore`. Building the deps object up there
 *     would read those bindings before initialisation — a temporal-dead-zone crash that the bundler turns
 *     from a build error into a runtime one.
 *
 *  2. IT REGISTERS A RESOLVER, NOT A VALUE. The module asks for the state on each use, so a test that
 *     imports `igniteTargetSession` and calls it WITHOUT running `apply()` still gets the real maps
 *     instead of a private fallback. That distinction is load-bearing: with a fallback, the per-target
 *     admission guard and the retry's "grown past its seed" check both silently degrade, and the suite
 *     catches it as a warm target being prompted twice.
 *
 *  3. THE PATHS ARE THUNKS. `configureRetiredStore` reassigns `retiredStorePath` /
 *     `transferredStorePath` whenever a profile or `dataDir` is resolved, and a test re-configures to a
 *     fresh directory mid-suite. A snapshot would roll back into the PREVIOUS profile's ledger — the
 *     source left retired on disk while the in-memory set was cleared, which is the double-blind state
 *     the rollback exists to end.
 */
setIgnitionDepsResolver(
  (): IgnitionDeps => ({
    admissions: ignitionAdmissions,
    pending: pendingIgnitions,
    pendingPath: () => storePaths().pendingIgnition,
    targets: graftTargets as unknown as Map<string, { seedEvents?: number }>,
    retired: retiredSessions,
    transferred: transferredSessions as unknown as Map<string, unknown>,
    autoGraftStates: autoGraftStates as unknown as Map<string, string>,
    autoGraftInFlight: autoGraftInFlight as unknown as Map<string, unknown>,
    pendingGraftSources: pendingGraftSources as unknown as Map<string, unknown>,
    pendingConfirms: pendingConfirms as unknown as Map<string, unknown>,
    retiredStorePath: () => storePaths().retired,
    transferredStorePath: () => storePaths().transferred,
    rollbackNoticed,
    rollbackNotices,
    audit: (entry) => appendGraftAudit(entry as unknown as GraftAuditEntry),
    logWarn: (message) => {
      try {
        storeCtxOf()?.logger?.warn?.(message)
      } catch {
        // Logging must never change a migration outcome.
      }
    },
  }),
)

/**
 * The read-only views the test suite imports.
 *
 * NOT re-exported from `core/ignition.ts` because the maps they expose are declared HERE — the module
 * only reaches them through the resolver. A caller inspecting the queue is inspecting THIS plugin's
 * state, so the accessors belong to this file.
 */
export function getPendingIgnitions(): ReadonlyMap<string, PendingIgnition> {
  return pendingIgnitions
}

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
