# dsh-graft-slice 0.7.4（v7.4 能力线）— 技术分析材料

> 本文可独立阅读，不需要此前的对话上下文。
> 附包内容：`plugin/`（源码+构建产物+253 条测试）、`reports/`（12 份过程报告）、`state/`（运行时状态快照与两个哈希清单）。

---

## 零、愿景与位置

**事实记忆只需可查，能力记忆才需要持久化。**

上下文窗口会腐蚀：越长，注意力越散，结论越容易被自己的历史淹没。持久化能力层不试图把所有东西塞进一个窗口，而是按成本拆分记忆：

| 记忆 | 需要什么 | 承担者 |
|---|---|---|
| 事实记忆（做过什么、原文、工具输出） | 只需可查：日志 + 按 seq 回读 | `graft_read_result` / `graft_search_history` |
| 能力记忆（怎么做才对、踩过哪些坑） | 必须持久化：存储与转化 | 记忆系统插件（规划中，能力飞轮基础设施） |

三件插件构成持久化能力层：

| 插件 | 职责 |
|---|---|
| **嫁接切片插件**（本仓库） | 工作能力连续性：换干净窗口、摆脱上下文腐蚀与注意力重置；切片 / 两阶段审核 / 崩溃可恢复 |
| **记忆系统插件**（规划中） | 记忆的存储与转化，长期记忆与能力飞轮的基础设施 |
| **副会话插件**（规划中） | 隔离用户消息，为主会话提供专业具体方案，并维护记忆系统 |

共同硬约束：不 fork、不改写源日志、只追加、每个指针都能被 `graft_read_result` 打开；崩溃不带走迁移（`.txn/` 写前日志 + 幂等恢复），任何时刻 `sourceUsable ∨ targetUsable`。
## 一、背景

**DeepSeek Harness (DSH)** 是一个 agent 运行时。每个会话把全部事件（消息、工具调用、工具结果、生命周期）追加写入一份 v4 日志（多帧 zstd 压缩的 JSONL）。

长任务会撑爆上下文窗口。DSH 原生的解法是 **compaction**：把中段事件替换成一段摘要。这有两个问题：

1. **有损**，且多代累积后误差不断放大；
2. 摘要写在 surface 上，会挤掉后续注入的内容。

本项目的替代方案叫 **物理隔离（graft）**：不压缩，而是把"最后一段"切下来，搬进一个**零继承**的新会话，让用户在新的上下文窗口里继续干同一件事。旧会话原样保留，可随时按 seq 回查原文。

**核心主张**：不压缩、可回查、可撤销。

## 二、系统构成

```
源会话 (1200 事件)
   │
   ├─ 在最后一个 turn/end 处切片（安全港检查：无悬空工具调用、无活跃流）
   │
   ├─ 构造"磁带"：Goal / Task Status / Workspace Files / Pending State / 可回读索引 / 可选的最近 N 轮重放
   │
   ├─ 写入新会话（零继承：只写 1 个闭合的 turn/step 骨架）
   │
   ├─ 退休源会话（pre-step 拦截 + 侧边栏标记 [已转移]）
   │
   └─ 通知客户端新会话出现
```

配套工具：
- `graft_search_history` — 按关键字在源日志里找 seq（补齐"回查"缺少的检索环节）
- `graft_read_result` — 按 seq 取原文
- `graft_resume_session` — 后悔药：撤销退休

## 三、实测数据（真机，同一源会话 / 同一指令 / 同一模型）

任务：`已重启，检查下安装情况`（需验证 4 项插件安装状态）

| 组 | 重放轮数 | steps | 工具调用 | 文件探查 | `plugin_manager` | token |
|---|---|---|---|---|---|---|
| 源会话（完整历史） | 全部 | 26 | 31 | 0 | 2 | 437,053 |
| A 档 | 0 | 42 | 68 | **19** | **0** | 173,714 |
| **B 档** | **1** | **9** | **17** | **1** | **3** | **80,571** |

**三组结论零冲突**（都验出 2.12.261101 已装、2.13.261102 可用、discover 与 safer-dsh-market 两个标签页 active、索引 1000 条 / 11 分类）。

**关键观察**：

