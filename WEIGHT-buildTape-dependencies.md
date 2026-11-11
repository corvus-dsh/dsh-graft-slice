# buildTape 依赖体重图（阶段 3 · 只读测量，未改任何 src/）

> 目的：回答一个前置问题 —— **`buildTape` 是「一个胖函数」，还是「一个薄函数依赖了一大堆东西」？**
> 答案决定下一步走哪条路。在此之前切任何子块都是无地图动刀（这是用户对上一份清单的裁定）。

## 一、结论先行

**它是「薄函数 + 重依赖」。**

| 量 | 值 |
|---|---|
| 函数体 | **496 行**（L3714..L4209） |
| 闭包（合并重叠后） | **1,750 行** |
| **外部依赖重量** | **1,254 行**（闭包 − 函数体 = 71.7%） |
| 外部声明数 | **47** 个 |

**72% 的体积不在 `buildTape` 里。** 所以上一份「候选子块清单」在解一个不存在的问题：
把 9 行切出去，闭包从 1,750 变成 1,741，**依然 > 800**，依然不是搬运节点。

## 二、47 个外部声明，按行数排序

| # | 名字 | 行范围 | 行数 | 形态 | 自身闭包（decl / lines） |
|---|---|---|---|---|---|
| 1 | `GraftConfig` | L480..L767 | **288** | type | 1 / 288 |
| 2 | `extractGoal` | L2617..L2824 | **208** | function（独立） | 14 / **341** |
| 3 | `inheritedConstraintAnchor` | L4227..L4314 | 88 | function（独立） | 3 / 97 |
| 4 | `extractLastStepScene` | L3290..L3365 | 76 | function（独立） | 4 / 86 |
| 5 | `extractOpenTurnCarryover` | L2271..L2343 | 73 | function（独立） | 4 / 98 |
| 6 | `extractSemanticState` | L3427..L3488 | 62 | function（独立） | 3 / 111 |
| 7 | `verifyWorkspace` | L3533..L3591 | 59 | function（独立） | 1 / 59 |
| 8 | `outcomeOfResult` | L3375..L3417 | 43 | function（独立） | 2 / 49 |
| 9 | `GoalResult` | L2490..L2522 | 33 | type | 6 / 73 |
| 10 | `pointerizeCodeBlocks` | L2443..L2472 | 30 | function（独立） | 7 / 58 |
| 11 | `attachmentPointer` | L4327..L4347 | 21 | function（独立） | 3 / 23 |
| 12 | `renderReplayTurn` | L3684..L3704 | 21 | function（独立） | 1 / 21 |
| 13 | `currentDagNode` | L2597..L2615 | 19 | function（独立） | 1 / 19 |
| 14 | `renderPointerLines` | L3005..L3023 | 19 | function（独立） | 2 / 29 |
| 15 | `objectiveOf` | L2569..L2584 | 16 | function（独立） | 1 / 16 |
| 16 | `extractSourceTemplate` | L2353..L2367 | 15 | function（独立） | 2 / 20 |
| 17 | `GraftTape` | L859..L872 | 14 | type | 4 / 39 |
| 18 | `GraftTapeTurn` | L835..L848 | 14 | type | 1 / 14 |
| 19 | `CallRecord` | L2373..L2384 | 12 | type | 1 / 12 |
| 20 | `extractAttachmentPointers` | L4350..L4360 | 11 | function（独立） | 4 / 34 |
| 21 | `firstLines` | L2419..L2429 | 11 | function（独立） | 1 / 11 |
| 22 | `PointerItem` | L2250..L2259 | 10 | type | 1 / 10 |
| 23 | `OpenTurnCarryover` | L2261..L2269 | 9 | type | 2 / 19 |
| 24 | `nearDuplicate` | L1288..L1295 | 8 | function（独立） | 3 / 13 |
| 25 | `pathFromToolArguments` | L2857..L2864 | 8 | function（独立） | 1 / 8 |
| 26 | `CodeBlockPointer` | L2399..L2405 | 7 | type | 1 / 7 |
| 27 | `lineCount` | L2411..L2417 | 7 | function（独立） | 1 / 7 |
| 28 | `noteForcedCut` | L6157..L6163 | 7 | function（独立） | 1 / 7 |
| 29 | `AssistantRecord` | L2386..L2391 | 6 | type | 1 / 6 |
| 30 | `GraftBoundary` | L851..L856 | 6 | type | 1 / 6 |
| 31 | `TEST_PASS_PATTERNS` | L3368..L3373 | 6 | const | 1 / 6 |
| 32 | `TurnDraft` | L2483..L2488 | 6 | type | 2 / 12 |
| 33 | `isGraftAuthored` | L807..L812 | 6 | function（独立） | 1 / 6 |
| 34 | `normalizeText` | L1211..L1216 | 6 | function（独立） | 1 / 6 |
| 35 | `slimScene` | L3496..L3501 | 6 | function（独立） | 1 / 6 |
| 36 | `GraftSource` | L770..L774 | 5 | type | 1 / 5 |
| 37 | `graftGenerationOf` | L8706..L8708 | 3 | function（独立） | 1 / 3 |
| 38 | `isHumanAuthored` | L823..L825 | 3 | function（独立） | 1 / 3 |
| 39 | `normalizedEqual` | L1297..L1299 | 3 | function（独立） | 1 / 3 |
| 40 | `tokenSet` | L1285..L1286 | 2 | function（独立） | 1 / 2 |
| 41 | `ATTACHMENT_KINDS` | L4325 | 1 | const | 1 / 1 |
| 42 | `CODEBLOCK_MAX_CHARS` | L2408 | 1 | const | 1 / 1 |
| 43 | `CODEBLOCK_MAX_LINES` | L2407 | 1 | const | 1 / 1 |
| 44 | `CODEBLOCK_PREVIEW_LINES` | L2409 | 1 | const | 1 / 1 |
| 45 | `GoalLayer` | L2560 | 1 | type | 1 / 1 |
| 46 | `WRITE_TOOL_NAMES` | L2855 | 1 | const | 1 / 1 |
| 47 | `name` | L414 | 1 | const | 1 / 1 |

