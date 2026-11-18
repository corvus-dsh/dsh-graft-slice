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
    let id = ''
    if (event.type === 'job/settled') {
      kind = 'job'
      id = typeof data.jobId === 'string' ? data.jobId : ''
    } else if (event.type === 'subagent-settled' || event.type === 'subagent/settled') {
      kind = 'subagent'
      id = typeof data.id === 'string' ? data.id : typeof data.taskId === 'string' ? data.taskId : ''
    } else {
      continue
    }
    if (id.length === 0 || kind === undefined) continue
    if (wanted.get(`${kind}:${id}`) !== kind) continue
    const key = `${kind}:${id}`
    if (seen.has(key)) continue
    seen.add(key)

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
export function relayText(settled: readonly SettledResult[], sourceSessionId: string): string | undefined {
  if (settled.length === 0) return undefined
  const jobs = settled.filter((item) => item.kind === 'job')
  const subs = settled.filter((item) => item.kind === 'subagent')
  const counts: string[] = []
  if (jobs.length > 0) counts.push(`${jobs.length} 个后台作业`)
  if (subs.length > 0) counts.push(`${subs.length} 个子代理`)

  const lines = [
    `[先前会话的后台结果已回来] 切片时留下的 ${counts.join('和')}已经结束，结果转述如下。`,
    ...settled.map((item) => {
      const head = `· ${item.kind === 'job' ? '后台作业' : '子代理'} ${item.label}（${item.id}）已结束，settle 在 seq=${item.settledSeq}`
      return item.summary === undefined
        ? `${head}；摘要未随事件写入，原文用 graft_read_result(${sourceSessionId}, ${item.settledSeq}) 读取。`
        : `${head}：\n  ${item.summary}`
    }),
    '这些结果不会再有第二次通知。需要原文时按上面的 seq 回读源会话。',
  ]
  return lines.join('\n')
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

/** `true` when this entry still owes the target a message. */
export function isOwed(entry: PendingTransfer): boolean {
  return entry.deliveredAt === undefined
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