/**
 * THE HOST GATEWAY — `src/core/host-gateway.ts`.
 *
 * THE PROBLEM, STATED AS IT ACTUALLY BITES
 *
 * The migration pipeline (`graftSliceAndInjectUnlocked`) reaches the host in exactly five places:
 *
 *     ctx.sessions.get(newId)                  preflight: "does this id already exist"
 *     ctx.get('sessionPersistence')            preflight: "is durable storage mounted"
 *     ctx.sessionQuery.readSession(id)         the SOURCE log, and the cold read-back
 *     ctx.sessions.get(sourceId).append(...)   the `[已转移]` title on the source
 *     persistence.stat(newId)                  "no half-written target with this id"
 *
 * Five call sites, but they hard-wired ONE answer to "what is a session": a live handle from a service
 * container. On a bare machine there is no container — there is a directory of `.jsonl` files, and a
 * caller who already owns an adapter. The plugin could not run there, not because its LOGIC was wrong,
 * but because it insisted on asking the host questions through the host's own nouns.
 *
 * WHAT THIS MODULE DOES ABOUT IT
 *
 * It puts those five questions behind a narrow interface and makes the DEFAULT implementation behave
 * EXACTLY as the inline code did. That is the whole design: the pipeline is unchanged, and the default
 * gateway is a byte-for-byte transcription of what used to be written inline.
 *
 * WHY A GATEWAY AND NOT MORE PROVIDERS
 *
 * `paradise-write.ts` already has a provider for the WRITE half (create/trigger). This one is for the
 * READ and PROBE half. Keeping them apart matters: a deployment may have a working storage adapter and
 * no live sessions at all (a harvested machine), and collapsing the two into one seam would force it to
 * fake the half it does not have.
 *
 * WHAT IT IS NOT: a second code path. There is no `if (bareMachine)` anywhere in the pipeline. There is
 * one pipeline, and a gateway that can be replaced.
 */

import type { LogReading, SessionRef } from './gateway-types.js'

/** The few verbs the pipeline needs from whatever is hosting it. */
export interface HostGateway {
  /** A short name for diagnostics — "which host is this running on?". */
  readonly name: string

  /**
   * Is this session id already taken? Answer `true` if it is live OR durably present.
   *
   * WHY ONE VERB AND NOT TWO: the pipeline only ever wants "may I use this id", and a caller that answers
   * "live" and "durable" separately would invite the pipeline to re-derive the combined answer — which is
   * where the two implementations would drift.
   */
  isTaken(id: string): Promise<boolean>

  /** Read a session's durable log. NEVER throws: an absent session is `readable: false`. */
  readLog(id: string): Promise<LogReading>

  /**
   * DOES THIS GATEWAY NEED THE TARGET TO BE BUILT THROUGH `SessionAdapter` (the paradise write path)?
   *
   * `true` is the behaviour that shipped: `sessions.prepare` + `sessionPersistence.create` are gone, and
   * the write goes through the layer. A gateway that CAN write a session itself answers `false` and takes
   * `writeTarget` instead.
   */
  readonly writesThroughParadise: boolean

  /**
   * DOES `readLog` RETURN THE SESSION HEADER AS AN EVENT?
   *
   * The pipeline's cold read-back compares the re-read event list against the tape it wrote, and THE TAPE
   * HAS NO HEADER — `materializeTape` builds events only, and the header is written separately. A host
   * whose reader includes a `session` event therefore needs it EXCLUDED before the comparison, and a
   * reader that never emits one needs nothing.
   *
   * WHY THIS IS A FLAG AND NOT A STRIP INSIDE THE PIPELINE: the pipeline must not guess at a reader's
   * shape. Getting this wrong is not cosmetic — measured on the bare-machine run, the first version of
   * this gateway wrote a header event and the cold read reported:
   *
   *     [COLD_READ_MISMATCH] cold-read event count 10 does not match written count 9
   *
   * The write was correct. The comparison was comparing a log-with-header against a tape-without-one.
   */
  readonly readLogIncludesHeader?: boolean

  /** Read a session's durable log. NEVER throws: an absent session is `readable: false`. */
  readLog(id: string): Promise<LogReading>

  /**
   * Write the target session. Only called when `writesThroughParadise` is false.
   *
   * WHY IT IS SEPARATE FROM `readLog`: the write is the one verb with real failure modes and a receipt,
   * and a gateway that can write but not read (or the reverse) is a legitimate half-implementation.
   */
  writeTarget?(input: { id: string; cwd: string; title?: string; events: readonly TargetEvent[] }): Promise<{
    ok: boolean
    stage: string
    warnings: string[]
    error?: { code: string; stage: string; message: string }
  }>

  /** Mark the SOURCE as transferred. Best-effort: the pipeline reports a failure as a warning. */
  markSourceTransferred?(id: string, title: string): Promise<void>
}

/** One event the target tape is built from, as the gateway receives it. */
export interface TargetEvent {
  readonly type: string
  readonly data: Record<string, unknown>
  readonly surface?: boolean
}

const NO_GATEWAY_SET: unique symbol = Symbol('no-gateway')

let installed: HostGateway | undefined

