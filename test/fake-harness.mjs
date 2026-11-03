/**
 * Test/demo harness for dsh-graft-slice.
 *
 * This is not a DSH runtime. It mirrors the parts of the real session and
 * persistence contracts the plugin depends on, and it enforces the same red
 * lines so a regression fails locally before a cold restart does.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SURFACE = new Set(['system/message', 'user/message', 'assistant/message'])

let nextTime = 1_700_000_000_000

function clone(value) {
  return structuredClone(value)
}

export class FakeSession {
  constructor(id, header) {
    this.id = id
    this.header = header
    this.log = []
  }

  get seq() {
    return this.log.length
  }

  append(type, data, opts) {
    if (SURFACE.has(type)) {
      if (opts?.surfaceOp !== 'append') throw new Error(`${type} requires surfaceOp:'append'`)
      if (type === 'assistant/message') {
        if ('sourceEventSeqs' in (opts ?? {})) throw new Error('assistant/message cannot carry sourceEventSeqs')
        if (!Array.isArray(data?.stream) || data.stream.length !== 0) throw new Error('assistant/message stream must be []')
        if (typeof data?.message?.id !== 'string' || data.message.id.length === 0) throw new Error('assistant message id required')
        if (data?.message?.role !== 'assistant') throw new Error('assistant message role required')
        const kind = data?.message?.source?.kind
        if (typeof kind !== 'string' || kind.length === 0 || kind === 'plugin') {
          throw new Error('assistant message needs a producer-owned source kind')
        }
        if (!Array.isArray(data?.message?.content)) throw new Error('assistant message content required')
      } else if (type === 'system/message') {
        if ('sourceEventSeqs' in (opts ?? {})) throw new Error('system/message cannot carry sourceEventSeqs')
        if (typeof data?.message?.id !== 'string' || data.message.id.length === 0) throw new Error('system message id required')
        if (data?.message?.role !== 'system') throw new Error('system message role required')
        if (data?.message?.source?.kind !== 'system-prompt') throw new Error('system message source.kind must be system-prompt')
        if (!Array.isArray(data?.message?.content) || data.message.content.length === 0) {
          throw new Error('system message content required')
        }
      } else {
        if (typeof data?.id !== 'string' || data.id.length === 0) throw new Error('user message id required')
        if (data?.role !== 'user') throw new Error('user message role required')
        // The real host does not constrain a user/message source kind: actual
        // logs carry `user`, `runtime-context`, `time-context`,
        // `subagent-settled`, `skill-catalog`, `agent-message`, `model-selection`
        // and `plugin:*` on the same event type. The harness previously demanded
        // `kind: 'user'`, which is stricter than the host and would reject the
        // v7.0 `plugin:graft-replay` marker for no real reason.
        if (typeof data?.source?.kind !== 'string' || data.source.kind.length === 0) {
          throw new Error('user message source.kind required')
        }
        if (!Array.isArray(data?.content)) throw new Error('user message content required')
      }
    } else {
      if (opts?.surfaceOp !== undefined) throw new Error(`${type} must not carry surfaceOp`)
      if (opts?.sourceEventSeqs !== undefined) throw new Error(`${type} must not carry sourceEventSeqs`)
      if (type === 'turn/start' && typeof data?.turn !== 'number') throw new Error('turn/start.turn required')
      if (type === 'step/start' && (typeof data?.turn !== 'number' || typeof data?.step !== 'number')) {
        throw new Error('step/start turn/step required')
      }
      if (type === 'step/end' && (typeof data?.turn !== 'number' || typeof data?.step !== 'number')) {
        throw new Error('step/end turn/step required')
      }
      if (type === 'turn/end' && (typeof data?.turn !== 'number' || typeof data?.reason?.kind !== 'string')) {
        throw new Error('turn/end turn/reason required')
      }
    }

    const event = {
      type,
      seq: this.log.length,
      time: nextTime++,
      data: clone(data),
      ...(opts?.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }),
      ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: clone(opts.sourceEventSeqs) }),
    }
    this.log.push(event)
    return clone(event)
  }

  snapshotEvents(from = 0) {
    return this.log.slice(from).map(clone)
  }
}

export class FakePersistence {
  constructor() {
    this.byId = new Map()
    this.createCalls = []
    this.flushCalls = 0
    this.closeCalls = 0
    this.appendCalls = []
    this.order = []
  }

  async create(header, options) {
    if (this.byId.has(header.id)) throw new Error(`session "${header.id}" already exists`)
    const record = {
      header: clone(header),
      inheritedEventCount: options?.inheritedEventCount ?? 0,
      events: [],
      flushed: false,
      closed: false,
    }
    this.byId.set(header.id, record)
    this.createCalls.push({ header: clone(header), options: clone(options ?? {}) })
    this.order.push('create')
    const persistence = this
    return {
      async append(events, appendOptions) {
        if (record.closed) throw new Error('handle closed')
        persistence.appendCalls.push({ id: header.id, count: events.length, options: clone(appendOptions ?? {}) })
        persistence.order.push('append')
        record.events.push(...events.map(clone))
        record.observedLength = record.events.length
      },
      async flush() {
        if (record.closed) throw new Error('handle closed')
        persistence.flushCalls += 1
        persistence.order.push('flush')
        record.flushed = true
      },
      async close() {
        persistence.closeCalls += 1
        persistence.order.push('close')
        record.closed = true
      },
    }
  }

  async stat(id) {
    const record = this.byId.get(id)
    return record === undefined ? undefined : { header: clone(record.header), sizeBytes: 0 }
  }

  read(id) {
    const record = this.byId.get(id)
    if (record === undefined) return undefined
    return {
      session: clone(record.header),
      inheritedEventCount: record.inheritedEventCount,
      events: record.events.map(clone),
    }
  }
}

export class FakeSessionStore {
  constructor(persistence) {
    this.persistence = persistence
    this.live = new Map()
    this.prepared = new Map()
    this.createCalls = []
    this.flushCalls = 0
  }

  get(id) {
    return this.live.get(id)
  }

  create(id, options = {}) {
    this.createCalls.push({ id, options })
    const session = this.prepare(id, options)
    this.live.set(id, session)
    return session
  }

  prepare(id, options = {}) {
    if (this.live.has(id)) throw new Error(`session "${id}" already exists`)
    const header = {
      version: 4,
      id,
      createdAt: Date.now(),
      ...(options?.meta?.cwd === undefined ? {} : { cwd: options.meta.cwd }),
      // v7.3.1: carry `agentPreset` like the real header does. Without it a test
      // cannot observe whether the graft carried the EFFECTIVE preset (selected
      // later via `agent-preset/selected`) instead of the header's initial one —
      // the mistake that left a live target without `plugin_manager`.
      ...(options?.meta?.agentPreset === undefined ? {} : { agentPreset: options.meta.agentPreset }),
      isSeeded: false,
    }
    const session = new FakeSession(id, header)
    this.prepared.set(id, session)
    return session
  }

  async flush(session) {
    this.flushCalls += 1
    if (!this.live.has(session.id)) throw new Error(`session "${session.id}" is not live in this store`)
    return true
  }
}

export function makeCtx({ sourceLog, persistence = new FakePersistence(), paths, currentAgentId } = {}) {
  const sessions = new FakeSessionStore(persistence)
  // v7.0 P6: expose the source log as a LIVE session.
  //
  // The real host keeps the running session in `ctx.sessions`, and the overflow
  // recovery path reads it through `snapshotEvents()` to find the last closed
  // turn and the open turn's completed work. Earlier tests only needed
  // `sessionQuery.readSession`, so the fixture never registered the source as
  // live — which made every `agent/request-error` path return early.
  if (sourceLog !== undefined) {
    const liveSource = {
      id: sourceLog.session.id,
      header: sourceLog.session,
      snapshotEvents: (fromSeq = 0) =>
        sourceLog.events.filter((event) => Number(event.seq) >= fromSeq),
      // v7.3.1: the real host DOES accept a log-only `session/title` append on a
      // live session — that is how the plugin writes the `[已转移]` signpost. The
      // fixture used to reject every append, so the newly added title-restoration
      // path could not be observed (its errors were swallowed by design). Record
      // titles here; keep rejecting surface writes, which really are the host's.
      append: (type, data) => {
        if (type === 'session/title') {
          sourceTitleAppends.push(clone({ type, data }))
          return clone({ type, data })
        }
        throw new Error('the fixture source session is read-only')
      },
    }
    sessions.live.set(sourceLog.session.id, liveSource)
  }
  const tools = new Map()
  /** v7.3.1: tools visible only inside an agent scope (invisible to the global view). */
  const scopedOnly = new Set()
  /** v7.3.1: emits recorded for assertions (see the `emit` handle below). */
  const emitted = []
  const listeners = new Map()
  const attachedSessions = []
  /**
   * v7.3.1: log-only `session/title` appends made to the LIVE source session.
   *
   * Observable so a test can assert on the `[已转移]` signpost and on its removal
   * during a resume. Kept out of `sourceLog.events` on purpose: appending there
   * would change the event list every other test slices over.
   */
  const sourceTitleAppends = []
  const dataDir = paths?.data ?? mkdtempSync(join(tmpdir(), 'dsh-graft-test-'))
  const currentAgent = { id: currentAgentId ?? sourceLog.session.id }
  const agents = {
    currentInitiator() {
      return currentAgent
    },
    get(id) {
      return id === currentAgent.id ? currentAgent : undefined
    },
  }
  const workspace = {
    id: 'ws-test',
    path: sourceLog.session.cwd,
    attachSession: async (sessionId) => {
      attachedSessions.push(sessionId)
    },
  }
  const workspaceRegistry = {
    async resolveByPath() {
      return workspace
    },
    async create() {
      return workspace
    },
  }
  const ctx = {
    paths: { data: dataDir },
    /**
     * v0.14: `SystemPromptRegistry`, enough for the guard/constraint SECTIONS.
     *
     * Sections are the compaction-immune channel; the fixture records them so a
     * test can read the exact text the host would render, per agent.
     */
    systemPrompt: {
      sections: [],
      getSectionOrder() {
        return 10
      },
      section(definition) {
        this.sections.push(definition)
        return () => {
          const index = this.sections.indexOf(definition)
          if (index >= 0) this.sections.splice(index, 1)
        }
      },
      /** Render one registered section for an agent, or '' when it is absent. */
      _render(name, agent) {
        const found = this.sections.find((item) => item.name === name)
        return found === undefined ? '' : String(found.text({ agent }) ?? '')
      },
    },
    /** v0.14: `workingDirectory.get(session)` — the host owns the effective cwd. */
    workingDirectory: {
      defaultDirectory: sourceLog.session.cwd,
      get(session) {
        return session?.header?.cwd ?? sourceLog.session.cwd
      },
    },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      // v7.0 P0-1: the REAL host surface.
      //
      // `ToolService` exposes `get(name, scope?)` and `schemas(scope?)`. It has
      // no `list()`. The fixture used to expose only `register`, so the plugin's
      // `tools.list()` call fell into its `typeof !== 'function'` guard and
      // silently returned "assume all tools" — F3 downgrade passed every test
      // and never fired on a real host. Modelling the real contract here is what
      // makes that class of bug visible.
      //
      // v7.3.1: both lookups are SCOPE-AWARE, because that is where the live bug
      // lived. The host contract is "scope omitted = the GLOBAL view", and core
      // tools are registered per-AGENT scope (through the preset). A plugin that
      // resolves availability with no scope therefore sees almost nothing, and
      // downgrades every pointer in the tape to an anonymous "tool". Model a
      // preset-scoped tool with `_registerScopedTool(name)`.
      get(name, scope) {
        if (scopedOnly.has(name)) return scope === undefined ? undefined : tools.get(name)
        return tools.get(name)
      },
      schemas(scope) {
        return [...tools.values()]
          .filter((definition) => scope !== undefined || !scopedOnly.has(definition.name))
          .map((definition) => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
          }))
      },
      /** v7.3.1: register a tool that exists only inside an agent scope. */
      _registerScopedTool(name) {
        tools.set(name, {
          name,
          description: `scoped tool ${name}`,
          parameters: { type: 'object', properties: {} },
        })
        scopedOnly.add(name)
        return () => {
          scopedOnly.delete(name)
          tools.delete(name)
        }
      },
      /** v7.3.1: which tools are invisible to the global view. */
      _scopedOnlyNames() {
        return [...scopedOnly]
      },
      /**
       * v0.14: `ToolService.guard()`.
       *
       * The real contract is a monotonic deny hook: the guard returns a reason
       * string to deny, and no guard can force-allow what another denied. The
       * fixture used to expose only `register`, so the command guard fell into
       * its `typeof !== 'function'` branch and disarmed itself in every test —
       * the same "fixture too poor to fail" shape the tool get/schemas note
       * above describes.
       */
      guards: [],
      guard(guardFn) {
        this.guards.push(guardFn)
        return () => {
          const index = this.guards.indexOf(guardFn)
          if (index >= 0) this.guards.splice(index, 1)
        }
      },
      /** Run every guard in order; the first denial wins (monotonic). */
      _runGuards(execution) {
        for (const guardFn of this.guards) {
          const reason = guardFn(execution)
          if (typeof reason === 'string' && reason.length > 0) return reason
        }
        return undefined
      },
    },
    sessions,
    sessionQuery: {
      async readSession(id) {
        if (id === sourceLog.session.id) return clone(sourceLog)
        const stored = persistence.read(id)
        if (stored !== undefined) return stored
        throw new Error(`session "${id}" not found`)
      },
    },
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessions') return sessions
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'paths') return { data: dataDir }
      if (name === 'agents') return agents
      // v7.0 P0-2/P0-1: the host's token meter and tool registry are real
      // services the plugin resolves through `ctx.get`. They are attached to the
      // context by the test AFTER makeCtx, so the lookup reads the live property
      // rather than a captured copy.
      if (name === 'tokenMeter') return ctx.tokenMeter
      if (name === 'tools') return ctx.tools
      // v0.14/v0.16: the two services the guard rails and the console resolve.
      if (name === 'systemPrompt') return ctx.systemPrompt
      if (name === 'workingDirectory') return ctx.workingDirectory
      if (name === 'commands') return ctx.commands
      if (name === 'configEditor') return ctx.configEditor
      return undefined
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    /**
     * v7.3.1: recorded emits.
     *
     * The plugin announces a completed target through `api-session/added` so the
     * Web UI shows it immediately (the client only refreshes on that event, and
     * the plugin cannot publish a live session without making it unresumable).
     * Recording here lets a test assert on the payload without a client.
     */
    emit(name, ...args) {
      emitted.push({ name, args: clone(args) })
    },
    logger: { info() {}, warn() {}, error() {} },
    // test handles
    _tools: tools,
    _listeners: listeners,
    _emitted: emitted,
    _persistence: persistence,
    _workspace: workspace,
    _workspaceRegistry: workspaceRegistry,
    _attachedSessions: attachedSessions,
    _sourceTitleAppends: sourceTitleAppends,
    _agents: agents,
    _currentAgent: currentAgent,
    pathsData: dataDir,
  }
  return ctx
}