1. **A 档（零重放）多花 1.6× 步骤、2.2× 工具调用**，且做了 **19 次文件探查**——它靠读配置文件重建"怎么验证"，因为"用 `plugin_manager` 查挂载态"这条经验只存在于被重放掉的对话里。
2. **B 档（1 轮）全面优于 A 档，甚至优于源会话**：9 步 vs 26 步、80k vs 437k token。
3. 机制：重放的最后一轮里有「（回顾：刚才我已经调用 plugin_manager…seq=1219）」，模型读到了方法，直接照做；而上下文仍很小，每步都便宜。

**结论**：**1 轮重放 + 小上下文 > 全量历史**。记忆够用就行，多了反而是负担（源会话每步要重发 1200 事件）。

## 四、v7.4 核心变化

### 4.1 事务安全：四态状态机 + 写前日志

迁移被拆成四个可恢复状态，写进 `<dataDir>/.txn/<sourceSessionId>.json`（先写日志，再动磁盘）：

| 状态 | 写入时机 | 崩溃后的含义 |
|---|---|---|
| `PREPARING` | `persistence.create()` 之前 | 目标 id 可能已被占用，可能是空壳 |
| `TARGET_FLUSHED` | `append + flush + close` 之后 | 目标内容完整，但未经冷读校验；源未退休 |
| `COLD_VERIFIED` | `readSession` + `assertColdLog` 通过后 | 目标可用，源仍未退休 |
| `COMMITTED` | 退休与台账落盘之后 | 迁移完成，记录随即删除 |

恢复方向固定且刻意「无聊」：**让源可用、让目标诚实**。启动时 `recoverGraftTransactions()` 扫描日志：

- `COMMITTED` → 只删记录；
- 其余 → 撤销可能已发生的提前退休、标记目标、删除记录；
- 幂等：第二次启动扫到 0 条。

**不变量**：任何时刻 `sourceUsable ∨ targetUsable` 为真。

### 4.2 崩溃注入实测（L1-L5，真实 `taskkill /F`）

harness 在**独立 OS 进程**里跑真实插件代码 + 磁盘存储，父进程在指定阶段 `taskkill /F` 杀掉它；每个场景都跑两次恢复扫描验证幂等。

| 场景 | 注入点 | 观测结果 |
|---|---|---|
| L1a | `create` 之后、`append` 之前 | 源可用；目标 0 事件；日志被回收 |
| L1b | 写入半截之后 | 源可用；目标部分写入 |
| L1c | `flush` 之后、冷读之前 | 源可用（源未退休） |
| L2a | `flush` 抛 `ENOSPC` | 迁移失败被记录；源可用 |
| L2b | ACL 拒绝写 `sessions/` | `create` 阶段失败；源可用 |
| L3 | 落盘数据被篡改 | 冷读拒绝；源可用 |
| L4 | 两进程同目标 id 并发 | 恰好 1 个成功（`mkdir` 原子占位） |
| L5 | 每个 L1 场景恢复两次 | 第二次 `scanned=0` |

三个 L1 场景都会在 `.graft-leftovers.json` 留下记录（`leftoverRecorded=true`）：宿主不给删除/追加，至少让残留目标「有名有姓」。 |

7/7 通过。**这轮测试揪出一个静默 P0**：`recoverGraftTransactions` 使用的 `readdirSync` **从未被 import**，而 `catch {}` 把 `ReferenceError` 变成「扫到 0 条」——`.txn` 日志写了一整版，恢复扫描在生产里从来没真正跑过。

修法：补 import；`catch` 只把 `ENOENT` 当「干净启动」，其余必须打日志；并补上**真正读取 journal** 的回归测试（此前只断言「文件存在」）。

### 4.3 两阶段审核：先审后写

| 工具 | 作用 |
|---|---|
| `graft_prepare` | 只读：产出目标/进度/约束/遗留 + 切片哈希 + 摘要 |
| `graft_commit` | 校验 preparedId 时效、哈希、**边界 seq 未漂移** 后才写盘 |

漂移判定用**边界 seq**（决定磁带结构的那个点），不是最后事件 seq：源在开放轮尾部继续增长只是「尾部刷新」，允许提交并把 `tailRefreshed`（变了哪些块、字符数从多少到多少）写进结果，让调用方知道「写盘的比你看过的新一点」。

