/**
 * ── TASK POSITION: WHERE THE PLAN SAYS THIS SESSION IS ────────────────────────────────────────────
 *
 * A slice replays what the source session DID. Three existing chunks already answer "what happened":
 * `phase-roadmap` infers a phase from the LOG, `task-status` replays the last `todo_write`, and the
 * pending state carries the unfinished instruction. None of them can answer "which node of the
 * approved plan am I standing in", because that fact does not live in a session log at all — it lives
 * in the task graph, which is the only artefact that spans generations.
 *
 * ── WHY THIS MODULE IS PURE, AND WHY THAT IS NOT A STYLE CHOICE ──────────────────────────────────
 *
 * `dsh-graft-slice` must never import `dsh-memory`: either plugin has to survive being uninstalled
 * alone, so the four repositories hold zero static imports between them. That rules out sharing a
 * `TaskGraph` type, and it has a consequence worth stating: the argument here is `unknown`, because the
 * file this reads was written by ANOTHER PROCESS with a shape this module cannot verify at compile
 * time. Every field is checked at runtime, and anything unrecognisable returns `undefined` — degrade to
 * "there is no graph", never throw. A slice is the main function; the position is an enhancement, and an
 * enhancement may not fail the thing it decorates.
 *
 * ── THE ONE THING THIS MODULE REFUSES TO DO ─────────────────────────────────────────────────────
 *
 * Invent a current node. An `active` node, or a `pending` node whose dependencies are all done, is a
 * fact the graph states. When neither exists — a plan that is entirely done, or one whose every
 * remaining node is blocked — the honest output is NO CHUNK. A heading reading 「当前节点：（无）」 looks
 * like information and is actually the absence of it, and a reader who has just been handed a plan will
 * believe it.
 */

/** The plan's current position, as plain data. `generation`/`originSessionId` come from graft. */
export interface TaskPositionInput {
  /**
   * ── THE PLAN DOES NOT EXIST YET (v0.39, B2-T4) ──────────────────────────────────────────────
   *
   * Set when the memory plugin IS present (its store directory exists) but no `task-graph.json` has
   * ever been written. That is not "no position" — it is a fact about the plan, and an actionable
   * one: the model can build a graph right now. Rendering the six sections here would be a lie
   * (there is no goal, no node, no edge), so this variant carries its own one-sentence body.
   *
   * It is a FLAG on the existing kind rather than a new chunk kind on purpose: a new kind must be
   * registered in four places (the `kind` union, the push site, the `priority` table, the `injected`
   * count), and a missed registration is ㉛'s "the second door did not inherit the first door's
   * guard". A body variant touches no registry.
   */
  notEstablished?: true
  goal: string
  goalLocked: boolean
  current?: {
    id: string
    title: string
    status: string
    requirements: string[]
    progress?: number
  }
  done: string[]
  pending: string[]
  blockedBy: string[]
  unlocks: string[]
  totalNodes: number
  /**
   * 第 N 代. Filled by GRAFT from its own ledger, never by the graph: `dsh-memory`'s `TaskGraph` has no
   * `generation` field and no `originSessionId` (measured: zero occurrences in `src/graph.ts`). A value
   * derived from a session id's prefix would be a guess wearing the shape of a fact.
   */
  generation?: number
  /** The session the goal chain started from — graft's ledger, same rule as `generation`. */
  originSessionId?: string
  /** Set when more than one node claims `active`; the reader must be told rather than silently picking. */
  multipleActive?: string[]
  /**
   * ── TD-M17 ②③: WHEN DID THIS NODE LAST MOVE? ──────────────────────────────────────────────────
   *
   * A graph that exists but is stale is MORE dangerous than a missing one: `task-position` renders it
   * as fact, and a fresh reader (the next generation) acts on it. So the block must be able to say
   * 「自 X 起未更新」 — and it must say it from data the CALLER supplied, never from a clock read
   * inside this module. That is the same rule `monitor.ts` follows (zero clock so it can be unit
   * tested), and here it is also what keeps the render a pure function of its input.
   *
   * `now` is injected by `readTaskPosition`. `updatedAt` comes from the graph node — this module
   * never invents it. Either one absent ⇒ NO claim (unknown is not stale).
   */
  freshness?: {
    /** The current node's `updatedAt`, as written by dsh-memory. */
    updatedAt?: string
    /** The caller's clock, as an ISO instant. Absent ⇒ no staleness judgement at all. */
    now?: string
    /** Override the threshold (tests, and a future config). Default `STALE_AFTER_DAYS`. */
    staleAfterDays?: number
  }
}

