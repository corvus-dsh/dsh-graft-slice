#!/usr/bin/env node
/**
 * End-to-end demonstration with the real plugin code and a real source log.
 *
 * The DSH services are replaced by the local fake harness, so this never
 * touches the live profile or the real session store. It exercises the same
 * apply() registration, tool definition, slicing plan, durable-write order,
 * cold-read verification, and retirement gate.
 *
 * Usage:
 *   node scripts/demo.mjs
 *   node scripts/demo.mjs --source <session-id|path-to-session.v4.jsonl.zstd>
 *   node scripts/demo.mjs --source <session-id> --new session-graft-demo
 */
import { statSync } from 'node:fs'

import { apply } from '../index.js'
import { makeSourceLog, FakePersistence, makeCtx } from '../test/fake-harness.mjs'
import { findSessionFile, listSessionFiles, readSessionLogFile } from './read-session-log.mjs'

const args = process.argv.slice(2)
const sourceArgIndex = args.indexOf('--source')
const newArgIndex = args.indexOf('--new')
const sourceArg = sourceArgIndex >= 0 ? args[sourceArgIndex + 1] : undefined
const newSessionId = newArgIndex >= 0 ? args[newArgIndex + 1] : `session-graft-demo-${Date.now()}`

function parseSource(value) {
  return value.includes('session.v4') || value.endsWith('.zstd') || value.endsWith('.jsonl')
    ? readSessionLogFile(value)
    : readSessionLogFile(findSessionFile(value))
}

function pickLatestClosedSession() {
  const files = listSessionFiles()
    .map((file) => {
      try {
        return { file, mtime: statSync(file).mtimeMs, size: statSync(file).size }
      } catch {
        return { file, mtime: 0, size: 0 }
      }
    })
    .sort((left, right) => right.mtime - left.mtime)
  for (const entry of files.slice(0, 80)) {
    try {
      const log = readSessionLogFile(entry.file)
      const turns = log.events.filter((event) => event.type === 'turn/start').length
      const ends = log.events.filter((event) => event.type === 'turn/end').length
      if (turns > 0 && ends === turns) return { log, file: entry.file }
    } catch {
      // damaged or unsupported log: try the next one
    }
  }
  return undefined
}

let source
let sourceLabel
if (sourceArg !== undefined) {
  source = parseSource(sourceArg)
  sourceLabel = sourceArg
} else {
  const picked = pickLatestClosedSession()
  if (picked !== undefined) {
    source = picked.log
    sourceLabel = picked.file
  } else {
    source = makeSourceLog({ turns: 7 })
    sourceLabel = 'synthetic fixture (no closed persisted session found)'
  }
}

const persistence = new FakePersistence()
const ctx = makeCtx({ sourceLog: source, persistence })
apply(ctx, {
  recentTurns: 5,
  maxTurnChars: 12000,
  maxTotalChars: 60000,
  oldTurnSummaryChars: 600,
  retireSource: true,
  verifyReadBack: true,
  skeletonTurn: 1,
  skeletonStep: 1,
})

const tool = ctx._tools.get('graft_slice_and_inject')
if (tool === undefined) throw new Error('graft_slice_and_inject was not registered')

const report = await tool.execute(
  { sourceSessionId: source.session.id, newSessionId },
  { signal: new AbortController().signal },
)

const stored = persistence.read(newSessionId)
const goalEvent = stored.events.find((event) => event.type === 'user/message')
const assistantEvents = stored.events.filter((event) => event.type === 'assistant/message')

console.log('=== dsh-graft-slice demo ===')
console.log('source         :', sourceLabel)
console.log('source session :', source.session.id)
console.log('source cwd     :', source.session.cwd)
console.log('target session :', newSessionId)
console.log('report         :', JSON.stringify(report, null, 2))
console.log('write order    :', persistence.order.join(' -> '))
console.log('event types    :', stored.events.map((event) => event.type).join(', '))
console.log('goal seed      :', goalEvent.data.content[0].text)
console.log('pending state  :', assistantEvents.at(-1)?.data?.message?.content?.[0]?.text)

const pointerCount = stored.events
  .flatMap((event) => event.data?.message?.content ?? [])
  .filter((block) => block?.type === 'text' && block.text.includes('expand_result'))
  .length
console.log('embedded tool pointers:', pointerCount)
console.log('retired source?       :', report.retired.source)
console.log('durability verified?  :', report.durability.verified)
console.log('next step             : open the Web UI, refresh the session list, and resume', newSessionId)
