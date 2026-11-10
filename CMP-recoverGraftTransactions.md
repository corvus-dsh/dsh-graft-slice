# 逐函数对照表（草案）— `recoverGraftTransactions`

> **状态：草案，未动一行代码。** 本表是「行为面等价」验收的**第 4 项**（见 `REPORT-stage2-modularization.md` §八之二），
> 用于替代依赖倒置时不适用 `verify-pure-move` 的那道不变式。
>
> **七列的命名需要你确认**：你给的三条硬约束我照办了（第 4 列 7 个 `let` 逐个点名、无「待定」；
> 第 5 列分列 `src/` 与 `test/`；第 6 列逐条「无」），但**七列的字面名我没有**——本会话与源会话都搜不到
> 「七列」的原文。下面第 1/2/3/7 列的名字是我按最合理的读法拟的，**改字面即可，结构不用动**：
>
> | 列号 | 我拟的名字 | 依据 |
> |---|---|---|
> | 1 | 函数 / 声明位置 | — |
> | 2 | 旧签名 | 依赖倒置必定改签名 |
> | 3 | 新签名（草案） | 同上 |
> | 4 | 模块级可变状态 | 你的硬约束 |
> | 5 | 调用点（`src/` 与 `test/` 分列） | 你的硬约束 |
> | 6 | 行为差异（逐条「无」） | 你的硬约束 |
> | 7 | 参数化来源（值从哪来） | 依赖倒置的落点，必须写清否则无法实现 |
> | 8 | **验收映射** | 你的裁定：不填它，「这个签名改动由哪条验收兜住」没人回答 |

---

## 一、摘要（一屏）

| # | 项目 | 值 |
|---|---|---|
| 1 | 函数 / 声明 | `recoverGraftTransactions`，`src/index.ts` **L8453..8535**（83 行）；闭包 **34 声明 / 505 行**，`mutable` = **7 个 `let`** |
| 2 | 旧签名 | `export function recoverGraftTransactions(ctx: PluginContextLike): { scanned: number; rolledBack: string[] }` |
| 3 | 新签名（草案） | `export function recoverGraftTransactions(ctx: PluginContextLike, paths: GraftStorePaths): { scanned: number; rolledBack: string[] }` |
| 4 | 模块级可变状态 | **7 个，逐个见 §四**（无「待定」） |
| 5 | 调用点 | `src/` **1 处调用**；`test/` **2 个文件、4 处调用、4 处非调用提及**（分列见 §五） |
| 6 | 行为差异 | **7 条，逐条「无」**（见 §六，每条给出「同一值、同一时序」的依据） |
| 7 | 参数化来源 | 全部 7 个值都来自**同一次装配**：`configureRetiredStore(ctx, settings)`（`src/index.ts` L5300..5345），见 §六 |
| 8 | **验收映射** | 见 §八：4 条验收各自兜住这次改动的一个面（导出面 / 全绿 / 端到端 / 对照表 + 新增 v131） |

---

## 一之二、签名基线（两行，可直接 diff）

**裁定为必填参数**（可选 + 回退会让 7 个 `let` 留着 → STOP 永不解除 → 依赖倒置白做）。基线如下，评审与
`.export-surface.json` 都看不出这类破坏（它只管名字），所以这两行必须随提交一起走：

```ts
// BEFORE
export function recoverGraftTransactions(ctx: PluginContextLike): { scanned: number; rolledBack: string[] }
// AFTER（`paths` 必填；不提供默认值，不保留回退）
export function recoverGraftTransactions(ctx: PluginContextLike, paths: GraftStorePaths): { scanned: number; rolledBack: string[] }
```

## 二、闭包构成（34 声明，搬动/改签名时必须一起处理）

| 类 | 数量 | 成员 |
|---|---|---|
| 接口 / 类型 | 9 | `GraftTxnRecord`、`GraftTxnState`、`PluginContextLike`、`PreparedSessionLike`、`SessionHeaderLike`、`SessionLogSnapshotLike`、`SessionQueryLike`、`SessionStoreLike`、`ToolRegistryLike` |
| 常量 | 3 | `AUTO_GRAFT_RESUME_GRACE_MS`、`PLUGIN_TITLE_MARKERS`、`name` |
| **模块级 `let`** | **7** | 见 §四 |
| 函数 | 15 | `recoverGraftTransactions`、`ctxForStores`、`discardPartialTarget`、`ledgerArray`、`markTargetBroken`、`persistAutoGraftSuppression`、`persistGraftTargetStore`、`persistLeftovers`、`persistRetiredStore`、`persistTransferredStore`、`recordLeftover`、`restorableTitle`、`resumeSession`、`txnFileFor`、`writeGraftTxn` |

**这张表本身已经说明为什么它不能「纯位移」**：闭包里有一半是**写盘助手**，它们的输入就是那 7 个路径；
不改签名就只能把它们一起搬进新模块，而它们又被 `apply()` 之外的代码共享 —— 搬走等于把「一处状态」变成两处。

