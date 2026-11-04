/**
 * v0.28 P0 — GLOBAL MODE, AND THE SESSION LIST THE CLIENT COULD NEVER SEE.
 *
 * THE REPORT. The panel finally rendered, but no selector ever appeared, the header sat
 * on "正在读取", the graft panel ended at "读取失败", and a newly opened session changed
 * nothing — the panel still insisted there was no active session.
 *
 * WHY, and this one is structural rather than a bug in a line of code.
 *
 *   - The CLIENT cannot enumerate sessions. Its `sessions` service has retain / using /
 *     binding / scope / search — no `list()`. `useSessions` only projects what the slot
 *     owner chose to publish, and a root-scoped sidebar publishes nothing.
 *   - The HOST does have `sessions.list()`.
 *   - The graft panel derived "is anything open?" from `rows.length`, and a row is only
 *     pushed for a session with a MEASURABLE TOKEN WATERMARK. A fresh session has none,
 *     so `rows` was empty, so the panel concluded nothing was open.
 *
 * Three fixes, and these tests hold each of them:
 *   1. the HOST now ships `sessions` with the console state — the list is produced where
 *      the method exists;
 *   2. every live session is listed even without a watermark (`hasWatermark` flags it);
 *   3. reads ALWAYS run, using a shape-valid placeholder agent for the
 *      session-independent command, while writes still require a real session.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

// ---------------------------------------------------------------------------
// 1. the HOST produces the session list
// ---------------------------------------------------------------------------

test('v0.28 P0: the graft console state carries a session list', () => {
  const source = readFileSync(join(ROOT, 'dsh-graft-slice/src/index.ts'), 'utf8')
  // The field must exist on the state type...
  assert.match(source, /sessions: Array<\{ sessionId: string; cwd: string; hasWatermark: boolean \}>/u,
    'the console state must declare a session list')
  // ...and must be populated for EVERY session, before the watermark filter.
  const liveIndex = source.indexOf('const liveSessions:')
  const watermarkSkip = source.indexOf('if (watermark === undefined) continue')
  assert.ok(liveIndex > 0, 'a liveSessions collector must exist')
  assert.ok(watermarkSkip > liveIndex, 'the skip on a missing watermark must come AFTER the collector')
  assert.match(source, /sessions: liveSessions/u, 'and it must be returned with the state')
})

test('v0.28 P0: a session WITHOUT a watermark is still listed', () => {
  const source = readFileSync(join(ROOT, 'dsh-graft-slice/src/index.ts'), 'utf8')
  // The entry is pushed before the `continue`, with hasWatermark recording the difference.
  const collector = source.slice(source.indexOf('const liveSessions:'), source.indexOf('if (watermark === undefined) continue'))
  assert.match(collector, /liveSessions\.push\(/u, 'every session must be pushed to the list')
  assert.match(collector, /hasWatermark: watermark !== undefined/u, 'and record whether it could be measured')
})

test('v0.28 P0: the memory console state carries a session list too', () => {
  const source = readFileSync(join(ROOT, 'dsh-memory/src/index.ts'), 'utf8')
  assert.match(source, /sessions: \(\(\) => \{/u, 'the memory state must include a sessions field')
  assert.match(source, /typeof sessions\.list !== 'function'/u, 'read through the HOST list method')
})

// ---------------------------------------------------------------------------
// 2. reads always run; writes still need a real session
// ---------------------------------------------------------------------------

/**
 * v0.30 REVISION.
 *
 * v0.28 required the placeholder for reads only, and refused an agent-less WRITE on the
 * grounds that a knob change must be attributable. That reasoning does not hold for these
 * knobs: they are PROFILE settings written by `configEditor.edit`, belonging to the
 * workspace rather than to a conversation. The refusal is what produced the
 * "有数据但无法点击" deadlock the user reported.
 *
 * The invariant that survives is the one that matters: the gateway must never receive an
 * INVALID agent. Both reads and writes now supply the same constant placeholder, so the
 * shape check passes and the command runs.
 */
test('v0.30 P0: BOTH reads and writes use a shape-valid placeholder, never undefined', () => {
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /GLOBAL_AGENT_ID = 'dsh-/u, `${file} must define a global placeholder id`)
    // The write path must NOT be blocked on a missing session any more.
    assert.equal(
      /if \(target === undefined\)/u.test(source),
      false,
      `${file}: refusing an agent-less write is what deadlocked the panel`,
    )
    // Every execute call must be given a non-optional, non-empty id. v1.0.2: the FIRST
    // ARGUMENT is now probed over three shapes (agent object / bare id / agentId object),
    // so the assertion is on the probed builder rather than on a literal call.
    assert.match(source, /const targetId =/u, `${file} must resolve a non-empty target id`)
    assert.match(source, /commands\.execute\(\.\.\.shape\.build\(attemptId\)\)/u,
      `${file} must pass a probed, non-optional id`)
    // v1.0.3: and it must try a REAL live session before the constant placeholder, because
    // the gateway looks the id up (`session/not-found` is what a placeholder always gets).
    assert.match(source, /const realSessionId = async/u, `${file} must be able to resolve a live id`)
    assert.match(source, /candidateIds/u, `${file} must try the live id first, then the fallback`)
  }
})

test('v0.28 P0: the memory panel redirects an agent-less read to the global command', () => {
  const source = readFileSync(join(ROOT, 'dsh-memory/client.js'), 'utf8')
  assert.match(source, /\/memory-console-global/u, 'there must be a session-independent command')
  assert.match(source, /effectiveLine/u, 'and the bridge must be able to substitute it')
  // ...and the HOST must actually register that command.
  const host = readFileSync(join(ROOT, 'dsh-memory/src/index.ts'), 'utf8')
  assert.match(host, /name: 'memory-console-global'/u, 'the command must be registered on the Host')
})

// ---------------------------------------------------------------------------
// 3. the panel prefers the Host list over the hook
// ---------------------------------------------------------------------------

test('v0.28 P0: the panel reads sessions from the HOST payload first', () => {
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /const hostSessions = /u, `${file} must derive the list from the Host payload`)
    assert.match(source, /Array\.isArray\(state\.sessions\)/u, `${file} must read state.sessions`)
    // Priority: Host, then hook, then nothing.
    assert.match(source, /const sessions = hostSessions\.length > 0 \? hostSessions : liveSessions/u,
      `${file} must prefer the Host list`)
  }
})

test('v0.28 P0: the panel names where its session list came from', () => {
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /sessionSource = /u, `${file} must track the list source`)
    // The rendered summary interpolates the source, naming both possibilities.
    assert.match(source, /'宿主 sessions\.list' : 'useSessions'/u, `${file} must surface it to the user`)
  }
})

// ---------------------------------------------------------------------------
// 4. global mode keeps the useful controls alive
// ---------------------------------------------------------------------------

test('v0.28 P0: switches are gated on the Host payload, not on a session', () => {
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /const canWrite = state !== null && state !== undefined/u,
      `${file}: a global setting must not be blocked by a missing session`)
    assert.equal(/const canWrite = effectiveSession\.length > 0/u.test(source), false,
      `${file}: gating writes on a session is what kept the panel inert`)
  }
})

test('v0.28 P0: the no-session message describes what still works', () => {
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /全局模式/u, `${file} must name global mode`)
    assert.match(source, /可以直接调节|可以直接调节并落盘/u, `${file} must say the settings are editable`)
  }
})
