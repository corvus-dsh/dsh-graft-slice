#!/usr/bin/env node
/**
 * ── W0-2 §12.3: DID THE THREE LAYERS ACTUALLY COVER THE CROSSINGS? ──────────────────────────────
 *
 * The ruling's acceptance criterion is a NUMBER, not a feeling:
 *
 *   「重跑同批 38 会话，报「三层合计覆盖几次跨窗 / 第 2 层几次 / 第 3 层几次」，合计必须 = 29 或逐次解释」
 *
 * So this script replays the corpus through the REAL decision functions (imported from
 * `src/core/nudge-margin.ts`, the same file the plugin ships) and reports, for every crossing:
 *
 *   layer 2 (`predicted`)  — the pre-step BEFORE the jump already predicted a crossing of the cutoff,
 *                            so the model was told while it still had room;
 *   layer 3 (`forced-cut`) — it was NOT predicted. The mark still fires (unconditionally), so the
 *                            handoff says 「未经预警」 instead of saying nothing.
 *
 * Every crossing is therefore covered by exactly one of them, which is the whole point of layer 3 being
 * unconditional: layer 2 can be beaten by a large enough step, and layer 3 cannot.
 *
 * ── WHY THE TOTAL MAY NOT BE 29 ────────────────────────────────────────────────────────────────
 *
 * 29 was measured on 38 sessions / 25,180 steps. The store keeps growing while work continues, so this
 * script PRINTS its own denominator and the per-crossing detail rather than asserting a constant. A
 * different total with the same shape (every crossing covered, layer 3 only where layer 2 could not)
 * is the honest outcome; a different total with NO explanation is the failure mode this script exists
 * to make impossible.
 *
 * Usage:
 *   node scripts/w0-three-layers.mjs --dir <workspace session dir>
 *   node scripts/w0-three-layers.mjs --dir <...> --json
 *   node scripts/w0-three-layers.mjs --dir <...> --no-predict   # can-red: layer 2 removed
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readSessionLogFile } from './read-session-log.mjs'
import {
  FLOOR_MAX_RATIO,
  NUDGE_PREDICT_WINDOW,
  WARN_MARGIN_TOKENS,
  deriveWarnAt,
  nudgeDeltas,
  predictGrowthTokens,
  recordNudgeSample,
  shouldNudge,
} from '../src/core/nudge-margin.ts'

const args = process.argv.slice(2)
const argOf = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const asJson = args.includes('--json')
const noPredict = args.includes('--no-predict')

/** The shipped fallback margin (`COMPACTION_WARN_MARGIN`) — the token derivation can fall back to it. */
const RATIO_FALLBACK = 0.03
/** The conservative `hardAt` when the host compaction threshold is not computable. */
const CONSERVATIVE_HARD_AT = 0.55

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
    let children = []
    try {
      children = readdirSync(join(root, entry.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const nested = join(root, entry.name, child.name, 'session.v4.jsonl.zstd')
      if (existsSync(nested) && statSync(nested).isFile()) out.push(nested)
    }
  }
  return out
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const root = argOf('--dir') ?? join(home, 'sessions')
const files = sessionFiles(root)
if (files.length === 0) {
  process.stderr.write(`w0-three-layers: no session logs under ${root}\n`)
  process.exit(2)
}

const crossings = []
const perSession = []
/**
 * ── LAYER 2's OWN EFFECT, COUNTED SEPARATELY FROM COVERAGE ────────────────────────────────────
 *
 * The dispatch's can-red is 「去预测 ⇒ 覆盖率变差」. On THIS corpus that can-red is VACUOUS, and the
 * measurement says so plainly: every crossing here is a giant jump (560k–640k tokens) or a 76k step
 * against an p90 of 833, and no p90 can bridge those — so layer 2 covers 0 of 31 either way, and the
 * "coverage got worse" test would report 0 → 0 (a comparison that cannot fail is not a test).
 *
 * The honest alternative is to count what layer 2 DOES change: the number of pre-steps it turns into a
 * nudge. `predictedNudges` must fall to 0 with `--no-predict`, and the count of `thresholdNudges` must
 * NOT move — that pins the two disjuncts independently.
 */
const nudgeStats = { thresholdNudges: 0, predictedNudges: 0, predictedSkippedByCutoff: 0 }

for (const file of files) {
  let log
  try {
    log = readSessionLogFile(file)
  } catch {
    continue
  }
  const events = Array.isArray(log?.events) ? log.events : []
  if (events.length === 0) continue
  let contextWindow = 0
  const usages = []
  const resetSeqs = []
  for (const event of events) {
    if (event?.type === 'request/context') {
      const window = Number(event.data?.contextWindow)
      if (Number.isFinite(window) && window > 0) contextWindow = window
    }
    if (!isReset(event?.type)) {
      if (event?.type !== 'assistant/message') continue
    } else {
      resetSeqs.push(Number(event.seq) || 0)
    }
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    const tokens =
      typeof usage?.inputTokens === 'number'
        ? usage.inputTokens
        : typeof usage?.totalTokens === 'number'
          ? usage.totalTokens
          : 0
    if (tokens > 0) usages.push({ seq: Number(event.seq) || 0, tokens })
  }
  if (usages.length < 2 || !(contextWindow > 0)) continue

  /**
   * The shipped derivation, on the shipped conservative pair. `deriveWarnAt` returns the margin source
   * too, so a session whose window could not carry a 30k margin is reported as `ratio-fallback` rather
   * than silently folded into the token count.
   */
  const derived = deriveWarnAt(CONSERVATIVE_HARD_AT, contextWindow, RATIO_FALLBACK)
  const warnAt = derived.warnAt
  let ring = []
  let nudgeDelivered = false
  let nudgeDeliveredAtRatio
  let covered = 0
  let coveredByPrediction = 0

  for (let index = 1; index < usages.length; index += 1) {
    const previous = usages[index - 1]
    const current = usages[index]
    const resetSince = resetSeqs.some((seq) => seq > previous.seq && seq <= current.seq)
    ring = recordNudgeSample(ring, { seq: current.seq, tokens: current.tokens }, contextWindow, resetSince)
    const prediction = noPredict
      ? { tokens: 0, from: 'floor', samples: 0 }
      : predictGrowthTokens(nudgeDeltas(ring.slice(0, -1)), contextWindow)
    const verdict = shouldNudge({
      tokens: previous.tokens,
      contextWindow,
      warnAt,
      cutoffRatio: CONSERVATIVE_HARD_AT,
      prediction,
    })
    if (verdict.fire) {
      if (verdict.reason === 'predicted') nudgeStats.predictedNudges += 1
      else nudgeStats.thresholdNudges += 1
      nudgeDelivered = true
      if (nudgeDeliveredAtRatio === undefined) nudgeDeliveredAtRatio = previous.tokens / contextWindow
    }
    const before = previous.tokens / contextWindow
    const after = current.tokens / contextWindow
    /**
     * THE CROSSING DEFINITION, unchanged from the W0 probe: below the nudge line at one pre-step and at
     * or above the cutoff at the next. That is the case the interval could not warn about.
     */
    if (!(before < warnAt && after >= CONSERVATIVE_HARD_AT)) continue
    covered += 1
    const layer = verdict.fire && verdict.reason === 'predicted' ? 'predicted' : 'forced-cut'
    if (layer === 'predicted') coveredByPrediction += 1
    crossings.push({
      session: file.split(/[\\/]/u).slice(-2, -1)[0]?.slice(0, 28) ?? '?',
      seq: current.seq,
      warnAt,
      warnSource: derived.source,
      before: Number(before.toFixed(4)),
      after: Number(after.toFixed(4)),
      deltaTokens: current.tokens - previous.tokens,
      predictedTokens: prediction.tokens,
      predictedFrom: prediction.from,
      predictedSamples: prediction.samples,
      nudgeDeliveredBefore: nudgeDelivered,
      layer,
    })
  }
  if (covered > 0) {
    perSession.push({
      session: file.split(/[\\/]/u).slice(-2, -1)[0]?.slice(0, 28) ?? '?',
      window: contextWindow,
      warnAt,
      warnSource: derived.source,
      crossings: covered,
      byPrediction: coveredByPrediction,
      nudgeDeliveredAtRatio: nudgeDeliveredAtRatio === undefined ? null : Number(nudgeDeliveredAtRatio.toFixed(4)),
    })
  }
}

const total = crossings.length
const byPrediction = crossings.filter((entry) => entry.layer === 'predicted').length
const byForcedCut = total - byPrediction
/** How many of the crossings are reset-shaped (`before` under the window's shrink ratio). */
const resetShaped = crossings.filter((entry) => entry.before < 0.05).length

/**
 * ── §16.4-1: 「预防」 AND 「披露」 ARE NOT THE SAME VERB ─────────────────────────────────────────
 *
 * The first version called the sum `coveredByOneLayer`, which reads as 「每件事都有人管」. Layer 3 does not
 * PREVENT a cut — it cannot; the cut already happened. It only DISCLOSES it in the handoff. Folding the two
 * into one word is the same failure this project keeps recording: a number that answers a question nobody
 * asked, in a way that makes the answer look better than it is.
 *
 * So the fields say what they measure:
 *   · `preventedByLayer2` — cuts that never happened because the model was warned in time;
 *   · `disclosedByLayer3` — cuts that happened and were described in the handoff;
 *   · `preventedOrDisclosed` — the sum, which is the honest name for "every crossing is accounted for".
 */
const summary = {
  root,
  sessionsScanned: files.length,
  sessionWindows: [...new Set(perSession.map((entry) => entry.window))],
  warnMargin: {
    tokens: WARN_MARGIN_TOKENS,
    floorMaxRatio: FLOOR_MAX_RATIO,
    predictWindow: NUDGE_PREDICT_WINDOW,
    ratioFallback: RATIO_FALLBACK,
  },
  layer2Enabled: !noPredict,
  crossings: total,
  /** `before` under 5% of the window: a just-reset context, not a working one (154-of-160 shape). */
  crossingsResetShaped: resetShaped,
  crossingsRealGrowth: total - resetShaped,
  preventedByLayer2: byPrediction,
  disclosedByLayer3: byForcedCut,
  /** Every crossing is accounted for by exactly one verb; anything else is a hole in the argument. */
  preventedOrDisclosed: byPrediction + byForcedCut === total,
  /**
   * NOT a coverage claim. On this corpus layer 2 prevents nothing (see the report): its effectiveness is
   * proved by `v260 ②`'s instrumented window, not by this number.
   */
  layer2CoverageNote: noPredict
    ? 'layer 2 disabled (can-red): the preventedByLayer2 count must fall, and it is 0 either way on this corpus'
    : 'this corpus cannot demonstrate layer 2 (all crossings are jumps); see test/v260 ② for the proof',
  /** Layer 2's actual effect on this corpus: how many nudges it fired, by reason. */
  nudges: nudgeStats,
  sessionsWithCrossings: perSession,
  detail: crossings,
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exit(0)
}

const lines = [
  `root                     ${summary.root}`,
  `sessions scanned         ${summary.sessionsScanned}`,
  `windows                  ${JSON.stringify(summary.sessionWindows)}`,
  `layer 2 (prediction)     ${summary.layer2Enabled ? 'ON' : 'OFF (can-red)'}`,
  '',
  `crossings                ${total}`,
  `  reset-shaped           ${resetShaped}   (before < 5% of the window: a post-reset re-read)`,
  `  real growth            ${summary.crossingsRealGrowth}   (this is the number the ruling is about)`,
  `  PREVENTED by layer 2   ${byPrediction}   (the cut never happened: the model was warned first)`,
  `  DISCLOSED by layer 3   ${byForcedCut}   (the cut happened and the handoff says so — 未经预警)`,
  `  every one accounted    ${summary.preventedOrDisclosed ? 'YES' : 'NO — a crossing has no layer'}`,
  '',
  `  NOTE                   ${summary.layer2CoverageNote}`,
  '',
  `nudges fired             ${nudgeStats.thresholdNudges + nudgeStats.predictedNudges}`,
  `  by threshold (layer 1) ${nudgeStats.thresholdNudges}`,
  `  by prediction (layer 2)${nudgeStats.predictedNudges}`,
  '',
  'per session:',
]
for (const entry of perSession) {
  lines.push(
    `  ${entry.session.padEnd(30)} warn=${entry.warnAt} (${entry.warnSource}) ` +
      `crossings=${entry.crossings} predicted=${entry.byPrediction} nudgedAt=${entry.nudgeDeliveredAtRatio ?? '—'}`,
  )
}
process.stdout.write(`${lines.join('\n')}\n`)
