import { homedir } from 'node:os'
import { join } from 'node:path'
/** Search/enumeration verbs: these are what turn a path into a filesystem sweep. */
export const SEARCH_VERB =
  /\b(?:rg|ripgrep|grep|findstr|select-string|sls|get-childitem|gci|dir|ls|find|where\.exe|get-item|resolve-path|tree)\b/iu

/**
 * Destructive verbs. Grouped so the workspace-confinement rule can exempt them.
 *
 * ── D1: `format` IS SEPARATED FROM THE FORMATTING CMDLETS (measured: 5 of 11 ordinary reads blocked) ─
 *
 * A bare `\bformat\b` also matches `Format-Table` and `Format-List` — the PowerShell cmdlets that
 * RENDER objects in a pipeline. In a read-only command they are formatting, not formatting-a-disk:
 *
 *       Get-ChildItem -Force 'D:\x' | Format-Table     ← a READ, and this one was DENIED
 *
 * So `format` counts only when it is NOT followed by `-` (the cmdlet suffix) and not part of a longer
 * word. `format D:` still matches (no dash); `Format-Volume` is matched by its own branch so the more
 * common PowerShell spelling is caught too.
 *
 * ── D3': THE MISSED DETECTION (dangerous, so it does not wait for D3) ────────────────────────────
 *
 * `Format-Volume -DriveLetter D -Force` was ALLOWED while `format D: /q` was denied: the guard caught
 * the cmd.exe spelling and missed the PowerShell one, i.e. it missed the more common form on this
 * platform. `format-volume` is therefore its own alternative.
 */
export const DESTRUCTIVE_VERB =
  /\b(?:rm|del|erase|rd|rmdir|remove-item|ri|diskpart|mkfs|shutdown|stop-computer|clear-disk)\b|\bformat-volume\b|\bformat(?![\w-])/iu

/**
 * Verbs that are destructive in EVERY form — there is no workspace-scoped version to confine them to.
 *
 * `Remove-Item .\build\x.log` is cleanup. `Format-Volume -DriveLetter D` destroys everything on a
 * volume, and no relative path can make it smaller. Asking "is the target inside the workspace?" of
 * such a command answers a question that does not apply — and, measured, the answer made it ALLOWED:
 * there is no `-Recurse` to trigger the confinement branch and `D:` alone is deliberately not an
 * escaping root. Naming the class lets the denial say what it is instead of falling through to "safe".
 */
export const UNCONFINABLE_VERB = /\b(?:format-volume|diskpart|clear-disk|mkfs|shutdown|stop-computer)\b|\bformat(?![\w-])/iu

/**
 * Flags that make a delete UNBOUNDED — able to reach beyond the path written on the line.
 *
 * ── D2: `-Force` IS NOT IN THIS SET, AND ITS PRESENCE WAS A BUG IN THE OTHER DIRECTION ───────────
 *
 * It used to be here, and the effect was backwards. The confinement rule reads
 * "deny if `recursive && outsideWorkspace`", so a flag that counted as recursion GRANTED the exemption
 * to anything inside the workspace — the one flag that makes a wipe SILENT was the flag that made it
 * look confined.
 *
 * `-Force` in PowerShell means "do not prompt / include hidden"; `New-Item`, `Copy-Item` and
 * `Set-Content` all use it as ordinary friction removal.
 */
export const RECURSIVE_FLAG = /(?:-recurse\b|\/s\b|-r\b|-rf\b|-fr\b|--recursive\b|\/q\b)/iu

/**
 * A path that escapes any workspace: a drive root, `/`, a home shortcut, or an
 * environment root. Deliberately narrow — `C:\Users\<user>\project\src` is NOT
 * here, because reading a specific path is legitimate; sweeping a root is not.
 *
 * Split in two on purpose: one regex with six alternatives and lookaheads is how
 * a guard acquires a typo that silently matches nothing.
 */
