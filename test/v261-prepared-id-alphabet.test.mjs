/**
 * ── v261 (B4-0b-2 W1-4b): the alphabet must cover the prepare/commit path too ────────────────────
 *
 * `v258` fixed the DIRECT slice path (`graft_slice_and_inject`). The review found that this was half the
 * job, and the missing half is the one the nudge actually points at:
 *
 *   graft_prepare   source: `asNonEmptyString` only; target: `length > 0` only
 *                   → that unchecked target is written to the prepared store
 *   graft_commit    hands `entry.targetSessionId` straight to `graftSliceAndInjectUnlocked`, where
 *                   `asSessionIdOrThrow` did not exist (it lived only inside `graftSliceAndInject`)
 *   loadPrepared    `typeof === 'string' ? value : ''` — a MISSING field became the empty string and
 *                   the entry survived every restart
 *
 * That is the A2 shape (B4-0b-1) in another repo: N paths, one validated. And it is worse here, because
 * the watermark nudge TELLS the model 「走 prepare/commit」 — so the unvalidated path is the recommended one.
 *
 * The judgement this file pins: a REFUSED id produces (a) an `INVALID_ARGUMENT` at the tool the model
 * called, (b) NO entry on disk, and (c) NO target session. Everything else is a slower way of having no
 * validator.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold() {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v261-'))
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { dir, log, ctx, persistence }
}

const tool = (ctx, name) => ctx._tools.get(name)

/**
 * The tools resolve `sourceSessionId` from `exec.agent.id` when it is omitted — which is the path the
 * nudge tells the model to use. Passing `{}` would test the "no id anywhere" refusal instead of the
 * alphabet, so the exec carries the fixture's own id.
 */
const execOf = (log) => ({ agent: { id: log.session.id } })

/**
 * The prepared store's filename, read from `src/core/store-layer.ts` rather than written twice.
 *
 * `FILE_NAMES` is not exported, so the test extracts the one line it needs from the file's text. That is
 * deliberately uglier than a hard-coded string: the first draft of this file guessed
 * `.prepared-slices.json` and every tampering assertion failed with ENOENT — and a test that cannot find
 * the file it means to attack proves nothing about the attack.
 */
const PREPARED_FILE = (() => {
  const source = readFileSync(new URL('../src/core/store-layer.ts', import.meta.url), 'utf8')
  const match = /prepared:\s*'([^']+)'/u.exec(source)
  assert.ok(match, 'store-layer.ts must declare FILE_NAMES.prepared')
  return match[1]
})()

/** Every id here was ACCEPTED by `asNonEmptyString` and must be refused by the alphabet. */
const HOSTILE = ['../escape', '..', 'a/b', 'a\\b', 'C:\\drive', '\\\\?\\C:\\x', '.hidden', 'has space', 'nul\u0000byte']

test('v261 ①: graft_prepare refuses an illegal targetSessionId and stages NOTHING', async () => {
  const { dir, log, ctx } = scaffold()
  const preparedFile = join(dir, PREPARED_FILE)
  for (const hostile of HOSTILE) {
    await assert.rejects(
      () => tool(ctx, 'graft_prepare').execute({ targetSessionId: hostile }, execOf(log)),
      (error) => {
        const message = String(error?.message ?? error)
        assert.match(message, /INVALID_ARGUMENT/u, `${JSON.stringify(hostile)} must be refused; got: ${message}`)
        assert.match(message, /targetSessionId/u, `and the message must name the field; got: ${message}`)
        return true
      },
    )
    assert.equal(existsSync(preparedFile), false, 'a refused id must not create the store at all')
  }
})

test('v261 ②: a legal target still stages and commits — the guard did not break the happy path', async () => {
  const { log, ctx } = scaffold()
  const staged = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'session-target-ok' }, execOf(log))
  assert.equal(staged.targetSessionId, 'session-target-ok')
  const committed = await tool(ctx, 'graft_commit').execute(
    { preparedId: staged.preparedId, digest: staged.digest },
    {},
  )
  assert.equal(committed.ok, true, `commit failed: ${JSON.stringify(committed.warnings ?? committed)}`)
  assert.equal(committed.newSessionId, 'session-target-ok')
})

