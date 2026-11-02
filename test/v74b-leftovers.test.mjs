/**
 * v7.4b: leftovers from an interrupted migration are named, not left to look
 * like a finished handoff.
 *
 * The host exposes no `remove` / `open(id,'write')` for a COLD session, so the
 * `[损坏]` title path in `markTargetBroken` cannot label one. The ledger in
 * `.graft-leftovers.json` is what the plugin can still do: remember the id and
 * say it out loud in the next review.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, loadLeftovers, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold({ failFlush = false } = {}) {
  const log = makeSourceLog({ turns: 3 })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-leftover-'))
  const persistence = new FakePersistence()
  if (failFlush) {
    const realCreate = persistence.create.bind(persistence)
    persistence.create = async (header, options) => {
      const handle = await realCreate(header, options)
      const realFlush = handle.flush
      return {
        ...handle,
        async flush(...args) {
          await realFlush?.(...args)
          throw new Error('simulated flush failure')
        },
      }
    }
  }
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { log, ctx, dir, persistence }
}

test('v7.4b: a failed flush is recorded as a leftover target', async () => {
  resetRetiredSessions()
  const { log, ctx, dir } = scaffold({ failFlush: true })

  await assert.rejects(() =>
    ctx._tools
      .get('graft_slice_and_inject')
      .execute({ sourceSessionId: log.session.id, newSessionId: 'leftover-1' }, {}),
  )

  const file = join(dir, '.graft-leftovers.json')
  assert.ok(existsSync(file), 'the interrupted migration must leave an auditable record')
  const list = JSON.parse(readFileSync(file, 'utf8'))
  const entry = list.find((item) => item.targetId === 'leftover-1')
  assert.ok(entry, 'the target id must be recorded')
  assert.equal(entry.sourceSessionId, log.session.id)
  resetRetiredSessions()
})

test('v7.4b: the next review says which leftovers exist', async () => {
  resetRetiredSessions()
  const { log, ctx, dir } = scaffold()
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '.graft-leftovers.json'),
    JSON.stringify([
      {
        targetId: 'ghost-1',
        sourceSessionId: 'session-source',
        stage: 'persistence.flush',
        reason: 'interrupted',
        at: new Date().toISOString(),
      },
    ]),
    'utf8',
  )
  loadLeftovers(ctx)

  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})
  assert.match(prepared.review, /未完成的迁移残留/u)
  assert.match(prepared.review, /ghost-1/u)
  resetRetiredSessions()
})