# v7.6 报告 — graft-slice 瘦身切割（第一阶段）

> 日期：2026-11-05
> 包：`dsh-graft-slice`（唯一改动的包）
> 结果：**542 / 542 全绿**（与基线完全一致）· `index.ts` **14,026 → 12,614 行**（-1,412）
> 旁证：`dsh-paradise` 122/122、`dsh-observer` 181/181 —— 均未受影响

---

## 0. 先说数字，因为它决定了本轮做什么

基线实测：`src/index.ts` = **14,026 行**，`node --test test/*.test.mjs` = **542 / 542 全绿**。

你上一轮采纳的选项 A 是「只抽与彼岸层真正重叠的四类」。我按这个口径执行，结果：

| 块 | 行数 | 去处 |
|---|---|---|
| 点火全套 | 723 | `src/core/ignition.ts`（921 行含头注释与依赖注入） |
| 宿主形状（骨架/消息/物化/冷读校验/身份元数据/系统头） | 841 + 66 + 1 | `src/core/host-shape.ts`（996 行） |
| **合计移出** | **1,631**（含搬入的辅助常量） | — |
| `index.ts` 净变化 | **14,026 → 12,614** | **-1,412 行** |

**为什么不是 5,000 行**：你已确认过，剩余约 6,000 行是存储/账本层（1,517）与工具注册层（4,119），它们与彼岸层**零重叠**。我在 `ARCHITECTURE.md` 的 TD-7 里写清了为什么现在不搬、以及它们与彼岸层无关。

---

## 1. 两块各自搬了什么

### 1.1 `src/core/ignition.ts`（723 行移出）

**搬走的**：`IGNITION_MARKER` / `DEFAULT_IGNITION_PROMPT` / `IGNITION_MAX_ATTEMPTS`、`ignitionDeadline`（AbortSignal 兼超时）、`alreadyIgnited`（按目标查日志 + 进程内准入）、`igniteTargetSession`（双通道 + 首次接受即记录准入）、`describePromptFailure`、`attemptIgnition`（持久队列原语）、`rollbackFailedIgnition` + `unRetireDurably`（un-retire 源会话）、`resumePendingIgnitions`（队列消费 + 预算耗尽即回滚）。

**没搬走的，以及为什么**：`pendingIgnitions` / `ignitionAdmissions` / `rollbackNoticed` 这三个 map 留在 `index.ts`。它们被 pre-step 闸门、debug 面板工具和 `configureRetiredStore` 共享——搬它们等于搬半个文件。

**怎么解决反向依赖**：注入 resolver，不用 `deps` 参数。

```ts
// core/ignition.ts 侧
let resolver: (() => IgnitionDeps) | undefined
export function setIgnitionDepsResolver(fn: () => IgnitionDeps): void { resolver = fn }
function state(): IgnitionDeps { /* 每次访问都问 resolver */ }

// index.ts 侧（文件最末尾，所有声明就绪之后）
setIgnitionDepsResolver((): IgnitionDeps => ({ admissions: ignitionAdmissions, ... }))
```

**三个不是风格的选择**：

1. **必须在文件末尾注册**。`graftTargets` 在 ~9870 行，`pendingGraftSources` 在 ~9780 行，在上方构建 deps 会读到未初始化的绑定——TDZ 崩溃，而 bundler 会把它从构建错误变成运行时错误。
2. **注册的是 resolver 而非值**。四个测试文件直接 `import { igniteTargetSession }` 调用而不跑 `apply()`；换成值，它们会拿到私有 fallback，而**每目标准入**和**"已越过种子"检查**会静默退化。测试当场抓到：warm 目标被重复点火。
3. **路径是 thunk**。`configureRetiredStore` 会重赋 `retiredStorePath`，测试还会中途换目录；快照会让回滚写进上一个 profile 的账本——源会话在盘上仍然退休，内存里却已清空，正是回滚存在的理由。

### 1.2 `src/core/host-shape.ts`（908 行移出）

