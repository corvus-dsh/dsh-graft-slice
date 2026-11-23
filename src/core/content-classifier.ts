/**
 * ── B1.1 / F2: `content-classifier` —— 给 19 种 `source.kind` 一个名字 ──────────────────────────
 *
 * WHY THIS EXISTS（Q1：「粘贴的报告不算用户需求」）
 *
 * DSH 把很多东西塞进 `user/message`：人类真打的字、时间上下文、运行快照、子智能体结算、
 * 插件回放、压缩摘要……实测 227 个真实会话 / 5,967 条 `user/message` 里有 **19 种**
 * `source.kind`。而旧代码只认识两种：
 *
 *   isHumanAuthored  = kind === 'user'                          （1 种）
 *   isGraftAuthored  = kind === 'plugin:graft-replay' || kind.startsWith('plugin:graft')
 *
 * 剩下 17 种全落到「既不是人也不是我」的默认分支 —— 于是「一条粘贴进来的报告」和
 * 「用户本人的一句要求」在类型上无法区分。Q1 要的正是这个区分。
 *
 * ── 三条纪律（都来自本仓的实测事故）──────────────────────────────────────────────────────────
 *
 * 1. **登记表必须穷举到实测的 19 种**，不是想到几种写几种。夹具 `test/fixtures/source-kinds.json`
 *    是那份全集；`v219` 用它驱动，而不是手抄一张 19 行的表。
 * 2. **未登记的 kind 不许静默丢弃（D5）**：归入 `host-noise`，并置 `unclassified: true`；
 *    `summarizeUnclassified()` 让调用方能在交接时打印「本会话有 N 条未登记的 source.kind」，
 *    让模型知道**它的输入不完整**。
 * 3. **本批不接线**：`apply()` 怎么用它、交接怎么改，是 F4 的事。本模块是纯函数、零 import，
 *    只被测试直接从 `.ts` 加载（Node 不走 `.js`→`.ts` 重写，所以它必须没有相对 import 链）。
 *
 * ── 为什么 `user` 还要二次判定 ────────────────────────────────────────────────────────────────
 *
 * 实测有两类假的 `user`：宿主用 `user` 壳发的系统内容（`[AI 设定…]`、`<system-reminder>`、
 * 压缩摘要），以及人类**粘贴**的报告。两者都不该被当成「用户本人的要求」。
 * `classifyBySource('user')` 只回答「壳是 user」，`classifyHumanText(text)` 回答「里面的字是谁的」。
 */

/**
 * ── THE REGISTRY LIVES HERE (Phase A, lead §25.3①) ───────────────────────────────────────────────
 *
 * `src/contracts/content-taxonomy.v1.json` and `docs/CONTENT-TAXONOMY.md` are both **generated** from
 * the tables below (`node scripts/emit-taxonomy.mjs`), and `v326` compares the three. So the registry has
 * ONE owner, and the JSON/docs are projections rather than second copies of 19 rows.
 *
 * ── WHY THE TABLES ARE HERE AND NOT IN `src/contracts/` ─────────────────────────────────────────
 *
 * The lead's wording was 「JSON 是唯一登记，`content-classifier.ts` 读合同」. Reading it needs a relative
 * import, and this file has TWO constraints that forbid one:
 *
 *   · `v219` loads this module straight from `.ts`. With a `.js` specifier nothing resolves on disk;
 *     with a `.ts` specifier `tsc` refuses (`allowImportingTsExtensions`), and the repo already carries
 *     ONE frozen instance of that diagnostic — adding a second is debt for no gain.
 *   · The file header's rule 「零 import」 exists for exactly that reason.
 *
 * So the direction is reversed: **the code is canonical and the JSON is the projection.** That keeps the
 * lead's actual goal (one owner, three places compared by a gate) and avoids both gate fights. The
 * divergence from the letter is recorded here rather than hidden.
 *
 * 用户裁定：`self-authored` 不是内容类，是 **provenance**。所以内容类是 10 个，而 `cls` 与
 * `provenance` 是两个正交维度，返回两个字段。
 */

/** 10 内容类。`self-authored` 不在这里 —— 它是 provenance。 */
export type ContentClass =
  | 'human'
  | 'objective'
  | 'project-rule'
  | 'session-rule'
  | 'task-transcript'
  | 'async-result'
  | 'peer-message'
  | 'host-noise'
  | 'reference'
  | 'history'

/** 来源属性：这条消息**是谁放进来的**（与「它是什么内容」正交）。 */
export type Provenance = 'human' | 'self' | 'peer' | 'host' | 'reference'

/** 交接里怎么处置这一类。 */
export type Continuation = 'full' | 'pointer' | 'pointer+first-line' | 'drop'

