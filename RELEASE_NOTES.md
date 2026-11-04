# dsh-graft-slice v0.21.0 — 点火死锁拦截、身份追溯、以及控制台真接通

**发布日期**：2026-11-04　**状态**：预发布（v0.20.0 → v0.21.0）　**测试**：404/404（+17）

## P0：双盲状态（源已冻结、目标没醒）已被拦截

**这是本次最致命的一条**。迁移刻意先退休源、再点火目标——因为源要被替换，不能让它继续接受输入。
于是存在一个**单边窗口**：源冻结，目标是唯一出路。如果点火最终失败（无通道 / 抛错 / 20s 超时 × 3 轮），
这个窗口**永不关闭**：源 `pre-step` 返回 `reject`，目标虽在磁盘上但不动。两者都活着，**没有一个接受工作**——
不是丢了一次迁移，是**丢了一个会话**。

修法：`rollbackFailedIgnition` + `ignitionExhausted`。预算耗尽时执行 **un-retire**：

1. 从 `.retired.json` / `.transferred.json` **文件里**移除（不只是内存）；
2. 清掉 pre-step 实际读取的**四个**标记：`retiredSessions` / `transferredSessions` / `autoGraftStates` /
   `pendingGraftSources`（只清台账会留下 `autoGraftStates==='done'`，pre-step 永远返回 `Transferred`——
   同一双盲状态低一层复现）；
3. 向源会话写一条 `developer/message`：`[dsh-graft-slice 回滚] 由于新会话点火失败，已为您自动回滚到当前会话，请重试切片。`
4. 目标保留但标题标记 `[点火失败] <id>`，避免被误认为该继续的会话；
5. 审计 `ignite-rollback`，含 `sourceRestored` / `noticeAppended`。

三个实现细节值得单说：

- **`persistRetiredStore(ctx, [id])` 不够**。写路径是 read-modify-write，并且会把文件内容**采纳回内存**
  （为合并两个进程的退休集，这是对的）。所以"先删内存、再写文件"会被同一次写回的采纳步骤撤销——
  内存看着成功，磁盘上还在，**下次重启照样冻结**。`unRetireDurably` 在锁内先改文件，再让内存与文件一致。
- **回滚提示只写一次**：单次路径与队列路径可能都到达回滚，两条同样的提示读起来像两次独立故障。
- **成功点火绝不回滚**：那会复活用户已经离开的会话，正是退休机制要阻止的「两个分叉目标」。

## P1：切片身份元数据（容灾追溯）

每个目标的第一条用户消息里多一行**机器可读**的溯源：

```
<!-- graft-identity: {"sourceSessionId":"session-…","boundarySeq":4043,"generation":1} -->
```

HTML 注释形状 ⇒ UI 里渲染为无、模型不会当指令；`parseIdentityMetadata` 可逆解析。
目标被污染或需要重切时，能从一条普通日志读取里拿到**确切**的 source / boundary / generation，
而不是让人去读散文猜。

## 修复：控制台 `cannot get property "remote.commands" without inject`

重启后两个面板报这条错误、全部不可操作。根因不是笔误：Client 侧 `remote` 是**生成的命名空间**，
只有当 `dsh.client.inject` 声明了 api-remotes 包时才存在，且属性读取受守卫。

两处修复：

1. `dsh.client.inject` 声明 `@deepseek-ai/dsh-api-remotes` + `@deepseek-ai/dsh-client-ui-conversation`；
2. bridge 改为优先走 `host.call(method, args)`——**包私有 RPC，无需任何 inject 声明**；
   生成的命名空间降为兜底。并且每个方法**返回结果而不抛异常**，所以一个通道死掉不会让整个面板崩成空白。

## 验证
17 条新测试：`v021-ignition-rollback`（7，含用户点名的**「点火永远超时 ⇒ 旧会话被成功 un-retire」**验收）、
`v021-identity-metadata`（5）、`v021-console-bridge`（5，用**真实 client.js 源码**求值，不是复制品）。
404/404 全绿；`check-docs` 27 facts；`verify-bundle` 27/27。

技术债登记见 [ARCHITECTURE.md](./ARCHITECTURE.md)（TD-1..TD-5，含 `index.ts` 体积）；
**本次发版不做任何大规模代码搬迁**。

