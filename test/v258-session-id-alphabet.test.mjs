/**
 * ── v258 (B4-0b-2 W1-4): a session id is a filename, a key and a title suffix — its alphabet is part
 * of the API ────────────────────────────────────────────────────────────────────────────────────────
 *
 * `asNonEmptyString` (`utils/serialize.ts:24`) checks `typeof === 'string' && length !== 0` and NOTHING
 * else, yet a comment in `txnFileFor` claimed 「The id is already restricted to safe characters」.
 * Measured, that sentence was false: `../x`, `C:\x`, `\\?\C:\x` and ids containing NUL all passed.
 *
 * The journal FILENAME was protected by `encodeURIComponent`, so the obvious reading ("no traversal")
 * happens to be true there — but the same id is also a `persistence.create` argument, a
 * `.graft-targets.json` key, an audit field and a title suffix. One validated alphabet at the entry
 * covers all of them at once, which is why the fix is at the entry and not at each use.
 *
 * ── the judgement this file pins ──────────────────────────────────────────────────────────────────
 *
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` plus an explicit `..` refusal. Each exclusion is listed in the
 * source next to the regex; here the requirement is only that REFUSED INPUT PRODUCES NO FILE — a
 * validator that throws after the target was reserved would be a slower way of having no validator.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold() {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v258-'))
  const log = makeSourceLog({ turns: 2 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { dir, log, ctx, persistence }
}

/** Each of these must be refused, and none may leave a file behind. */
const HOSTILE_IDS = [
  '../escape',
  '..',
  'a/b',
  'a\\b',
  'C:\\windows',
  '\\\\?\\C:\\device',
  'has space',
  '.hidden',
  'dot..doubled',
  'nul\u0000byte',
  'x'.repeat(129),
]

test('v258 ①: 敌意 id 一律 INVALID_ARGUMENT，且磁盘零变化', async () => {
  for (const id of HOSTILE_IDS) {
    const { dir, log, ctx, persistence } = scaffold()
    const before = JSON.stringify(persistence.createCalls.length)
    const outcome = await ctx._tools
      .get('graft_slice_and_inject')
      .execute({ sourceSessionId: log.session.id, newSessionId: id }, {})
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error }))

    assert.equal(
      outcome.ok,
      false,
      `${JSON.stringify(id)} 必须被拒；实测返回 ${JSON.stringify(outcome.value ?? null).slice(0, 200)}`,
    )
    const message = String(outcome.error?.message ?? outcome.error)
    assert.match(message, /INVALID_ARGUMENT|newSessionId/u, `${JSON.stringify(id)} 的拒绝必须点名 ${'newSessionId'}：${message}`)
    assert.equal(persistence.createCalls.length, Number(before), `${JSON.stringify(id)} 被拒时不许预留 id`)
    /** Nothing named after the id may appear in the store directory. */
    const files = readdirSync(dir)
    assert.equal(files.some((name) => name.includes('escape') || name.includes('windows')), false, `磁盘上不许留下痕迹：${files.join(', ')}`)
  }
})

test('v258 ②: 合法 id 仍然照常通过（校验不是「一律拒绝」）', async () => {
  const legal = ['plain-id', 'auto-graft-mw0y4tu-lkjtr5', 'A.b_c-1', 'x'.repeat(128)]
  for (const id of legal) {
    const { log, ctx } = scaffold()
    const outcome = await ctx._tools
      .get('graft_slice_and_inject')
      .execute({ sourceSessionId: log.session.id, newSessionId: id }, {})
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error }))
    const message = `${JSON.stringify(id)} 被拒了：${String(outcome.error?.message ?? '')}`
    /** It may fail for OTHER reasons inside the fake harness; it must not fail as INVALID_ARGUMENT. */
    if (!outcome.ok) assert.doesNotMatch(String(outcome.error?.message ?? ''), /newSessionId must/u, message)
  }
})

test('v258 ③: 注释与代码不再打架 —— `txnFileFor` 里那句假话已改成「它当初是假的」', () => {
  const source = readFileSyncSource()
  const start = source.indexOf('function txnFileFor(')
  assert.notEqual(start, -1)
  const body = source.slice(start, source.indexOf('\n}\n', start))

  /**
   * The phrase MAY appear — but only inside a sentence that says it was false. Asserting its total
   * absence would forbid quoting the defect in the comment that records it, which is how a future
   * reader learns what the trap was. So the requirement is: every occurrence is framed as a retraction.
   */
  const mentions = [...body.matchAll(/already restricted to safe characters/gu)].length
  if (mentions > 0) {
    assert.match(body, /USED TO BE FALSE|both halves are wrong|是假的/iu, '引用旧说法必须同时说明它是错的')
  }
  assert.match(body, /encodeURIComponent/u, 'encode 作为纵深防御必须保留')
  assert.match(body, /asSessionIdOrThrow/u, '必须指向真正的校验位置')
})

function readFileSyncSource() {
  /** Read the TS source, not the bundle: the claim is about what a reader of `src/` sees. */
  return readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
}

void existsSync