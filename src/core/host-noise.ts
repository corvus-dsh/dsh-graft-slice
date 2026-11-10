/**
 * v0.17: strip HOST NOISE from anything that crosses into a migrated session.
 *
 * The audit that motivated this: a session's own tool output recorded the
 * machine it happened to run on — `C:\Users\<user>\AppData\...`, `/home/...`,
 * `/tmp/...` — and a filesystem sweep of a drive root. Those bytes are real
 * history, but they are not *this project's* history, and they are actively
 * harmful in a tape: they teach the next session that the profile directory is
 * part of its workspace, and they hand it paths it cannot resolve. The workspace
 * red line tells a model not to go there; this stops the tape from *showing* it
 * the way.
 *
 * Two rules, because the two cases differ:
 *
 *   1. a paragraph that names only host paths is REPLACED by a marker — the
 *      reader learns something was elided instead of quietly receiving less;
 *   2. a paragraph that names host paths AND project paths keeps its project
 *      content and has the host tokens redacted, because dropping it would lose
 *      work that actually happened here.
 *
 * The marker is deliberate: a silent deletion in a verbatim replay is the exact
 * "unmarked hole" failure the per-turn budget rules exist to prevent.
 */
export const HOST_NOISE_MARKER = '[宿主环境噪音，已过滤]'

export const HOST_PATH_MARKER = '[宿主路径已过滤]'

export const FOLDED_OUTPUT_MARKER = '[命令输出已折叠]'

/** Host-owned locations. Narrow on purpose: a project path under `D:\` is not noise. */
export const HOST_PATH_PATTERN =
  /[A-Za-z]:[\\/]Users[\\/][^\s"',;)]*|\bAppData\b|(?:\/home\/|\/tmp\/|\/var\/folders\/)[^\s"',;)]*|%(?:APPDATA|LOCALAPPDATA|USERPROFILE)%|\$env:(?:APPDATA|LOCALAPPDATA|USERPROFILE)\b|[A-Za-z]:[\\/]Windows[\\/][^\s"',;)]*|\b[A-Za-z]:[\\/](?=$|[\s"',;)])|~[\\/](?=$|[\s"',;)])/iu

/** A sweep of a whole volume, as opposed to a search inside the workspace. */
export const GLOBAL_SEARCH_PATTERN =
  /\brg\b[^\n]{0,40}\s\/(?:\s|$)|\b(?:Get-ChildItem|gci|dir|ls|find|grep|findstr|Select-String)\b[^\n]{0,60}(?:\s\/\s|[A-Za-z]:[\\/](?:\s|$))|\b(?:find|du|grep)\b[^\n]{0,30}\s\/(?:\s|$)|-Recurse[^\n]{0,40}[A-Za-z]:[\\/](?:\s|$)/iu

export function isProjectPath(candidate: string, cwd: string): boolean {
  if (cwd.length === 0) return false
  const normalize = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
  const target = normalize(candidate)
  const root = normalize(cwd)
  return target.length > 0 && root.length > 0 && (target === root || target.startsWith(`${root}/`))
}

/**
 * @param text anything headed for the tape, the pending state or the workspace block
 * @param cwd the source session's working directory: the only path that is NOT noise
 */
export function stripHostNoise(text: string, cwd = ''): string {
  const input = typeof text === 'string' ? text : ''
  if (input.length === 0) return input
  // Paragraphs, so a redaction cannot silently merge two unrelated statements.
  const paragraphs = input.split(/\n{2,}/u)
  const cleaned = paragraphs.map((paragraph) => {
    if (paragraph.trim().length === 0) return paragraph
    const hasHostPath = HOST_PATH_PATTERN.test(paragraph)
    const hasGlobalSearch = GLOBAL_SEARCH_PATTERN.test(paragraph)
    if (!hasHostPath && !hasGlobalSearch) return paragraph
    // Does this paragraph also carry something that belongs to the project?
    const projectPaths = (paragraph.match(/(?:[A-Za-z]:[\\/]|\/)[^\s"',;)]+/gu) ?? []).filter((candidate) =>
      isProjectPath(candidate, cwd),
    )
    const keepBecauseProject = projectPaths.length > 0
    if (hasGlobalSearch && !keepBecauseProject) return FOLDED_OUTPUT_MARKER
    if (!keepBecauseProject) return HOST_NOISE_MARKER
    return paragraph.replace(new RegExp(HOST_PATH_PATTERN.source, 'giu'), HOST_PATH_MARKER)
  })
  return cleaned.join('\n\n')
}
