/**
 * ── S1b-2 / A′ 形态：同一绑定，两份导出 ──────────────────────────────────────────────────────
 *
 * `WordingPattern` 携带元数据（intent / samples / nearMisses / caveat），而生产代码需要一个**裸
 * RegExp**。`bundle.mjs` 把所有模块内联进一个作用域、剥掉 `export`、删除 import、不做别名重写，
 * 所以「对象 vs 正则」的转换没有地方可放——实测报 `TypeError: X.test is not a function`。
 *
 * 解法是**同一个绑定导出两次**：
 *
 *     export const TODO_TOOL_NAME = /…/iu                      ← 裸正则，生产代码用
 *     export const TODO_TOOL_NAME_CONTRACT = { re: TODO_TOOL_NAME, … }   ← 元数据，只有测试用
 *
 * 这样：
 *   - 消费方 `import { TODO_TOOL_NAME }` 拿到的就是正则，**函数体零改动**；
 *   - 元数据对象与正则共享**同一个绑定**，结构性不可能漂移（不需要 `X.re === X_RE` 那种测试）；
 *   - `*_CONTRACT` 只在测试里 import，所以**不进 bundle**——导出面不变，撞名风险为零。
 *
 * ── 命名映射：契约沿用生产名（用户裁定 (i)）────────────────────────────────────────────────────
 *
 * 变量名承载「在哪里被引用」的机械性，`name` 字段承载「这是什么」的语义。两者不必相同：
 *
 *     CONSTRAINT_PATTERN   ← 生产名（消费方零改动），name: 'WIDE_CONSTRAINT'
 *     STANDING_PROHIBITION ← 生产名，name: 'PROHIBITION_PLUS_ACT'
 */
import type { WordingPattern } from './types.js'

/**
 * ── 1. TODO_TOOL_NAME ───────────────────────────────────────────────────────────────────────────
 *
 * The question: is this tool name `todo_write`, including namespaced spellings?
 *
 * WHY THE `$` MATTERS, PROVEN BY THE LOGS. This pattern requires `todo_write` to END the string. In
 * the real corpus the token also appears mid-sentence, overwhelmingly in the harness's own node-plan
 * reminder — `写进 todo_write 时用「阶段 1:」前缀` — and in tool inventory lists
 * (`…,web_fetch,todo_write,working_directory,…`). Those are mentions of the tool, not a record that
 * the tool is being CALLED. Without the anchor the contract would fire on every reminder block.
 *
 * A SECOND IMPLEMENTATION EXISTS: `dsh-observer/src/core/monitor.ts` carries the same pattern under
 * the name `TODO_TOOL`, with the comment "exactly like graft does". The two are separate plugins and
 * cannot share code (observer must not depend on graft), so `test/contracts-todo-parity.test.mjs`
 * compares the two SOURCE files character by character.
 */
export const TODO_TOOL_NAME = /(?:^|[^a-z0-9])todo[_-]?write$/iu

export const TODO_TOOL_NAME_CONTRACT: WordingPattern = {
  name: 'TODO_TOOL_NAME',
  re: TODO_TOOL_NAME,
  intent: '这次工具调用的名字是不是 todo_write（含 mcp__x__todo_write / foo/todo-write 这类命名空间写法）',
  samples: [
    {
      text: '- seq=4633 Turn 13 · todo_write',
      source: 'auto-graft-mw7jlaxh-8gtiyl/session.v4.jsonl.zstd',
      seq: 16,
    },
  ],
  nearMisses: [
    {
      text: '[系统提示] 这是长任务：请先制定或更新你的节点计划（Node Plan）——阶段 → 当前节点 → 卡点。写进 todo_write 时用「阶段 1:」前缀，切片会原样带走。',
      kind: 'real-nearby',
      why: '句中提到 todo_write，是宿主的节点计划提醒，不是「这次调用的是 todo_write」。正则要求结尾锚定，故正确地不命中。',
    },
    {
      text: '- `side session preset mounted standard` → `allow= 10 read,glob,grep,web_search,web_fetch,todo_write,working_directory,skill,job_l…',
      kind: 'real-nearby',
      why: '工具清单里的枚举项。todo_write 是逗号分隔列表中的一个名字，后面还有别的工具，因此不以它结尾。',
    },
  ],
  caveat:
    '结尾锚定 `$` 是这条契约的全部要害：去掉它，上面两条真实文本会立刻误命中，' +
    '而「模型被反复提醒要写 todo」会被读成「模型一直在写 todo」。' +
    'observer 侧有一份逐字相同的第二实现，跨仓 parity 测试读源文件比对（不能读 index.js，bundle 会做转义）。',
}

