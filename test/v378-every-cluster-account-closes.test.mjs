/**
 * ── v378：每一簇的行数账必须闭合（R1 / S15）──────────────────────────────────────────────────────
 *
 * 这条断言原本住在 **paradise** 的 `v374 ④` 里，读的是 **graft** 的 `ARCHITECTURE.md`。两个后果：
 *
 *   1. **graft 的一次纯移动能让 paradise 变红**：`v374` 用 `lines.slice(rowAt, rowAt + 4)` 定位账目段，
 *      graft 合入第 2、3 簇的登记行后，账目段被推出那个 4 行窗口 —— 于是 paradise 红了，
 *      **而 N2 的账目一个字都没变**。实测 508/509。
 *   2. 判据绑的是**位置**，不是**性质**。本批第五次同形（前四次：`everUsedTodo` 绑符号、
 *      `v252 ②` 绑文件、`v347` 绑单元名、S3 绑 87 行）。
 *
 * ── 为什么现在按「标题」定位 ────────────────────────────────────────────────────────────────────
 *
 * 账目段的标题是 `**段一 · 第 N 簇的行数账**`（或带 `（N3）` 后缀）。标题是**语义锚点**：
 * 再搬十簇，它跟着自己那一段走，不会被别人的登记行挤开。行号会漂，标题不会。
 *
 * ── 判据要证的三件事 ──────────────────────────────────────────────────────────────────────────
 *
 *   ① **每一簇**都有账目段（数量 = TD-1a 里 `core/` 新增登记数，不是「至少一条」）
 *   ② 段内同时写出「搬多少行」「净变化」「差额被解释」——三者缺一即红
 *   ③ **负向**：合成一个「77 与 −72 并置但差额不解释」的段落 ⇒ 判定必须拒绝
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ARCH = join(ROOT, 'ARCHITECTURE.md')
const arch = readFileSync(ARCH, 'utf8')
const lines = arch.split('\n')

/**
 * Locate every account paragraph BY TITLE.
 *
 * A paragraph runs from its title line to the next blank line or the next title — never a fixed
 * number of lines, because the neighbours move.
 */
export function accountParagraphs(text) {
  const all = text.split('\n')
  const paragraphs = []
  for (let i = 0; i < all.length; i += 1) {
    if (!/段一\s*·\s*第\s*\d+\s*簇的行数账/u.test(all[i])) continue
    const body = [all[i]]
    for (let j = i + 1; j < all.length; j += 1) {
      /** Stop at a blank line, another title, or a table row (the registry lives right above). */
      if (all[j].trim() === '' || /段一\s*·\s*第\s*\d+\s*簇的行数账/u.test(all[j]) || all[j].startsWith('| `core/')) break
      body.push(all[j])
    }
    paragraphs.push({ title: all[i].trim(), index: i + 1, body: body.join('\n') })
  }
  return paragraphs
}

/**
 * Judge ONE paragraph. Exported so the negative half exercises the same rules as the positive half —
 * a second implementation in the test would be a second source of truth.
 */
/**
 * HOW MANY CLUSTERS HAVE MOVED — from EVIDENCE, not from a constant.
 *
 * `git log --diff-filter=A -- src/core/*.ts` gives one added module per move, and each of those
 * commits names its cluster (`第 N 簇`). That is the only definition here that cannot drift: a
 * constant would need editing on every move, and the whole defect (N4) was a constant that was not
 * edited — `>= 3` while 4 had moved, so deleting one account still passed.
 *
 * Returns the sorted cluster numbers. Empty when git is unavailable — the caller treats an empty
 * set as MEASUREMENT-BROKEN, never as 「zero clusters」 (they plainly exist).
 */
export function clusterNumbersFromGit(repo) {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--format=%s', '--', 'src/core'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const numbers = new Set()
    for (const line of out.split(/\r?\n/u)) {
      const match = /第\s*(\d+)\s*簇/u.exec(line)
      if (match !== null) numbers.add(Number(match[1]))
    }
    return [...numbers].sort((a, b) => a - b)
  } catch {
    return []
  }
}

export function judgeAccount(paragraph) {
  const problems = []
  const body = String(paragraph.body ?? paragraph)

  /** "搬 77 行" / "搬 69 行" — the moved count. */
  const moved = /搬\s*[\d,]+\s*行/u.test(body) || /([\d,]+)\s*行（/u.test(body)
  if (!moved) problems.push('没有写出「搬了多少行」')

  /** "净 −72" — the net change, with a sign. */
  const net = /净\s*[−-]\s*[\d,]+/u.test(body)
  if (!net) problems.push('没有写出「净变化」')

  /**
   * The difference must be EXPLAINED: an import line, separators, re-export lines, blank lines, or an
   * arithmetic identity (`= A + B`). Two numbers side by side with no explanation is the N3 defect.
   */
  const explained = /import|分隔|re-export|空行|=\s*[\d,]+\s*\+\s*[\d,]+/u.test(body)
  if (!explained) problems.push('差额没有被解释（import / 分隔 / re-export / 空行 / 算术恒等式）')

  return problems
}

