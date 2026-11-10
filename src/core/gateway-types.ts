/**
 * THE GATEWAY'S VALUE TYPES — `src/core/gateway-types.ts`.
 *
 * WHY THE SHAPES ARE RE-DECLARED INSTEAD OF IMPORTED
 *
 * `core/host-gateway.ts` must be importable by a deployment that has NO host and therefore no host
 * bindings. Pulling `LogReading` from the plugin's own session types would be fine — they are local — but
 * keeping these three small shapes here makes the dependency graph of the gateway obvious at a glance:
 * it needs a reading, a ref, and a target event, and nothing else.
 *
 * THE SHAPES ARE STRUCTURALLY THE PROTOCOL'S. They are not a second vocabulary; they are the subset the
 * migration pipeline actually reads. A field the pipeline never touches is deliberately absent, because a
 * gateway asked to produce it would have to invent it.
 */

/** One stored event, as the pipeline reads it. */
export interface GatewayEvent {
  readonly seq: number
  readonly type: string
  readonly time?: number
  readonly data?: unknown
}

/** A session handle. Opaque id plus the directory it belongs to — the two facts the pipeline uses. */
export interface SessionRef {
  readonly id: string
  readonly cwd: string
}

/**
 * What a log reading must carry for the pipeline to decide anything.
 *
 * `readable: false` is how "there is no such session" is expressed — NOT an exception, and NOT an empty
 * event list, because those are three different facts: absent, empty, unreadable.
 */
export interface LogReading {
  readonly readable: boolean
  readonly path: string
  readonly pathSource: string
  readonly bytes: number
  readonly frameCount: number
  readonly framesDecoded: number
  readonly events: readonly GatewayEvent[]
  readonly eventTypes: readonly string[]
  readonly eventCount: number
  readonly firstMessage: {
    readonly seq: number
    readonly type: string
    readonly role: string
    readonly origin: string
    readonly textLength: number
    readonly textHead: string
    readonly rendered: boolean
  } | null
  readonly notes: readonly string[]
  /**
   * THE SESSION HEADER, when the reader could see one.
   *
   * The pipeline reads three facts off it — `origin`, `delegationDepth`, `parentSession(Id)` — to refuse a
   * subagent log (it has no independent goal, and its delegation boilerplate becomes an illegal action for
   * a top-level target). A gateway that cannot surface a header leaves this absent, and the pipeline then
   * treats the log as top-level. That is the same behaviour as a host whose reader dropped the header.
   */
  readonly session?: Record<string, unknown>
}

export interface SessionHeaderLike {
  id: string
  cwd?: string
  createdAt?: number
  isSeeded?: boolean
  [key: string]: any
}

export interface SessionLogSnapshotLike {
  session: SessionHeaderLike
  inheritedEventCount?: number
  events: SessionEventLike[]
}

export interface PreparedSessionLike {
  id: string
  header: SessionHeaderLike
  seq: number
  append(type: string, data: any, opts?: any): SessionEventLike
  snapshotEvents(from?: number): readonly SessionEventLike[]
}

export interface SessionStoreLike {
  get(id: string): { id: string } | undefined
  prepare(id: string, options?: any): PreparedSessionLike
}

export interface SessionQueryLike {
  readSession(id: string): Promise<SessionLogSnapshotLike>
}

export interface ToolRegistryLike {
  register(definition: any): () => void
}

export interface PluginContextLike {
  tools: ToolRegistryLike
  sessions: SessionStoreLike
  sessionQuery: SessionQueryLike
  get(name: string): any
  on(name: string, listener: (...args: any[]) => any, options?: any): () => void
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
    error?: (message: string) => void
  }
}
