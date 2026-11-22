/**
 * LEDGER RESTORE — the ONE place that decides the order of an un-retire. `src/core/ledger-restore.ts`.
 *
 * WHY THIS IS ITS OWN MODULE (v8.x B10): the rollback path used to state that order twice — once in
 * `rollbackFailedIgnition` (memory first, then the disk write) and once here (disk first, then memory).
 * Two statements of one rule is not redundancy, it is a race: the caller's copy won, so a failed write
 * left memory saying "restored" while the ledger on disk still said "retired". Extracting the function
 * is what removes the second copy, and it is also what lets the module-size gate stay a ceiling
 * instead of becoming a budget.
 *
 * DEPENDENCY DIRECTION: everything arrives as `deps` — no import from `index.ts` or `ignition.ts`
 * (either would be a cycle). Same shape `core/txn.ts` uses for its audit sink.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { withFileLock } from './txn.js'
import { readLedger, writeLedgerAtomic } from './ledger.js'

/**
 * The per-session marks the pre-step actually reads, plus the two ledger paths.
 *
 * Narrow on purpose: a wider `state()` would let this module reach for something it does not need and
 * turn a pure ordering rule into a second owner of graft's bookkeeping.
 */
export interface LedgerRestoreDeps {
  retiredStorePath(): string
  transferredStorePath(): string
  retired: Set<string>
  transferred: Map<string, unknown>
  /** The auto-graft STATE machine — `'done'` here returns `reason: 'Transferred'` forever. */
  autoGraftStates: { delete(key: string): unknown }
  /** The in-flight guard, so a rollback does not collide with a graft still holding the id. */
  autoGraftInFlight: { delete(key: string): unknown }
  /** The deferred queue: a pending source that was retracted must not be resumed later. */
  pendingGraftSources: { delete(key: string): unknown }
  pendingConfirms: { delete(key: string): unknown }
  /** "This id is a target we created" — a rollback ends that relationship. */
  targets: { delete(key: string): unknown }
  logWarn?(message: string): void
}

/** The ledger-aware read: a torn or future-epoch envelope reads as empty, not as garbage. */
function ledgerArrayLocal(path: string): unknown[] {
  const read = readLedger(path)
  if (read.defect !== undefined && read.defect !== 'unreadable') return []
  return Array.isArray(read.payload) ? read.payload : []
}

/**
 * The TRUE un-retire.
 *
 * `persistRetiredStore(ctx, [id])` is not enough, and the reason is subtle: the write path is a
 * read-modify-write that ADOPTS the file's contents back into memory (correct for merging two
 * processes' retirements). So a removal that runs before the file is rewritten can be UNDONE by that
 * same adopt pass on the next write — the id comes back from disk and the session is frozen again,
 * durably, on the next restart. The rollback would look successful in memory and be a no-op on disk.
 *
 * This does the removal in the only order that holds: remove from the file under the lock, and make the
 * in-memory set agree with the file afterwards. On a failed write it returns `false` WITHOUT having
 * touched memory, so "memory agrees with disk" holds on both branches.
 */
export function restoreSessionDurably(deps: LedgerRestoreDeps, sessionId: string): boolean {
  let restored = false
  try {
    mkdirSync(dirname(deps.retiredStorePath()), { recursive: true })
    withFileLock(deps.retiredStorePath(), () => {
      const remaining = new Set(ledgerArrayLocal(deps.retiredStorePath()).filter((v): v is string => typeof v === 'string'))
      remaining.delete(sessionId)
      writeLedgerAtomic(deps.retiredStorePath(), [...remaining].sort())
      // The memory set is made to AGREE with the file, not merged into: after an explicit removal,
      // "the file does not have it" is the authoritative answer.
      deps.retired.delete(sessionId)
      restored = !remaining.has(sessionId)
    })
  } catch (error) {
    try {
      deps.logWarn?.(`[dsh-graft-slice] un-retire write failed for ${sessionId}: ${String((error as any)?.message ?? error)}`)
    } catch {
      // Logging must not change the rollback result.
    }
    return false
  }
  try {
    mkdirSync(dirname(deps.transferredStorePath()), { recursive: true })
    withFileLock(deps.transferredStorePath(), () => {
      const remaining = { ...(ledgerArrayLocal(deps.transferredStorePath()) as unknown as Record<string, unknown>) }
      delete remaining[sessionId]
      writeLedgerAtomic(deps.transferredStorePath(), remaining)
      deps.transferred.delete(sessionId)
    })
  } catch (error) {
    try {
      deps.logWarn?.(
        `[dsh-graft-slice] un-retire transfer write failed for ${sessionId}: ${String((error as any)?.message ?? error)}`,
      )
    } catch {
      // Logging must not change the rollback result.
    }
  }
  /**
   * Belt and braces for the in-memory gate the pre-step actually reads.
   *
   * The pre-step consults FOUR per-session marks, not just the two ledgers: the retired set, the
   * transferred map, the auto-graft STATE machine, and the deferred graft queue. Clearing only the
   * ledgers leaves `autoGraftStates === 'done'`, which returns `reason: 'Transferred'` forever — the
   * session would be un-retired on disk and still frozen in the running process, the same double-blind
   * one layer down.
   */
  deps.retired.delete(sessionId)
  deps.transferred.delete(sessionId)
  deps.autoGraftStates.delete(sessionId)
  deps.autoGraftInFlight.delete(sessionId)
  deps.pendingGraftSources.delete(sessionId)
  deps.pendingConfirms.delete(sessionId)
  // The "this id is a target we created" mark belongs to the TARGET, and a rollback ends that
  // relationship: the source is a plain session again and must not inherit the target's grace window.
  deps.targets.delete(sessionId)
  return restored || !deps.retired.has(sessionId)
}
