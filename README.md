# dsh-graft-slice

**DSH 日志切片与最小注入插件。** 在源会话最后一个 `turn/end` 处切取高保真磁带，创建一个零继承、可冷恢复的交接会话；不 fork，不引入 SQLite，不单独注入 `tool/result`。

> 当前版本 **0.7.4（预发布）**（v7.4 能力线，仓库语义化版本从 0 起）。
> 目标运行时：DeepSeek Harness **0.2.1-rc.5**（当前桌面端）。
> 规格书 v2.1 写的是 rc.4；本实现已按 rc.5 的真实源码校正了两处会导致冷恢复失败的问题。

## 愿景：事实记忆只需可查，能力记忆才需要持久化

上下文窗口会腐蚀：窗口越长，注意力越散，结论越容易被自己的历史淹没。所以这个生态不打算把所有东西塞进一个窗口，
而是把「记忆」拆成两类，按**不同的成本**分别对待：

| 记忆 | 需要什么 | 承担者 |
|---|---|---|
| **事实记忆**：做过什么、当时的原文、工具输出 | **只需可查** | 会话日志 + 按 seq 回读（`graft_read_result` / `graft_search_history`），不重放、不摘要 |
| **能力记忆**：怎么做才对、踩过哪些坑、有效方法 | **必须持久化** | 记忆系统插件：记忆的存储与转化，长期记忆与能力飞轮的基础设施 |

**持久化能力层**由三件插件组成：

| 插件 | 职责 |
|---|---|
| **嫁接切片插件**（本仓库 `dsh-graft-slice`） | **工作能力连续性**：在上下文爆掉之前换一个干净窗口，摆脱上下文腐蚀、重置注意力；切片 / 两阶段审核 / 崩溃可恢复 |
| **记忆系统插件**（规划中） | **记忆的存储与转化**：把做过的事沉淀成可复用的能力，作为长期记忆与能力飞轮的基础设施 |
| **副会话插件**（规划中） | **隔离用户消息**：为主会话提供专业、具体的方案，并维护记忆系统 |

三者共享的硬约束：不 fork、不改写源日志、只追加、每个指针都能被 `graft_read_result` 打开；
迁移不能带走现场——`.txn/` 写前日志 + 幂等恢复，任何时刻 `sourceUsable ∨ targetUsable`。

本项目是 **DSH 开源生态**的一部分：GitHub topics 标 `dsh-plugin`，发布以预发布（prerelease）先行。
### 真机自我切片（本项目第一次）

| 项 | 数值 |
|---|---|
| 源会话 | 48 轮 / 14,978 事件 / 9.5 MB 压缩日志 |
| 交接注入 | **14,252 字符**（system 1,125 + 磁带 13,127），源的 0.15% |
| 磁带结构 | 1 轮封闭骨架 + 8 个回顾块（goal / task-status / workspace / carryover / readback / pending …） |
| 断点 | `open-turn-carryover` 370 字符（Turn 47，进行中）+ `recent-turn` 5,889 字符（Turn 46 全文） |
| 回读 | 指针 1,860 处；可回读索引 1,982 条 |
| 结果 | 新会话**零澄清提问**接上工作，并自行发现 pending 与断点的矛盾 |

## 安装与准入校验

本插件是 **DSH bundle**：加载器只认 `package.json` 里的 `dsh.bundle.patch`，普通依赖会被静默忽略。

```bash
# 用户安装（dsh CLI）
dsh plugin --profile <name> add dsh-graft-slice
dsh --profile <name> --dump-config        # 配置树里应出现 dsh-graft-slice 条目
```

仓库自带的契约校验器（不依赖 dsh CLI，可在 CI 里跑）：

```bash
node scripts/verify-bundle.mjs   # 27 项：bundle 声明 / files 白名单 / ESM / manifest 一致 / patch 形状 / 来源审计 / 脱敏
```

三条高频致命错误，本仓库都用校验器兜住：

| 错误 | 后果 | 本仓库 |
|---|---|---|
| 只声明 `main`/`exports`，漏 `dsh.bundle` | 被当成普通依赖，静默不激活 | `dsh.bundle.patch` 已声明并校验 |
| `files` 漏 `cordis.patch.yml` | 装上了但没有配置层，挂载失败 | 白名单含 patch + `index.js` + `manifest.json` |
| 未设 `type: "module"` | CJS 引 ESM 核心包，启动即崩 | `type: "module"` 已校验 |

`cordis.patch.yml` 用**包名**引用（`name: dsh-graft-slice`），不写相对路径——相对路径只在本机成立。

## v7.4.0（P0/P1 修复）：断点优先、进行中轮次不丢、两阶段审核

**事故**：一个 41 轮的真实会话在 75% 水位命中时正处于实施中途。auto-graft 在 `turn-stopping` 触发，比该轮的 `turn/end` 早了一个事件；`autoGraftIfNeeded` 把快照截断在「最后一个它看得见的 `turn/end`」——也就是**上一轮**的末尾。结果整轮（用户的决定 + 83 步实施）从磁带里凭空消失，target 把**再上一轮**读成「这个会话的任务」，并重做了磁盘上早已存在的工作。

**病灶**：`extractOpenTurnCarryover`（v7.0 B1，专门为这种场景写的携带块）因此永远读到空尾巴，等于死代码。三处都有同样的预截断：水位 auto-graft、冷读回退、溢出恢复。

**修法**：

```text
locateBoundary       骨架仍切在最后一个「闭合」轮  → 红线不变（target 必须有自己的闭合骨架）
sourceSnapshot       不再预截断，开放轮原样进入 carryover
carryover            注入在磁带最前面（断点优先于状态）
```

配套约束：`hasClosedTurn()` 区分「根本没有可切边界」与「边界存在、后面还有活」；前者返回 `undefined` 让水位重试，而不是静默切一个更老的点。

**回归测试**（`test/v74-breakpoint-priority.test.mjs`）：同一份测试跑在冻结的 7.3.1 构建上应有 3 条必红——`the in-flight round must survive the graft; losing it is the bug this test exists for`。这正是本次事故的最小复现。

**配置默认值（v7.4 统一，四处逐字一致）**

| 项 | 源码默认 | `tiers.yml` | 线上 `cordis.patch.yml` | 说明 |
|---|---|---|---|---|
| `recentTurns` | **5** | A=0 / B=1 / C=5 | B 档 = 1 | 仅当 `adaptiveDepth=false` 时生效 |
| `adaptiveDepth` | **true** | A=false / B=false / C=true | false（B 档） | true 时按会话形状自适应（debug 形状降到 0 轮） |
| `autoGraftAtRatio` | **0.75** | 0.75 | 0.75 | 旧注释写 0.60、值却是 0.75，v7.4 把注释改对 |

以前四处冲突：源码 5 / 线上 patch 1 / `tiers.yml` C 档 0+false（与它自己上限 5 处的注释矛盾）/ README 写 5。现在 C 档 = 源码默认，不改配置跑出来的就是 C 档。

**同一版本其余落地**

