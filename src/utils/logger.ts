/**
 * v1.3 REFACTOR — the LOG SHAPE, separated from the log WRITE.
 *
 * The write (`appendGraftAudit`) needs the data directory, the file lock and the state
 * paths, so it stays in index.ts. What moves here is the part that has no state at all:
 * the entry type and the one-line JSON formatter. `formatAuditLine` produces exactly the
 * bytes the old inline `JSON.stringify({ ...entry, pid })` produced.
 */

export interface GraftAuditEntry {
  at: string
  kind:
    | 'lock-wait'
    | 'lock-stale'
    /**
     * v2.2.0: a lock reclaimed even though its holder's pid looked ALIVE.
     *
     * A pid can be recycled, so liveness cannot be trusted forever — without a hard cap a
     * recycled pid would wedge the store permanently. This kind exists so that reclaim is
     * NEVER silent: a `lock-stale-forced` line in the audit is the evidence that the
     * pid-liveness rule was overridden and a human should look at the timing.
     */
    | 'lock-stale-forced'
    | 'lock-owner-mismatch'
    | 'lock-reclaimed'
    | 'command-blocked'
    | 'chain-guard'
    /**
     * ── N1/N2/N3 (lead §二十九/三十) ──────────────────────────────────────────────────────────────
     *
     * `grace-yielded`：宽限期**让位**给宿主压缩（这一代已经工作过，压力是它自己长出来的）。
     * `graft-seed-too-large`：这一代**一出生**就越过硬切线 —— 那是继承的种子太大，属 RESOURCE。
     * 靠反复切片消化它只会切出同样大的新种子，所以它必须显形，而不是被当成「该切了」。
     */
    | 'grace-yielded'
    | 'graft-seed-too-large'
    | 'model-nudge'
    | 'nudge-escalation'
    | 'force-graft'
    | 'target-created'
    /**
     * A command policy returned `ask` and the pre-step gate stopped to consult. Written by
     * index.ts:10628 but missing from this union, so the audit call was a type error.
     * See commit msg.
     */
    | 'command-asked'
    /**
     * W1-3 (B4-0b-2): a file in `.txn` that recovery will NOT act on.
     *
     * Two shapes produce it: a filename this plugin could never have written, and one of our own
     * filenames whose content cannot be parsed. The first is LEFT ALONE (it is not ours to delete);
     * the second is dropped after this line. Both used to be a silent `rmSync`.
     */
    | 'journal-foreign'
    /** W1-2: a complete-but-unretired target that recovery kept for a human to decide about. */
    | 'journal-kept'
    /**
     * W1-4b: a persisted prepared slice whose `targetSessionId` (or `sourceSessionId`) is not a legal
     * session id. The entry is DROPPED rather than repaired with `''`.
     *
     * WHY DROPPING IS RIGHT HERE, and why it differs from the journal rule: a `.txn` journal is evidence
     * of a migration that may have half-happened OUTSIDE this process, so it is kept for a human. A
     * prepared slice is our OWN staging record, written by this plugin, and an illegal id in it can only
     * come from a build that accepted one (or from a hand edit). Committing it would create a target the
     * alphabet forbids; keeping it would let a later commit try again forever. So: report it, then drop.
     */
    | 'prepared-entry-invalid'
  file?: string
  sessionId?: string
  targetSessionId?: string
  ratio?: number
  waitedMs?: number
  detail?: string
}

/**
 * One JSON line, without the trailing newline.
 *
 * `pid` is injected LAST on purpose: the audit file is read by tools that diff lines, and
 * keeping the caller's field order byte-stable is what makes those diffs readable.
 */
export function formatAuditLine(entry: GraftAuditEntry, pid: number): string {
  return JSON.stringify({ ...entry, pid })
}