export interface ContentClassSpec {
  readonly id: ContentClass
  readonly label: string
  readonly continuation: Continuation
  /** 是否允许进硬约束候选池（D1 的目的，而不是它的字面）。 */
  readonly intoConstraintCandidates: boolean
  readonly basis: string
}

export interface ProvenanceSpec {
  readonly id: Provenance
  readonly meaning: string
}

export interface SourceKindEntry {
  readonly kind: string
  readonly contentClass: ContentClass
  readonly provenance: Provenance
  readonly note: string
}

export const CATEGORY_TABLES = (() => {
  const contentClasses: readonly ContentClassSpec[] = Object.freeze([
    { id: 'human', label: '人类真打的字', continuation: 'full', intoConstraintCandidates: true, basis: '唯一能承载「用户要什么」的类；受预算截断，但保留原文。' },
    { id: 'objective', label: '总目标 / 目标状态', continuation: 'pointer+first-line', intoConstraintCandidates: false, basis: '目标是「去哪儿」，不是「不许做什么」；由 goal 记录承载，不混进约束池。' },
    { id: 'project-rule', label: '项目级长期约束', continuation: 'full', intoConstraintCandidates: true, basis: 'agent-instructions 是人写在仓库里的规则文件，不是模型注入 —— 与 D1 要防的不是同一件事。' },
    { id: 'session-rule', label: '本会话短期约束', continuation: 'full', intoConstraintCandidates: true, basis: '从 human 文本里抽出的祈使句；出处仍是人，所以有资格进池。' },
    { id: 'task-transcript', label: '转述 / 待分析材料', continuation: 'pointer', intoConstraintCandidates: false, basis: 'Q1 的裁定：转述不是需求。正文可能很长，交接只留指针 + 一句摘要。' },
    { id: 'async-result', label: '子智能体 / 后台作业结果', continuation: 'pointer+first-line', intoConstraintCandidates: false, basis: '结论有用、正文可重读；D3 要求必须留 {kind, seq, 首句}。' },
    { id: 'peer-message', label: '其它节点 / 子智能体发的', continuation: 'pointer+first-line', intoConstraintCandidates: false, basis: '跨节点的指令不是用户指令；留发送者与首句，其余靠指针。' },
    { id: 'host-noise', label: '宿主噪音 / 环境快照', continuation: 'drop', intoConstraintCandidates: false, basis: 'D4：丢弃必须记数，不许静默；影响行为但不该进约束池。' },
    { id: 'reference', label: '参考数据（无权威）', continuation: 'drop', intoConstraintCandidates: false, basis: '来源自称 authority="none"；当成事实引入会把无权威变成有权威。' },
    { id: 'history', label: '压缩摘要 / 上一代交接', continuation: 'pointer', intoConstraintCandidates: false, basis: '摘要已压过一次；再全文带入是二次压缩，且会把上一代的措辞当成本代事实。' },
  ])

  const provenance: readonly ProvenanceSpec[] = Object.freeze([
    { id: 'human', meaning: '人类直接输入' },
    { id: 'self', meaning: '本插件自己注入的（回放 / 交接）—— 这是 provenance，不是内容类' },
    { id: 'peer', meaning: '其它节点 / 子智能体 / 副脑' },
    { id: 'host', meaning: '宿主运行时（时间、cwd、模型切换、审批策略）' },
    { id: 'reference', meaning: '只读参考源（无权威）' },
  ])

  /**
   * 19 种 `source.kind`（B0.8 的实测快照）。不在表里的一律走 `UNKNOWN_POLICY`。
   * 刻意不用 `startsWith('plugin:graft')` 收编变体：没见过的 `plugin:graft-foo` 应当**显形为未登记**，
   * 而不是被前缀悄悄归进 `self`。
   */
  const sourceKinds: readonly SourceKindEntry[] = Object.freeze([
    { kind: 'user', contentClass: 'human', provenance: 'human', note: '壳是 human，里面可能混着压缩摘要 / 人设注入，需二次判定' },
    { kind: 'goal', contentClass: 'objective', provenance: 'host', note: '' },
    { kind: 'tool-goal', contentClass: 'objective', provenance: 'host', note: 'goal_complete / goal_blocked' },
    { kind: 'agent-instructions', contentClass: 'project-rule', provenance: 'host', note: 'CLAUDE.md / AGENTS.md 等目录级指令' },
    { kind: 'subagent-settled', contentClass: 'async-result', provenance: 'peer', note: '' },
    { kind: 'tool-jobs', contentClass: 'async-result', provenance: 'host', note: '后台作业完成回执' },
    { kind: 'agent-message', contentClass: 'peer-message', provenance: 'peer', note: '' },
    { kind: 'plugin:observer-briefing', contentClass: 'peer-message', provenance: 'peer', note: '副脑给主脑的简报' },
    { kind: 'plugin:graft-replay', contentClass: 'history', provenance: 'self', note: '本插件注入的上一代回放：内容上是历史，来源上是自己' },
    { kind: 'plugin:dsh-memory', contentClass: 'reference', provenance: 'reference', note: 'authority="none"' },
    { kind: 'compact-checkpoint', contentClass: 'history', provenance: 'host', note: '' },
    { kind: 'time-context', contentClass: 'host-noise', provenance: 'host', note: '' },
    { kind: 'runtime-context', contentClass: 'host-noise', provenance: 'host', note: '影响行为（cwd / 文件策略 / GUI URL）' },
    { kind: 'skill-catalog', contentClass: 'host-noise', provenance: 'host', note: '' },
    { kind: 'model-selection', contentClass: 'host-noise', provenance: 'host', note: '影响行为' },
    { kind: 'user-approval', contentClass: 'host-noise', provenance: 'host', note: '影响行为（审批策略）' },
    { kind: 'repeat-tool-reminder', contentClass: 'host-noise', provenance: 'host', note: '' },
    { kind: 'plugin:chat-import', contentClass: 'host-noise', provenance: 'host', note: '' },
    { kind: 'working-directory', contentClass: 'host-noise', provenance: 'host', note: '影响行为' },
  ])

  /**
   * 未知 kind 的策略（D5）：19 种是**今天的**答案。归入 host-noise 以求安全，但**显形**为
   * unclassified 并保留指针 —— 否则「用户说了什么」与「我们看见了什么」会悄悄分叉。
   */
  const unknownPolicy = Object.freeze({
    className: 'host-noise' as ContentClass,
    flagUnclassified: true,
    preservePointer: true,
    warn: true,
    basis: 'D5：未登记的 kind 必须显形并记数，不许静默丢弃；指针保留，便于回读确认它到底是什么。',
  })

  return Object.freeze({ version: 1, contentClasses, provenance, sourceKinds, unknownPolicy })
})()

