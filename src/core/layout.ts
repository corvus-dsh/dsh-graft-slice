/**
 * THE CROSS-PLUGIN LAYOUT CONTRACT — the only thing `dsh-graft-slice` and `dsh-memory` share.
 *
 * ── P1-2 (audit 2026-11-08): WHY A VERSION MARKER, WHEN THE LEDGER EPOCH ALREADY EXISTS ───────
 *
 * `core/ledger.ts` fences the ledger *content format* with an epoch. That fence does NOT cover the
 * *directory layout*, and the gap has teeth on this side too:
 *
 *   - this plugin reads four files out of the memory store by NAME (`negatives.jsonl`, `facts.jsonl`,
 *     `experiences.jsonl`, `suggestions.jsonl`) and degrades every unreadable one to `[]`. A rename on
 *     the writer's side therefore shows up as "this workspace has no memories recorded" — a silent
 *     zero, not an error.
 *   - both sides derive each other's directory INDEPENDENTLY (`resolveStoreDir` /
 *     `resolveMemoryPaths` here, `graftDataDir` there), so the two derivations can disagree with no
 *     error anywhere.
 *
 * So each producer writes `.layout.json` into the directory it owns:
 *
 *   { "layout": 1, "producer": "dsh-memory", "files": ["negatives.jsonl", ...] }
 *
 * and each reader asserts it BEFORE reading:
 *
 *   absent      → proceed. A directory written before this marker existed is legacy, and refusing it
 *                 would break every existing installation on upgrade. Documented, not silent.
 *   unreadable  → REFUSE. A torn manifest is not proof of an understood layout.
 *   layout != N → REFUSE with `LAYOUT_UNSUPPORTED`. Exact match rather than ">=": a reader accepting
 *                 an older version claims it still knows that shape, and a claim nobody can check is
 *                 the guess this module exists to remove.
 *
 * WHAT THIS CANNOT CATCH, SAID PLAINLY: if the two plugins look at DIFFERENT DIRECTORIES, this reader
 * finds no manifest there and proceeds — absent looks exactly like "never used". Detecting that is a
 * deployment check, not a version check.
 *
 * THE SAME MODULE EXISTS IN `dsh-memory` WITH THE PRODUCER NAMES MIRRORED, and the duplication is
 * deliberate: the four repositories have zero static imports between them, which is what lets any one
 * be uninstalled without the others failing at load. Each side's test hard-codes the OTHER side's
 * literal file names and version, so a one-sided layout change turns a test red where it was made —
 * see `test/v102-layout-contract.test.mjs`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The manifest's file name, inside the directory it describes. */
export const LAYOUT_MANIFEST_FILE = '.layout.json'

/** The layout version of the GRAFT LEDGER directory this build writes (and reads). */
export const GRAFT_LEDGER_LAYOUT_VERSION = 1

/** The files `dsh-memory` takes out of the ledger directory this plugin owns. */
export const GRAFT_LEDGER_FILES = ['.retired.json', '.transferred.json'] as const

/** The layout version of the MEMORY STORE this build reads. */
export const MEMORY_LAYOUT_VERSION = 1

/** The files this plugin reads out of the memory store. */
export const MEMORY_LAYOUT_FILES = ['negatives.jsonl', 'facts.jsonl', 'experiences.jsonl', 'suggestions.jsonl'] as const

export interface LayoutManifest {
  layout: number
  producer: string
  files: readonly string[]
}

export type LayoutRead =
  | { state: 'absent' }
  | { state: 'unreadable'; detail: string }
  | { state: 'present'; manifest: LayoutManifest }

/** Raised when a directory's declared layout is absent-but-torn or one this build does not speak. */
export class LayoutUnsupportedError extends Error {
  readonly code = 'LAYOUT_UNSUPPORTED'
  readonly dir: string
  readonly expected: number
  readonly found?: number

  constructor(dir: string, expected: number, detail: string, found?: number) {
    super(`LAYOUT_UNSUPPORTED: ${dir}: ${detail}`)
    this.name = 'LayoutUnsupportedError'
    this.dir = dir
    this.expected = expected
    this.found = found
  }
}

export function readLayoutManifest(dir: string): LayoutRead {
  const path = join(dir, LAYOUT_MANIFEST_FILE)
  if (!existsSync(path)) return { state: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { state: 'unreadable', detail: `manifest is not valid JSON (${String((error as any)?.message ?? error)})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'unreadable', detail: 'manifest is not a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  const layout = Number(record.layout)
  if (!Number.isFinite(layout) || layout <= 0) {
    return { state: 'unreadable', detail: `manifest has no usable "layout" number (${JSON.stringify(record.layout)})` }
  }
  return {
    state: 'present',
    manifest: {
      layout,
      producer: typeof record.producer === 'string' ? record.producer : '',
      files: Array.isArray(record.files) ? record.files.filter((name): name is string => typeof name === 'string') : [],
    },
  }
}

/**
 * The pre-read gate. Throws `LayoutUnsupportedError` (code `LAYOUT_UNSUPPORTED`) when the directory
 * declares a layout this build does not speak; returns the read otherwise, including `absent`.
 *
 * IT THROWS RATHER THAN RETURNING A FLAG on purpose: a caller that forgets to check a boolean reads
 * the directory anyway, which is precisely the silent-zero failure this replaces.
 */
export function assertLayoutSupported(
  dir: string,
  expected: { version: number; producer: string },
): LayoutRead {
  const read = readLayoutManifest(dir)
  if (read.state === 'absent') return read
  if (read.state === 'unreadable') {
    throw new LayoutUnsupportedError(dir, expected.version, read.detail)
  }
  if (read.manifest.layout !== expected.version) {
    throw new LayoutUnsupportedError(
      dir,
      expected.version,
      `written with layout ${read.manifest.layout} by ${read.manifest.producer || 'an unknown producer'}, ` +
        `but this build speaks layout ${expected.version}; refusing to read it rather than guess`,
      read.manifest.layout,
    )
  }
  return read
}

/**
 * Publish this side's layout. Idempotent BY CONTENT: an unchanged manifest is not rewritten, so an
 * activation does not touch the directory's mtime and no watcher sees a phantom change.
 */
export function writeLayoutManifest(dir: string, manifest: LayoutManifest): boolean {
  const body = `${JSON.stringify({ layout: manifest.layout, producer: manifest.producer, files: [...manifest.files] }, null, 2)}\n`
  const path = join(dir, LAYOUT_MANIFEST_FILE)
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === body) return false
  } catch {
    // unreadable → fall through and rewrite
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, body, 'utf8')
  return true
}