---

# dsh-graft-slice v0.20.0 — 交接任务看板（Task Board）

**发布日期**：2026-11-04　**状态**：预发布（v0.19.0 → v0.20.0）　**测试**：387/387（+11）

## 问题
v0.19 蒸馏得对，但**渲染成了一段话**：一行结果、一段下一步、一行停泊点。读散文的模型必须**自己推导看板**
——哪些做完了、哪些正在进行、哪些还没开始——而这一步推导正是"恢复的会话开始重做已完成工作"的入口。

## 修法：`renderTaskBoard`
`renderInstructionCard` 现在渲染一张**四列看板**（同一个渲染器，不另起一套格式，避免两套格式漂移）：

```
## 交接任务看板（第一轮只要读这里）
**原始用户要求**：把两个插件升级到 v0.20 并跑通全量测试

**✅ 已完成**
- git commit abc1234 成功（seq=88）

**🔄 进行中**
- 正在改 retrieve.ts 的任务对齐过滤

**⏭️ 待开始**
- 提交并推送两个仓库

**⚠️ 唯一未决阻塞**：pwsh 失败：…（原文 seq=41；只有后续工作确实卡在它上面时才去读）
**停泊点**：Turn 9 已完成 · 边界 seq=240 · 可回读指针 12 处 · sourceSessionId=…
需要原文时用 graft_read_result(sourceSessionId="…", seq=…)，或用 graft_search_history 先搜后读；不要靠猜。

**已按语义瘦身**：丢弃 3 条已解决的报错、2 段报错正文（只保留一行摘要）、812 字符中间叙述

旧会话的历史执行日志和临时错误无需理会——它们只作为回读证据保留。请直接执行上面「⏭️ 待开始」里的待办项。
```

设计要点：

1. **「🔄 进行中」是 v0.19 缺的那一列**。断点落在开放轮次时，那里的工作既不是"已完成"（没有结果），
   也不是"待开始"（已经开工）。并进「待开始」会让目标重做，并进「已完成」会让目标以为已落地。
   它来自开放轮次**自己的**未执行指令，与 `open-turn-carryover` 共用同一个提取器，所以两者不会互相矛盾。
2. **空列要声明，不能省略**。缺失的列读作"未知"，显式写 `- 无` 读作"确实还没有"——这是两条不同的指令。
3. **看板发 seq，就必须点名读它的工具**。v0.19 这句来自正文的散文回读提示；看板丢掉了散文，
   所以补上 `graft_read_result` / `graft_search_history` 那一行，否则目标手里只有坐标、没有用法。
4. **正文不再整段搬运**。散文里"我接下来需要 X"被**移进**「⏭️ 待开始」列（模型没写 todo 时它就是唯一的计划）；
   排除项与回读提示保留为注记；其余判重后丢弃——看板复述自己只会更长，不会更清楚。
5. **瘦身披露的计数必须真实**。重构中曾丢失 `narrationChars` 的累加，导致披露行消失；现已用测试守住。
6. **点火 Prompt 同步改写**：

```
[dsh-graft-slice 点火] …旧会话的历史执行日志和临时错误无需理会，它们只作为回读证据保留；
请直接执行看板中「⏭️ 待开始」里的待办项，不要复述交接过程，也不要重新调研已经完成的部分。
```

同一句话同时写进**点火 Prompt**（目标读到的第一条）与**看板尾部**（目标每轮重读的那块）：只写一处就会留缺口
——一次性消息会随消息过期，常驻块才是长期有效的规则。

## 验证
11 条新测试（`test/v020-task-board.test.mjs`）：四列存在且按阅读顺序、进行中不并入另两列、空列显式声明、
看板点名回读工具、未决阻塞一行带 seq、尾部规则、瘦身披露计数、超预算截断有声明、
点火 Prompt 含"无需理会"与「⏭️ 待开始」、`renderInstructionCard` 就是看板。387/387 全绿。

---

# dsh-graft-slice v0.19.0 — 切片极限瘦身 + 物理点火

**发布日期**：2026-11-04　**状态**：预发布（v0.18.0 → v0.19.0）　**测试**：376/376（+20）