---

## 三、第 4 列详解：7 个 `let`（逐个点名，无「待定」）

全部声明在 `src/index.ts` 的装配区（L5233..5847），**全部在同一次调用里被赋值**（见 §七）。

| # | `let` 名 | 声明行 | 写入点 | 读点数 | 代表读点 |
|---|---|---|---|---|---|
| 1 | `retiredStorePath` | L5233 | L5327 | 20+ | L173, L5365, L5401, L5603, L6287, L8457 |
| 2 | `transferredStorePath` | L5234 | L5328 | 14 | L5364, L5380, L6329, L6344, L6386 |
| 3 | `graftTargetsPath` | L5236 | L5329 | 7 | L8755..8805 |
| 4 | `txnDirPath` | L5249 | L5330 | 8 | L173, L8370, L8457, L8469, L12150 |
| 5 | `storeCtx` | L5251 | L5304 | 2 | L5253, L12322 |
| 6 | `leftoversStorePath` | L5847 | L5338 | 5 | L5851, L5856, L5883 |
| 7 | `autoGraftSuppressedPath` | L5814 | L5339 | 6 | L7103..7133 |

**读点数一列是我按 `\bNAME\b` 扫 `src/index.ts` 得到的（含注释与字符串），不是「调用点」的精确数**；
真正要改的是 §七 那个装配点，读点数只用来判断「这个值被多少地方依赖」。

---

## 四、第 5 列详解：调用点（`src/` 与 `test/` 分列）

| 类 | 文件 | 行 | 性质 |
|---|---|---|---|
| **`src/`** | `src/index.ts` | L8453 | **声明** |
| **`src/`** | `src/index.ts` | L9896 | **调用**（1 处） |
| `test/` | `test/v74b-txn-recovery.test.mjs` | L20 | import |
| `test/` | `test/v74b-txn-recovery.test.mjs` | L51, L56, L73, L88 | **调用（4 处）** |
| `test/` | `test/v127-closure-instrument.test.mjs` | L88, L95, L98, L126 | **非调用**：断言闭包仪器对该函数报出 7 个 `let`（字符串与 `measure()` 参数） |

**这是三个不同的集合，必须分开说**（本项目已经因为混用「提及 / 读取 / 断言」出过一次错）：
本函数的**真实调用点** = `src/` 1 处 + `test/` 4 处 = **5 处**；
另有 `test/v127` 的 **4 处提及**（不是调用，改签名不影响它，但改名字会影响）。

**改签名的直接后果**：`test/v74b` 的 4 处调用必须同步加参数 → 若这些调用是从 `../index.js` 拿的公开 API，
则**这是行为面改动**，必须连测试一起改，且第 2 条验收（720 全绿）要在改完后仍然成立。

---

## 五、第 6 列详解：行为差异（逐条「无」）

判据：对每个 `let`，新旧两版在**同一时序**上读到的值是同一个对象/同一个字符串，且**赋值时机不变**。

| # | `let` | 行为差异 | 依据 |
|---|---|---|---|
| 1 | `retiredStorePath` | **无** | 旧版从模块级读；新版从 `paths.retiredStorePath` 读，而后者由**同一次** `configureRetiredStore` 赋值，调用发生在任何读之前（`apply()` 内 L5300，读点最早 L5365） |
| 2 | `transferredStorePath` | **无** | 同上，写入 L5328 早于最早读点 L5364 |
| 3 | `graftTargetsPath` | **无** | 同上，写入 L5329 早于最早读点 L8755 |
| 4 | `txnDirPath` | **无** | 同上，写入 L5330 早于最早读点 L8370；`recoverGraftTransactions` 内的读在 L8457 之后 |
| 5 | `storeCtx` | **无** | 写入 L5304；唯一相关读点 L5253 在**同一装配链**内，L12322 在 `apply()` 之后，均晚于赋值 |
| 6 | `leftoversStorePath` | **无** | 写入 L5338 早于读点 L5851 |
| 7 | `autoGraftSuppressedPath` | **无** | 写入 L5339 早于读点 L7103 |

**这张表还不是最终形态**：它现在证明的是「时序不变」，还**没有**证明「同一目录被解析两次会得到同一个值」——
后者需要看 `resolveStoreDir(ctx, settings.dataDir)` 是否幂等（P1-2 的 `.layout.json` 已经写在装配里）。
**在动第一行代码前，这一条必须补成实测**（同一 `ctx` 连续装配两次，断言 7 个路径字符串相等）。

---

## 六、第 7 列详解：参数化来源（依赖倒置的落点）

**唯一装配点**：`configureRetiredStore(ctx, settings)`（`src/index.ts` L5300..5345），它在 `apply()` 内被调用一次，
把 `dataDir` 解析出来后**一次性**赋给 7 个路径 + `storeScope` + `storeCtx`：

