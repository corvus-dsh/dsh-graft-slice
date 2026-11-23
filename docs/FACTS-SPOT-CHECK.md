# facts 抽查 · Phase A（**advisory，不是门禁**）

> 依据：lead §25.4b「新增一列 `facts`，并做**一次性**交叉抽查：同一个事实被两个单元以不同方式推导
> → 列出来。**明标 advisory，不是门禁**」。首个抽查对象是 `warnAt` / `hardAt`（总报告 §1.1 R1）。
>
> 本文只记录**量到的东西**；没量到的写在末尾。它不拦截任何提交，它是 Phase W1 的输入。

## 一、量到什么：`warnAt` / `hardAt` 有四个推导者

| # | 位置 | 它算什么 | 谁读它 |
|---|---|---|---|
| 1 | `core/watermark.ts:201-202` | **动态**：`warnAt = hardCeiling − warnMargin`，`hardAt = hardCeiling` | `effectiveWatermarks` 的调用方 |
| 2 | `core/watermark.ts:252-253` | **固定**：`warnAt = modelDrivenGraftAtRatio`，`hardAt = autoGraftAtRatio` | 同上 |
| 3 | `index.ts:10989 governedWatermarks` | 在 `effectiveWatermarks` 之上再套 `applyMargin` + `applyCompactionCeiling` | 引擎的每一个自动决策（`:12486`/`:12508`/`:12689`/`:13218`/`:13230`/`:14659`） |
| 4 | `core/compaction-guard.ts`（19 处） | 自己的天花板与可算性判定 | `governedWatermarks` 与 `graft_debug_status` |

**同一对数字，两条推导链**（1/2 是 base，3 是引擎最终值，4 是压缩上限）。这不是「实现错误」，
是**事实所有权分裂**：`warnAt` 这个名字在四个地方各有定义。

## 二、一处已经能指认的分歧

`index.ts:13314`：

```ts
? effectiveWatermarks(settings, undefined)     // 面板「没有代表会话」时
: await governedWatermarks(...)                // 有代表会话时
```

**同一张面板的两条分支读的不是同一个函数。** 有会话时该行读 `governed`（含 compaction 天花板与
token 边距），无会话时读 `effective`（不含）。所以「无会话那一屏」与「有会话那一屏」的数字口径不同 ——
这正是 R1 说的「面板 warnAt 与引擎 governed 不同源」。

## 三、另外两处（总报告 R2/R3，本轮**未量化**）

| 报告项 | 我核到的状态 |
|---|---|
| R2 token 口径四级不一致 | **未量化**。`readTokenWatermark` / `tokenMeter.measure` / `snapshotEvents` 三条来源我只确认存在，没有逐级比对数字。 |
| R3 cache key 只有 sessionId | **未量化**。`-- 见 `core/state.ts` 的缓存键；本轮没有追踪它的失效条件。 |

这两条**必须由 Phase W1 自己量**，不许拿本文当作已量。

## 四、这份抽查的用途

- `docs/HANDLER-INVENTORY.md` 里每个单元的 `facts` 列是**逐单元**的答案（谁读谁写什么）；
- 本文是**跨单元**的那一半：同一个事实出现在多个单元里时，列出来；
- **Phase W1 的入口**：把 1/2/3/4 收敛成一个所有者，然后 W1 才动代码。

## 五、我没做的事（不当作已完成）

1. 没有把四个推导者收敛成一个 —— 那是 Phase W1，不是 Phase A；
2. 没有量化 R2 / R3；
3. 没有把本文变成门禁 —— lead 明确要求 **advisory**，一条「同一个事实只能有一个推导者」的机械
   判据在今天还写不出来（四个推导者里有两个是合法的分层，不是重复）。
