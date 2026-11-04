# ARCHITECTURE — v0.22 技术债与重构登记

> 本文件登记**已知的结构性债务**，不是待办清单的替代品。每条都写清：现状、为什么现在不动、以及可验收的退出条件。
> 规则：**发版前不做大规模代码搬迁**——一次搬迁换来的回归，会把已经验证过的容灾能力重新变成未验证。

## 登记项

### TD-1 `dsh-graft-slice/src/index.ts` 单文件过大（P2，非阻塞）

| 项 | 内容 |
|---|---|
| 现状 | `src/index.ts` 约 13,750 行 / 约 620 KB；`index.js` 约 600 KB。含 90+ 导出、约 60 个内部模块级函数，覆盖：日志切片、磁带构建、注入计划、点火、台账、锁、控制台命令、调试面板、工具注册 |
| 影响 | 单文件让「改 A 碰坏 B」的排查成本变高；diff review 困难；IDE 索引与增量构建变慢；新人无法按职责分层阅读 |
| 为什么现在不动 | v0.21 刚完成 P0 容灾（点火失败 un-retire 回滚）与 P1 治理（身份元数据 / 记忆库治理），行为面刚被 399 条测试锁定。此刻搬迁会把「已验证」变回「未验证」，且回滚路径本身是新代码，风险叠加 |
| 退出条件（可验收） | ① 按职责拆成 `session-slice.ts` / `tape.ts` / `injection.ts` / `ignition.ts` / `ledger.ts` / `guards.ts` / `console.ts` / `tools.ts` 等模块，每个 ≤ 800 行；② `index.ts` 只保留 `apply()` 装配与再导出，≤ 300 行；③ **拆前后测试数不变、全绿**；④ `scripts/build.mjs` 的产物字节差异仅来自模块边界（banner 与 import 语句）；⑤ 每个模块导出面的 `grep` 参考计数与拆前一致（防止顺手删了导出） |
| 建议节奏 | 一次只搬一个模块，搬完立刻跑全量 + 真机切片一次；不与其他行为改动混在同一次提交 |

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

### TD-6 `index.ts` 里的「未导出但被测试间接依赖」的领域逻辑（P2，v0.22 新增）

| 项 | 内容 |
|---|---|
| 现状 | v0.22 的点火路由隔离、撤稿竞态、原子写都改在 `index.ts` 内。`alreadyIgnited` 按 `targetId` 独立存储、`.retired.json` 的 un-retire 回滚，只能通过 `apply()` 装配后的工具面（`graft_slice_and_inject`）驱动，无法单独 import 单测。测试必须走 `fake-harness.mjs` 搭出整个宿主 |
| 影响 | 单测成本高、失败定位慢；一个纯函数（如「哪些 target 需要点火」）被迫用集成测试覆盖 |
| 为什么现在不动 | 拆这些函数会动到 `apply()` 的装配顺序，而点火/回滚路径刚刚才被 410 条测试锁住。**发版前不做搬迁** |
| 退出条件 | 把 `igniteTargetSession` / `alreadyIgnited` / `unretireSource` 抽到 `ignition.ts`，作为**纯函数 + 注入式副作用**导出；`index.ts` 只做装配；测试可直接 import 单个函数，现有集成测试保持不变且全绿 |

---

## 本次发版（v0.22）**不做**的事

- 不搬迁 `index.ts` 的任何大段代码（TD-1 / TD-2 / TD-6）。
- 不改阈值常量的数值与所属层（TD-3）。
- 不实现技能合并的落盘（TD-4）。

以上各项均已登记且有退出条件；发版后按「一次一个模块 + 全量测试 + 真机切片」的节奏推进。
