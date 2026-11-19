#!/usr/bin/env node
/**
 * ── W0 (B4-0b-2): MEASURE THE PER-STEP TOKEN JUMP. NO BEHAVIOUR CHANGE. ─────────────────────────
 *
 * Dispatch §12.5 exists because the FIRST run of this measurement lived in a temp directory and never
 * entered any repository: the numbers went into a report, and the next generation could read the
 * conclusion but not re-run it. 「没有可复跑物，数字就只是声称」. This file is the re-runnable artifact.
 *
 * WHAT IT READS
 *
 * The real session store, through `read-session-log.mjs` — THIS repo's own reader. (The first version
 * shelled out to `dsh-memory/lib/zstd.js` via a spawned node process; that made the probe depend on a
 * sibling checkout, which is a dependency on "my machine", not on this repo. The reader is now in-tree
 * and imports nothing.)
 *
 *   · `request/context`     → `data.contextWindow`            (the plugin's denominator)
 *   · `assistant/message`   → `data.usage.inputTokens ?? data.usage.totalTokens`   (the numerator)
 *
 * The delta between two consecutive `assistant/message` usage values is the closest thing the durable
 * log has to "how much did the context grow between two steps": every pre-step follows one model call
 * whose usage is recorded. It is the PROVIDER's prompt-token count, so a step that added a large tool
 * result shows up here as a large delta — which is exactly the quantity the window has to survive.
 *
 * ── THE TWO FALSE NUMBERS, KEPT AS COMMENTS BECAUSE BOTH ARE RECURRING SHAPES ─────────────────────
 *
 * 1. `delta / 0 = Infinity`. The first `countCrossings` looked the window up per entry with
 *    `sessions.find(...)` on a DELTA object — which has no `contextWindow`, so it was `undefined`,
 *    so `x / 0` was `Infinity`, so `Infinity > width` was true for EVERY pair and two different
 *    thresholds reported the SAME number (13,731 of 25,170). Two thresholds agreeing to the digit is
 *    arithmetic, not evidence: the shapes must differ or the filter is broken.
 * 2. `usages.length` stored as a NUMBER. The first version pushed `usages: usages.length` while the
 *    counter iterated `session.usages.length`; `(5).length` is `undefined`, the loop never ran, and
 *    every threshold reported `{crossed: 0, eligible: 0}`. An `eligible: 0` denominator is that bug's
 *    signature — zero crossings out of zero chances is not evidence of anything. Hence: the field
 *    carries the ARRAY, and `eligible` is printed so a zero denominator cannot read as "no crossings".
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/w0-token-jump.mjs                    # uses $DSH_HOME (or ~/.dsh), all workspaces
 *     node scripts/w0-token-jump.mjs --dir <path>       # one workspace's session directory
 *     node scripts/w0-token-jump.mjs --json             # machine-readable
 *     node scripts/w0-token-jump.mjs --exclude-resets   # can-red: drop the reset classification
 *
 * `--exclude-resets` is the can-red for §12.2 layer 2: with reset points folded back into "growth",
 * the measured maximum and p95 must get WORSE (larger). If they do not move, the exclusion is not
 * doing anything and the number it removed was never a reset.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readSessionLogFile } from './read-session-log.mjs'

const args = process.argv.slice(2)
const argOf = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const asJson = args.includes('--json')
const excludeResets = args.includes('--exclude-resets')

/** Event types that mean "the context was replaced, so a jump across them is not growth". */
const RESET_MARKERS = ['compaction', 'compact/', 'context/reset', 'session/restore', 'session/resume', 'plugin:translator']
const isReset = (type) => RESET_MARKERS.some((marker) => String(type ?? '').includes(marker))

