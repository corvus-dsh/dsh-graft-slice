# handler-inventory · dsh-graft-slice

> 生成物：`node scripts/handler-inventory.mjs --write`。**不要手改** —— 它每次从头扫源码。
> `facts` / `movable` / `why` 来自 `docs/handler-inventory.json`（判断，不可机械提取）。

## tool · 9

| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |
|---|---|---|---:|---|---|---|
| 1 | `graft_slice_and_inject` | src/index.ts:13621-13754 | 134 | 写：把源会话切片写进目标会话（tape + 注入），并在成功后退休源会话 | 是 | 切片本体在 ignition / pending-transfers；这里只剩编排。搬出时必须连回执字段一起，否则审批链路的形状会分裂。 |
| 2 | `graft_resume_session` | src/index.ts:13765-13811 | 47 | 写：撤销一次迁移（把会话从 retired/transferred 移回可用） | 是 | 与 ledger 的 retired/transferred 集合同源；搬出时判据随迁，避免「取消迁移」有两份实现。 |
| 3 | `graft_prepare` | src/index.ts:13819-13944 | 126 | 写：产出 PreparedSlice（含 handover / task-position / 各 chunk）并落盘；只读源会话 | 部分 | prepare 是审批的第一步，它的回执形状是「无损 JSON」判据的锚（v301/v302）；搬出需要同步移动那些判据。 |
| 4 | `graft_commit` | src/index.ts:13946-14004 | 59 | 写：把批准的 PreparedSlice 写进目标会话并点火；校验 digest | 部分 | 与 prepare 成对（digest 校验跨两者），单搬会造出两个所有者。 |
| 5 | `graft_search_history` | src/index.ts:14006-14138 | 133 | 只读：按关键词检索源会话 / 上游链的日志 | 是 | 纯读 + 授权门禁（按 graft 自己的 pair 记录判定来源链）；门禁在 read-helpers 侧。 |
| 6 | `graft_read_result` | src/index.ts:14140-14265 | 126 | 只读：按 seq 取一条 tool 结果或 assistant 消息 | 是 | 同上，纯读。 |
| 7 | `graft_update_goal` | src/index.ts:14293-14371 | 79 | 写：改写**当前会话**的 goal 记录（goalEvolution 追加一条） | 是 | 依赖调用方会话身份；搬出时「谁是调用方」的取法必须保持一个所有者。 |
| 8 | `graft_constraint` | src/index.ts:14374-14588 | 215 | 读写：项目级约束的 declare / reject / promote / demote（写 constraintSections 存储） | 是 | 约束从抽取池里取；搬出时「约束的唯一所有者」必须仍然是一个（当前是 constraint-section 存储）。 |
| 9 | `graft_debug_status` | src/index.ts:14590-14745 | 156 | 只读：水位 vs nudge/cutoff、锁、.txn 残留、retired 数、memory store 状态、compaction ceiling | 是 | 纯诊断；它与 memory 面板读同一批事实，搬出时「谁算 compaction」的单一所有者必须不动（19.4-F 已收口）。 |

## command · 3

| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |
|---|---|---|---:|---|---|---|
| 1 | `graft-console` | src/index.ts:13585-13589 | 5 | 只读：单会话转生控制台状态（阈值 / 行 / pendingIgnitions） | 是 | 与 -global 共用同一个 consoleState；两个命令一起搬，否则面板契约分裂。 |
| 2 | `graft-console-global` | src/index.ts:13601-13606 | 6 | 只读：会话无关的控制台状态（面板实际调用这条；行级阈值 + compaction 顶层字段） | 是 | 同上；17.4-A / 19.4-F 的字段形状（顶层 compaction、configWritable）是 client.js 的契约，搬出时不许改形状。 |
| 3 | `graft-console-set` | src/index.ts:13607-13617 | 11 | 写：一个配置键落盘（configEditor / profile patch），含宿主压缩开关那一行 | 是 | 可写键集合是被判据钉住的（v311）；搬出时那张键表必须跟着走，否则「可写键」有两个所有者。 |

## event · 4

| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |
|---|---|---|---:|---|---|---|
| 1 | `PRE_STEP_EVENT` | src/index.ts:12230-12741 | 512 | 读写：[agent/pre-step] 判定是否进入（nudge / 强制切 / 抑制窗口）+ 注入提示 | 难 | 闭包持有 settings / 抑制窗口 / 会话态；这是整个转生决策的入口，搬出前必须先抽出「决策状态」这个对象。 |
| 2 | `TURN_STOPPING_EVENT` | src/index.ts:12768-12795 | 28 | 读写：[agent/turn-stopping] 回合收尾时的台账与转述落盘 | 难 | 与 PRE_STEP 共用抑制窗口与台账状态；同一理由。 |
| 3 | `agent/request-error` | src/index.ts:12824-12921 | 98 | 读写：请求错误的记账与重试判定 | 是 | 依赖较少，但它的回执与 PRE_STEP 的账本同源，搬出时账本必须只有一个所有者。 |
| 4 | `tools/pre-execute` | src/index.ts:13122-13148 | 27 | 读写：工具执行前的命令护栏（越界搜索 / 递归删除） | 是 | 护栏本体在 core/command-guard.ts；这里只是接线，搬出成本低。 |

## adapter-entry · 0

**这一类是 0，理由是事实：** graft 不注册 adapter 项：它是 paradise 写通道的**消费方**（经 setParadiseWriteProvider 注入），不是提供方。适配层（dispatcher / adapters / launcher / workflow）在 dsh-paradise，那里才有 adapter 注册面。这一格是 0 是事实，不是漏扫。

