/**
 * ── 生产用的裸正则；元数据在同目录的 model-wording.contracts.ts ──────────────────────────────
 *
 * 本文件只导出 4 个 RegExp，生产代码（index.ts / core/task-state.ts）import 的就是它们。
 *
 * ── 为什么元数据被拆了出去（E1，实测）──────────────────────────────────────────────────────────
 *
 * `bundle.mjs` 内联的是**整个文件**，不是消费方 import 的那几个符号。所以只要生产代码需要其中
 * 一个正则，整份文件——包括 `samples` 里真实的 `session-<uuid>`、`.jsonl.zstd` 文件名、本机
 * 的 `auto-graft-*` 会话名——就会被内联进**发布产物**。实测拆分前 index.js 里有 2 个 session id、
 * 5 个 `.jsonl.zstd`、8 个 `auto-graft-*`。
 *
 * 当时文件头写着「`*_CONTRACT` 只在测试里 import，所以不进 bundle」——那句话是**真的，而且没用**：
 * 内联按文件走，不按 import 走。现在元数据在 `model-wording.contracts.ts` 里，`src/index.ts` 的
 * 依赖图到不了它，「不进产物」因此是**结构性事实**，不是靠注释保证的承诺。
 *
 * 同一绑定的保证仍然成立：契约文件 import 这里的正则、不重新写一遍，所以 `CONTRACT.re === REGEX`
 * 不可能漂移，也不需要 `X.re === X_RE` 那种事后测试。
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