function sessionFiles(root) {
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const direct = join(root, entry.name, 'session.v4.jsonl.zstd')
    if (existsSync(direct)) {
      out.push(direct)
      continue
    }
    // `root` is already one workspace dir; one level deeper covers `sessions/<ws>/<id>/…` callers.
    for (const child of readdirSync(join(root, entry.name), { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      const nested = join(root, entry.name, child.name, 'session.v4.jsonl.zstd')
      if (existsSync(nested) && statSync(nested).isFile()) out.push(nested)
    }
  }
  return out
}

const explicit = argOf('--dir')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const root = explicit ?? join(home, 'sessions')
const files = sessionFiles(root)
if (files.length === 0) {
  process.stderr.write(`w0-token-jump: no session logs under ${root}\n`)
  process.stderr.write('  pass --dir <workspace session dir> or set DSH_HOME\n')
  process.exit(2)
}

const sessions = []
let unreadable = 0
for (const file of files) {
  let log
  try {
    log = readSessionLogFile(file)
  } catch {
    unreadable += 1
    continue
  }
  const events = Array.isArray(log?.events) ? log.events : []
  if (events.length === 0) {
    unreadable += 1
    continue
  }
  let contextWindow = 0
  const usages = []
  const resetSeqs = []
  for (const event of events) {
    if (event?.type === 'request/context') {
      const window = Number(event.data?.contextWindow)
      if (Number.isFinite(window) && window > 0) contextWindow = window
      continue
    }
    if (event?.type !== 'assistant/message') {
      if (isReset(event?.type)) resetSeqs.push(Number(event.seq) || 0)
      continue
    }
    const usage = event.data?.usage
    const candidate =
      typeof usage?.inputTokens === 'number'
        ? usage.inputTokens
        : typeof usage?.totalTokens === 'number'
          ? usage.totalTokens
          : 0
    if (candidate > 0) usages.push({ seq: Number(event.seq) || 0, tokens: candidate })
  }
  if (usages.length < 2) continue
  /** `usages` is the ARRAY (false number #2); `deltas` carries the classification, not the raw delta. */
  const deltas = []
  for (let index = 1; index < usages.length; index += 1) {
    const before = usages[index - 1]
    const after = usages[index]
    const crossedReset = excludeResets
      ? false
      : resetSeqs.some((seq) => seq > before.seq && seq <= after.seq)
    const bucket =
      index === 1
        ? 'firstCall'
        : Number.isFinite(contextWindow) && contextWindow > 0 && before.tokens < contextWindow * 0.05
          ? 'shrinkThenGrow'
          : crossedReset
            ? 'afterResetEvent'
            : 'growth'
    deltas.push({
      seq: after.seq,
      delta: after.tokens - before.tokens,
      before: before.tokens,
      after: after.tokens,
      bucket,
      /** Kept so `countCrossings` never has to look a window up per entry (false number #1). */
      window: contextWindow,
    })
  }
  sessions.push({ file, contextWindow, usages, deltas })
}

const quantile = (sorted, q) => {
  if (sorted.length === 0) return undefined
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[index]
}

/** Growth only: the three reset buckets are the 154-of-160 shape, not the thing the window must hold. */
const growthDeltas = sessions.flatMap((session) => session.deltas.filter((d) => d.bucket === 'growth').map((d) => d.delta))
const allDeltas = sessions.flatMap((session) => session.deltas.map((d) => d.delta))
const growthSorted = [...growthDeltas].sort((a, b) => a - b)
const allSorted = [...allDeltas].sort((a, b) => a - b)

const ratioOf = (entry) => (entry.window > 0 ? entry.delta / entry.window : undefined)
const growthRatios = sessions
  .flatMap((session) => session.deltas.filter((d) => d.bucket === 'growth'))
  .map(ratioOf)
  .filter((value) => typeof value === 'number')
  .sort((a, b) => a - b)

/**
 * "One step crossed the whole window": `before < warnAt && after >= hardAt`.
 *
 * BOTH WINDOWS ARE REPORTED because the dispatch's stop condition asks whether 0.03 is FAR too narrow:
 * the conservative 0.03 pair (0.52/0.55, what `compaction-guard` gives when the host threshold is not
 * computable) and a hypothetical 0.10 pair. If the wider one is still crossed, width is not the fix.
 */
function countCrossings(warnAt, hardAt) {
  let crossed = 0
  let eligible = 0
  for (const session of sessions) {
    const window = session.contextWindow
    if (!(Number.isFinite(window) && window > 0)) continue
    for (const entry of session.deltas) {
      eligible += 1
      if (entry.before / window < warnAt && entry.after / window >= hardAt) crossed += 1
    }
  }
  return { crossed, eligible }
}

const windows = [...new Set(sessions.map((session) => session.contextWindow).filter((value) => value > 0))]
const maxGrowth = sessions.flatMap((session) =>
  session.deltas.filter((d) => d.bucket === 'growth' && d.window > 0).map((d) => ({ ...d, ratio: d.delta / d.window })),
)
maxGrowth.sort((a, b) => b.ratio - a.ratio)

const summary = {
  root,
  sessionsScanned: files.length,
  sessionsWithSequence: sessions.length,
  unreadableFrames: unreadable,
  contextWindows: windows,
  resetExclusion: excludeResets ? 'OFF (can-red)' : 'ON',
  samples: allDeltas.length,
  buckets: {
    growth: sessions.flatMap((s) => s.deltas).filter((d) => d.bucket === 'growth').length,
    firstCall: sessions.flatMap((s) => s.deltas).filter((d) => d.bucket === 'firstCall').length,
    shrinkThenGrow: sessions.flatMap((s) => s.deltas).filter((d) => d.bucket === 'shrinkThenGrow').length,
    afterResetEvent: sessions.flatMap((s) => s.deltas).filter((d) => d.bucket === 'afterResetEvent').length,
  },
  deltaTokens: {
    allMax: allSorted.at(-1),
    allP95: quantile(allSorted, 0.95),
    growthMax: growthSorted.at(-1),
    growthP95: quantile(growthSorted, 0.95),
    growthMedian: quantile(growthSorted, 0.5),
  },
  deltaRatio: {
    growthMax: growthRatios.at(-1),
    growthP95: quantile(growthRatios, 0.95),
  },
  crossesWindow: {
    conservative003: countCrossings(0.52, 0.55),
    hypothetical010: countCrossings(0.50, 0.6),
    nominal005: countCrossings(0.7, 0.75),
  },
  topGrowth: maxGrowth.slice(0, 8).map((entry) => ({
    seq: entry.seq,
    deltaTokens: entry.delta,
    ratio: Number(entry.ratio.toFixed(4)),
    before: entry.before,
    after: entry.after,
  })),
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
} else {
  const lines = [
    `root                 ${summary.root}`,
    `sessions             ${summary.sessionsWithSequence} with a sequence (${summary.sessionsScanned} scanned, ${summary.unreadableFrames} unreadable)`,
    `windows              ${JSON.stringify(summary.contextWindows)}`,
    `reset exclusion      ${summary.resetExclusion}`,
    `deltas               ${summary.samples}  (growth ${summary.buckets.growth} / firstCall ${summary.buckets.firstCall} / shrinkThenGrow ${summary.buckets.shrinkThenGrow} / afterReset ${summary.buckets.afterResetEvent})`,
    `growth tokens        max ${summary.deltaTokens.growthMax}  p95 ${summary.deltaTokens.growthP95}  median ${summary.deltaTokens.growthMedian}`,
    `growth ratio         max ${summary.deltaRatio.growthMax?.toFixed(4)}  p95 ${summary.deltaRatio.growthP95?.toFixed(4)}`,
    `crossings @0.52/0.55 ${summary.crossesWindow.conservative003.crossed} of ${summary.crossesWindow.conservative003.eligible}`,
    `crossings @0.50/0.60 ${summary.crossesWindow.hypothetical010.crossed} of ${summary.crossesWindow.hypothetical010.eligible}`,
    `crossings @0.70/0.75 ${summary.crossesWindow.nominal005.crossed} of ${summary.crossesWindow.nominal005.eligible}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}