/** The statuses a node may carry. Anything else is treated as unrecognised and skipped. */
const STATUSES = new Set(['pending', 'active', 'done', 'abandoned'])
/** Nodes that exist for structural reasons and never describe work. */
const STRUCTURAL = new Set(['start', 'goal'])
/** Every list is capped: an id list is a signpost, not an inventory. */
const MAX_NODE_LIST = 8
/** The whole block is capped. Six sections at ~200 characters each. */
export const TASK_POSITION_MAX_CHARS = 1200
/** Requirements shown for the current node, most useful first. */
const MAX_REQUIREMENTS = 3
/**
 * TD-M17 ②③: how long a node may sit unchanged before the block SAYS SO.
 *
 * 14 days, and it is a number this file does not pretend to derive: the real graph's nodes are
 * updated per work session, so two weeks of silence is "nobody has touched this plan", not "a slow
 * week". It is a display threshold, not a gate — nothing is hidden or refused because of it.
 */
export const STALE_AFTER_DAYS = 14

/**
 * ── "THE PLAN WAS NEVER STARTED" ─────────────────────────────────────────────────────────────────
 *
 * The factory for the `notEstablished` variant, so the shape and the sentence it renders live in the
 * same module as every other position body. A caller that builds this object by hand would be a
 * second definition of what "no graph" looks like, and the first time the two drifted the chunk would
 * say one thing at review and another at write time.
 */
