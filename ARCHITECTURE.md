# ARCHITECTURE — v0.23 技术债、长期规则与重构登记

> 本文件登记**已知的结构性债务**，不是待办清单的替代品。每条都写清：现状、为什么现在不动、以及可验收的退出条件。
> 规则：**发版前不做大规模代码搬迁**——一次搬迁换来的回归，会把已经验证过的容灾能力重新变成未验证。
>
> **v0.23 起，本文件同时是长期规则的唯一落点**：凡是"一次说清、长期有效"的约定都写在这里，不再逐条塞进每一次交接的 HARD CONSTRAINTS。原因见下方「长期规则」一节。

## 长期规则（从 prompt 迁出，长期有效）

> 背景：交接曾把 27 条硬约束逐条搬进 prompt。规则本身大多没错，错在**位置**——prompt 是每一轮都要花掉的预算，一个需要先读完 changelog 才能找到边界的模型，边界感反而更差。
> 现在：prompt 只留 ≤5 条**红线**（绝对禁止、短、不可协商），其余进 `archived` 随交接单保留。
> 本节的每一条都是**长期规则**，不在 prompt 里，但同等有效。

### 工作区与搜索边界
1. 工作目录严格限定为当前 cwd。禁止针对盘符根目录、AppData、用户目录、全局根的搜索（`rg /`、`Get-ChildItem -Recurse` 等）。
2. 找不到文件时只允许在当前目录 `ls` / `dir` 查找。同一路径被拒绝或找不到后，**不得换写法重试**、不得向外层目录扩散。
3. 删除/移动前必须确认解析后的绝对路径就是目标路径。

### 破坏性操作
4. 禁止 `rm -rf /`、指向盘符根目录 / 用户目录 / 工作区之外的 `Remove-Item -Recurse`。
5. 清理时把目标限制在当前工作区内；无法限制时，报告风险与缺口而不是执行。

### 迁移与交接
6. 迁移纪律：完成前 2 轮之前不得再触发切片；先把手上的任务推进到明确停泊点，再考虑交接。
7. 点火路由必须按 `targetSessionId` 独立分发，`alreadyIgnited` 状态按 `targetId` 独立存储，绝不全局共享。
8. 点火失败必须回滚（un-retire 源会话），绝不出现"源已冻结、目标没醒"的双盲状态。
9. harvest 读到正在被切片退休的源时，失败绝不回写 `processed.json` 游标。

### 记忆与上下文
10. 检索必须校验记忆 `workspace` 与当前 cwd 一致；跨工作区一律不注入。
11. 检索只注入轻量元数据（`name` + `when_to_use`），正文仅在模型主动 `skill_read(name)` 时读取。
12. 完整 LLM 语义过滤只在模型主动 `memory_search` 时启用；pre-step 超时降级为严格词法召回。
13. 记忆注入必须用 `<system_meta_memory>` 做物理隔离，标注 `authority="none"`，绝不裸文本进 user 消息。
14. 负知识超 30 天未命中且上下文不符时降权，并前置 `[历史偶发错误，仅供参考]`。

### 落盘与数据
15. 结构化 JSON 落盘前必须 `JSON.parse` 校验；失败阻断覆盖、写 `.rejected-*` 隔离、抛明确 Warning。
16. `atomicWrite` 只保证不撕裂，不保证内容有效——两者是不同的问题，不要互相替代。
17. 截断一律用无副作用形式：代码层 `slice`，或 `<file_content truncated_lines="N">` 这类 XML 属性。**禁止**在正文里插入 `...[已省略]` / `...[truncated]`。

### 前端
18. 面板组件只能使用沙箱文档列出的 React 符号（`createElement` / `useState` / `useEffect`）；超出部分必须 `typeof` 探测 + 降级。
19. 面板必须有错误边界：渲染抛错显示红色卡片，绝不白屏。
20. Host 返回的 payload 一律按"数据"处理，每个字段防御性读取；不完整的数据只能损失一个区块。

## 登记项

### TD-1 `dsh-graft-slice/src/index.ts` 单文件过大（P2，非阻塞）