/**
 * ── 2. CONSTRAINT_PATTERN（契约名 WIDE_CONSTRAINT）──────────────────────────────────────────────
 *
 * WIDE CONSTRUCTION — a RECALL HEURISTIC, NOT A CONSTRAINT JUDGEMENT.
 *
 * Measured on 9,153 real text blocks: it fires on **2126** of them, and a large share are descriptions
 * that merely CONTAIN an emphasis word — "Only that file was written", "the sandbox forbids deletion,
 * so it was not cleared", "Use on Windows for … if an ordinarily readable path cannot be read". A word
 * list cannot tell an instruction from a report; the difference is the PREDICATE RELATION, and a
 * regex sees characters, not relations.
 *
 * So this pattern alone must never decide. The decision lives at the call site:
 *   1. `isHumanAuthored`   — a plugin-injected sentence is not a user rule;
 *   2. `isQuestionLike`    — a question is not a standing rule;
 *   3. `ACTION_PATTERN` + `EMPHATIC` — weighting, never gating on their own.
 *
 * Using it alone WILL misfire. That is the method's boundary, not a typo to fix — which is why the
 * vocabulary is NOT being narrowed: removing `if` / `only` would lose recall on real rules that use
 * those words, and the misfires would simply move.
 */
export const CONSTRAINT_PATTERN = /(必须|禁止|绝对|不能|不得|不许|务必|第\s*\d+\s*行|CHECKSUM_42|如果|则|除非|仅有|只有|否则|优先|\bmust\b|\bnever\b|\bforbidden\b|\bline\s+\d+\b|\bdo not\b|\bdon't\b|\bcannot\b|\brequired\b|\bconstraint\b|\bif\b|\bthen\b|\bunless\b|\bonly\b|\bprefer\b|\balways\b|\bbefore\s+you\b|\bend\s+every\b)/iu

export const WIDE_CONSTRAINT: WordingPattern = {
  name: 'WIDE_CONSTRAINT',
  re: CONSTRAINT_PATTERN,
  intent: '这句话像不像一条持久的约束（**召回用**，宽；单独使用会误命中，见 caveat）',
  samples: [
    {
      text: '操作约束: Documents 读可写不可 → 第一步必须复制进 D:\\插件开发与安装\\dsh-lab\\ 并建 PATCHES.md 索引',
      source: 'session-64345616-2ef5-44ec-8152-c08696d498d2/session.v4.jsonl.zstd',
      seq: 376,
    },
  ],
  nearMisses: [
    {
      text: '- `diagnose-windows-sandbox-acl`: Use on Windows for unexpected DSH sandbox access denials: workspace writes or listing fail, or an ordinarily readable path cannot be read.',
      kind: 'real-misfire',
      why: '技能目录摘要：命中的是英文虚词 if / only / cannot，句子本身回答的是「这个 skill 什么时候用」，不是一条约束。',
    },
  ],
  caveat:
    '实测在 9153 条真实文本上命中 2126 条，误命中率很高且**无法靠收窄词表修好**——' +
    '约束的本质是主谓关系（"你必须做 X" vs "X 必须存在"），词表看不到关系。' +
    '所以本契约只做召回：真正的判定在调用点的 isHumanAuthored / isQuestionLike 两步过滤之后。' +
    '**不收窄词表**是刻意的：删掉 if/only 会损失真实约束的召回，误命中只会换个地方出现。',
}

/**
 * ── 3. EMPHATIC — 与生产 `hard` **逐字相同**，不是并集 ──────────────────────────────────────────
 *
 * The question: does this sentence contain a HARD emphasis word? Used for WEIGHTING (+2), never as a
 * gate on its own.
 *
 * ── WHY THIS IS `hard` AND NOT `hard ∪ strong` (a correction, measured) ────────────────────────
 *
 * There are two emphasis lists in the source, and they are NOT the same:
 *
 *     hard   (scorer, human path)  must never don't "do not" cannot always only
 *                                  必须 禁止 绝对 不能 不得 务必                            (13)
 *     strong (LLM path)            must never don't "do not" only always cannot
 *                                  必须 禁止 不要 不得 只能 务必 始终 绝不                     (15)
 *
 * Measured (`_scratch/verify-emphatic-tables.mjs`):
 *     only in hard   : 绝对 不能
 *     only in strong : 不要 只能 始终 绝不
 *     UNION would be 17 tokens — it is neither list.
 *
 * The first version of this contract WAS the union, on the theory that two lists serving one semantic
 * should merge. That was wrong for a wiring step: the union gives `hard` three extra words, so a
 * 必须-class sentence would earn +2 where it currently earns 0, and **which rules fit a fixed prompt
 * budget would change**. Wiring exists to remove duplication, not to change behaviour.
 *
 * So this contract is `hard`, character for character. What to do about the union is TD-14.
 */
export const EMPHATIC = /(\bmust\b|\bnever\b|\bdon't\b|\bdo not\b|\bcannot\b|\balways\b|\bonly\b|必须|禁止|绝对|不能|不得|务必)/iu

export const EMPHATIC_CONTRACT: WordingPattern = {
  name: 'EMPHATIC',
  re: EMPHATIC,
  intent: '这句话里有没有硬强调词（**加权 +2 用**，不作门禁）',
  samples: [
    {
      text: '- 新建 dsh-sidecar/docs/DOCS-DRIFT.md：32 条三列对账(D-01..D-32)+ §2 必须改代码(8 项)',
      source: 'session-3b99cdc6-957a-4c7c-9396-56177c0eb5b1/session.v4.jsonl.zstd',
      seq: 877,
    },
  ],
  nearMisses: [
    {
      text: 'task-3 done. Deliverable: D:\\插件开发与安装\\dsh-sidecar\\docs\\RECOVERY-TESTS.md (UTF-8, 5 sections). Only that file + .tmp\\recon-tests written',
      kind: 'real-misfire',
      why: '完成汇报：`Only that file … written` 是在限定「只写了这一个文件」，是对已发生事实的描述，不是禁令。',
    },
    {
      text: 'task-4 COMPLETE. Deliverable: dsh-sidecar\\docs\\RECOVERY-DEPLOY.md (273 lines, UTF-8 中文). No restart, no source…',
      kind: 'real-nearby',
      why: '同样是完成汇报，但 `No restart` 不在本契约词表内，因此正确地不命中。它证明边界的位置。',
    },
  ],
  caveat:
    '`only` / `cannot` / `no …` 在**描述性英文**里极常见，而模型汇报工作时正好这样写。' +
    '所以这条只能加分，不能单独决定「这是一条约束」。' +
    '**本契约与生产 `hard` 逐字相同（13 个词），不含 `strong` 的 只能/始终/绝不/不要**——' +
    '取并集是更合理的设计，但会改变加权，需单独一轮验证（见 ARCHITECTURE TD-14）。',
}

/**
 * ── 4. STANDING_PROHIBITION（契约名 PROHIBITION_PLUS_ACT）───────────────────────────────────────
 *
 * The question: is this a STANDING prohibition against a destructive act (as opposed to a one-off
 * instruction like "delete D:\X\repair-log.cjs")?
 *
 * It is a two-part structure, not a word list: a prohibition cue, then within 12 characters, a
 * destructive verb. That shortness is deliberate — a cue anywhere in the sentence would keep
 * "绝不能让这个无备份、强制覆盖的脚本再跑一次", which is the very sentence the filter exists to drop.
 *
 * REAL MISFIRE, AND IT IS THE HARD KIND: `因沙箱禁止递归删除未能自动清除` contains 禁止 followed by 删除
 * inside the window. It is a STATUS EXPLANATION — "the sandbox forbade it, so it was not cleaned up".
 * Character-for-character this is indistinguishable from the instruction it resembles; only the
 * subject tells them apart. **This is a known, unfixed boundary**, recorded rather than papered over.
 *
 * NOTE: exported but NOT yet imported by production (which still declares its own literal). Wiring is
 * remaining S1b-2 work.
 */
export const STANDING_PROHIBITION = /(禁止|严禁|绝不|不要|不得|不能|务必|必须|每次|任何|一律|永远|始终|never|always|must|do not|don't|only)[^。；\n]{0,12}?(删除|删掉|移除|清空|清理|\brm\b|\bdel\b|\bdelete\b|\bremove\b|\bdrop\b|\bunlink\b)/iu

export const PROHIBITION_PLUS_ACT: WordingPattern = {
  name: 'PROHIBITION_PLUS_ACT',
  re: STANDING_PROHIBITION,
  intent: '这是不是一条针对破坏性动作的**持久禁令**（区别于「删掉 D:\\X\\repair-log.cjs」这类一次性操作）',
  samples: [
    {
      text: '破坏性命令红线：禁止 rm -rf /、Remove-Item -Recurse 指向盘符根目录 / 用户目录 / 工作区之外的路径；',
      source: 'auto-graft-mw7jlaxh-8gtiyl/session.v4.jsonl.zstd',
      seq: 7693,
    },
    {
      text: '6. **resolve 层"最多 8 项"是死代码**（3 项白名单+去重，永远到不了）→ 删掉，上限只留在 `encodeSecurityCapabilities` 的结构边界。',
      source: 'auto-graft-mw7jlaxh-8gtiyl/session.v4.jsonl.zstd',
      seq: 5679,
    },
  ],
  nearMisses: [
    {
      text: '清理提示：%TEMP% 下 final-*/tgzfinal-*/broken-* 因沙箱禁止递归删除未能自动清除，可手动删；不在工作区与 release 内。',
      kind: 'real-misfire',
      why: '状态说明：`沙箱禁止递归删除` 解释的是「为什么没删掉」，不是用户下的禁令。12 字符窗口内 禁止+删除 齐备，字面与禁令完全同形。',
    },
  ],
  caveat:
    '**已知未修的边界**：`因沙箱禁止递归删除未能自动清除` 与 `禁止删除任何脚本` 在这条正则看来一模一样。' +
    '区分它们需要看主语（谁在禁止谁），而正则没有主语的概念。' +
    '12 字符窗口是刻意的（更宽会保留本应丢弃的句子），但窗口救不了这个 case。',
}

/** Every contract, for tests to iterate. Metadata only — never imported by production code. */
export const ALL_CONTRACTS: readonly WordingPattern[] = [
  TODO_TOOL_NAME_CONTRACT,
  WIDE_CONSTRAINT,
  EMPHATIC_CONTRACT,
  PROHIBITION_PLUS_ACT,
]
