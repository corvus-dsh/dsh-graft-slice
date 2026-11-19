/**
 * ── PENDING TRANSFERS: results that arrive A F T E R the session that started them is gone ────────
 *
 * THE HOLE THIS CLOSES. A slice copies the conversation; it cannot copy a running process. When the
 * source session is retired, its background jobs and subagents keep running and their results go to a
 * session nobody is reading. Before this module the tape said so plainly — 「它们不会被迁移，结果也
 * 不会自动回到这里」 — which was honest and useless: the work had been paid for and the result was
 * thrown away.
 *
 * So the tape now promises the opposite, and this module is what makes that promise keepable:
 *
 *   AT SLICE TIME      the target id, the watched ids and the watermark are written to a ledger
 *   WHEN SETTLED       the source log's own `job/settled` / `subagent-settled` events are the evidence
 *   AT TARGET PRE-STEP one injected message names what came back, then the entry is marked delivered
 *
 * ── WHY THE EVIDENCE IS THE LOG, NOT THE PROCESS TABLE ─────────────────────────────────────────
 *
 * The source is RETIRED: the plugin must not depend on "is that job still alive", because (a) it is a
 * different process, (b) the source may be on another host, and (c) the plugin would then need a jobs
 * service it deliberately does not inject. `job/settled` is already in the durable record, paired with
 * `job/registered` by id, so a cold read answers the same question a live handle would.
 *
 * ── WHY THE LEDGER IS A TODO, NOT A LOG ────────────────────────────────────────────────────────
 *
 * Each entry carries `deliveredAt`. An undelivered entry is retried on the next pre-step; a delivered
 * one never speaks again. Without that, every subsequent activity would re-announce the same result —
 * the "warning becomes noise" failure this repository has paid for more than once.
 *
 * This module is PURE: events in, facts out. The IO lives in `index.ts`, next to the other stores.
 */

/** One watched background item, as the ledger records it. */
export interface WatchedItem {
  /** `job` for a background job, `subagent` for a spawned agent. */
  kind: 'job' | 'subagent'
  id: string
  /** Human label at slice time, so the relayed message can name it rather than cite an opaque id. */
  label: string
}

/** One ledger row: what to watch, and whether the result has been relayed already. */
export interface PendingTransfer {
  targetSessionId: string
  sourceSessionId: string
  watchJobIds: string[]
  watchSubagentIds: string[]
  /** The boundary seq at slice time: anything settled at or before this was already in the tape. */
  sinceSeq: number
  createdAt: number
  /** Set when the relay was delivered; an entry without it is still owed. */
  deliveredAt?: number
  /**
   * ── v0.43 (B4-0b-1 A5): WHICH RESULTS HAVE BEEN RELAYED, NOT WHETHER THE ROW SPOKE ─────────────
   *
   * `deliveredAt` stamped the whole ROW. A row watching job-1 AND job-2 that relayed job-1 was
   * therefore marked "done", and job-2's result — arriving minutes later — was never delivered: the
   * tape had promised "these results will not be announced twice", and the second one was never
   * announced once. The audit's B-2.
   *
   * The set carries `deliveryKey` strings (`kind:id:settledSeq`), so:
   *   · each watched result is delivered exactly once;
   *   · a re-run of the same job at a NEW seq is news and IS delivered (the key contains the seq);
   *   · a repeated event at the SAME seq stays silent (the key is already in the set).
   *
   * `deliveredAt` is kept as the legacy marker ("this row has spoken at least once"): rows written by
   * older builds have only it, and reading them must not re-announce what they already said.
   */
  deliveredKeys?: string[]
  /**
   * ── v0.43 (A5): "THIS ROW HAS BEEN SCANNED AS FAR AS A FROZEN LOG CAN GO" ─────────────────────
   *
   * After a source is RETIRED its log cannot grow, so a scan that found nothing new is final. Without
   * this marker every settled row would be cold-read on every pre-step forever — the cost B-12 already
   * complains about, made worse by A5 no longer being able to use `deliveredAt` as a terminal state
   * (that is exactly the stamp that was wrong).
   *
   * Set only when the source is KNOWN retired. A live source can grow, and a re-run at a new seq is
   * news (②), so a live row is never marked exhausted.
   */
  exhaustedAt?: number
}

/** A settled item that the target has not been told about yet. */
export interface SettledResult {
  kind: 'job' | 'subagent'
  id: string
  label: string
  /** The seq of the settling event — part of the idempotency key. */
  settledSeq: number
  /** A short, human-readable conclusion when the event carried one. */
  summary?: string
}

