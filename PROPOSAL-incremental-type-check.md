# 立项：增量类型检查（不引入「一次全红」的 CI）

> 用户 2026-11-11 裁定：**不批准**「引入 tsc 让 CI 变红」；**批准**「增量拉紧」。
> 本文件是立项说明与规格，**不实现**。实现须单独立项、单独提交。

## 一、为什么这件事不能等

本项目**从不运行 `tsc`**。构建链是：

```
src/*.ts  →  stripTypeScriptTypes()  →  内联拼接  →  index.js
```

`stripTypeScriptTypes` 只删类型语法，**不做任何符号检查**。由此：

| 现象 | 它能证明 | 它不能证明 |
|---|---|---|
| 782 条测试全绿 | **运行时行为**正确 | 类型正确 |
| `npm run build` 成功 | **无语法错** | 无类型错 |
| `verify-pure-move` IDENTICAL | 内容行未变 | 类型引用未断 |

**搬断一个类型引用，strip 不会报，测试可能也不会报。**

这不是假设。实测：`SessionEventLike` 由 `core/watermark.ts:276` 导出、被 2 个模块正常 import，
而 `index.ts` **从未 import 它却引用了 34 次** —— 测试全绿，构建成功，问题一直在。
（已于 `ce44d9b` 修复：一行 import，34 处归零。）

## 二、存量有多重（实测 196 条）

```
type-check: 196 diagnostic(s)

by code:
  2304      115  Cannot find name 'textOfMessage' / 'SessionEventLike' / 'process' …
  2307       18  Cannot find module 'node:os' …（缺 @types/node）
  2459       15  Module './host-shape.js' declares 'extractActiveGoalChange' locally…
  2580       15  Cannot find name 'process'
  2339       12  Property 'content' does not exist on type 'unknown'
  2551        4  Property 'toolPointers' does not exist on type 'AssistantRecord'
  … 另有 12 类共 17 条

by file:
  index.ts             93
  core/host-shape.ts   59
  core/txn.ts           7
  core/watermark.ts     5
  core/ignition.ts      4
  core/store-layer.ts   4
  core/gateway-types.ts 3
  core/goal-extraction.ts 3   ← 本次搬移带入，与 index.ts 同源
  core/ledger.ts        3
```

**126 条集中在 2 个文件。** 这不是「类型系统不适用」，是「存量债 + 缺 @types/node」。

## 三、为什么不能直接开 tsc 门禁

如果 CI 跑 `tsc --noEmit` 并要求 0 错：

- 第一天就是 **196 红**，且其中 18 条是**环境问题**（缺 `@types/node`），不是代码问题；
- 红成为**常态** → 被忽略 → 与「CI 永远红」无异；
- 真正的**新增**错误会淹没在存量里，反而**降低**发现率。

**「红了就会有人修」只在红是例外时成立。** 196 条常红等于 0 条有效信号。

## 四、批准的做法：增量拉紧

### 4.1 核心规则（已按实测修正）

> **只对「本次提交触及的文件」要求 0 类型错误；存量文件进显式白名单。**
> **搬移型提交豁免为「错误数不变」—— 不许变多，不要求变少。**

#### 为什么不是「新文件」

初稿写的是「新文件从第一天就类型正确」，**这条假设被实测推翻**。

搬移是**纯位移**：源文件里的类型错误会被**原样带走**。实测搬出去的模块各自带着错误：

| 模块 | 类型错误数 | 来源 |
|---|---|---|
| `core/goal-extraction.ts` | 3 | 从 index.ts 原样搬入 |
| `core/adaptive-depth.ts` | 2 | 存量 |
| `core/command-guard.ts` | 2 | 存量 |
| `core/instruction-card.ts` | 2 | 存量 |
| `core/graft-config.ts` / `core/pending-state.ts` / `core/tape-shape.ts` | 各 1 | 存量 |

所以「新文件 = 干净文件」是错的。**判据必须按「本次提交触及了哪些文件」**，
而不是按「这个文件是不是本次创建的」。

#### 搬移型提交的专用规则

纯位移的语义是「内容一份不差地换个地方」，因此**类型错误数也必须一份不差**：

> 搬移提交前后，被搬运的声明所在的**错误总数必须相等**（可以重新分布到不同文件）。