test('v261 ③: a HAND-EDITED prepared entry is refused at commit, no target is created, and the drop is audited', async () => {
  /**
   * The attack the review named: the id arrives through the FILE, not through the tool. Three assertions,
   * because the fix is three layers — the entry is dropped at load (audit `prepared-entry-invalid`), the
   * commit is refused, and the target does not exist afterwards.
   *
   * A RE-ACTIVATION is what forces the loader to read the tampered file: `apply()` calls `loadPrepared()`
   * on every activation, and the in-memory map still holds the clean entry. Testing the map instead of
   * the disk is exactly how "the test passes, the production path is not wired" happens.
   */
  const { dir, log, ctx, persistence } = scaffold()
  const staged = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'session-will-tamper' }, execOf(log))
  const preparedFile = join(dir, PREPARED_FILE)
  assert.ok(existsSync(preparedFile), `the prepared store must exist after a successful prepare: ${preparedFile}`)
  const onDisk = JSON.parse(readFileSync(preparedFile, 'utf8'))
  assert.ok(onDisk[staged.preparedId], 'the entry must be on disk before we tamper with it')
  onDisk[staged.preparedId].targetSessionId = 'C:\\x'
  writeFileSync(preparedFile, JSON.stringify(onDisk, null, 2), 'utf8')

  /**
   * ── A RESTART IS A NEW CONTEXT, NOT A SECOND `apply()` ON THE SAME ONE ─────────────────────────
   *
   * `apply(ctx)` registers tools, so calling it twice on one ctx throws `duplicate tool` — which the first
   * draft of this test did. More importantly, the thing under test is the LOADER reading the tampered
   * file; the in-memory map still holds the clean entry from the prepare. So the test builds a NEW ctx
   * over the same data directory, which is exactly what a process restart looks like from the store's
   * point of view.
   */
  resetRetiredSessions()
  const restarted = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(restarted, { dataDir: dir })

  await assert.rejects(
    () => tool(restarted, 'graft_commit').execute({ preparedId: staged.preparedId, digest: staged.digest }, {}),
    (error) => {
      assert.match(String(error?.message ?? error), /INVALID_ARGUMENT|PREPARED_UNKNOWN/u)
      return true
    },
  )
  assert.equal(persistence.byId.has('C:\\x'), false, 'no target may be created from a tampered entry')
  const audit = existsSync(join(dir, '.graft-audit.jsonl'))
    ? readFileSync(join(dir, '.graft-audit.jsonl'), 'utf8')
    : ''
  assert.match(audit, /"kind":"prepared-entry-invalid"/u, `the drop must be audited; audit was: ${audit.slice(0, 400)}`)
  assert.match(audit, /targetSessionId/u, 'and must name the field')
})

test('v261 ③b: a prepared entry MISSING targetSessionId is dropped, not repaired to ""', async () => {
  /**
   * The loader's old `: ''` default. An empty target can never be created, so the entry was a permanent
   * commit failure whose message said nothing about why — and it survived every restart.
   */
  const { dir, log, ctx } = scaffold()
  const staged = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'session-missing-field' }, execOf(log))
  const preparedFile = join(dir, PREPARED_FILE)
  const onDisk = JSON.parse(readFileSync(preparedFile, 'utf8'))
  delete onDisk[staged.preparedId].targetSessionId
  writeFileSync(preparedFile, JSON.stringify(onDisk, null, 2), 'utf8')

  resetRetiredSessions()
  const restarted = makeCtx({ sourceLog: log, persistence: undefined, paths: { data: dir } })
  apply(restarted, { dataDir: dir })

  await assert.rejects(
    () => tool(restarted, 'graft_commit').execute({ preparedId: staged.preparedId, digest: staged.digest }, {}),
    (error) => {
      /**
       * Both answers mean the same thing and both are honest: `PREPARED_UNKNOWN` (the entry was dropped
       * at load, which is what the fix does) or `INVALID_ARGUMENT` (a caller reached the guard first).
       * What must NOT happen is `''` being accepted as a target.
       */
      const message = String(error?.message ?? error)
      assert.match(message, /PREPARED_UNKNOWN|INVALID_ARGUMENT/u, `got: ${message}`)
      return true
    },
  )
  const audit = existsSync(join(dir, '.graft-audit.jsonl'))
    ? readFileSync(join(dir, '.graft-audit.jsonl'), 'utf8')
    : ''
  assert.match(audit, /"kind":"prepared-entry-invalid"/u, 'the drop must be audited')
})