## 三、分类汇总

| 类 | 个数 | 合计行数 | 备注 |
|---|---|---|---|
| **独立函数** | **27** | **831** | 其中 **22 个**自身闭包 ≤ 自身行数 + 10（依赖很浅）；**5 个**深依赖，见下 |
| **类型** | 13 | 411 | `stripTypeScriptTypes` 会抹掉，**产物零成本** |
| **值常量** | 7 | 12 | 都是 1 行或 6 行 |
| 外部合计 | 47 | 1,254 | |

**5 个深依赖**（自身闭包比自身多出 10 行以上，搬它们等于搬一个小簇）：

| 名字 | 自身 | 自身闭包 | 多出 | 声明数 |
|---|---|---|---|---|
| `extractGoal` | 208 | 341 | **+133** | 14 |
| `extractSemanticState` | 62 | 111 | +49 | 3 |
| `pointerizeCodeBlocks` | 30 | 58 | +28 | 7 |
| `extractOpenTurnCarryover` | 73 | 98 | +25 | 4 |
| `extractAttachmentPointers` | 11 | 34 | +23 | 4 |

**最重的 8 个**：

| 名字 | 自身行数 | 自身闭包 | 观察 |
|---|---|---|---|
| `GraftConfig` | 288 | 288（1 声明） | 纯类型，**产物零成本**，但占 288 行「闭包行数」 |
| `extractGoal` | 208 | **341**（14 声明） | 自身就是一个小容器，依赖 14 个声明 |
| `inheritedConstraintAnchor` | 88 | 97（3 声明） | 依赖浅 |
| `extractLastStepScene` | 76 | 86（4 声明） | 依赖浅 |
| `extractOpenTurnCarryover` | 73 | 98（4 声明） | **深 +25** |
| `extractSemanticState` | 62 | 111（3 声明） | **深 +49** |
| `verifyWorkspace` | 59 | 59（1 声明） | **完全自足** |
| `outcomeOfResult` | 43 | 49（2 声明） | 依赖浅 |

## 四、这张图说明了什么

