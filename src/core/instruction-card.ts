import { BOARD_TRAILER, renderTaskBoard } from './task-board.js'
import type { BoardVerification } from './task-board.js'

export interface SemanticNextAction {
  text: string
  source: 'todo' | 'user' | 'plan' | 'unresolved-error' | 'goal'
  seq?: number
  blockedByError?: true
}

export interface SemanticState {
  outcome?: SemanticOutcome
  /** The newest failure that NOTHING later succeeded past. */
  unresolvedError?: { text: string; seq: number; tool: string }
  next?: SemanticNextAction
  discarded: SemanticDiscard
}

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
  /** TD-11: forwarded to `renderTaskBoard` so the 待开始 heading can carry its source label. */
  pendingSource?: 'transcript' | 'model'
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
  /** C1: which layer produced `request` — rendered as a trust label beside the requirement. */
  goalLayer?: 'objective' | 'dag-node' | 'transcript'
  /** C1 hard rule 2: a newer human message that changed direction after the objective. */
  supersededBy?: { text: string; seq?: number; afterObjective: boolean }
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
    ...(input.pendingSource === undefined ? {} : { pendingSource: input.pendingSource }),
    ...(input.hasWrittenPlan === true ? { hasWrittenPlan: true } : {}),
    stopPoint: input.stopPoint,
    ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
    pointerCount: input.pointerCount,
    ...(unresolved === undefined ? {} : { unresolvedError: unresolved }),
    discarded: input.semantic.discarded,
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.currentGoal === undefined ? {} : { currentGoal: input.currentGoal }),
    ...(input.goalRevisions === undefined ? {} : { goalRevisions: input.goalRevisions }),
    // C1: the label and the arbitration must reach the reader, not stop at the extractor.
    ...(input.goalLayer === undefined ? {} : { goalLayer: input.goalLayer }),
    ...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
    notes,
  })
}