真机证据：`handoff-demo` 审核时 carryover 277 字符，提交时 370（提交前多写了一段），旧实现只回一句 `Committed the reviewed slice.`；现在会明确报告。

### 4.4 检索强化：按 seq 回读必须真的读得到

| 项 | v7.4 状态 |
|---|---|
| 人类消息可搜 | 支持 `user/message`，但**严校 `source.kind === 'user'`**；`plugin:graft-replay`、`runtime-context`、`skill-catalog` 等一律不可被搜成用户指令 |
| 回读指针 | `[Workspace Files]` 改为引用 **tool/result 的 seq**（此前引用 `tool/call` 的 seq，`graft_read_result` 回「No payload」）；真机 8/8 可读 |
| 可回读索引 | 24 条按最近优先；总数为真实可读事件数（本次真机 1,982 处） |
| 子代理报告 | 关键词必须落在结果开头（文件/日志类工具 12 字符内），并排除 `<path>`/行号/`✔` 转储；只保留最近 5 条 |

### 4.5 断点优先于状态

- 开放轮的 carryover 注入在磁带**最前面**，且注明**它是拼接**：`（断点块：下面 N 段正文按时间拼接自断点前各步的最终段落，不是一条完整消息）`；
- pending 里若清单第一项与断点前最后一次调用同名，追加一行：`断点前我刚发出过 X(seq=N)，这一项可能已经做完了——先核对结果，不要直接重跑`；
- 真机实例：清单写「立刻执行 `graft_prepare` 体检」，而断点块已显示 prepare 完成、下一步是提交。

### 4.6 跨代审计：约束锚点

当目标 goal 里的 HARD CONSTRAINTS 是**继承来的副本**时，pending 第一行写：

```
[高优锚点] 核心约束源自第 1 代会话（<sessionId>），seq=2282，必要时请优先回读。
下面这段 HARD CONSTRAINTS 是插件从用户原话抽取的副本，不是这一代用户刚刚说的。
```

来源判定只看**人类 `user/message`**（硬约束 8），且取**最早**一条，避免后来的再声明冒充来源。第二代起按代计数（第 N 代会话）。

### 4.7 真机自我嫁接（本项目第一次）

源会话 48 轮 / 14,978 事件 / 9.5 MB 压缩日志 → target 注入 **14,252 字符**（system 1,125 + 磁带 13,127），1 轮封闭骨架 + 8 个回顾块，指针 1,860。

| 指标 | 数值 |
|---|---|
| 体积 | 14,252 字符（源的 0.15%） |
| 截断 | `open-turn-carryover` 370 + `recent-turn` 5,889（Turn 46 全文） |
| 时效 | 引用到 `seq=14926` 的报错原文、`seq=14965` 的 prepare、`seq=14889` 的编辑 |

**实测结论**：新会话在零澄清提问下接上（先核 `.txn`/台账/自身 id，再跑全量测试），并自行发现 pending 与断点的矛盾。
## 五、已修复的 11 个缺陷（全部在真机或宿主源码中证实）

### 4.1 致命：所有 target 都无法被宿主打开（现网 284 个）

宿主 v4 校验器（`dsh-session-format-v3-to-v4` → `titleSources`）：

```js
// 空 messageSeqs 与 source.kind === 'user' 必须同真同假
if (event.type === "session/title" && references.length === 0 !== (data.source.kind === "user"))
  throw new SessionFormatError("session/title messageSeqs must be empty exactly for a user title")

// 非空时，每个引用必须是更早的、source.kind === 'user' 的真人消息
for (const value of references) {
  const source = events[seq]
  if (source?.type !== "user/message" || source.data.source.kind !== "user")
    throw new SessionFormatError("… must cite distinct earlier human user/message events")
}
```

插件写了 `messageSeqs: [goalSeq]`，而 goal 是**插件自己写的**（`plugin:graft-replay`），不是真人消息 → 必然拒绝。
而 target 里**没有任何真人消息**，所以唯一合法形态是 `{ messageSeqs: [], source: { kind: 'user' } }`。

**为什么 181 个测试没抓到**：自研校验器只检查"title 非空""无 surface 元数据"，**从未实现宿主那条 source 规则**。校验器比宿主宽松，等于没有校验。

### 4.2 致命：检索路径被静默摧毁

宿主契约：

