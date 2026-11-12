// 依赖图环检测：加 import 修类型错误时，唯一真正的危险是「引入环」。
// 输出：节点数、边数、所有环（若有）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ── THE REPO PATH MUST BE DERIVED, NOT TYPED ─────────────────────────────────────────────────────
 *
 * The first version hard-coded `D:/持久层能力架构/dsh-graft-slice` — this machine's absolute path.
 * It passed every local run and failed on its very first CI run (#118, step 19) because on the
 * runner there is no `D:` drive at all. Every other script in this directory already derives the
 * root from `import.meta.url`; this one did not, and nothing local could catch it.
 *
 * A path constant that only exists on one machine is not a configuration, it is a bug with a
 * delayed report — and the delay is exactly one push.
 */
const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')

function walk (dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith('.ts') && !e.includes('.bak')) out.push(p)
  }
  return out
}

const files = walk(SRC)
const IMP = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gu

/** 解析相对 spec 到真实文件（补 .ts） */
function target (fromFile, spec) {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/u, ''))
  for (const cand of [base + '.ts', join(base, 'index.ts')]) {
    try { if (statSync(cand).isFile()) return cand } catch { /* not this one */ }
  }
  return undefined
}

const graph = new Map()
const missing = []
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const outs = new Set()
  for (const m of text.matchAll(IMP)) {
    const t = target(f, m[1])
    if (t === undefined) { missing.push(`${relative(SRC, f)} -> ${m[1]}`); continue }
    if (t !== f) outs.add(t)
  }
  graph.set(f, outs)
}

const rel = f => relative(SRC, f).replace(/\\/g, '/')

// Tarjan 强连通分量：>1 的 SCC 就是环
let index = 0
const idx = new Map(); const low = new Map(); const onStack = new Set(); const stack = []; const sccs = []
function strongconnect (v) {
  idx.set(v, index); low.set(v, index); index += 1
  stack.push(v); onStack.add(v)
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))) }
    else if (onStack.has(w)) { low.set(v, Math.min(low.get(v), idx.get(w))) }
  }
  if (low.get(v) === idx.get(v)) {
    const comp = []
    let w
    do { w = stack.pop(); onStack.delete(w); comp.push(w) } while (w !== v)
    if (comp.length > 1) sccs.push(comp)
  }
}
for (const f of files) if (!idx.has(f)) strongconnect(f)

const edges = [...graph.values()].reduce((s, o) => s + o.size, 0)
console.log(`nodes: ${files.length}  edges: ${edges}  unresolved: ${missing.length}`)
if (missing.length > 0) console.log('unresolved:\n  ' + missing.join('\n  '))
if (sccs.length === 0) {
  console.log('ACYCLIC — no dependency cycle')
} else {
  console.log(`CYCLES: ${sccs.length}`)
  for (const c of sccs) console.log('  ' + c.map(rel).join(' ⇄ '))
  process.exitCode = 1
}
