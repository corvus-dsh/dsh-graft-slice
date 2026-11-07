/**
 * v1.3 REFACTOR (batch 2, step 1) — FILE LOCKS, moved out of index.ts verbatim.
 *
 * Behaviour is unchanged: same timeouts, same stale detection, same owner-token check,
 * same audit lines. Two things are different only in WHERE they live:
 *
 *   1. the audit sink is INJECTED (`setAuditSink`) instead of imported, so this module
 *      never imports index.ts and no cycle can form;
 *   2. `sleepSync` / `lockDirFor` / the timeout constants moved with the code that uses
 *      them, because they exist for the lock and nothing else.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { graftError } from '../utils/serialize.js'
import type { GraftAuditEntry } from '../utils/logger.js'

export const LOCK_SETTLE_MS = 12
export const LOCK_TIMEOUT_MS = 8_000
export const LOCK_STALE_MS = 30_000
/**
 * HOW LONG A LOCK IS RESPECTED EVEN WHEN ITS HOLDER LOOKS ALIVE.
 *
 * `staleMs` alone is a TIMESTAMP test: "nobody renewed this for 30s, so the holder must be
 * gone". That inference is false under load. The renewal timer is an ordinary JS timer, so a
 * holder descheduled past 30s — a blocked event loop, a machine under eight concurrent
 * writers, a suspended laptop — still holds a perfectly valid lock while its lease looks
 * abandoned. Stealing it then puts TWO writers inside the critical section, which is the
 * exact corruption this lock exists to prevent.
 *
 * So the pid in the owner file is consulted before stealing: a lock is only stolen when its
 * holder is PROVABLY gone. This is the same rule `dsh-paradise` uses for its guards
 * (`SYNC_LEASE_GUARD_STALE_MS` raised 5s → 60s for the same measured reason), tightened here
 * with an actual liveness probe rather than a bigger number.
 *
 * THE HARD CAP, AND WHY IT EXISTS. A pid can be RECYCLED: the real holder died, an unrelated
 * process got its pid, and the liveness probe now says "alive" forever. Without a cap that
 * lock would never be reclaimed and every later graft would fail with STATE_LOCK_TIMEOUT —
 * a permanent outage traded for a transient risk. So past this multiple of `staleMs` the lock
 * is reclaimed regardless of the probe, and the decision is written to the audit log as
 * `lock-stale-forced` so it is never silent.
 */
export const LOCK_FORCED_STEAL_MULTIPLE = 10

/**
 * Is a process with this pid still running?
 *
 * `process.kill(pid, 0)` performs the existence and permission checks without delivering a
 * signal; `EPERM` means "alive but not ours", which is ALIVE. Treating EPERM as dead is how a
 * supervisor kills a healthy process — the same reasoning `dsh-paradise`'s `isProcessAlive`
 * records.
 *
 * NAMED `isHolderAlive` AND NOT `isProcessAlive` ON PURPOSE. `index.ts` already exports an
 * `isProcessAlive`, and the bundler inlines every module into ONE file — a second top-level
 * declaration with the same name is a duplicate-binding SyntaxError at load, not a shadow.
 * The two implementations must not drift, so this one only adds the self-pid short-circuit
 * and otherwise follows the same rule.
 */
export function isHolderAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as any)?.code === 'EPERM'
  }
}

/**
 * The audit sink, injected by the plugin at load time.
 *
 * Deliberately a setter and not an import: index.ts imports THIS module, so the reverse
 * dependency would be a cycle (and the bundler inlines both into one file, where a cycle
 * would surface as a temporal-dead-zone crash rather than a build error).
 */
export type AuditSink = (entry: GraftAuditEntry) => void

let auditSink: AuditSink | undefined

export function setAuditSink(sink: AuditSink | undefined): void {
  auditSink = sink
}

function audit(entry: GraftAuditEntry): void {
  try {
    auditSink?.(entry)
  } catch {
    // Audit is evidence, never a gate.
  }
}

/** Block the current thread without burning a core (Atomics.wait is a real sleep). */
export function sleepSync(ms: number): void {
  try {
    const waitArray = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(waitArray, 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Atomics unavailable (exotic runtime): the deadline loop still yields the CPU.
    }
  }
}

/** `<path>.lock` next to the file it protects. */
export function lockDirFor(path: string): string {
  return `${path}.lock`
}

/**
 * Acquire one file lock. Returns the release function (idempotent).
 *
 * `label` is only for the audit line ("which lock did we wait on?"), so an operator can
 * tell a ledger wait from an audit wait.
 */
