/**
 * THE PLUGIN'S OWN STATE — `src/core/state.ts`.
 *
 * WHAT THIS FILE IS FOR
 *
 * `index.ts` is 12 000 lines and mixes three different things: the host-facing plugin (tools,
 * waterfalls, prompts), the migration policy, and the in-memory bookkeeping that keeps a pass from
 * running twice. This module exists so the third one has a home with a single sentence of meaning:
 * **every collection here is process-local state that the plugin owns and no other plugin may see.**
 *
 * WHY THAT MATTERS FOR INDEPENDENCE, NOT JUST FOR TIDINESS
 *
 * The three plugins are supposed to run side by side without sharing memory or configuration. The way
 * that property actually breaks is never a deliberate shared registry — it is a map that a second
 * plugin can reach because it happened to be declared at module scope somewhere reachable. Declaring
 * them here, exported to nobody but `index.ts`, makes the boundary a fact of the file layout: there is
 * exactly one module that can name these bindings, and it is this plugin's own entry point.
 *
 * NOTHING HERE TOUCHES A HOST. No `ctx`, no service lookup, no adapter import. The one host-shaped
 * piece of graft's configuration — where the store files live — stays in `index.ts`, because that is
 * resolved from the profile at activation and is a decision, not state. This file only declares the
 * containers and the directory the plugin itself sits in.
 *
 * WHY `PLUGIN_DIR` MOVED TOO
 *
 * It was `dirname(fileURLToPath(import.meta.url))` where the path defaults were written. The bundle
 * inlines every module into `index.js`, so `import.meta.url` resolves to the same shipped file no
 * matter which module spells it — moving the declaration changes nothing at runtime, and it lets the
 * path defaults in `index.ts` keep reading it without a second copy.
 *
 * WHY THE PATHS ARE *NOT* HERE
 *
 * They are reassigned by `configureRetiredStore` when a profile or `dataDir` is resolved. An imported
 * ESM binding is read-only in the importer, so a `let` moved here could not be reconfigured from
 * `index.ts` — the plugin would silently keep writing into the plugin directory instead of the
 * profile. Collections are different: nobody rebinds them, they are only mutated, which is legal.
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { PendingIgnition } from './ignition.js'

/** The directory the shipped bundle lives in (`index.js`), used for default store locations. */
export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/* ── the durable ledgers, mirrored in memory ──────────────────────────────────────────────── */

/** Sessions whose log has been handed off and must not be resumed. */
export const retiredSessions = new Set<string>()
/** Sources that were handed off: which target replaced them, when, and why. */
export const transferredSessions = new Map<string, { newSessionId: string; at: number; reason: string }>()

/* ── the auto-graft queue ─────────────────────────────────────────────────────────────────── */

/** Sessions with an auto-graft decision in flight, so one pass cannot start twice. */
export const autoGraftInFlight = new Set<string>()
/** Per-session progress through the auto-graft pipeline: idle → grafting → done. */
export const autoGraftStates = new Map<string, 'idle' | 'grafting' | 'done'>()
/** Sessions whose transition card has already been shown. */
export const transitionCards = new Set<string>()
/** Target ids currently being built, so two builders cannot pick the same id. */
export const inFlight = new Set<string>()

/** v6.3 module 1: sessions that hit a busy step and must retry at turn/end. */
export const pendingGraftSources = new Set<string>()

/**
 * v6.0 补丁一：草稿捕获。
 *
 * 用户在旧会话被拦截的那一瞬间正在输入的内容，不应该凭空消失。
 * 拦截时捕获，写盘；target 第一次收到输入时把草稿和新输入合并成一条，
 * 然后立刻删除——只生效一次。
 */
export interface DraftPayload {
  sourceSessionId: string
  targetSessionId: string
  text: string
  capturedAt: number
}

export const draftPayloads = new Map<string, DraftPayload>()

/* ── the confirmation gate ───────────────────────────────────────────────────────────────── */

export interface PendingConfirm {
  targetId: string
  askedAt: number
  ratio: number
}

/** Watermark questions already asked, per source session. */
export const pendingConfirms = new Map<string, PendingConfirm>()

/**
 * v7.0 P6: sessions whose request overflowed once already.
 *
 * The retry the host performs after a successful recovery must not become a
 * migration loop: if the freshly built tape is itself larger than the window,
 * the retried request overflows again, and a second migration would produce the
 * same tape. One attempt per session is the honest limit — the second overflow
 * is surfaced to the caller instead of being papered over.
 */
