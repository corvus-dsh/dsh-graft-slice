import { extractActiveGoalChange } from './host-shape.js'
import { isGraftAuthored } from './message-source.js'
import { nearDuplicate, normalizeText, normalizedEqual } from './text-normalize.js'
import { isRecord, truncateEnd } from '../utils/serialize.js'
import { textOfMessage } from './watermark.js'
import type { GraftTape } from './tape-shape.js'

interface GoalResult {
  goal: string
  source: GraftTape['goalSource']
  /**
   * C1: which layer answered. Absent on the legacy paths that predate the ruling, so an old caller (and
   * an old test fixture) still type-checks; every NEW path sets it.
   */
  goalLayer?: GoalLayer
  /** The seq a reader can jump to for the original words — a pointer, never the body. */
  sourceSeq?: number
  /**
   * ── C1 HARD RULE 2: THE ARBITRATION RESULT ──────────────────────────────────────────────────────
   *
   * When layer 1 (a declared objective) answers, the user may still have changed direction in the
   * window AFTER the goal was declared. Measured failure this encodes: objective = "把 S1b-2 的 9 个契约
   * 骨架写出来", then the user said "先别写骨架，先修 CI" — and the old code returned the objective with
   * NO trace of the correction, so the target kept doing what the user had just abandoned.
   *
   * \`supersededBy\` carries the newest substantive human message as a STRUCTURED second value (not a
   * string glued onto \`goal\`), so a renderer can show both and say which one wins. It is present
   * whenever an objective answered AND a newer human message exists — deliberately unconditional: the
   * ruling forbids deciding "are these the same task?" (a semantic judgement that cannot be made
   * reliably, and \`nearDuplicate\` compares token sets, which misjudges exactly this case).
   */
  supersededBy?: {
    /** The newest substantive human message, collapsed and truncated. */
    text: string
    /** Its seq, so a reader can go read the whole thing. */
    seq?: number
    /** True when the message came AFTER the goal declaration. */
    afterObjective: boolean
  }
}
type GoalLayer = 'objective' | 'dag-node' | 'transcript'
function objectiveOf(events: readonly SessionEventLike[]): { objective: string; seq?: number } | undefined {
  const change = extractActiveGoalChange(events)
  if (change === undefined) return undefined
  const goal = change.goal
  if (!isRecord(goal)) return undefined
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : ''
  if (objective.length === 0) return undefined
  let seq: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type !== 'goal/change') continue
    const candidate = Number(events[index].seq)
    if (Number.isSafeInteger(candidate)) seq = candidate
    break
  }
  return seq === undefined ? { objective } : { objective, seq }
}
function currentDagNode(graphText: string | undefined): string | undefined {
  if (typeof graphText !== 'string' || graphText.trim().length === 0) return undefined
  /**
   * ── THE ID MUST NOT CONSUME THE SEPARATOR (measured the hard way) ─────────────────────────────
   *
   * A lazy `([^\n]+?)` before the em dash split `n-s1b-2 — 契约化…` at its FIRST hyphen, yielding the
   * id `n` and the title `s1b-2 — 契约化…`. Node ids are hyphenated in practice, so the id is matched as
   * a token that stops at whitespace, and the separator must have whitespace around it.
   */
  const nodeLine = /^[ \t]*[-*]?[ \t]*\[Node\][ \t]*([^\s—]+)[ \t]+—[ \t]+([^\n]+)$/gmu
  for (const match of graphText.matchAll(nodeLine)) {
    const id = match[1].trim()
    const title = match[2].trim()
    if (/(?:done|completed|已完成)/iu.test(title)) continue
    // Boundaries only: the run collapses whitespace and truncates, so a long title cannot become a body.
    return `${id} — ${title}`.replace(/\s+/gu, ' ').slice(0, 160)
  }
  return undefined
}
function extractGoal(events: readonly SessionEventLike[], dagText?: string): GoalResult {
  /**
   * ── LAYERS 1 AND 2 ANSWER BEFORE THE TRANSCRIPT IS READ AT ALL ─────────────────────────────────
   *
   * This ordering is the fix, not a detail. With an objective present there is nothing to infer, so the
   * question "is this human message a requirement or a pasted report?" — the question C1 was blocked on
   * — simply does not arise. That is why this was held for a ruling instead of patched with a
   * report-shape regex: the regex would have been guessing at layer 3 while a declaration was available.
   */
  /**
   * ── DECLARED BEFORE LAYER 1, BECAUSE LAYER 1 NOW READS IT (rule 24, learned twice) ──────────────
   *
   * Rule 2 makes layer 1 consult the newest human message, so `humans` must exist before the objective
   * branch runs. It was declared further down, and the first build died with
   * `Cannot access 'humans' before initialization` — the same temporal-dead-zone failure this file's
   * architecture notes warn about (`splitByShape` had it too). Moving the declaration is the fix; the
   * ordering comment is here so the next edit does not re-break it.
   */
  /**
   * ── DECLARED ABOVE THEIR FIRST CONSUMER, ON PURPOSE ──────────────────────────────────────────
   *
   * C1 rule 2 makes layer 1 look at the newest human message, so it reaches `newestSubstantive` →
   * `substantive` → these two patterns. All of it used to sit BELOW the objective branch, and the
   * build died with `Cannot access 'substantive' before initialization` — the same temporal-dead-zone
   * failure as `humans` a moment earlier, and the same class as `splitByShape` before that.
   *
   * The order here is load-bearing: patterns → substantive → humans → objectiveOf → layer 1.
   */
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

  const humans = events.filter(
    (event) => event.type === 'user/message' && event.data?.source?.kind === 'user' && textOfMessage(event.data).length > 0,
  )

  const declared = objectiveOf(events)
  if (declared !== undefined) {
    /**
     * ── C1 HARD RULE 2: THE OBJECTIVE DOES NOT SILENTLY OVERRULE THE USER ────────────────────────
     *
     * A declared objective says what the session was SET to do. It does not say the user never changed
     * their mind afterwards, and the measured failure is exactly that: the objective won unconditionally,
     * the user's "先别写骨架，先修 CI" vanished, and the target kept building what the user had just
     * abandoned.
     *
     * THE RULING'S JUDGEMENT CALL, ENCODED: do NOT decide whether the two are "the same task". That is a
     * semantic comparison this code cannot make — and `nearDuplicate` is the wrong tool for it (it
     * compares TOKEN SETS, so "两个不同任务在同一子系统" scores as identical; that mistake was already
     * made once in C2).
     *
     * Instead: whenever an objective answered AND a newer substantive human message exists, carry that
     * message as a STRUCTURED second value with its seq, and let the renderer say "以最新为准". Constant
     * cost, no semantic guess, and the conflict is visible even when a human would call the two
     * consistent — a redundant line is cheaper than a silently abandoned instruction.
     */
    const newest = newestSubstantive()
    const objectiveSeq = declared.seq
    const afterObjective = newest !== undefined && (objectiveSeq === undefined || newest.seq === undefined || newest.seq > objectiveSeq)
    return {
      goal: truncateEnd(declared.objective, 4000).text,
      source: 'user',
      goalLayer: 'objective',
      ...(declared.seq === undefined ? {} : { sourceSeq: declared.seq }),
      ...(newest === undefined || !afterObjective
        ? {}
        : {
            supersededBy: {
              text: truncateEnd(newest.text, 400).text,
              ...(newest.seq === undefined ? {} : { seq: newest.seq }),
              afterObjective: true,
            },
          }),
    }
  }

  /**
   * Layer 2: the DAG's current node, when layer 1 is silent.
   *
   * ONE line, as a boundary — rule 1. The node says WHERE the work is, never WHAT it contains; the
   * carrier (`context/memory-graph` or the rendered `memory_graph_read` text) is the caller's business,
   * so this takes the rendered text and extracts the single node line.
   */
  const dagNode = currentDagNode(dagText)
  if (dagNode !== undefined) {
    return {
      goal: truncateEnd(dagNode, 4000).text,
      source: 'user',
      goalLayer: 'dag-node',
    }
  }

  /** The seq of the newest human message — the pointer layer 3 hands back instead of the body. */
  const newestHumanSeq = (): number | undefined => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      if (isGraftAuthored(event.data?.source)) continue
      const candidate = Number(event.seq)
      if (Number.isSafeInteger(candidate)) return candidate
    }
    return undefined
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

  /**
   * The NEWEST substantive human message, as a structured value.
   *
   * Same three gates as the anchor loop above — user-authored, not graft-authored, substantive — so
   * "the user changed direction" is judged by the SAME notion of substance that decides what counts as
   * a goal at all. A second, weaker predicate here would let a bare "请继续" masquerade as a new
   * instruction.
   */
  function newestSubstantive(): { text: string; seq?: number } | undefined {
    for (let index = humans.length - 1; index >= 0; index -= 1) {
      const event = humans[index]
      if (isGraftAuthored(event.data?.source)) continue
      const text = textOfMessage(event.data)
      if (!substantive(text)) continue
      const seq = Number(event.seq)
      return Number.isSafeInteger(seq) ? { text: normalizeText(text), seq } : { text: normalizeText(text) }
    }
    return undefined
  }

  if (anchors.length > 0) {
    const ordered = anchors.reverse()
    const joined = ordered.map((line) => truncateEnd(line, 1600).text).join('\n')
    /**
     * Layer 3: the transcript. It stays a FALLBACK, and it arrives with a pointer rather than as the
     * whole body — `sourceSeq` names where the words are, so a reader who needs them spends one tool
     * call instead of the injection spending its window on them.
     */
    const newestSeq = newestHumanSeq()
    return {
      goal: truncateEnd(joined, 4000).text,
      source: 'user',
      goalLayer: 'transcript',
      ...(newestSeq === undefined ? {} : { sourceSeq: newestSeq }),
    }
  }
  const human = humans[0]
  if (human) {
    return { goal: truncateEnd(normalizeText(textOfMessage(human.data)), 4000).text, source: 'user', goalLayer: 'transcript' }
  }
  const anyUser = events.find((event) => event.type === 'user/message' && textOfMessage(event.data).length > 0)
  if (anyUser) {
    return { goal: truncateEnd(normalizeText(textOfMessage(anyUser.data)), 4000).text, source: 'fallback-user', goalLayer: 'transcript' }
  }
  const assistant = events.find((event) => event.type === 'assistant/message' && textOfMessage(event.data?.message).length > 0)
  if (assistant) {
    return { goal: truncateEnd(normalizeText(textOfMessage(assistant.data?.message)), 4000).text, source: 'assistant', goalLayer: 'transcript' }
  }
  return { goal: 'Continue the migrated work.', source: 'placeholder', goalLayer: 'transcript' }
}