test('v378 ①: EVERY cluster has an account paragraph (a population, not "at least one")', () => {
  const paragraphs = accountParagraphs(arch)
  /** The count of registered `core/` modules added by moves is the yardstick for how many accounts. */
  const registeredRows = lines.filter((line) => /^\| `core\/[a-z-]+\.ts`/u.test(line)).length
  assert.ok(registeredRows > 10, `① 登记表必须是一个有人口的表，实测 ${registeredRows} 行`)

  /**
   * ── N4（S16）：门槛必须来自证据，且必须是**完整区间** ─────────────────────────────────────────
   *
   * 旧断言是 `paragraphs.length >= 3`，而实测已搬 4 簇 —— **删掉一整簇的账目仍然全绿**。
   * 标题写着「a population, not at least one」，那句话当时只是口号。
   *
   * 现在：已搬簇号从 git 算；账目段里的簇号必须**恰好**是 1..N。多一段、少一段都红，
   * 而缺的那一段会被**点名**（`缺第 2 簇`），不是一句「少于已搬的簇数」让读者自己找。
   */
  const moved = clusterNumbersFromGit(join(ROOT))
  assert.ok(moved.length > 0,
    '① 已搬簇数必须可测（MEASUREMENT-BROKEN）：git 里找不到任何「第 N 簇」提交 —— 不是「0 簇」，是这个量具坏了')

  const documented = paragraphs
    .map((paragraph) => {
      const match = /第\s*(\d+)\s*簇的行数账/u.exec(paragraph.title)
      return match === null ? undefined : Number(match[1])
    })
    .filter((value) => value !== undefined)
    .sort((a, b) => a - b)

  /** A gap is the actionable failure: name the cluster, do not describe the count. */
  const missing = moved.filter((number) => !documented.includes(number))
  const extra = documented.filter((number) => !moved.includes(number))
  assert.deepEqual(missing, [], `① 这些簇已搬但**没有账目段**：缺第 ${missing.join(' / 第 ')} 簇`)
  assert.deepEqual(extra, [], `① 这些账目段声称的簇**并不存在**（git 里没有对应的第 N 簇提交）：第 ${extra.join(' / 第 ')} 簇`)
  assert.equal(documented.length, moved.length,
    `① 账目段数（${documented.length}）必须等于已搬簇数（${moved.length}）`)

  /** And every paragraph must close its own account. */
  const failures = []
  for (const paragraph of paragraphs) {
    const problems = judgeAccount(paragraph)
    if (problems.length > 0) failures.push(`L${paragraph.index} ${paragraph.title}\n    ${problems.join(' / ')}`)
  }
  assert.deepEqual(failures, [],
    `① 这些账目段没有闭合：\n  ${failures.join('\n  ')}`)
})

test('v378 ②: the anchoring is BY TITLE — a neighbour inserting rows must not break it', () => {
  /**
   * 这条是 R1 的核心，用合成的文本直接证明：在一段账目前面插入任意多行（模拟别人登记新模块），
   * 定位结果不变。旧实现（固定 4 行窗口）在这里必红。
   */
  const specimen = [
    '| `core/someone-else.ts` | 别人的登记行 | `x` | — |',
    '| `core/another.ts` | 又一行 | `y` | — |',
    '| `core/third.ts` | 第三行 | `z` | — |',
    '',
    '**段一 · 第 9 簇的行数账**：搬 77 行；净 −72。差额 5 = 1（import）+ 4（分隔与 re-export）。',
  ].join('\n')

  const found = accountParagraphs(specimen)
  assert.equal(found.length, 1, `② 必须按标题找到 1 段，实测 ${found.length}`)
  assert.equal(judgeAccount(found[0]).length, 0,
    `② 前面插了 3 行登记，账目仍必须被判为闭合 —— 这就是「按位置」与「按性质」的分界`)
})

test('v378 ③ (negative): two numbers side by side with NO explanation is refused', () => {
  /**
   * N3 的原形：写「搬 77 行」与「净 −72」，但不解释那 5 行去哪了。
   */
  const symptom = '**段一 · 第 1 簇的行数账**：搬 77 行；净 −72。'
  const problems = judgeAccount(symptom)
  assert.ok(problems.some((line) => line.includes('差额没有被解释')),
    `③ 必须拒绝「两个数字并置而不解释」，实测 problems=${JSON.stringify(problems)}`)
})

test('v378 ④ (negative): a paragraph missing the net figure is refused', () => {
  const symptom = '**段一 · 第 2 簇的行数账**：搬 51 行。差额 1 行 = 新模块的 import 行。'
  const problems = judgeAccount(symptom)
  assert.ok(problems.some((line) => line.includes('净变化')),
    `④ 必须拒绝「只写搬了多少、不写净变化」，实测 problems=${JSON.stringify(problems)}`)
})
