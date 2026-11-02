#!/usr/bin/env node
/**
 * Optional deep verification against the real v4 relationship validator.
 *
 * This script does not ship or vendor DSH code. Point
 * DSH_VALIDATOR_NODE_MODULES at a node_modules directory that contains the
 * extracted packages:
 *
 *   @deepseek-ai/dsh-session-format-v3-to-v4
 *   @deepseek-ai/dsh-session-format-v2-to-v3
 *   @deepseek-ai/dsh-session-format-v1-to-v2
 *   @deepseek-ai/dsh-session-format-v0-to-v1
 *   @deepseek-ai/dsh-session-format
 *   plus their transitive imports
 *
 * One way to build that directory is to extract the `lib/**\/*.js` files of
 * those packages from `resources/app.asar` and copy them under
 * `<dir>/@deepseek-ai/<pkg>/`. The validation itself calls
 * `assertReleasedV4Relationships(artifact, knownEventTypes)`.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const modules = process.env.DSH_VALIDATOR_NODE_MODULES
if (!modules) {
  process.stdout.write(
    'skip: set DSH_VALIDATOR_NODE_MODULES to a node_modules directory containing the extracted DSH format packages\n',
  )
  process.exit(0)
}

const { assertReleasedV4Relationships } = await import(
  pathToFileURL(join(modules, '@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')).href
)
const { apply, graftSliceAndInject } = await import('../index.js')
const { makeCtx, FakePersistence, makeSourceLog } = await import('../test/fake-harness.mjs')
const { findSessionFile, readSessionLogFile } = await import('./read-session-log.mjs')

async function validate(label, log, config) {
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  apply(ctx, config)
  const newId = `session-format-${label}`
  const report = await graftSliceAndInject(ctx, config, log.session.id, newId, undefined)
  const stored = persistence.read(newId)
  const artifact = {
    header: stored.session,
    inheritedEventCount: stored.inheritedEventCount,
    events: stored.events,
  }
  assertReleasedV4Relationships(artifact, new Set(stored.events.map((event) => event.type)))
  console.log(`${label} PASS events=${stored.events.length} recent=${report.recentTurnCount} older=${report.olderTurnCount}`)
}

const synthetic = makeSourceLog({ turns: 7 })
await validate('synthetic-1-1', synthetic, { recentTurns: 5, skeletonTurn: 1, skeletonStep: 1 })

try {
  await validate('synthetic-0-0', synthetic, { recentTurns: 5, skeletonTurn: 0, skeletonStep: 0 })
  console.log('synthetic-0-0 UNEXPECTED PASS')
  process.exitCode = 1
} catch (error) {
  console.log('synthetic-0-0 expected FAIL:', String(error?.message ?? error))
}

const fallbackLog = {
  session: {
    version: 4,
    id: 'session-no-assistant',
    createdAt: Date.now(),
    cwd: synthetic.session.cwd,
    isSeeded: false,
  },
  inheritedEventCount: 0,
  events: [
    { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: Date.now(), data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: Date.now(),
      data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'goal' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 3, time: Date.now(), data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
  ],
}
await validate('fallback-plugin-graft', fallbackLog, { recentTurns: 5, skeletonTurn: 1, skeletonStep: 1 })

try {
  const file = findSessionFile('session-demo-source')
  const real = readSessionLogFile(file)
  await validate('real-log', real, {
    recentTurns: 5,
    maxTurnChars: 12000,
    maxTotalChars: 60000,
    skeletonTurn: 1,
    skeletonStep: 1,
  })
} catch (error) {
  console.log('real-log skipped:', String(error?.message ?? error))
}