| 项 | 内容 |
|---|---|
| 现状 | **`src/index.ts` 12,887 行 / 12,383 非空**（G5 之后；搬运前为 13,271 / 12,742）。**行数口径：`wc -l`** —— `content.split(/\r?\n/)`，且文件以换行结尾时不计末尾空项；非空行 = 该数组中 `trim().length > 0` 的个数。已抽出 `core/host-shape.ts`（996 行）、`core/ignition.ts`（1,005 行）、`core/paradise-write.ts`（240 行）与 `core/task-state.ts`（564 行，G5）。剩余部分仍含 90+ 导出、约 60 个内部模块级函数，覆盖：日志切片、磁带构建、注入计划、台账、锁、控制台命令、调试面板、工具注册 |
| 影响 | 单文件让「改 A 碰坏 B」的排查成本变高；diff review 困难；IDE 索引与增量构建变慢；新人无法按职责分层阅读 |
| 为什么现在不动 | 见下方 TD-7：本轮只搬了「与彼岸层真正重叠」的两块。剩下的搬运是纯位移，不减复杂度，且 84 个测试文件直接 import 那些区域的 30 个符号 |
| 退出条件（可验收） | ① 按职责拆成 `session-slice.ts` / `tape.ts` / `injection.ts` / `ledger.ts` / `guards.ts` / `console.ts` / `tools.ts` 等模块，每个 ≤ 800 行；② `index.ts` 只保留 `apply()` 装配与再导出，≤ 300 行；③ **拆前后测试数不变、全绿**；④ `scripts/build.mjs` 的产物字节差异仅来自模块边界（banner 与 import 语句）；⑤ 每个模块导出面的 `grep` 参考计数与拆前一致（防止顺手删了导出） |
| 建议节奏 | 一次只搬一个模块，搬完立刻跑全量 + 真机切片一次；不与其他行为改动混在同一次提交 |
| 进度 | ✅ `core/host-shape.ts`（v7.6，996 行：身份元数据 / 四个消息构造器 / materializeTape / buildInjectionEvents / assertColdLog / extractActiveGoalChange / 系统头与红线）<br>✅ `core/ignition.ts`（v7.6，921 行 → v7.7 1,005 行：点火通道 + 每目标准入 + 持久队列 + 重试 + 回滚）<br>✅ `core/paradise-write.ts`（v7.7，240 行：彼岸层桥接 —— 懒加载、按 ctx 缓存、具名拒绝）<br>✅ `core/task-state.ts`（G5，564 行：`extractTaskState` + `checkTaskBoundary` + `checkSafeHarbor` + 它们共用的 `splitSentences` / `orderedBySeq` / todo 与 report 的解析助手；**纯搬运，导出面 180 不变，测试 598 不变**）<br>⏳ 存储/账本层（约 1,517 行）<br>⏳ 工具注册层（约 4,119 行） |

### TD-7 存储层与工具层「未搬移」（P2，v7.6 登记）

