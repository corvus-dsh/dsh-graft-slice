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
> **本条只登记，不改判据 —— 等用户裁定。**

## 六、数据来源（可复跑）

```bash
node ../_scratch/dependency-weight.mjs      # 本表
node ../_scratch/verify-weight.mjs          # 独立复算本表每个数字（18 项断言）
node ../_scratch/cluster-components.mjs     # 12 个连通分量（第四节五）
node ../_scratch/cluster-both.mjs           # 两个容器各几个簇（第四节七）
node ../_scratch/overlap-both.mjs           # 依赖子集关系（第四节七）
node ../_scratch/experiment-move.mjs        # 搬出实验，自动逐字节还原（第四节六）
node scripts/closure.mjs buildTape          # 48 声明 / 1,750 行
node scripts/closure.mjs <symbol>           # 任一依赖的自身闭包
```

**已补做的事**：47 个依赖之间的彼此引用（第四节五的连通分量）、`buildTape` 与 `buildInjectionPlan` 的依赖重叠（第四节七）、
以及「搬出去闭包是否真的下降」的实测（第四节六）。

**仍然没做的事**（如实）：
- 没有算新模块**自身的 import 成本**——搬出去的簇在新模块里仍要 import，只是不再计入 `index.ts` 的闭包数。
- 没有验证搬完能否编译、测试是否全绿；那要真正切割时才知道。
- **没有判定哪条路线最优** —— 按裁定，这是用户的决定。
