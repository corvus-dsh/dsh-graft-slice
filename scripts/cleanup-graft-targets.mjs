#!/usr/bin/env node
/**
 * Remove legacy `auto-graft-*` handoff targets from the DSH session store.
 *
 * WHY THIS EXISTS
 *
 * Versions up to 7.3.0 wrote `session/title` events the host's v4 validator
 * rejects, so every target this plugin created was unopenable. 284 of them
 * accumulated in the live store before the defect was found. The cause is fixed
 * in 7.3.1; this script clears the backlog.
 *
 * SAFETY MODEL — read before running
 *
 *   1. DRY RUN BY DEFAULT. Nothing is touched without `--execute`.
 *
 *   2. A CUTOFF IS REQUIRED TO EXECUTE. After 7.3.1 a target is a legitimate,
 *      openable session, and it has the same `auto-graft-` prefix. Running a
 *      blanket delete after creating a new target to verify the fix would destroy
 *      exactly the session you just checked. So `--execute` demands either
 *      `--before <ISO>` (delete only targets older than that instant) or `--all`
 *      (delete every target, including new ones).
 *
 *   3. QUARANTINE, NOT DELETION. The default execute mode MOVES each session
 *      directory into a quarantine folder, so the operation is reversible by
 *      moving it back. `--purge` deletes outright instead.
 *
 *   4. ONLY `auto-graft-` PREFIXES ARE EVER TOUCHED. The filter is applied to the
 *      directory name before anything else, and asserted again before removal.
 *
 *   5. REFERENCES ARE CHECKED, NOT ASSUMED. The script greps `workspace.json`
 *      and the plugin's own state files for each candidate id, reports what it
 *      finds, and removes only what references a session it is actually removing.
 *
 * USAGE
 *
 *   node scripts/cleanup-graft-targets.mjs
 *       dry run: list candidates, cutoff guidance, and reference findings
 *
 *   node scripts/cleanup-graft-targets.mjs --execute --before 2026-11-02T14:30:00+08:00
 *       move every target created before that instant into quarantine
 *
 *   node scripts/cleanup-graft-targets.mjs --execute --all
 *       move every target into quarantine
 *
 *   node scripts/cleanup-graft-targets.mjs --execute --before <ISO> --purge
 *       delete instead of quarantine
 *
 * OPTIONS
 *   --execute            actually modify the store (default: dry run)
 *   --before <ISO>       only targets whose mtime is strictly older than this
 *   --all                consider every auto-graft target (overrides --before)
 *   --purge              delete instead of moving to quarantine
 *   --sessions <dir>     session root (default: $DSH_HOME/sessions)
 *   --data-dir <dir>     plugin state dir holding .retired/.transferred json
 *   --json               emit a machine-readable summary
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const TARGET_PREFIX = 'auto-graft-'
const LOG_NAME = 'session.v4.jsonl.zstd'

function parseArgs(argv) {
  const out = { execute: false, before: undefined, all: false, purge: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--execute') out.execute = true
    else if (arg === '--all') out.all = true
    else if (arg === '--purge') out.purge = true
    else if (arg === '--json') out.json = true
    else if (arg === '--before') out.before = argv[++i]
    else if (arg === '--sessions') out.sessions = argv[++i]
    else if (arg === '--data-dir') out.dataDir = argv[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

/** Every `sessions/<workspace>/` root, without hardcoding a workspace hash. */
function sessionRoots(base) {
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name))
}

/**
 * The session's TRUE creation time, read from the log header.
 *
 * File mtime is NOT usable as a cutoff here: repairing the 284 corrupt titles
 * rewrote every log, so all 284 mtimes collapsed to the repair instant. The
 * header's `createdAt` was untouched by that repair and is the real timestamp.
 *
 * Frames are walked from the front; the header is in the first frame, so this
 * decompresses one frame rather than the whole log.
 */
function sessionCreatedAt(logPath) {
  try {
    const buffer = readFileSync(logPath)
    const ZSTD_MAGIC = 0xfd2fb528
    if (buffer.length < 5 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return undefined
    let offset = 4
    const descriptor = buffer[offset]
    offset += 1
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryIdFlag = descriptor & 3
    if (singleSegment === 0) offset += 1
    offset += [0, 1, 2, 4][dictionaryIdFlag]
    offset += contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8
    for (;;) {
      const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
      offset += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >>> 3
      if (type === 0) offset += size
      else if (type === 1) offset += 1
      else if (type === 2) offset += size
      if (last === 1) break
    }
    if (checksum === 1) offset += 4
    const text = zstdDecompressSync(buffer.subarray(0, offset)).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      if (record.type !== 'session') continue
      const created = Number(record.createdAt)
      if (Number.isFinite(created) && created > 0) return created
    }
  } catch {
    // Fall through: an unreadable header means we fall back to mtime.
  }
  return undefined
}

