/**
 * ── v146: 包里的文件必须覆盖 package.json 的每一个指针（门禁 B）──────────────────────────────────
 *
 * 用户 2026-11-13 裁定：「pack 文件集必须覆盖 types 与 exports 的每个目标」。
 *
 * 为什么单列一条门禁：`verify-bundle` 查的是**产物内容**（导出面、内联模块），
 * `check-docs` 查的是**文档与代码一致**，两者都不看「包里到底有没有那个文件」。
 * 一个指向未打包文件的字段，在仓库里看不出任何异常 —— 只有装上去的人才会撞到。
 *
 * 本轮 `types` 已删除，所以这条断言当前退化成「没有悬空指针」：
 *   · `main` / `dsh.bundle.patch` / `exports` 的每个目标都必须在包里；
 *   · `exports` 里的 glob 必须至少命中一个包里文件（命中 0 个的 glob 与写死一个不存在的路径等价）；
 *   · 万一以后又把 `types` 加回来，它同样必须被打包 —— 这一条留在测试里，不靠记忆。
 *
 * `npm pack --dry-run --json` 不需要网络，也不需要真的产出 tarball。
 * npm 不可用时按 RESOURCE 规则跳过（不是通过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** glob → 正则：只支持 npm `files`/`exports` 里实际用到的 `*` 形态。 */
const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*')}$`, 'u')

/**
 * 找到 npm 的可执行入口。
 *
 * 两次实测的坑：
 *   ① `execFileSync('npm', …)` 在 Windows 上 ENOENT —— npm 是 `npm.cmd`，`execFile` 不做 PATHEXT 解析。
 *   ② 改成 `npm.cmd` 后变成 EINVAL —— Node 20+ 为 CVE-2024-27980 禁止无 shell 地 spawn `.cmd`。
 *
 * 所以：优先用 `process.env.npm_execpath`（npm 导出的 cli.js，`node <cli.js>` 可直接跑，不需要 shell）；
 * 没有它时在 Windows 上必须开 `shell: true`，由 shell 解析 PATHEXT。参数是常量，没有注入面。
 */
const npmInvocation = () => {
  const execpath = process.env.npm_execpath
  if (typeof execpath === 'string' && execpath.endsWith('.js') && existsSync(execpath)) {
    return { cmd: process.execPath, args: [execpath], shell: false }
  }
  return process.platform === 'win32'
    ? { cmd: 'npm', args: [], shell: true }
    : { cmd: 'npm', args: [], shell: false }
}

const packedFiles = (t) => {
  const { cmd, args, shell } = npmInvocation()
  try {
    const out = execFileSync(cmd, [...args, 'pack', '--dry-run', '--json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell,
    })
    const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)
    return JSON.parse(json)[0].files.map((f) => f.path)
  } catch (error) {
    t.skip(`npm pack --dry-run unavailable (${String(error.message).slice(0, 80)}) — RESOURCE condition, not a pass`)
    return undefined
  }
}

test('v146: every pointer in package.json resolves to a file that is actually packed', (t) => {
  const packed = packedFiles(t)
  if (packed === undefined) return
  const set = new Set(packed)

  const pointers = []
  if (typeof pkg.main === 'string') pointers.push({ field: 'main', target: pkg.main.replace(/^\.\//u, '') })
  if (typeof pkg.types === 'string') pointers.push({ field: 'types', target: pkg.types.replace(/^\.\//u, '') })
  const patch = pkg.dsh?.bundle?.patch
  if (typeof patch === 'string') pointers.push({ field: 'dsh.bundle.patch', target: patch.replace(/^\.\//u, '') })

  const dangling = pointers.filter((p) => !set.has(p.target))
  assert.deepEqual(dangling, [],
    `package.json points at files that are NOT in the tarball:\n  ${dangling.map((d) => `${d.field} -> ${d.target}`).join('\n  ')}`)

  // exports：字符串目标必须逐字在包里；glob 必须命中至少一个
  const exportEntries = Object.entries(pkg.exports ?? {})
  const badExports = []
  for (const [key, value] of exportEntries) {
    const targets = typeof value === 'string' ? [value] : Object.values(value).filter((v) => typeof v === 'string')
    for (const target of targets) {
      const clean = target.replace(/^\.\//u, '')
      if (clean.includes('*')) {
        const re = globToRegExp(clean)
        if (!packed.some((f) => re.test(f))) badExports.push(`${key} -> ${clean} (glob matches nothing in the tarball)`)
      } else if (!set.has(clean)) {
        badExports.push(`${key} -> ${clean} (not packed)`)
      }
    }
  }
  assert.deepEqual(badExports, [], `exports contains dangling pointers:\n  ${badExports.join('\n  ')}`)
})

test('v146: the packed set has no obvious leaks (tests, scripts, scratch)', (t) => {
  const packed = packedFiles(t)
  if (packed === undefined) return

  const forbidden = ['test/', 'scripts/', '_scratch/', 'docs/', '.github/']
  const leaked = packed.filter((p) => forbidden.some((bad) => p === bad.slice(0, -1) || p.startsWith(bad)))
  assert.deepEqual(leaked, [], `development files leaked into the tarball:\n  ${leaked.join('\n  ')}`)

  assert.ok(packed.includes('package.json'), 'package.json must be packed')
  assert.ok(packed.includes('index.js'), 'the entry point must be packed')
})