export const CONTENT_CLASSES = CATEGORY_TABLES.contentClasses
export const PROVENANCE = CATEGORY_TABLES.provenance
export const SOURCE_KINDS = CATEGORY_TABLES.sourceKinds
export const UNKNOWN_POLICY = CATEGORY_TABLES.unknownPolicy
export const TAXONOMY_VERSION = CATEGORY_TABLES.version

export interface ClassifiedSource {
  cls: ContentClass
  /** 谁放进来的（与内容类正交）。用户裁定：`self-authored` 落在这里，不落进 `cls`。 */
  provenance: Provenance
  /** 未登记的 kind（D5 纪律：必须记录，不许静默丢弃）。 */
  unclassified?: true
}

/** kind → 合同条目。从合同派生，不是手写 —— 手写的那份已经有 19 行要同步了。 */
const BY_KIND: ReadonlyMap<string, { contentClass: ContentClass; provenance: Provenance }> = new Map(
  SOURCE_KINDS.map((entry) => [entry.kind, { contentClass: entry.contentClass, provenance: entry.provenance }]),
)

/** 合同里的 10 个内容类（测试与文档比对用同一份）。 */
export const CONTENT_CLASS_IDS: readonly ContentClass[] = CONTENT_CLASSES.map((entry) => entry.id)

/**
 * ── 这张表搬进了合同（Phase A）────────────────────────────────────────────────────────────────
 *
 * 它曾经是这里的一份手写 19 行映射，同时 `docs/` 里还有一张 19 行的表、合同里还有一份。**一个事实，
 * 三个所有者。** 现在表只在 `src/contracts/content-taxonomy.v1.ts`，本模块从它派生（`BY_KIND`），
 * 并有一条 gate 比对「合同 / 本模块导出的类 id / 文档表」三处。
 */

/** `summarizeUnclassified` 对「连 kind 都没有」的条目使用的标签。 */
const NO_KIND_LABEL = '(no source.kind)'

/**
 * ── 按 `source.kind` 分类 ──────────────────────────────────────────────────────────────────────
 *
 * 返回 `unclassified: true` 时，调用方**必须**把它当成「输入不完整」而不是「不重要」：
 * 用 `summarizeUnclassified()` 聚合后打印出来，比一条一条猜测有用得多（D5）。
 *
 * 未登记的 kind 走合同的 `UNKNOWN_POLICY`：归入它指定的内容类以求安全，但**显形**为 unclassified
 * （策略在合同里，不在这个函数里 —— 否则「未知怎么办」会有两个所有者）。
 */
export function classifyBySource(kind: string | undefined): ClassifiedSource {
  if (typeof kind === 'string') {
    const entry = BY_KIND.get(kind)
    if (entry !== undefined) return { cls: entry.contentClass, provenance: entry.provenance }
  }
  return { cls: UNKNOWN_POLICY.className, provenance: 'host', unclassified: true }
}

