#!/usr/bin/env node
/**
 * v0.15 maintenance: quarantine the GHOST sessions and reset the derived ledgers.
 *
 * A "ghost" is a `session_projcache` entry whose session log no longer exists on
 * disk. Measured on this machine: 574 cache entries, 10 of them real. The other
 * 564 were still listed in the browser while pointing at nothing.
 *
 * WHY THIS IS NOT PART OF `graft_debug_status`
 *
 * The panel is read-only by construction, and that is a property worth keeping: a
 * diagnostic that mutates state cannot be run casually while a session is live.
 * Clearing is therefore a separate, EXPLICIT script — like `memory_migrate_evidence`,
 * it never runs on activation.
 *
 * WHAT IT DOES
 *
 *   - copies the three ledgers (`.retired.json`, `.transferred.json`,
 *     `.graft-targets.json`) and the two derived caches
 *     (`.graft-constraint-sections.json`, `.graft-prepared.json`) into a quarantine
 *     directory, then resets the derived state;
 *   - MOVES every ghost cache entry into the same quarantine directory (never
 *     deletes: for a session whose log is gone, that cache file is the only
 *     remaining trace);
 *   - writes `MANIFEST.json` (original path, bytes, mtime) and `restore.ps1`, which
 *     puts everything back.
 *
 * Usage:
 *   node scripts/prune-ghosts.mjs                 # dry run: report only
 *   node scripts/prune-ghosts.mjs --apply         # quarantine + reset
 *   node scripts/prune-ghosts.mjs --apply --keep-ledgers   # ghosts only
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { collectDebugStatus, scanAndReclaimLocks, collectMemoryStoreStatus, readLedger } from '../index.js'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const keepLedgers = args.includes('--keep-ledgers')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = process.env.DSH_PROFILE_DIR ?? join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
const stateDir = (() => {
  const index = args.indexOf('--data')
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : join(profileDir, 'data', 'dsh-graft-slice')
})()
const cacheRoot = (() => {
  const index = args.indexOf('--cache')
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : join(home, 'storages', 'session_projcache', 'sessions')
})()
const memoryDir = (() => {
  const index = args.indexOf('--memory')
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : join(profileDir, 'data', 'dsh-memory')
})()

function liveSessionIds() {
  const root = join(home, 'sessions')
  const out = new Set()
  try {
    for (const workspace of readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      for (const session of readdirSync(join(root, workspace.name), { withFileTypes: true })) {
        if (session.isDirectory()) out.add(session.name)
      }
    }
  } catch {
    // An absent sessions root means every cache entry is a ghost; that is reported
    // by the counts, not silently turned into "delete everything".
  }
  return out
}

function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * v0.18: the ledgers carry an epoch envelope, so a bare `readJson` sees an object
 * where it expects an array. These two unwrap through the plugin's own reader —
 * the same one the runtime uses, so this script cannot drift from it.
 */
function ledgerPayload(path) {
  const read = readLedger(path)
  return read.defect === undefined || read.defect === 'unreadable' ? read.payload : undefined
}
function ledgerArray(path) {
  const payload = ledgerPayload(path)
  return Array.isArray(payload) ? payload : []
}
function ledgerRecord(path) {
  const payload = ledgerPayload(path)
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
}
/** The empty form of a reset ledger, in the CURRENT epoch. */
function emptyLedgerText(name) {
  const payload = name === '.transferred.json' || name === '.graft-targets.json' ? {} : []
  return JSON.stringify({ epoch: 2, at: new Date().toISOString(), pid: process.pid, payload }, null, 2) + '\n'
}