```
schemas(scope?) — "the viewing scope (the agent); omitted = the GLOBAL view"
```

插件调用 `tools.schemas()` **不传 scope**。核心工具是按 **agent scope** 注册的（preset 内），全局视图看不到 → 插件误判"目标没有这些工具" → 所有指针被降级成 `（历史记录：…不支持的工具 X…）` → 索引的名称提取又不认这个形态 → 整个索引坍成：

```
- seq=360  Turn 5 · tool
- seq=364  Turn 5 · tool
```

**一个没有工具名的索引，读者没有任何理由去取任何一条。** 检索路径名存实亡。

**修法**：① 按源 agent 的 scope 查询；② 每个被调用的工具再用 `get(name, scope)` 交叉验证，**降级要求两次查询都失败**；③ 索引的降级指针也标注 `(unavailable here)`。

### 4.3 严重：target 缺了任务最需要的 4 个工具

源会话 `header.agentPreset = "standard"`，但在 seq 9 发过 `agent-preset/selected { agentPreset: "cordis" }`。
`cordis` 预设才带 `plugin_manager` / `plugin_market` / `cordis_inspect_*`。

插件只复制了 header 的**初始值** → target 按 `standard` 恢复 → 37 个工具（源会话 41 个），**恰好缺这个任务要用的 4 个**。target 自己的推理记录了这个症状：

> "plugin_manager isn't in my tool list."

宿主自己的重建规则印证了修法：

```js
/** Current Session preset, initialized from its header and advanced by selection events. */
init: (header) => header.agentPreset ?? null,
apply: (state, event) => event.type === 'agent-preset/selected' ? event.data.agentPreset : state,
```

**修法**：扫描 `agent-preset/selected` 取最后一个（当前生效），回退 header。

### 4.4 严重：goal 标注与内容矛盾，导致重做已完成的活

goal 被标为「**当前**要做的事」，内容却是**最初且已全部完成**的请求：

```
当前要做的事：帮我看看jet hub这个插件最新版本，以及找个…插件市场
[Task Status]  [x] 升级… [x] 安装… [x] 配置… [x] 启用… [ ] 重启后验证
[pending]      我接下来需要立刻执行：重启 DSH 后验证 Discover 页…
```

target 读到的"当前任务"是已完成的研究，于是**重新做了一遍**。信息本身都在，是标签与内容自相矛盾。

**修法**：改为「这个会话的任务」，不再声称"现在"。**"下一步"的唯一归属者是 pending state。**

### 4.5–4.11 其余 7 项

| 缺陷 | 根因 | 修法 |
|---|---|---|
| 后悔药不撤销 `[已转移]` 标记 | 只清退休状态，不改标题 | 从日志找回上一条非插件标题并还原（含原引用） |
| 预算公式 `÷0.5`（=×2） | 按英文 4 字符/token 估算，中文 1 字符≈1 token | 改为 1:1，宁可估小 |
| `assistant/attempt` 致溢出恢复永久不可达 | attempt 落在最后一个 `turn/end` 之后时，`streaming` 永不清除 | 只有 `stream` 非空才算流式；`assistant/chunk` 才是证据 |
| 搜索被单个事件吃光结果位 | 每处匹配占一条命中 | 按**事件**去重，用 `×N` 表示密度 |
| 新建 target 不通知客户端 | 客户端只在 `session/created` 时刷新，而插件走持久化层创建 | 自己 emit `api-session/added`（见 §5.1） |
| 状态文件非原子写 | `writeFileSync` 先截断再写 | tmp + rename |
| 约束 section 仅存内存 | 重启后压缩护盾消失 | 落盘 `.graft-constraint-sections.json` |

## 六、两个"不能这样做"的架构约束（重要）

### 5.1 不能通过"发布会话"来让 target 可见

直觉做法是把 target 发布进活动存储，宿主就会 emit `session/created` → 客户端刷新。**但这会毁掉可恢复性**：

```js
// dsh-agent-loop 的 resume
handle = await persistence.open(id, "write", { signal })
```

```js
// sessions.enter() 的契约
"throws if a session with this id is already in the store"
```

一旦发布会话，用户点开续接时 `enter` 会因 id 重复而失败——**会话从"看不见"变成"打不开"**。