| 项 | 变化 |
|---|---|
| 两阶段审核（P1-2） | 新增 `graft_prepare`（只读，产出目标/进度/约束/遗留 + 切片哈希）与 `graft_commit`（校验 preparedId 时效、哈希、源 seq 未漂移后才写盘）。单步 `graft_slice_and_inject` 仍可用，但不再是推荐路径 |
| 回顾句（P4-1，方案 B） | 同句式的回顾按工具聚合为紧凑行：`- pwsh(seq=364,372,380) · read(seq=398)`；`!` 标记报错，行序即时序。同一日志 A/B 实测 19,987 → 14,486 字符（−27.5%），指针数 1,812 不变 |
| Pending 模板（P4-2） | 条件句改成「我接下来需要继续推进，前提是 …」；计划句只在句首匹配（`下一步`/`接下来`/`待办`），不再把引用里的 `runs later` 当成计划 |
| 归档 fork（P4-3） | 给 fork 会话在激活时挂到所属工作区并 emit `api-session/added`；此前 `baseline-fork-demo` 磁盘上有 1,200 事件、侧边栏零行 |
| 约束来源（硬约束 7） | 当 goal 里含继承的 HARD CONSTRAINTS 时，pending state 第一行写「核心约束源自第 N 代会话，seq=Y，必要时请优先回读」 |
| 自适应档位（决策 2） | `autoAdaptiveTier`（默认 **false**）：开启后，若最近有未完成 todo 或最近一次调用失败，重放轮数降到 1 轮（B 档）；干净收尾则用 0 轮（A 档）。优先级高于 `adaptiveDepth`，结果写在 `plan.adaptiveTier` |
| Task Status 时效 | 注入的清单带上 `todo_write` 的 seq 与「之后又过了多少事件/轮」，避免把做完的清单当成当前计划 |

**解除退休后的宽限（v7.4 追加）**

`graft_resume_session` 清掉退休标记后，日志并没有变小，水位仍然 ≥ 0.75——用户刚说一句话，就会被再次嫁接进一个新 target 并退休一次。本项目实测两次（第二次发生在解除后第一条消息）。现在 resume 会给该会话 **30 分钟自动嫁接宽限**，并落盘到 `.auto-graft-suppressed.json`，重启后依然有效；`resetRetiredSessions()` 也会清掉它，避免污染测试。

## v7.4.0 追加（真实长会话嫁接后收紧）

`handoff-demo` 是本项目的第一次真机自我嫁接（源会话 48 轮 / 14,978 事件，切片 1 轮封闭骨架 + 7 个回顾块，合计约 1.3 万字符）。之后按观察到的问题收紧了三处：

| 缺陷 | 现象 | 修法 |
|---|---|---|
| pending 与断点打架（硬约束 4） | pending 写「立刻执行：用 graft_prepare 体检」，而断点块已经显示 `graft_prepare(seq=14965)` 且下一步是提交——状态压过了断点 | 开放轮尾部最后一次工具调用与清单第一项同名时，pending 追加一行「断点前我刚发出过 X(seq=N)，这一项可能已经做完了——先核对结果，不要直接重跑」 |
| 锚点漏掉人类粘贴的抽取副本（硬约束 7） | 约束块是插件抽取后塞进 goal 的，源日志里并不存在同名文本，于是锚点永远不触发 | 改从源会话里**最早一条人类 user/message 的 HARD CONSTRAINTS** 取 seq；插件自述行（`plugin:graft-replay`、`[系统提示] 本次任务的硬约束…`）永远不算来源（硬约束 8 的 `source.kind === 'user'` 严校） |
| Subagent Reports 被工具输出污染 | 5 条「报告」里 4 条是 `read`/`pwsh`/`job_output` 的原文（文件转储、测试日志），占掉约 1.7 KB | 关键词必须落在结果开头 60 字符内，且正文不得是文件/日志转储（`<path>`、行号、`✔` 批量）；清单只保留最近 5 条 |

| 断点块是拼的 | carryover 读起来像一条完整消息，实际是各步最终段落逐字拼接（真机 6/6 可回源），目标据此误判"这是我最后说的话" | 块头加一行：`（断点块：下面 N 段正文按时间拼接自断点前各步的最终段落，不是一条完整消息）` |
| 未提交的冷目标无法打标 | 宿主不提供 delete / open-for-append，`[损坏]` 标题只能写给活动会话；flush 之后崩溃会留一个内容完整、看起来可续接的目标 | 新增 `.graft-leftovers.json` 台账：每次中断都记下 targetId/源/阶段/原因，并在下一次 `graft_prepare` 的摘要里明说「不要从它们继续」 |
| 同一源被切两次 | 手动路径不看 retired/transferred 台账，`session-source-demo` 实际产出过 3 个 target | 默认拒绝切片已迁移源（`SOURCE_ALREADY_MIGRATED`），显式 `allowReslice: true` 才放行；`graft_resume_session` 仍是否决解除路径 |

这几条的回归测试在 `test/v74b-handoff-coherence.test.mjs` 与 `test/v74-two-phase.test.mjs`。
## v7.3.1（关键修复）：所有 target 都是宿主无法打开的

**7.3.0 及之前创建的每一个交接会话，宿主都无法加载。** 真机实测：

```text
stored session "auto-graft-…" is corrupt:
SessionFormatError: session/title messageSeqs must cite distinct earlier
human user/message events
```

现场有 **284 个这样的会话**，全部无法打开。

### 规则（`dsh-session-format-v3-to-v4` 的 `titleSources`）

```js
// 空 messageSeqs 与 source.kind === 'user' 必须同真同假
if (event.type === "session/title"
    && references.length === 0 !== (data.source.kind === "user"))
  throw new SessionFormatError("session/title messageSeqs must be empty exactly for a user title")

// 非空时，每个被引用的 seq 必须是更早的、source.kind === 'user' 的真人 user/message
for (const value of references) {
  const source = events[seq]
  if (source?.type !== "user/message" || source.data.source.kind !== "user")
    throw new SessionFormatError("… must cite distinct earlier human user/message events")
}
```

### 为什么必然违规

target 里**没有任何真人消息**——它唯一的 `user/message` 是插件写的 goal（`plugin:graft-replay`）。所以：

- title **不能**引用任何 seq（引用 goal 就是引用非真人消息）
- 空引用**必须**配 `source.kind: 'user'`

而旧代码做了两件错事：初始 title 写 `kind: 'fallback'`，append 路径又把 `messageSeqs` 覆盖成 `[goalSeq]`。**唯一合法的形态是 `{ messageSeqs: [], source: { kind: 'user' } }`。**

### 为什么当时的测试套件没抓到

冷日志校验器只检查了「title 非空」「无 surface 元数据」，**从未实现宿主那条 source 规则**。校验器比宿主宽松，就等于没有校验。现在该规则已写进 `assertColdLog`，并有 3 条专门测试钉住。

### 存量修复

284 个损坏会话已就地修复（改动仅限 title 记录），原件备份于
`<data-dir>\_emergency_backups\graft-target-titles-2026-11-02\`。
修复后由**宿主自己**验证可读（`graft_search_history` 成功检索），并非仅凭本插件自检。


## v7.3：检索补齐，默认切到零重放

前几版建了一套「按 seq 回读」的设计，但**没有任何工具回答「哪个 seq 提到了 AssertionError」**。注入的索引上限 24 条最近指针加最早的约束块，更早的内容原则上可达、实际上不可达——目标要么猜 seq，要么重跑命令。

`graft_search_history(sourceSessionId, query, limit=10, regex=false)` 补上这一环：

```text
"error"  → found=true total=10
  seq=475  [tool/result]  Error: old_string was not found in "<other-project>\dsh-side…
  seq=610  [tool/result]  …err: 'var(--dsw-alias-state-error-primary)', Line 80: // no…
  seq=644  [assistant/message]  …说明真实 `$DSH_HOME` 曾被测试数据污染过…