/** Move within a volume, falling back to copy+unlink across volumes. */
function moveFile(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
}

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const quarantine = join(dirname(cacheRoot), `_quarantine-ghost-${stamp}`)
  const live = liveSessionIds()
  const entries = (() => {
    try {
      return readdirSync(cacheRoot).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
  })()
  const ghosts = entries.filter((name) => !live.has(name.replace(/\.json$/u, '')))

  const ledgerFiles = ['.retired.json', '.transferred.json', '.graft-targets.json']
  const cacheFiles = ['.graft-constraint-sections.json', '.graft-prepared.json']
  const plan = {
    stateDir,
    cacheRoot,
    quarantine,
    liveSessions: live.size,
    cacheEntries: entries.length,
    ghosts: ghosts.length,
    ledgersReset: keepLedgers ? [] : ledgerFiles.filter((name) => existsSync(join(stateDir, name))),
    cachesReset: keepLedgers ? [] : cacheFiles.filter((name) => existsSync(join(stateDir, name))),
  }

  // Before/after counters come from the same collector the debug panel uses, so
  // "did it reach zero?" is answered by the tool, not by this script's own maths.
  const before = collectDebugStatus({
    section: 'locks',
    settings: { modelDrivenGraftAtRatio: 0.7, autoGraftAtRatio: 0.75, contextWindowTokens: 0 },
    locks: scanAndReclaimLocks([stateDir], true),
    retired: ledgerArray(join(stateDir, '.retired.json')),
    transferred: Object.entries(ledgerRecord(join(stateDir, '.transferred.json'))).map(([id, value]) => ({ id, newSessionId: value?.newSessionId, at: value?.at })),
    targets: Object.entries(readJson(join(stateDir, '.graft-targets.json'), {})).map(([id, mark]) => ({ id, generation: Number(mark?.generation ?? 1), sourceSessionId: String(mark?.sourceSessionId ?? ''), createdAt: Number(mark?.createdAt ?? 0) })),
  })

  if (!apply) {
    process.stdout.write(
      [
        'DRY RUN — nothing was moved. Add --apply to quarantine.',
        `state dir      : ${stateDir}`,
        `cache root     : ${cacheRoot}`,
        `live sessions  : ${live.size}`,
        `cache entries  : ${entries.length} (ghosts: ${ghosts.length})`,
        `quarantine dir : ${quarantine}`,
        `ledgers to reset : ${plan.ledgersReset.join(', ') || '(none)'}`,
        `caches to reset  : ${plan.cachesReset.join(', ') || '(none)'}`,
        `retired now    : ${before.transactions.retiredCount}`,
        `targets now    : ${before.transactions.graftTargetsCount}`,
        '',
      ].join('\n'),
    )
    return
  }

  mkdirSync(quarantine, { recursive: true })
  const manifest = { at: new Date().toISOString(), stateDir, cacheRoot, quarantine, liveSessions: [...live], moved: [], reset: [], shadowed: [] }

  // 1. derived state -> quarantine, then reset.
  for (const name of [...plan.ledgersReset, ...plan.cachesReset]) {
    const from = join(stateDir, name)
    const to = join(quarantine, `state-${name}`)
    moveFile(from, to)
    manifest.moved.push({ from, to, bytes: statSync(to).size, sha256: sha256(to) })
    const empty = name === '.transferred.json' || name === '.graft-targets.json' ? '{}\n' : '[]\n'
    const written = name === '.retired.json' || name === '.transferred.json' ? emptyLedgerText(name) : empty
    writeFileSync(from, written, 'utf8')
    manifest.reset.push({ path: from, written: written.trim() })
  }

  // 2. ghost cache entries -> quarantine.
  for (const name of ghosts) {
    const from = join(cacheRoot, name)
    const to = join(quarantine, 'projcache', name)
    moveFile(from, to)
    manifest.moved.push({ from, to, bytes: statSync(to).size, sha256: sha256(to) })
  }

  writeFileSync(join(quarantine, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  writeFileSync(
    join(quarantine, 'restore.ps1'),
    [
      '# Restore everything this run quarantined. Run from any directory.',
      '$ErrorActionPreference = "Stop"',
      `$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'MANIFEST.json') -Raw | ConvertFrom-Json`,
      'foreach ($item in $manifest.moved) {',
      '  $target = $item.from',
      '  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null',
      '  Move-Item -LiteralPath $item.to -Destination $target -Force',
      '  Write-Host "restored $target"',
      '}',
      'Write-Host "done: $($manifest.moved.Count) file(s) restored"',
      '',
    ].join('\n'),
    'utf8',
  )

  const after = collectDebugStatus({
    section: 'locks',
    settings: { modelDrivenGraftAtRatio: 0.7, autoGraftAtRatio: 0.75, contextWindowTokens: 0 },
    locks: [],
    retired: ledgerArray(join(stateDir, '.retired.json')),
    transferred: Object.entries(ledgerRecord(join(stateDir, '.transferred.json'))).map(([id, value]) => ({ id, newSessionId: value?.newSessionId, at: value?.at })),
    targets: Object.entries(readJson(join(stateDir, '.graft-targets.json'), {})).map(([id, mark]) => ({ id, generation: Number(mark?.generation ?? 1), sourceSessionId: String(mark?.sourceSessionId ?? ''), createdAt: Number(mark?.createdAt ?? 0) })),
  })
  // The memory panel is asked for separately: `collectDebugStatus` only fills the
  // panels its `section` names, and asking for `all` would also re-read the locks.
  const memory = collectMemoryStoreStatus(memoryDir, join(homedir(), '.agents', 'skills'))

  process.stdout.write(
    [
      `quarantined ${manifest.moved.length} file(s) -> ${quarantine}`,
      `restore with : pwsh -File "${join(quarantine, 'restore.ps1')}"`,
      `retired : ${before.transactions.retiredCount} -> ${after.transactions.retiredCount}`,
      `targets : ${before.transactions.graftTargetsCount} -> ${after.transactions.graftTargetsCount}`,
      `cache entries left : ${(() => { try { return readdirSync(cacheRoot).filter((n) => n.endsWith('.json')).length } catch { return 0 } })()}`,
      `memory skills/negatives : ${memory.counts?.skills ?? '?'}/${memory.counts?.negatives ?? '?'}`,
      '',
    ].join('\n'),
  )
}

void PLUGIN_DIR
void collectMemoryStoreStatus
main()
