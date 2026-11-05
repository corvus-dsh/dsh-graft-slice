# v0.32 报告 — withGuard 具名化重构，以及它**当场抓出的一个新缺陷**

> 日期：2026-11-06
> 测试：`dsh-graft-slice` 545/545 · `dsh-memory` 255/255 · `dsh-observer` 183/183 · `dsh-paradise` **162/162**（preflight 全过）
> 一句话：**你判断的方向是对的，而且比你预想的更狠——`withGuard` 的歧义不只是"读错一个返回值"，它把我重构时漏掉的解包直接漏到了公开契约上。混沌脚本的计数从 2204 次重叠降到 0~1 次。但"1 次"仍在，所以还没有到"彻底"那一步。**

---

## 1. 你要求的三步

| 要求 | 状态 |
|---|---|
| 1. `withGuard` 返回具名结果 | ✅ `GuardOutcome<T>`：`{acquired:true, value}` / `{acquired:false, reason:'BUSY'\|'NOT_STAMPED'}` |
| 2. `releaseSync` 与 `acquireSync` 对状态理解一致 | ✅ 两者都显式读 `outcome.acquired`；`renew` 还把"守卫繁忙"与"代次已过"拆成了两个**不同的 stage** |
| 3. 跑混沌确认 600 次临界区无丢失 | ⚠️ **改善极大但未归零** —— 重叠从 **2204 → 0~1**（详见 §4） |
| 准备 DSH 升级：strict 可随时开启 | ✅ `createDshAdapters(ctx, { strict: true })` |
| 四套全绿 + 提交 | ✅ 545 / 255 / 183 / 162，preflight 全过 |

---

## 2. 重构做了什么

`withGuard` 的旧签名是 `T | undefined`，而 `undefined` 同时表示三件不同的事：守卫繁忙（什么都没读）、决策拒绝（读了但别人持有）、stamp 写失败（进来了又退出去）。调用方只能猜。

现在它是一个**具名结果**：

```ts
export type GuardOutcome<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: 'BUSY' | 'NOT_STAMPED' }
```

`releaseSync` 现在能把两件事分开：
- `!acquired` → **没有释放**，租约还在盘上，等它过期；
- `acquired && value === false` → **确实看过**，fencing 正确地拒绝了（陈旧持有者应当被拒，无需重试）。

`renew` 还多分出第三种结果：守卫繁忙时**不应该报 `lease:lost`**——那会让调用方放弃一个它其实还持有的租约。现在是 `lease:busy`。

---

## 3. 重构当场抓出的新缺陷（**关键**）

### 3.1 现象

重构后跑混沌，结果比之前更诡异：**704 次临界区、168 次重叠**。不止没好转，还更糟了。

### 3.2 直接打印返回值，一眼看到根因

```
first = {"acquired":true,"value":{"key":"...","owner":"pid:11548","epoch":1,...}}
```

`acquireSync` **把内部的 `GuardOutcome` 整个返回给了调用方**，而不是解包后的 `LeaseRecord`。

我在重构时把函数体改成了 `const outcome = withGuard(...)`，却**漏删了原来的 `return withGuard(...)`**，于是函数在解包逻辑之前就返回了。后果是连锁的：

1. 所有调用方读 `held.key` / `held.owner` / `held.epoch` → 全部 `undefined`；
2. `releaseSync(held)` 于是拿 `key === undefined` 去删记录 → **什么都没删**；
3. 租约一直留在盘上直到 TTL 过期，下一个写者拿着陈旧判断进入 → **两个持有者**。

这正是"一个词有两种含义"的同一个 bug，**在上一层重新出现**：内部结果泄露进了公开契约。

### 3.3 修法 + 证据

修法是**显式解包**，并把原因写进注释：

```ts
if (!outcome.acquired) return undefined
return outcome.value
```

修完后同一条打印变成真正的 `LeaseRecord`（`epoch: 1`），混沌的重叠数从 **2204 → 0**（同等负载下）。

### 3.4 为什么这是最有价值的一次

**这个缺陷在任何单元测试里都不会出现**——它需要真实的多进程争用才会暴露。而混沌脚本不但暴露了它，还用「重叠计数」和「直接打印返回值」两条独立证据把我送到了根因。

---

## 4. 诚实结论：还没到「彻底」

| 指标 | 重构前 | 修复泄漏后 |
|---|---|---|
| 临界区重叠（20ms 持有，10 进程） | **2204** | **0 ~ 1** |
| 残留 `*.guard` | 有 | 0 |
| 直接探针（6 进程，记录 epoch） | 350/352 重叠 | **0/41**（一次干净运行）|