1. **`buildTape` 不是胖函数**。它自己只有 496 行，且内部候选都是 3–24 行的小块（上一份清单）。
2. **它是一张「装配图」**：47 个依赖里 27 个是独立函数、13 个是纯类型。其中 22 个依赖很浅
   （自身闭包 ≤ 自身行数 + 10），**5 个是深依赖**（见第三节），最深的是 `extractGoal`（+133 行）。
3. **`GraftConfig`（288 行、纯类型）单独占了闭包的 16%**，而它是**零产物成本**的。
   这意味着 1,750 这个数字里，**411 行是类型（零成本）**，真正的值依赖是 831（函数）+ 12（常量）= **843 行**。
4. **所以「超过 800」这件事，在有类型剥离的前提下，本身就该被重新审视**（见第五节）。


## 四点五、47 个依赖结成 12 个簇 —— 每个簇是一个不可再分的搬运单位

上一节按「单个声明」排序，但**搬运单位不是单个声明，是连通分量**：若 A 的闭包含 B，A 与 B 必须一起走，
否则搬完还得 import 回来（等于没搬）。用「每个成员的闭包」建图、求连通分量，得：

| # | 行数 | 成员数 | 值类 | 类型类 | 成员 |
|---|---|---|---|---|---|
| 1 | **558** | 21 | 466 | 92 | `extractGoal` 那一家（含 `GoalResult` / `GraftTape` / `nearDuplicate` 等） |
| 2 | **288** | 1 | 0 | **288** | `GraftConfig`（纯类型，独占 16% 闭包） |
| 3 | 119 | 7 | 119 | 0 | `extractAttachmentPointers` / `extractLastStepScene` 那一家 |
| 4 | 111 | 3 | 111 | 0 | `extractSemanticState` / `outcomeOfResult` / `TEST_PASS_PATTERNS` |
| 5 | 59 | 1 | 59 | 0 | `verifyWorkspace`（完全自足） |
| 6 | 58 | 7 | 51 | 7 | `pointerizeCodeBlocks` 那一家 |
| 7 | 21 | 1 | 21 | 0 | `renderReplayTurn` |
| 8 | 12 | 2 | 0 | 12 | `AssistantRecord` + `TurnDraft` |
| 9 | 12 | 1 | 0 | 12 | `CallRecord` |
| 10 | 7 | 1 | 7 | 0 | `noteForcedCut` |
| 11 | 6 | 1 | 6 | 0 | `slimScene` |
| 12 | 3 | 1 | 3 | 0 | `graftGenerationOf` |
| | **1,254** | **47** | 843 | 411 | 合计与外部总量吻合 |

**闭合性已验**：12/12 全部闭合——没有任何一个成员的闭包越出自己那个簇。
**没有簇超过 800 行**（最大 558），所以**每一个簇本身都合规**，问题只在 `buildTape` 的角度上。

## 四点五点五、⚠️ 决定性算术：要 shed 950 行，不是「搬一个就够」

**这是上一版漏掉的算术，也是「按簇搬」方案的真实成本。**

`buildTape` 要合规，必须： `1,750 − shed ≤ 800` → **`shed ≥ 950 行`**。
也就是外部依赖必须从 **1,254 行降到 ≤ 304 行**。

| 搬到第几个簇 | 累计 shed | 闭包剩 | 判定 |
|---|---|---|---|
| 1（簇1，558） | 558 | 1,192 | 仍超 **392** |
| 2（+簇2，288） | 846 | **904** | 仍超 **104** |
| 3（+簇3，119） | **965** | **785** | ✅ **首次 ≤ 800** |
| 12（全部） | 1,254 | 496 | = 函数体本身 |

**所以「搬一个簇让闭包下降」≠「让 buildTape 合规」。**
至少要 **3 个簇、965 行**。这与上一轮「切 9 行子块」是**同一个形状：方向对、量不够**。

### 穷举 12 个簇的全部 4,095 种组合（达到 shed ≥ 950 的方案 867 个）

- **最少需要 3 个簇**；不存在「两个簇就够」的方案（最大两簇 558+288=846 < 950）。
- 3 个簇里**最省的两组**：
  - 簇1 + 簇2 + **簇4** = 558 + 288 + 111 = **957** → 闭包 **793**（比下面那组少 shed 8 行）
  - 簇1 + 簇2 + **簇3** = 558 + 288 + 119 = **965** → 闭包 **785** ← 用户指定顺序