## 问题一：交接带着旧房子的报错
`open-turn-carryover` 把开放轮次基本原样搬走——助手叙述逐字、指针逐行，加上 `renderLastStepScene`
里那条**完整报错正文**（上限 2000 字符）。这是目标既不能执行也不能验证的最大一块文本，而且它让
新会话开局先修一个已经修好的问题。

## 修法一：语义状态提取（`extractSemanticState` + `renderInstructionCard`）
只提炼「最终结果 + 未执行的下一步 + 停泊点」，装进一张 ≤1400 字符的**指令卡**：
- 最终结果从证据里读：`git commit <sha>` / `git push` / `测试 N 通过` / `写入 <file>`，**每条都带 seq**；
- 扫描自新到旧、遇到第一个成功即停 ⇒ 更早的失败一律视为已覆盖（`resolvedErrors`），**不进新上下文**；
- 只有**没有任何成功覆盖过**的那条报错保留一行（160 字符 + seq），因为它是下一步的阻塞；
- 丢弃**必须声明**（`【已按语义瘦身】`）；指针散文丢了但**坐标保留**（`seq=…`），可达性不变；
- `open-turn-carryover` 只保留**未执行的用户指令** + 指针坐标 + 丢弃声明；
- `extractConstraints` 跳过 `[dsh-graft-slice 点火]` 消息：它是真实 `user/message`，但它是我们写的
  引导语，不是人声明的规则。

## 问题二：目标会话正确但静止
交接成功、源会话已退休，而目标**等人点它**——工作停在交接成功的那一刻。`selfSliceBootstrap`
是一句写给目标的话，不是机制。

## 修法二：物理点火（`igniteTargetSession`）
`graft_slice_and_inject` 在 `handle.flush()` 之后、退休事务提交之后调用宿主
`sessionController.prompt(request, signal)`（Web 输入框同一条通道，会从持久化冷恢复会话），
投递带 `[dsh-graft-slice 点火]` 标记的唤醒指令。缺省开启（`igniteTarget: true`，`ignitionMode: queue`）。
- 通道缺失/抛错/超时 20s：**迁移照样成功**，`ignition` 如实上报，意图写入
  `<dataDir>/.graft-pending-ignition.json` 由下一次 `apply()` 重试；
- 目标日志已有点火消息：`alreadyIgnited`，**不再投递**（重复投递 = 同一句话被读成两轮用户意图）；
- 连续 3 次失败：放弃并审计 `ignite-failed`；
- 审计线：`ignite` / `ignite-failed` / `ignite-skipped`。

## 控制台
新增「物理点火」卡片：`igniteTarget` 开关、`ignitionMode`（queue/steer）、**未点火会话列表**
（含重试次数）。`igniteTarget` 与 `ignitionMode` 均可实时落盘，无需重启。

## 验证
18 条新测试：`test/v019-semantic-card.test.mjs`（10 条：提交/推送/测试/落盘识别、最新结果优先、
已解决报错丢弃并计数、未决报错一行带 seq、`slimScene`、卡片结构、诚实空卡、
**端到端**——噪声开放轮只留干净卡片且丢弃有声明、点火消息不进约束）与
`test/v019-ignition.test.mjs`（8 条：标记与默认值、通道被调用且 sessionId 是目标、
**点火在落盘之后**、无通道如实上报并入队、抛错不回溯迁移并审计、
已点火不重复投递、`igniteTarget:false` 差分开关、Remote 面兜底）。

## 补正：`ask` 走真正的审批通道
v0.18 把 `autonomous` 下的 ask 实现成「拒绝并让 agent 去要确认」——那是权宜之计。核对宿主契约后：
`tools/pre-execute` 是瀑布，决策可以是 `{kind:'ask', reason, displayReason}`，且**缺少审批支持时会
降级为拒绝**（天然 fail-closed）；而 `tools.guard()` 只能返回拒绝字符串。
所以现在两个决策各走各的通道：**deny 走 guard**（单调，后来的 guard 无法撤销），**ask 走瀑布**（真审批弹窗）。
顺序上 guard 在瀑布之后，因此 deny 仍然压过 ask——更严的判定存活。
387/387 全绿。

---

# dsh-graft-slice v0.18.0 — 风险/策略分离、动态水位、硬约束零丢失、台账 epoch

