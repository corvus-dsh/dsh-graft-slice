/**
 * THE PARADISE WRITE BRIDGE — `src/core/paradise-write.ts`.
 *
 * WHY A BRIDGE RATHER THAN A DIRECT IMPORT
 *
 * Two reasons, and the second is the one that matters here:
 *
 *  1. `dsh-paradise` is a separate package and a separate bundle entry. A static bare import survives
 *     into this single-file bundle and fails at `import()` time whenever the layer is absent — taking
 *     the whole plugin down with it, at load, before any of its 542 tests could say why.
 *
 *  2. The layer is a REQUIRED dependency of the write path from v7.7 on, so "absent" must be a NAMED
 *     refusal with a stage, not a crash and not a silent fallback to the old inline writer. A bridge is
 *     where that decision can be made once instead of at each call site.
 *
 * WHAT THE BRIDGE GUARANTEES
 *
 *   - the layer is resolved LAZILY and the answer is CACHED (including a failure);
 *   - a missing or too-old layer produces `{ ok: false, reason }`, never a throw;
 *   - the two specifiers tried are the installed package name and the sibling directory, which is how
 *     this workspace actually lays the repositories out.
 */

/** The subset of the layer's write surface this plugin calls. Structural, so a rename breaks here first. */
export interface ParadiseSessionLike {
  create(input: {
    cwd: string
    title?: string
    id?: string
    items?: Array<{ visibility: 'visible' | 'context-only'; text: string; origin: string; id?: string }>
    tape?: ReadonlyArray<{ type: string; data: Record<string, any>; surface?: boolean }>
    inheritFrom?: string
    /** `false` when the caller publishes the new session itself — see `CreateOptions.publish`. */
    publish?: boolean
  }): Promise<{
    ok: boolean
    stage: string
    warnings: string[]
    session?: { id: string; cwd: string }
    rendered?: ReadonlyArray<{ id: string; requested: string; rendered: boolean; reason: string }>
    types?: string[]
    appended?: number
    verified?: boolean
    contentSeq?: number | null
    contentSourceKind?: string
    workspaceAttached?: boolean
    clientAnnounced?: boolean
    error?: { code: string; stage: string; message: string }
  }>
  readonly capabilities: { create: boolean; trigger: boolean; verifyDeletion: boolean }
  /**
   * Make the session start working.
   *
   * `SessionRef.cwd` is supplied because the protocol requires it, but this verb addresses a session by
   * id: every host in this workspace resolves the agent from `sessionId`. The bridge therefore passes
   * the cwd when the caller knows it and does not invent one when it does not.
   */
  trigger(
    session: { id: string; cwd?: string },
    trigger: {
      text: string
      mode: 'queue' | 'interrupt'
      origin: string
      marker?: string
      fallbackModes?: boolean
    },
  ): Promise<{
    ok: boolean
    stage: string
    channel?: string
    alreadyTriggered?: true
    promptChars?: number
    warnings: string[]
    error?: { code: string; stage: string; message: string }
  }>
}

interface ParadiseLayerLike {
  createDshAdapters(ctx: any): { name: string; session: ParadiseSessionLike }
  deleteSession(
    ctx: any,
    sessionId: string,
    reason: string,
  ): Promise<{
    ok: boolean
    removed: boolean
    verified: 'absent' | 'present' | 'unverifiable'
    marked: boolean
    notes: string[]
    warnings: string[]
  }>
  paradiseInternals?: { VERSION?: string }
}

export interface ParadiseWriteBinding {
  ok: boolean
  reason: string
  session?: ParadiseSessionLike
  deletes?: ParadiseLayerLike['deleteSession']
  layerName?: string
  via?: string
  version?: string
  /**
   * The trigger verb, bound to the same context as `session`.
   *
   * It is a separate field rather than a call through `session.trigger` so the CALL SITE keeps reading
   * like one operation, and so a layer too old to carry the verb degrades to `undefined` instead of
   * throwing an unhelpful `is not a function` deep inside a migration.
   */
  triggers?: ParadiseSessionLike['trigger']
}

const PACKAGE_NAME = 'dsh-paradise'

/** The specifiers tried, in order. Exported so a test can assert the resolution order. */
export function paradiseSpecifiers(): string[] {
  return [PACKAGE_NAME, `../${PACKAGE_NAME}/index.js`]
}

let cached: ParadiseWriteBinding | null = null
let cachedFor: any = null
/**
 * A binding a TEST (or an operator) has PRIMED, which applies to the next context that asks.
 *
 * WHY THIS EXISTS AS ITS OWN SLOT rather than the primed value being cached under some context: a test
 * has no context yet at the moment it primes — it is stating "whatever asks next, answer THIS". The
 * previous version stored the primed value as the cache and left `cachedFor` as it was, so the very
 * context the test then created did not match and the bridge silently re-resolved the REAL layer.
 *
 * The consequence was severe and is exactly what an end-to-end proof caught: a "the layer is absent"
 * test still got a successful migration, because the mock was never consulted. A test seam that does
 * not seam is worse than none — it certifies the thing it was meant to falsify.
 */
