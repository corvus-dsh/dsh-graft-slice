/**
 * v1.3 REFACTOR (batch 2, step 2b) — the LEDGER READ/WRITE layer.
 *
 * Moved verbatim from index.ts, with one structural rule kept: every function here takes
 * the file path as an argument. Nothing in this module knows about the data directory, the
 * plugin context or the module-level state paths — that knowledge stays in index.ts, which
 * is what keeps the dependency one-way.
 *
 * The failure contract is part of the behaviour and is unchanged:
 *   - an absent or unparsable file reads as `{ epoch: 0, defect: 'unreadable' }`;
 *   - an envelope without a payload reads as `torn`;
 *   - an envelope from a NEWER writer reads as `future-epoch` (refuse, wait for a retry);
 *   - a file with no envelope at all is the legacy shape: `{ epoch: 1, payload: parsed }`.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

import { isRecord } from '../utils/serialize.js'

/**
 * Write JSON via temp file + rename.
 *
 * `rename` is atomic on the same volume on both NTFS and POSIX, so a reader sees either
 * the old file or the new one and never a partial one.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

/** Parse an object out of a file; ANY failure degrades to `{}` (callers rely on it). */
export function readJsonRecord(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export type LedgerDefect = 'unreadable' | 'torn' | 'future-epoch'

export interface LedgerEnvelope {
  epoch: number
  at: string
  pid: number
  payload: unknown
}

export interface LedgerRead {
  /** 0 = absent/unreadable, 1 = a bare legacy payload, 2+ = an envelope epoch. */
  epoch: number
  payload: unknown
  /** Present when `payload` must not be used. */
  defect?: LedgerDefect
}

export const LEDGER_EPOCH = 2

export function readLedger(path: string): LedgerRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { epoch: 0, payload: undefined, defect: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { epoch: 0, payload: undefined, defect: 'unreadable' }
  }
  if (isRecord(parsed) && 'epoch' in parsed) {
    const epoch = Number((parsed as Record<string, unknown>).epoch)
    if (!Number.isFinite(epoch) || epoch <= 0) return { epoch: 0, payload: undefined, defect: 'torn' }
    if (epoch > LEDGER_EPOCH) return { epoch, payload: undefined, defect: 'future-epoch' }
    if (!('payload' in parsed)) return { epoch, payload: undefined, defect: 'torn' }
    const payload = (parsed as Record<string, unknown>).payload
    if (payload === undefined || payload === null) return { epoch, payload: undefined, defect: 'torn' }
    return { epoch, payload }
  }
  return { epoch: 1, payload: parsed }
}

/** The epoch of a ledger file: 0 absent, 1 legacy, 2+ envelope. */
export function readLedgerEpoch(path: string): number {
  return readLedger(path).epoch
}

/**
 * The usable payload of a ledger file, whatever shape wrote it.
 *
 * Exported because the disk-only tools (`scripts/debug-status.mjs`,
 * `scripts/prune-ghosts.mjs`) and the tests read the same files: one unwrap
 * implementation, not five.
 */
export function readLedgerPayload(path: string): unknown {
  const read = readLedger(path)
  return read.defect === undefined || read.defect === 'unreadable' ? read.payload : undefined
}

/** The payload as an object, or `{}` when the file is missing/foreign/torn. */
export function ledgerRecord(path: string): Record<string, unknown> {
  const read = readLedger(path)
  if (read.defect !== undefined && read.defect !== 'unreadable') return {}
  return isRecord(read.payload) ? read.payload : {}
}

/** Wrap a payload in the current envelope and write it atomically. */
export function writeLedgerAtomic(path: string, payload: unknown): void {
  const envelope: LedgerEnvelope = {
    epoch: LEDGER_EPOCH,
    at: new Date().toISOString(),
    pid: process.pid,
    payload,
  }
  writeJsonAtomic(path, envelope)
}