> 结论：**「先搬哪个」的顺序问题，本质上被「至少要搬 3 个」这个量级吃掉了** ——
> 无论怎么排，buildTape 都必须至少搬掉 3 个簇才第一次合规。
> 这也意味着**不存在「只搬一个簇就收工」的中间态**；中间态一律仍超限。

## 四点六、关键实验：搬出去，闭包真的会掉

这条推断了很久，必须实测。做法：把 `renderReplayTurn`（21 行，自足）搬进临时新模块、
`index.ts` 改为 re-export，量 `buildTape` 闭包，再逐字节还原。

```
baseline buildTape: 48 声明 / 1750 行
after    buildTape: 47 声明 / 1729 行
delta: -1 声明 / -21 行              ← 正好等于被搬走的声明行数
restored byte-identical: true
restored buildTape: 48 / 1750
```

**为什么掉**：`closure.mjs` 的闭包**不跟随 import**（L252：`if (declaration === undefined) continue // an import`），
而且只在**种子所在文件内**追踪（L245 `local = perFile.get(seedFile)`）。所以符号搬出 `index.ts` 后，
`buildTape` 里对它的引用变成 import，不再计入闭包。

**这条同时是一个警告**：如果哪天有人把「闭包变小」当成「复杂度下降」的证据，那是自欺——
**闭包衡量的是「同一文件内的耦合」，搬走它就是把它移到 import 边界之外，复杂度没有消失，只是换了记账位置。**
本阶段所有搬出（N1–N7、P0–P5）都建立在这条口径上，口径本身没错（它回答的是「这个文件还能不能读懂」），
但**不能被读成「系统变简单了」**。

## 四点七、两个容器的关系：依赖是子集，簇是同一个

| 量 | `buildTape` | `buildInjectionPlan` |
|---|---|---|
| 声明 / 闭包行数 | 48 / 1,750 | **108 / 3,693** |
| 函数体 | 496 | 744 |
| 外部依赖 | 47 | 107 |
| 连通分量 | 12 | 6 |
| 最大分量 | 558（21 件） | **2,615（84 件，含 `buildTape` 本体与全部 47 个依赖）** |

**`buildTape` 的 47 个外部依赖是 `buildInjectionPlan` 107 个的真子集**（共享 47/47，无一独立）。
而且两者同属 `buildInjectionPlan` 的最大那个 84 件簇。

**推论**：搬 `buildTape` 的 12 个簇，会**同时**从 `buildInjectionPlan` 的闭包里退出 1,254 行
（3,693 → 2,439）。但 `buildInjectionPlan` 自己的 60 个独有依赖里还有一个 37 件 / 1,361 行的簇，
所以**它搬完 buildTape 这一半仍超 800**，需要单独处理。

> **⚠️ 订正：`buildInjectionPlan` 实测是 108 / 3,693，不是文档一直写的 110 / 3,705。**
> 逐提交测量结果：N6 `a772dbd` = 129/3,934 → **N7 `9e2f33e` = 110/3,705** →
> **P0 `fd5b6e1` = 108/3,693**（P0 把 7 个结构性会话类型搬进 `core/gateway-types.ts`，从它的闭包里退出 2 声明 / 12 行）
> → P4 / P5 / HEAD 均为 108/3,693。
> **110/3,705 是 N7 时的快照，P0 之后一直没同步**，出现在 7 处（ARCHITECTURE 2 处、本报告 3 处、closure.mjs 与 v135 注释各 1 处）。

## 五、度量口径待裁定（用户要求记入，不自行改判据）

> **800 上限的原文是「闭包行数 > 800 不得作为搬运节点」**，而 **TD-1 的原意是「每个模块 ≤ 800 行」**。
>
> 这两个是**不同的度量**：
> - 「模块大小」= 一个文件有多少行 → 决定**可读性 / review 成本**；
> - 「依赖总和（闭包）」= 搬走它要一起带走多少 → 决定**搬运难度**。
>
> 当年把前者当后者是**权宜**。对 `buildTape` 而言，这两个数差了 **3.5 倍**（496 vs 1,750），
> 而且 1,750 里还有 411 行是**产物零成本**的类型。
>
### 用户 2026-11-11 给出的裁定建议（**登记，未采用**）