**搬走的**：`IDENTITY_METADATA_MARKER` + `renderIdentityMetadata` / `parseIdentityMetadata`、`goalMessage` / `sessionTitleForGoal` / `systemMessage` / `assistantMessage`、`assertLogOnly` / `assertMessageSurface` / `materializeTape`、`assertTopLevelHeader`、`injectionSource`、`extractRuntimeIntent`、`buildInjectionEvents`、`assertColdLog`、`extractActiveGoalChange`、`MIGRATION_SYSTEM_PROMPT` + `workspaceRedline` + `migrationSystemPrompt`、`GRAFT_CHAIN_GRACE_TURNS`。

**没搬走的**：`buildTape`、`buildInjectionPlan` 及其下游。它们决定**交接该说什么**（goal、board、constraints、carryover、codeblock 指针化），是 graft 的策略而非宿主的形状。

**切点由依赖数决定，不是由行数**：

| 候选块 | 外部依赖 | 结论 |
|---|---|---|
| `buildTape` 及以上 | **59 个**，含活动状态（`graftTargets`、`graftSliceAndInjectUnlocked`） | 搬它需要环或小型注入框架——引入的耦合并未减少 |
| 宿主形状块 | **14 个**，搬入 `extractActiveGoalChange` 后只剩 **5 个**（4 类型 + 1 常量） | 搬 |

**踩到的坑：`import type` 也算依赖**。`scripts/bundle.mjs` 用正则扫所有相对 specifier 来算内联顺序，**不区分 type-only**（类型是后来由 Node strip 掉的，不是这个 walker 做的）。所以从 `index.ts` 导入类型会直接得到：

```
Error: cycle in src/: index.ts -> core\host-shape.ts -> index.ts -> core\host-shape.ts
```

解法：host-shape **不导入 index.ts**，需要的那几个形状在自己文件里**结构化声明**（`GraftConfigShape` / `GraftPlanShape` / `SessionHeaderShape` / `SessionLogSnapshotShape` / `GraftSourceShape`）。TypeScript 是结构化的，传 `index.ts` 的对象照样满足；而 `GRAFT_REPLAY_SOURCE_KIND` 在两侧各有一份同字面量声明——三词字符串，比一个环便宜。

---

## 2. 542 条测试是底线，我守住了

```
ℹ tests 542
ℹ pass 542
ℹ fail 0
```

中途确实红过，四轮，每次都是真实缺陷不是测试将就：

| 失败 | 根因 | 修法 |
|---|---|---|
| `attemptIgnition` 不是导出 | core 的先加 `deps` 参数改了签名 | 改回 resolver 注入，签名零变化 |
| warm 目标被重复点火 | `alreadyIgnited` 把 `event.data.message` 解包了一层，`textOfMessage` 找不到 `.content` | 与原文一致：传 `event.data` 整体 |
| unreadable 日志返回 `true` | 服务解析改成了 `ctx.get()`，测试只挂直接属性 | 统一 `hostService()`：直接属性优先，accessor 兜底 |
| un-retire 没清 `.retired.json` | deps 里路径是快照，`configureRetiredStore` 重赋后不同步 | 路径改成 getter |

**没有为了让测试通过而改测试。** 唯一改动测试文件的是 `ARCHITECTURE.md` 的文档校验（新增 TD-7 后 `check-docs` 依然 27 项全过）。

---

## 3. 派生产物校验

| 检查 | 结果 |
|---|---|
| `node scripts/build.mjs` | 677,988 字节 / 7 个内联模块 |
| 连续两次构建 | **字节完全相同**（可复现） |
| `node scripts/check-docs.mjs` | **27 facts agree** |
| `node scripts/verify-bundle.mjs` | **27/27 checks passed** |
| 内联顺序 | `serialize → logger → watermark → ledger → txn → ignition → host-shape → index` |

`index.js` 从 643,304 → 677,988 字节（+34,684）。**这是预期内的**：两个新模块各自带走了原有的注释块，且 `host-shape` 有一份本地结构化类型声明。字节增加不等于行为变化，542 条测试覆盖了行为面。

---

## 4. `ARCHITECTURE.md` 登记了什么

**TD-1 更新**：现状改为 12,614 行，并新增「进度」一行，明确列出 ✅ 已搬两块、⏳ 未搬两块。

**TD-7 新增**（按你的第二条要求），写清四件事：