export function notEstablishedPosition(): TaskPositionInput {
  return {
    notEstablished: true,
    goal: '',
    goalLocked: false,
    done: [],
    pending: [],
    blockedBy: [],
    unlocks: [],
    totalNodes: 0,
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()) : []

/**
 * `unknown` graph in, position out. `undefined` means "nothing honest to say" — a malformed document, a
 * document that is not a graph at all, or a plan with no current node.
 */
export function toTaskPosition(
  graph: unknown,
  /**
   * TD-M17 ②③: `now` is INJECTED so this function stays pure. Omitting it is legal and means "do not
   * judge freshness" — an offline reader or a test that only cares about the position gets the same
   * six sections, with no staleness line invented from a clock this module read itself.
   */
  options: { now?: string; staleAfterDays?: number } = {},
): TaskPositionInput | undefined {
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) return undefined
  const record = graph as Record<string, unknown>
  const rawNodes = record.nodes
  if (!Array.isArray(rawNodes)) return undefined

  /**
   * Keep only nodes this module can describe. A hand-edited file must not make the block unreadable,
   * and `start` is structural: it is done by definition, and listing it as "completed work" would put
   * the word 「开始」 at the top of a list of real completed phases.
   */
  const nodes = rawNodes
    .filter((node): node is Record<string, unknown> => node !== null && typeof node === 'object' && !Array.isArray(node))
    .map((node) => ({
      id: text(node.id),
      title: text(node.title),
      status: text(node.status),
      dependsOn: stringList(node.dependsOn),
      requirements: stringList(node.requirements),
      progress: typeof node.progress === 'number' && Number.isFinite(node.progress) ? node.progress : undefined,
      /** TD-M17: the node's own last-update stamp; absence is unknown, not "just now". */
      updatedAt: text(node.updatedAt),
    }))
    .filter((node) => node.id.length > 0 && STATUSES.has(node.status))

  if (nodes.length === 0) return undefined

  const doneIds = new Set(nodes.filter((node) => node.status === 'done').map((node) => node.id))
  const work = nodes.filter((node) => !STRUCTURAL.has(node.id))

  const current = pickCurrent(work, doneIds)
  /**
   * ③ of the spec: no current node ⇒ NO CHUNK. This is the refusal described at the top of the file —
   * a completed plan and a fully blocked one both land here, and both are honest silences.
   */
  if (current === undefined) return undefined

  /**
   * Blockers are the same edge set the runnability test used — otherwise the block would say
   * 「我被谁阻塞：goal」 for a goal that never completes, which is true of every node in every plan and
   * therefore tells the reader nothing.
   */
  const blockedBy = runnableEdges(current.node.dependsOn, work).filter((parent) => !doneIds.has(parent))
  /** Reverse edges are computed, never stored: the graph records `dependsOn` only. */
  const unlocks = work
    .filter((node) => node.status === 'pending' && node.dependsOn.includes(current.node.id))
    .map((node) => node.id)
    .sort()

  return {
    goal: text(record.goal),
    goalLocked: text(record.goalLockedAt).length > 0,
    current: {
      id: current.node.id,
      title: current.node.title,
      status: current.node.status,
      requirements: current.node.requirements,
      ...(current.node.progress === undefined ? {} : { progress: current.node.progress }),
    },
    done: work.filter((node) => node.status === 'done').map((node) => node.id),
    pending: work.filter((node) => node.status === 'pending').map((node) => node.id),
    blockedBy,
    unlocks,
    totalNodes: work.length,
    /**
     * TD-M17 ②③: the freshness input, filled ONLY with what was actually read. `now` comes from the
     * caller; when it is absent the renderer makes no judgement (see `renderTaskPosition`).
     */
    ...(current.node.updatedAt.length === 0 && options.now === undefined
      ? {}
      : {
          freshness: {
            ...(current.node.updatedAt.length === 0 ? {} : { updatedAt: current.node.updatedAt }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.staleAfterDays === undefined ? {} : { staleAfterDays: options.staleAfterDays }),
          },
        }),
    ...(current.multipleActive === undefined ? {} : { multipleActive: current.multipleActive }),
  }
}

/**
 * ── WHICH NODE IS "CURRENT" (the spec's three cases, in order) ──────────────────────────────────
 *
 * ① an `active` node. More than one is a graph that contradicts itself; take the runnable one with the
 *   smallest id and report the rest, because silently picking one would hide the contradiction.
 * ② otherwise a `pending` node whose dependencies are ALL done — the next legal step.
 * ③ otherwise nothing.
 *
 * ── `goal` IS NOT A PRECONDITION, AND TREATING IT AS ONE SILENTLY BLOCKS EVERY PLAN ────────────
 *
 * Measured against `dsh-memory/src/graph.ts`: `lock-goal` creates the goal node with `status:
 * 'pending'`, and nothing ever completes it — the goal is the DESTINATION, not a step. So a node that
 * declares `dependsOn: ['goal']` (which is the normal way to hang the first phase off the objective)
 * can never have "all dependencies done", and the whole plan renders as "no current node".
 *
 * The first version of this function compared against every dependency and returned `undefined` for
 * exactly that shape. The block disappeared for the most ordinary graph there is: one goal plus a
 * chain of phases. A silence that looks like "the plan is finished".
 *
 * So the runnability test keeps ONLY edges to real work. `start` is excluded for the mirror reason —
 * it is done from the beginning and constrains nothing.
 */
function runnableEdges(
  dependsOn: readonly string[],
  work: ReadonlyArray<{ id: string; status: string }>,
): string[] {
  const workIds = new Set(work.map((node) => node.id))
  return dependsOn.filter((parent) => workIds.has(parent))
}