/**
 * Build a synthetic but shape-faithful v4 source log.
 *
 * The first turn includes a real tool/call + tool/result pair, a non-empty
 * source stream, and an assistant/attempt + assistant/chunk noise. Later
 * turns contain Markdown so the older-turn summary path can be asserted.
 */
export function makeSourceLog({ cwd = 'D:\\work\\demo', turns = 7, sourceSessionId = 'session-source' } = {}) {
  const events = []
  let seq = 0
  let messageCounter = 0

  const push = (type, data, surfaceOp) => {
    const event = {
      type,
      seq: seq++,
      time: nextTime++,
      data: clone(data),
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
    }
    events.push(event)
    return event
  }

  push('permission/preset', { preset: 'full-access' })
  push('session/title', { title: 'fixture', messageSeqs: [], source: { kind: 'fallback' } })

  for (let turn = 1; turn <= turns; turn += 1) {
    const step = 1
    push('turn/start', { turn })
    push('step/start', { turn, step })

    if (turn === 1) {
      push(
        'user/message',
        {
          id: `user-${++messageCounter}`,
          role: 'user',
          content: [
            {
              type: 'text',
              text: '你是一个资深 DSH 插件开发者。实现 dsh-graft-slice：在最后一个 turn/end 处切片，并用最小骨架注入一个新会话。',
            },
          ],
          source: { kind: 'user' },
        },
        'append',
      )
    } else if (turn === 2) {
      push(
        'user/message',
        {
          id: `user-${++messageCounter}`,
          role: 'user',
          content: [{ type: 'text', text: '继续：补上测试和冷恢复验证。' }],
          source: { kind: 'user' },
        },
        'append',
      )
    }

    // Noise that must not enter the tape.
    push('assistant/attempt', {
      turn,
      step,
      stream: [{ type: 'chunk', time: nextTime++, chunk: { type: 'text-delta', index: 0, text: 'partial' } }],
    })
    push('assistant/chunk', {
      turn,
      step,
      index: 0,
      chunk: { type: 'text-delta', index: 0, text: 'partial' },
    })

    const callId = `call-${turn}`
    const assistantId = `assistant-${++messageCounter}`
    const content = [
      {
        type: 'text',
        text:
          turn === 1
            ? '我先核对会话 API 和持久化路径。\n\n**计划**\n- 读取源码\n- 确认 flush 语义'
            : `第 ${turn} 轮：完成了一段实现和验证。\n\n- 记录：${'细节 '.repeat(20)}\n- 下一步：继续推进第 ${turn + 1} 项。`,
      },
    ]
    if (turn === 1) {
      content.push({
        type: 'tool-call',
        id: callId,
        name: 'read_file',
        arguments: '{"path":"session.js"}',
      })
    }
    push(
      'assistant/message',
      {
        turn,
        step,
        message: {
          id: assistantId,
          role: 'assistant',
          content,
          source: {
            kind: 'model',
            provider: 'deepseek-account',
            model: 'deepseek-flash',
            replayState: { response: { kind: 'fixture' } },
          },
        },
        stream: [
          {
            type: 'text-chunks',
            time0: nextTime++,
            index: 0,
            dt: [1, 2],
            texts: ['第 ', String(turn)],
          },
        ],
        // v7.0 P0-2: a real assistant/message carries the provider's usage, and
        // the watermark's log-based path reads it. Omitting it here made the
        // fixture lie about which measurement tier is reachable, so the
        // "usage beats estimate" behaviour could not be tested at all.
        usage: { inputTokens: 1200 + turn * 100, outputTokens: 80, totalTokens: 1280 + turn * 100 },
      },
      'append',
    )

    if (turn === 1) {
      push('tool/call', {
        turn,
        step,
        callId,
        name: 'read_file',
        arguments: '{"path":"session.js"}',
      })
      push('tool/result', {
        turn,
        step,
        message: {
          id: `tool-result-${turn}`,
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{ type: 'text', text: 'SESSION API VERIFIED: prepare/create/append/flush' }],
        },
      })
      push(
        'assistant/message',
        {
          turn,
          step,
          message: {
            id: `assistant-final-${turn}`,
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: '核对完成。当前假设：必须用 prepare + 持久化 handle 才是可冷恢复路径。已排除：sessions.create 直接落盘。下一步：写测试并跑冷读。',
              },
            ],
            source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
          },
          stream: [],
        },
        'append',
      )
    }

    push('step/end', { turn, step })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }

  return {
    session: { version: 4, id: sourceSessionId, createdAt: nextTime++, cwd, isSeeded: false },
    inheritedEventCount: 0,
    events,
  }
}