| 项 | 内容 |
|---|---|
| 现状 | v7.6 只抽出了与 `dsh-paradise` **真正重叠**的两块：`core/host-shape.ts`（996 行）与 `core/ignition.ts`（921 行）。`index.ts` 仍有两大块没有搬：<br>① **存储 / 账本 / 墓碑 / 转生**（约 1,517 行）：`.retired.json`、`.transferred.json`、`.graft-targets.json`、`.graft-prepared.json`、事务恢复、锁的调用点；<br>② **工具注册层**（约 4,119 行）：8 个工具的 `parameters` / `output.schema` / `render` 样板，加上 `agent/pre-step`、`agent/turn-stopping`、`session/event` 的监听与水位判定。 |
| 为什么不搬 | **不是因为难，是因为没有收益。** 这两块与彼岸层**零重叠**：存储层是 graft 私有的转生账本（`dsh-paradise` 不关心一个会话为什么被退休），工具层是 graft 自己的对外门面（协议层不该知道 `graft_prepare` 的 schema）。<br>把它们搬到 `src/core/` 只是**换文件**——总行数不变、耦合不变、认知负担不变，但会新增两类风险：<br>（a）84 个测试文件直接 import 这两个区域的 **30 个符号**（`acquireFileLock`、`recoverGraftTransactions`、`renderTaskBoard`、`graftSliceAndInject`、`readLedgerPayload` 等），搬动就要逐个核对 import 面；<br>（b）两个区域都有**模块级可变状态**（`retiredSessions`、`graftTargets`、`autoGraftStates`）被 pre-step 与工具处理器共享，搬到新文件后跨模块访问会立刻遇到本文件已经踩过两次的 TDZ 问题。 |
| 什么时候该搬 | 当**接入彼岸层的适配器**成为下一步时（第二阶段），工具层要改的是调用点而不是位置——那时顺手搬才有意义：改动本来就要发生，搬动是免费的。现在单独搬一次，等于为同一个文件付两次回归成本。<br>**v7.7 更新**：第二阶段（接入彼岸层）**已经发生**，但工具层仍然没搬——因为实际改动只落在 `graftSliceAndInjectUnlocked` 内的**两个调用点**（create 与 rollback）和 `igniteTargetSession` 的**通道段**，工具注册那一层（8 个工具的 schema / render 样板、pre-step 与 turn-stopping 监听、水位判定）一行都没动。原来那句「第二阶段顺手搬」的假设，被事实推翻了：接入彼岸层不是一次全局改写，而是三处调用点的替换。所以这条记录继续有效，只是理由更新为「**至今仍没有发生那次顺手的机会**」。 |
| 退出条件（可验收） | ① 存储层搬进 `core/stores.ts`（≤ 800 行），`register` / `commit` / `discard` / `recover` 四个动作各自成函数；② 工具层搬进 `core/tools.ts`，`apply()` 只做 `registerTools(ctx)` 一行装配；③ **591 条测试全绿且数字不变**；④ 上述 30 个被测试 import 的符号全部保持同名再导出；⑤ 真机切片一次，侧边栏、卡片、点火全部正常。 |
| 与彼岸层的关系 | **无。** 这是 graft 的内部整理，不涉及协议。`dsh-paradise` 只接管「怎么在宿主上写一个会话」，不接管「graft 为什么决定写它」。 |

### TD-2 `dsh-memory/src/index.ts` 单文件偏大（P2，非阻塞）

| 项 | 内容 |
|---|---|
| 现状 | `src/index.ts` 约 1,300 行，含工具注册、控制台命令、注入 pre-step、harvest 编排、配置解析 |
| 影响 | 比 TD-1 轻；主要问题是 `applyInner` 一个函数承担了注册与运行两件事，阅读时需要来回跳 |
| 为什么现在不动 | 同上：刚加完 LLM 警告 / 归档 pass / 负知识时效三处行为，先让它们被测试固定 |
| 退出条件 | 按 `tools.ts` / `console.ts` / `retrieve-path.ts` / `harvest-path.ts` 拆分，`applyInner` 只做装配；测试数与全绿状态不变 |

### TD-3 `retrieve.ts` 的启发式阈值没有统一出处（P2）

| 项 | 内容 |
|---|---|
| 现状 | `MERGE_SIMILARITY`（archive）、`TASK_TERM_LIMIT`（task alignment）、`NEGATIVE_STALE_DAYS`、`FLOOR` / `THRESHOLD`、`STOPWORD_WEIGHT` 分散在 `retrieve.ts` 与 `archive.ts`，都是常量而非配置 |
| 影响 | 调一个阈值要改代码 + 重新构建；真机调优时无法在控制台里做差分实验 |
| 为什么现在不动 | 这些阈值目前都有测试锁定其**语义**（不是数值），搬进 Config 会新增一类「配置错了但没报错」的失效模式，需要配套校验与文档，工作量大于收益 |
| 退出条件 | 全部进入 `MemoryConfig` / `GraftConfig`，带范围校验、默认值文档、以及每个阈值的差分测试（改配置 → 行为按预期改变） |

### TD-4 归档 pass 只算「计划」，合并没有真正落盘（P2）

| 项 | 内容 |
|---|---|
| 现状 | `applySkillArchive` 会写 `archived: true`；但 `plan.merges`（相似技能合并）目前**只报告不执行**——真正的合并属于 store 的职责（它拥有冲突链与证据并集），尚未接上 |
| 影响 | 膨胀治理的第一步（合并）只起到「报告」作用；真正生效的是第二步（归档 10%） |
| 为什么现在不动 | 合并要维护 `evidence` 并集、`conflicts_with` 互链、`supersedes` 链与 provenance，任何一处做错都会**丢证据**。宁可先归档（可逆、无损），也不做半吊子的合并 |
| 退出条件 | `store.ts` 提供 `mergeSkills(keeper, absorbed)`：并集 evidence、转移冲突链、保留双方 provenance、写审计行；归档 pass 改为先合并后归档，并有「合并后证据条数 = 两边之和」的测试 |

