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

/** 一条 `user/message` 在 Q1 语境里「是谁的、能不能当需求」。 */
export type ContentClass =
  | 'human'            // 人类真打的字
  | 'objective'        // 总目标 / 目标状态
  | 'project-rule'     // 项目级长期约束
  | 'session-rule'     // 本会话短期约束（从 human 里抽祈使句；本批只留接口，无 producer）
  | 'task-transcript'  // 转述 / 待分析材料  ← Q1 的核心
  | 'async-result'     // 子智能体 / 后台作业结果
  | 'peer-message'     // 其它节点 / 子智能体发的
  | 'self-authored'    // 本插件自己注入的回放
  | 'host-noise'       // 宿主噪音 / 环境快照
  | 'reference'        // 参考数据（无权威）
  | 'history'          // 压缩摘要

export interface ClassifiedSource {
  cls: ContentClass
  /** 未登记的 kind（D5 纪律：必须记录，不许静默丢弃）。 */
  unclassified?: true
}

/**
 * ── 19 种 kind 的映射表（逐字来自 B0.8 的实测快照）────────────────────────────────────────────
 *
 * 键是**登记过的** kind；不在表里的一律 host-noise + `unclassified: true`。
 * 刻意不用 `startsWith('plugin:graft')` 去收编 `plugin:graft-*` 的其它变体 ——
 * `isGraftAuthored` 那么做是因为它要回答「是不是我」，而这里要回答「它属于哪一类」：
 * 一个没见过的 `plugin:graft-foo` 应当**显形为未登记**，而不是被前缀悄悄归进 self-authored。
 *
 * `plugin:graft-replay` 这个字面量与 `core/host-shape.ts` 的 `GRAFT_REPLAY_SOURCE_KIND` 同值。
 * 这里不 import 它：本模块被测试直接以 `.ts` 加载，而 host-shape 的相对 import 用的是 `.js`
 * 说明符（只在校验/打包链路里可解析）。抄一个字面量的代价由 v219 的夹具驱动来兜底。
 */
const KIND_TO_CLASS: ReadonlyMap<string, ContentClass> = new Map<string, ContentClass>([
  ['user', 'human'], // 二次判定见 classifyHumanText
  ['goal', 'objective'],
  ['tool-goal', 'objective'],
  ['agent-instructions', 'project-rule'],
  ['subagent-settled', 'async-result'],
  ['tool-jobs', 'async-result'],
  ['agent-message', 'peer-message'],
  ['plugin:observer-briefing', 'peer-message'],
  ['plugin:graft-replay', 'self-authored'],
  ['plugin:dsh-memory', 'reference'],
  ['compact-checkpoint', 'history'],
  ['time-context', 'host-noise'],
  ['runtime-context', 'host-noise'],
  ['skill-catalog', 'host-noise'],
  ['model-selection', 'host-noise'],
  ['user-approval', 'host-noise'],
  ['repeat-tool-reminder', 'host-noise'],
  ['plugin:chat-import', 'host-noise'],
  ['working-directory', 'host-noise'],
])

/** `summarizeUnclassified` 对「连 kind 都没有」的条目使用的标签。 */
const NO_KIND_LABEL = '(no source.kind)'

/**
 * ── 按 `source.kind` 分类 ──────────────────────────────────────────────────────────────────────
 *
 * 返回 `unclassified: true` 时，调用方**必须**把它当成「输入不完整」而不是「不重要」：
 * 用 `summarizeUnclassified()` 聚合后打印出来，比一条一条猜测有用得多（D5）。
 */
export function classifyBySource(kind: string | undefined): ClassifiedSource {
  if (typeof kind === 'string') {
    const cls = KIND_TO_CLASS.get(kind)
    if (cls !== undefined) return { cls }
  }
  return { cls: 'host-noise', unclassified: true }
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
    if (KIND_TO_CLASS.has(kind) || seen.has(kind)) continue
    seen.add(kind)
    out.push(kind)
  }
  return out
}
