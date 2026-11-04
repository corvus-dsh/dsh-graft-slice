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
    | 'lock-owner-mismatch'
    | 'lock-reclaimed'
    | 'command-blocked'
    | 'chain-guard'
    | 'model-nudge'
    | 'nudge-escalation'
    | 'force-graft'
    | 'target-created'
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
