#!/usr/bin/env node
/**
 * Read a persisted DSH v4 session log without the Host.
 *
 * DSH's JSONL backend appends one zstd frame per checkpoint, so the artifact
 * is a concatenation of frames rather than one frame. Node's
 * zstdDecompressSync() decodes only the first frame; this reader walks the
 * frame headers and decodes each frame, then parses the JSONL records.
 *
 * This file is a development/smoke-test utility. The plugin itself always
 * uses ctx.sessionQuery.readSession().
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MASK = 0xfffffff0
const SKIPPABLE_MAGIC = 0x184d2a50

function frameRanges(buffer) {
  const ranges = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset)
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      if (offset + 8 > buffer.length) break
      const size = buffer.readUInt32LE(offset + 4)
      offset += 8 + size
      continue
    }
    if (magic !== ZSTD_MAGIC) break
    const start = offset
    offset += 4
    if (offset >= buffer.length) break
    const descriptor = buffer[offset]
    offset += 1
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryIdFlag = descriptor & 3
    if (singleSegment === 0) offset += 1 // Window_Descriptor
    offset += [0, 1, 2, 4][dictionaryIdFlag]
    offset += contentSizeFlag === 0 ? (singleSegment === 1 ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8
    for (;;) {
      if (offset + 3 > buffer.length) throw new Error('truncated zstd block header')
      const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
      offset += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >>> 3
      if (type === 0) offset += size
      else if (type === 1) offset += 1
      else if (type === 2) offset += size
      else throw new Error('reserved zstd block type')
      if (last === 1) break
    }
    if (checksum === 1) offset += 4
    ranges.push({ start, end: offset })
  }
  return ranges
}

export function decompressSessionLog(buffer) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return buffer.toString('utf8')
  const ranges = frameRanges(buffer)
  if (ranges.length === 0) throw new Error('not a zstd frame stream')
  const decoded = []
  for (const range of ranges) {
    decoded.push(zstdDecompressSync(buffer.subarray(range.start, range.end)))
  }
  return Buffer.concat(decoded).toString('utf8')
}

export function parseSessionLog(text) {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) throw new Error('empty session log')
  const header = JSON.parse(lines[0])
  if (header.type !== 'session') throw new Error(`first record is ${header.type}, expected session`)
  const events = []
  for (const line of lines.slice(1)) {
    const event = JSON.parse(line)
    if (typeof event.type !== 'string') continue
    events.push(event)
  }
  return { session: header, inheritedEventCount: 0, events }
}

export function readSessionLogFile(path) {
  return parseSessionLog(decompressSessionLog(readFileSync(path)))
}

export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function findSessionFile(sessionId, home = dshHome()) {
  const sessionsRoot = join(home, 'sessions')
  let workspaces = []
  try {
    workspaces = readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    throw new Error(`sessions root not found: ${sessionsRoot}`)
  }
  for (const workspace of workspaces) {
    const candidate = join(sessionsRoot, workspace.name, sessionId, 'session.v4.jsonl.zstd')
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // keep scanning
    }
  }
  throw new Error(`session "${sessionId}" not found under ${sessionsRoot}`)
}

export function listSessionFiles(home = dshHome()) {
  const sessionsRoot = join(home, 'sessions')
  const files = []
  let workspaces = []
  try {
    workspaces = readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return files
  }
  for (const workspace of workspaces) {
    const workspaceRoot = join(sessionsRoot, workspace.name)
    let sessions = []
    try {
      sessions = readdirSync(workspaceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = join(workspaceRoot, session.name, 'session.v4.jsonl.zstd')
      try {
        if (statSync(file).isFile()) files.push(file)
      } catch {
        // not a persisted session
      }
    }
  }
  return files
}

function summarize(log) {
  const counts = {}
  for (const event of log.events) counts[event.type] = (counts[event.type] ?? 0) + 1
  const turns = log.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
  const ends = log.events.filter((event) => event.type === 'turn/end').map((event) => event.data.turn)
  return {
    id: log.session.id,
    cwd: log.session.cwd,
    events: log.events.length,
    turns: turns.length,
    closedTurns: ends.length,
    lastTurn: turns.at(-1) ?? null,
    lastClosedTurn: ends.at(-1) ?? null,
    types: counts,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const target = args.find((arg) => !arg.startsWith('--'))
  if (target === undefined) {
    process.stderr.write('usage: node scripts/read-session-log.mjs <session-id|file> [--json]\n')
    process.exitCode = 2
    return
  }
  const path = target.includes('session.v4') || target.endsWith('.jsonl') || target.endsWith('.zstd')
    ? target
    : findSessionFile(target)
  const log = readSessionLogFile(path)
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(log, null, 2) + '\n')
    return
  }
  process.stdout.write(JSON.stringify({ path, ...summarize(log) }, null, 2) + '\n')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    process.exitCode = 1
  })
}
