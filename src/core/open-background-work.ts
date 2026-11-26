import { backgroundWorkIdOf, isBackgroundOpenEvent, isBackgroundSettleEvent } from './pending-transfers.js'
import type { SessionEventLike } from './watermark.js'
import { isRecord } from '../utils/serialize.js'

/**
 * v7.0 P1-2: background work that will NOT follow the user into the target.
 *
 * A graft copies the conversation; it cannot copy a running process. Jobs and
 * subagents are owned by the live agent loop, and when the source session is
 * retired those children keep running (or get torn down) with their results
 * going to a session the user has left. The target then waits for a report that
 * will never arrive, or — worse — re-runs work that is still in flight.
 *
 * Detection is from the log, not from the jobs service: `job/registered` and
 * `job/settled` are already paired per job id in the durable record, so this
 * needs no live handle and works identically for a cold slice.
 */
export interface OpenBackgroundWork {
  jobs: string[]
  subagents: string[]
  /** The same items by ID (the labels above are for display). Added in v0.40 for the transfer ledger. */
  jobIds: string[]
  subagentIds: string[]
}

export function extractOpenBackgroundWork(events: readonly SessionEventLike[]): OpenBackgroundWork {
  const jobs = new Map<string, string>()
  const subagents = new Map<string, string>()
  for (const event of events) {
    const data = event.data
    if (!isRecord(data)) continue
    /**
     * ── v0.43 (B4-0b-1 A6): THE SAME TABLE AS THE RELAY ────────────────────────────────────────
     *
     * These four branches used to compare literal strings here while `settledSince` compared a
     * DIFFERENT set of literal strings there — and the two disagreed exactly on the subagent case
     * (`subagent/end` vs `subagent-settled`). Now both sides ask the shared predicate, so "which
     * names mean finished" has one answer. `v248` walks the whole table through both functions.
     */
    if (isBackgroundOpenEvent('job', event.type)) {
      const id = backgroundWorkIdOf('job', data)
      if (id.length === 0) continue
      const label = typeof data.label === 'string' && data.label.length > 0 ? data.label : id
      jobs.set(id, label)
      continue
    }
    if (isBackgroundSettleEvent('job', event.type)) {
      const id = backgroundWorkIdOf('job', data)
      if (id.length > 0) jobs.delete(id)
      continue
    }
    // A spawned subagent's lifetime is visible through its own events: the
    // task id appears on creation and again on settlement.
    if (isBackgroundOpenEvent('subagent', event.type)) {
      const id = backgroundWorkIdOf('subagent', data)
      if (id.length === 0) continue
      subagents.set(id, typeof data.label === 'string' && data.label.length > 0 ? data.label : id)
      continue
    }
    if (isBackgroundSettleEvent('subagent', event.type)) {
      const id = backgroundWorkIdOf('subagent', data)
      if (id.length > 0) subagents.delete(id)
    }
  }
  return {
    jobs: [...jobs.values()],
    subagents: [...subagents.values()],
    /**
     * ── v0.40 (B3 / F5): THE IDS, BECAUSE THE LABELS ARE FOR READING ────────────────────────────
     *
     * `jobs`/`subagents` carry the human LABELS — that is what the tape prints, and printing an opaque
     * id in prose was never useful. The ledger however must watch IDS: a label is display text, and a
     * `job/settled` event identifies its job by id. Measured while writing v241: keying the ledger on
     * the label produced a row watching `后台作业 42` and the relay then matched nothing, forever.
     *
     * Additive fields, so every existing reader keeps working.
     */
    jobIds: [...jobs.keys()],
    subagentIds: [...subagents.keys()],
  }
}