function pickCurrent(
  work: ReadonlyArray<{ id: string; title: string; status: string; dependsOn: string[]; requirements: string[]; progress?: number; updatedAt: string }>,
  doneIds: ReadonlySet<string>,
): { node: (typeof work)[number]; multipleActive?: string[] } | undefined {
  const byId = [...work].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const isRunnable = (node: (typeof work)[number]): boolean =>
    runnableEdges(node.dependsOn, work).every((parent) => doneIds.has(parent))
  const active = byId.filter((node) => node.status === 'active')
  if (active.length > 0) {
    const runnable = active.filter(isRunnable)
    const chosen = runnable[0] ?? active[0]
    if (chosen === undefined) return undefined
    return active.length > 1 ? { node: chosen, multipleActive: active.map((node) => node.id) } : { node: chosen }
  }
  const next = byId.find((node) => node.status === 'pending' && isRunnable(node))
  return next === undefined ? undefined : { node: next }
}

/**
 * ── INPUT IN, TEXT OUT ──────────────────────────────────────────────────────────────────────────
 *
 * Six sections in a FIXED order, because the order is the argument: the goal orients, the current node
 * locates, and the edges explain why the next step is not available yet. A reader who stops after two
 * lines still knows what they are doing.
 *
 * Nothing here is padded. A missing `progress` prints no line at all rather than `0%` — zero is a
 * measurement, and "we have not measured this" is not zero.
 */
export function renderTaskPosition(input: TaskPositionInput): string | undefined {
  /**
   * The `notEstablished` variant first: it is the ONE case where there is something to say without a
   * position, and the six sections below would have nothing true to put in any of them.
   *
   * The body is ONE cell, not a paragraph: this appears in the review the user reads before every
   * slice of a graph-less profile, and 「每次切片都提醒一遍」 is how a warning becomes noise. It names
   * the tool and the op so the reader can act without going to look anything up.
   */
  if (input.notEstablished === true) {
    return [
      '[TASK POSITION]',
      '任务图：尚未建立',
      '多步任务建议先调用 memory_graph_update 建图（op:bootstrap 可从零建整张计划），',
      '之后每完成一个节点更新状态；跨切片的「我在哪」与 observer 的进度判断都依赖它。',
    ].join('\n')
  }
  const current = input.current
  if (current === undefined) return undefined
  const lines: string[] = ['[TASK POSITION]']

  /** 1. The goal, and whether it is still allowed to move. */
  if (input.goal.length > 0) {
    lines.push(`全局目标：${input.goal}${input.goalLocked ? '（已锁定）' : ''}`)
  }

  /** 2. The current node: title, requirements, progress — the three things a reader acts on. */
  lines.push(`当前节点：${current.id}（${current.status}）${current.title}`)
  const requirements = current.requirements.slice(0, MAX_REQUIREMENTS)
  if (requirements.length > 0) {
    lines.push(`  要求：${requirements.join('；')}${current.requirements.length > MAX_REQUIREMENTS ? `（共 ${current.requirements.length} 条）` : ''}`)
  }
  if (current.progress !== undefined) lines.push(`  进度：${current.progress}%`)

  /**
   * ── TD-M17 ②③: 「自 … 起未更新」 ──────────────────────────────────────────────────────────────
   *
   * The whole point of this line is that a stale graph is read as CURRENT: the next generation gets
   * 「当前节点：b2-t3（pending）」 and redoes finished work. Saying the date is what turns a claim into
   * dated evidence, and it costs one line inside the existing cap (the cap itself is untouched).
   *
   * The judgement lives in `staleDays` below and is a pure function of two instants. Anything it
   * cannot parse, or a NEGATIVE age (clock skew between two machines), yields NO line: an unknown
   * age must not become "recent", and it must not become "stale" either.
   */
  const age = staleDays(input.freshness)
  if (age !== undefined) {
    const since = input.freshness?.updatedAt?.slice(0, 10) ?? ''
    lines.push(`  自 ${since} 起未更新（已 ${age} 天）`)
  }

  /** 3/4. The two halves of the plan, capped: a signpost, not an inventory. */
  const idList = (ids: readonly string[]): string =>
    ids.length <= MAX_NODE_LIST ? ids.join(', ') : `${ids.slice(0, MAX_NODE_LIST).join(', ')}…共 ${ids.length} 个`
  if (input.done.length > 0) lines.push(`已完成：${idList(input.done)}`)
  if (input.pending.length > 0) lines.push(`未开始：${idList(input.pending)}`)

  /** 5. The edges. Both directions are named, because "why can't I start" and "who am I holding up" are different questions. */
  if (input.blockedBy.length > 0) lines.push(`我被谁阻塞：${idList(input.blockedBy)}`)
  if (input.unlocks.length > 0) lines.push(`我解锁谁：${idList(input.unlocks)}`)

  /** 6. Generation, from graft's ledger only — see the interface comment. Omitted entirely when unknown. */
  if (input.generation !== undefined && input.generation > 0) {
    const origin = input.originSessionId === undefined || input.originSessionId.length === 0
      ? ''
      : `；目标链自 ${input.originSessionId} 起`
    lines.push(`本代：第 ${input.generation} 代${origin}`)
  }

  /** A graph that names two current nodes is telling the reader something; say it rather than hide it. */
  if (input.multipleActive !== undefined && input.multipleActive.length > 1) {
    lines.push(`⚠ 多个节点同时 active（${input.multipleActive.join(', ')}）—— 图与预期不符，请用 memory_graph_update 修正`)
  }

  return capText(lines.join('\n'))
}