**发布日期**：2026-11-04　**状态**：预发布（v0.17.0 → v0.18.0）　**测试**：356/356（+23）

## 问题
第三方审计：本插件仍在用**字符串防御**。三处具体缺陷：
1. `scanAgentCommand` 同时承担"判定命令是什么"和"决定拦不拦"，策略散落在正则里，没有可读的操作员表；
2. 水位是写死的 `0.70` / `0.75`：小窗口下交接本身装不下（迁移在交接过程中被窗口填满而失败），大窗口下又过早；
3. `extractConstraints` 用 `slice(0, 8)` + 8000 字符 `break` **静默**砍掉规则——目标读到的 HARD CONSTRAINTS
   可能正好缺了它即将违反的那条。
加上共有防线缺口：`.retired.json` / `.transferred.json` 无版本号，另一个插件可能"读到半条记录"就用它生成技能。

## 修法
1. **风险/策略分离**：`classifyAgentCommand` 只给 `safe | unknown | destructive`；`policyDecision(risk, mode)`
   是一张表（strict / balanced / autonomous）。`tools.guard` 按 `safetyMode` 执行，审计区分
   `command-blocked` 与 `command-asked`。`destructive` 在 `autonomous` 是 **ask**（拒绝并指名确认步骤），
   不是 allow。
2. **动态水位**：`estimateGraftCost` + `calculateSafeWatermark(windowLimit, estimatedGraftCost)`；
   `0.75` 降级为**天花板**（历史实测最晚可切点），下限 0.50；增长预测来自 `growthTokensPerTurn × growthReserveTurns`。
   `feasible: false` 明确表示"这个窗口装不下一次交接"。`watermarkMode: 'fixed'` 保留旧常量供差分测试。
3. **硬约束零丢失**：容量驱动打包（`constraintBudgetChars`，默认 8000），逐条不截断；装不下 → 报告，
   `assertConstraintsPreserved` 抛 `GRAFT_ABORTED: constraints truncated`。可返回的计划带
   `constraintIntegrity` 正向证据。
4. **台账 epoch**：两个台账写成 `{epoch, at, pid, payload}` 信封；旧形状（epoch 1）继续读并在下次写入时就地升级；
   未来 epoch 与缺 payload 的信封**拒读并等下一次重试**。`dsh-memory` 同步实现，harvest 报 `ledger.deferred`，
   `memory_migrate_evidence` 在被拒时不再猜"最新会话"。

## 验证
23 条新测试：`test/v018-policy.test.mjs`（决策表 + guard 按配置模式执行 + 审计分类 + **拒绝的单调性**：
后注册的宽松 guard 无法推翻我们的拒绝——这正是"策略只接 `tools.guard`、不接可被覆盖的
`tools/pre-execute` 瀑布"这条架构决定的测试表达）、
`test/v018-watermark.test.mjs`（成本模型、单调性、夹取、不回归、增长预测、fixed 差分、端到端更早切断）、
`test/v018-constraints.test.mjs`（容量与报告、`GRAFT_ABORTED`、计划内正向证据、容量可调）、
`test/v018-ledger-epoch.test.mjs`（信封写入、旧形状兼容与升级、未来 epoch 拒读、撕裂拒读与重试）。
356/356 全绿。

---

# dsh-graft-slice v0.17.0 — 宿主噪音过滤

**发布日期**：2026-11-04　**状态**：预发布（v0.16.0 → v0.17.0）　**测试**：333/333（+6）

## 问题
迁移 tape 里保留了源会话机器上的路径（`C:\Users\<user>\AppData\...`、`/home/...`、`/tmp/...`）与整盘扫描
命令的输出。它们在日志里是真实历史，但对目标而言是**不可解析的路径** + 一个"profile 目录属于我的工作区"的暗示。

## 修法
`stripHostNoise(text, cwd)`：只含宿主路径的段落整段替换为 `[宿主环境噪音，已过滤]`；含项目路径的段落只
redact 宿主 token（保留真实工作）；全盘扫描输出无项目路径则 `[命令输出已折叠]`。收口在
`buildInjectionPlan` 的 chunk 映射与 `renderWorkspaceState`，所以没有"忘了包一层的构建器"。
判据窄：`C:\Users\<user>\...` 是噪音，`C:\...` 之外的项目路径不是；工作区内的 `rg` 不是。

