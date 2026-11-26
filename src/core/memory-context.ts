/**
 * v1.7.0 — RENDER WHAT THE MEMORY STORE KNOWS, FOR A HANDOFF.
 *
 * WHY THIS BELONGS IN A SLICE AT ALL
 *
 * A handoff replays what the SOURCE SESSION did. It cannot say what the organisation already
 * learned — the SKILL.md describing the working method, or the negative recording why the obvious
 * approach fails. Those live in `dsh-memory`, and without them every new session rediscovers what
 * an old one paid for. That rediscovery is the cost the memory layer exists to remove, so a slice
 * that omits it is handing off a task with its history but without its lessons.
 *
 * WHY THE RENDERER IS PURE AND TAKES PLAIN DATA
 *
 * `dsh-graft-slice` does not depend on `dsh-memory` — importing it would make the slicer unable to
 * run without a memory store, which is the coupling both plugins avoid. So the caller recalls and
 * passes the hits in; this function only formats them.
 */
export interface MemoryContextInput {
  /** Skills worth carrying: the working method for this kind of task. */
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly title: string; readonly when?: string }>
  /** Negatives worth carrying: what already went wrong, so it is not repeated. */
  readonly negatives?: ReadonlyArray<{ readonly title: string; readonly detail?: string }>
  /** Facts worth carrying. Kept short — they are context, not instructions. */
  readonly facts?: ReadonlyArray<{ readonly title: string }>
  /** Per-item character cap for the detail line. Default 160. */
  readonly maxDetailChars?: number
}

/**
 * Format memory hits as an injection block, or return `undefined` when there is nothing to say.
 *
 * RETURNING `undefined` FOR AN EMPTY SET IS DELIBERATE: an empty "MEMORY CONTEXT" heading reads as
 * "memory was consulted and knew nothing", which is a different (and misleading) signal from "memory
 * was not consulted for this slice". The caller only adds the chunk when this returns text.
 */
export function renderMemoryContext(input: MemoryContextInput): string | undefined {
  const skills = input.skills ?? []
  const negatives = input.negatives ?? []
  const facts = input.facts ?? []
  if (skills.length === 0 && negatives.length === 0 && facts.length === 0) return undefined
  const cap = Math.max(40, Math.trunc(input.maxDetailChars ?? 160))
  const lines: string[] = ['## MEMORY CONTEXT（历史沉淀，不是本次任务的要求）', '']

  if (skills.length > 0) {
    lines.push('### 已知做法（来自技能库，直接复用，不要重新发明）')
    for (const skill of skills) {
      const when = skill.when === undefined || skill.when.length === 0 ? '' : `　适用：${skill.when.slice(0, cap)}`
      lines.push(`- \`${skill.name}\` — ${skill.title.slice(0, cap)}${when}`)
    }
    lines.push('')
  }

  if (negatives.length > 0) {
    lines.push('### 已知失败（这些做法已经试过并且失败，不要重复）')
    for (const negative of negatives) {
      const detail = negative.detail === undefined || negative.detail.length === 0 ? '' : `　→ ${negative.detail.slice(0, cap)}`
      lines.push(`- ${negative.title.slice(0, cap)}${detail}`)
    }
    lines.push('')
  }

  if (facts.length > 0) {
    lines.push('### 相关事实')
    for (const fact of facts) lines.push(`- ${fact.title.slice(0, cap)}`)
    lines.push('')
  }

  lines.push('这些是历史沉淀，与上方 HARD CONSTRAINTS 不冲突；若冲突，以 HARD CONSTRAINTS 为准。')
  return lines.join('\n')
}