/**
 * ── WHAT SETTLED SINCE THE SLICE ───────────────────────────────────────────────────────────────
 *
 * Only watched ids count, only events AFTER `sinceSeq` count, and only the FIRST settle of an id is
 * reported. Each of those is a separate guard with a separate failure behind it:
 *
 *   · without the id filter, the target is told about jobs it never had anything to do with;
 *   · without the `sinceSeq` filter, a job that settled BEFORE the slice is re-announced — its result
 *     is already in the tape, so the message is a duplicate dressed as news;
 *   · without first-settle-only, a retried settle (the host can repeat the event) says the same thing
 *     twice.
 *
 * `summary` is taken from whatever the settle event carries (`result`/`summary`/`output`). A settle
 * with no text still counts: "it finished, here is where to read it" is the actionable part, and
 * withholding it because the event was terse would defeat the point.
 */
/**
 * ── v0.43 (B4-0b-1 A6): ONE TABLE FOR "IS THIS BACKGROUND WORK STILL RUNNING?" ──────────────────
 *
 * The audit's B-3 measured the two halves disagreeing: `extractOpenBackgroundWork` treated
 * `subagent/end` as the end of a subagent (`src/index.ts:2939`), while `settledSince` only recognised
 * `subagent-settled` / `subagent/settled` (`:104`). Consequences, both permanent:
 *
 *   · a subagent that ended with `subagent/end` stayed in `openSubagentIds` of the ledger row, so the
 *     row was never "fully settled" and the target was owed a result it could never be told about;
 *   · a settle named `subagent/end` arriving after the slice was invisible to the relay.
 *
 * The names are host shapes, and there are more than one of them per kind. Listing them in a single
 * table is the only form in which "the two sides agree" is checkable: `v248` feeds EVERY name in this
 * table through BOTH functions, so a name added to one side and forgotten on the other fails there.
 */
export const JOB_OPEN_EVENT_NAMES = ['job/registered'] as const
export const JOB_SETTLE_EVENT_NAMES = ['job/settled'] as const
export const SUBAGENT_OPEN_EVENT_NAMES = ['subagent/start'] as const
export const SUBAGENT_SETTLE_EVENT_NAMES = ['subagent/end', 'subagent-settled', 'subagent/settled'] as const

/** Does this event type mean "a subagent/job of this kind started"? */
export function isBackgroundOpenEvent(kind: 'job' | 'subagent', type: unknown): boolean {
  if (typeof type !== 'string') return false
  const table = kind === 'job' ? JOB_OPEN_EVENT_NAMES : SUBAGENT_OPEN_EVENT_NAMES
  return (table as readonly string[]).includes(type)
}

/** Does this event type mean "a subagent/job of this kind finished"? */
export function isBackgroundSettleEvent(kind: 'job' | 'subagent', type: unknown): boolean {
  if (typeof type !== 'string') return false
  const table = kind === 'job' ? JOB_SETTLE_EVENT_NAMES : SUBAGENT_SETTLE_EVENT_NAMES
  return (table as readonly string[]).includes(type)
}

/**
 * The id a background-work event names, across the shapes the host has used.
 *
 * `jobId` for jobs; `id` or `taskId` for subagents. Returned as `''` when the event does not carry
 * one — the callers treat that as "not evidence", never as an id of empty string.
 */
export function backgroundWorkIdOf(kind: 'job' | 'subagent', data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  if (kind === 'job') return typeof record.jobId === 'string' ? record.jobId : ''
  if (typeof record.id === 'string') return record.id
  return typeof record.taskId === 'string' ? record.taskId : ''
}

export function settledSince(
  events: readonly any[],
  watched: { jobs: readonly string[]; subagents: readonly string[] },
  sinceSeq: number,
): SettledResult[] {
  const wanted = new Map<string, 'job' | 'subagent'>()
  for (const id of watched.jobs) wanted.set(`job:${id}`, 'job')
  for (const id of watched.subagents) wanted.set(`subagent:${id}`, 'subagent')

  const seen = new Set<string>()
  const out: SettledResult[] = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const seq = Number(event.seq)
    if (!Number.isFinite(seq) || seq <= sinceSeq) continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue

    let kind: 'job' | 'subagent' | undefined
    if (isBackgroundSettleEvent('job', event.type)) kind = 'job'
    else if (isBackgroundSettleEvent('subagent', event.type)) kind = 'subagent'
    else continue
    const id = backgroundWorkIdOf(kind, data)
    if (id.length === 0 || kind === undefined) continue
    if (wanted.get(`${kind}:${id}`) !== kind) continue
    const key = `${kind}:${id}`
    /**
     * Deduplicate by `kind:id:settledSeq`, NOT by id alone.
     *
     * Two different seqs for one id mean the job RAN AGAIN — `deliveryKey`'s own docstring calls that
     * news. The old id-only `seen` set swallowed it: the first settle was relayed, the re-run never
     * was, and the `deliveredKeys` fix could not help because the second settle never reached it.
     * Repeats of the same event (same seq) are still collapsed here, which is what this set is for.
     */
    const fullKey = `${key}:${seq}`
    if (seen.has(fullKey)) continue
    seen.add(fullKey)

    const label =
      typeof data.label === 'string' && data.label.length > 0 ? data.label : id
    const raw =
      typeof data.summary === 'string'
        ? data.summary
        : typeof data.result === 'string'
          ? data.result
          : typeof data.output === 'string'
            ? data.output
            : undefined
    out.push({
      kind,
      id,
      label,
      settledSeq: seq,
      ...(raw === undefined ? {} : { summary: raw.length > 400 ? `${raw.slice(0, 400)}…` : raw }),
    })
  }
  return out
}

