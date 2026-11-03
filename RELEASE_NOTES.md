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