这条正是「搬移会不会带进新错误」的机器化答案：
- 若搬移后错误数**变多** → 搬移不是纯的，或新模块缺了 import，**红**；
- 若**相等** → 位置变了、错误没变，符合纯位移，**绿**；
- 若**变少** → 更好（顺带修好了），**绿**且 ceiling 收紧。

**本条的实证**：第 4 步搬移后，`goal-extraction.ts` 的 5 个声明**没有 `export`**，
而 index.ts 从它 import —— 产生 5 条 code 2459。这正是「搬移带进了新错误」，
但 **782 条测试全绿、构建成功、verify-pure-move IDENTICAL**，三道关都没拦住。
只有 type-check 能看见。

### 4.2 与既有模式保持一致

本项目已有两处同形状的先例，直接复用其结构：

| 先例 | 白名单 | 约束 |
|---|---|---|
| `test/v129-gate-coverage.test.mjs` | `EXEMPT`（closure.mjs / verify-pure-move.mjs） | 每条带理由，空清单不通过 |
| `test/v130-module-size-cap.test.mjs` | `EXEMPT`（host-shape 1047 / ignition 1069） | 每条是**上限**（ceiling），**不许增长**，缩小总是允许 |

新增 `test/v142-type-check-budget.test.mjs` 沿用同一套：
每条例外必须**点名文件 + 写明理由 + 记录当前错误数作为 ceiling**。

### 4.3 具体规格（供实现时照做）

```js
// test/v142-type-check-budget.test.mjs
const BASELINE = new Map([
  // 文件 → { ceiling, reason }  —— ceiling 是「今天的错误数」，不是目标
  ['index.ts',              { ceiling: 93, reason: '…' }],
  ['core/host-shape.ts',    { ceiling: 59, reason: '…' }],
  // …
])

// 规则 1：本次提交触及的文件（含新建与修改）必须 0 错误 —— 搬移型提交除外（见 4.1）
// 规则 2：BASELINE 里的文件，错误数 > ceiling → 红（不许增长）
// 规则 3：错误数下降时**自动收紧** ceiling（把新值写回基线，避免「缩小后又被加回去」）
// 规则 4：分母 —— 必须真的扫到 N 个文件，空扫描不算通过
// 规则 5：编译器缺失 → RESOURCE skip（与 v135/v139 同族），不是红
```

三条必须写进测试注释的理由（否则下一个人会把它关掉）：

1. **为什么不是 0**：196 条存量，一次清零等于长期红；
2. **为什么 ceiling 而不是忽略**：ceiling **不许增长**，所以新债进不来；
3. **为什么新文件要求 0**：新文件没有存量可辩，从第一天就该正确。

### 4.4 验收标准（实现时逐项证明）

| # | 必须证明 | 方法 |
|---|---|---|
| 1 | 新文件有类型错 → 红 | 造一个 `__probe.ts` 含 `Cannot find name` |
| 2 | 存量文件错误数 +1 → 红 | 在 baseline 文件里加一处引用未定义符号 |
| 3 | 存量文件错误数 −1 → 绿，且 ceiling **被收紧** | 修一处，重跑，断言基线写入新值 |
| 4 | 编译器缺失 → SKIP，不是红 | 移走 typescript 目录（同 v135/v139 的模拟 CI） |
| 5 | 分母存在 | 空扫描必须失败 |
| 6 | **搬移型提交错误数不变 → 绿；变多 → 红** | 造一次缺 export 的搬移 |

## 五、不在本立项范围内

- **不修存量 196 条**（那是还债，另一件事）；
- **不引入 `@types/node`**（会一次消掉 33 条，但那要先裁定「是否为 devDependency」——
  本项目**故意不声明依赖**，见 `closure.mjs` 的注释）；
- **不改构建链**（strip 仍然是唯一构建路径）。

## 六、与「四步搬移」的关系

四步搬移（`8084014` / `208c866` / `88ed5ed` / `577c327`）的每一步都做了：
`verify-pure-move` IDENTICAL、导出面 182、测试全绿、逐字比对签名与调用点。

**这些验证的是「搬运是否纯」，不是「类型是否正确」。** 两者都需要，
但后者目前**只有本立项能提供**。这就是它必须存在的原因。

---

**状态**：立项（未实现）。下一步由用户裁定是否排期。
