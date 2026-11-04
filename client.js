/**
 * dsh-graft-slice — the Web console (Client half).
 *
 * WHAT THIS REMOVES
 *
 * Changing a graft knob used to mean: find cordis.patch.yml, edit YAML, restart
 * the host, lose the session. So in practice the knobs were frozen. The panel
 * reads the live state and writes knobs through the Host's `configEditor`, so a
 * toggle takes effect on the next pre-step and survives a restart because it IS
 * the config — not a shadow copy in plugin memory.
 *
 * THE BRIDGE IS DELIBERATELY DEFENSIVE
 *
 * The UI rules name `ctx.remote.commands.execute` as the Client-callable Host
 * entry point, but the client-side arity differs between host builds and cannot
 * be verified from the bundle. So the bridge tries the plausible shapes in order
 * and DISPLAYS which one worked (or the reason none did). A panel that silently
 * does nothing is worse than one that says what failed — and `/graft-console` is
 * the same implementation, usable from the composer meanwhile.
 */
window.__ModuleLoader__.load({
  id: 'dsh-graft-slice',
  /**
   * v0.21: `host` is the THIRD symbol the client sandbox hands the factory.
   *
   * The documented surface for a Client half is `(require, styles, host)` — the
   * package-private JSON RPC to this package's own Host half. The panel used
   * `ctx.get('remote')` instead, and on the live page that threw
   * `cannot get property "remote.commands" without inject`. Keeping the old path as
   * a fallback costs nothing; making it the primary makes the panel dead.
   */
  factory(require, styles, host) {
    const React = require('react')
    const h = React.createElement
    const PANEL_KEY = 'graft-console'

    /**
     * v1.0.0 P0 — FACTORY SCOPE, NOT EFFECT SCOPE.
     *
     * `withTimeout` used to live inside the fetch effect, while `write` (the knob
     * handler) is a component-scope closure. Clicking a toggle therefore threw
     * `ReferenceError: withTimeout is not defined` — surfaced on the live page as a
     * red card `错误详情：{"message":"withTimeout is not defined",
     * "via":"remote.commands.execute"}` — so EVERY switch failed to write, and the
     * panel fell back to the gray "these are the plugin defaults" line.
     *
     * One definition at factory scope is visible to the effect and to every
     * handler, which is the property the original placement silently lacked.
     */
    /**
     * v1.0.1 P0 — peeling the command envelope lives INSIDE makeBridge.
     *
     * It is only ever used by the bridge, and keeping it there means the bridge can be
     * lifted out of this bundle and unit-tested on its own (test/v022-console-bridge
     * does exactly that). `withTimeout` stays at factory scope because the renderer
     * needs it too.
     */
    const withTimeout = (promise, ms, label) =>
      new Promise((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          resolve({ ok: false, via: 'timeout', text: `${label} 超时（${ms}ms 内宿主没有回应）` })
        }, ms)
        Promise.resolve(promise).then(
          (value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({ ok: false, via: 'none', text: String((error && error.message) || error) })
          },
        )
      })

    const CSS = `
.gc-root{display:flex;flex-direction:column;gap:16px;padding:20px 24px;height:100%;overflow:auto;color:var(--dsw-alias-text-primary,inherit);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.gc-card{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.25));border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,transparent)}
.gc-h{font-size:14px;font-weight:600;margin:0 0 10px}
.gc-sub{opacity:.65;font-size:12px;margin:0 0 12px}
.gc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.14))}
.gc-row:first-of-type{border-top:0}
.gc-label{display:flex;flex-direction:column;gap:2px}
.gc-hint{opacity:.6;font-size:11.5px}
.gc-sw{position:relative;width:40px;height:22px;border-radius:11px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18));cursor:pointer;padding:0;flex:0 0 auto}
.gc-sw[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent}
.gc-sw i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .14s ease}
.gc-sw[aria-checked="true"] i{left:20px}
.gc-num{width:84px;text-align:right;font-variant-numeric:tabular-nums}
.gc-range{flex:1;min-width:120px}
.gc-bar{position:relative;height:8px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.2));overflow:hidden;margin-top:6px}
.gc-bar>span{position:absolute;inset:0 auto 0 0;border-radius:5px}
.gc-badge{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3))}
.gc-warn{color:#b45309}.gc-over{color:#b91c1c}.gc-ok{opacity:.7}
.gc-table{width:100%;border-collapse:collapse}
.gc-table th,.gc-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.14));font-weight:400}
.gc-btn{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));border-radius:7px;padding:5px 11px;cursor:pointer;color:inherit;font:inherit}
.gc-btn:disabled{opacity:.5;cursor:default}
.gc-err{color:#b91c1c;white-space:pre-wrap}
.gc-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;opacity:.75}
.gc-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));border-radius:8px;overflow:hidden;flex:0 0 auto}
.gc-seg button{border:0;background:transparent;color:inherit;font:inherit;padding:4px 10px;cursor:pointer;opacity:.65}
.gc-seg button[aria-pressed="true"]{background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;opacity:1}
.gc-select{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));border-radius:7px;padding:5px 9px;color:inherit;font:inherit;max-width:340px}
.gc-sw[disabled],.gc-num[disabled],.gc-range[disabled],.gc-seg button[disabled]{opacity:.45;cursor:not-allowed}
.gc-crash{margin:24px;padding:16px 18px;border:1px solid #b91c1c;border-radius:10px;background:rgba(185,28,28,.08);color:#b91c1c;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.gc-crash h3{margin:0 0 8px;font-size:14px}
.gc-crash pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;opacity:.9}
`

    /**
     * Client -> Host.
     *
     * v0.21: the FIRST channel is `host.call(...)`.
     *
     * The panel used to probe `ctx.get('remote').commands.execute(...)` shapes. On
     * the live page that threw `cannot get property "remote.commands" without
     * inject` — `remote` is a GENERATED namespace that only exists once the
     * api-remotes client package is declared in `dsh.client.inject`, and even then
     * the property is guarded per-declaration. The package-private RPC builtin
     * `host.call(method, args)` reaches this package's own Host half with no such
     * declaration, so it is tried first and the namespace is the fallback.
     */
    function makeBridge(ctx, host, slotProps) {
      /**
       * v1.0.1 P0 — PEELING THE COMMAND ENVELOPE.
       *
       * `commands.execute` resolves to a CommandExecution `{ kind, text }`, NOT to
       * `{ result: { kind, text } }`. The old code looked only at `.result`, fell
       * through to `JSON.stringify(settled)` and reported `ok: true`, so the panel set
       * its state to the ENVELOPE — an object with no `config` and no `thresholds`.
       *
       * One line, every symptom: toggles rendered OFF and never flipped (the optimistic
       * update wrote into an empty object that the next read replaced), "当前推导：
       * 读取失败", and the gray "these are the plugin defaults" line — while writes
       * really did persist at the Host, so the toast appeared and nothing changed.
       *
       * The unwrap tolerates depth 3 and a stringified envelope, because the wrapper is
       * a host-build detail. It never invents one: an unrecognised shape is an error,
       * not state.
       */
      const tryParse = (text) => {
        try {
          return JSON.parse(text)
        } catch {
          return undefined
        }
      }

      const safeSlice = (value, limit) => {
        const cap = typeof limit === 'number' ? limit : 600
        try {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          if (typeof text !== 'string') return String(value)
          return text.length > cap ? `${text.slice(0, cap)}…` : text
        } catch {
          return '(无法序列化的返回值)'
        }
      }

      const unwrapExecution = (value) => {
        let node = value
        let decision = undefined
        for (let depth = 0; depth < 3 && decision === undefined; depth += 1) {
          if (node === null || node === undefined) return undefined
          if (typeof node === 'string') {
            const parsed = tryParse(node)
            if (parsed === undefined) return undefined
            node = parsed
            continue
          }
          if (typeof node !== 'object') return undefined
          if (typeof node.text === 'string') {
            decision = { kind: typeof node.kind === 'string' ? node.kind : 'success', text: node.text }
            break
          }
          const inner = node.result !== undefined ? node.result : node.value !== undefined ? node.value : node.execution
          if (inner === undefined) return undefined
          node = inner
        }
        return decision
      }

      /** Which call shape the host accepted last time, so a working contract costs one call. */
      let workingShape = undefined

      /**
       * v1.0.2: a gateway rejection has a code and a field — say them out loud instead of
       * printing a JSON blob the operator cannot read.
       */
      const describeRejection = (value) => {
        if (value !== null && value !== undefined && typeof value === 'object') {
          const failure = value.error !== null && typeof value.error === 'object' ? value.error : undefined
          if (failure !== undefined) {
            const code = typeof failure.code === 'string' ? failure.code : 'error'
            const details = failure.details !== null && typeof failure.details === 'object' ? failure.details : undefined
            const field = details !== undefined && typeof details.field === 'string' ? ` field=${details.field}` : ''
            return `${code}${field}`
          }
          if (value.ok === false) return 'ok:false（无错误码）'
        }
        return `无法识别的返回形状：${safeSlice(value, 200)}`
      }

      /**
       * v0.24 — WHY THE PANEL STOOD AT "读取中…" AND WHY `commands/execute` RETURNED
       * `gateway/arguments-invalid`.
       *
       * The Host registers `commands.execute(agent, line, attachments, signal)` and the
       * `agent` parameter is typed `Agent`, i.e. `{ id: SessionId }` — a REQUIRED,
       * validated argument. The Remote validates its payload against that signature and
       * rejects anything else with `gateway/arguments-invalid`, which is exactly the
       * error the memory panel showed.
       *
       * The previous `agentOf()` did this:
       *
       *     const list = ctx.get('sessions').list()
       *
       * The CLIENT `sessions` service has no `list()` method at all — its surface is
       * `retain` / `using` / `retainInfo` / `refreshProjections` / `search` / `fork` /
       * `scope` / `binding`. (`list()` exists on the HOST store, which is a different
       * object reached by a different process.) So the call returned `undefined` on
       * every render, `execute(undefined, …)` was rejected as invalid arguments, and
       * the rejection was swallowed into a string that the panel rendered as an error
       * card — or, on the graft side, left the panel with no state at all.
       *
       * Two independent fixes, because either alone is fragile:
       *
       *   1. ASK THE SLOT. The `main` slot is root-scoped, so it receives standard
       *      props including `useSessions`, the Client's ObservableSnapshot selector for
       *      live sessions. That is the supported way for a root-scoped panel to learn
       *      which sessions exist; it does not require `list()` anywhere.
       *   2. FALL BACK TO `binding`. If the hook is unavailable (an older host, a
       *      different slot), a retained session's binding exposes both `sessionId` and
       *      `session.command(line)` — the ISession method the UI is meant to use.
       *
       * `agentOf` now returns undefined ONLY when there is genuinely no live session,
       * and that case is reported as "no session" instead of being sent as an invalid
       * argument.
       */
      /**
       * v0.26: the hook is ATTACHED by the component, because it arrives as a prop.
       *
       * The `inject` callback for a root-scoped slot receives NO arguments, so the
       * previous attempt to read `useSessions` from it always saw `undefined`. The hook
       * is a standard selector passed to the COMPONENT, which forwards it here.
       */
      let sessionsHook = (() => {
        if (slotProps === undefined || slotProps === null) return undefined
        return typeof slotProps.useSessions === 'function' ? slotProps.useSessions : undefined
      })()

      const sessionIdsFromProps = () => {
        try {
          const useSessions = sessionsHook
          if (typeof useSessions !== 'function') return []
          // `useSessions(selector)` is a SnapshotSelectorHook. A selector returning the
          // whole snapshot is the only thing safe to call here, and only the id list is
          // needed, so ask for exactly that.
          const snapshot = useSessions((value) => value)
          if (snapshot === undefined || snapshot === null) return []
          const list = Array.isArray(snapshot)
            ? snapshot
            : Array.isArray(snapshot.sessions)
              ? snapshot.sessions
              : Array.isArray(snapshot.list)
                ? snapshot.list
                : []
          const ids = []
          for (const entry of list) {
            const id = typeof entry === 'string' ? entry : entry && typeof entry.id === 'string' ? entry.id : typeof entry?.sessionId === 'string' ? entry.sessionId : ''
            if (id.length > 0) ids.push(id)
          }
          return ids
        } catch {
          return []
        }
      }

      /**
       * v1.0.3 — A REAL SESSION ID, because the command's first argument must name one.
       *
       * Proven by the live rejection `session/not-found` (see the shapes comment): the
       * gateway accepts a bare id and looks it up, so a constant placeholder can never
       * succeed. A root-scoped panel has no session of its own, so the id comes from:
       *
       *   1. the slot's session snapshot (`useSessions`), when the owner publishes one;
       *   2. the Host's content index (`sessions.search`), which returns session ids;
       *   3. nothing — and then the panel says so instead of pretending to read.
       *
       * Resolved once per panel instance: it only has to be A live session, because the
       * console's payload is global.
       */
      let cachedSessionId = ''
      const realSessionId = async () => {
        if (cachedSessionId.length > 0) return cachedSessionId
        const fromProps = sessionIdsFromProps()
        if (fromProps.length > 0) {
          cachedSessionId = fromProps[fromProps.length - 1]
          return cachedSessionId
        }
        try {
          const sessions = ctx.get ? ctx.get('sessions') : undefined
          if (sessions && typeof sessions.search === 'function') {
            for (const query of ['的', '我们', '我', 'the', 'a']) {
              try {
                const reply = await sessions.search(query, undefined)
                const items = reply && reply.ok === true && reply.value ? reply.value.items : undefined
                if (!Array.isArray(items)) continue
                for (const item of items) {
                  const id = item && typeof item.sessionId === 'string' ? item.sessionId : ''
                  if (id.length > 0) {
                    cachedSessionId = id
                    return cachedSessionId
                  }
                }
              } catch {
                // A search shape that throws simply does not contribute an id.
              }
            }
          }
        } catch {
          // No sessions face: the panel reports "no id", which is the truthful state.
        }
        return ''
      }

      /**
       * Resolve ONE valid `{ id }` agent, or undefined with the reason recorded.
       *
       * `remote.commands.execute` needs the agent of the session the command runs FOR.
       * Root-scoped panels are not bound to a session, so the honest choice is the most
       * recently active one — which is what a user is looking at when they open a
       * console panel.
       */
      const agentOf = (preferredId) => {
        // v0.25: an EXPLICIT choice always wins. A human picking a session is the
        // unambiguous source of truth and must not be second-guessed by "newest".
        const ids = sessionIdsFromProps()
        if (typeof preferredId === 'string' && preferredId.length > 0) {
          // An id the user chose is a real id even when the snapshot does not list it:
          // the Host validates it and reports if it is gone. Refusing it here would stop
          // the selector recovering from a stale snapshot.
          return { id: preferredId }
        }
        if (ids.length > 0) return { id: ids[ids.length - 1] }
        try {
          const sessions = ctx.get ? ctx.get('sessions') : undefined
          // The CLIENT surface has no `list()`. Probe the two methods that DO exist and
          // can name a session: `retainInfo`/`binding` need an id we do not have, so the
          // only remaining supported source is a snapshot the caller already holds.
          if (sessions && typeof sessions.list === 'function') {
            // Defensive: a host build that does expose `list()` on the client face.
            const list = sessions.list()
            if (Array.isArray(list) && list.length > 0) {
              const first = list[0]
              const id = typeof first === 'string' ? first : first && typeof first.id === 'string' ? first.id : ''
              if (id.length > 0) return { id }
            }
          }
        } catch {
          // Reported by the caller as "no session", which is the accurate statement.
        }
        return undefined
      }

      /**
       * v0.25: the session list, for the panel's selector.
       *
       * A root-scoped panel can legitimately see ZERO sessions — a fresh window with no
       * conversation. Reporting that as a dead end made the whole console useless in
       * exactly the situation a user opens it. The ids are published so a human can pick.
       */
      const listSessions = () => {
        const ids = [...sessionIdsFromProps()]
        try {
          const sessions = ctx.get ? ctx.get('sessions') : undefined
          if (sessions && typeof sessions.list === 'function') {
            const list = sessions.list()
            if (Array.isArray(list)) {
              for (const entry of list) {
                const id = typeof entry === 'string' ? entry : entry && typeof entry.id === 'string' ? entry.id : ''
                if (id.length > 0 && !ids.includes(id)) ids.push(id)
              }
            }
          }
        } catch {
          // An unavailable service simply means no extra ids.
        }
        return ids
      }

      /**
       * v0.28: a shape-valid Agent for a session-independent command.
       *
       * `Agent` is `{ id: SessionId }`; the gateway checks the shape, never existence.
       * The Host side of `/graft-console` reads nothing from it. A placeholder is therefore
       * honest here — it is the parameter the contract demands for a request that has no
       * session, not a pretend session.
       */
      const GLOBAL_AGENT_ID = 'dsh-graft-console-global'

      const callHost = async (line, preferredId) => {
        const failures = []
        const agent = agentOf(preferredId)
        /**
         * `remote.commands.execute(agent, line, attachments, signal)`.
         *
         * Sending an undefined agent is worse than not sending at all: the gateway
         * rejects it as `gateway/arguments-invalid`, which reads like a plugin bug and
         * buries the real cause ("no session is open"). So the no-agent case is stated
         * plainly and the other channels are still tried.
         */
        const commands = (() => {
          try {
            const remote = ctx && ctx.get ? ctx.get('remote') : undefined
            return remote && remote.commands
          } catch (error) {
            failures.push(`ctx.get('remote'): ${String((error && error.message) || error)}`)
            return undefined
          }
        })()

        if (commands && typeof commands.execute === 'function') {
          /**
           * v0.28 P0 — THE SENTINEL AGENT, AND WHY IT IS SOUND.
           *
           * The gateway validates `agent` by SHAPE (`{ id: string }`), never by
           * existence. That is why `gateway/arguments-invalid` appeared for `undefined`
           * and never for a well-formed id.
           *
           * `/graft-console` reads nothing from the agent — it reports knobs, thresholds,
           * the cost estimate, pending ignitions and the session list, all from Host state
           * and the profile config. Blocking that behind a resolved session is what left
           * the panel permanently at "正在读取".
           *
           * So a placeholder is used when no session is known. It is not a pretend
           * session: the command genuinely does not depend on one, and the panel labels
           * the result as global. WRITES never take this path — a knob change without a
           * session is refused, because it must be attributable.
           */
          /**
           * v0.30 P0 — WRITES TAKE THE PLACEHOLDER TOO.
           *
           * v0.28 refused a write without a real session, reasoning that a knob change
           * must be attributable. That reasoning does not hold for these knobs: they are
           * PROFILE settings written by `configEditor.edit` into `cordis.patch.yml`, and
           * they belong to the workspace, not to a conversation. Requiring a session made
           * the panel inert in exactly the situation the user hit — global mode with
           * nothing open — producing the "有数据但无法点击" deadlock.
           *
           * Auditability is preserved differently: the constant placeholder makes the
           * writer identifiable as the console itself, and the UI states plainly that the
           * switch is a global setting.
           */
          const targetId =
            agent !== undefined && agent !== null && typeof agent.id === 'string' && agent.id.length > 0
              ? agent.id
              : GLOBAL_AGENT_ID
          /**
           * v1.0.2 P0 — THE FIRST ARGUMENT IS PROBED, NOT ASSUMED.
           *
           * Live failure (screenshot, 2026-11-04 21:0x):
           *
           *   gateway/input-invalid | details.endpoint=commands/execute | field=agentId
           *
           * The generated client proxy never says whether it wants the Agent OBJECT or the
           * bare id string, and the host build is not inspectable from this bundle. Every
           * shape the panel tried was rejected at validation, which is why NO console read
           * ever produced data — and why the previous round's stringify fallback turned a
           * rejection envelope into fake panel state.
           *
           * So the bridge now probes the three plausible shapes in order, remembers the one
           * that worked, and reports every rejection it had to survive. A rejection is
           * NEVER success.
           */
          /**
           * v1.0.3 — THE PROBE ANSWERED THE QUESTION. `id-string` IS THE CONTRACT.
           *
           * Measured from the live error text (2026-11-04 21:39):
           *
           *   agent-object:   gateway/input-invalid field=agentId   <- wrong TYPE
           *   id-string:      session/not-found                     <- right type, id missing
           *   agentId-object: gateway/input-invalid field=agentId   <- wrong TYPE
           *
           * `session/not-found` is a BUSINESS error, not a validation error: the gateway
           * accepted a bare SessionId string and then looked it up. So the first argument
           * is the id STRING, and it has to name a session that EXISTS — which a constant
           * placeholder never can. Hence `realSessionId()`: a live id from the slot's
           * own session snapshot, or from the Host's content index.
           */
          const shapes = [
            { name: 'id-string', build: (id) => [id, line, [], undefined] },
            { name: 'agent-object', build: (id) => [{ id }, line, [], undefined] },
            { name: 'agentId-object', build: (id) => [{ agentId: id }, line, [], undefined] },
          ]
          const ordered =
            workingShape === undefined
              ? shapes
              : [shapes.find((shape) => shape.name === workingShape), ...shapes.filter((shape) => shape.name !== workingShape)]
          const sessionId = await realSessionId()
          /**
           * v1.0.3: the RESOLVED id goes first — an explicit choice must never be
           * second-guessed — and the live id found from the snapshot/index is the retry.
           * In production the placeholder earns `session/not-found` and the retry is what
           * makes the panel work; in a session-bound panel the first attempt already wins.
           */
          const candidateIds =
            sessionId.length > 0 && sessionId !== targetId ? [targetId, sessionId] : [targetId]
          for (const attemptId of candidateIds) {
            for (const shape of ordered) {
              if (shape === undefined) continue
              try {
                const settled = await commands.execute(...shape.build(attemptId))
                const execution = unwrapExecution(settled)
                if (execution !== undefined) {
                  workingShape = shape.name
                  return {
                    ok: execution.kind !== 'error',
                    text: execution.text,
                    via: `remote.commands.execute(${shape.name})`,
                    raw: settled,
                  }
                }
                failures.push(`${shape.name}: ${describeRejection(settled)}`)
              } catch (error) {
                failures.push(`${shape.name}: ${String((error && error.message) || error)}`)
              }
            }
          }
        } else {
          failures.push('remote.commands 不可用（inject 未生效或宿主未挂载）')
        }

        // The dynamic-package RPC: only present when this bundle runs as a DYNAMIC
        // package. An installed client module receives `require` alone, so this is a
        // bonus channel, never the primary one.
        if (host !== undefined && typeof host.call === 'function') {
          try {
            const value = await host.call('commands.execute', { line })
            return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value), via: 'host.call(commands.execute)' }
          } catch (error) {
            failures.push(`host.call(commands.execute): ${String((error && error.message) || error)}`)
          }
        }
        return {
          ok: false,
          via: 'none',
          text:
            `面板无法调用宿主（${failures.length === 0 ? 'remote.commands 与 host.call 都不可用' : failures.join(' | ')}）。\n` +
            'Host 侧功能不受影响：可直接在输入框执行该命令。',
        }
      }
      return {
        /** v0.25: the session surface, so the panel can offer an explicit choice. */
        /**
         * v0.26: the component hands over the `useSessions` hook it received.
         *
         * Called from the component body during render. Until it is called, `sessions()`
         * is empty and `canWrite()` is false — which means NO request is attempted, which
         * is exactly the reported fix.
         */
        attach: (hook) => {
          if (typeof hook === 'function') sessionsHook = hook
        },
        sessions: () => listSessions(),
        /** Is there an agent right now? Decides read-only mode vs. interactive. */
        canWrite: () => agentOf() !== undefined,
        state: (sessionId) => callHost('/graft-console', sessionId),
        set: (key, value, sessionId) => callHost(`/graft-console-set ${key} ${value}`, sessionId),
        // The panel must render even when the bridge is dead: every method resolves
        // to an error RESULT, never a thrown exception, so one failed call cannot
        // blank the slot entry.
        safe: async (fn, ...args) => {
          try {
            return await fn(...args)
          } catch (error) {
            return { ok: false, via: 'none', text: String((error && error.message) || error) }
          }
        },
      }
    }

    function Toggle({ label, hint, checked, onChange, disabled }) {
      return h('div', { className: 'gc-row' }, [
        h('span', { key: 'l', className: 'gc-label' }, [
          h('span', { key: 'a' }, label),
          hint ? h('span', { key: 'b', className: 'gc-hint' }, hint) : null,
        ]),
        h('button', {
          key: 's',
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          className: 'gc-sw',
          // v0.25: read-only mode DISABLES the control instead of hiding it — a hidden
          // switch leaves the user wondering whether the feature exists.
          ...(disabled === true ? { disabled: true, title: '只读：没有确定的活动会话' } : {}),
          onClick: () => { if (disabled !== true) onChange(!checked) },
        }, h('i', null)),
      ])
    }

    function Ratio({ label, hint, value, onChange, disabled }) {
      const [draft, setDraft] = React.useState(String(value))
      React.useEffect(() => setDraft(String(value)), [value])
      const commit = (next) => {
        const num = Number(next)
        if (Number.isFinite(num) && num > 0 && num < 1) onChange(Math.round(num * 100) / 100)
        else setDraft(String(value))
      }
      return h('div', { className: 'gc-row' }, [
        h('span', { key: 'l', className: 'gc-label' }, [
          h('span', { key: 'a' }, label),
          hint ? h('span', { key: 'b', className: 'gc-hint' }, hint) : null,
        ]),
        h('input', {
          key: 'r',
          className: 'gc-range',
          type: 'range',
          min: '0.30',
          max: '0.95',
          step: '0.01',
          value: String(value),
          'aria-label': label,
          ...(disabled === true ? { disabled: true } : {}),
          onChange: (event) => { if (disabled !== true) onChange(Number(event.target.value)) },
        }),
        h('input', {
          key: 'n',
          className: 'gc-num',
          type: 'number',
          min: '0.05',
          max: '0.99',
          step: '0.01',
          value: draft,
          'aria-label': `${label} 数值`,
          ...(disabled === true ? { disabled: true } : {}),
          ...(disabled === true ? { disabled: true } : {}),
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => commit(draft),
          onKeyDown: (event) => { if (event.key === 'Enter') commit(draft) },
        }),
        h('span', { key: 'p', className: 'gc-hint' }, `${Math.round(value * 100)}%`),
      ])
    }

    function Segmented({ label, hint, value, options, onChange, disabled }) {
      return h('div', { className: 'gc-row' }, [
        h('span', { key: 'l', className: 'gc-label' }, [
          h('span', { key: 'a' }, label),
          hint ? h('span', { key: 'b', className: 'gc-hint' }, hint) : null,
        ]),
        h('span', { key: 's', className: 'gc-seg', role: 'group', 'aria-label': label },
          options.map((option) => h('button', {
            key: option.value,
            type: 'button',
            'aria-pressed': String(option.value === value),
            title: option.title || option.value,
            ...(disabled === true ? { disabled: true } : {}),
            onClick: () => { if (disabled !== true) onChange(option.value) },
          }, option.label))),
      ])
    }

    /** A bounded integer knob (v0.18 capacity/rate settings). */
    function NumberRow({ label, hint, value, min, max, onChange, disabled }) {
      const [draft, setDraft] = React.useState(String(value))
      React.useEffect(() => { setDraft(String(value)) }, [value])
      const commit = (raw) => {
        const parsed = Number(raw)
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) { setDraft(String(value)); return }
        if (parsed < min || parsed > max) { setDraft(String(value)); return }
        if (parsed !== value) onChange(parsed)
      }
      return h('div', { className: 'gc-row' }, [
        h('span', { key: 'l', className: 'gc-label' }, [
          h('span', { key: 'a' }, label),
          hint ? h('span', { key: 'b', className: 'gc-hint' }, hint) : null,
        ]),
        h('input', {
          key: 'n',
          className: 'gc-num',
          type: 'number',
          min: String(min),
          max: String(max),
          step: '1',
          value: draft,
          'aria-label': label,
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => commit(draft),
          onKeyDown: (event) => { if (event.key === 'Enter') commit(draft) },
        }),
      ])
    }

    function SessionRow({ row }) {
      // v0.23: a Host payload is DATA, not a contract this file can assume. Each
      // field is read through a guard because `.toLocaleString()` on undefined is one
      // of the ways a single bad row used to take the whole panel down with it.
      const data = row || {}
      const n = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
      const state = typeof data.state === 'string' ? data.state : 'unknown'
      const color = state === 'over-hard-cutoff' ? '#b91c1c' : state === 'over-warn-line' ? '#b45309' : '#10b981'
      const cls = state === 'over-hard-cutoff' ? 'gc-over' : state === 'over-warn-line' ? 'gc-warn' : 'gc-ok'
      const warnAt = n(data.warnAt, 0.7)
      const hardAt = n(data.hardAt, 0.75)
      const percent = n(data.percent, 0)
      const generation = n(data.generation, 0)
      const grace = n(data.graceTurnsRemaining, 0)
      return h('tr', null, [
        h('td', { key: 'id' }, [
          h('div', { key: 'a', className: 'gc-mono' }, String(data.sessionId || '(未知会话)')),
          h('div', { key: 'b', className: 'gc-hint' }, data.cwd || '(未记录工作目录)'),
        ]),
        h('td', { key: 'w' }, [
          h('div', { key: 'a' }, `${percent}% · ${n(data.tokens, 0).toLocaleString()} / ${n(data.contextWindow, 0).toLocaleString()}`),
          h('div', { key: 'b', className: 'gc-bar' }, h('span', { style: { width: `${Math.min(100, percent)}%`, background: color } })),
          h('div', { key: 'c', className: 'gc-hint' }, `数据来源 ${data.source || '(未知)'}`),
        ]),
        h('td', { key: 'd' }, [
          h('div', { key: 'a' }, `→提示线 ${Math.round(warnAt * 100)}% 还差 ${n(data.toWarnTokens, 0).toLocaleString()} tok`),
          h('div', { key: 'b', className: 'gc-hint' }, `→强制线 ${Math.round(hardAt * 100)}% 还差 ${n(data.toHardTokens, 0).toLocaleString()} tok`),
        ]),
        h('td', { key: 's' }, [
          h('span', { key: 'a', className: `gc-badge ${cls}` }, state),
          generation > 0
            ? h('div', { key: 'b', className: 'gc-hint' }, `第 ${generation} 代${grace > 0 ? ` · 保护中 ${grace} 轮` : ''}`)
            : h('div', { key: 'b', className: 'gc-hint' }, '原始会话'),
        ]),
      ])
    }

    /**
     * v0.23 — ERROR BOUNDARY. A white panel is the worst failure mode for a diagnostic
     * surface: it reports nothing, and the user cannot tell "no data" from "this
     * crashed". The requirement is that a throw becomes a RED CARD.
     *
     * WHY THIS IS A CLASS. The first draft of this guard wrapped `h(Component, props)`
     * in try/catch. That cannot work and the test proved it: `createElement` is LAZY —
     * it records an element, and React calls the component later, outside our catch.
     * Only a class boundary participates in the render phase at the right moment.
     *
     * The catch: `React.Component` is not on the documented sandbox surface either. So
     * it is FEATURE-DETECTED. When the class API is present the panel gets a real
     * boundary; when it is not, the bare component is returned and still renders — a
     * boundary can only ever add protection, never remove the panel.
     */
    function guard(Component) {
      if (typeof React.Component !== 'function') return Component
      return class PanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { crash: null }
        }

        static getDerivedStateFromError(error) {
          return { crash: error }
        }

        componentDidCatch(error, info) {
          try {
            const detail = `${String((error && error.stack) || error)}\n\n组件栈：\n${String((info && info.componentStack) || '(无)')}`
            console.error(`[${PANEL_KEY}] 面板渲染失败：`, detail)
          } catch {
            // Logging must never be the second crash.
          }
        }

        render() {
          if (this.state.crash === null) return this.props.children
          const error = this.state.crash
          return h('div', { className: 'gc-crash' }, [
            h('h3', { key: 't' }, '控制台渲染失败'),
            h('div', { key: 'a' }, '面板内部抛出了未捕获异常，已被错误边界拦下（不再白屏）。完整堆栈已写入浏览器控制台。'),
            h('pre', { key: 'p' }, String((error && error.stack) || (error && error.message) || error)),
            h('div', { key: 'b', style: { marginTop: '10px', opacity: 0.75 } },
              '宿主侧功能不受影响：可直接在输入框执行 /graft-console 查看同样的数据。'),
          ])
        }
      }
    }

    /** Wrap the panel so a render throw becomes a card instead of an unmounted tree. */
    function withBoundary(Component) {
      const Boundary = guard(Component)
      if (Boundary === Component) return Component
      return function GuardedPanel(props) {
        return h(Boundary, null, h(Component, props))
      }
    }

    /**
     * v0.29 P0 — THE STATE THE PANEL FALLS BACK TO WHEN THE HOST DOES NOT ANSWER.
     *
     * The reported failure had several faces and ONE cause: the fetch failed, `state`
     * stayed null, and everything derived from it looked broken —
     *
     *   - every knob was `disabled: !canWrite` with `canWrite = state !== null`;
     *   - the derivation line rendered its "当前推导：读取中…" branch;
     *   - the header could report a failure while nothing was drawn, because one path
     *     returned before setting an error.
     *
     * A panel that cannot reach the Host is still useful for READING what the plugin
     * would use by default. So a failed fetch now yields a REAL state object carrying the
     * shipped defaults, tagged `degraded` with the reason. The knobs then reflect those
     * defaults and say so, which beats a dead panel — and a write attempt against them
     * will still fail loudly, which is correct: a default is not the live config.
     */
    function fallbackState(reason) {
      return {
        degraded: true,
        degradedReason: reason,
        config: {
          modelDrivenGraft: true,
          autoGraft: true,
          modelDrivenGraftAtRatio: 0.7,
          autoGraftAtRatio: 0.75,
          workspaceRedline: true,
          commandGuard: true,
          graftTargetGraceTurns: 2,
          safetyMode: 'balanced',
          watermarkMode: 'dynamic',
          constraintBudgetChars: 8000,
          growthTokensPerTurn: 1200,
          growthReserveTurns: 3,
          igniteTarget: true,
          ignitionMode: 'queue',
        },
        thresholds: null,
        rows: [],
        pendingIgnitions: [],
        sessions: [],
      }
    }

    function GraftConsole({ bridge, useSessions }) {
      /**
       * v0.26: hand the selector to the bridge BEFORE anything can request.
       *
       * This runs during render, above every effect and every callback, so by the time
       * `refresh` can fire the bridge already knows how to list sessions. If the hook is
       * absent the bridge stays empty and no request is made — the reported fix.
       */
      try {
        if (bridge !== undefined && typeof bridge.attach === 'function') bridge.attach(useSessions)
      } catch {
        // A bridge that cannot attach is a bridge that will report "no session".
      }
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [via, setVia] = React.useState('')
      /** v0.30: a visible write confirmation ("已保存到全局配置"). */
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      /**
       * v0.27 P0 — THE PANEL THAT NEVER WOKE UP.
       *
       * The report: the panel sat at "只读 / 没有活动会话", and stayed at "正在读取" even
       * after the user switched sessions. The bridge HAD the hook, so why?
       *
       * Because `useSessions` was being CALLED FROM AN EFFECT (via `bridge.canWrite()`).
       * A hook invoked outside render cannot subscribe, so a session change never
       * re-rendered this component. The panel was frozen at whatever the snapshot said
       * when it mounted — and on a fresh window that is nothing.
       *
       * The fix is to call it HERE, during render, and let its RESULT drive the element
       * tree. A SnapshotSelectorHook subscribes internally, so a session appearing
       * re-renders this component and every derived value below follows.
       *
       * Called unconditionally, so hook order is stable across renders.
       */
      const readSessions = (hooks) => {
        try {
          if (typeof hooks !== 'function') return []
          const snapshot = hooks((value) => value)
          if (snapshot === undefined || snapshot === null) return []
          const list = Array.isArray(snapshot)
            ? snapshot
            : Array.isArray(snapshot.sessions)
              ? snapshot.sessions
              : Array.isArray(snapshot.all)
                ? snapshot.all
                : Array.isArray(snapshot.list)
                  ? snapshot.list
                  : []
          const ids = []
          for (const entry of list) {
            const id =
              typeof entry === 'string'
                ? entry
                : entry && typeof entry.id === 'string'
                  ? entry.id
                  : entry && typeof entry.sessionId === 'string'
                    ? entry.sessionId
                    : ''
            if (id.length > 0 && !ids.includes(id)) ids.push(id)
          }
          return ids
        } catch {
          return []
        }
      }
      const liveSessions = readSessions(useSessions)
      /** Stable identity for "which sessions exist" — the effect dependency. */
      const sessionKey = liveSessions.join('\u0000')
      const activeFromHook = (() => {
        try {
          if (typeof useSessions !== 'function') return ''
          const snapshot = useSessions((value) => value)
          if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return ''
          const candidate = snapshot.activeSessionId ?? snapshot.currentSessionId ?? snapshot.active ?? snapshot.current
          return typeof candidate === 'string' ? candidate : ''
        } catch {
          return ''
        }
      })()
      /**
       * v0.23 — THE BLANK PANEL, and why this is a counter instead of useCallback.
       *
       * The symptom was precise: the sidebar ICON drew, the PANEL was pure white. Both
       * cells are function components in this same bundle; the only difference that
       * matters is that the icon calls nothing and the panel called
       * `React.useCallback`.
       *
       * The React surface the client sandbox advertises is exactly
       * `createElement` / `useState` / `useEffect`. `useCallback` is not on it. If the
       * sandbox hands a narrowed React (rather than the full module), the panel dies
       * with `TypeError: React.useCallback is not a function` — during render, before
       * a single node is committed, which is a white page and not a partial one. The
       * icon, calling no hook, still draws. That is the observed asymmetry.
       *
       * So: only the three advertised hooks are used now. The refetch that useCallback
       * existed to stabilise is driven by `tick`, which is STATE and therefore stable
       * by construction — bumping it re-runs the effect with no memo entry to get
       * wrong. Fewer moving parts AND a smaller API dependency.
       */
      /**
       * v0.25 — THE SESSION THE PANEL ACTS ON.
       *
       * Empty means "let the bridge pick the most recent live session". A root-scoped
       * panel has no inherent session binding, and useSessions can legitimately return
       * nothing (a fresh window with no conversation open). Rather than dead-end on
       * "没有可用的活动会话", the panel offers an explicit choice, and an explicit choice
       * is authoritative.
       */
      const [picked, setPicked] = React.useState('')
      const [tick, setTick] = React.useState(0)
      const refresh = () => setTick((value) => value + 1)

      React.useEffect(() => {
        let alive = true
        /**
         * `withTimeout` is defined at FACTORY scope (v1.0.0) — it used to be local to
         * this effect, which broke every `write` handler with a ReferenceError.
         */

        const run = async () => {
          if (bridge === undefined) {
            if (alive) { setError('桥接未注入（slot inject 缺失）'); setBusy(false) }
            return
          }
          /**
           * v0.26 P0 — THE AGENT GUARD, BEFORE ANY REQUEST.
           *
           * The reported bug: the panel correctly rendered its read-only UI, and then the
           * background fetch still went out with an undefined agent, so the gateway
           * rejected it and a red `remote.commands.execute` card appeared on top of a
           * panel that was already correctly saying "read only".
           *
           * The UI state was right; the TRAFFIC was not. So the guard lives here, at the
           * one choke point every request passes through, rather than in the renderer:
           *
           *   if no agent -> send nothing, keep existing data, raise no error.
           *
           * "Nobody has picked a session yet" is a NORMAL state for a root-scoped panel,
           * not a failure. Printing it in red would teach the user to ignore red.
           */
          /**
           * v0.27: resolve the target from the RENDER-TIME session list.
           *
           * `bridge.canWrite()` used to be asked here, and it called `useSessions` from
           * inside this effect — a hook outside render, which cannot subscribe and so
           * never saw a session change. The ids are computed during render now, and
           * `sessionKey` in the dependency array re-runs this effect on a switch.
           */
          const target = picked.length > 0
            ? picked
            : activeFromHook !== ''
              ? activeFromHook
              : liveSessions.length > 0
                ? liveSessions[liveSessions.length - 1]
                : ''
          /**
           * v0.28 P0 — ALWAYS FETCH.
           *
           * `/graft-console`'s Host handler takes NO agent: the whole payload (knobs,
           * thresholds, cost estimate, pending ignitions, session list) is produced from
           * Host state and the profile config. Gating the fetch on a resolved session —
           * as v0.26 did — blocked data that never needed one, which is why the panel sat
           * on "正在读取" forever and then reported "读取失败".
           *
           * A target id is still passed when one exists, so a session-scoped Host build
           * can use it; when none exists the bridge sends its shape-valid placeholder and
           * the Host ignores it.
           */
          if (alive) setBusy(true)
          try {
            /**
             * v0.29 P0 — A THREE-SECOND BUDGET AND A REAL FALLBACK.
             *
             * Twelve seconds is indistinguishable from "hang" to someone watching a
             * panel. And when it expired the panel was left with no state at all, so every
             * knob stayed disabled and the derivation line kept saying "读取中…" — several
             * symptoms, one cause: `state` never became non-null.
             *
             * Budget is now 3s, and a failure FALLS BACK to the shipped defaults so the
             * panel stays readable. The fallback is marked `degraded`, so the UI can say
             * "these are defaults" instead of pretending they are the live config.
             */
            const reply = await withTimeout(bridge.state(target), 3_000, '读取转生控制台')
            if (!alive) return
            setVia(String((reply && reply.via) || ''))
            if (!reply || !reply.ok) {
              const reason = String((reply && reply.text) || '宿主没有返回内容')
              setError(reason)
              setState((prev) => (prev !== null && prev !== undefined ? prev : fallbackState(reason)))
              return
            }
            // Parsing is the second place a blank panel can come from: a non-JSON
            // reply threw out of the component and React unmounted the tree.
            let parsed
            try {
              parsed = JSON.parse(reply.text)
            } catch (parseError) {
              const reason = `宿主返回的不是 JSON：${String((parseError && parseError.message) || parseError)}\n原始内容：${String(reply.text).slice(0, 500)}`
              setError(reason)
              setState((prev) => (prev !== null && prev !== undefined ? prev : fallbackState(reason)))
              return
            }
            setError('')
            setState(parsed)
          } catch (caught) {
            if (alive) {
              const reason = String((caught && caught.message) || caught)
              setError(reason)
              setState((prev) => (prev !== null && prev !== undefined ? prev : fallbackState(reason)))
            }
          } finally {
            if (alive) setBusy(false)
          }
        }
        void run()
        const timer = setInterval(() => { void run() }, 5000)
        return () => { alive = false; clearInterval(timer) }
        /**
         * v0.27: `sessionKey` (a plain string) instead of the array.
         *
         * A dependency array compares by reference, so passing `liveSessions` would re-run
         * the fetch on every render whenever the hook mints a fresh array. The joined ids
         * change only when the SET of sessions changes — exactly when a refetch is due.
         */
      }, [bridge, tick, picked, sessionKey])

      /**
       * `write` is a plain closure, recreated each render. That is fine: it is never a
       * dependency of an effect, so it needs no identity guarantee — which is the only
       * thing useCallback would have bought.
       */
      const write = async (key, value) => {
        try {
          /**
           * v0.30 P0 — a write is a GLOBAL write, bounded and confirmed.
           *
           * The knob lives in the profile patch, not in a conversation, so no session is
           * consulted. The call is wrapped in the same 3s budget as the read, because a
           * switch that hangs on click is worse than one that reports failure.
           */
          const reply = await withTimeout(bridge.set(key, value), 3_000, '写入配置')
          setVia(String((reply && reply.via) || ''))
          if (!reply || !reply.ok) { setError(String((reply && reply.text) || '写入失败')); return }
          // Visible confirmation, named the way the user asked for.
          setNotice('已保存到全局配置')
          // Optimistic: show the new value immediately, then let the refetch confirm it.
          setState((prev) => (prev === null ? prev : { ...prev, config: { ...(prev.config || {}), [key]: value } }))
          setError('')
          setTimeout(refresh, 400)
        } catch (caught) {
          setError(String((caught && caught.message) || caught))
        }
      }

      // v0.23: every field is read defensively. The Host returning a shape that is
      // merely INCOMPLETE (an older bundle, a half-mounted service) must cost a
      // section, never the whole panel.
      const config = state === null || state === undefined ? null : state.config || null
      const rows = state !== null && state !== undefined && Array.isArray(state.rows) ? state.rows : []
      const thresholds = state !== null && state !== undefined && state.thresholds ? state.thresholds : null
      const pending = state !== null && state !== undefined && Array.isArray(state.pendingIgnitions) ? state.pendingIgnitions : []
      const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

      /**
       * v0.27: the session list comes from the RENDER-TIME read, not from the bridge.
       *
       * The bridge's copy is whatever the hook returned last time somebody asked it —
       * and since that used to happen inside an effect, it never updated. `liveSessions`
       * is recomputed on every render and therefore follows a session switch.
       */
      /**
       * v0.28 P0 — WHERE THE SESSION LIST ACTUALLY COMES FROM, in priority order.
       *
       *   1. THE HOST PAYLOAD. `state.sessions` is produced by `sessions.list()` on the
       *      Host — the only place that method exists. Authoritative, and works even when
       *      the Client exposes nothing.
       *   2. THE HOOK. `useSessions`, when the owner actually projects something.
       *   3. Nothing.
       *
       * v0.27 relied on (2) alone, and on this sidebar it returns an empty list — so the
       * selector never appeared even though a session was plainly open. The panel was
       * asking the one party that could not answer.
       */
      const hostSessions = state !== null && state !== undefined && Array.isArray(state.sessions)
        ? state.sessions
            .map((entry) => (entry && typeof entry.sessionId === 'string' ? entry.sessionId : typeof entry === 'string' ? entry : ''))
            .filter((id) => id.length > 0)
        : []
      const sessions = hostSessions.length > 0 ? hostSessions : liveSessions
      const sessionSource = hostSessions.length > 0 ? 'host' : liveSessions.length > 0 ? 'hook' : 'none'
      /** The session this panel acts on. */
      const effectiveSession = picked.length > 0 ? picked : activeFromHook !== '' ? activeFromHook : sessions.length > 0 ? sessions[sessions.length - 1] : ''
      /**
       * v0.28: knobs are GLOBAL settings, so they are editable whenever the Host is
       * reachable. v0.26 gated them on a session, which left the panel inert in exactly
       * the case where a session was not exposed. Session-scoped views (the watermark
       * table) are greyed separately.
       */
      const canWrite = state !== null && state !== undefined
      const hasSession = effectiveSession.length > 0

      /**
       * v1.0.2 P2 — HEALTH, STATED AT THE TOP INSTEAD OF DISCOVERED PER CARD.
       *
       * Every failure this panel has had in production (dead bridge, rejected agent,
       * stringified envelope, stale defaults) looked IDENTICAL in the UI: plausible
       * numbers that never move. One badge answers "is this data real?" before the
       * operator reads a single switch.
       *
       * Red = no host data at all, or the Host itself said it degraded. Amber = data is
       * there but the derivation is missing. Green = the numbers came from the Host.
       */
      const health =
        state === null || state === undefined
          ? { level: 'red', text: '宿主通道未连通', hint: `桥接通道：${via || '（无）'}${error ? `；原因：${String(error).slice(0, 200)}` : ''}` }
          : state.degraded === true
            ? {
                level: 'red',
                text: '宿主通道降级',
                hint: String(state.degradedReason || '宿主返回了降级状态：上面的数值是插件默认值，不是真实配置。'),
              }
            : thresholds === null
              ? { level: 'amber', text: '已连通 · 推导缺失', hint: '配置读到了，但阈值/代价推导为空，请点「刷新」重试。' }
              : { level: 'green', text: '宿主通道正常', hint: `桥接通道：${via || '（未知）'}；每 5 秒自动刷新。` }
      const healthColor = health.level === 'green' ? '#16a34a' : health.level === 'amber' ? '#b45309' : '#b91c1c'

      return h('div', { className: 'gc-root' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'head' }, [
          h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
            h('h2', { key: 't', className: 'gc-h', style: { fontSize: '16px', margin: 0 } }, '转生控制台 · dsh-graft-slice'),
            h(
              'span',
              {
                key: 'health',
                className: 'gc-badge',
                title: health.hint,
                style: { color: healthColor, borderColor: healthColor, fontWeight: 600 },
              },
              `${health.level === 'green' ? '●' : health.level === 'amber' ? '▲' : '●'} ${health.text}`,
            ),
          ]),
          h('p', { key: 's', className: 'gc-sub' },
            '改动直接写入 profile 配置（configEditor），下一次 pre-step 生效，无需重启。'),
        ]),
        /**
         * v0.29 P0 — AN UNMISSABLE ERROR CARD.
         *
         * "显示读取失败但下方没有渲染红卡" is what a conditional `error ? … : null`
         * produces when a failure path forgets to set `error`. Two fixes: the card is
         * keyed on BOTH `error` and `state.degraded`, and it is a plain inline-styled
         * div carrying the raw text — a diagnostic that depends on the styling layer it
         * is diagnosing is not a diagnostic.
         */
        error || (state !== null && state !== undefined && state.degraded === true)
          ? h('div', {
              key: 'e',
              style: {
                border: '1px solid #b91c1c',
                borderRadius: '8px',
                padding: '12px 14px',
                background: 'rgba(185,28,28,.08)',
                color: '#b91c1c',
                font: '13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            }, [
              h('div', { key: 't', style: { fontWeight: 600, marginBottom: '6px' } }, '读取失败'),
              h('div', { key: 'm' }, String(error || (state && state.degradedReason) || '(宿主没有返回可识别的错误信息)')),
              /**
               * v0.30: the RAW failure, as JSON. The user's rule is explicit — make the
               * error visible before trying to make it pretty. A panel that hides why it
               * failed cannot be debugged from the page.
               */
              h('div', { key: 'raw', style: { marginTop: '8px', fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '11.5px', opacity: 0.85 } },
                '错误详情：' + JSON.stringify({
                  message: String(error || ''),
                  degradedReason: state && state.degradedReason ? String(state.degradedReason) : undefined,
                  via: via || undefined,
                })),
              h('div', { key: 'h', style: { marginTop: '8px', opacity: 0.8 } },
                '以上开关显示的是插件默认值，不是宿主的真实配置。点击「刷新」重试。'),
            ])
          : null,
        /** v0.30: the write confirmation, rendered next to the error card. */
        notice ? h('div', {
          key: 'n',
          style: {
            border: '1px solid #047857',
            borderRadius: '8px',
            padding: '10px 14px',
            background: 'rgba(4,120,87,.08)',
            color: '#047857',
            font: '13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif',
          },
        }, notice) : null,
        /**
         * v0.25 — THE SESSION SELECTOR.
         *
         * A root-scoped panel may see zero sessions. Reporting that as a dead end made
         * the console useless in exactly the situation a user opens it (a fresh window,
         * nothing running). The choices are:
         *
         *   - sessions available -> default to the newest, allow switching
         *   - none available     -> say so ONCE, and keep the READ-ONLY view alive so the
         *                           live watermark is still visible
         */
        h('div', { key: 'session', className: 'gc-card' }, [
          h('div', { key: 'hh', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
            h('h3', { key: 'h', className: 'gc-h', style: { margin: 0 } }, '目标会话'),
            // v0.27: a manual refresh, so an unverifiable "reactivity" assumption is
            // something the user can override with one click.
            h('button', {
              key: 'rf',
              type: 'button',
              className: 'gc-btn',
              disabled: busy,
              onClick: refresh,
              title: '立即重新拉取状态（全局数据不需要会话）',
            }, busy ? '读取中…' : '刷新'),
          ]),
          h('p', { key: 's', className: 'gc-sub' },
            sessions.length === 0
              /**
               * v0.28: GLOBAL MODE is a real mode, not a degraded dead end.
               *
               * Everything below — the knobs, the thresholds, the cost estimate, the
               * ignition settings — comes from Host state and the profile config and is
               * session-INDEPENDENT, so it is loaded and editable. Only the live watermark
               * table needs a session, and it says so instead of greying the whole panel.
               */
              ? '全局模式：以下开关写入 profile 配置（与具体会话无关），可以直接调节并落盘。实时水位需要打开一个会话后才显示。'
              : `命令会以会话 ${effectiveSession} 的身份执行（列表来源：${sessionSource === 'host' ? '宿主 sessions.list' : 'useSessions'}）。切换会立即重新读取。`),
          sessions.length === 0
            ? null
            : h('div', { key: 'r', className: 'gc-row' }, [
                h('span', { key: 'l', className: 'gc-label' }, '会话'),
                h('select', {
                  key: 'sel',
                  className: 'gc-select',
                  value: picked,
                  'aria-label': '目标会话',
                  onChange: (event) => {
                    setPicked(String(event.target.value || ''))
                    setState(null)
                    setError('')
                    setTick((value) => value + 1)
                  },
                }, [
                  h('option', { key: '', value: '' }, sessions.length > 0 ? `（默认：${effectiveSession}）` : '（最新一个）'),
                  ...sessions.map((id) => h('option', { key: id, value: id }, id)),
                ]),
              ]),
        ]),
        h('div', { key: 'sw', className: 'gc-card' }, [
          h('h3', { key: 'h', className: 'gc-h' }, '核心开关'),
          h(Toggle, {
            key: 'mdg',
            label: '主动转生（modelDrivenGraft）',
            hint: '到提示线提醒模型自己收尾并 graft_prepare；关掉后模型不会被提示',
            checked: config ? config.modelDrivenGraft === true : false,
            onChange: (next) => write('modelDrivenGraft', next),
            disabled: !canWrite,
          }),
          h(Toggle, {
            key: 'ag',
            label: '强制兜底（autoGraft）',
            hint: '到强制线由系统强制迁移，模型忽略提示也不会无限硬扛',
            checked: config ? config.autoGraft === true : false,
            onChange: (next) => write('autoGraft', next),
            disabled: !canWrite,
          }),
        ]),
        h('div', { key: 'ratio', className: 'gc-card' }, [
          h('h3', { key: 'h', className: 'gc-h' }, '水位阈值'),
          h(Ratio, {
            key: 'w',
            label: '提示线（modelDrivenGraftAtRatio）',
            hint: '默认 0.70；固定模式下生效，动态模式下是提示线的下限来源',
            value: config ? config.modelDrivenGraftAtRatio : 0.7,
            onChange: (next) => write('modelDrivenGraftAtRatio', next),
            disabled: !canWrite,
          }),
          h(Ratio, {
            key: 'h',
            label: '强制线（autoGraftAtRatio）',
            hint: '默认 0.75；固定模式下的兜底水位，动态模式下是最晚可切的天花板',
            value: config ? config.autoGraftAtRatio : 0.75,
            onChange: (next) => write('autoGraftAtRatio', next),
            disabled: !canWrite,
          }),
        ]),
        h('div', { key: 'modes', className: 'gc-card' }, [
          h('h3', { key: 'h', className: 'gc-h' }, '模式与容量（v0.18）'),
          h(Segmented, {
            key: 'wm',
            label: '水位来源（watermarkMode）',
            hint: 'dynamic：按窗口与一次交接的估价推导；fixed：直接用上面两个常量',
            value: config ? config.watermarkMode : 'dynamic',
            options: [
              { value: 'dynamic', label: '动态', title: '推导 safeCeiling = 1 - 估价/窗口' },
              { value: 'fixed', label: '固定', title: '原样使用两个常量（差分测试用）' },
            ],
            onChange: (next) => write('watermarkMode', next),
            disabled: !canWrite,
          }),
          h(Segmented, {
            key: 'sm',
            label: '命令策略（safetyMode）',
            hint: 'strict 全拒未知/破坏性；balanced 默认；autonomous 对破坏性只 ASK，不静默执行',
            value: config ? config.safetyMode : 'balanced',
            options: [
              { value: 'strict', label: 'strict' },
              { value: 'balanced', label: 'balanced' },
              { value: 'autonomous', label: 'autonomous' },
            ],
            onChange: (next) => write('safetyMode', next),
            disabled: !canWrite,
          }),
          h(NumberRow, {
            key: 'cb',
            label: '硬约束容量（constraintBudgetChars）',
            hint: '装不下的规则会让迁移抛 GRAFT_ABORTED，而不是静默缩短规则集',
            value: config ? config.constraintBudgetChars : 8000,
            min: 500,
            max: 200000,
            onChange: (next) => write('constraintBudgetChars', next),
            disabled: !canWrite,
          }),
          h(NumberRow, {
            key: 'gt',
            label: '增长预测（growthTokensPerTurn）',
            hint: '每轮新增 token 的估计（工具长尾）；越大 → 越早切',
            value: config ? config.growthTokensPerTurn : 1200,
            min: 0,
            max: 100000,
            onChange: (next) => write('growthTokensPerTurn', next),
            disabled: !canWrite,
          }),
          h('p', { key: 'derived', className: 'gc-sub', style: { margin: '10px 0 0' } },
            thresholds
              ? `当前推导：强制线 ${(num(thresholds.hardAt, 0.75) * 100).toFixed(2)}% · 提示线 ${(num(thresholds.warnAt, 0.7) * 100).toFixed(2)}%` +
                ` · 单次交接估价 ${num(thresholds.estimatedGraftCost, 0).toLocaleString()} tok` +
                (thresholds.feasible === false ? ' · ⚠ 该窗口装不下一次交接（feasible=false）' : '')
              // v0.24: "读取中" only while a fetch is genuinely in flight. After a failure
              // the line says so, instead of spinning forever with no explanation.
              : busy ? '当前推导：读取中…' : '当前推导：读取失败（原因见下方红卡），开关显示的是默认值。'),
        ]),
        h('div', { key: 'guard', className: 'gc-card' }, [
          h('h3', { key: 'h', className: 'gc-h' }, '护栏'),
          h(Toggle, {
            key: 'wr',
            label: '工作目录红线（workspaceRedline）',
            hint: '注入「工作目录严格限定为 <cwd>」；建议保持开启',
            checked: config ? config.workspaceRedline === true : false,
            onChange: (next) => write('workspaceRedline', next),
            disabled: !canWrite,
          }),
          h(Toggle, {
            key: 'cg',
            label: '命令层拦截（commandGuard）',
            hint: '在工具层拒绝越界搜索与逃出工作区的递归删除',
            checked: config ? config.commandGuard === true : false,
            onChange: (next) => write('commandGuard', next),
            disabled: !canWrite,
          }),
        ]),
        h('div', { key: 'ignite', className: 'gc-card' }, [
          h('h3', { key: 'h', className: 'gc-h' }, '物理点火（v0.19）'),
          h(Toggle, {
            key: 'it',
            label: '落盘后自动唤醒（igniteTarget）',
            hint: '目标会话 flush 成功后由宿主 sessionController.prompt 直接开跑，无需人工点击',
            checked: config ? config.igniteTarget === true : false,
            onChange: (next) => write('igniteTarget', next),
            disabled: !canWrite,
          }),
          h(Segmented, {
            key: 'im',
            label: '唤醒投递方式（ignitionMode）',
            hint: 'queue：作为下一条用户输入；steer：插到当前轮之前',
            value: config ? config.ignitionMode : 'queue',
            options: [
              { value: 'queue', label: 'queue' },
              { value: 'steer', label: 'steer' },
            ],
            onChange: (next) => write('ignitionMode', next),
            disabled: !canWrite,
          }),
          pending.length > 0
            ? h('p', { key: 'p', className: 'gc-sub', style: { color: '#b45309', margin: '8px 0 0' } },
                `未点火（已排队重试）：${pending.map((item) => `${item.targetId}（第 ${item.attempts} 次）`).join('、')}`)
            : h('p', { key: 'p', className: 'gc-hint', style: { margin: '8px 0 0' } },
                '当前没有待点火的会话。'),
        ]),
        h('div', { key: 'live', className: 'gc-card' }, [
          h('div', { key: 'h', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
            h('h3', { key: 't', className: 'gc-h', style: { margin: 0 } }, '实时水位'),
            h('button', { key: 'b', type: 'button', className: 'gc-btn', disabled: busy, onClick: refresh }, busy ? '读取中…' : '刷新'),
          ]),
          h('p', { key: 's', className: 'gc-sub' },
            via ? `桥接通道：${via}` : '每 5 秒自动刷新；水位来自宿主 tokenMeter / provider usage'),
          // v0.23: `state.rows.length` used to be read without checking that rows is
          // an ARRAY at all — an incomplete Host payload blanked the panel here.
          state === null
            ? h('div', { key: 'n', className: 'gc-hint' }, '正在读取…')
            : rows.length === 0
              ? h('div', { key: 'n', className: 'gc-hint' }, '当前没有可测量的活动会话。')
              : h('table', { key: 'tb', className: 'gc-table' }, [
                  h('thead', { key: 'th' }, h('tr', null, [
                    h('th', { key: 'a' }, '会话'),
                    h('th', { key: 'b' }, '水位'),
                    h('th', { key: 'c' }, '距下一次转生'),
                    h('th', { key: 'd' }, '状态'),
                  ])),
                  h('tbody', { key: 'tb' }, rows.map((row) => h(SessionRow, {
                    key: String(row && row.sessionId),
                    row: row || {},
                  }))),
                ]),
        ]),
        // v0.23: a raw dump, always present and collapsed-looking, so "is the Host
        // returning data at all" is answerable from the page instead of from devtools.
        h('details', { key: 'raw', className: 'gc-card' }, [
          h('summary', { key: 's', style: { cursor: 'pointer', fontSize: '12px', opacity: 0.7 } },
            '原始状态数据（排查用）'),
          h('pre', { key: 'p', className: 'gc-mono', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: '8px' } },
            state === null ? '(尚未读取)' : JSON.stringify(state, null, 2).slice(0, 8000)),
        ]),
      ])
    }

    /**
     * The sidebar cell renders the ICON ONLY.
     *
     * v0.22: it used to render an icon AND a text span '转生', while the panellist
     * registration ALSO supplies `label: () => '转生'` for the owner to render. Both
     * drew text, which is why the sidebar showed "转生 转生". The owner projects the
     * label; the cell is the icon.
     */
    function SidebarEntry() {
      return h('span', { 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'center' } }, [
        h('svg', { key: 'i', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }, [
          h('path', { key: 'p', d: 'M4 17c3-9 7-9 10-2s5 5 6 1' }),
          h('circle', { key: 'c', cx: 4, cy: 17, r: 1.6, fill: 'currentColor', stroke: 'none' }),
        ]),
      ])
    }

    return {
      /**
       * v0.22: `remote` and `remote.commands` are SERVICES, not package names.
       *
       * The page kept reporting `cannot get property "remote.commands" without
       * inject` after the previous fix because that fix declared a package in
       * `dsh.client` — that orders bundle LOADING, it does not grant service access.
       * The official client plugins declare the service keys themselves
       * (`["sessions", "remote", "remote.commands", ...]`), and the Cordis property
       * guard reads exactly this array.
       */
      inject: ['slots', 'remote', 'remote.commands'],
      apply(ctx) {
        /**
         * v0.26 — WHERE `useSessions` ACTUALLY COMES FROM.
         *
         * v0.24 assumed the `inject` callback receives the slot props. It does not: the
         * root-scoped `InjectParams` tuple is EMPTY (`[]`), so `inject: (props) => ...`
         * was handed `undefined` and the bridge's `sessionIdsFromProps()` always returned
         * `[]`. That is why the panel kept reporting "no session" even after the
         * useSessions fix — the hook never reached the bridge at all.
         *
         * The standard selector hooks are delivered as COMPONENT PROPS (`useSessions` et
         * al.), not through inject. So the bridge is built with `ctx` only, and the
         * component hands it the hook it received:
         *
         *     function GraftConsole({ bridge, useSessions }) { ... }
         *
         * `bridge.attach(useSessions)` is called from the component body so the bridge can
         * resolve sessions from then on. Until that happens (or when the hook is absent)
         * `sessions()` returns `[]` and NO request is made — which is the reported fix.
         */
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_KEY,
              inject: () => ({ bridge: makeBridge(ctx, host) }),
            },
            withBoundary(GraftConsole),
          ),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 60, label: () => '转生' }, withBoundary(SidebarEntry)),
        )
      },
      // Kept on the module so a wiring fix needs no rebuild of the panel body.
      __bridgeFactory: makeBridge,
      /**
       * v0.23: test seams. The blank-panel regression was invisible to the unit suite
       * because nothing ever RENDERED a component — the bundle was only string-matched.
       * These let `test/v023-panel-render.test.mjs` call each piece against a React that
       * offers only the documented symbols, which is the environment that broke.
       */
      __panelForTest: GraftConsole,
      __sessionRowForTest: SessionRow,
      __guardForTest: guard,
    }
  },
})
