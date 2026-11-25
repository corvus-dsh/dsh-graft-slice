import type { BoardVerification } from './task-board.js'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

/**
 * v0.23 P2 — MEASURE WHAT THE FILESYSTEM SAYS, AT HANDOFF TIME.
 *
 * Read-only, bounded, and failure-tolerant by construction: the handoff must never
 * fail because a `git` binary is missing. A probe that cannot answer records WHY in
 * `unavailable`, because "could not check" and "checked, clean" are different facts
 * and the board must not present them the same way.
 *
 * Why these three probes and no more:
 *   - `rev-parse HEAD` + `log -1` establish WHICH commit the directory is on. That is
 *     the exact claim a board makes ("commit e8da8f6 成功") and the exact thing that
 *     can be a hallucination.
 *   - `status --porcelain` answers "is the work on disk actually committed". A board
 *     that says "done" while 12 files are uncommitted is the common real failure.
 *   - a root listing size is the cheap sanity check that the directory the target will
 *     open is the one the source was working in.
 *
 * Each runs with a short timeout: this happens inside a migrate call, and a hung git
 * process would hold the handoff hostage. Any error is data, not a throw.
 */
export function verifyWorkspace(cwd: string, now: number = Date.now()): BoardVerification {
  const run = (args: string[]): string | undefined => {
    try {
      const out = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      return String(out).trim()
    } catch {
      // Not a repo, git absent, timed out, permission denied: all the same to us.
      return undefined
    }
  }

  let entries: number | undefined
  try {
    entries = readdirSync(cwd).length
  } catch {
    entries = undefined
  }

  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    return { cwd: '(未记录)', unavailable: '源会话没有可用的工作目录', at: now, ...(entries === undefined ? {} : { entries }) }
  }

  const head = run(['rev-parse', '--short', 'HEAD'])
  if (head === undefined) {
    return {
      cwd,
      ...(entries === undefined ? {} : { entries }),
      unavailable: '不是 git 仓库，或没有任何提交',
      at: now,
    }
  }

  const subject = run(['log', '-1', '--pretty=%s'])
  let dirty: { tracked: number; untracked: number } | undefined
  const status = run(['status', '--porcelain'])
  if (status !== undefined) {
    const lines = status.split('\n').filter((line) => line.trim().length > 0)
    // `??` is the porcelain prefix for untracked; everything else is a tracked change.
    dirty = {
      tracked: lines.filter((line) => !line.startsWith('??')).length,
      untracked: lines.filter((line) => line.startsWith('??')).length,
    }
  }

  return {
    cwd,
    head,
    ...(subject === undefined || subject.length === 0 ? {} : { subject }),
    ...(dirty === undefined ? {} : { dirty }),
    ...(entries === undefined ? {} : { entries }),
    at: now,
  }
}