export function acquireFileLock(
  path: string,
  options: { timeoutMs?: number; staleMs?: number; label?: string; silent?: boolean; leaseMs?: number } = {},
): () => void {
  const lock = lockDirFor(path)
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const label = options.label ?? basename(path)
  // The audit file must never audit its own acquisition: that recursion re-enters this
  // function while the audit lock is still held and deadlocks the thread.
  const silent = options.silent === true
  // v7.8: a lock is OWNED, not merely claimed. The owner file carries a random token;
  // release verifies it, so a late writer cannot delete a lock that was stolen and
  // re-acquired by someone else. The same file is the lease: while the holder is alive it
  // is rewritten every leaseMs/2, so waiters can tell "slow" from "dead".
  const leaseMs = options.leaseMs ?? 30_000
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`
  const ownerFile = join(lock, 'owner')
  const writeOwner = (): void => {
    try {
      writeFileSync(ownerFile, JSON.stringify({ token, pid: process.pid, at: Date.now() }), 'utf8')
    } catch {
      // The lock dir exists; a missing owner file only costs precise stealing.
    }
  }
  const readOwner = (): { token?: string; at?: number; pid?: number } => {
    try {
      return JSON.parse(readFileSync(ownerFile, 'utf8')) as { token?: string; at?: number; pid?: number }
    } catch {
      return {}
    }
  }
  const started = Date.now()
  let reported = false
  for (;;) {
    try {
      mkdirSync(lock)
      writeOwner()
      let renewal: ReturnType<typeof setInterval> | undefined
      if (leaseMs > 0) {
        renewal = setInterval(writeOwner, Math.max(100, Math.floor(leaseMs / 2)))
        // A renewal timer must never keep the host process alive.
        ;(renewal as unknown as { unref?: () => void }).unref?.()
      }
      const held = Date.now() - started
      if (!silent && held > LOCK_SETTLE_MS) {
        audit({ at: new Date().toISOString(), kind: 'lock-wait', file: label, waitedMs: held })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        if (renewal !== undefined) clearInterval(renewal)
        // Owner check: only the holder may remove the lock.
        const owner = readOwner()
        if (owner.token !== undefined && owner.token !== token) {
          audit({
            at: new Date().toISOString(),
            kind: 'lock-owner-mismatch',
            file: label,
            detail: 'release refused: the lock was re-acquired by another owner',
          })
          return
        }
        try {
          rmSync(lock, { recursive: true, force: true })
        } catch {
          // A lock we cannot remove is reported by the next waiter as stale.
        }
      }
    } catch (error) {
      if ((error as any)?.code !== 'EEXIST') throw error
    }
    // Stale detection: a killed process leaves the directory behind, and its lease stops
    // being renewed. Prefer the lease timestamp over the dir mtime, because the dir mtime
    // cannot be renewed without unlinking the lock.
    //
    // v2.2.0: A TIMESTAMP IS NOT PROOF OF DEATH. The old rule stole the lock as soon as
    // `staleMs` elapsed, which under load steals a LIVE holder's lock (the renewal timer is
    // just a JS timer; a descheduled holder cannot fire it) and puts two writers inside one
    // critical section. Now the holder's pid is probed first, and a lock is only stolen on
    // evidence:
    //
    //   1. the lease is old AND the holder pid is gone          -> steal (the real crash case)
    //   2. the lease is old AND no pid recorded at all          -> steal (a record we cannot
    //                                                              attribute is not a holder we
    //                                                              can honour)
    //   3. the lease is ancient (> FORCED_STEAL_MULTIPLE × stale)-> steal regardless, because a
    //                                                              recycled pid must not deadlock
    //                                                              the store forever; audited
    //   4. the lease is old but the holder is alive             -> WAIT. This is the case that
    //                                                              used to corrupt state.
    try {
      const owner = readOwner()
      const leaseAt = Number.isFinite(Number(owner.at)) ? Number(owner.at) : statSync(lock).mtimeMs
      const age = Date.now() - leaseAt
      if (age > staleMs) {
        const holderPid = Number(owner.pid)
        const holderKnown = Number.isFinite(holderPid) && holderPid > 0
        const forced = age > staleMs * LOCK_FORCED_STEAL_MULTIPLE
        if (forced || !holderKnown || !isHolderAlive(holderPid)) {
          rmSync(lock, { recursive: true, force: true })
          audit({
            at: new Date().toISOString(),
            kind: forced ? 'lock-stale-forced' : 'lock-stale',
            file: label,
            detail: forced
              ? `stolen after ${Math.round(age)}ms despite pid ${holderPid} looking alive (pid reuse guard)`
              : holderKnown
                ? `stolen after ${Math.round(age)}ms; holder pid ${holderPid} is gone`
                : `stolen after ${Math.round(age)}ms; no holder pid recorded`,
          })
          continue
        }
        // Evidence says the holder is ALIVE. Wait for it instead of stealing.
        // (No `continue`: fall through to the timeout check so a wedged holder still
        // surfaces as STATE_LOCK_TIMEOUT rather than an infinite wait.)
      }
    } catch {
      continue // the holder released between EEXIST and stat: retry immediately
    }
    const waited = Date.now() - started
    if (waited > timeoutMs) {
      throw graftError(
        'STATE_LOCK_TIMEOUT',
        `could not acquire the ${label} lock within ${timeoutMs}ms; another graft is still writing state`,
      )
    }
    if (!silent && !reported && waited > LOCK_SETTLE_MS) {
      reported = true
      audit({ at: new Date().toISOString(), kind: 'lock-wait', file: label, waitedMs: waited, detail: 'waiting' })
    }
    sleepSync(LOCK_SETTLE_MS)
  }
}

/** Run `fn` while holding the lock for `path`. */
export function withFileLock<T>(
  path: string,
  fn: () => T,
  options: { timeoutMs?: number; staleMs?: number; label?: string; silent?: boolean; leaseMs?: number } = {},
): T {
  const release = acquireFileLock(path, options)
  try {
    return fn()
  } finally {
    release()
  }
}