## 验证
6 条新测试（`test/v83-noise.test.mjs`），含端到端验收与工作区索引路径；333/333 全绿。

---

# dsh-graft-slice v0.15.0 — 七道防线 + 跨仓库版本对齐（v0.15.0 军规）

**发布日期**：2026-11-03　**状态**：预发布（v0.12.0 → v0.15.0）　**测试**：321/321（+25，含 v0.13 两项）

> 版本号说明：本次把 `dsh-graft-slice` 与 `dsh-memory` 统一到 **v0.15.0**（`package.json` / `manifest.json` /
> README 三处对齐）。graft 侧承载「七道防线 + 调试面板」，memory 侧承载「双时态记忆 + 取代裁决 + 来源分级」。

---

## 七道防线（v0.13 两项 + v0.14 五项）

| # | 防线 | 落点 | 行为 |
|---|---|---|---|
| D1 | 封杀全局搜索 | `tools.guard` + system-prompt section + pre-step 注入 | 盘符根 / AppData / 用户目录的搜索在 dispatch 前被拒 |
| D2 | 防死循环切片 | `isProtectedGraftTarget` 无条件生效 + nudge 抑制 + `graft_generation` | 目标前 2 轮任何自动路径都切不动，含 75% 兜底 |
| D3 | 记忆工作区硬隔离 | memory 侧（写入记 `workspace`，读取端池级门禁） | 跨工作区/无 provenance 一律不注入 |
| D4 | 记忆防污染 | memory 侧 `threat.ts` 注入前重扫 | 注入型文本直接丢弃，含未渲染正文 |
| D5 | 进程级锁清理 | `apply()` 启动 `scanAndReclaimLocks()` | 按 owner PID 判活：死锁回收并审计，活持有者不动 |
| D6 | 危险命令拦截 | 与 D1 同一 scanner | 逃出工作区的递归删除被拒；工作区内照常 |
| D7 | 一次性约束过滤 | `extractConstraints` + LLM 提示 | “立刻删除某文件”这类只安全一次的步骤不进 HARD CONSTRAINTS |

### 本次修掉的两个真漏洞

1. **D2 的守卫一直存在，却恰好在无人值守那条路上被跳过**：`graftTargetGraceTurns` 嵌在
   `ignoreTransferGuard !== true` 里，而两条自动路径（75% 兜底、确认模式）都传了 `ignoreTransferGuard: true`。
   绕开“已退休/已转移”不等于绕开“这是刚出生的目标”，两者现已分离（仅 `forceSlice` 可绕过，自动路径都不传）。
2. **D4 的扫描会被渲染器的截断击败**：`clipTitle` 把标题截到 30 字符，`Ignore all previous instructions`
   变成 `Ignore all previous instructio…`，模式不再匹配。现在同时扫**未截断的源字段**。

## 调试面板 `graft_debug_status`（+ CLI）

- 工具：水位（token / 窗口 / 百分比 / 数据来源 / 距 70% 与 75% 还差多少）、锁与事务（`.lock` 持有者 pid 与存活、
  `.txn` 未完成、retired/transferred/graft target 计数）、记忆库（技能/负知识/事实/经验/队列 + 带 `workspace`
  时的同区/跨区/无 provenance 分类）。
- CLI：`node scripts/debug-status.mjs --data <dir> --session <id> --workspace <path>`，锁扫描为 `dryRun`，只读。
- 水位只认真实 provider usage；拿不到就**如实 unavailable**，不编一个与宿主 meter 不一致的数字。

## 验证

321/321（新增 25 条：`test/v80-guard.test.mjs` 6 条、`test/v81-guardrails.test.mjs` 19 条）、
`check-docs` 27 项一致、`verify-bundle` 27/27。

---

# 以下为 v0.12.0 内容

# dsh-graft-slice v0.12.0 — 主动转生闭环：预警被无视就升级，强切要留痕

**发布日期**：2026-11-03　**状态**：预发布（v0.11.0 → v0.12.0）　**测试**：296/296（+4）

---

## 问题

70% 的 nudge 是建议，但「建议」不能被无视到 75% 被系统斩断：模型在 70% 后继续
调用工具，切点落在写一半的句子/工具调用中间，目标代还会把这次强制中断当成计划内交接。