### TD-5 点火通道的可观测性依赖宿主日志（P3）

| 项 | 内容 |
|---|---|
| 现状 | 点火的成功/失败写入 `.graft-audit.jsonl` 与工具返回值；控制台显示「未点火列表」。但**通道为何不可用**（服务未挂载 / 权限 / provider 拒绝）只能从 `reason` 字符串推断 |
| 退出条件 | 在 `IgnitionResult` 中区分失败类别（`no-channel` / `rejected` / `timeout` / `threw`），控制台按类别给不同处置建议 |
| 进度（v7.7/v7.8） | ✅ **部分达成。** v7.7 接入彼岸层后，`no-channel` 与 `rejected` 已在回执上分开：前者是 `attempted: false`（没通道，意图入队重试），后者是 `attempted: true, ok: false`（试过并被拒）。`timeout` 与 `threw` 仍然只能从 `reason` 文本区分——彼岸层的 `describeFailure` 会把 `(aborted: …)` 附在原因后面，这是可读但不可断言的形态。⏳ 剩余：给回执加一个枚举字段（需要同时改彼岸层回执类型与 graft 的映射，属于下一轮的范围） |

### TD-6 `index.ts` 里的「未导出但被测试间接依赖」的领域逻辑（P2，v0.22 新增）

| 项 | 内容 |
|---|---|
| 现状 | v0.22 的点火路由隔离、撤稿竞态、原子写都改在 `index.ts` 内。`alreadyIgnited` 按 `targetId` 独立存储、`.retired.json` 的 un-retire 回滚，只能通过 `apply()` 装配后的工具面（`graft_slice_and_inject`）驱动，无法单独 import 单测。测试必须走 `fake-harness.mjs` 搭出整个宿主 |
| 影响 | 单测成本高、失败定位慢；一个纯函数（如「哪些 target 需要点火」）被迫用集成测试覆盖 |
| 为什么现在不动 | 拆这些函数会动到 `apply()` 的装配顺序，而点火/回滚路径刚刚才被 **410 条测试**（v7.7 当时）锁住。**发版前不做搬迁** |
| 退出条件 | 把 `igniteTargetSession` / `alreadyIgnited` / `unretireSource` 抽到 `ignition.ts`，作为**纯函数 + 注入式副作用**导出；`index.ts` 只做装配；测试可直接 import 单个函数，现有集成测试保持不变且全绿 |
| 进度（v7.7） | ✅ **已达成。** `igniteTargetSession` / `alreadyIgnited` / `ignitionExhausted` / `igniteTargetSession` 的准入图已住在 `core/ignition.ts`，状态通过 `setIgnitionDepsResolver` 注入（不是 import，避免与 `index.ts` 成环）。`v0.32-ignition-signal.test.mjs` 与 `v0.22-ignition-routing.test.mjs` 直接 import 单函数跑单测，**542 条集成测试**（v7.7 当时）同时保持全绿 |

---

### TD-8 彼岸层桥接的两条契约，是**调用方**的事实还是**宿主**的事实（P1，v7.7 登记）