/**
 * Candidates: directories whose NAME starts with the prefix AND that contain a
 * session log. The name check happens first and is re-asserted at removal time.
 */
function collectCandidates(roots) {
  const found = []
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith(TARGET_PREFIX)) continue
      const dir = join(root, entry.name)
      const log = join(dir, LOG_NAME)
      if (!existsSync(log)) continue
      const stat = statSync(log)
      const createdAt = sessionCreatedAt(log)
      found.push({
        id: entry.name,
        dir,
        log,
        // `createdAt` is authoritative; mtime is only a fallback for a log whose
        // header could not be read.
        createdAt: createdAt ?? stat.mtimeMs,
        mtime: stat.mtimeMs,
        bytes: stat.size,
      })
    }
  }
  return found.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Does anything outside the session directory reference these ids?
 *
 * Verified on the live store: nothing does — DSH discovers sessions by scanning
 * the directory, and no registry, workspace row, or projection cache lists a
 * target. The check still runs, because "we looked and found nothing" is a much
 * stronger statement than "we assumed there was nothing".
 */
function findReferences(candidates, options) {
  const ids = new Set(candidates.map((candidate) => candidate.id))
  const findings = []

  const workspaceFile = join(homedir(), '.dsh', 'storages', 'workspace.json')
  if (existsSync(workspaceFile)) {
    const text = readFileSync(workspaceFile, 'utf8')
    let matched = 0
    for (const id of ids) if (text.includes(id)) matched += 1
    findings.push({ path: workspaceFile, kind: 'workspace-registry', matched })
  }

  for (const name of ['.transferred.json', '.retired.json', '.graft-targets.json', '.graft-constraint-sections.json']) {
    const path = join(options.dataDir, name)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    let matched = 0
    for (const id of ids) if (text.includes(id)) matched += 1
    findings.push({ path, kind: 'plugin-state', matched })
  }

  const projectionDir = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
  if (existsSync(projectionDir)) {
    let matched = 0
    for (const file of readdirSync(projectionDir)) {
      for (const id of ids) {
        if (file.includes(id)) { matched += 1; break }
      }
    }
    findings.push({ path: projectionDir, kind: 'projection-cache', matched })
  }

  return findings
}

/**
 * Strip references to removed ids from the plugin's own state files.
 *
 * Written atomically (temp + rename) for the same reason the plugin does it: a
 * crash mid-write would leave a JSON file that parses to nothing, and an empty
 * retired set silently un-retires sessions.
 */
function cleanPluginState(ids, options, log) {
  const changes = []
  const transferred = join(options.dataDir, '.transferred.json')
  if (existsSync(transferred)) {
    const parsed = JSON.parse(readFileSync(transferred, 'utf8'))
    const before = Object.keys(parsed).length
    for (const id of ids) delete parsed[id]
    const after = Object.keys(parsed).length
    if (after !== before) {
      if (options.execute) writeJsonAtomic(transferred, parsed)
      changes.push({ path: transferred, removed: before - after })
    }
  }
  const retired = join(options.dataDir, '.retired.json')
  if (existsSync(retired)) {
    const parsed = JSON.parse(readFileSync(retired, 'utf8'))
    if (Array.isArray(parsed)) {
      const kept = parsed.filter((id) => !ids.has(String(id)))
      if (kept.length !== parsed.length) {
        if (options.execute) writeJsonAtomic(retired, kept)
        changes.push({ path: retired, removed: parsed.length - kept.length })
      }
    }
  }
  for (const change of changes) log(`  ${change.path}: removed ${change.removed} reference(s)`)
  return changes
}