## 修法

1. **升级拦截**：nudge 触发后的下一个 pre-step（= 模型又开了一步）注入一次
   「水位告急：请立刻调用 graft_prepare 和 graft_slice_and_inject 切走」。
   与 nudge 同一步绝不注入；同一步只发一次。
2. **服从不误伤**：升级前读取 nudge 之后的日志，若已出现 `graft_prepare` /
   `graft_slice_and_inject` / `graft_commit`，判定为**服从**，不注入指控。
3. **强切留痕**：被无视的 nudge 进入 75% 强切时打 `forcedCutMarks`；`buildTape()`
   在 pending-state 写入「模型拒绝提前切走（70% 预警后仍继续调用工具），导致在 N%
   水位被强制中断」。自主切片/计划内交接不带这个标记。
4. 审计新增 `nudge-escalation`；reset 清理三张会话态表，避免跨会话串味。

## 验证

- 296/296：新增 4 条（升级只发一次且不与 nudge 同步、`graft_*` 调用判服从、
  强切目标带标记与水位、自主切片不带标记）。

---

# 以下为 v0.11.0 内容

**发布日期**：2026-11-03　**状态**：预发布（v0.10.0 → v0.11.0）　**测试**：292/292

---

## 四项加固

1. **计划前置**：未完成 Todo > 3 且无 `阶段 N:` 前缀 → 注入「请先分析当前任务，制定阶段节点（Phase），
   并明确每个节点的完成标准，使用 todo_write 保存。」（已有阶段前缀则不打扰）
2. **产物复用**：pending-state 对 `write/edit` 的产物追加
   `已完成节点产物：<path>；后续请直接 read 复用，避免重复生成。`
3. **退休原子**：`.retired.json` + `.transferred.json` 两文件事务；任一失败 → 双文件回滚 +
   内存回滚 + `RETIREMENT_WRITE_FAILED`；`.txn` 仅在全部成功后清理。
4. **锁持有人 + 租约**：`owner` 文件（token/pid/at）+ 持锁续写；释放校验 token；
   等待方按租约判活，不再误抢活锁。

## E2E（3 独立 Project 并发）

`node scripts/e2e-multiproject.mjs`：3 个进程各自 dataDir，同时做 70% 自切片（nudge → slice）、
harvest、租约续期与场景路由。12 项断言全过：每项目只退休自己的源、自启提示与产物复用齐全、
租约在持有期内推进、数据库技能对 UI 查询不可见、技能证据只引用本项目 session id。

---

# 以下为 v0.10.0 内容

# dsh-graft-slice v0.10.0 — 并发安全：两个会话同时转生也不互相覆盖

**发布日期**：2026-11-03　**状态**：预发布（v0.9.0 → v0.10.0）　**测试**：288/288

---

## v0.10.0：状态文件锁

v0.9 的 Model-Driven 让"多个会话同时到达水位"从罕见变成了常态。旧写法"序列化自己内存里的
map，再 rename 覆盖"在并发下会丢掉另一方的记录：被抹掉的会话重启后复活、再被嫁接一次，
先写者则在 `SOURCE_DRIFT` 的假象里打转。

修法三层：

| 层 | 做法 |
|---|---|
| 互斥 | 每个状态文件 `<file>.lock`，用 `mkdirSync` 的 EEXIST 做原子占锁；锁龄 >30s 视为崩溃遗留直接夺取 |
| 合并 | 锁内 read-modify-write：磁盘 ∪ 内存；删除显式传 `remove`（回滚/恢复/提交消费） |
| 单写者 | 每个源会话一把 `source:<id>` 锁；切片前重读磁盘台账，第二个写者得到 `SOURCE_ALREADY_MIGRATED` |

覆盖范围：`.retired.json`、`.transferred.json`、`.graft-prepared.json`、`.graft-targets.json`、
`.auto-graft-suppressed.json`、约束分节。

**审计**：`.graft-audit.jsonl` 记录 `model-nudge` / `force-graft` / `lock-wait` / `lock-stale`。
pre-step 的提示不进会话日志，这行是"提示发过、在多少水位发的"的唯一持久证据。