把 800 拆成两个判据：

| 判据 | 内容 | 用途 |
|---|---|---|
| **(a) 搬迁门槛** | **模块大小**（函数体 / 声明行数）≤ 800 | 这是 TD-1 原意 —— 决定「能不能搬」 |
| **(b) 依赖总和** | **只报告、不设限** | 闭包大 = review 成本，**不等于「不可搬」** |

**防滥用约束**（用户要求一并登记）：用「模块大小」判据搬出的目标，**必须在同一提交**用
`verify-pure-move`（纯位移）或「按簇整体搬」**证明没有引入新依赖**。

> ⚠️ **这条建议有一个已实测的漏洞，必须先补上才可用**：`verify-pure-move` **看不见新增的 import**。
>
> 实测（2026-11-11）：往 `src/core/adaptive-depth.ts` 顶部注入
> `import { ledgerRecord } from './ledger.js'`，`verify-pure-move` 仍然打印 **IDENTICAL**。
> 原因在它的定义里：CONTENT LINE **排除**任何以 `import ` / `export ` 开头的行
> （因为纯搬运必然产生这些行）—— 而「引入新依赖」这件事**恰好只出现在这些行上**。
>
> **已补**：新增 `scripts/verify-import-edges.mjs`（比较两个 revision 的 import 边集合，
> 报告每一条出现/消失的边），配 `test/v136-import-edges.test.mjs`（5 条，**can-red 5/5 已验**）。
> 同一注入实验下：`verify-pure-move` = IDENTICAL（看不见），`verify-import-edges` = **ADDED (1)**。
> 所以「没有引入新依赖」这句话，**现在有工具能证明；在此之前没有**。

> **本条只登记，不改判据 —— 等用户裁定。在裁定之前，一切仍按现行口径（闭包 > 800 = 容器）执行。**

## 五点五、两条工具事实（都与「按簇搬」的验收方式直接相关）

### ① `verify-pure-move` 看不见新增依赖 —— 已补 `verify-import-edges`

防滥用约束要求「搬出的目标必须在同一提交证明没有引入新依赖」。**这句话原本无法被证明。**

`verify-pure-move` 的 CONTENT LINE 定义**排除**任何以 `import ` / `export ` 开头的行
（因为纯搬运必然产生这些行）。而「引入新依赖」这件事**恰好只出现在这些行上**。

实测（2026-11-11）：往 `src/core/adaptive-depth.ts` 顶部注入
`import { ledgerRecord } from './ledger.js'`：

```
verify-pure-move   : IDENTICAL（看不见）
verify-import-edges: ADDED (1)   + core/adaptive-depth.ts -> ./ledger [ledgerRecord]
还原后两者 : 都回到干净（逐字节）
```

**已补**：`scripts/verify-import-edges.mjs`（import 边集合对比）+ `test/v136`（5 条，can-red 5/5）。

### ② 「17 = pending 2 + resource 15」曾无法逐条验证 —— 已让 gate 打印证据

这条直接对应用户此前的判断：**「总数对 ≠ 每类都对」**。

查清的事实：
- `check-readme-tally.mjs` **确实**在子进程里用 `--test-reporter=tap` 跑套件，**逐条分类**；
- 但它只把结果汇总成一行 `measured: ... (pending=2 resource=15)`，
  **逐条分类从不离开那个进程**。所以读 CI 日志的人只能验证加法，不能验证分类。
- run #97 的日志里能看到 TAP 行，是因为当次 **v135 失败**，失败详情顺带打印了 `not ok` 行 ——
  **那是运气，不是机制**。

**已补**：gate 现在逐条打印 `[verdict] test name` + 原因，并且自检
「由这些行推出的总数 == 打印的总数」，不等则退出码 1。`test/v137`（5 条，can-red 5/5）钉住它。

**补上之后的第一次 CI 运行（`02febd5`，job 130395896865）就在日志里给出了逐条证据**：

