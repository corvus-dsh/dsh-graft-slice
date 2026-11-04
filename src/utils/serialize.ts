/**
 * v1.3 REFACTOR — stateless helpers, moved out of the 14k-line index.ts verbatim.
 *
 * Red line for this move: NOTHING here changed behaviour. Same bodies, same names, same
 * error codes and messages. The only additions are the `export` keywords, which the
 * bundler strips when it inlines this file into index.js.
 *
 * Why these functions first: they hold no state, touch no service, open no file. A bad
 * move shows up immediately in the suite (545 tests) instead of in a migration.
 */

/** The typed error every refusal in this plugin uses. */
export function graftError(code: string, message: string): Error & { code: string } {
  const error = new Error(`[${code}] ${message}`) as Error & { code: string }
  error.name = 'GraftError'
  error.code = code
  return error
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw graftError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value
}

export function asSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw graftError('INVALID_ARGUMENT', `${field} must be a non-negative safe integer`)
  }
  return value
}

export function asFiniteInteger(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw graftError('INVALID_CONFIG', `${field} must be a finite number`)
  }
  return Math.max(0, Math.trunc(value))
}

export interface Truncation {
  text: string
  truncated: boolean
  originalLength: number
}

/**
 * v0.23 — NO MORE FREE-TEXT TRUNCATION MARKERS.
 *
 * The marker itself was the bug: a `...[已省略 N 行]` line inserted into JSON makes a
 * downstream parse fail, and the failure is attributed to the reader. Truncation is
 * therefore a bare slice; the cut is declared by structured fields (`truncated`,
 * `originalLength`) and, where a wrapper is needed, by `wrapTruncated()` in index.ts.
 */
export function truncateEnd(text: string, limit: number): Truncation {
  if (limit <= 0 || text.length <= limit) return { text, truncated: false, originalLength: text.length }
  return {
    text: text.slice(0, Math.max(0, limit)),
    truncated: true,
    originalLength: text.length,
  }
}

export function truncateMiddle(text: string, limit: number): Truncation {
  if (limit <= 0 || text.length <= limit) return { text, truncated: false, originalLength: text.length }
  const head = Math.max(1, Math.floor(limit * 0.6))
  const tail = Math.max(0, limit - head)
  // Head and tail are joined WITHOUT a separator: the absent region is declared by the
  // caller, not by a fake line inside the text.
  return {
    text: text.slice(0, head) + (tail > 0 ? text.slice(-tail) : ''),
    truncated: true,
    originalLength: text.length,
  }
}

/** Clamp a ratio into [low, high]; a non-finite value means "at the ceiling". */
export function clampRatio(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return high
  return Math.min(high, Math.max(low, value))
}