**演练**：`node scripts/duel-model-driven.mjs` 用四个真实进程共享一个 dataDir（A/B 73% 自助，
C/D 76% 兜底），断言 4 源全退休、4 target 全带自启提示、审计 2 nudge + 2 force-graft、无锁超时。

**测试**：288/288（新增 4 条并发用例：合并写、prepared 防覆盖、跨进程互斥 8 并发、陈旧锁夺取）。

---

# 以下为 v0.9.0 内容

# dsh-graft-slice v0.9.0 — 模型主动觉知，自己决定何时转生

> **主动交接 · 断点优先 · 崩溃可恢复**
>
> 一个 DeepSeek Harness 插件：上下文水位到 70% 时，**由模型自己**判断是否跨阶段、
> 自己收尾、自己发起切片；系统只在 75% 作为兜底。交接产物零继承、可冷恢复、
> 每一条事实都能按 seq 回读。

---

## 一句话

**把"宿主到点强杀"变成"模型主动觉知"——正在干活的人最清楚哪里可以停。**

v4.0 的 `autoGraft` 在 75% 无条件迁移。对长任务这是物理打断：正在写的句子、
刚发出的工具调用，都随之中断；目标会话还可能把上一轮读成"当前任务"。
v7.6 给模型预留 5% 安全余量，让它在安全点自己交接，同时保留 75% 的硬兜底。

## 一、水位变成三段

| 水位 | 行为 |
|---|---|
| < 70% | 不变 |
| ≥ 70% 且 < 75% | 注入一条提示（每轮最多一次）：模型可自行交接 |
| ≥ 75% | 系统兜底：`autoGraft` 强制迁移，逻辑一行未改 |

提示原文：

```text
[系统提示] 当前上下文水位已达 73%。如果你觉得当前任务需要跨阶段进行，
请先调用 graft_prepare 查看交接单；确认无误后，调用 graft_slice_and_inject 进行自我切片。
```

### 为什么先 `graft_prepare`、再 `graft_slice_and_inject`

- `graft_prepare` 只读：模型先看清目标 / 进度 / 约束 / 遗留 / 哈希，再决定；
- 真切割走**单步**路径：模型在两步之间只要继续干活，源会话就继续增长，
  prepare 时的摘要必然漂移，`graft_commit` 会报 `SLICE_DIGEST_MISMATCH`。
  单步路径现场重切，没有这个窗口。

### 提示的传递纪律

- 走 `agent/pre-step` 的 `messages` 通道：**不写日志、不占 step 号**，不与 v4 时序冲突；
- 每个 `turn` 最多一次，同一轮跑多少 step 都不重复；
- 只是提示，不是闸门：模型判断不需要跨阶段，可以继续执行。

## 二、Target 自启：不再开局等用户

每个切片产物的 `pending-state` 底部固定追加：

```text
[系统提示] 你刚刚完成了一次自我切片。请直接接着“当前任务”继续执行，无需等待用户确认。
```

`pending-state` 是预算裁剪中的 protected chunk，**压得再紧也不会被截掉**。
`modelDrivenGraft: false` 时，这条与 70% 预警一并消失，行为回到 0.8.x。

## 三、配置

```yaml
modelDrivenGraft: true        # 默认 true
modelDrivenGraftAtRatio: 0.70 # 预警水位，须低于 autoGraftAtRatio
autoGraft: true               # 兜底防线（建议保持开启）
autoGraftAtRatio: 0.75        # 兜底强切
```

两条边界规则（都已写进测试）：

1. **不静默钳制**：预警水位配到 ≥ 兜底线时窗口为空、永不触发——配置错了就是没有预警，
   而不是被悄悄改成"看起来能用"的值。
2. **兜底线按会话实际生效情况算**：`autoGraft: false` 或被 `autoGraftSessionIds` 排除的会话
   没有强制兜底，预警窗口延伸到 100%——否则模型会误以为"后面还有系统接住"。

## 四、主动交接不等于放弃控制

- 自助切片走**同一条物理路径**：零继承、写盘后冷读校验、退休源会话。
  主动模式只改变"谁先决定"，不改变产物形状与安全不变量。