```
skip evidence: 17 classified line(s)
   1. [resource] every sample can be found in the real corpus …
      corpus absent at …/_scratch/real-texts.json — provenance unverified in this checkout (not a pass)
   2. [resource] every real-misfire can be found in the real corpus too
      corpus absent at … — misfire provenance unverified in this checkout (not a pass)
   3. [resource] graft TODO_TOOL_NAME and observer TODO_TOOL are character-for-character
      observer source absent at …/dsh-observer/src/core/monitor.ts — parity unverified in this checkout
   4. [resource] the observer copy still carries the same intent note (a warning, not a gate)
      observer source absent — intent note unverified
   5. [resource] the 35 constraints from the seven clean generations are ALL accepted
      ledger absent at …/.graft-constraint-sections.json — reverse validation not run in this checkout
   6. [pending]  D2 control: a recursive delete is still destructive wherever it points
      TD-17 ruled to KEEP this behaviour: recursive delete inside the workspace stays ALLOWED
   7. [pending]  C1: a pasted REPORT is not presented as the requirement
      pending a ruling on goal semantics (用户要什么 vs 用户最后说了什么)
   8. [resource] FULL CORPUS (local only): runs when present, and says so when it is not
      CORPUS-CHECK SKIPPED (RESOURCE_MISSING): full corpus not present; the committed sample above still ran
   9..17. [resource] × 9  closure / v135 五条 + 四条 closure 基础
      RESOURCE: typescript is not installed; closure.mjs exits 2 rather than guessing
totals derived from these lines: AGREE
```

**逐类核对**（`measured: tests=761 pass=744 fail=0 skipped=17 (pending=2 resource=15)`）：

| 类 | 条数 | 逐条原因 | 与 gate 一致 |
|---|---|---|---|
| **resource** | **15** | typescript 未安装 **9** / corpus 缺失 **3** / observer 源码缺失 **2** / ledger 缺失 **1** | ✅ |
| **pending** | **2** | TD-17 裁定保留 / 目标语义待裁定 | ✅ |
| 合计 | 17 | 编号 1..17 连续 | ✅ |

**现在这 15 条是可以逐条审阅的，不再是「总数恰好对上」。**

> 顺带记一个真实 bug：v137 第一版直接 spawn 了 gate 的 main，而 main 会在子进程里跑整套测试 ——
> 而整套测试包含 v137 自己，于是**递归**（实测把套件从 756 推到 760、fail 从 0 推到 4）。
> 修法是把分类抽成纯函数 `classifySkipLines`，测试只调纯函数。**「测试触发的测量污染了测量对象」
> 与本轮前面几例同族。**

## 六、数据来源（可复跑）

```bash
node ../_scratch/dependency-weight.mjs      # 本表
node ../_scratch/verify-weight.mjs          # 独立复算本表每个数字（18 项断言）
node ../_scratch/cluster-components.mjs     # 12 个连通分量（第四节五）
node ../_scratch/cluster-both.mjs           # 两个容器各几个簇（第四节七）
node ../_scratch/overlap-both.mjs           # 依赖子集关系（第四节七）
node ../_scratch/experiment-move.mjs        # 搬出实验，自动逐字节还原（第四节六）
node ../_scratch/shed-arithmetic.mjs        # 950 行算术 + 穷举 4,095 种组合（第四节五点五）
node ../_scratch/prove-edge-gap.mjs         # 证明 verify-pure-move 看不见新增依赖
node scripts/verify-import-edges.mjs        # import 边集合对比（补 pure-move 的盲区）
node scripts/check-readme-tally.mjs         # skip 逐条分类 + 证据打印（第五节五②）
node scripts/closure.mjs buildTape          # 48 声明 / 1,750 行
node scripts/closure.mjs <symbol>           # 任一依赖的自身闭包
```

**已补做的事**：47 个依赖之间的彼此引用（第四节五的连通分量）、`buildTape` 与 `buildInjectionPlan` 的依赖重叠（第四节七）、
以及「搬出去闭包是否真的下降」的实测（第四节六）。

**仍然没做的事**（如实）：
- 没有算新模块**自身的 import 成本**——搬出去的簇在新模块里仍要 import，只是不再计入 `index.ts` 的闭包数。
- 没有验证搬完能否编译、测试是否全绿；那要真正切割时才知道。
- **没有判定哪条路线最优** —— 按裁定，这是用户的决定。