/**
 * INSTALL (OR CLEAR) A GATEWAY.
 *
 * Called once by a bare-machine deployment before running a migration. Inside a host nothing calls it, so
 * `resolveGateway(ctx)` returns the default — which is what keeps every existing test on the shipped path.
 */
export function setHostGateway(gateway: HostGateway | undefined): void {
  installed = gateway
}

/** Is a gateway installed? Diagnostics print this so "why is it not using the host" is answerable. */
export function hasHostGateway(): boolean {
  return installed !== undefined
}

/**
 * THE DEFAULT GATEWAY — the shipped behaviour, transcribed.
 *
 * Every method below is what the inline code did, moved without translation. The comments name the LINE
 * it came from so a reviewer can diff the two and find nothing.
 */
export function hostGatewayFromContext(ctx: any): HostGateway {
  /**
   * `ctx.sessions.get(id)` — the live-handle registry. Wrapped in a try because a service proxy can throw
   * on an unknown name, and a preflight that throws is a migration that fails for the wrong reason.
   */
  const liveHandle = (id: string): any => {
    try {
      return ctx?.sessions?.get?.(id)
    } catch {
      return undefined
    }
  }
  const persistence = (): any => {
    try {
      return ctx?.get?.('sessionPersistence') ?? ctx?.sessionPersistence
    } catch {
      return undefined
    }
  }

  return {
    name: 'host-context',
    writesThroughParadise: true,

    /**
     * WAS: `ctx.sessions.get(newId) !== undefined` plus `persistence.stat(newId)`.
     *
     * The durable half is checked only when `stat` exists — the original guarded it with
     * `typeof persistence.stat === 'function'`, and that guard is behaviour: a host without `stat` cannot
     * answer, and pretending it said "free" would let a migration overwrite a real session.
     */
    async isTaken(id: string): Promise<boolean> {
      if (liveHandle(id) !== undefined) return true
      const store = persistence()
      if (store === undefined || typeof store.stat !== 'function') return false
      try {
        const existing = await store.stat(id)
        return existing !== undefined && existing !== null
      } catch {
        /**
         * A THROWING `stat` IS NOT "FREE". The original propagates the error and the migration refuses;
         * answering `false` here would turn an unreadable store into permission to overwrite.
         */
        throw new Error(`sessionPersistence.stat 抛错：无法确认 ${id} 是否已存在`)
      }
    },

    /** WAS: `await ctx.sessionQuery.readSession(id)`, whose result the pipeline already tolerates as null. */
    async readLog(id: string): Promise<LogReading> {
      const raw = await ctx?.sessionQuery?.readSession?.(id)
      return normalizeReading(id, raw)
    },

    /** WAS: `live.append('session/title', …)` inside a try whose failure became a warning. */
    async markSourceTransferred(id: string, title: string): Promise<void> {
      const live = liveHandle(id)
      if (live === undefined || typeof live.append !== 'function') return
      live.append('session/title', {
        title,
        messageSeqs: [],
        source: { kind: 'user' },
      })
    },
  }
}

/**
 * Coerce whatever a reader returned into the shape the pipeline consumes.
 *
 * WHY THIS IS SHARED: both gateways need it, and two copies of "an absent session is `readable: false`"
 * is how one path starts treating a missing log as an empty one. Exported so a bare gateway can reuse it.
 */
export function normalizeReading(id: string, raw: unknown): LogReading {
  if (raw === null || raw === undefined) {
    return {
      readable: false,
      path: '',
      pathSource: 'gateway',
      bytes: 0,
      frameCount: 0,
      framesDecoded: 0,
      events: [],
      eventTypes: [],
      eventCount: 0,
      firstMessage: null,
      notes: [`session ${id} 不存在`],
    }
  }
  const record = raw as Record<string, unknown>
  const events = Array.isArray(record.events) ? (record.events as LogReading['events']) : []
  const types = [...new Set(events.map((event) => String((event as any)?.type ?? '')))]
  return {
    readable: record.readable === false ? false : events.length > 0,
    path: typeof record.path === 'string' ? record.path : '',
    pathSource: typeof record.pathSource === 'string' ? record.pathSource : 'gateway',
    bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    frameCount: typeof record.frameCount === 'number' ? record.frameCount : events.length,
    framesDecoded: typeof record.framesDecoded === 'number' ? record.framesDecoded : events.length,
    events,
    eventTypes: types,
    eventCount: events.length,
    firstMessage: (record.firstMessage as LogReading['firstMessage']) ?? null,
    notes: Array.isArray(record.notes) ? (record.notes as string[]) : [],
    /** The header travels with the reading: the pipeline needs it to refuse a subagent log. */
    ...(record.session !== null && typeof record.session === 'object'
      ? { session: record.session as Record<string, unknown> }
      : {}),
  }
}

/**
 * WHICH GATEWAY IS LIVE FOR THIS CONTEXT.
 *
 * The installed one wins; otherwise the default built from `ctx`. There is deliberately no third option:
 * "no gateway" is not a state the pipeline can run in, and a fallback that invented one would hide the
 * fact that the plugin had been handed a context it cannot use.
 */
export function resolveGateway(ctx: any): HostGateway {
  return installed ?? hostGatewayFromContext(ctx)
}

export { NO_GATEWAY_SET }
export type { SessionRef }