export const overflowRetries = new Set<string>()

/**
 * v7.0 P6: overflow recoveries that produced a target but deliberately did NOT
 * retire the source.
 *
 * The retry has to run in the source session, so retirement cannot happen
 * before it. These entries are consumed by the source's next `agent/pre-step`,
 * which is the earliest moment the user can be redirected to the target.
 */
export const deferredOverflowTargets = new Map<string, string>()

/**
 * v7.3: per-session count of task-boundary deferrals.
 *
 * The cap exists so a session whose "task" never reaches a clean boundary — an
 * expected failure, a flaky test, a red the user decided to live with — still
 * migrates. Without it, the probe converts "wait for a good moment" into "never
 * move", which is worse than cutting in an awkward place.
 */
export const taskBoundaryDeferrals = new Map<string, number>()

/* ── the goal chain ──────────────────────────────────────────────────────────────────────── */

export interface GraftTargetMark {
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

export const graftTargets = new Map<string, GraftTargetMark>()

/* ── constraint carry-over ───────────────────────────────────────────────────────────────── */

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
export interface PendingConstraintPayload {
  sourceSessionId: string
  targetSessionId: string
  constraints: string[]
  source: 'llm'
  extractedAt: number
}

export const pendingConstraints = new Map<string, PendingConstraintPayload>()
export const constraintsApplied = new Set<string>()
/**
 * Sessions that were already reasserted their constraints once.
 *
 * One per process. The system-prompt section is the durable channel; this is the
 * one-shot fallback for a host (or a start-up ordering) where the section was
 * not registered. Repeating it every step would make a standing rule read like
 * a nag and cost the recency position on every request.
 */
export const constraintsReasserted = new Set<string>()

/**
 * v0.14 D1: sessions that already received the workspace red line through the
 * pre-step `messages` channel. Same discipline as `constraintsReasserted`: the
 * system-prompt section is the durable channel, this is the one-shot in-band
 * fallback for a host where the section could not be registered.
 */
export const guardReasserted = new Set<string>()

export const constraintsInFlight = new Set<string>()

/**
 * v7.4: sessions resumed from retirement, and when their auto-graft grace ends.
 *
 * Without this, "undo the migration" is a two-step loop: resume, speak once, get
 * migrated again. The log does not shrink on resume, so the watermark is still
 * over the ratio the moment the user types.
 */
export const autoGraftSuppressedUntil = new Map<string, number>()

/* ── ignition ────────────────────────────────────────────────────────────────────────────── */

/**
 * THE IGNITION STATE LIVES HERE; the functions live in `core/ignition.ts`.
 *
 * These declarations are read by code this plugin still owns: the pre-step gate consults
 * `ignitionAdmissions`, the debug-status tool serialises `pendingIgnitions`, and
 * `configureRetiredStore` resets all of them.
 */
export const pendingIgnitions = new Map<string, PendingIgnition>()
/** Admissions recorded in this process, per TARGET. See the routing note in core/ignition.ts. */
export const ignitionAdmissions = new Map<string, { at: number; promptChars: number }>()
/** Sources already told about a rollback in this process, so the same notice is written twice. */
export const rollbackNoticed = new Set<string>()
/**
 * v7.8 — THE ROLLBACK NOTICES WAITING FOR DELIVERY, per source session.
 *
 * Replaces the `live.append('developer/message', { turn: 0, step: 0 })` that used to put the notice
 * into the source's log. That shape is not a real round, and the host's resume-time format validation
 * rejects it; the notice now travels through the pre-step `messages` channel instead, which writes
 * nothing and consumes no step.
 */
export const rollbackNotices = new Map<string, { text: string; at: number; targetId: string }>()

/* ── the standing-constraint shield ──────────────────────────────────────────────────────── */

/**
 * v7.0 P0-5: the constraints this plugin keeps rendering into a target's system prompt, keyed by
 * target session id.
 *
 * Separate from `pendingConstraints` (which is a one-shot queued refinement): this map is the
 * durable, every-request source of truth for a target's standing rules. It is in-memory because the
 * goal `user/message` already persists the same list — a restart loses this map and the section
 * renders `''`, while the goal message still carries the constraints, so nothing is lost, only
 * re-hardened once the session is grafted again.
 */
export const targetConstraintSections = new Map<string, { constraints: string[]; at: number }>()

/* ── the leftover-target ledger ──────────────────────────────────────────────────────────── */

/**
 * A target left behind by an interrupted migration.
 *
 * `markTargetBroken` writes a `[损坏]` title, but only to a LIVE session handle. A target that
 * failed before cold verification is cold: the host exposes no `open(id,'write')` here, so the
 * plugin cannot relabel it. What it CAN do is keep a ledger of "these ids exist and are not a
 * finished handoff", and say so in the next review.
 */
export interface LeftoverTarget {
  targetId: string
  sourceSessionId: string
  stage: string
  reason: string
  at: string
}

export const leftoverTargets = new Map<string, LeftoverTarget>()
/** How many leftovers are remembered before the oldest is dropped. */
export const LEFTOVER_CAP = 20

/* ── the plan / watermark nudges ─────────────────────────────────────────────────────────── */

export interface PlanNudgeState {
  userKey: string
  turns: number
  nudged: boolean
  lastNudgeTurn: number
}

export const planNudgeStates = new Map<string, PlanNudgeState>()
/**
 * v1.0.0 P0 — THE ONLY COLLECTION WITHOUT AN EXIT, AND WHY IT NOW HAS TWO.
 *
 * The audit flagged this map as the single real leak: `planNudgeStates.set(agentId, …)` on
 * every pre-step with **no delete anywhere**. Every other session-keyed collection in this
 * file has at least one delete or clear; this one had none, which is exactly the discipline
 * breach the audit was describing.
 *
 * Two exits, because one is not enough:
 *
 *   1. `rememberPlanNudge()` evicts the oldest entry past `PLAN_NUDGE_CAP`. A cap is the
 *      exit that does not depend on ANY lifecycle event being wired correctly — and there
 *      are six different places that retire a session in this file. A cleanup attached to
 *      five of them is a leak that looks fixed.
 *   2. `forgetPlanNudge()` for callers that DO know a session is gone.
 *
 * Map preserves insertion order, so "oldest" is "least recently written" — `remember`
 * re-inserts on every write, which makes the eviction order match usage rather than
 * creation. That matters: an actively nudged long-lived session must not be evicted ahead
 * of a hundred sessions that finished days ago.
 *
 * WHY NOT `WeakMap`: the key is a session id string, not an object. A string key in a weak
 * collection is never collectable, so `WeakMap` would look like a fix and behave like the
 * leak.
 */
export const PLAN_NUDGE_CAP = 500

/** Drop one session's nudge state. Safe on an unknown id. */
export function forgetPlanNudge(agentId: string): void {
  planNudgeStates.delete(agentId)
}

/**
 * Store a session's nudge state, re-inserting so eviction is LRU, then trim to the cap.
 * Returns the stored state so callers can keep using the object they passed.
 */
export function rememberPlanNudge(agentId: string, state: PlanNudgeState): PlanNudgeState {
  planNudgeStates.delete(agentId)
  planNudgeStates.set(agentId, state)
  while (planNudgeStates.size > PLAN_NUDGE_CAP) {
    const oldest = planNudgeStates.keys().next().value
    if (oldest === undefined) break
    planNudgeStates.delete(oldest)
  }
  return state
}

/** agentId → the `turn` whose model-driven nudge was already sent. */
export const modelDrivenNudgeTurns = new Map<string, number>()

/**
 * v7.9: sessions that were nudged at the lead watermark and kept working anyway.
 *
 * The nudge is advisory, but "advisory" must not mean "ignorable until the process is cut
 * mid-write". After the nudge, the first pre-step proves the model started another step; that step
 * gets ONE hard instruction and the session is marked. If the model still ignores it, the hard
 * cutoff runs with the mark, and the target's pending state records that the cut was forced.
 */
export const watermarkEscalations = new Map<string, { at: number; ratio: number; sinceSeq: number }>()
export const watermarkEscalated = new Set<string>()
export const forcedCutMarks = new Map<string, { ratio: number; at: number }>()

/* ── the two-phase slice ─────────────────────────────────────────────────────────────────── */

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
  /** TD-11: how many `handover.pending` items the review carried (0 = none supplied). */
  handoverPendingCount?: number
  /** TD-11: how many `handover.notes` items the review carried (0 = none supplied). */
  handoverNoteCount?: number
  /** v7.4: the reviewed chunk bodies, for tail-vs-history comparison at commit. */
  chunks?: Array<{ kind: string; text: string }>
}

/** Reviewed-but-not-committed slices, by `preparedId`. */
export const preparedSlices = new Map<string, PreparedSlice>()