1. **未搬的是什么**：存储/账本/墓碑/转生（约 1,517 行）+ 工具注册层（约 4,119 行）；
2. **为什么不搬**：不是难，是**没有收益**——与彼岸层零重叠。存储层是 graft 私有的转生账本（彼岸层不关心一个会话为什么被退休），工具层是 graft 自己的对外门面（协议层不该知道 `graft_prepare` 的 schema）。搬到别处只是换文件，总行数、耦合、认知负担全都不变，但会新增两类风险：84 个测试文件直接 import 那两处的 **30 个符号**；两处都有模块级可变状态被 pre-step 与工具处理器共享，跨模块访问会立刻遇到本文件已踩两次的 TDZ。
3. **什么时候该搬**：接入彼岸层适配器时（第二阶段）。那时工具层本来就要改调用点，**搬动是免费的**；现在单独搬一次，等于为同一个文件付两次回归成本。
4. **与彼岸层的关系**：无。

---

## 5. 本轮改动清单

```
新增  dsh-graft-slice/src/core/ignition.ts      921 行  — 点火通道 + 每目标准入 + 持久队列 + 重试 + 回滚
新增  dsh-graft-slice/src/core/host-shape.ts    996 行  — 身份元数据 / 消息构造 / 物化 / 冷读校验 / 系统头
改    dsh-graft-slice/src/index.ts              14,026 → 12,614 行
改    dsh-graft-slice/ARCHITECTURE.md           TD-1 更新 + TD-7 新增
重建  dsh-graft-slice/index.js                  677,988 字节 / 7 模块（字节可复现）
```

未改动：`dsh-paradise`（122/122）、`dsh-observer`（181/181）、`client.js`、`manifest.json`、`cordis.patch.yml`、`package.json`。

---

## 6. 诚实边界

1. **`index.ts` 仍是 12,614 行，离 5,000 很远。** 这是你已确认的取舍，不是我偷懒：剩下的 6,000 行与彼岸层无关。
2. **`host-shape.ts` 里有一份类型声明与 `index.ts` 重复**（5 个 interface + 1 个字符串常量）。原因是 bundler 把 `import type` 算作依赖边。真正的修法是让 `bundle.mjs` 认识 `import type`，那是另一件事，我没顺手改——改构建器会影响另外两个包。
3. **点火逻辑没有搬进 `dsh-paradise`。** 你要求「与彼岸层完全相同的逻辑直接移入」。实际情况是：彼岸层的 `trigger.ts` 已经有通道机制（marker / 幂等 / AbortSignal / 双通道），graft 这块的**增量**是每目标准入、重试存活检查、持久队列、un-retire 回滚——这些是 graft 私有策略，不属于协议。**所以本轮没有动彼岸层。** 第二阶段接入时，graft 的 `igniteTargetSession` 会改为调用 `paradise.session.trigger`，私有策略留在 graft。
4. **未做真机切片。** 本轮是纯重构，542 条测试 + 27 项文档 + 27 项包校验全绿，但真实宿主上的侧边栏、卡片、点火需要你重启后验证一次。建议验收动作：切一次片，确认目标会话能打开、卡片可见、自己开始跑。

---

## 7. 下一轮（第二阶段）的入口

`index.ts` 现在有 7 个内联模块，清楚到可以直接接彼岸层：

| 现有调用 | 目标 | 位置 |
|---|---|---|
| `sessions.prepare` + `sessionPersistence.create` + `append/flush/close` | `paradise.session.create(items)` | `graftSliceAndInjectUnlocked` |
| `igniteTargetSession` 的通道部分 | `paradise.session.trigger` | `core/ignition.ts` |
| `discardPartialTarget` / `mark` | `paradise.deleteSession` | 回滚路径 |
| `assertColdLog`（已抽出） | 保留在 graft（它是 graft 的红线校验，不是协议） | `core/host-shape.ts` |

`assertColdLog` 我刻意没有替换成彼岸层的校验：graft 的红线比协议更严（它管 `sourceEventSeqs`、`assistant/message` 的 stream 形状），而协议层只保证「写进去的是合法的」。**严的那一份留在 graft，是刻意的。**
