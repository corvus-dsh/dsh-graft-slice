#!/usr/bin/env node
/**
 * v0.14 `graft_debug_status` from the shell.
 *
 * Same three panels as the agent tool, without a live host:
 *
 *   1. watermark  — token usage of a session log, and the distance to the 70%
 *                   nudge and the 75% hard cutoff;
 *   2. locks      — state locks (with owner pid and liveness), unfinished `.txn`
 *                   migrations, retired / transferred counts;
 *   3. memory     — skills / negatives / facts / experiences, and with
 *                   `--workspace`, the records the isolation gate would REFUSE.
 *
 * Read-only: the lock sweep runs in dryRun, and nothing is written.
 *
 * Usage:
 *   node scripts/debug-status.mjs [--data <dir>] [--memory <dir>] [--skills <dir>]
 *                                 [--session <sessionId>] [--workspace <path>]
 *                                 [--section all|watermark|locks|memory] [--json]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { collectDebugStatus, scanAndReclaimLocks, collectMemoryStoreStatus } from '../index.js'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

function parseArgs(argv) {
  const out = { section: 'all' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      out[key] = true
      continue
    }
    out[key] = value
    index += 1
  }
  return out
}

/** The same resolution order `configureRetiredStore` uses, minus the live ctx. */
function resolveStateDir(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return { dir: explicit, scope: '--data' }
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    return { dir: join(profileDir, 'data', 'dsh-graft-slice'), scope: 'DSH_PROFILE_DIR' }
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) {
    const suffix = process.platform === 'win32' ? ['profiles', process.env.DSH_PROFILE ?? 'desktop'] : []
    return { dir: join(home, ...suffix, 'data', 'dsh-graft-slice'), scope: 'DSH_HOME' }
  }
  return { dir: PLUGIN_DIR, scope: 'plugin-dir' }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * The watermark from a session log, without a live host.
 *
 * Provider usage is real data: the last `assistant/message` reports what the
 * request actually cost. The context window comes from the last `request/context`.
 * When either is missing this returns undefined rather than inventing a number —
 * an estimated watermark that disagrees with the host's meter is worse than none.
 */
export function watermarkFromLog(log, contextWindowOverride = 0) {
  let contextWindow = 0
  let usageTokens = 0
  for (const event of log?.events ?? []) {
    if (event?.type === 'request/context') {
      const window = Number(event.data?.contextWindow)
      if (Number.isFinite(window) && window > 0) contextWindow = window
      continue
    }
    if (event?.type === 'assistant/message') {
      const usage = event.data?.usage
      const candidate =
        typeof usage?.inputTokens === 'number' ? usage.inputTokens : typeof usage?.totalTokens === 'number' ? usage.totalTokens : 0
      if (candidate > 0) usageTokens = candidate
    }
  }
  const effective = contextWindowOverride > 0 ? contextWindowOverride : contextWindow
  if (usageTokens > 0 && effective > 0) {
    return { tokens: usageTokens, contextWindow: effective, ratio: usageTokens / effective, source: 'usage' }
  }
  return undefined
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const state = resolveStateDir(args.data)
  const memoryDir = typeof args.memory === 'string' && args.memory.length > 0 ? args.memory : join(state.dir, '.dsh-memory')
  const skillsDir = typeof args.skills === 'string' && args.skills.length > 0 ? args.skills : join(homedir(), '.agents', 'skills')

  const locks = scanAndReclaimLocks([state.dir], true)
  const retired = readJson(join(state.dir, '.retired.json'), [])
  const transferred = readJson(join(state.dir, '.transferred.json'), {})
  const targets = readJson(join(state.dir, '.graft-targets.json'), {})
  const txns = (() => {
    try {
      const names = readdirSafe(join(state.dir, '.txn'))
      return names
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const record = readJson(join(state.dir, '.txn', name), {})
          return { name, ...record }
        })
    } catch {
      return []
    }
  })()

  let watermark
  if (typeof args.session === 'string' && args.session.length > 0) {
    const { findSessionFile, readSessionLogFile } = await import('./read-session-log.mjs')
    const file = args.session.endsWith('.jsonl') || args.session.endsWith('.zstd') ? args.session : findSessionFile(args.session)
    watermark = watermarkFromLog(readSessionLogFile(file), Number(args['context-window']) || 0)
  }

  const status = collectDebugStatus({
    section: typeof args.section === 'string' ? args.section : 'all',
    settings: {
      modelDrivenGraftAtRatio: Number(args.warn) || 0.7,
      autoGraftAtRatio: Number(args.hard) || 0.75,
      contextWindowTokens: Number(args['context-window']) || 0,
    },
    ...(watermark === undefined ? {} : { watermark }),
    locks,
    retired: Array.isArray(retired) ? retired : [],
    transferred: Object.entries(transferred).map(([id, value]) => ({
      id,
      newSessionId: value?.newSessionId,
      at: value?.at,
    })),
    targets: Object.entries(targets).map(([id, mark]) => ({
      id,
      generation: Number(mark?.generation ?? 1),
      sourceSessionId: String(mark?.sourceSessionId ?? ''),
      createdAt: Number(mark?.createdAt ?? 0),
    })),
    txns,
    memory: { memoryDir, skillsDir },
    ...(typeof args.workspace === 'string' ? { workspace: args.workspace } : {}),
  })

  status.paths = { stateDir: state.dir, scope: state.scope, memoryDir, skillsDir }
  status.memory = collectMemoryStoreStatus(memoryDir, skillsDir, typeof args.workspace === 'string' ? args.workspace : undefined)

  if (args.json === true) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n')
    return
  }
  renderHuman(status, state)
}