/** A v3-style nested tool result for the fallback reader test. */
export function makeV3ToolResult(seq = 0) {
  return {
    type: 'tool/result',
    seq,
    time: nextTime++,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'tool-result-v3',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-v3' },
        toolCallId: 'call-v3',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-v3',
            content: [{ type: 'text', text: 'v3 nested result' }],
          },
        ],
      },
    },
  }
}

/** Count event types in an array. */
export function typeCounts(events) {
  const counts = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return counts
}

/** Return the registered tool definitions for assertions. */
export function registeredTools(ctx) {
  return new Map(ctx._tools)
}

/** Deliver one agent/pre-step event through the registered listeners. */
export async function dispatchPreStep(ctx, payload) {
  const listeners = ctx._listeners.get('agent/pre-step') ?? []
  let index = -1
  const next = async () => {
    index += 1
    if (index >= listeners.length) return { kind: 'enter', messages: payload?.messages ?? [] }
    return listeners[index](payload, next)
  }
  return next()
}

/**
 * Deliver one `agent/request-error` waterfall entry (v7.0 P6).
 *
 * Mirrors the host: the waterfall's terminal `next()` resolves to `undefined`,
 * and a listener may short-circuit with `{ kind: 'retry' }` to make the loop
 * re-issue the same step.
 */
export async function dispatchRequestError(ctx, payload) {
  const listeners = ctx._listeners.get('agent/request-error') ?? []
  let index = -1
  const next = async () => {
    index += 1
    if (index >= listeners.length) return undefined
    return listeners[index](payload, next)
  }
  return next()
}

/** Deliver one agent/turn-stopping event through the registered listeners. */export async function dispatchTurnStopping(ctx, payload) {
  const listeners = ctx._listeners.get('agent/turn-stopping') ?? []
  for (const listener of listeners) await listener(payload)
}

/** Deliver one session/event through the registered listeners. */
export async function dispatchSessionEvent(ctx, session, event) {
  const listeners = ctx._listeners.get('session/event') ?? []
  for (const listener of listeners) await listener(session, event)
}