| 项 | 内容 |
|---|---|
| 现状（v7.7） | v7.7 把 graft 的物理写入、冷读校验、回滚与点火通道接进了 `dsh-paradise`。接入过程暴露了四个只有**真实业务消费者**才会撞到的边界问题，全部已修，但每一条都是「协议里少了一个字段」而不是「graft 写错了」：<br>① `isSeeded`：预写校验用的是合成 header，缺 `isSeeded: false`，导致 **104 条测试**（v7.7 当时）在 `SEEDED_HEADER` 处集体失败；<br>② 可见消息的 `source.kind`：适配器把 observer 的 `'user'` 约定当成通用宿主规则，拒绝了 graft 合法的 `plugin:graft-replay` 回放tape；<br>③ `assistant/message` 回显：同理，回显是「本适配器合成的内容」的约定，不是宿主要求，回放tape 里没有它是对的；<br>④ `prompt` 的 marker 与 mode 词：适配器用 observer 的历史 marker（`[dsh-observer 点火]`）与协议词（`interrupt`）发请求，而宿主只认 `steer`、graft 的日志里只有它自己的 marker。 |
| 影响 | 每一条都表现为「**静默降级或错误拒绝**」，而不是崩溃。最贵的第 ④ 条：marker 不匹配会让幂等检查永远判定「没点过」，于是每次重试都会把同一条指令**再发一次**，目标会把它读成两轮用户意图 |
| 为什么登记而不是继续修 | 四条都已修完并锁了测试（`dsh-paradise/test/caller-contract.test.mjs` 8 条）。但「哪些字段属于调用方」这个判断**只做过一次**，下一个业务消费者（`dsh-memory`、`dsh-observer` 的下一个版本）很可能带来第五、第六条。把它登记下来，是为了下一次不再靠撞墙发现 |
| 退出条件 | ① `protocol/adapters.ts` 的 `CreateRequest` / `TurnTrigger` 对每个 caller-supplied 字段都写明「谁的约定」；② `caller-contract.test.mjs` 覆盖 create（`tape` / `publish`）与 trigger（`marker` / `mode` / `fallbackModes` / `origin`）的每一条；③ **第二条业务消费者接入时，零新增修复**——若仍有新增，说明边界还没定清 |

---

## TD-9 `scanAgentCommand`：**刻意保留的兼容层**，不是「8 个版本没处理」（P2，2026-11-09 登记）

