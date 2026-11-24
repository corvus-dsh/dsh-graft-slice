#!/usr/bin/env node
/**
 * ── sync-shared: the ONLY way to copy the shared scripts, and it refuses to stop half-way ────────
 *
 * WHY THIS EXISTS (lead §三十七.5). dsh 用手工 `Copy-Item` 在四仓之间同步「必须逐字节相同」的文件。
 * 手工同步必然有窗口，而窗口期任何一仓跑 check 都会红 —— 这正是那次 paradise `v277` 偶发红的形态。
 *
 * ── WHAT IT ACTUALLY BUYS (and what it does NOT) ─────────────────────────────────────────────────
 *
 * 四个独立仓库之间**没有真正的原子性**。本脚本内部仍然是 N 次复制。它做到的是两件更小、更诚实的事：
 *
 *   1. 窗口从「两条手工命令之间」压缩到「一个命令之内」；
 *   2. 复制完成后**立刻自检**，半完成会被抓住并以 exit 1 退出。
 *
 * 所以正确的说法是「窗口被压缩到一个命令内，且半完成会被自检抓住」—— 不是「结构上无法半完成」。
 * 把自己的方案说大，与把产品说好，是同一种病。
 *
 * ── CONTRACT ────────────────────────────────────────────────────────────────────────────────────
 *
 *   --dry-run   只打印将要复制什么，不写任何文件
 *   幂等        内容相同的文件不重写
 *   自检        复制后立刻跑 `check-shared-sources.mjs`；失败 ⇒ exit 1，并打印**补救命令**
 *   基准        清单里的每个作用域以 `repos[0]` 为基准（写进数据，不靠「其余三仓」这种相对说法）
 *
 * Usage:
 *   node scripts/sync-shared.mjs            # sync + self-check
 *   node scripts/sync-shared.mjs --dry-run  # show the plan only
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = resolve(ROOT, '..')
const dryRun = process.argv.includes('--dry-run')

const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'shared-sources.json'), 'utf8'))
const digestOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

let copied = 0
let skipped = 0
const problems = []

for (const [scopeName, scope] of Object.entries(manifest.scopes ?? {})) {
  const repos = scope.repos ?? []
  if (repos.length === 0) continue
  /** `repos[0]` is the BASE — recorded in the data so nobody has to guess. */
  const base = repos[0]
  const baseDir = join(WORKSPACE, base, 'scripts')
  if (!existsSync(baseDir)) {
    problems.push(`基准仓 ${base} 不在工作区（作用域 ${scopeName}）`)
    continue
  }
  for (const file of scope.files ?? []) {
    const source = join(baseDir, file)
    if (!existsSync(source)) {
      problems.push(`${base}/scripts/${file} 不存在 —— 清单要求它存在`)
      continue
    }
    const sourceDigest = digestOf(source)
    for (const repo of repos.slice(1)) {
      const target = join(WORKSPACE, repo, 'scripts', file)
      if (existsSync(target) && digestOf(target) === sourceDigest) {
        skipped += 1
        continue
      }
      if (dryRun) {
        console.log(`  would copy ${file}: ${base} -> ${repo}`)
        copied += 1
        continue
      }
      try {
        copyFileSync(source, target)
        copied += 1
      } catch (error) {
        problems.push(`${file}: ${base} -> ${repo} 复制失败（${String(error?.message ?? error)}）`)
      }
    }
  }
}

console.log(
  `sync-shared: scope plan ${dryRun ? '(dry-run)' : '(applied)'} — copied=${copied} already-identical=${skipped}`,
)
for (const problem of problems) console.error(`  ❌ ${problem}`)

if (problems.length > 0) {
  console.error('\nsync-shared: ABORTED — 上面的问题没有被修掉，仓库可能停在半完成状态。')
  console.error('补救：先修复被点名的问题，然后重新运行 `node scripts/sync-shared.mjs`；')
  console.error('      `node scripts/check-shared-sources.mjs` 会告诉你现在到底哪些仓还不一致。')
  process.exit(1)
}

if (dryRun) {
  console.log('sync-shared: dry-run 结束，没有写任何文件。')
  process.exit(0)
}

/**
 * Self-check BEFORE reporting success. This is the half that makes the window survivable: a half-done
 * copy cannot be mistaken for a finished one.
 */
const check = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-shared-sources.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
})
process.stdout.write(check.stdout ?? '')
process.stderr.write(check.stderr ?? '')

if ((check.status ?? 1) !== 0) {
  console.error('\nsync-shared: 复制完成了，但自检没通过 —— 不要把这当成同步成功。')
  console.error('补救：`node scripts/check-shared-sources.mjs` 查看点名的不一致，修好后重跑本脚本。')
  process.exit(1)
}

console.log('sync-shared: OK — 复制完成且自检通过（窗口被压缩到一个命令内，不是「原子」）。')