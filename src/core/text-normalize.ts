export function normalizeText(text: string): string {
  // Preserve code-block indentation and blank lines: recent turns are supposed
  // to be high-fidelity, not flattened prose. Only normalize line endings and
  // trim the outer edges.
  return text.replace(/\r\n/gu, '\n').trim()
}

export function tokenSet(text: string): Set<string> {  return new Set((text.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/gu) ?? []))
}

export function nearDuplicate(a: string, b: string): boolean {
  const left = tokenSet(a)
  const right = tokenSet(b)
  if (left.size === 0 || right.size === 0) return normalizedEqual(a, b)
  let overlap = 0
  for (const token of left) if (right.has(token)) overlap += 1
  return overlap / Math.max(left.size, right.size) >= 0.9
}

export function normalizedEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * ── ONE NORMALISATION FOR WORKSPACE PATHS (B1-5) ────────────────────────────────────────────────
 *
 * `D:\x`, `d:/x/` and `D:\x\` are the same directory, and a constraint rejected under one spelling
 * must apply to the others. This exact expression already existed INLINE in three places
 * (the scope matcher in `index.ts`, `core/command-guard.ts`, `core/host-noise.ts`); adding a fourth
 * copy is precisely the failure this repository keeps recording (same rule, N implementations —
 * they agree until one is edited). So it lives here once, and new code calls it.
 *
 * It is a KEY, not a display value: lower-cased, forward-slashed, trailing slashes removed. Callers
 * that need to show a path to a human must keep the original string.
 */
export function normalizeWorkspace(value: string): string {
  return value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
}