- **从自己的开放轮里切走是允许的**：`locateBoundary()` 把切点放在最后一个 `turn/end`，
  开放轮以 `open-turn-carryover` 块带过去（用户原话、助手正文、已完成工具结果的指针）。
  v7.4c 补上了"用户刚发指令、模型还没回答"的形状——此前它会被整块丢弃。
- **兜底永远在**：模型忽略提示，75% 仍然强制迁移。

## 五、同版本线的两处关键修复

### 1. 开放轮携带（v7.4c）

水位命中常常发生在模型干活中途。旧防护只把"指针 + 助手正文"算作内容，
于是"只有用户指令、还没有助手回答"的开放轮被整块丢掉，目标会话把上一轮当成任务。
现在 `userTexts` 也算内容，并明确写出"这一轮尚未结束、没有助手正文"。

### 2. `phase-roadmap` 计入尾部块

v0.8.0 的节点计划块漏算进"尾部块"，导致 `graft_commit` 在摘要完全一致时仍报
`SLICE_DIGEST_MISMATCH`。修正后 commit 校验与真实切片一致。

## 六、继承自 0.8.x 的保证（未变）

- **崩溃可恢复**：`PREPARING → TARGET_FLUSHED → COLD_VERIFIED → COMMITTED` 四状态事务；
  启动扫描 `.txn/`，不变量 `sourceUsable ∨ targetUsable`；真实 `taskkill /F` 注入 7/7 通过。
- **跨代审计**：继承的 HARD CONSTRAINTS 在 pending 首行带来源锚点
  （第 N 代 / seq=Y / 必要时优先回读）。
- **来源判定只看人类**：`source.kind === 'user'` 才算用户指令；插件自述、系统注入、
  技能目录、时间戳一律不算。
- **已迁移源默认拒绝再切**，`allowReslice: true` 显式放行。

## 七、与 dsh-memory 的能力飞轮

```
dsh-graft-slice：让长任务物理上不断（上下文交接）
dsh-memory     ：让每一代经验上不丢（四层认知 + SKILL.md）
```

主动交接把断点从"系统随机选的位置"变成"模型选的安全位置"，交接单里的
PendingState / 约束 / 遗留因此更真实；退休的源会话又会被 dsh-memory 采成
Fact / Experience / Negative Path / Skill，喂给下一代。

**交接 → 记忆 → 更好的下一次交接**，这是"持久层能力架构"的闭环。

## 八、升级步骤

1. 更新插件 → 重建 `index.js` → **重启宿主**（宿主只加载启动时的构建）。
2. 确认 `autoGraft: true` + `autoGraftAtRatio: 0.75`；新字段可省略（默认已开启）。
3. 体验：到 70% 看提示 → `graft_prepare` 看交接单 → `graft_slice_and_inject` 切走 →
   新会话直接接着干。
4. 暂时不想让模型参与：`modelDrivenGraft: false`。

## 九、测试与文档门禁

```
node scripts/build.mjs          # 生成 index.js
node --test test/*.test.mjs     # 284/284
node scripts/check-docs.mjs     # 22 条事实一致
```

新增 `test/v76-model-driven.test.mjs`（10 条）：70% 注入、每轮一次、低于 70% 不注入、
关闭开关不注入、75% 强制兜底、无兜底时窗口延伸、排除会话窗口延伸、Target 自启文案、
默认值，以及**端到端**：收到提示 → 调 `graft_slice_and_inject` → 目标落盘含自启提示。

## 十、已知限制

- 水位来自宿主 `tokenMeter`（或日志 usage / 字符估算），`source` 字段会说明来源；
  估算模式下预警时机会有偏差。
- 70% 提示是建议：模型可以判断"还不需要交接"并继续，直到 75% 被强制迁移——
  这是设计内的兜底，不是故障。
- 75% 的强制迁移仍可能落在不理想时点；它是最后保险，不是常用路径。
- 未提交的冷目标无法被物理标注（宿主不提供 open-for-append），靠 `.graft-leftovers.json` 记账点名。

## 十一、隐私与安全

- 插件只读写本地会话日志与自己声明的 `dataDir`；不发起网络请求。
- 交接产物不含密钥、环境变量或宿主机凭据；运行时状态由目标会话自己的 agent loop 重建，
  不伪造 `request/header`、不复制权限事件。
- 文档与示例中的路径均为占位符或虚构工作目录。