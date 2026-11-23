# 内容类型学 · v1 · 合同表

> 唯一登记：`src/contracts/content-taxonomy.v1.ts`（代码）。
> `src/contracts/content-taxonomy.v1.json` 是它的**生成投影**（`node scripts/emit-taxonomy.mjs`），
> 本表是同一份合同的**人读投影**。三处由 `test/v326-content-taxonomy-contract.test.mjs` 比对。
> **改分类只改合同，然后重新生成** —— 手改 JSON 或本表都会让 gate 红。

## 一、10 个内容类

`self-authored` **不在此表**：它是 provenance（谁放进来的），不是「这是什么内容」。

| 类 | 含义 | 交接处置 | 进约束候选 | 依据 |
|---|---|---|---|---|
| `human` | 人类真打的字 | 全文（受预算） | ✅ | 唯一能承载「用户要什么」的类 |
| `objective` | 总目标 / 目标状态 | 指针 + 首句 | ❌ | 目标是「去哪儿」，不是「不许做什么」 |
| `project-rule` | 项目级长期约束 | 全文 | ✅ | 人写在仓库里的规则文件，不是模型注入 |
| `session-rule` | 本会话短期约束 | 全文 | ✅ | 从 human 文本抽出的祈使句，出处仍是人 |
| `task-transcript` | 转述 / 待分析材料 | 指针 | ❌ | Q1 裁定：转述不是需求 |
| `async-result` | 子智能体 / 后台作业结果 | 指针 + 首句 | ❌ | D3：必须留 `{kind, seq, 首句}` |
| `peer-message` | 其它节点 / 子智能体发的 | 指针 + 首句 | ❌ | 跨节点指令不是用户指令 |
| `host-noise` | 宿主噪音 / 环境快照 | 丢弃（记数） | ❌ | D4：丢弃必须记数，不许静默 |
| `reference` | 参考数据（无权威） | 丢弃 | ❌ | 来源自称 `authority="none"` |
| `history` | 压缩摘要 / 上一代交接 | 指针 | ❌ | 摘要已压过一次，再全文带入是二次压缩 |

## 二、5 种 provenance（与内容类正交）

| provenance | 含义 |
|---|---|
| `human` | 人类直接输入 |
| `self` | 本插件自己注入的（回放 / 交接）—— **`self-authored` 的真实住处** |
| `peer` | 其它节点 / 子智能体 / 副脑 |
| `host` | 宿主运行时（时间、cwd、模型切换、审批策略） |
| `reference` | 只读参考源（无权威） |

## 三、19 种 `source.kind` 的登记

| `source.kind` | 内容类 | provenance | 注解 |
|---|---|---|---|
| `user` | `human` | `human` | 壳是 human，里面可能混着压缩摘要 / 人设注入，需二次判定 |
| `goal` | `objective` | `host` | |
| `tool-goal` | `objective` | `host` | `goal_complete` / `goal_blocked` |
| `agent-instructions` | `project-rule` | `host` | `CLAUDE.md` / `AGENTS.md` 等目录级指令 |
| `subagent-settled` | `async-result` | `peer` | |
| `tool-jobs` | `async-result` | `host` | 后台作业完成回执 |
| `agent-message` | `peer-message` | `peer` | |
| `plugin:observer-briefing` | `peer-message` | `peer` | 副脑给主脑的简报 |
| `plugin:graft-replay` | `history` | `self` | 本插件注入的上一代回放：**内容上是历史，来源上是自己** |
| `plugin:dsh-memory` | `reference` | `reference` | `authority="none"` |
| `compact-checkpoint` | `history` | `host` | |
| `time-context` | `host-noise` | `host` | |
| `runtime-context` | `host-noise` | `host` | 影响行为（cwd / 文件策略 / GUI URL） |
| `skill-catalog` | `host-noise` | `host` | |
| `model-selection` | `host-noise` | `host` | 影响行为 |
| `user-approval` | `host-noise` | `host` | 影响行为（审批策略） |
| `repeat-tool-reminder` | `host-noise` | `host` | |
| `plugin:chat-import` | `host-noise` | `host` | |
| `working-directory` | `host-noise` | `host` | 影响行为 |

## 四、未知 kind 的策略（D5）

十九种是**今天的**答案。宿主加一种新 kind，我们不能静默把它当噪音丢掉 —— 那会让「用户说了什么」
与「我们看见了什么」悄悄分叉。

- 归入 `host-noise` 以求安全；
- 但**显形**为 `unclassified: true`，由 `summarizeUnclassified()` 聚合打印；
- **保留指针**（seq），让读者能回去看它到底是什么。

## 五、D1 与 `project-rule` 的一处张力（写明，不掩盖）

纪律 D1 原话：「任何 `classifyBySource(kind) !== 'human'` 的消息不得进入 `HARD CONSTRAINTS` 池」。
那句话写在 `project-rule` 成为独立类之前，字面执行会**禁止 `agent-instructions`**（人写在仓库里的
规则文件）成为约束，却**允许**一个 `user` 壳的压缩摘要成为约束 —— 字面与目的相反。

所以合同按**目的**逐类声明 `intoConstraintCandidates` + `basis`，而不是按一个字面比较。这条张力
记在这里，是因为它下一次还会被读到。