/**
 * ── TD-M17 ②③: HOW STALE IS THIS NODE? (pure, two instants in, one number or `undefined` out) ───
 *
 * `undefined` covers three different cases on purpose, because the renderer's behaviour is the same
 * for all of them and none of them is a measurement:
 *   · either stamp missing or unparseable — the age is UNKNOWN;
 *   · `neg` — `now` is before `updatedAt`, i.e. two clocks disagreed. Reporting "0 天" there would be
 *     a filter for a value this function cannot defend;
 *   · the age is within the threshold — the node is CURRENT, and saying "已 3 天" on every block
 *     would train the reader to skip the line that matters.
 */
export function staleDays(freshness: TaskPositionInput['freshness'] | undefined): number | undefined {
  if (freshness === undefined) return undefined
  const updated = Date.parse(freshness.updatedAt ?? '')
  const now = Date.parse(freshness.now ?? '')
  if (!Number.isFinite(updated) || !Number.isFinite(now)) return undefined
  const days = Math.floor((now - updated) / 86_400_000)
  if (!Number.isFinite(days) || days < 0) return undefined
  const threshold = freshness.staleAfterDays ?? STALE_AFTER_DAYS
  return days > threshold ? days : undefined
}

/**
 * ── THE CAP, AND WHAT GIVES WAY FIRST ──────────────────────────────────────────────────────────
 *
 * Trimming the middle of a prose block is the usual answer; it is the wrong one here, because every
 * line of this block is a different kind of statement.
 *
 * ── W1-6: THE OLD ORDER SACRIFICED THE MOST ACTIONABLE LINES FIRST ─────────────────────────────
 *
 * The old implementation kept `lines.slice(0, 4)` and dropped from the BOTTOM. The bottom is exactly
 * where 「未开始」/「我被谁阻塞」/「我解锁谁」 live — the three lines a next generation needs in order to
 * know what to do — while 「已完成」 sits ABOVE them and survived. So the one case where the cap fires
 * left the reader with the history and no instructions.
 *
 * The order below is by ACTIONABILITY, most expendable first:
 *
 *   1. 已完成          — history; useful, but the next generation does not act on it
 *   2. 本代 / 目标链     — provenance; needed for audit, not for the next step
 *   3. 要求（多条）      — the node's requirements, trimmed one at a time
 *   4. 新鲜度「自 … 起」   — a warning about staleness, which the truncation line already implies
 *   5. 进度            — a number the current node line already carries in spirit
 *   NEVER: 当前节点 / 未开始 / 我被谁阻塞 / 我解锁谁 / 全局目标
 *
 * The cap is a BODY cap: the declaration line is charged separately (`TRUNCATION_NOTE_RESERVE`), so
 * `TASK_POSITION_MAX_CHARS` really bounds the position text and the note cannot push it over. The old
 * implementation appended the note to an already-full body and every assertion still passed, because
 * nothing measured the total.
 */
