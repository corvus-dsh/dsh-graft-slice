import type { PluginContextLike } from './gateway-types.js'

export async function discardPartialTarget(ctx: PluginContextLike, targetId: string): Promise<void> {
  const notes: string[] = []
  const persistence = (() => {
    try {
      return ctx.get('sessionPersistence') as any
    } catch {
      return undefined
    }
  })()
  const sessions = (() => {
    try {
      return ctx.get('sessions') as any
    } catch {
      return undefined
    }
  })()
  // 1. The prepared reservation, if the backend exposes a discard.
  for (const method of ['discardPrepared', 'discard', 'forget']) {
    if (persistence === undefined || typeof persistence[method] !== 'function') continue
    try {
      await persistence[method](targetId)
      notes.push(`persistence.${method}`)
    } catch (error) {
      notes.push(`persistence.${method} failed: ${String((error as any)?.message ?? error)}`)
    }
    break
  }
  // 2. A durable artifact, if the backend offers a removal.
  for (const method of ['remove', 'delete']) {
    if (persistence === undefined || typeof persistence[method] !== 'function') continue
    try {
      await persistence[method](targetId)
      notes.push(`persistence.${method}`)
    } catch (error) {
      notes.push(`persistence.${method} failed: ${String((error as any)?.message ?? error)}`)
    }
    break
  }
  // 3. A live-store entry, if one was ever published.
  if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(targetId) !== undefined) {
    for (const method of ['remove', 'delete', 'dispose']) {
      if (typeof sessions[method] !== 'function') continue
      try {
        await sessions[method](targetId)
        notes.push(`sessions.${method}`)
      } catch (error) {
        notes.push(`sessions.${method} failed: ${String((error as any)?.message ?? error)}`)
      }
      break
    }
  }
  try {
    ctx.logger?.warn?.(
      notes.length === 0
        ? `[dsh-graft-slice] failed target ${targetId} could not be removed (no delete API on this host); the id stays reserved`
        : `[dsh-graft-slice] discarded failed target ${targetId} (${notes.join(', ')})`,
    )
  } catch {
    // Logging must not replace the primary failure.
  }
}
