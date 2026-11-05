/**
 * THE HOST-SHAPE LAYER — extracted verbatim from `index.ts` (v7.6, 841 lines).
 *
 * WHAT THIS FILE IS: the part of a slice that talks to the RUNTIME.
 *
 *   - the identity metadata that records provenance on a migrated session;
 *   - the four message constructors (`goalMessage`, `systemMessage`, `assistantMessage`, the title);
 *   - `materializeTape` + `assertLogOnly` / `assertMessageSurface`: seq/time assignment and the
 *     surface rules that decide what a log-only event may carry;
 *   - `buildInjectionEvents`: the whole event list, built in memory;
 *   - `assertColdLog`: the post-write validator that re-checks a persisted tape field by field;
 *   - `extractActiveGoalChange`: reads the source's newest goal record.
 *
 * WHAT IT IS NOT: the part that decides WHAT to write. `buildInjectionPlan` (goal, board, constraints,
 * carryover, codeblock pointerisation) stays in `index.ts`. What a handoff should SAY is graft's policy;
 * HOW the runtime wants it shaped is this file.
 *
 * WHY THE SPLIT FALLS HERE AND NOT FURTHER UP: the block above needs 59 outside symbols including live
 * state (`graftTargets`, `graftSliceAndInjectUnlocked`). Moving that would need a cycle or a small
 * injection framework — more coupling than it removes. This block needs 14, and after moving
 * `extractActiveGoalChange` in with it the remainder are TYPES and PURE CONSTANTS.
 *
 * BEHAVIOUR IS BYTE-IDENTICAL. Same bodies, same codes, same messages, same order of checks.
 *
 * DEPENDENCY DIRECTION: this module imports NOTHING from `index.ts` — not even types.
 *
 * THE BUILDER COUNTS `import type` AS A DEPENDENCY. `scripts/bundle.mjs` walks every relative specifier
 * to compute inline order, and it does not distinguish a type-only import from a value import (the type
 * syntax is stripped later, by Node, not by the walker). An earlier attempt to import types from
 * `index.ts` therefore produced `cycle in src/: index.ts -> core/host-shape.ts` and no build at all.
 *
 * So the handful of shapes this module needs are declared LOCALLY, structurally. They are the same
 * properties `index.ts` declares; a caller passing an `index.ts` object satisfies them, because TypeScript
 * is structural and the bundler strips types anyway. The duplication is four interfaces and one string
 * constant — cheaper than a cycle, which would be a temporal-dead-zone crash at load time.
 */

/** The `source.kind` this plugin stamps on a replayed turn. Same literal as `index.ts`'s copy. */
export const GRAFT_REPLAY_SOURCE_KIND = 'plugin:graft-replay'

/** The normalised plugin settings this module reads. Mirrors `Required<GraftConfig>`'s used fields. */
export interface GraftConfigShape {
  igniteTarget: boolean
  ignitionPrompt: string
  ignitionMode: 'queue' | 'steer'
  workspaceRedline: boolean
  constraintProvider: string
  constraintModel: string
  skeletonTurn: number
  skeletonStep: number
}

/** Where the replayed content came from. */
export interface GraftSourceShape {
  kind: string
  provider?: string
  model?: string
}

/** The slice plan: what the tape will say. */
export interface GraftPlanShape {
  cwd: string
  goal: any
  tape: any
  sourceTemplate: any
  [key: string]: any
}

/** A session header, as this module reads it. */
export interface SessionHeaderShape {
  id: string
  cwd?: string
  createdAt?: number
  isSeeded?: boolean
  [key: string]: any
}

/** A cold read of a persisted session. */
export interface SessionLogSnapshotShape {
  session?: SessionHeaderShape
  events?: any[]
  inheritedEventCount?: number
  [key: string]: any
}

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
  source: GraftSourceShape,
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

function sourceForReport(source: GraftSourceShape): GraftSourceShape {
  const copy: GraftSourceShape = { kind: source.kind }
  if (source.provider !== undefined) copy.provider = source.provider
  if (source.model !== undefined) copy.model = source.model
  return copy
}

/**
 * A handoff session is a new top-level session, never a subagent/fork child.
 * The real v4 header names the parent `parentSession`; older drafts used
 * `parentSessionId`, and `lineage` is checked defensively for compatibility.
 */
function assertTopLevelHeader(header: SessionHeaderShape): void {
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
function injectionSource(plan: GraftPlanShape, settings: GraftConfigShape): GraftSourceShape {
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
  plan: GraftPlanShape,
  settings: GraftConfigShape,
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
  cold: SessionLogSnapshotShape,
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
/* ── the system head and the workspace red line ─────────────────────────────────────────────── */

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
const GRAFT_CHAIN_GRACE_TURNS = 2