| 项 | 内容 |
|---|---|
| 事实 | `src/index.ts` 的 `scanAgentCommand(command, workspace)` 带 `@deprecated v0.18` 标记至今仍在导出面上。它**不是**被遗忘的死代码：审计一度把它归入「标了废弃却跨 8 个版本没处理」，这个判断是错的——它是**有意保留的兼容层**。 |
| 它现在做什么 | 内部只做一件事：调 `classifyAgentCommand(command, workspace)`（风险分级 `safe \| unknown \| destructive`），再套上历史判决 `{ decision: 'deny' }`。**`deny` 是它唯一的判决**——它从不返回 allow，因为「允许」在历史 API 里用 `undefined` 表达。 |
| 谁在用（删了会红哪条） | ① `scripts/check-docs.mjs:181` —— 文档门禁断言 README 提到 `scanAgentCommand(`；② `test/v81-guardrails.test.mjs` —— 多处直接调用并断言 `decision`（含 `Remove-Item -Recurse C:\` 必须是 `deny`）；③ `test/v103-seam-inventory.test.mjs` —— 把它钉成 **REFERENCED_NOT_A_SEAM**，专门防止有人把它当 seam 折叠或删除。 |
| 为什么不删 | 删它 = **改变行为**，不是清理：① 上面两个测试会红；② 文档门禁会红；③ 任何仍在 import 它的外部调用方会从「拿到 deny」变成「拿到 undefined」——在一个安全护栏上，这个方向的错误是 fail-open。冻结期不做行为变更。 |
| 新代码该用什么 | `classifyAgentCommand` + `policyDecision(risk, mode)`。两者职责分离：前者只给风险等级，**不给裁决**；后者是唯一做决定的地方（见 README 的风险/策略分离小节）。 |
| 退出条件（可验收） | ① `scripts/check-docs.mjs` 的断言改指 `classifyAgentCommand`；② `v81-guardrails.test.mjs` 全部改用 `classifyAgentCommand` + `policyDecision` 并断言等价判决；③ README 不再把 `scanAgentCommand` 当公开用法介绍；④ 全仓 `grep scanAgentCommand` 为 0（除 ARCHITECTURE 本条记录）；⑤ 全量测试数**不变**且全绿——证明迁移没有顺手丢掉任何一条护栏。 |

## TD-10 焦点转移只存在于 observer；graft 侧需要可选入口（P2，2026-11-09 登记）

| 项 | 内容 |
|---|---|
| 现状 | **焦点转移只在 `dsh-observer` 里实现。** 实测 `openSession` 出现次数：observer `client.js` **8** 次（`:68-94` 有完整的 openSession + 跳转）、memory **0** 次、graft **0** 次。当 observer 未安装（它是可选插件）时，**graft 切片完成后没有任何东西把界面跳过去**。 |
| 为什么这不是「直接补一个跳转」 | **自动切片不跳转是正确的设计**：水位触发的切片是后台行为，多会话并发切片时自动跳转会打断用户正在做的工作。所以修复方向是**可选入口**，不是恢复默认跳转。 |
| 已做（本轮） | `GraftConfig` 新增 `focusAfterGraft?: 'never' \| 'always' \| 'manual-only'`，**默认 `'never'`（与现状一致，不改行为）**。`'always'` / `'manual-only'` **被接受并记录，但尚未接线** —— 配置项与文档都明确标注这一点，**不发布一个不生效却不标注的开关**。 |
| 若要实现的正确形态 | ① observer 孵化（用户点击触发）→ **默认跳转**（保留现状）；② graft 自动切片（水位触发）→ **默认不跳**，面板给「→ 跳到新会话」按钮；③ graft 手动切片（模型主动调用）→ `focusAfterGraft: 'always'` 时跳转；④ 多会话场景 → 面板显示「刚才 N 个会话完成切片」的列表，**而不是跳到某一个**。 |
| 退出条件（可验收） | ① `'never'` 下行为与今天完全一致（测试数字不变）；② `'manual-only'` 只在工具主动调用路径跳转，自动路径不跳；③ `'always'` 覆盖两种路径；④ 多会话完成时**不**产生跳转，而是列出条目；⑤ 用测试固定「自动路径永不抢焦点」这一条——它是这个功能存在的理由。 |

## TD-11 `graft_prepare` 没有内容入参：交接内容 100% 自动提取（P1，2026-11-09 登记）

| 项 | 内容 |
|---|---|
| 现状 | `graft_prepare` 的参数**只有三个**：`sourceSessionId` / `targetSessionId` / `allowReslice`，且 `additionalProperties: false`（`src/index.ts:12667-12689` 实测）。**没有第四个参数可以承载内容。** |
| 交接内容的来源 | `prepareSlice` 的 `review` 全部来自自动提取：`pending-state` 来自 `buildPendingState`，后者读 `extractTaskState` 的 `openTodos`，后者读 **`todo_write` 事件**。 |
| 后果（机制，不是猜测） | 模型想交接时，**它能表达的唯一方式是触发自动提取**；而自动提取读的是**它上一轮写的 TODO** —— 那正是它此刻想覆盖的东西。于是：**轮次中途的「我想交接什么」无法表达；未更新 TODO 时，交接单反映的是上一轮状态。** |
| 建议修法 | 新增**可选** `handover?: { goal?, pending?, constraints?, notes? }`：提供则**覆盖**对应字段；`review` 里标注「本段由模型提供」；**`digest` 必须把 `handover` 计入** —— 否则「用户审阅的是这一版」这条保证失效（digest 是审阅对象的指纹）。 |
| 与 G5 的关系 | G5 要搬的 `buildPendingState` / `renderTaskBoard` **正是这套自动提取的实现**。所以在 TD-11 的方案定下来之前，**G5 只搬 `extractTaskState` / `checkTaskBoundary` / `checkSafeHarbor` 三件套**，不搬 `buildPendingState` / `renderTaskBoard` —— 避免搬完就改。 |
| 退出条件（可验收） | ① 模型提供 `handover` 时，`review` 与 `digest` **都**反映它；② 不提供时行为不变（现状 **598 条测试**全绿）；③ digest 变化必须能被「用户确认过的 digest」检查捕获（提供与不提供是两份不同的 digest）。 |

## 本次发版（v0.22）**不做**的事

- 不搬迁 `index.ts` 的任何大段代码（TD-1 / TD-2 / TD-6）。
- 不改阈值常量的数值与所属层（TD-3）。
- 不实现技能合并的落盘（TD-4）。
- 不删除 `scanAgentCommand`（TD-9：删它是行为变更，退出条件见上）。

以上各项均已登记且有退出条件；发版后按「一次一个模块 + 全量测试 + 真机切片」的节奏推进。
