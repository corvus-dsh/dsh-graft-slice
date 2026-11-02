#!/usr/bin/env node
/**
 * Development smoke test: run the pure slicing plan over every persisted
 * session log on this machine. It never writes.
 *
 * Usage: node scripts/scan-real-logs.mjs [--limit N] [--verbose]
 */
import { listSessionFiles, readSessionLogFile } from './read-session-log.mjs'
import { buildInjectionPlan } from '../index.js'

const args = process.argv.slice(2)
const limitIndex = args.indexOf('--limit')
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity
const verbose = args.includes('--verbose')

const files = listSessionFiles().slice(0, Number.isFinite(limit) ? limit : undefined)
const counts = {
  files: files.length,
  parsed: 0,
  parseFailed: 0,
  planOk: 0,
  openTurn: 0,
  noClosedTurn: 0,
  missingCwd: 0,
  otherFailed: 0,
}
const other = []
let totalTapeChars = 0
let maxTapeChars = 0

for (const file of files) {
  let log
  try {
    log = readSessionLogFile(file)
  } catch (error) {
    counts.parseFailed += 1
    other.push({ file, stage: 'parse', message: String(error?.message ?? error) })
    continue
  }
  counts.parsed += 1
  try {
    const plan = buildInjectionPlan(log, {})
    counts.planOk += 1
    totalTapeChars += plan.totalTapeChars
    maxTapeChars = Math.max(maxTapeChars, plan.totalTapeChars)
    if (verbose) {
      console.log(
        JSON.stringify({
          file,
          id: log.session.id,
          events: log.events.length,
          recent: plan.recentTurnCount,
          older: plan.olderTurnCount,
          chars: plan.totalTapeChars,
          warnings: plan.warnings.length,
        }),
      )
    }
  } catch (error) {
    const code = error?.code ?? ''
    if (code === 'OPEN_TURN') counts.openTurn += 1
    else if (code === 'NO_CLOSED_TURN') counts.noClosedTurn += 1
    else if (code === 'MISSING_CWD') counts.missingCwd += 1
    else {
      counts.otherFailed += 1
      other.push({ file, stage: 'plan', code, message: String(error?.message ?? error) })
    }
  }
}

console.log(
  JSON.stringify(
    {
      ...counts,
      totalTapeChars,
      averageTapeChars: counts.planOk === 0 ? 0 : Math.round(totalTapeChars / counts.planOk),
      maxTapeChars,
      otherFailures: other.slice(0, 20),
    },
    null,
    2,
  ),
)
if (counts.otherFailed > 0) process.exitCode = 1