let primed: ParadiseWriteBinding | null = null
let resolveInFlight: Promise<ParadiseWriteBinding> | null = null

/**
 * Resolve the layer's write surface for THIS context.
 *
 * Never throws: the caller gets `ok: false` and a reason it can put in an error with a stage.
 *
 * WHY THE BINDING IS KEYED BY CONTEXT, NOT CACHED GLOBALLY
 *
 * `createDshAdapters(ctx)` builds an adapter bound to the host services reachable through that one
 * context — `sessions`, `sessionPersistence`, `sessionQuery`. The first version cached the binding
 * unconditionally, so the SECOND context to ask got the FIRST context's adapter: every later migration
 * wrote into a persistence store that no longer existed, and the cold read then failed with
 * `session "<id>" not found`. On the desktop there is one context for the process lifetime, so the bug
 * was invisible there and fatal in tests, where each case builds its own host. Caching the resolution
 * per context keeps the "resolve once" benefit exactly where it is true.
 */
export async function ensureParadiseWrite(ctx: any): Promise<ParadiseWriteBinding> {
  /**
   * THE PRIMED ANSWER WINS FOR THE NEXT CONTEXT, ONCE.
   *
   * Consuming it (rather than answering forever) keeps the seam honest in both directions: the NEXT
   * context after the primed one resolves for real, so a test cannot accidentally certify a mock as the
   * shipped behaviour.
   */
  if (primed !== null) {
    const answer = primed
    primed = null
    cached = answer
    cachedFor = ctx
    return answer
  }
  if (cached !== null && cachedFor === ctx) return cached
  if (resolveInFlight !== null && cachedFor === ctx) return resolveInFlight
  resolveInFlight = (async (): Promise<ParadiseWriteBinding> => {
    const failures: string[] = []
    for (const specifier of paradiseSpecifiers()) {
      try {
        const mod: any = await import(/* @vite-ignore */ specifier)
        if (typeof mod?.createDshAdapters !== 'function' || typeof mod?.deleteSession !== 'function') {
          failures.push(`${specifier}: 已加载但缺少 createDshAdapters/deleteSession（版本过旧？需要 >= 0.4.0）`)
          continue
        }
        let adapters: { name: string; session: ParadiseSessionLike }
        try {
          adapters = mod.createDshAdapters(ctx)
        } catch (error) {
          failures.push(`${specifier}: createDshAdapters 抛错：${String((error as any)?.message ?? error)}`)
          continue
        }
        const binding: ParadiseWriteBinding = {
          ok: true,
          reason: '',
          session: adapters.session,
          deletes: mod.deleteSession,
          ...(typeof adapters.session?.trigger === 'function'
            ? { triggers: adapters.session.trigger.bind(adapters.session) }
            : {}),
          layerName: adapters.name,
          via: specifier === PACKAGE_NAME ? 'bare' : 'sibling',
          ...(typeof mod?.paradiseInternals?.VERSION === 'string' ? { version: mod.paradiseInternals.VERSION } : {}),
        }
        cached = binding
        cachedFor = ctx
        return binding
      } catch (error) {
        failures.push(`${specifier}: ${String((error as any)?.message ?? error)}`)
      }
    }
    const binding: ParadiseWriteBinding = { ok: false, reason: `${PACKAGE_NAME} 不可用 —— ${failures.join(' | ')}` }
    cached = binding
    cachedFor = ctx
    return binding
  })()
  const inFlight = resolveInFlight
  cachedFor = ctx
  try {
    return await inFlight
  } finally {
    if (resolveInFlight === inFlight) resolveInFlight = null
  }
}

/**
 * Test seam: forget every cached answer, and optionally state what the NEXT context should be told.
 *
 * TWO DIFFERENT JOBS, deliberately one call: "forget" (a degradation test re-probing a real install)
 * and "prime" (a seam test asserting the ABSENT-layer path). Priming goes into its own slot because the
 * context to be primed does not exist yet when a test states the answer — see `primed`.
 */
export function resetParadiseWriteCache(prime?: ParadiseWriteBinding): void {
  cached = null
  cachedFor = null
  resolveInFlight = null
  primed = prime === undefined ? null : prime
}

/** The binding a failed resolution produces. Exported so a test primes the real shape. */
export function unavailableWriteBinding(reason: string): ParadiseWriteBinding {
  return { ok: false, reason }
}

/** What a caller is told when the layer is missing. One sentence, used by every caller. */
export const PARADISE_WRITE_MISSING_CONSEQUENCE =
  `切片写入不可用：${PACKAGE_NAME} 未安装或版本过旧（需要 >= 0.4.0 的写层）。` +
  '把 dsh-paradise 放在与 dsh-graft-slice 同级的目录，或在 profile 的依赖里加入它。'