```ts
function configureRetiredStore(ctx: PluginContextLike, settings: Required<GraftConfig>): void {
  const resolved = resolveStoreDir(ctx, settings.dataDir)
  const dataDir = resolved.dir
  storeScope = resolved.scope
  storeCtx = ctx
  // …writeLayoutManifest(dataDir, …)
  retiredStorePath = join(dataDir, '.retired.json')      // L5327
  transferredStorePath = join(dataDir, '.transferred.json') // L5328
  graftTargetsPath = join(dataDir, '.graft-targets.json')   // L5329
  txnDirPath = join(dataDir, '.txn')                       // L5330
  leftoversStorePath = join(dataDir, '.graft-leftovers.json') // L5338
  autoGraftSuppressedPath = join(dataDir, '.auto-graft-suppressed.json') // L5339
}
```

**草案**：把这 7 个值收进一个**不可变的结构体**（下面的 `GraftStorePaths`），由 `configureRetiredStore`
构造后**返回**，`apply()` 内保存一份并传给需要它的函数：

```ts
export interface GraftStorePaths {
  readonly retiredStorePath: string
  readonly transferredStorePath: string
  readonly graftTargetsPath: string
  readonly txnDirPath: string
  readonly leftoversStorePath: string
  readonly autoGraftSuppressedPath: string
  readonly storeCtx: PluginContextLike | undefined
  readonly scope: string
}
```

`storeCtx` 与 `scope` 一起收进来，否则 `ctxForStores()` 仍要读模块级状态 —— **留下一个 `let` 就等于没做**。

**必须一起改的 15 个函数**（闭包里的函数成员，全部读这些值）：
`recoverGraftTransactions`、`ctxForStores`、`discardPartialTarget`、`ledgerArray`、`markTargetBroken`、
`persistAutoGraftSuppression`、`persistGraftTargetStore`、`persistLeftovers`、`persistRetiredStore`、
`persistTransferredStore`、`recordLeftover`、`restorableTitle`、`resumeSession`、`txnFileFor`、`writeGraftTxn`。

---

## 七、这份草案**还不能**开工的三件事（先补齐，再谈代码）

1. **`resolveStoreDir` 的幂等性实测**：同 `ctx` 连续装配两次，7 个路径字符串必须相等（§五 的「无」依赖它）。
2. **`ctxForStores()` 的语义**：它是否在「`storeCtx` 未赋值」时有回退路径？若有，新签名必须保留同一回退。
3. **公开 API 变更的登记**：这 7 个路径目前**不是导出符号**（属实现细节），但 `recoverGraftTransactions`
   是导出的；加一个必填参数会改变其对外签名 —— 需要确认是否允许「加参数」而非「加默认值」。
   若不许破坏 API，则新参数必须可选，并保留旧行为（**这会削弱依赖倒置，须你裁定**）。

---

## 八、第 8 列详解：验收映射

| 这次改动动了什么 | 由哪条验收兜住 | 现状 |
|---|---|---|
| 函数签名加**必填** `paths`（`src/` 1 处 + `test/` 4 处调用点） | **验收 2**：720 全绿（改完必须仍 718 pass / 0 fail） | 720 / 718 / 0 / 2 |
| 7 个模块级 `let` 消失（闭包的 `mutable` 从 7 → 0） | **验收 4**（逐函数对照表）+ **v131**（解析的优先级 / 每装配重算 / 稳定性） | v131 4/4 绿，且**能红证明 2/2** |
| 公开名字不变（只加参数） | **验收 1**：导出面 182 不变 | 182 |
| 运行时行为（写盘位置、退休闸门、点火） | **验收 3**：端到端（假 harness）三项 true | 三项均 true |
| 每个被改签名函数的行为差异 | **验收 4**：第 6 列逐条「无」 | 7 条「无」（本轮） |

**v131 是前置证据，不是补充**：它断言 `resolveStoreDir` ①显式 `config.dataDir` 胜出 ②每次装配重算
③同输入同结果。这三条任一不成立，参数化就会**改行为**，那就不许动代码。

**一条方法教训（实测）**：v131 的测试 import 的是 **产物 `index.js`**，而变异改的是 `src/index.ts`。
前两次能红证明都「未红」，原因是**变异后没有重建**——测试跑的还是旧产物。正确循环是
**变异 → 重建 → 测试 → 还原 → 重建**（两次重建都要做，否则产物与已提交源码不一致）。
本项目的其它能红证明大多读源码或直接 import 脚本，不受此影响；**凡是测试 import 产物的，都必须带重建**。

## 九、数据来源（可复跑）

- 闭包与 `mutable`：`node scripts/closure.mjs recoverGraftTransactions`
- 声明行 / 签名 / 7 个 `let` 的读写点 / 调用点：`node ..\_scratch\cmp-recover.mjs`
- 装配点：`src/index.ts` L5300..5345（本表 §六 原文引用）
- v131 前置证据：`node --test test/v131-store-dir-resolution.test.mjs`
- v131 能红证明：`node ..\_scratch\v131-canred3.mjs`（含重建循环）