/** The one message the target receives when results have come back. */
/**
 * ── W1-5 (B4-0b-2): A FOREIGN RESULT IS QUOTED DATA, NOT LAYOUT ────────────────────────────────
 *
 * `relayText` dropped `summary` in verbatim (400 chars per item, no total cap) and the caller wrapped
 * the whole thing in `[系统提示] …`. A job whose output contains `## 下一步`, a fenced block or a `---`
 * therefore injected a HEADING or a FENCE into the target's context — inside a message that claims to
 * be a plugin notice. `neutralizeStructure` already exists for exactly this (`pending-state.ts`), and
 * user-typed text already goes through it; tool output did not.
 *
 * TWO MECHANISMS, and the second is the one that is easy to miss:
 *
 *   1. every `summary` passes through the injected `neutralize` (the caller supplies
 *      `neutralizeStructure` — this module must not import `pending-state.ts`, which would make a
 *      cycle, and the plugins' doctrine is "inject the value, keep the leaf ignorant");
 *   2. the WHOLE relay has a character budget (`RELAY_TOTAL_CHARS`). Thirty settled items at 400 chars
 *      each is 12,000 characters of somebody else's text in one pre-step message; past the budget each
 *      remaining item is degraded to `seq + label` — still a usable pointer — and the omission is
 *      DECLARED with a count, per the "silent truncation is a defect" rule.
 */
export const RELAY_TOTAL_CHARS = 2_000

/** Injected so the leaf stays unaware of the layout layer (and no import cycle appears). */
export type StructureNeutralizer = (text: string) => string

export function relayText(
  settled: readonly SettledResult[],
  sourceSessionId: string,
  options: { neutralize?: StructureNeutralizer; maxChars?: number } = {},
): string | undefined {
  if (settled.length === 0) return undefined
  const neutralize = options.neutralize ?? ((text: string) => text)
  const budget = Number.isFinite(options.maxChars) ? Number(options.maxChars) : RELAY_TOTAL_CHARS
  const jobs = settled.filter((item) => item.kind === 'job')
  const subs = settled.filter((item) => item.kind === 'subagent')
  const counts: string[] = []
  if (jobs.length > 0) counts.push(`${jobs.length} 个后台作业`)
  if (subs.length > 0) counts.push(`${subs.length} 个子代理`)

  const header = `[先前会话的后台结果已回来] 切片时留下的 ${counts.join('和')}已经结束，结果转述如下。`
  const footer = '这些结果不会再有第二次通知。需要原文时按上面的 seq 回读源会话。'
  /** Budget applies to the BODY: the header and footer are our own structure and always fit. */
  const bodyBudget = Math.max(200, budget - header.length - footer.length)

  const rendered: string[] = []
  let used = 0
  let omitted = 0
  for (const item of settled) {
    const kindName = item.kind === 'job' ? '后台作业' : '子代理'
    const head = `· ${kindName} ${item.label}（${item.id}）已结束，settle 在 seq=${item.settledSeq}`
    const pointerOnly = `· ${kindName} ${item.id} @ seq=${item.settledSeq}`
    const withSummary = item.summary === undefined ? undefined : `${head}：\n  ${neutralize(item.summary)}`
    const chosen = withSummary ?? `${head}；摘要未随事件写入，原文用 graft_read_result(${sourceSessionId}, ${item.settledSeq}) 读取。`
    if (used + chosen.length <= bodyBudget || rendered.length === 0) {
      rendered.push(chosen)
      used += chosen.length
      continue
    }
    /**
     * Over budget. Degrade in TWO steps, because both are honest and they cost different amounts:
     *
     *   1. the full pointer (~80 chars) when it still fits — label + id + seq, no quoted text;
     *   2. the minimal pointer (`<id> @ seq=`) when even that does not.
     *
     * MEASURED MISTAKE THIS CORRECTS: the first version always pushed the full `head`, so thirty
     * over-budget items still added ~2,400 characters and the total came out at 2,955 against a
     * 2,000-character budget — the cap existed in the code and had no effect on the output. A budget
     * that can be exceeded by continuing to append is not a budget.
     */
    const fitsFull = used + head.length <= bodyBudget
    const fitsMinimal = used + pointerOnly.length <= bodyBudget
    if (fitsFull) {
      rendered.push(head)
      used += head.length
    } else if (fitsMinimal) {
      rendered.push(pointerOnly)
      used += pointerOnly.length
    }
    /** Either way the item is counted as NOT fully relayed — the reader must know. */
    omitted += 1
  }

  const omissionLine =
    omitted === 0
      ? ''
      : `另有 ${omitted} 条结果因总长超出 ${budget} 字符预算而只保留回读坐标（内容未转述；这些结果确实存在，只是没在这里展开）。`

  return [header, ...rendered, ...(omissionLine.length > 0 ? [omissionLine] : []), footer].join('\n')
}