function readdirSafe(path) {
  return readdirSync(path)
}

function renderHuman(status, state) {
  const lines = []
  lines.push('=== dsh-graft-slice debug status ===')
  lines.push(`state dir : ${state.dir} (${state.scope})`)
  const watermark = status.watermark
  if (watermark?.available === false) {
    lines.push(`watermark : unavailable — ${watermark.reason}`)
  } else {
    lines.push(
      `watermark : ${watermark.percent}% (${watermark.tokens}/${watermark.contextWindow}, ${watermark.source}) ` +
        `| warn ${watermark.warnAt} in ${watermark.toWarnTokens} tok | hard ${watermark.hardAt} in ${watermark.toHardTokens} tok | ${watermark.state}`,
    )
  }
  const locks = status.locks
  lines.push(`locks     : ${locks.held.length} present${locks.held.length === 0 ? '' : ' -> ' + locks.held.map((entry) => `${entry.label}(pid=${entry.pid ?? '?'},alive=${entry.alive ?? '?'})`).join(', ')}`)
  if (locks.reclaimedAtActivation.length > 0) lines.push(`            reclaimed at activation: ${locks.reclaimedAtActivation.join(', ')}`)
  const transactions = status.transactions
  lines.push(`txn       : ${transactions.pending.length} unfinished${transactions.pending.length === 0 ? '' : ' -> ' + transactions.pending.map((txn) => `${txn.name}:${txn.state ?? '?'}`).join(', ')}`)
  lines.push(`retired   : ${transactions.retiredCount} session(s)`)
  lines.push(`targets   : ${transactions.graftTargetsCount} graft target(s)`)
  const memory = status.memory
  if (memory.available === false) {
    lines.push(`memory    : unavailable — ${memory.reason}`)
  } else {
    lines.push(
      `memory    : ${memory.counts.skills} skill(s), ${memory.counts.negatives} negative(s), ${memory.counts.facts} fact(s), ` +
        `${memory.counts.experiences} experience(s), ${memory.counts.suggestions} queued`,
    )
    if (memory.workspace !== undefined) {
      lines.push(
        `  workspace ${memory.workspace}: skills ${memory.skillsInWorkspace.matched} ok / ${memory.skillsInWorkspace.dirty} dirty` +
          ` (unscoped ${memory.skillsInWorkspace.unscoped}); negatives ${memory.negativeRecords.matched} ok / ` +
          `${memory.negativeRecords.foreign} foreign / ${memory.negativeRecords.unscoped} unscoped`,
      )
      for (const item of [...memory.skillsInWorkspace.dirtyList, ...memory.negativeRecords.dirty]) {
        lines.push(`    - ${item.name ?? item.kind}: ${item.reason} :: ${String(item.text ?? '').slice(0, 60)}`)
      }
    }
  }
  process.stdout.write(lines.join('\n') + '\n')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    process.exitCode = 1
  })
}