**所以**：target 必须保持"冷"状态（只在磁盘上、不在活动存储里），通知改为插件自己 emit `api-session/added`，payload 逐字段对齐宿主的 `summarizeCold(record)`，且**故意不带 `projections`**（客户端只在它存在时应用投影帧，手搓帧有破坏侧边栏状态的风险）。

### 5.2 压缩与 system head 的关系

`dsh-compaction-basic` 的 `selectCompactableRange`：

```js
const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;
return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] };
```

**可压缩范围永远从 surface index ≥ 1 开始**。而 `SystemPromptProjection.project()` 会在 target 第一次真实请求时**替换 surface node 0**。

所以：
- 约束放 **system head** → 压缩碰不到，但会被 `project()` 抹掉；
- 约束放 **user/message** → 不怕 `project()`，但会被 compaction 吃掉。

**采用的解法**：`ctx.systemPrompt.section({name, order, text: (ctx) => …})`——它不是 surface 节点，渲染进 `systemHead` 占据的位置，**结构上双重免疫**。默认 `compaction-basic: auto: false`，但那只是"还没被打过"，不是保护。

## 七、v7.4 之后仍存在的问题

| # | 问题 | 影响 |
|---|---|---|
| R1 | **未提交的冷目标无法被「物理」标注**：宿主不提供 delete/open-for-append，`[损坏]` 标题只能写给活动会话 | 崩溃在 flush 之后会留一个**内容完整但未提交**的目标。v7.4b 起有 `.graft-leftovers.json` 台账，并在下一次 `graft_prepare` 摘要里点名「不要从它们继续」；源仍可用（不变量成立）。残留风险：用户不看摘要、直接从它续接 |
| R2 | 恢复扫描对 `COLD_VERIFIED` 的崩溃也一律回滚 | 一个已经过冷读校验的目标被丢弃并标记，浪费一次完整迁移 |
| R3 | 零重放对「依赖早期结论」的任务是否够用，仍无数据 | v7.4 的 `autoAdaptiveTier` 只是把「有未完成 todo / 最近失败」当作降档信号，n=1 |
| R4 | `totalHits` 与 `totalMatches` 的语义区分 | 需读者理解两种截断 |

（P1 回顾句冗余、P2 pending 条件句、P3 归档 fork 已在 v7.4 修完。）
## 八、希望被分析的问题

1. **B 档胜出是普遍规律还是任务特性？** 本次任务是「验证现状」——重放最后一轮恰好给了方法。对「依赖早期结论」的任务（如连续重构），1 轮是否仍够？
2. **崩溃恢复的取舍**：`COLD_VERIFIED` 之后崩溃，目标其实可用，但一律回滚是否过于保守？可否「先标记待确认，再由下次启动决定」？
3. **未提交目标的长期方案**：在宿主不提供删除/追加的前提下，插件能否用「自身台账 + prepare 时的警告」把风险降到可接受？
4. **`systemPrompt.section` 作为压缩免疫层是否足够**：它依赖宿主在渲染 system prompt 时调用 section provider。若未来 compaction 改成重写 node 0，这个防护是否失效？
5. **冷会话可见性的长期方案**：当前靠插件自造 `api-session/added`。若宿主改变该事件 wire schema，插件会静默失败。有没有更稳的官方通道？
## 九、目录与复现

```
plugin/src/index.ts        单文件实现（约 8,900 行）
plugin/test/*.test.mjs     253 条测试
plugin/index.js            构建产物（393,361 B，Node 22.6+ type-stripping）
plugin/README.md           完整设计文档（含逐条缺陷说明与宿主源码引用）
plugin/tiers.yml           A/B/C 三档配置与实测数据
state/FREEZE-MANIFEST.json 65 个文件的 SHA-256
reports/crash-report.json   L1-L5 崩溃注入原始结果
state/quarantine-manifest.json 284 个已隔离会话的 SHA-256
```

构建与验证：

```
node scripts/build.mjs        # 生成 index.js
node --test test/*.test.mjs   # 253/253
node scripts/check-docs.mjs   # 文档与代码的 22 项事实一致性
```

宿主版本：DeepSeek Harness 0.2.1-rc.5（桌面端，Windows）。
所有宿主行文均直接读取自 `app.asar` 中的真实源码，非推测。