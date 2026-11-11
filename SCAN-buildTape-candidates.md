# buildTape 内部候选子块清单（阶段 3 · 扫描，未改任何 src/ 代码）

> 用途：`buildTape`（48 / 1,750 行，超上限 2.19×）是**容器**，内部无可剥的独立叶子。下一阶段要做的
> 是从内部切出**闭包闭合的子块**。本文件只提供测量，**不选切割对象**——按裁定，由你按第 6 项重排。
>
> 数据来源：`scripts/closure.mjs --block`（子块闭包）+ `_scratch/scan-candidates.mjs`（AST 分析）。
> 全程只读。

## 一、结构概览

`buildTape` 跨 **L3714..L4209**（496 行），函数体直接语句 **34 条**。语句边界与行范围见
`_scratch/scan-buildtape.mjs` 的输出。三个最大的语句：

| 语句 | 行范围 | 行数 | 形态 |
|---|---|---|---|
| #6 | L3764..L3900 | **137** | `for (const event of sliced)` —— 事件扫描主循环 |
| #11 | L3931..L3976 | 46 | `for (const draft of ordered)` —— 草稿转 tapeTurns |
| #31 | L4154..L4193 | 40 | `renderInstructionCard({...})` |

## 二、候选子块（六项 + mutable）

排序按你给的规则（mutable: none → 本地声明升序 → **值类 outside 升序** → 行数升序），
但**未最终定序**——第 6 项由你重排。

