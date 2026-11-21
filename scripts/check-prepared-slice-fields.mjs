#!/usr/bin/env node
/**
 * ── EVERY `PreparedSlice` FIELD MUST SURVIVE `loadPrepared` ─────────────────────────────────────
 *
 * B4-B B1b. This gate exists because the SAME defect happened twice, and a comment warning about it
 * did not stop the second one.
 *
 * ── THE TWO OCCURRENCES, MEASURED ──────────────────────────────────────────────────────────────
 *
 *   v7.4 · `chunks`   — the review stores the chunk bodies for the tail-vs-history comparison. The
 *                       loader rebuilt entries without it, so commit compared against an empty
 *                       `before` and reported EVERY stable block as changed.
 *   B4-B · `handover` — the model's approved content. The prepare wrote it to disk, the write path
 *                       received it, and the loader dropped it — so the target session got none of it.
 *
 * Between the two, the loader's own comment acquired this warning:
 *
 *     // v7.4: chunks must survive the round-trip. This loader rebuilds the entry
 *     // field by field, so a field missing from this list is silently dropped
 *
 * **And `handover` was still missed.** A comment is not a check: it has to be read by the person
 * adding the field, at the moment they are adding it, in a file they are not editing.
 *
 * ── WHY A STATIC CHECK, NOT ANOTHER BEHAVIOUR TEST ────────────────────────────────────────────
 *
 * `v295 ①` DOES catch a dropped `handover` — by reading the target session. But it costs a full
 * prepare+commit and, when it fails, it fails with 「内容没进磁带」, which is the SYMPTOM. The root cause
 * (a field missing from a list 4000 lines away) is only visible by reading two blocks side by side.
 * This gate names the field and the file, in ~30 lines, at zero runtime cost.
 *
 * ── WHAT IT COMPARES ─────────────────────────────────────────────────────────────────────────
 *
 *   A. the field names of `interface PreparedSlice { … }` in `src/core/state.ts`
 *   B. the keys of the object literal passed to `preparedSlices.set(id, { … })` in `src/index.ts`
 *
 * Every A must appear in B. A field that only exists in the interface is a field the loader drops.
 *
 * ── WHAT IT DOES NOT COVER, STATED RATHER THAN IMPLIED ───────────────────────────────────────
 *
 *   · the REVERSE direction (a key in B that is not in A) is not an error — the loader may legitimately
 *     derive a field (`preparedId: id`) — but it IS reported as an observation;
 *   · it does not check the field's TYPE or that the value was validated;
 *   · it does not check `persistPrepared` (that one serialises the whole object, so it cannot drop a
 *     field by omission — which is exactly why the loader is the only place this can happen).
 *
 * 用法：node scripts/check-prepared-slice-fields.mjs [--json]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The root is the CALLER'S directory (W5-1's lesson: `import.meta.url` answers about the wrong tree). */
const REPO = process.cwd()
const STATE = join(REPO, 'src', 'core', 'state.ts')
const INDEX = join(REPO, 'src', 'index.ts')

/**
 * Field names of `interface PreparedSlice { … }`.
 *
 * Brace counting after the `interface` keyword, so a nested object type (`{ pending?, notes? }`) does
 * not end the block early — the same lesson `check-silent-catch.mjs` learned about brace matching.
 */
export function interfaceFields(source) {
  const start = source.search(/export\s+interface\s+PreparedSlice\s*\{/u)
  if (start < 0) return undefined
  const braceAt = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let index = braceAt; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end < 0) return undefined

  const body = source.slice(braceAt + 1, end)
  const fields = []
  /** Top-level `name:` / `name?:` at depth 0 only — a nested type's members are not fields of this one. */
  let nested = 0
  for (const line of body.split(/\r?\n/u)) {
    const stripped = line.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\*.*$/u, '').trim()
    if (stripped.length === 0) continue
    if (nested === 0) {
      const match = /^([A-Za-z_$][\w$]*)\s*\??\s*:/u.exec(stripped)
      if (match !== null) fields.push(match[1])
    }
    nested += (stripped.match(/\{/gu) ?? []).length - (stripped.match(/\}/gu) ?? []).length
    if (nested < 0) nested = 0
  }
  return fields
}