/**
 * ── THE IDEMPOTENCY KEY ───────────────────────────────────────────────────────────────────────
 *
 * `(kind, id, settledSeq)`, not `id` alone. Measured failure this prevents: a job that settles, is
 * retried by the host, and settles again at a NEW seq is genuinely new information (the second run's
 * result), while a repeated event at the SAME seq is the same result said twice. Keying on the id alone
 * turns the first case into a swallowed result; keying on the text would break whenever the host
 * rephrases.
 */
export function deliveryKey(item: SettledResult): string {
  return `${item.kind}:${item.id}:${item.settledSeq}`
}

/**
 * `true` when this entry still owes the target a message.
 *
 * ── v0.43 (B4-0b-1 A5): THE ANSWER NOW DEPENDS ON WHAT SETTLED ──────────────────────────────────
 *
 * With `settled` supplied, the question is "is any of these results still undelivered?" — the only
 * form that can be true for a row that already spoke about a different id. Without it (a caller that
 * has not read the source log yet, and legacy rows), the answer stays the old row-level one.
 *
 * Both answers are honest: the first is what the relay needs, the second is what a reader needs
 * before it has paid for the cold read.
 */
export function isOwed(entry: PendingTransfer, settled?: readonly SettledResult[]): boolean {
  if (settled === undefined || settled.length === 0) return entry.deliveredAt === undefined
  const delivered = new Set(entry.deliveredKeys ?? [])
  return settled.some((item) => !delivered.has(deliveryKey(item)))
}

/**
 * May this row be skipped WITHOUT reading the source log?
 *
 * Two yes-cases, both about "no further result can arrive":
 *   · `exhaustedAt` was set (a retired source whose frozen log was fully scanned);
 *   · the row was written by a build BEFORE `deliveredKeys` existed and has already spoken. Its
 *     un-relaid results were lost by the old row-level stamp — nothing can recover them, and re-reading
 *     it forever would buy nothing. The row is kept (it is history), just not re-scanned.
 *
 * A live source is NEVER skipped: it can grow, and a re-run at a new seq is new information.
 */
export function isScanExhausted(entry: PendingTransfer): boolean {
  if (entry.exhaustedAt !== undefined) return true
  return entry.deliveredKeys === undefined && entry.deliveredAt !== undefined
}

/**
 * The subset of `keys` this row is responsible for, i.e. the ones naming an id it watches.
 *
 * Used by the delivery stamp: appending a correction must record the keys that belong to THIS row
 * and leave every other row's set alone.
 */
export function watchedDeliveryKeys(entry: PendingTransfer, keys: readonly string[]): string[] {
  const prefixes = [
    ...entry.watchJobIds.map((id) => `job:${id}:`),
    ...entry.watchSubagentIds.map((id) => `subagent:${id}:`),
  ]
  return keys.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
}

/** A ledger row from the slice-time inputs. Kept here so the shape has one definition. */
export function transferRecord(input: {
  targetSessionId: string
  sourceSessionId: string
  jobs: readonly string[]
  subagents: readonly string[]
  sinceSeq: number
  createdAt: number
}): PendingTransfer {
  return {
    targetSessionId: input.targetSessionId,
    sourceSessionId: input.sourceSessionId,
    watchJobIds: [...input.jobs],
    watchSubagentIds: [...input.subagents],
    sinceSeq: input.sinceSeq,
    createdAt: input.createdAt,
  }
}