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
  const readOwner = (): { token?: string; at?: number } => {
    try {
      return JSON.parse(readFileSync(ownerFile, 'utf8')) as { token?: string; at?: number }
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
    try {
      const owner = readOwner()
      const leaseAt = Number.isFinite(Number(owner.at)) ? Number(owner.at) : statSync(lock).mtimeMs
      if (Date.now() - leaseAt > staleMs) {
        rmSync(lock, { recursive: true, force: true })
        audit({ at: new Date().toISOString(), kind: 'lock-stale', file: label, detail: 'stolen after staleMs' })
        continue
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
