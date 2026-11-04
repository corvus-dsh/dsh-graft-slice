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
      const sessionIdsFromProps = () => {
        try {
          if (slotProps === undefined || slotProps === null) return []
          const useSessions = slotProps.useSessions
          if (typeof useSessions !== 'function') return []
          // `useSessions(selector)` is a SnapshotSelectorHook. A selector that returns
          // the whole snapshot is the only thing safe to call from a non-render context,
          // and we only need the id list, so ask for exactly that.
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
       * Resolve ONE valid `{ id }` agent, or undefined with the reason recorded.
       *
       * `remote.commands.execute` needs the agent of the session the command runs FOR.
       * Root-scoped panels are not bound to a session, so the honest choice is the most
       * recently active one — which is what a user is looking at when they open a
       * console panel.
       */
      const agentOf = () => {
        const ids = sessionIdsFromProps()
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

      const callHost = async (line) => {
        const failures = []
        const agent = agentOf()

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
          if (agent === undefined) {
            failures.push('remote.commands.execute: 没有可用的活动会话（agent 参数必填，伪造会被 gateway 拒绝）')
          } else {
            try {
              const settled = await commands.execute(agent, line, [], undefined)
              const text = settled && settled.result && typeof settled.result.text === 'string' ? settled.result.text : undefined
              if (text !== undefined) return { ok: settled.result.kind !== 'error', text, via: 'remote.commands.execute' }
              if (settled !== undefined) return { ok: true, text: JSON.stringify(settled), via: 'remote.commands.execute' }
              failures.push('remote.commands.execute: returned undefined (the command name did not resolve)')
            } catch (error) {
              const message = String((error && error.message) || error)
              // The gateway error is the most informative thing we have; keep it whole.
              failures.push(`remote.commands.execute: ${message}`)
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
        state: () => callHost('/graft-console'),
        set: (key, value) => callHost(`/graft-console-set ${key} ${value}`),
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

    function Toggle({ label, hint, checked, onChange }) {
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
          onClick: () => onChange(!checked),
        }, h('i', null)),
      ])
    }

    function Ratio({ label, hint, value, onChange }) {
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
          onChange: (event) => onChange(Number(event.target.value)),
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
          onChange: (event) => setDraft(event.target.value),
          onBlur: () => commit(draft),
          onKeyDown: (event) => { if (event.key === 'Enter') commit(draft) },
        }),
        h('span', { key: 'p', className: 'gc-hint' }, `${Math.round(value * 100)}%`),
      ])
    }

    function Segmented({ label, hint, value, options, onChange }) {
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
            onClick: () => onChange(option.value),
          }, option.label))),
      ])
    }

    /** A bounded integer knob (v0.18 capacity/rate settings). */
    function NumberRow({ label, hint, value, min, max, onChange }) {
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

    function GraftConsole({ bridge }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [via, setVia] = React.useState('')
      const [busy, setBusy] = React.useState(false)
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
      const [tick, setTick] = React.useState(0)
      const refresh = () => setTick((value) => value + 1)

      React.useEffect(() => {
        let alive = true
        /**
         * v0.24: a HARD timeout on the fetch.
         *
         * The bridge awaits a Remote call, and the panel used to sit on "读取中…"
         * indefinitely when that call neither resolved nor rejected — a channel that is
         * mounted but not answering looks exactly like a slow one. `busy` could never
         * clear, so the UI had no way back.
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

        const run = async () => {
          if (bridge === undefined) {
            if (alive) { setError('桥接未注入（slot inject 缺失）'); setBusy(false) }
            return
          }
          if (alive) setBusy(true)
          try {
            const reply = await withTimeout(bridge.state(), 12_000, '读取转生控制台')
            if (!alive) return
            setVia(String((reply && reply.via) || ''))
            if (!reply || !reply.ok) {
              setError(String((reply && reply.text) || '宿主没有返回内容'))
              return
            }
            // Parsing is the second place a blank panel can come from: a non-JSON
            // reply threw out of the component and React unmounted the tree.
            let parsed
            try {
              parsed = JSON.parse(reply.text)
            } catch (parseError) {
              setError(`宿主返回的不是 JSON：${String((parseError && parseError.message) || parseError)}\n原始内容：${String(reply.text).slice(0, 500)}`)
              return
            }
            setError('')
            setState(parsed)
          } catch (caught) {
            if (alive) setError(String((caught && caught.message) || caught))
          } finally {
            if (alive) setBusy(false)
          }
        }
        void run()
        const timer = setInterval(() => { void run() }, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [bridge, tick])

      /**
       * `write` is a plain closure, recreated each render. That is fine: it is never a
       * dependency of an effect, so it needs no identity guarantee — which is the only
       * thing useCallback would have bought.
       */
      const write = async (key, value) => {
        try {
          const reply = await bridge.set(key, value)
          setVia(String((reply && reply.via) || ''))
          if (!reply || !reply.ok) { setError(String((reply && reply.text) || '写入失败')); return }
          // Optimistic: the panel shows the new value immediately and the refetch
          // confirms it, so a slow Loader reconciliation does not read as a failure.
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

      return h('div', { className: 'gc-root' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'head' }, [
          h('h2', { key: 't', className: 'gc-h', style: { fontSize: '16px' } }, '转生控制台 · dsh-graft-slice'),
          h('p', { key: 's', className: 'gc-sub' },
            '改动直接写入 profile 配置（configEditor），下一次 pre-step 生效，无需重启。'),
        ]),
        error ? h('div', { key: 'e', className: 'gc-card gc-err' }, error) : null,
        h('div', { key: 'sw', className: 'gc-card' }, [
          h('h3', { key: 'h', className: 'gc-h' }, '核心开关'),
          h(Toggle, {
            key: 'mdg',
            label: '主动转生（modelDrivenGraft）',
            hint: '到提示线提醒模型自己收尾并 graft_prepare；关掉后模型不会被提示',
            checked: config ? config.modelDrivenGraft === true : false,
            onChange: (next) => write('modelDrivenGraft', next),
          }),
          h(Toggle, {
            key: 'ag',
            label: '强制兜底（autoGraft）',
            hint: '到强制线由系统强制迁移，模型忽略提示也不会无限硬扛',
            checked: config ? config.autoGraft === true : false,
            onChange: (next) => write('autoGraft', next),
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
          }),
          h(Ratio, {
            key: 'h',
            label: '强制线（autoGraftAtRatio）',
            hint: '默认 0.75；固定模式下的兜底水位，动态模式下是最晚可切的天花板',
            value: config ? config.autoGraftAtRatio : 0.75,
            onChange: (next) => write('autoGraftAtRatio', next),
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
          }),
          h(NumberRow, {
            key: 'cb',
            label: '硬约束容量（constraintBudgetChars）',
            hint: '装不下的规则会让迁移抛 GRAFT_ABORTED，而不是静默缩短规则集',
            value: config ? config.constraintBudgetChars : 8000,
            min: 500,
            max: 200000,
            onChange: (next) => write('constraintBudgetChars', next),
          }),
          h(NumberRow, {
            key: 'gt',
            label: '增长预测（growthTokensPerTurn）',
            hint: '每轮新增 token 的估计（工具长尾）；越大 → 越早切',
            value: config ? config.growthTokensPerTurn : 1200,
            min: 0,
            max: 100000,
            onChange: (next) => write('growthTokensPerTurn', next),
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
          }),
          h(Toggle, {
            key: 'cg',
            label: '命令层拦截（commandGuard）',
            hint: '在工具层拒绝越界搜索与逃出工作区的递归删除',
            checked: config ? config.commandGuard === true : false,
            onChange: (next) => write('commandGuard', next),
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
         * v0.24: build the bridge PER SLOT INSTANCE, from the props the owner supplies.
         *
         * `inject` is called with the slot props, and `main` is root-scoped — it gets the
         * standard selector hooks including `useSessions`, which is the supported way to
         * learn the live session list from a root panel. Building the bridge once in
         * `apply` would freeze it before any session existed, which is how the panel
         * ended up with no agent and therefore no data.
         */
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_KEY,
              inject: (props) => ({ bridge: makeBridge(ctx, host, props) }),
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