/**
 * Keys of the object literal passed to the LAST `preparedSlices.set(id, { … })` in `src/index.ts`.
 *
 * Only the loader has this shape; `prepareSlice` uses `preparedSlices.set(preparedId, entry)` with a
 * variable, and a test file could pass anything. Taking the object-literal form keeps the comparison
 * aimed at the reconstruction list, which is the only place a field can be dropped.
 */
export function reconstructionKeys(source) {
  const match = /preparedSlices\.set\(\s*id\s*,\s*\{/u.exec(source)
  if (match === null) return undefined
  const braceAt = match.index + match[0].length - 1
  let depth = 0
  let end = -1
  for (let index = braceAt; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end < 0) return undefined

  const body = source.slice(braceAt + 1, end)
  const keys = []
  let nested = 0
  for (const line of body.split(/\r?\n/u)) {
    const stripped = line.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\*.*$/u, '').trim()
    if (stripped.length === 0) continue
    if (nested === 0) {
      /**
       * A key is `name:` at the START of a line, or a shorthand `name,`. Both appear in this block
       * (`preparedId: id,` and, before v7.4, bare `chunks,`).
       */
      const explicit = /^([A-Za-z_$][\w$]*)\s*:/u.exec(stripped)
      const shorthand = /^([A-Za-z_$][\w$]*)\s*,?\s*$/u.exec(stripped)
      const found = explicit ?? shorthand
      if (found !== null) keys.push(found[1])
    }
    nested += (stripped.match(/\{/gu) ?? []).length - (stripped.match(/\}/gu) ?? []).length
    if (nested < 0) nested = 0
  }
  return keys
}

/** Fields of the interface that the loader does NOT copy. Each one is a field that gets dropped. */
export function droppedFields(fields, keys) {
  const present = new Set(keys)
  return fields.filter((field) => !present.has(field))
}

function main() {
  let stateText
  let indexText
  try {
    stateText = readFileSync(STATE, 'utf8')
    indexText = readFileSync(INDEX, 'utf8')
  } catch (error) {
    console.log(`prepared-slice-fields: FAILED TO START — cannot read a source file: ${String(error?.message ?? error)}`)
    return 1
  }

  const fields = interfaceFields(stateText)
  const keys = reconstructionKeys(indexText)

  if (fields === undefined) {
    console.log(`prepared-slice-fields: FAILED TO START — no \`interface PreparedSlice\` in ${STATE}`)
    return 1
  }
  if (keys === undefined) {
    console.log(
      `prepared-slice-fields: FAILED TO START — no \`preparedSlices.set(id, { … })\` in ${INDEX}. ` +
        'The loader may have been renamed or restructured; update this gate rather than deleting it.',
    )
    return 1
  }
  /** A scan over an empty set reports no problems — both halves need a denominator. */
  if (fields.length < 5) {
    console.log(`prepared-slice-fields: FAILED TO START — parsed only ${fields.length} field(s); the parser is wrong`)
    return 1
  }
  if (keys.length < 5) {
    console.log(`prepared-slice-fields: FAILED TO START — parsed only ${keys.length} key(s); the parser is wrong`)
    return 1
  }

  const dropped = droppedFields(fields, keys)
  const extra = keys.filter((key) => !fields.includes(key))

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ fields, keys, dropped, extra }, null, 2))
    return dropped.length === 0 ? 0 : 1
  }

  if (dropped.length === 0) {
    console.log(
      `prepared-slice-fields: OK — all ${fields.length} field(s) of PreparedSlice are copied by ` +
        `loadPrepared (${keys.length} key(s) in the reconstruction)` +
        (extra.length === 0 ? '' : ` · observed extra key(s): ${extra.join(', ')}`),
    )
    return 0
  }

  console.log(`prepared-slice-fields: ${dropped.length} field(s) would be DROPPED by loadPrepared`)
  for (const field of dropped) {
    console.log(`  ${field} — declared in state.ts, but missing from the preparedSlices.set(id, { … }) block`)
  }
  console.log('')
  console.log('A field in the interface but not in the reconstruction is written to disk and thrown away on')
  console.log('the way back. Measured twice: `chunks` (v7.4) and `handover` (B4-B B1). The second one had a')
  console.log('comment warning about the first, which is why this is a check and not another comment.')
  console.log('')
  console.log(`Files: ${STATE} · ${INDEX}`)
  return 1
}

process.exitCode = main()