| 候选 | 行范围 | 行数 | 本地声明 | OUTSIDE 值 | OUTSIDE 类型 | mutable(let) |
|---|---|---|---|---|---|---|
| **openTurn instruction if** | L4124..L4132 | 9 | **0** | **0** | **0** | none |
| **call-collapse loop** | L3904..L3926 | 23 | **0** | **0** | **0** | none |
| todoFreshness IIFE | L3992..L4015 | 24 | 1 | **0** | 0 | none |
| sourceMark block | L4148..L4153 | 6 | 2 | **0** | 0 | none |
| pendingStateText | L4194..L4196 | 3 | 1 | **0** | 0 | none |
| openCall scan | L3985..L3990 | 6 | 0 | 1 (`name`) | 0 | none |
| artifact scan loop | L4073..L4085 | 13 | 0 | 1 (`name`) | 0 | none |
| artifact scan + note | L4073..L4089 | 17 | 1 | 1 (`name`) | 0 | none |
| before openCall (#15–16) | L3985..L4015 | 31 | 1 | 1 (`name`) | 0 | none |
| openTurn board block | L4108..L4118 | 11 | 2 | 1 (`extractOpenTurnCarryover`) | 0 | none |
| semantic extraction | L4119..L4119 | 1 | 1 | 1 (`extractSemanticState`) | 0 | none |
| semantic + if + sourceMark | L4119..L4153 | 35 | 3 | 1 (`extractSemanticState`) | 0 | none |
| openTurn + sourceMark | L4108..L4153 | 46 | 4 | 1 (`extractOpenTurnCarryover`) | 0 | none |
| instruction card | L4154..L4193 | 40 | 1 | 1 (`verifyWorkspace`) | 0 | none |
| pendingBody call | L4017..L4039 | 23 | 1 | 2 (`extractLastStepScene`, `slimScene`) | 0 | none |
| **event-scan loop** | L3764..L3900 | **137** | 0 | **3** (`extractAttachmentPointers`, `isGraftAuthored`, `normalizeText`) | 0 | none |
| draft→tapeTurns loop | L3931..L3976 | 46 | 0 | **4** (`normalizeText`, `pointerizeCodeBlocks`, `renderPointerLines`, `renderReplayTurn`) | 0 | none |

## 二之二、一处必须记的自我纠正（遮蔽）

第一版扫描把「函数内部任意位置声明的名字」都当作局部，于是 `openCall scan`（L3985..L3990）报了 **0 个**
outside。但 `closure.mjs --block` 报 **1 个：`name [const]`** —— 因为那一段里有
`const name = typeof event.data?.name === 'string' ? event.data.name : ''`，
**在文本上遮蔽了模块级的 `export const name = 'dsh-graft-slice'`**。

**工具是对的，我的脚本错了**：切割后那段代码里出现的是标识符 `name`，读代码的人不看声明就分不清指哪一个。
`artifact scan loop`（L4073..L4085）与 `artifact scan + note`（L4073..L4089）同样受影响，已一并订正。

这一处与「仪器测的不是你以为的东西」同族，但方向相反：**这次错的是我的分析脚本**，不是被测工具。

### 交叉核对（订正后，工具与脚本一致）

```
node scripts/closure.mjs --block src/index.ts 3904 3926
  → local 0 / OUTSIDE 0 / mutable none       # 与脚本一致
node scripts/closure.mjs --block src/index.ts 3985 3990
  → local 0 / OUTSIDE 1 (name [const])       # 与订正后的脚本一致
```

## 三、第 6 项的观察（这一列改变了排序）

**所有候选的 OUTSIDE 类型数都是 0**。也就是说：在 `buildTape` 内部，**没有一个是靠「只依赖类型」而便宜的**——
每个代价都是**值类**（函数/常量），那些会真的进产物、真的要接 import。

唯一的类型类出现在**语句级**（不在语义候选里）：`CallRecord` / `TurnDraft` / `GraftTapeTurn` 三个 interface
被单条语句引用。但它们的行数都是 1，作为切割对象太小。

**推论**：第 6 项在这里**没有区分度**——排序实际由「值类 outside 数」与「行数」决定。这与你的预期
（类型类会被抹掉、所以便宜）方向一致，只是这座容器里可用的「类型便宜」机会**一条都没有**。

## 四、两类候选的差别（不是数字，是语义）

**A 类：`outside` 为 0 的完整语义单元**（可直接搬，搬完 `index.ts` 少一段、新模块零 import 或只 import 类型）：

| 候选 | 行数 | 说明 |
|---|---|---|
| `call-collapse loop` | 23 | L3904..L3926，独立遍历 `calls`，只碰函数内局部变量 |
| `openCall scan` | 6 | L3985..L3990，短循环 |
| `artifact scan loop` | 13 | L4073..L4085，遍历 `sliced` 收集 `writtenArtifacts` |
| `openTurn instruction if` | 9 | L4124..L4132，单分支 |
| `todoFreshness IIFE` | 24 | L3992..L4015，自包含 IIFE |

**B 类：`outside` 有值依赖**（要接 import，且这些依赖本身可能又是别的容器的成员）：

| 候选 | 行数 | 值依赖 |
|---|---|---|
| `event-scan loop` | **137** | 3 个（`extractAttachmentPointers` / `isGraftAuthored` / `normalizeText`） |
| `draft→tapeTurns loop` | 46 | 4 个 |
| `pendingBody call` | 23 | 2 个 |
| `instruction card` | 40 | 1 个（`verifyWorkspace`） |

**`event-scan loop` 是最大的单块（137 行）**，但它是 B 类；`call-collapse loop`（23 行）是 A 类里最大的。

## 五、我没有替你做的事

- **没有选切割对象**（按裁定，等你排）。
- **没有改任何 `src/` 代码**。
- **没有计算传递闭包**：`outside` 里那些函数（如 `normalizeText`）自己还有没有依赖，本清单**未展开**。
  子块闭包工具不计算传递集合（限制已写在 `scripts/closure.mjs` 的注释里）；候选确定后应再用
  `closure.mjs <symbol>` 逐个查它们的闭包规模。
- **没有验证「搬走后 `index.ts` 能否编译」**：那要在真正切割时才知道。

## 六、数据来源（可复跑）

```bash
node scripts/closure.mjs buildTape                      # 整函数：48 声明 / 1,750 行
node scripts/closure.mjs --block src/index.ts 3904 3926 # 任一候选的行范围
node ../_scratch/scan-buildtape.mjs                     # 34 条语句边界
node ../_scratch/scan-windows.mjs                       # 59 个 clean 连续窗口
node ../_scratch/scan-candidates.mjs                    # 本表
```