const TRUNCATION_NOTE_RESERVE = 80

/** Which line is which kind, by its prefix — the renderer's own vocabulary, reused rather than re-invented. */
type SacrificeKind = 'done' | 'generation' | 'requirements' | 'freshness' | 'progress' | 'never'

function sacrificeKindOf(line: string): SacrificeKind {
  if (line.startsWith('已完成：')) return 'done'
  if (line.startsWith('本代：')) return 'generation'
  if (line.startsWith('  要求：')) return 'requirements'
  if (line.startsWith('  自 ') && line.includes('起未更新')) return 'freshness'
  if (line.startsWith('  进度：')) return 'progress'
  return 'never'
}

/**
 * The order lines are given up in. A line whose kind is not listed is `never` and is never dropped;
 * if the block STILL does not fit with only `never` lines, the last resort below truncates text.
 */
const SACRIFICE_ORDER: readonly SacrificeKind[] = ['done', 'generation', 'requirements', 'freshness', 'progress']

function capText(body: string): string {
  if (body.length <= TASK_POSITION_MAX_CHARS) return body
  const lines = body.split('\n')
  /**
   * Give up whole lines in sacrifice order. `requirements` may be given up MULTIPLE times — it is a
   * comma-joined list, so shortening it is a real intermediate step rather than an all-or-nothing one.
   * Every other kind is a single line.
   */
  const dropped = new Set<number>()
  let out = lines.join('\n')
  const dropFirstOfKind = (kind: SacrificeKind): boolean => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (dropped.has(index)) continue
      const line = lines[index] as string
      if (sacrificeKindOf(line) !== kind) continue
      if (kind === 'requirements') {
        const parts = line.replace(/^  要求：/u, '').split('；')
        if (parts.length > 1) {
          lines[index] = `  要求：${parts.slice(0, -1).join('；')}…（已截断）`
          out = lines.filter((_, at) => !dropped.has(at)).join('\n')
          return true
        }
      }
      dropped.add(index)
      out = lines.filter((_, at) => !dropped.has(at)).join('\n')
      return true
    }
    return false
  }
  for (const kind of SACRIFICE_ORDER) {
    let guard = 0
    while (out.length > TASK_POSITION_MAX_CHARS && guard < 200) {
      guard += 1
      if (!dropFirstOfKind(kind)) break
    }
  }
  const note = `（本块已按 ${TASK_POSITION_MAX_CHARS} 字符上限截断，完整图请用 memory_graph_read 读取）`
  if (out.length <= TASK_POSITION_MAX_CHARS) {
    /**
     * The note is charged against the SAME number the caller believes bounds the block, so what is
     * returned is `body + '\n' + note` where the body already left room for the note.
     */
    const head = out.slice(0, Math.max(0, TASK_POSITION_MAX_CHARS - TRUNCATION_NOTE_RESERVE - 1))
    return `${head}\n${note}`
  }
  /**
   * Only `never` lines remain and they still overflow: a single pathological line (a 900-character
   * node title). Cut IT, and say so — silence here would be the "truncated but looks complete" failure
   * the whole block exists to avoid.
   */
  const budget = Math.max(40, TASK_POSITION_MAX_CHARS - TRUNCATION_NOTE_RESERVE - 1)
  return `${out.slice(0, budget)}…（已截断）`
}