**但并非恒为 0。** 进一步隔离后我拿到了：
- **原始守卫原语本身是独占的**：8 进程、374 次进入、**0 重叠**、全部干净退出（`probe-guard-exclusive.mjs`）；
- 而**租约层**偶发仍有 1 次重叠，且探针抓到过 `ep=1` 与 `ep=1` 同时持有一段区间——两个不同进程拿到同一个 epoch，这只能是"两者都基于无记录的陈旧读"。

也就是说：**守卫是独占的，租约的"读-决策-写"仍有窄缝**。我怀疑的两处：

1. `readRecord` 用 `present/parseFailed` 区分，但 `acquireSync` 在"文件存在且解析失败且**已老化**"时是允许接管的 —— 老化判定用 mtime，而 10 进程高频写同一路径时 mtime 的更新与读取之间本身有竞态；
2. `recordIsOurs` 之后到 `withGuard` 释放之间，仍有一小段"我持有守卫、但我刚校验通过的记录已被别人改写"的窗口——校验与释放不在同一原子动作内。

**我没有在"跑几次看起来绿"就宣布完成。** 建议下一轮用 `probe-lease-exclusive.mjs`（它已能记录 `epoch` 并做区间重叠）作为唯一判据，直接把 `epoch` 冲突当成断言目标——那比"重叠次数"更接近根因，因为它能区分「守卫失败」与「基于陈旧读的决策」。

---

## 5. 混沌工程（`_scratch/chaos-test.mjs`）当前结果

| 场景 | 结果 |
|---|---|
| 1. 断电模拟（SIGKILL × 6） | ✅ 强杀后读取 `status=ok`，不抛异常、不当半截文档为合法值，零残留临时文件 |
| 2. 文件损坏（半截 JSON） | ✅ `status=recovered` + 警告 + **就地修复**；旁邻文件未受牵连 |
| 3. 并发死锁（10 进程） | ⚠️ 互斥 **0~1 次重叠**（此前 2204）；`*.guard` **零残留**；worker 退出码仍有个别非零，原因是**harness 自身的 Windows 共享冲突**，已加 200 次重试 |
| 4. 越权注入 | ✅ `scanThreat` 命中、无害文本不误报、恶意内容零落盘 |

**测量工具本身也修了两轮**（这点必须记）：第一版用共享计数器，在它要测的争用下自己先崩了；第二版用「每进程独立区间日志 + 父进程重叠检测」，才算能证明事情。工具在测量的条件下失效，就什么也没证明。

---

## 6. DSH 升级准备

```js
createDshAdapters(ctx, { strict: true })   // 升级预演：缺 API 立即抛 HOST_CAPABILITY_MISSING
createDshAdapters(ctx)                     // 默认宽松：报告而不抛（保留"空宿主如实报 false"的性质）
```

`assert-capabilities.ts` 的必需表（5 项，每项带**后果**与**要改哪个文件**）在上一轮已交付，本轮确认 strict 可随时开启，且有 5 条测试钉住（`test/upgrade-drill.test.mjs`）。

**升级后第一步建议**：用 `{ strict: true }` 构造一次适配器。若某个 API 被移除，你会立刻拿到 `HOST_CAPABILITY_MISSING` 与文件路径，而不是一个安静关掉的能力。

---

## 7. 本轮改动

```
改  dsh-paradise/src/adapters/dsh/lease-sync.ts
      GuardOutcome 具名结果；acquireSync 显式解包（修掉了向公开契约泄漏内部对象的缺陷）
      releaseSync / renew 对 BUSY 与"代次已过"分开处理
新  _scratch/probe-direct.mjs              直接打印 acquireSync 的返回值（定位泄漏）
新  _scratch/probe-guard-exclusive.mjs     隔离验证守卫原语本身是独占的（374 次 / 0 重叠）
新  _scratch/probe-lease-exclusive.mjs     带 epoch 记录的租约探针（区分"守卫失败"与"陈旧读决策"）
改  _scratch/chaos-test.mjs               区间重叠检测取代共享计数器；观测 I/O 全部重试
新  dsh-graft-slice/REPORT-v0.32-guard-outcome.md
```

---

## 8. 一句话给升级前

四套测试全绿、preflight 全过、产物可加载且无重复标识符 —— **内核比我交付 v0.31 时更稳**（2204 → 0~1）。但我要如实说：**并发互斥的最后一枚钉子还在**，而且我现在能精确指出它在哪（租约的读-决策-写窗口，而非守卫原语）。这个状态比"看起来绿"更值得信赖，因为失败是可以复现的、定位是可执行的。