function writeJsonAtomic(path, value) {
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const lines = []
  const log = (line) => {
    lines.push(line)
    if (!options.json) process.stdout.write(`${line}\n`)
  }

  if (options.help) {
    log('usage: node scripts/cleanup-graft-targets.mjs [--execute --before <ISO>|--all] [--purge] [--json]')
    return { ok: true }
  }

  const sessionBase = options.sessions ?? join(homedir(), '.dsh', 'sessions')
  options.dataDir = options.dataDir ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'data', 'dsh-graft-slice')

  const roots = sessionRoots(sessionBase)
  const all = collectCandidates(roots)
  log(`session store : ${sessionBase}`)
  log(`workspace dirs: ${roots.length}`)
  log(`auto-graft targets found: ${all.length}`)
  if (all.length === 0) return { ok: true, candidates: 0, removed: 0 }

  const oldest = new Date(all[0].createdAt).toISOString()
  const newest = new Date(all[all.length - 1].createdAt).toISOString()
  log(`  oldest (header createdAt): ${oldest}`)
  log(`  newest (header createdAt): ${newest}`)
  const repairInstant = Math.max(...all.map((candidate) => candidate.mtime))
  log(`  newest file mtime        : ${new Date(repairInstant).toISOString()}`)
  log('  cutoff uses the header timestamp; the earlier repair rewrote every file,')
  log('  so mtimes all collapsed to the repair instant and are not usable here.')

  // Which subset is actually in scope?
  let selected = all
  if (options.before !== undefined && !options.all) {
    const cutoff = Date.parse(options.before)
    if (!Number.isFinite(cutoff)) throw new Error(`--before is not a parseable instant: ${options.before}`)
    selected = all.filter((candidate) => candidate.createdAt < cutoff)
    log(`  cutoff ${new Date(cutoff).toISOString()} → ${selected.length} in scope (${all.length - selected.length} protected)`)
  } else if (!options.all) {
    selected = []
    log('  no --before / --all given: nothing is in scope')
  } else {
    log('  --all: every target is in scope')
  }

  const findings = findReferences(selected, options)
  log('')
  log('external references to the selected ids:')
  for (const finding of findings) {
    log(`  ${finding.matched === 0 ? 'none' : `${finding.matched} id(s)`}  in  ${finding.path}`)
  }

  if (!options.execute) {
    log('')
    log('DRY RUN — nothing was modified.')
    log('To proceed, re-run with --execute plus a bound, for example:')
    log(`  node scripts/cleanup-graft-targets.mjs --execute --before ${newest}`)
    log('That bound removes every target created up to the newest one listed above,')
    log('which keeps any target you create AFTER the fix out of scope.')
    return { ok: true, dryRun: true, candidates: all.length, inScope: selected.length, findings }
  }

  if (selected.length === 0) {
    log('')
    log('Nothing in scope; nothing to do.')
    return { ok: true, removed: 0 }
  }

  const quarantine = join(sessionBase, '..', '_quarantine-graft-targets', new Date().toISOString().replace(/[:.]/gu, '-'))
  if (!options.purge) mkdirSync(quarantine, { recursive: true })

  let removed = 0
  let bytes = 0
  const failures = []
  for (const candidate of selected) {
    try {
      // Re-assert the only invariant that matters before destroying anything.
      if (!basename(candidate.dir).startsWith(TARGET_PREFIX)) {
        throw new Error('refusing to remove a directory that is not an auto-graft target')
      }
      if (options.purge) {
        rmSync(candidate.dir, { recursive: true, force: true })
      } else {
        renameSync(candidate.dir, join(quarantine, basename(candidate.dir)))
      }
      removed += 1
      bytes += candidate.bytes
    } catch (error) {
      failures.push({ id: candidate.id, error: String(error?.message ?? error) })
    }
  }

  const ids = new Set(selected.map((candidate) => candidate.id))
  log('')
  log(`removed ${removed} of ${selected.length} selected target(s) (${(bytes / 1024 / 1024).toFixed(2)} MB of logs)`)
  log(options.purge ? '  mode: purged (not recoverable)' : `  mode: quarantined → ${quarantine}`)
  if (failures.length > 0) {
    log(`  failures: ${failures.length}`)
    for (const failure of failures.slice(0, 5)) log(`    ${failure.id}: ${failure.error}`)
  }
  cleanPluginState(ids, options, log)

  // Post-condition: the store must contain no auto-graft target older than the cutoff.
  const remaining = collectCandidates(sessionRoots(sessionBase))
  const cutoffValue = options.before ? Date.parse(options.before) : Infinity
  const kept = remaining.filter((candidate) => candidate.createdAt < cutoffValue)
  log('')
  log(`remaining auto-graft targets: ${remaining.length}`)
  log(`  older than the cutoff still present: ${kept.length} (expected 0)`)
  if (kept.length > 0) log('  WARNING: some in-scope targets survived; inspect the failures above.')

  return { ok: failures.length === 0, removed, failures, remaining: remaining.length, quarantine: options.purge ? undefined : quarantine }
}

main()