/**
 * ── 「粘贴材料」的最小长度阈值：800 字符 ───────────────────────────────────────────────────────
 *
 * 依据（B0 实测语料：227 个日志 / 5,967 条 `user/message`，本批不引用原文，原因见夹具 `_provenance`）：
 *
 *   · 人类真打的字绝大多数是一两句祈使句 —— B0.8 夹具里 19 条 `sampleText` 的样本量级是 10–40 字；
 *   · 一份带多级标题 + 表格 + 代码块的粘贴报告，实际通常在 1.5k 字以上；
 *   · 800 落在两者之间：比任何一句正常的人类祈使句都长，又明显短于一份真报告。
 *
 * 这是**估计**，不是长度分布的实测分位。它的作用是把「以下是我想问的」这类短句留在 human，
 * 而不是做精确切分；阈值本身由 v219 的 ⑤/④ 两侧钉住（短句必须留在 human，长报告必须被抓）。
 */
const PASTE_MIN_CHARS = 800

/**
 * 假 user（系统内容套了 user 壳）的四条判据。
 *
 * ⚠️ 必须**先于** task-transcript 判定：压缩上下文样本里就含「以下是压缩摘要」，
 * 而那是 task-transcript 的短语判据会命中的形状。先判 legacy 才不会被它抢走。
 */
const LEGACY_INJECTION_PATTERNS: readonly RegExp[] = [
  /^\s*[\[【]\s*(?:AI\s*设定|系统提示)/u,
  /<system-reminder>/iu,
  /上下文刚刚被压缩/u,
  /^\s*只输出一个\s*JSON\s*对象/iu,
]

/** 「以下是…报告/方案/清单/摘要」：把中间部分限制在一句话内，避免跨段误命中。 */
const REPORT_PHRASE = /以下是[^。\n]{0,40}?(?:报告|方案|清单|摘要)/u

/**
 * 「请你分析 / 请你评估 / 这是…的报告」开头。
 *
 * 比派工单的「这是…的」更窄：只认「这是 + ≤20 字 + 报告类名词」，因为一个 1000 字的
 * 真实需求也可能以「这是一个…」开头 —— 宽泛的 `^这是` 会把正常需求判成粘贴材料。
 */
const REPORT_REQUEST_PREFIX = /^\s*(?:请你分析|请你评估|这是[^\n]{0,20}?(?:报告|方案|清单|摘要|分析|材料))/u

/** 报告结构：≥2 个 markdown 标题行 + 一张表 + 一个代码围栏，三者同时出现才算。 */
const hasReportStructure = (text: string): boolean =>
  (text.match(/^#{1,6}\s+\S/gmu) ?? []).length >= 2 &&
  /^\|.*\|$/mu.test(text) &&
  /```/u.test(text)

/**
 * ── 只用于 `cls === 'human'` 的二次判定 ───────────────────────────────────────────────────────
 *
 * 返回 `legacy-injection` 时，那不是 ContentClass 的成员：它表示「壳是 user，但内容是系统」，
 * 调用方应把它当作 self-authored 一类处理（F4 决定具体落点）。
 */
export function classifyHumanText(text: string): 'human' | 'task-transcript' | 'legacy-injection' {
  for (const pattern of LEGACY_INJECTION_PATTERNS) {
    if (pattern.test(text)) return 'legacy-injection'
  }
  /**
   * 长度阈值是**每个 task-transcript 分支**的前提，不是可选项：
   * 「以下是」也会出现在一句普通的短话里（「以下是我想问的」）。短句一律留在 human。
   */
  if (text.length > PASTE_MIN_CHARS) {
    if (REPORT_PHRASE.test(text)) return 'task-transcript'
    if (REPORT_REQUEST_PREFIX.test(text)) return 'task-transcript'
    if (hasReportStructure(text)) return 'task-transcript'
  }
  return 'human'
}

/**
 * ── D5 的聚合出口：这一批事件里有多少种**未登记**的 `source.kind` ─────────────────────────────
 *
 * 返回去重后的 kind 列表（保持首次出现的顺序）；空数组 = 全部已登记。
 * 连 kind 都没有的条目会以 `(no source.kind)` 出现 —— 「没有来源」本身也是输入不完整的证据，
 * 静默跳过它等于把最该说的一句藏起来。
 */
export function summarizeUnclassified(events: readonly { source?: { kind?: string } }[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const event of events) {
    const raw = event?.source?.kind
    const kind = typeof raw === 'string' && raw.length > 0 ? raw : NO_KIND_LABEL
    if (BY_KIND.has(kind) || seen.has(kind)) continue
    seen.add(kind)
    out.push(kind)
  }
  return out
}
