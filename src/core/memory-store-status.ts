import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { MEMORY_LAYOUT_VERSION, assertLayoutSupported } from './layout.js'
/**
 * v0.14: read the memory store read-only, and — with `workspace` — say which
 * records are "dirty" from that workspace's point of view: written elsewhere, or
 * written with no provenance at all (the records the isolation gate refuses).
 */
export function collectMemoryStoreStatus(
  memoryDir: string,
  skillsDir: string,
  workspace?: string,
): Record<string, unknown> {
  /**
   * P1-2: THE LAYOUT GATE RUNS BEFORE ANY FILE IS OPENED.
   *
   * `readJsonl` below degrades every unreadable file to `[]`, which is right for a file that is
   * merely absent and wrong for a directory whose layout changed: the panel would print
   * `negatives: 0` for a store full of records, and nothing would say why. `.layout.json` — written by
   * `dsh-memory` at its activation — is the only thing that can tell those two apart.
   *
   * A refusal is REPORTED, never thrown out of the tool: this is the read-only debug panel, and
   * "the other plugin is a layout ahead" must not turn a status call into a failed tool call. The
   * panel says `available: false` with the reason, which is strictly more informative than the silent
   * zero it used to print.
   */
  try {
    assertLayoutSupported(memoryDir, { version: MEMORY_LAYOUT_VERSION, producer: 'dsh-memory' })
  } catch (error) {
    return {
      available: false,
      reason: 'LAYOUT_UNSUPPORTED',
      detail: String((error as any)?.message ?? error),
      memoryDir,
      skillsDir,
      counts: { skills: 0, negatives: 0, facts: 0, experiences: 0, suggestions: 0 },
    }
  }
  const wanted = typeof workspace === 'string' ? workspace.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase() : ''
  const readJsonl = (file: string): Array<Record<string, unknown>> => {
    try {
      return readFileSync(join(memoryDir, file), 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {
            return undefined
          }
        })
        .filter((record): record is Record<string, unknown> => record !== undefined)
    } catch {
      return []
    }
  }
  const classify = (records: Array<Record<string, unknown>>): { matched: number; foreign: number; unscoped: number; dirty: Array<Record<string, unknown>> } => {
    if (wanted.length === 0) return { matched: 0, foreign: 0, unscoped: 0, dirty: [] }
    let matched = 0
    let foreign = 0
    let unscoped = 0
    const dirty: Array<Record<string, unknown>> = []
    for (const record of records) {
      const scope = String(record.scope ?? '').toLowerCase()
      const recorded = String(record.workspace ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
      if (scope === 'global') continue
      if (recorded.length === 0) {
        unscoped += 1
        if (dirty.length < 10) dirty.push({ kind: record.kind ?? 'record', reason: 'no workspace recorded (legacy)', text: String(record.text ?? record.symptom ?? '').slice(0, 80) })
        continue
      }
      if (recorded === wanted) matched += 1
      else {
        foreign += 1
        if (dirty.length < 10) dirty.push({ kind: record.kind ?? 'record', reason: `recorded in ${record.workspace}`, text: String(record.text ?? record.symptom ?? '').slice(0, 80) })
      }
    }
    return { matched, foreign, unscoped, dirty }
  }

  const skills: Array<{ name: string; scope: string; workspace: string }> = []
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(skillsDir, entry.name, 'SKILL.md')
      try {
        const text = readFileSync(path, 'utf8')
        skills.push({
          name: entry.name,
          scope: (text.match(/^scope:\s*(.+)$/mu)?.[1] ?? 'project').trim().toLowerCase(),
          workspace: (text.match(/^workspace:\s*(.+)$/mu)?.[1] ?? '').trim(),
        })
      } catch {
        // A skill directory without a readable SKILL.md is not a skill.
      }
    }
  } catch {
    // An absent skills directory means "no skills yet", not a failure.
  }

  const negatives = readJsonl('negatives.jsonl').map((record) => ({ ...record, kind: 'negative' }))
  const facts = readJsonl('facts.jsonl').map((record) => ({ ...record, kind: 'fact' }))
  const experiences = readJsonl('experiences.jsonl').map((record) => ({ ...record, kind: 'experience' }))
  const suggestions = readJsonl('suggestions.jsonl')

  const skillScope = (scope: string): boolean => scope === 'global'
  const skillDirty = (skill: { name: string; scope: string; workspace: string }): boolean => {
    if (wanted.length === 0) return false
    if (skillScope(skill.scope)) return false
    const recorded = skill.workspace.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
    return recorded !== wanted
  }
  const dirtySkills = wanted.length === 0 ? [] : skills.filter(skillDirty)

  return {
    available: true,
    memoryDir,
    skillsDir,
    counts: {
      skills: skills.length,
      negatives: negatives.length,
      facts: facts.length,
      experiences: experiences.length,
      suggestions: suggestions.length,
    },
    // Without a workspace this is a plain inventory; with one, "dirty" means
    // "this record would be REFUSED by the isolation gate for this workspace".
    ...(wanted.length === 0
      ? {}
      : {
          workspace: wanted,
          skillsInWorkspace: {
            matched: skills.length - dirtySkills.length,
            dirty: dirtySkills.length,
            unscoped: skills.filter((skill) => skill.scope !== 'global' && skill.workspace.trim().length === 0).length,
            dirtyList: dirtySkills.slice(0, 10).map((skill) => ({ name: skill.name, reason: skill.workspace.trim().length === 0 ? 'no workspace recorded (legacy)' : `recorded in ${skill.workspace}` })),
          },
          negativeRecords: classify(negatives),
          factRecords: classify(facts),
          experienceRecords: classify(experiences),
        }),
  }
}
