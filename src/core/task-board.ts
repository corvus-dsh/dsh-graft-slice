import { truncateEnd } from '../utils/serialize.js'

// v1.3: `Truncation` and the two truncate* functions moved to src/utils/serialize.ts.

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
// v1.3: truncateEnd / truncateMiddle moved to src/utils/serialize.ts.

/**
 * Wrap a truncated body so the CUT is declared outside the payload.
 *
 * `<file_content truncated_lines="N" original_chars="M">` is inert to every parser
 * that does not know the element, and unambiguous to the ones that do. `countLines`
 * is overridable because different callers truncate by chars, turns, or records.
 */
export function wrapTruncated(text: string, original: number, originalLines?: number): string {
  const kept = text.split('\n').length
  const dropped = Math.max(0, (originalLines ?? original) - kept)
  const attr = originalLines === undefined ? `original_chars="${original}"` : `original_lines="${originalLines}"`
  return `<file_content truncated_lines="${dropped}" ${attr}>\n${text}\n</file_content>`
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
   * TD-11: WHERE the pending list came from.
   *
   * `'model'` means the model supplied it through `graft_prepare`'s `handover.pending` — a
   * deliberate statement made at handoff time. It is labelled in the heading because a reader
   * must be able to tell "the model just told me this" from "the plugin read it out of the log".
   * Absent means the transcript (the historical default) and gets no label.
   */
  pendingSource?: 'transcript' | 'model'
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
  /**
   * C1: which layer produced `request`. Rendered as a LABEL next to the requirement, because the three
   * layers are not equally trustworthy: objective/dag-node are DECLARED, transcript is GUESSED.
   *
   * Optional so every existing caller (and test fixture) keeps compiling; absent means "unknown
   * provenance", which the renderer states rather than silently omits.
   */
  goalLayer?: 'objective' | 'dag-node' | 'transcript'
  /**
   * C1 hard rule 2: the newest substantive human message that arrived AFTER the objective, when one
   * exists. Rendered as its own section so a changed direction cannot disappear behind a declaration.
   */
  supersededBy?: { text: string; seq?: number; afterObjective: boolean }
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

export const BOARD_COLUMNS = {
  request: '原始用户要求',
  done: '✅ 已完成',
  doing: '🔄 进行中',
  todo: '⏭️ 待开始',
} as const

/**
 * ── C3: A DISPLAY TRUNCATION MUST BE VISIBLE ────────────────────────────────────────────────────
 *
 * `truncateEnd` deliberately emits no marker: its own comment explains that a `...[已省略 N 行]` line
 * inside a JSON payload makes a downstream parse fail, and that reason is correct FOR PAYLOADS.
 *
 * A board is the opposite kind of surface — a human (and a model) reads it as prose, and a bare cut
 * reads as a complete sentence that happens to end mid-word. Measured: a 1,164-character request was
 * cut to 311 and ended at "## 一、EMP" with nothing to say so.
 *
 * So the structured fields are used the way they were designed to be used: `truncated` and
 * `originalLength` decide whether to append a marker, and the marker names the way back to the
 * original (the seq lookup this session already documents).
 */
export function truncateForDisplay(text: string, limit: number): string {
  const cut = truncateEnd(text, limit)
  if (cut.truncated === false) return cut.text
  return `${cut.text}…（已截断，原文 ${cut.originalLength} 字符，用 seq 回读原文）`
}

/**
 * True when two texts are THE SAME TEXT cut differently — not two facts that agree.
 *
 * ── WHY THIS IS NOT `nearDuplicate` (index.ts:1371) ─────────────────────────────────────────────
 *
 * That one compares TOKEN SETS and fires at 90% overlap, which is right for constraint sentences ("is
 * this the same rule stated twice?") and wrong here: two different paragraphs about the same subsystem
 * share most of their vocabulary and would be suppressed as duplicates, hiding real content.
 *
 * The board's duplicate had a specific shape — the SAME source text rendered into two columns — so the
 * test is a shared PREFIX, which that shape produces and independent prose does not.
 */
export function sameTextHead(a: string, b: string): boolean {
  const left = a.replace(/\s+/gu, ' ').trim()
  const right = b.replace(/\s+/gu, ' ').trim()
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true
  const shorter = Math.min(left.length, right.length)
  if (shorter < 30) return false
  let shared = 0
  while (shared < shorter && left[shared] === right[shared]) shared += 1
  return shared >= Math.min(60, shorter)
}

export function renderTaskBoard(input: TaskBoardInput): string {
  const lines: string[] = [`## 交接任务看板（第一轮只要读这里）`]
  const request = input.request.replace(/\s+/gu, ' ').trim()
  /**
   * ── C1: THE LABEL SAYS HOW MUCH TO TRUST THIS LINE ────────────────────────────────────────────
   *
   * A reader cannot tell a declared objective from a transcript guess without being told, and the two
   * deserve different trust. `unknown` is stated explicitly rather than omitted: a missing label reads
   * as "no distinction", which is the ambiguity this change exists to remove.
   *
   * POSITION MATTERS: the label goes at the END of the line. Three shipped board tests match
   * `**原始用户要求**：<text>` literally, so inserting the label before or right after the colon broke them.
   * A new fact must be added WITHOUT moving the shape other code depends on — that is the whole lesson.
   */
  const layerLabel =
    input.goalLayer === 'objective'
      ? ' （objective）'
      : input.goalLayer === 'dag-node'
        ? ' （dag-node）'
        : input.goalLayer === 'transcript'
          ? ' （transcript，未声明目标）'
          : ' （来源未知）'
  lines.push(
    `**${BOARD_COLUMNS.request}**：${request.length === 0 ? '（未提取到明确要求，见 goal 消息）' : truncateForDisplay(request, 300)}${layerLabel}`,
  )

  /**
   * ── C1 HARD RULE 2, RENDERED ──────────────────────────────────────────────────────────────────
   *
   * The objective is a DECLARATION, not a veto. When a newer substantive human message exists, it is
   * shown here with its seq and an explicit arbitration line — "以最新为准" — so a target that reads
   * only this block still learns the user moved. No semantic comparison is attempted: the ruling
   * forbids it (a token-set test would misjudge two tasks in one subsystem, which is the C2 mistake).
   */
  if (input.supersededBy !== undefined && input.supersededBy.afterObjective) {
    const newer = input.supersededBy.text.replace(/\s+/gu, ' ').trim()
    const seqText = input.supersededBy.seq === undefined ? '' : `（seq=${input.supersededBy.seq}）`
    lines.push(
      '',
      `⚠️ 本会话后来改了口径${seqText}：${truncateForDisplay(newer, 300)}`,
      '    判定：以最新的用户要求为准；objective 未变，完成本轮后需更新。',
    )
  }

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
    lines.push('', `**当前目标**：${truncateForDisplay(currentGoal, 300)}`)
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
  } else if (sameTextHead(doing, request) || (currentGoal.length > 0 && sameTextHead(doing, currentGoal))) {
    /**
     * ── C2: SAY THAT IT IS THE SAME THING, INSTEAD OF PRINTING IT TWICE ──────────────────────────
     *
     * The duplicate is not harmless. Two identical paragraphs read as two agreeing facts, so whatever
     * they say arrives with double weight — and the reader spends attention confirming that the
     * second one really does say the same thing. Naming it as a pointer costs one line and removes
     * the false confirmation.
     */
    lines.push(
      '- （与上面的「原始用户要求」/「当前目标」同一段文本，不重复渲染；断点落在该轮次中，未闭合。）',
    )
  } else {
    lines.push(`- ${truncateForDisplay(doing, 300)}`)
  }

  // ⏭️ 待开始 — the next action FIRST, rest after. This is the column the ignition
  // prompt points at, so its first item has to be the real next step.
  // TD-11: say WHERE the list came from. A model-supplied list is a deliberate statement made at
  // handoff time; unlabelled, it would read as tool-derived and silently outrank the log.
  const pendingHeading =
    input.pendingSource === 'model' ? `**${BOARD_COLUMNS.todo}**（模型提供）` : `**${BOARD_COLUMNS.todo}**`
  lines.push('', pendingHeading)
  const pending = input.pending.map((item) => item.replace(/\s+/gu, ' ').trim()).filter((item) => item.length > 0)
  if (pending.length === 0) {
    // v0.32 P1: "the written list is finished" is NOT "there is no plan".
    lines.push(
      input.hasWrittenPlan === true
        ? '- 待办清单已全部完成；按上面的「原始用户要求」做最后验证与收尾。'
        : '- 按上面的「原始用户要求」继续推进，并验证结果。',
    )
  } else {
    for (const item of pending.slice(0, 4)) lines.push(`- ${truncateForDisplay(item, 200)}`)
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
  /**
   * ── C4: TWO DIFFERENT COUNTS, TWO DIFFERENT NAMES ────────────────────────────────────────────────
   *
   * `pointerCount` is how many pointers were WRITTEN into the tape. The index's own total (see the
   * "共 N 处可回读" line elsewhere in this file) is `pointerCount + Σ userTexts` — it counts the
   * user messages too, because those are also readable by seq. Both numbers are correct; printing
   * one of them under the name of the other is what made "811 vs 1347" look like an arithmetic bug.
   */
  if (input.pointerCount > 0) stop.push(`本索引列出可回读指针 ${input.pointerCount} 处（另有用户原话可按 seq 回读，故「共 N 处」会更大）`)
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