```

搜索面是 `assistant/message` 与 `tool/result`（有载荷的两类事件）。默认字面匹配、大小写不敏感；`regex: true` 时按正则，编译失败返回 `error` 而不是抛异常。命中带 ±50 字预览与事件总长。

**默认档位因此改为 A（`recentTurns: 0` + `adaptiveDepth: false`）**：有了搜索，重放旧对话不再增加可达性。实测 A 档 2,268 字符、0 重放，与 C 档拥有相同的 342 个回读句柄。

### 其他 v7.3 修复

| 项 | 之前 | 现在 |
|---|---|---|
| 预算公式 | `tokenBudget / 0.5`（等于 ×2）。中文下 1 字符≈1 token，200k 窗口算出 200k 字符预算 = 吃满窗口 | 1 字符 = 1 token，200k 窗口 → 100k 字符预算 |
| 溢出恢复可达性 | `assistant/attempt` 落在最后一个 `turn/end` 之后时永久 unsafe，P6 永不执行 | 只有 `stream` 非空或存在 `assistant/chunk` 才算流式 |
| 撤回迁移 | 只能手改 `.retired.json` | `graft_resume_session(sessionId)`：清 retired/transferred/连锁标记并落盘，**不删除 target** |


## v7.2 实测基线（真实会话 14 轮 / 3,882 事件）

三档注入的实际体积，用来回答「砍掉重放之后还剩什么」：

| 档位 | 重放轮数 | 总字符 | 可回读指针 |
|---|---|---|---|
| A 零重放 | 0 | 2,076 | 342 |
| B 单轮 | 1 | 7,597 | 342 |
| C 默认 | 4 | 35,874 | 342 |

两条结论，都有测试守着：

1. **回读句柄与重放轮数无关**——A 和 C 都是 342 条。重放轮次没有增加检索能力，只增加了体积。
2. 因此 **debug 模式在 7.2 起强制零重放**（v6.3 的逻辑相反，会给 6-8 轮）。调试会话的近期内容是最不可压缩的堆栈墙，而**最后一条报错原文已内联进 Pending-State**（≤2000 字符，超出标 `[已截断]`），目标不需要再花一次工具调用去展开指针。

### `compaction-basic` 的 `auto: false` 及其代价

profile 里对 `compaction-basic` 设了 `auto: false`，这会**同时关掉 DSH 自带的溢出恢复**：

```js
if (this.config.auto) this._registerAutomaticCompaction()   // 三个监听器一起注册
```

关掉 auto 等于同时关掉 pre-step 压力检查、`agent/request-error` 溢出恢复、`agent/status` 清理。**溢出恢复是可达的，但只由本插件的 P6 提供**——监听同一个 `agent/request-error`，检测 `CONTEXT_WINDOW_EXCEEDED` 后迁移并返回 `{ kind: 'retry' }`。没有第二层保险。

保留 DSH 兜底的做法是把 `auto` 改回 `true`，代价是两套压缩机制同时监听 `agent/pre-step`，顺序不可控。


## 文件

| 文件 | 说明 |
|---|---|
| `src/index.ts` | 完整 TypeScript 源码（类型、阶段注释、红线自检） |
| `index.js` | 由 `src/index.ts` 生成、DSH 直接加载的运行时 |
| `manifest.json` | 插件名称、版本、声明权限、工具/钩子清单 |
| `cordis.patch.yml` | Loader 插入行与默认配置 |
| `test/*.test.mjs` | 255 个测试：切片、注入、红线、真实日志、profile 隔离、代码块指针、异步约束、草稿捕获、dataDir 隔离、真实 v4 校验器、产物索引、工具可用性降级、v7.0 重放/连锁守卫/约束漂移/结构伪造/代际污染/溢出恢复/预算优先级/压缩免疫/零重放/跨代追溯 |
| `tiers.yml` | 真机验收三档配置（A 零重放 / B 单轮 / C 默认对照组） |
| `test/fixtures/` | 真实日志派生的 v4 fixture（`real-session.v4.jsonl.zstd` + `MANIFEST.json` 记录来源、计数与 sha256） |
| `scripts/build.mjs` | 用 Node 内建 stripTypeScriptTypes 构建 |
| `scripts/demo.mjs` | 端到端演示：真实日志 + 假宿主，不写真实存储 |
| `scripts/scan-real-logs.mjs` | 对本机全部持久化日志做只读切片扫描 |
| `scripts/read-session-log.mjs` | 读取多 zstd frame 的 v4 日志（开发工具） |

## 对 v2.1 的两处必要校正

### 1. 骨架必须是 `turn: 1` / `step: 1`，不是 `0`

DSH 的 v4 关系校验器从 1 开始计数，`turn: 0` 会抛：

```text
turn/start does not open the expected turn
```

已用真实 `@deepseek-ai/dsh-session-format-v3-to-v4` 验证：`synthetic-1-1 PASS`，`synthetic-0-0` 按预期 FAIL。

### 2. 持久化要走 `sessions.prepare + sessionPersistence.create + handle.append/flush`，不是 `sessions.create + sessions.flush`

`create()` 会把会话发布进 live store，后续 `agents.resume()` 直接失败：

```text
session "<id>" already exists
```

而 `sessions.flush()` 对 detached 会话会拒绝。正确路径与 `AgentLoop.create()` 内部一致：`prepare` → `persistence.create` → `append` → `flush` → `close`。`inheritedEventCount` 恒为 0，从不调用 `fork()`。

## 阶段映射

| 阶段 | 行为 |
|---|---|
| Phase 1 | `sessionQuery.readSession`，定位最后一个 `turn/end`，open turn 直接拒绝，提取 producer-owned assistant source（兜底 `plugin:graft`） |
| Phase 2 | 只保留 assistant 文本；tool call/result 转成内联指针文本；最近 N turn 逐字保留，更早的 turn 压缩成摘要；抽取 goal 与第一人称 pending state |
| Phase 3 | 开 `turn/1 step/1` 骨架，注入受保护 `system/message` 作为第一个 surface，注入 goal seed `user/message`（`surfaceOp:'append'`），注入摘要/磁带/pending 为 `assistant/message`（`stream: []`、无 `sourceEventSeqs`），闭合骨架 |
| Phase 4 | 经 `sessionPersistence` 落盘，冷读校验，源会话进入退休集合，`agent/pre-step` 返回 `{ kind: 'reject' }` |

### 为什么必须注入 system/message 头

冷恢复时，被恢复 agent 自己的 system prompt 若排在 user/assistant 之后，会被拒绝：

```text
system/message requires a protected first surface head
```

所以第一个 surface 必须是 `system/message`。

## v3.0 加固

- 边界推断、open-turn 拒绝、source template 提取全部前置到任何写操作之前。
- 冷读校验逐事件比对类型、seq、surfaceOp，确保产物与写入一致。

## v3.1 生产级 UX 收尾

- 注入 `session/title`，侧边栏显示 `[接续] <goal 前 20 字>`。
- 自动挂载到源会话所属 workspace，避免"未分组"。

## v3.2 约束锚定

- 从 user/message 抽取硬约束，注入 `HARD CONSTRAINTS` 区块。
- 约束独立于 assistant 摘要：原始约束通常在用户消息里，而不是助手选择总结的内容。

## v3.3 / v4.0 自动迁移与状态延续

- Task Status：解析 `todo_write`、`- [ ]` / `- [x]`。
- Subagent Reports：抽取子 agent 回报。
- v4.0 autoGraft：token 水位触发，Single Writer 通过 pre-step 闸门 + transfer 映射实现。

## v4.2 强制枚举

- `HARD CONSTRAINTS` 改为严格有序列表 `1. [ ] ...`。
- 增加死命令：`If asked about constraints or progress, you MUST enumerate every single item without skipping or summarizing.`

## v4.3 约束降噪

- 过滤 <10 字、>800 字、问号结尾、无动作动词/祈使词的句子。
- 去近似重复；候选超过 8 条时按 hard/imperative/action/长度/scope 打分，只留 8 条。
- 真实 COMPINT 15 条抽取：平均 8 条、命中 10/15，噪声仍偏高。

## v5.0 LLM 语义约束提取

- 新增 `llmExtractConstraints()`：一次轻量 LLM 调用选择长期有效约束；正则提取器保留为 fallback。
- 专属 Prompt 明确排除"写一篇文章/写一个长脚本"这类一次性生成请求。
- 最多 2 次尝试，全部失败才回退正则。
- COMPINT 15 条：首轮 14/15，重试后 15/15；平均约 1.93 条。
- 后置过滤排除 `请帮我/能不能/是否/有没有/如何/为什么/我想/我希望` 等请求语气。

## v5.1 单调度器与全自动 E2E

- autoGraft 收敛为唯一 `agent/pre-step` 调度器，`turn-stopping` 与 `session/event` 不再触发迁移。
- `idle | grafting | done` 三态；`grafting` / `done` 直接 reject。
- 创建 target **之前**先写 `.transferred` / `.retired`，失败回滚状态与文件。

E2E：

| 基准 | A 组（原生 compaction） | B 组（本插件） |
|---|---|---|
| COMPINT 15 条模型探针 | 15/15 | 15/15 |
| RULER 5 条多跳 | 4/5 | 5/5 |
| Task Status 5-Todo | — | 正确答出剩余 api / ui / test |

诚实标注：COMPINT 上 A/B 打平，B 无显著优势；RULER 上 B 领先 1 条。样本量小，不可外推。

## v5.2 补丁三：旧会话交接卡片

- 旧会话被 transferred/retired 拦截前，append 一次性 `assistant/message` 交接卡片。
- 卡片包含目标会话、迁移时间、已保全内容与"请前往新会话继续"。`assistant/message` 是 DSH 会渲染的 surface；早先尝试的 `developer/message` 在桌面端不可见。
- 卡片 `stream: []`，不带 `sourceEventSeqs`，不写 `tool/result`。
- 旧会话标题更新为 `[已交接] → <targetSessionId>`。
- 若拦截发生在无 open step 的 pre-step，补一个 card-only turn + step/start，只补 step/end，由 agent loop 收 turn/end。
- 真实桌面端已确认：卡片可见、标题变为 `[已交接]`、旧会话输入被拒绝。

## v5.2 崩溃事故与架构修复

事故：把 detached target 用 `sessions.enter()` / `sessions.announce()` 塞进 live store，并向 live target 追加 source 的 `request/header`、`permission/preset`、`sandbox/mode`、`approval/policy`。DSH 重启时恢复这些"半活"会话直接崩溃，安全模式也无法启动。

架构结论（DSH 三层不可混用）：

```text
持久化层  sessionPersistence（磁盘事件日志）
运行层    agent loop → sessions live store → 模型/工具/权限
UI 层     workspaceRegistry → workspace.sessionIds
```

修复：

- 移除 `sessions.enter` / `sessions.announce`，target 保持 detached prepared。
- 移除 `pendingRuntimeMeta`、`applyPendingRuntimeMeta`，不再伪造 `request/header` 与权限事件。
- 模型/工具/权限由 target 打开时的 agent loop 真实建立；迁移只继承 `agentPreset` 与持久意图（见下节）。
- `stableCtx.get()` 改为「先查启动快照、回退 live ctx」，修复 `workspaceRegistry` 晚绑定导致 autoGraft 路径 attach 失败。

隔离验证（headless + `--patch`）：

- 新 target 自动进入工作区，无需手改 `workspace.json`。
- 连续两次重启并恢复该 target：`exit=0`，无崩溃。
- 骨架事件无 `surfaceOp`；seeded `assistant/message` 的 `stream` 为 `[]`；无 `sourceEventSeqs`。

## v5.2 运行态意图迁移（读 DSH 源码后的正确做法）

崩溃后的结论不是"运行态不能迁移"，而是**必须迁 DSH 自己认可的持久意图，而不是伪造请求头**。

对照 DSH 源码（`dsh-api-session-controller`、`dsh-permission-presets`、`dsh-compaction-basic`、`dsh-session-reference`、`dsh-workspace`）后确定：

| 事件 | 归属 projection | 能否迁移 |
|---|---|---|
| `model/selection` | `modelSelection`（`lastUsed` / `pending`） | ✅ 迁，这是用户的选择意图 |
| `permission/preset` | `permissions.preset` | ✅ 迁 |
| `sandbox/mode` | `permissions.sandbox` | ✅ 迁 |
| `approval/policy` | `permissions.approval` | ✅ 迁 |
| `request/header` | 一次模型请求的 epoch header | ❌ 绝不复制 |
| `sessions.enter` / `announce` | live store 生命周期 | ❌ 插件不得调用 |

实现：`extractRuntimeIntent()` 从**完整源日志**读取这四类事件，`buildInjectionEvents()` 在 `turn/end` **之后**写入 target seed，位置与 DSH 自己写这些 knob 的位置一致，全部 `surface: false`。

autoGraft 的 snapshot 会截断到最后一个 `turn/end`（避免切到 open turn），而 knob 事件恰在其后，因此 autoGraft 单独从完整事件里提取 intent 再传入。

验证（隔离 headless）：

```text
src  session-lab6-src      model/selection = deepseek-account/deepseek-flash
tgt  lab6-mvxlqnqw-e8rqvu  ... turn/end, permission/preset, sandbox/mode,
                               approval/policy, model/selection
                           v4 validator PASS，连续两次重启 exit=0
```

决定性验证——用 DSH 自己的 `applyModelSelectionProjection` 折叠 target 日志：

```text
lastUsed = { provider: qodercn,          model: dfmodel }         ← 该次运行 profile 默认
pending  = { provider: deepseek-account, model: deepseek-flash }  ← 迁移进来的意图
next     = deepseek-account / deepseek-flash                     ← UI 下次装配采用
```

即：即使 profile 默认是 `qodercn/dfmodel`，target 仍按 source 的 `deepseek-account/deepseek-flash` 恢复。

限制说明：headless 一次性运行在 `agentOptions` 里直接注入 profile 默认 provider/model，不经过 `modelSelection` projection，所以 CLI 单跑不会体现该意图；桌面端经 `api-session-controller.selectionFor()` 读取 `pending`，会生效。

## v5.2 退休状态按 profile 隔离

`.retired.json` 决定 pre-step 拒绝哪些会话。两个 profile 共用一份文件，意味着 lab 里的测试退休会静默拦掉 desktop 的真实会话，因此这是正确性要求，不是整洁性偏好。

路径解析顺序（`resolveStoreDir()`）：

| 顺序 | 来源 | 结果目录 |
|---|---|---|
| 1 | `ctx.paths.data` | 服务声明的数据目录 |
| 2 | `DSH_PROFILE_DIR` | `<profile>/data/dsh-graft-slice` |
| 3 | `DSH_HOME` + `DSH_PROFILE` | `<home>/profiles/<profile>/data/dsh-graft-slice` |
| 4 | 插件目录 | 共享，激活时打 warn |

注：`paths` 不在当前 Service 目录中（`cordis_inspect_query` 已确认），所以实际生效的是第 2 项——启动器总会注入 `DSH_PROFILE_DIR`（本机观测值 `<home>\.dsh\profiles\desktop`）。

激活阶段就会 `mkdirSync(dataDir, { recursive: true })`，把"目录不可写"提前到启动时暴露，而不是迁移中途失败。

覆盖测试：`test/store-isolation.test.mjs` 验证 A/B 两目录互不泄漏、损坏文件不阻断激活、无 `paths` 时走 `DSH_PROFILE_DIR`。

## v5.2 补丁四：超长代码块指针化

`assistant/message` 里直接被写出的 fenced code block，超过 **200 行或 8,000 字符**时不再全文进 tape：

```text
[codeblock seq=4 lines=4-303 preview]
const row0 = 0;
…（前 10 行）
…[294 more lines; call graft_read_result({"sourceSessionId":"<sourceSessionId>","seq":4,"lineRange":{"start":4,"end":303}})]
```

`graft_read_result` 现在同时接受两种指针：

- `[tool name=xx seq=YY]` → 读 `tool/result`
- `[codeblock seq=YY lines=A-B]` → 读 `assistant/message`

并新增 `lineRange` 参数（1-based，闭区间），返回 `lineRange: { start, end, totalLines }`。

**关键正确性细节**：指针里的行号是**整条消息的绝对行号**，不是代码块内相对行号。否则 `lineRange` 会静默偏移——首版实现正是犯了此错，被真实 E2E 抓到并修正。同理，`body` 尾部那个位于闭合围栏前的换行是"终止上一行"，不是"开启新行"，行数统计必须去掉它。

真实 E2E（300 行内联代码块）：指针输出 `lines=4-303`；`lineRange {start:250,end:255}` 返回 `const row246 … const row251`，与源日志第 250–255 行逐字一致；`{start:4,end:6}` 返回 `row0…row2`。

只处理 assistant 正文；`write_file`/`edit` 产生的代码已有工具指针，不重复指针化。

## 红线合规

| 红线 | 实现 |
|---|---|
| 禁止 `ctx.sessions.fork()` | 代码中不存在；测试静态扫描 + 假宿主无 `fork` |
| 骨架不带 `surfaceOp` | `appendLogOnly()` 每次 append 后断言 `surfaceOp === undefined` |
| 第一条 surface 必须是 `system/message` | `buildInjectionEvents()` 在 `step/start` 后立即注入；`assertColdLog()` 再次断言 |
| `system/message`、`user/message`、`assistant/message` 带 `surfaceOp:'append'` | `appendSystemMessage()` / `appendUserMessage()` / `appendAssistantMessage()` 断言 |
| `assistant/message` 的 `stream: []`，禁 `sourceEventSeqs` | builder 固定 `stream: []`；append 后与冷读后双重断言 |
| 不单独 append `tool/result` | 只把结果转成指针文本；冷读断言无 `tool/result` |
| `source.kind` 不为 `plugin` | `extractSourceTemplate()` 跳过 `kind:'plugin'`；兜底 `plugin:graft` |
| 结构性畸形 turn 拒绝 | `locateBoundary()` 对「open turn 内再 start」与「无 start 的 end」抛错 |
| 退休拦截不写源日志 | 内存 Set + 持久化 `.retired.json`/`.transferred.json`；`agent/pre-step` 返回 `{ kind:'reject', reason }` |
| 不伪造 `request/header` | 代码中无 `request/header` 写入；运行态只迁 `model/selection` 与三个权限 knob |
| 不调用 `sessions.enter` / `announce` | 代码中不存在；target 始终 detached prepared |

## v6.3.0 四个物理防线

前几版解决的是"语义是否接得上"，v6.3 解决"物理动作是否正确"。

### 模块一：Safe Harbor（安全停泊点）

**问题**：模型正在跑长 tool/call 或流式输出时强切，target 会继承一个悬空调用——有 call 没有 result，模型看到无法解释的工作。

**实现**：`checkSafeHarbor(events)` 扫描整个日志：

| 条件 | 判定 |
|---|---|
| `tool/call` 无匹配 `tool/result` | 不安全 |
| `assistant/chunk` / `assistant/attempt` 出现且未闭合 | 不安全 |
| 其余 | 安全（quiet boundary） |

不安全时置 `pendingGraftSources` 标记并返回，下一个 `turn/end` 是天然安静边界，届时重试。

### 模块二：多模态与附件指针

**问题**：`buildTape` 只保留文本，用户上传的图片/文件在 target 里彻底消失。

**实现**：`extractAttachmentPointers(message)` 识别 `image` / `file` / `attachment` / `document` / `audio` / `video` 块，提取 `path`、`hostPath`、`url`、`source.path`、`attachment.path` 或引用 id，转成：

```text
（回顾：用户在此处上传了一个图片（bug.png），保存路径为：<workspace>\shots\bug.png，必要时请直接读取该路径）
```

无路径时如实说明"记录里没有留下可读取的路径"，不编造。指针挂在当前 turn 的 assistant 块上，与工具指针同样自然。

注：本机 572 份真实日志中没有附件块（内容类型只有 text / reasoning / tool-call），因此该模块按 DSH 的消息块规范实现，并用构造 fixture 覆盖。

### 模块三：自适应切片深度

**问题**：`recentTurns: 5` 硬编码。Debug 需要更多上下文，写作需要更少。

**实现**：`calculateAdaptiveDepth(events, settings)` 看最近 6 轮的形状：

| 信号 | 含义 |
|---|---|
| tool calls / turn | 高 = 调试 |
| 报错比例 | 高 = 调试 |
| 代码块占比 | 高 = 调试 |
| assistant 文本长度 | 长 = 生成 |

三档结果：

```text
debug      → depth = max(6, 0.9*max)    例：8
generation → depth = min(4, min+1)      例：4
balanced   → depth = 5
```

报告新增 `adaptiveDepth: { depth, mode, reason }`，例如：

```text
generation-shaped: 0.0 tool calls/turn, 0% code, long prose
```

真实日志验证：v4 校验器输出 `real-log PASS events=22 recent=7 older=4`——自适应在真实会话上选用了 7 轮。

### 模块四：迁移确认阀

**问题**：静默迁移会让正在专注打字的用户"被切走"。

**实现**：新增 `graftMode: 'silent' | 'confirm'`（默认 silent）。

confirm 模式下的水位处理：

```text
达到 75% → 不迁移，pre-step 返回 reject：
             "上下文即将满载，是否由系统进行无缝迁移？
              （回复"确认"立刻迁移，其它回复取消）"
用户回"确认" → 执行迁移，同样走 Safe Harbor 检查
用户回其它   → 取消提示，水位可再次触发
```

`confirmTtlMs` 默认 10 分钟，超时自动失效，避免陈旧提示堆积。

## v6.4 产物索引与工具可用性降级

v6.3 的真实长会话盲测暴露的最后一个缺口是 **A5（无感）只做到一半**：新窗口知道"发生过什么"，但不知道"现在的工作落在哪些文件上"，于是第一条动作是自己扫工作区。

### 一、`[Workspace Files]` 产物索引

从源窗口的 `write` / `edit` 调用里派生，按最近一次操作排序，作为 chunk `workspace-files` 注入：

```text
[Workspace Files]
本次窗口内我写过/改过的文件（按最近一次操作排序，工作目录 <other-project>）：
- recovery\raw\window-filter-3.mjs（最近一次：write，seq=15018）
- dsh-rollover-snapshot\tests\round52-delegation.spec.ts（最近一次：write ×2，seq=14667）
本次窗口共有 327 个文件，这里只列最近 20 个；更早的同样能用 graft_read_result 按 seq 回读。
以上是写入记录，不是磁盘校验结果；需要内容时用 graft_read_result 按 seq 回读，不要再盲目列目录。
```

三条硬规则（都有测试守着）：

| 规则 | 为什么 |
|---|---|
| 有上限就**声明**上限（`共有 N 个 / 只列最近 M 个`） | 静默截断的列表会被读成"事情就这些"，下一窗口据此认为没有别的产物 |
| 最近一次报错的路径标 `未确认落盘` | 渲染函数不 stat 磁盘，不能把"调用过"说成"文件在" |
| 页脚只说"写入记录，不是磁盘校验结果" | 旧文案写"当前磁盘上真实存在的产物"——这是一句没做校验的断言 |

失败判定吃的是**真实 v4 形状**（`data.message.toolCallId` / `data.message.isError`），不是 `data.toolCallId`。
这一点是实测抓到的：按扁平形状写会编译通过、用手写 fixture 也能过，但在真实日志上永不触发（防线存在但已死）。

真实语料证据（本机 575 份持久化日志，只读扫描）：

| 指标 | 值 |
|---|---|
| 含 write/edit 的路径 | 3,526 |
| **最近一次尝试报错的路径** | **38** |
| 会因此出现 `未确认落盘` 的日志 | 22 |
| 例：`534030e7…`（cwd `D:\live2d模型分析`） | `- work\audit\residual\e5b_minification.py（最近一次：edit ×5，seq=479，最近一次报错，未确认落盘）` |

同一份 11 MB 真实语料（`session-51ba018f…`，15,062 事件）：`write/edit` 调用 475 次、去重 327 个路径、块内列 20 个 → 声明省略 307 个。

### 二、`F3` 工具可用性降级

tape 里的指针句原本一律写成"我刚才已经调用 X 完成了这一步"。若 X 是源窗口独有、新 profile 没挂载的工具，模型会照着调用一个不存在的工具。

现在切片时读取宿主**实时工具注册表**，目标没有的工具改成：

```text
（历史记录：使用了当前环境不支持的工具 spawn_teammate；原始输出仍可用 graft_read_result 读 seq=1115）
```

同一份真实语料（把可用工具限制为 `pwsh/read/write/edit/grep/glob/todo_write/job_output`）：20 条指针被降级，**降级后仍被写成"可调用"的 0 条**。

### 三、盲测口径的变化

`goalMessage` 的旁白从"当前磁盘的核心文件状态已同步"改为"本窗口写过/改过的文件已列在 [Workspace Files] 区块，请以此为起点继续"——因为索引是写入记录，不是磁盘快照。

## v6.3.0 测试（historical — 当前套件见上表）

```text
95 tests / 95 pass（v6.3.0 快照，historical；新增 10 条）
```

新增覆盖：

```text
safe harbor: 未返回结果的 tool call 阻止切割
safe harbor: 已返回结果的 tool call 是安全边界
safe harbor: 流式输出阻止切割
attachments: image 块生成可读路径指针
attachments: 无路径的 file 块如实说明
attachments: 纯文本消息不产生指针
adaptive depth: 调试型会话保留更深窗口（>=6）
adaptive depth: 散文型会话保留更浅窗口（<=4）
adaptive depth: 两种密度结果确实不同
confirm mode: 水位达到时先询问而非直接迁移
```

## v6.0 日志损坏事故（必须读）

插件在真实桌面端把一个 **7,531 事件、92 轮、6.6 MB** 的用户会话写成了 corrupt。

### 根因

`appendTransitionCard` 为写交接卡片自己补了 `step/start`，且 step 号硬编码为 `1`：

```text
7525 step/end   {turn:92, step:2}
7526 step/start {turn:92, step:1}   ← 插件写的，step 号回退
7527 assistant/message {turn:92, step:1}
7528 session/title
7529 step/end
7530 turn/end   {turn:92}
```

v4 要求同一 turn 内 step 严格递增，`1` 出现在 `2` 之后即被判非法：

```text
SessionFormatError: step/start does not match the open turn and next step
```

整个日志因此无法加载，桌面端报 `历史加载失败`。

### 修复

**数据修复**：只删插件写的 4 个事件（7526–7529），保留 DSH 自己的 `turn/end`，重排 seq。

```text
修复后 7,527 events / 92 turns
V4_VALIDATOR_PASS
```

原始文件已备份为 `session.v4.jsonl.zstd.bak-before-stepfix`。

**代码修复（零伪造原则）**：Agent Loop 是 lifecycle 事件的唯一 writer，插件不得代写。

| 规则 | 实现 |
|---|---|
| 绝不写 `turn/start` / `step/start` / `turn/end` / `step/end` | `validateAppendIsLifecycleSafe()` 对这些类型直接返回 `ok:false` |
| 只在已有 open step 时写 | `openStepOf()` 返回 undefined 就放弃，不补 step |
| 只写 `developer/message` 与 `session/title` | 两者都是 log-only，不受 lifecycle 约束 |
| 写前预校验 | 按 v4 规则重放 turn/step 序列，不合法就跳过并打 warn |

代价：已关闭的会话看不到交接卡片。**静默优于损坏日志。**

### 回归测试

`test/zero-forgery.test.mjs`（5 条）：

```text
open step 3 绝不收到更小的 step 号
已闭合日志不接收任何事件
open turn 但无 open step 时不写
只追加 developer/message 与 session/title
非法前缀被预校验拒绝并记录 warn
```

## v6.0 剧本化唤醒

注入内容从"说明书"改成"续演剧本"。轻量模型读到结构化材料时倾向于复述字段，读到叙事时才会继续干活。

| 位置 | v5.2 | v6.0 |
|---|---|---|
| Goal Seed | Markdown 列表 `**当前目标**：…` | 第一人称旁白 `【系统交接】上一段对话因为上下文满载…请顺接前文的思路直接继续` |
| PendingState | `上一轮我们排除了 Y；目前的判断是 X` | 内心独白 `我刚刚排除了 Y。我现在的判断是 X。接下来我需要 Z。` |
| 工具指针 | `（注：此处调用了 write 工具…）` | 历史回忆 `（回顾：刚才我已经调用 write 完成了这一步，结果已折叠…读 seq=123）` |
| 结尾 | pending-state 即结束 | 追加**执行死命令**：`系统强制指令：不要复述上文…立刻调用相应工具执行第一个动作。` |

死命令作为最后一个 assistant 块，位置在全部材料之后、`step/end` 之前。

源句子自带的前缀（`- 下一步：`、`当前假设：`）在拼进独白前会被剥掉，否则会读出"接下来我需要 - 下一步：…"这种嵌套标题残渣。

## v6.0 补丁一：草稿捕获与接管

用户在旧会话被拦截那一刻正在输入的文本不该消失。

```text
旧会话 reject 前 → 捕获最后一条 user 文本 → .graft-drafts.json
target 首次输入 → 合并成一条 user/message → 立即删除
```

合并格式：

```text
[系统提示：用户在上一个会话被拦截前，正在输入：「把 auth 模块的 token 刷新改成」]
[用户新输入：「继续。」]

请把这两段当成同一个连续意图来处理。
```

只生效一次：拿到就删，避免用户每轮都看到同一段旧草稿。

## v6.0 关键修复：dataDir 必须显式配置

桌面宿主**不向 Electron 主进程导出** `DSH_PROFILE_DIR` / `DSH_HOME`——那两个变量只存在于工具沙箱的子进程环境里。真实桌面端 E2E 的证据是状态文件落在了插件目录：

```text
<data-dir>\.transferred.json
<data-dir>\.retired.json
```

而 `profiles\desktop\data\dsh-graft-slice\` 是空的。也就是说环境推断的三级降级全部落空，最终回退到插件目录，**所有 profile 共享一份状态**。

修复：新增 `config.dataDir`，优先级最高：

| 顺序 | 来源 |
|---|---|
| 1 | `config.dataDir`（显式，桌面端唯一可靠手段） |
| 2 | `ctx.paths.data` |
| 3 | `DSH_PROFILE_DIR` |
| 4 | `DSH_HOME` + `DSH_PROFILE` |
| 5 | 插件目录（共享，激活时打 warn） |

desktop profile 现已配置：

```yaml
dataDir: "<home>\\.dsh\\profiles\\desktop\\data\\dsh-graft-slice"
```

## v6.0 真实 E2E 抓到并修复的缺陷

**指针用了字面量占位符**：`graft_read_result({"sourceSessionId":"<sourceSessionId>"…})`。模型只能从交接旁白反推源会话 id，推不出就读不到。现在直接写入真实 id。

**LLM 结果覆盖正则兜底**：系统头里有 2 条约束，随后注入的却只有 1 条——`「只用要点列表」` 被 LLM 的较短结果顶掉。现在两者取并集（按归一化文本去重），并在收窄时打 warn。

## v6.0 桌面端状态

迁移产物 `session-v6-desktop-1` 校验：

```text
events 20, turns 1, v4 validator PASS
title:  [接续] 检查下大量会话发生这样的错误是为何，并尝
goal:   【系统交接】…（第一人称旁白，无 JSON）
chunks: 摘要 / Subagent / 正文(含回忆指针) / 内心独白 / 死命令
```

`session/end-seed` 与 `request/header` 均不存在，说明 DSH **尚未真正打开过**该会话——它处于待唤醒状态，需要在 target 里发一句话才会进入模型。这是预期行为，不是注入失败。

## v5.2 补丁二：异步约束提取

迁移关键路径不再等待 LLM。原来 `await llmExtractConstraints` 会随源历史增长而线性变慢，直接推高「触发到看到新会话」的延迟。

新流程：

```text
迁移开始 → 正则 extractConstraints 生成 FAST_CONSTRAINTS
         → 建 target / 斩断旧会话 / flush 落盘      ← 用户此刻已可用
         → 后台 llmExtractConstraints（不 await）
         → 成功则写 .pending-constraints.json
         → target 下一次 pre-step 注入一次
```

失败处理：LLM 挂了就保留正则结果，迁移不回滚。约束质量下降是次要问题，迁移已经成功。

注入通道用 `agent/pre-step` 返回的 `messages`，与 `dsh-session-reference` 注入跨会话快照的方式一致。**不写日志事件**——自己开 `step/start` 会占用 step 序号，v4 要求 step 严格递增，agent loop 随后自己的 `step/start` 就会被拒（`step/start does not match the open turn and next step`）。这个坑是真实 E2E 抓到的。

注入消息的角色必须是 `user`：DSH 要求 `developer` 角色与 `developer/message` 事件同时出现，而 pre-step 的 messages 会投影成 `user/message`。用 `[系统提示]` 前缀让人工可读、也让模型知道这是背景而非新指令。

## v5.2 注入格式拟人化（面向 Flash 等轻量模型）

结构化标签会让小模型复读或试图重放，因此注入内容改写成叙述：

| 位置 | 之前 | 现在 |
|---|---|---|
| 工具指针 | `[tool name=write seq=123 expand_result(...)]` | `（注：此处调用了 write 工具，结果已省略；需要细节时用 graft_read_result 读取 seq=123）` |
| 工具报错 | 同上 | `（注：调用 pwsh 报错，Exit Code 7；可用 graft_read_result 读取 seq=123 的完整输出）` |
| pending state | `当前假设：X / 已排除：Y / 下一步：Z` | `上一轮我们排除了 Y；目前的判断是 X；接下来的主要任务是 Z。` |
| goal seed | `{"kind":"persistent-capability-seed",...}` | Markdown 段落：当前目标 / 工作目录 / 源会话 + 「请先从上次停下的地方继续」 |
| 标题 | 可能带 `{"kind"` 或 `[` | 检测到结构化残留则回退 `[接续] MM-DD HH:MM` |

配套修正：指针不再独占一行，所以 `pointerLines()` 改为内嵌扫描（`pointerSentences()`），工具名也从「调用了 X 工具」中提取——否则 `olderToolNames` 会退化。摘要清洗用整句匹配，避免把指针替换成空格后留下「需要细节时用 ）」这种残句。

真实 E2E（240 行内联代码块 + 两条中文约束）：

```text
迁移报告 constraintSource = regex-fallback   ← 迁移时只有正则，符合设计
后台 3 秒内写入 .pending-constraints.json：
  所有回答只用要点列表，不要写段落。
  涉及数字时必须写成英文单词。
target 下一次 pre-step 注入一次，模型回答：
  「Standing constraints from the source session's user messages, verbatim: …」
v4 validator PASS（23 events, 2 turns）
```

## 开放 turn 的处理（v5.2 修正）

早期实现把「最后一个 turn 未闭合」当作致命错误：

```text
the last turn (91) has no matching turn/end; refusing to slice without a stable boundary
```

真实桌面端暴露了这个设计缺陷：**从任何会话里调用工具，调用者本身就在那个敞开的 turn 中，因此它永远无法闭合自己。** 结果是手工路径几乎 100% 失败，而 autoGraft 因为用截断快照一直正常。

修正后 `locateBoundary()` 区分两类情况：

| 情况 | 处理 |
|---|---|
| 末尾有未闭合 turn（正常开放尾部） | **丢弃该 turn**，切到最后一个已闭合 `turn/end`，返回 `droppedOpenTurns: 1` |
| `turn/start` 落在已开启的 turn 内 | 仍抛错——日志本身不一致 |
| `turn/end` 没有匹配的 `turn/start` | 仍抛错——日志本身不一致 |

`allowOpenTail: false` 可恢复严格模式。

真实 6.6 MB 日志验证（`session-3afa4b95…`，7,505 事件，人为追加 turn 92）：

```text
boundary { boundarySeq: 7504, lastTurn: 91, turnCount: 92, droppedOpenTurns: 1 }
tape turns 74, last tape turn 91, pointers 637
```

语义代价：**当前这一轮对话不会被带进 target**。这是正确取舍——切片需要已闭合的稳定边界，而正在进行的 turn 既未完成、也仍在增长。

## 工具

### `graft_slice_and_inject`

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sourceSessionId` | string | 是 | 已闭合的源会话；最后一个 turn 必须被 `turn/end` 关闭 |
| `newSessionId` | string | 是 | 新会话 id；不得已存在，且不等于源会话 |

返回：`ok`、`sourceSessionId`、`newSessionId`、`cwd`、`boundarySeq`、`sourceEventCount`、`turns`、`recentTurnCount`、`olderTurnCount`、`injected`、`pointers`、`constraints`、`constraintSource`、`taskStatus`、`subagentReports`、`workspace`、`eventSeqRange`、`sourceTemplate`、`skeleton`、`durability`、`retired`、`warnings`。

### `graft_read_result`

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sourceSessionId` | string | 是 | 拥有该 tool/result 或 assistant/message 的源会话 |
| `seq` | integer | 是 | 指针中打印的 seq |
| `lineRange` | object | 否 | `{ start, end }`，1-based 闭区间，用于代码块指针 |

返回：`found`、`seq`、`text`、`truncated`、`totalChars`，以及（带 `lineRange` 时）`lineRange: { start, end, totalLines }`。

## 配置

`cordis.patch.yml` 默认：

```yaml
recentTurns: 5
oldTurnSummaryChars: 600
maxTurnChars: 0          # 0 = 不截断近期 turn
maxTotalChars: 0         # 0 = 不设总预算
retireSource: true
verifyReadBack: true
skeletonTurn: 1          # rc.5 必须为 1
skeletonStep: 1          # rc.5 必须为 1
autoGraft: false
autoGraftAtRatio: 0.75
contextWindowTokens: 0   # 0 = 从 request/context 推断
autoGraftIdPrefix: auto-graft
autoGraftSessionIds: []  # 空 = 所有会话
autoGraftKeepAliveMs: 0  # 仅测试用
constraintProvider: ''
constraintModel: ''
```

长会话建议显式设置预算，例如 `maxTurnChars: 12000`、`maxTotalChars: 60000`。本机 317 份真实日志扫描结果：299 份可切片，16 份 open-turn，2 份无闭合 turn；平均 tape 约 14k 字符，最大约 199k 字符；不设预算时请自行评估模型上下文。

## 构建与测试

```powershell
cd <plugin-dir>

# 1) 构建 index.js（Node >= 22.6 才带 stripTypeScriptTypes；运行时只需 Node >= 20）
node scripts/build.mjs

# 2) 255 个测试
node --test test/*.test.mjs

# 2b) 文档与代码一致性（版本、构建新鲜度、工具清单、测试计数、功能状态）
node scripts/check-docs.mjs

# 3) 端到端演示：自动挑一份最近的、已闭合的真实日志
node scripts/demo.mjs

# 4) 指定源会话
node scripts/demo.mjs --source session-demo-source --new session-graft-demo

# 5) 只读扫描本机全部真实日志
node scripts/scan-real-logs.mjs

# 6) 可选：用从 app.asar 提取的真实 v4 校验器再验一遍
$env:DSH_VALIDATOR_NODE_MODULES = "$env:TEMP\dsh-format-check\node_modules"
node scripts/validate-real-format.mjs
```

## 安装与调用

```text
plugin_manager(action: "install_bundle", target: "D:\\work\\demo\\dsh-graft-slice")
```

或手动挂到 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-graft-slice
      name: dsh-graft-slice
      config:
        recentTurns: 5
        retireSource: true
        verifyReadBack: true
        skeletonTurn: 1
        skeletonStep: 1
        autoGraft: false
```

然后调用：

```text
graft_slice_and_inject({ sourceSessionId: "session-…", newSessionId: "session-graft-…" })
```

刷新 Web UI 会话列表，打开/恢复新会话。若要从源会话立即退休，源会话的下一次 `agent/pre-step` 会返回 `{ kind: 'reject' }`；如果不想停掉源会话，把配置改为 `retireSource: false`。

冷恢复验收：

1. 重启 DSH，打开新会话，不得出现 `SessionFormatError`。
2. 新会话第一轮应以第一人称复述目标、进度、下一步。
3. `deriveMessages()` 中骨架事件不产生消息，注入的 assistant 消息作为顶层消息投影。
4. 在新会话调用 `graft_read_result({ sourceSessionId, seq })` 能取回旧工具结果。

## 限制

- `retiredSessions` 内存集合由 `.retired.json` 支撑，按 profile 隔离（见上文）；文件损坏时静默降级为空集，不会阻断激活。
- 源会话必须有绝对 `cwd`；新会话使用与源会话**精确字符串相等**的 `cwd`，不做 `normalize`/symlink 归一化。这是跨会话工具授权的前提。
- 不注入 `tool/result` 事件；工具结果只以指针文本存在。
- 不复制源 `stream`；所有合成 assistant 消息都是 `stream: []`。
- `graft_read_result` 按规格绕过工具层授权；请用工具策略限制调用方。
- `manifest.json` 的 `permissions` 是声明性元数据；DSH 0.2.1-rc.5 不按插件 manifest 做权限强制，实际能力来自注入的 Service。
- 代码块指针只处理 assistant 正文里的 fenced block；缩进式代码块与 `write_file`/`edit` 产物不处理。
- 草稿转发与异步约束精修已实现：源被 reject 前捕获最后一条 user 文本写入 `.graft-drafts.json`，target 首次输入合并一次即删除；迁移关键路径只用正则约束，LLM 精修在后台完成后排队，由 target 下一次 pre-step 注入一次。迁移本身仍是同步的（建 target、落盘、斩断之间不并发）。
- source 独有的工具在 target profile 不存在时，指针会被降级成"历史记录：使用了当前环境不支持的工具 X"，只保留 `graft_read_result` 的 seq 取回路径（见 v6.4 F3）。降级依赖宿主实时工具注册表：注册表读不到时按"全都可用"处理，指针保持原样——宁可让模型尝试一次，也不谎称工具不存在。
- `[Workspace Files]` 是**写入记录**，不是磁盘校验：本窗口写过/改过的路径按最近一次操作排序，最近一次报错的标 `未确认落盘`，超过 20 条的按总数声明省略。文件若被后续步骤删除或改名，索引不会知道。
