/**
 * AUDIT ROUND 3 (P0-1/P0-2): THE HANDOVER TOOLS MUST NOT MAKE THE MODEL GUESS ITS OWN SESSION ID.
 *
 * THE MEASURED FAILURE. The watermark nudge told the model to call `graft_prepare`, and that tool
 * required a `sourceSessionId` the model had no way to obtain — no tool returned it and the
 * transcript does not contain it. Measured on the audited machine:
 *
 *     graft_prepare({})                          -> INVALID_ARGUMENT
 *     graft_prepare({sourceSessionId:"current"})  -> session "current" not found
 *     graft_prepare({sourceSessionId:"<old id>"}) -> SUCCEEDED
 *
 * The third call sliced a DIFFERENT, OLDER session that the model had scraped out of a stored skill,
 * and reported success. A silent wrong answer is worse than a loud failure — that is the whole point
 * of these assertions.
 *
 * THE FIX IS NOT NEW MACHINERY: `graft_debug_status` already resolved the caller with `exec.agent.id`
 * in this same file. What is pinned here is that (a) the other two tools now do the same, (b) the
 * model can LEARN its id instead of inferring it, and (c) an explicit id still wins, because slicing
 * another session on purpose is how one session repairs another.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'
import { makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

const CALLER = 'session-caller-known-0001'

function host() {
  const sourceLog = makeSourceLog({ turns: 6, sourceSessionId: CALLER })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence() })
  apply(ctx, {})
  return { ctx, sourceLog }
}

const exec = { agent: { id: CALLER } }

test('audit P0-1: graft_debug_status REPORTS the calling session id (the model has a source for it)', async () => {
  const { ctx } = host()
  const status = await ctx._tools.get('graft_debug_status').execute({ section: 'all' }, exec)

  /**
   * The value was ALWAYS computed — `collectDebugStatus` received it and never printed it. So the one
   * tool that knew the answer kept it, and the model went looking in stored skills for something
   * id-shaped. This assertion is the difference between "the tool knows" and "the model can know".
   */
  assert.equal(status.sessionId, CALLER, 'the calling session id must appear in the output')
  assert.equal(typeof status.sessionIdHint, 'string', 'and must come with a hint on how to use it')
  assert.match(status.sessionIdHint, /sourceSessionId/u, 'the hint must name the parameter to pass it to')
})

test('audit P0-1: graft_prepare works with NO arguments, and slices the CALLER', async () => {
  const { ctx } = host()
  const prepared = await ctx._tools.get('graft_prepare').execute({}, exec)

  assert.equal(typeof prepared.preparedId, 'string', 'no-argument prepare must succeed')
  assert.equal(
    prepared.sourceSessionId,
    CALLER,
    'and it must cut THIS session — not an id found somewhere else',
  )
})

test('audit P0-2: graft_prepare still generates a target id when none is given', async () => {
  const { ctx } = host()
  const prepared = await ctx._tools.get('graft_prepare').execute({}, exec)
  assert.equal(typeof prepared.targetSessionId, 'string')
  assert.ok(prepared.targetSessionId.length > 0, 'the optional target keeps its documented default')
})

test('audit P0-1: an EXPLICIT sourceSessionId still wins over the caller (other-session repair)', async () => {
  const { ctx } = host()
  /**
   * The resolution ORDER is the contract: explicit first, caller second. If the caller ever took
   * precedence, a session could not repair another one at all — which is a real workflow, not a
   * hypothetical (that is what an observer does for its main).
   *
   * A missing log for the other id is fine here: what matters is that the CALLER was not substituted.
   */
  await assert.rejects(
    () => ctx._tools.get('graft_prepare').execute({ sourceSessionId: 'session-other-0002' }, exec),
    (error) => !String(error?.message ?? error).includes(CALLER),
    'an explicit id must be honoured, never silently replaced by the caller',
  )
})

test('audit P0-1: with no explicit id AND no host-supplied caller, the refusal is NAMED and actionable', async () => {
  const { ctx } = host()
  /**
   * This is the branch that replaced guessing. A refusal that says what to do is strictly better than
   * a successful slice of the wrong conversation, so the message must name both the parameter and the
   * tool that can supply it.
   */
  await assert.rejects(
    () => ctx._tools.get('graft_prepare').execute({}, { agent: {} }),
    (error) => {
      const message = String(error?.message ?? error)
      return /sourceSessionId/u.test(message) && /graft_debug_status/u.test(message)
    },
    'the refusal must name the missing argument AND where to get it',
  )
})

test('audit P0-1: the no-argument call shape is documented in the watermark nudge', async () => {
  /**
   * The nudge is the thing that CREATES the deadlock, so the fix has to reach the text as well as the
   * schema: a model that is told "call graft_prepare" and not told it may omit the parameter will
   * still go hunting for an id.
   */
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')

  assert.match(source, /MODEL_DRIVEN_NUDGE_BODY/u, 'the nudge constant must exist')
  const at = source.indexOf('MODEL_DRIVEN_NUDGE_BODY')
  const window = source.slice(at, at + 1200)
  assert.match(window, /不需要任何参数|不传参数/u, 'the nudge must say the tools can be called with no arguments')
  assert.match(window, /graft_debug_status/u, 'and must name the tool that returns the id if one is wanted')
})