export const ESCAPING_ROOT =
  /\b[A-Za-z]:[\\/](?=$|[\s"'),;])|(?:^|[\s"'=(,])\/(?=$|[\s"'),;])|~[\\/]?(?=$|[\s"'),;])|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|windir)%|\$env:(?:USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|windir)\b/iu

/** The system directories every Windows profile has, and `AppData` anywhere. */
export const SYSTEM_DIR =
  /[A-Za-z]:[\\/](?:Users|Windows|Program Files(?: \(x86\))?|ProgramData)(?=$|[\\/\s"'),;])|(?:^|[\s"'=(,\\\/])AppData(?=$|[\\/\s"'),;])/iu

export function escapesWorkspace(text: string): boolean {
  return ESCAPING_ROOT.test(text) || SYSTEM_DIR.test(text)
}

/**
 * ── D1: A VERB MUST BE IN COMMAND POSITION, OR IT IS DATA ────────────────────────────────────────
 *
 * Matching a destructive word ANYWHERE denies `rg "format" src/` — a search for the WORD `format` —
 * which is the same failure this rule is being fixed for, one layer down. The word is a verb only at
 * the START of a command segment; anywhere else it is an argument.
 *
 * Segments start at the beginning and after a pipe, semicolon, `&&`, `||`, or an opening parenthesis.
 * A few wrappers are skipped so `sudo rm -rf` still counts: their verb is the one after the wrapper.
 */
export const SEGMENT_START = /(?:^|[|;&]\s*|\()\s*(?:(?:sudo|doas|env|command|exec|&)\s+)*(?<verb>[A-Za-z][\w.-]*)/gu

/** Does `pattern` match a word sitting in COMMAND POSITION? */
export function verbInCommandPosition(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(SEGMENT_START)) {
    const verb = match.groups?.verb ?? ''
    pattern.lastIndex = 0
    if (pattern.test(verb)) {
      pattern.lastIndex = 0
      return true
    }
  }
  return false
}

/**
 * Expand the environment shortcuts a destructive command may hide behind, so the
 * confinement check sees a real path. Only the roots the guard cares about;
 * anything unknown is left as-is and treated as "not provably inside".
 */
export function expandKnownRoots(text: string): string {
  return text
    .replace(/%USERPROFILE%/giu, () => homedir())
    .replace(/\$env:USERPROFILE\b/giu, () => homedir())
    .replace(/%APPDATA%/giu, () => join(homedir(), 'AppData', 'Roaming'))
    .replace(/\$env:APPDATA\b/giu, () => join(homedir(), 'AppData', 'Roaming'))
    .replace(/%LOCALAPPDATA%/giu, () => join(homedir(), 'AppData', 'Local'))
    .replace(/\$env:LOCALAPPDATA\b/giu, () => join(homedir(), 'AppData', 'Local'))
}

/** Path-ish tokens of a command, for the confinement check. */
export function pathTokensOf(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/(?:[A-Za-z]:[\\/]|\/|~[\\/]?|\.{1,2}[\\/])[^\s"'`,;)|&]+/gu)) out.push(match[0])
  return out
}

export function isInsideWorkspace(target: string, workspace: string): boolean {
  if (workspace.length === 0) return false
  // A relative target is, by definition, relative to the session's directory.
  // `..` is not: it leaves the workspace, and "not provably inside" must not read
  // as "inside" for a recursive delete.
  if (!/^(?:[A-Za-z]:[\\/]|\/|~)/u.test(target)) return !/^\.\.[\\/]|^\.\.$/u.test(target)
  const normalize = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
  const normalizedTarget = normalize(target)
  const normalizedWorkspace = normalize(workspace)
  if (normalizedTarget.length === 0 || normalizedWorkspace.length === 0) return false
  return normalizedTarget === normalizedWorkspace || normalizedTarget.startsWith(`${normalizedWorkspace}/`)
}

/**
 * v0.18: the RISK CLASS the scanner reports, separated from the DECISION the
 * policy makes about it.
 *
 * The audit's point was that a string matcher was doing two jobs at once: deciding
 * what a command IS, and deciding whether to block it. The first is evidence (and
 * regexes are fine for it); the second is policy, and policy belongs in one table
 * an operator can read and change. Splitting them is also what makes the modes
 * testable: `strict` and `autonomous` differ in the decision table only.
 */
export type CommandRisk = 'safe' | 'unknown' | 'destructive'

export interface CommandAssessment {
  risk: CommandRisk
  code?: 'GLOBAL_SEARCH' | 'DESTRUCTIVE_COMMAND'
  reason?: string
}

/**
 * v0.18: classify a command by risk, without deciding what to do about it.
 *
 * Deliberately NOT a richer taxonomy: every extra class is a class someone must
 * keep calibrated, and the two that matter operationally are "provably confined"
 * and "provably unbounded". Everything else is `unknown`, and `unknown` fails
 * closed outside `autonomous`.
 */
export function classifyAgentCommand(command: string, workspace = ''): CommandAssessment {
  const raw = typeof command === 'string' ? command : ''
  if (raw.trim().length === 0) return { risk: 'safe' }
  const text = expandKnownRoots(raw)

  if (verbInCommandPosition(text, UNCONFINABLE_VERB)) {
    /**
     * Checked BEFORE the confinement branch on purpose. Reaching that branch first would produce
     * "target is not provably inside the workspace", which is true but beside the point — a caller
     * could reasonably conclude that pointing it INSIDE the workspace would be allowed.
     */
    return {
      risk: 'destructive',
      code: 'DESTRUCTIVE_COMMAND',
      reason:
        'DESTRUCTIVE_COMMAND：该命令会销毁整个卷/磁盘或系统状态，不存在“限制在工作区内”的版本。' +
        `当前工作区：${workspace.trim().length > 0 ? workspace : '(未知)'}。` +
        '这类命令一律拒绝；如果确实需要，请用户手动执行。',
    }
  }

  if (verbInCommandPosition(text, DESTRUCTIVE_VERB)) {
    const escaping = escapesWorkspace(text)
    const recursive = RECURSIVE_FLAG.test(text)
    const workspaceKnown = workspace.trim().length > 0
    const targets = pathTokensOf(text)
    const outsideWorkspace =
      workspaceKnown && targets.length > 0 && targets.every((target) => !isInsideWorkspace(target, workspace))
    if (escaping || (recursive && outsideWorkspace)) {
      return {
        risk: 'destructive',
        code: 'DESTRUCTIVE_COMMAND',
        reason:
          'DESTRUCTIVE_COMMAND：该命令是递归/强制的破坏性删除，且目标落在工作区之外或指向系统根目录。' +
          `当前工作区：${workspaceKnown ? workspace : '(未知)'}。` +
          '如果确实需要清理，请把目标限制在工作区内并给出确切路径（例如相对路径 .\\build），或让用户确认后手动执行。',
      }
    }
    // A destructive verb we cannot place: `rm -rf` with a relative bare name is
    // ordinary, `Remove-Item -Recurse <unknown absolute>` is not provable either way.
    if (recursive && !workspaceKnown) {
      return {
        risk: 'unknown',
        code: 'DESTRUCTIVE_COMMAND',
        reason: 'DESTRUCTIVE_COMMAND：无法确认目标是否在工作区内（工作目录未知），请给出确切路径或确认后执行。',
      }
    }
    return { risk: 'safe' }
  }

  if (SEARCH_VERB.test(text) && escapesWorkspace(text)) {
    return {
      risk: 'destructive',
      code: 'GLOBAL_SEARCH',
      reason:
        'GLOBAL_SEARCH：禁止针对盘符根目录 / AppData / 用户目录 / 全局根（如 rg / 、Get-ChildItem -Recurse）的搜索。' +
        `当前工作区：${workspace.trim().length > 0 ? workspace : '(未知)'}。` +
        '找不到文件时请只在当前目录用 ls / dir 查找，或直接询问用户；不要换写法重试、不要向外层目录扩散。',
    }
  }
  return { risk: 'safe' }
}
