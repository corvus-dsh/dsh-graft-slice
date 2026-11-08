/**
 * v1.0.6 — `session/agent-busy`: THE PANEL MUST ADDRESS A SESSION THAT CAN ANSWER.
 *
 * ── THE LIVE FAILURE (2026-11-08, after a host restart) ────────────────────────────────────────────
 *
 * Both console panels reported, verbatim:
 *
 *   id-string: session/agent-busy | agent-object: gateway/input-invalid field=agentId |
 *   agentId-object: gateway/input-invalid field=agentId | id-string: session/not-found | ...
 *
 * `session/agent-busy` is in `ApiSessionAgentError` — the error type of
 * `sessionController.resolveAgent(sessionId)`, documented as "resolve OR RESUME one ordinary Session
 * for another host API domain". So the code does not mean "bad id": it means THE ID IS REAL AND THAT
 * SESSION'S AGENT IS MID-TURN. The panel was addressing a working session, which is the normal state
 * when a human opens the panel while a run is in flight — so the panel was unreadable exactly when it
 * was wanted, and the previous retry (a resolved id that no longer exists) answered `not-found`.
 *
 * `sessionController.list()` returns `SessionSummary` rows, whose contract includes `running`. The
 * bridge read those rows as IDS ONLY and took the first one — ordered by activity, i.e. the busiest.
 *
 * These tests drive the real `makeBridge` factory out of both client bundles (the same `new Function`
 * extraction `v022-console-bridge.test.mjs` uses) and pin:
 *   1. a busy preferred session does not stop the read — an IDLE one answers;
 *   2. the human's explicit choice is still tried FIRST;
 *   3. when every known session is running, the failure NAMES the state instead of dumping four
 *      codes, because `agent-busy` has a next action and `input-invalid` never did.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const CLIENTS = ['dsh-graft-slice/client.js', 'dsh-memory/client.js']

function loadBridge(file) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const start = source.indexOf('    function makeBridge(')
  assert.ok(start >= 0, `${file} must define makeBridge`)
  let depth = 0
  let end = -1
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  assert.ok(end > start, `${file}: could not find the end of makeBridge`)
  const body = source.slice(start, end)
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return makeBridge;`)()
}

const rejection = (code) => {
  const error = new Error(`{"code":"${code}"}`)
  error.code = code
  return error
}

/**
 * A host whose `list()` reports `running` per row, and whose `execute` behaves like the real one:
 * a running session's agent cannot be handed out.
 */
function hostCtx({ sessions, onExecute }) {
  return {
    get(name) {
      if (name === 'sessions') return { list: () => sessions.map((row) => ({ id: row.sessionId })) }
      if (name === 'remote') {
        return {
          session: { list: async () => ({ items: sessions }) },
          commands: {
            async execute(target) {
              const id = typeof target === 'string' ? target : target && (target.id || target.agentId)
              onExecute(id)
              const row = sessions.find((candidate) => candidate.sessionId === id)
              if (row === undefined) throw rejection('session/not-found')
              if (row.running === true) throw rejection('session/agent-busy')
              return { result: { kind: 'success', text: '{"ok":true,"via":"' + id + '"}' } }
            },
          },
        }
      }
      return undefined
    },
  }
}

for (const file of CLIENTS) {
  const label = file.split('/')[0]

  test(`v1.0.6 ${label}: a BUSY preferred session no longer blocks the read — an idle one answers`, async () => {
    const tried = []
    const ctx = hostCtx({
      sessions: [
        { sessionId: 'busy-session', running: true },
        { sessionId: 'idle-session', running: false },
      ],
      onExecute: (id) => tried.push(id),
    })
    const bridge = loadBridge(file)(ctx, undefined)
    // The human's choice is the busy one — exactly the live case (a pasted id kept in localStorage).
    assert.equal(bridge.useSession('busy-session'), true)

    const result = await bridge.state()
    assert.equal(result.ok, true, `${label}: the panel must read through an idle session`)
    assert.match(String(result.text), /idle-session/u, 'the answer came from the idle session')
    assert.ok(tried.includes('busy-session'), 'and the explicit choice was still tried first')
    assert.ok(
      tried.indexOf('busy-session') < tried.indexOf('idle-session'),
      'the human’s id outranks the fallback: speculation must be ordered, not preferred',
    )
  })

  test(`v1.0.6 ${label}: every session running → the failure NAMES the state (agent-busy)`, async () => {
    const ctx = hostCtx({
      sessions: [{ sessionId: 'busy-session', running: true }],
      onExecute: () => {},
    })
    const bridge = loadBridge(file)(ctx, undefined)
    bridge.useSession('busy-session')

    const result = await bridge.state()
    assert.equal(result.ok, false)
    assert.match(String(result.text), /agent-busy/u, 'the raw code is still reported')
    assert.match(
      String(result.text),
      /正在跑一轮/u,
      'AND the reason is said in words: agent-busy is state with a next action, not a schema defect',
    )
    assert.match(String(result.text), /空闲会话/u, 'the next action names what the panel needs')
  })

  test(`v1.0.6 ${label}: the idle list is read from the SAME host call the bridge already made`, async () => {
    /**
     * No new channel is invented: `session/agent-busy` was solvable with data the bridge was already
     * fetching and discarding. If a future edit stops asking for `running`, this fails.
     */
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /const listIdleHostSessionIds = async/u, `${label}: the idle lister must exist`)
    assert.match(source, /running !== true/u, `${label}: idle means the host did not say running`)
    assert.match(source, /\.\.\.idleIds/u, `${label}: and its ids must reach the candidate list`)
  })
}
