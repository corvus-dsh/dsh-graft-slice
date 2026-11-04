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
    function makeBridge(ctx, host) {
      const callHost = async (method, args) => {
        const failures = []
        // 1. the package-private RPC: no inject declaration needed, no namespace guard.
        if (host !== undefined && typeof host.call === 'function') {
          try {
            const value = await host.call(method, args)
            return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value), via: `host.call(${method})` }
          } catch (error) {
            failures.push(`host.call(${method}): ${String((error && error.message) || error)}`)
          }
        }
        // 2. the generated namespace, when this composition declares it.
        const remote = (() => {
          try {
            return ctx && ctx.get ? ctx.get('remote') : undefined
          } catch (error) {
            failures.push(`ctx.get('remote'): ${String((error && error.message) || error)}`)
            return undefined
          }
        })()
        const namespace = remote && remote.commands
        if (namespace && typeof namespace.execute === 'function') {
          try {
            const settled = await namespace.execute(method, args, [], undefined)
            const text = settled && settled.result && typeof settled.result.text === 'string' ? settled.result.text : undefined
            if (text !== undefined) return { ok: settled.result.kind !== 'error', text, via: 'remote.commands.execute' }
            if (settled !== undefined) return { ok: true, text: JSON.stringify(settled), via: 'remote.commands.execute' }
          } catch (error) {
            failures.push(`remote.commands.execute: ${String((error && error.message) || error)}`)
          }
        }
        return {
          ok: false,
          via: 'none',
          text:
            `面板无法调用宿主（${failures.length === 0 ? '没有可用的 Client→Host 通道' : failures.join(' | ')}）。\n` +
            `请在输入框直接执行：/${method.startsWith('graft') || method.startsWith('memory') ? method : 'graft-console'}`,
        }
      }
      return {
        state: () => callHost('graft-console', null),
        set: (key, value) => callHost('graft-console-set', { rawInput: `${key} ${value}` }),
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
      const color = row.state === 'over-hard-cutoff' ? '#b91c1c' : row.state === 'over-warn-line' ? '#b45309' : '#10b981'
      const cls = row.state === 'over-hard-cutoff' ? 'gc-over' : row.state === 'over-warn-line' ? 'gc-warn' : 'gc-ok'
      const warnAt = typeof row.warnAt === 'number' ? row.warnAt : 0.7
      const hardAt = typeof row.hardAt === 'number' ? row.hardAt : 0.75
      return h('tr', null, [
        h('td', { key: 'id' }, [
          h('div', { key: 'a', className: 'gc-mono' }, row.sessionId),
          h('div', { key: 'b', className: 'gc-hint' }, row.cwd || '(未记录工作目录)'),
        ]),
        h('td', { key: 'w' }, [
          h('div', { key: 'a' }, `${row.percent}% · ${row.tokens.toLocaleString()} / ${row.contextWindow.toLocaleString()}`),
          h('div', { key: 'b', className: 'gc-bar' }, h('span', { style: { width: `${Math.min(100, row.percent)}%`, background: color } })),
          h('div', { key: 'c', className: 'gc-hint' }, `数据来源 ${row.source}`),
        ]),
        h('td', { key: 'd' }, [
          h('div', { key: 'a' }, `→提示线 ${Math.round(warnAt * 100)}% 还差 ${row.toWarnTokens.toLocaleString()} tok`),
          h('div', { key: 'b', className: 'gc-hint' }, `→强制线 ${Math.round(hardAt * 100)}% 还差 ${row.toHardTokens.toLocaleString()} tok`),
        ]),
        h('td', { key: 's' }, [
          h('span', { key: 'a', className: `gc-badge ${cls}` }, row.state),
          row.generation > 0
            ? h('div', { key: 'b', className: 'gc-hint' }, `第 ${row.generation} 代${row.graceTurnsRemaining > 0 ? ` · 保护中 ${row.graceTurnsRemaining} 轮` : ''}`)
            : h('div', { key: 'b', className: 'gc-hint' }, '原始会话'),
        ]),
      ])
    }

    function GraftConsole({ bridge }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [via, setVia] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const refresh = React.useCallback(async () => {
        if (bridge === undefined) { setError('桥接未注入（slot inject 缺失）'); return }
        setBusy(true)
        try {
          const reply = await bridge.state()
          setVia(reply.via)
          if (!reply.ok) { setError(reply.text); return }
          setError('')
          setState(JSON.parse(reply.text))
        } catch (caught) {
          setError(String((caught && caught.message) || caught))
        } finally {
          setBusy(false)
        }
      }, [bridge])

      const write = React.useCallback(async (key, value) => {
        const reply = await bridge.set(key, value)
        setVia(reply.via)
        if (!reply.ok) { setError(reply.text); return }
        // Optimistic: the panel shows the new value immediately and the refetch
        // confirms it, so a slow Loader reconciliation does not read as a failure.
        setState((prev) => (prev === null ? prev : { ...prev, config: { ...prev.config, [key]: value } }))
        setError('')
        setTimeout(refresh, 400)
      }, [bridge, refresh])

      React.useEffect(() => { void refresh() }, [refresh])
      React.useEffect(() => {
        const timer = setInterval(() => { void refresh() }, 5000)
        return () => clearInterval(timer)
      }, [refresh])

      const config = state === null ? null : state.config

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
            state && state.thresholds
              ? `当前推导：强制线 ${(state.thresholds.hardAt * 100).toFixed(2)}% · 提示线 ${(state.thresholds.warnAt * 100).toFixed(2)}%` +
                ` · 单次交接估价 ${state.thresholds.estimatedGraftCost.toLocaleString()} tok` +
                (state.thresholds.feasible ? '' : ' · ⚠ 该窗口装不下一次交接（feasible=false）')
              : '当前推导：读取中…'),
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
          state && state.pendingIgnitions && state.pendingIgnitions.length > 0
            ? h('p', { key: 'p', className: 'gc-sub', style: { color: '#b45309', margin: '8px 0 0' } },
                `未点火（已排队重试）：${state.pendingIgnitions.map((item) => `${item.targetId}（第 ${item.attempts} 次）`).join('、')}`)
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
          state === null
            ? h('div', { key: 'n', className: 'gc-hint' }, '正在读取…')
            : state.rows.length === 0
              ? h('div', { key: 'n', className: 'gc-hint' }, '当前没有可测量的活动会话。')
              : h('table', { key: 'tb', className: 'gc-table' }, [
                  h('thead', { key: 'th' }, h('tr', null, [
                    h('th', { key: 'a' }, '会话'),
                    h('th', { key: 'b' }, '水位'),
                    h('th', { key: 'c' }, '距下一次转生'),
                    h('th', { key: 'd' }, '状态'),
                  ])),
                  h('tbody', { key: 'tb' }, state.rows.map((row) => h(SessionRow, {
                    key: row.sessionId,
                    row,
                  }))),
                ]),
        ]),
      ])
    }

    function SidebarEntry() {
      return h('span', { 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, [
        h('svg', { key: 'i', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }, [
          h('path', { key: 'p', d: 'M4 17c3-9 7-9 10-2s5 5 6 1' }),
          h('circle', { key: 'c', cx: 4, cy: 17, r: 1.6, fill: 'currentColor', stroke: 'none' }),
        ]),
        h('span', { key: 'l' }, '转生'),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // v0.21: `host` is threaded through so the bridge has a channel that needs
        // no inject declaration at all.
        const bridge = makeBridge(ctx, host)
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY, inject: () => ({ bridge }) }, GraftConsole),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 60, label: () => '转生' }, SidebarEntry),
        )
      },
      // Kept on the module so a wiring fix needs no rebuild of the panel body.
      __bridgeFactory: makeBridge,
    }
  },
})
