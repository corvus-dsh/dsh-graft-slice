/**
 * THE STORE LAYER — where a profile's durable graft files live, resolved once per application.
 *
 * ── WHY THIS MODULE EXISTS (S3-P1, and the theorem it answers) ──────────────────────────────────
 *
 * `recoverGraftTransactions` cannot reach `mutable: []` while the store location lives in module-level
 * `let`s: a value decided per application, exposed through public APIs that do not take it as a
 * parameter, has nowhere else to live. This module is the first half of the answer — a **pure,
 * importable resolver** that turns `(ctx, config)` into a frozen path set, with no module state of its
 * own. Whether the old code switches to it is P4's business; P1 only has to exist, be correct, and be
 * unreachable from `index.ts` (an unwired module is inert: `bundle.mjs` inlines only what is reachable).
 *
 * ── THE ONE RULE THIS FILE MUST NOT BREAK ───────────────────────────────────────────────────────
 *
 * **It imports NOTHING from `index.ts`.** A single back-import — even `import type` — closes a cycle
 * that `orderModules` refuses at build time (type-only specifiers are followed like any other). The
 * structural session types it needs were moved to `core/gateway-types.ts` (P0) for exactly this reason.
 *
 * ── THE RESOLUTION ORDER IS THE BEHAVIOUR ───────────────────────────────────────────────────────
 *
 * The five branches below are copied from `resolveStoreDir` deliberately, one for one, because P3 will
 * diff this against the old implementation. Re-ordering them is not a cleanup — it silently moves every
 * profile's retirement stores, which decides which sessions a pre-step gate refuses.
 */

import { join } from 'node:path'
import type { PluginContextLike } from './gateway-types.js'

/** The config subset the resolver reads. Structural, so `index.ts` can pass its `GraftConfig` as-is. */
export interface StoreLayerConfig {
  /** `config.dataDir`. When set it WINS over the host path — that priority is itself a behaviour. */
  dataDir?: string
  /**
   * Last-resort directory, used only when no branch above yields one.
   *
   * Passed in rather than computed from `import.meta.url`, because in TS source this file's directory
   * is `src/core/` while the bundle inlines it next to `index.ts` — the two would disagree, and the
   * fallback is the one branch where a disagreement is silent (it is shared by every profile).
   */
  fallbackDir: string
}

/** The seven store locations plus the directory they share. **Frozen**: a layer is a constant. */
export interface StorePaths {
  readonly dir: string
  readonly scope: string
  readonly retired: string
  readonly transferred: string
  readonly graftTargets: string
  readonly txnDir: string
  readonly leftovers: string
  readonly autoGraftSuppressed: string
  readonly constraintSections: string
  readonly pendingConstraints: string
}

export interface StoreLayer {
  readonly paths: StorePaths
  /** The context captured at assembly time, or `undefined` when the layer was built without one. */
  readonly ctx: PluginContextLike | undefined
}

const FILE_NAMES = {
  retired: '.retired.json',
  transferred: '.transferred.json',
  graftTargets: '.graft-targets.json',
  txnDir: '.txn',
  leftovers: '.graft-leftovers.json',
  autoGraftSuppressed: '.auto-graft-suppressed.json',
  constraintSections: '.graft-constraint-sections.json',
  pendingConstraints: '.pending-constraints.json',
} as const

/**
 * Resolve the profile-private store directory.
 *
 * Order (identical to the implementation this will be diffed against):
 *   1. `config.dataDir`            — an explicit setting; wins over everything.
 *   2. `ctx` → `get('paths').data` — the profile's declared data dir, when the service is mounted.
 *   3. `DSH_PROFILE_DIR`           — the launcher's own profile directory.
 *   4. `DSH_HOME` (+ `DSH_PROFILE`) — the same value, derived by hand.
 *   5. `config.fallbackDir`        — the plugin directory; shared by every profile, hence last.
 */
export function resolveStoreDir(ctx: PluginContextLike | undefined, config: StoreLayerConfig): { dir: string; scope: string } {
  const explicit = config.dataDir
  if (typeof explicit === 'string' && explicit.length > 0) {
    return { dir: explicit, scope: 'config.dataDir' }
  }

  let paths: unknown
  try {
    paths = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('paths') : undefined
  } catch {
    // Cordis service proxies may reject undeclared property reads; that is not a resolution failure.
    paths = undefined
  }
  if (
    paths !== null
    && typeof paths === 'object'
    && typeof (paths as { data?: unknown }).data === 'string'
    && ((paths as { data: string }).data).length > 0
  ) {
    return { dir: (paths as { data: string }).data, scope: 'paths.data' }
  }

  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    return { dir: join(profileDir, 'data', 'dsh-graft-slice'), scope: 'DSH_PROFILE_DIR' }
  }

  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (typeof home === 'string' && home.length > 0) {
    const suffix = typeof profile === 'string' && profile.length > 0 ? ['profiles', profile] : ['plugin-data']
    return { dir: join(home, ...suffix, 'data', 'dsh-graft-slice'), scope: 'DSH_HOME' }
  }

  return { dir: config.fallbackDir, scope: 'plugin-dir' }
}

/**
 * Build the layer. Pure: same inputs ⇒ same frozen object content, no module-level cache.
 *
 * A cache here would look like an optimisation and behave like a bug: the second profile would inherit
 * the first profile's directory, and the `retired` store decides which sessions are refused.
 */
export function createStoreLayer(ctx: PluginContextLike | undefined, config: StoreLayerConfig): StoreLayer {
  const { dir, scope } = resolveStoreDir(ctx, config)
  const paths: StorePaths = Object.freeze({
    dir,
    scope,
    retired: join(dir, FILE_NAMES.retired),
    transferred: join(dir, FILE_NAMES.transferred),
    graftTargets: join(dir, FILE_NAMES.graftTargets),
    txnDir: join(dir, FILE_NAMES.txnDir),
    leftovers: join(dir, FILE_NAMES.leftovers),
    autoGraftSuppressed: join(dir, FILE_NAMES.autoGraftSuppressed),
    constraintSections: join(dir, FILE_NAMES.constraintSections),
    pendingConstraints: join(dir, FILE_NAMES.pendingConstraints),
  })
  return Object.freeze({ paths, ctx })
}
