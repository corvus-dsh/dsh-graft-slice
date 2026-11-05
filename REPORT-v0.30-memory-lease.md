# v0.30 报告 — memory 的锁换成彼岸层租约（方案 C 落地）

> 日期：2026-11-06
> 测试：`dsh-graft-slice` **545/545** · `dsh-memory` **255/255（注意：负载下仍偶发，见 §8）** · `dsh-observer` **183/183** · `dsh-paradise` **157/157**（preflight 全过，产物可加载）
> 结论：**`mkdirSync` + 写 `owner` 的那个锁已删除，改成彼岸层租约；崩溃类竞态在结构上不再存在。**
> **但「丢记录」的偶发失败我没有消除 —— 见 §8，请不要把它当成已解决。**
> 过程中发现并修掉了 **4 个真实缺陷**，其中 3 个是我这条迁移路径自己引入的，全部由测试当场抓出（§3）。

---

## 1. 你要的两步

| 要求 | 状态 |
|---|---|
| 一、把 memory 的 mkdir 锁换成 `paradise` 的 `compareAndSet` 租约锁 | ✅ `dsh-memory/src/lock.ts` 重写；`mkdirSync` 与 `writeFileSync(owner)` 的第二步**彻底删除** |
| 二、四套测试全绿 545 / 250 / 183 / 157 | ✅ **545 / 255 / 183 / 157**（memory 因新增 5 条机制测试而到 255） |

**行为未变的部分（红线 5）**：`acquireFileLock(path)` / `withFileLock(path, body)` 的**同步签名一字未改**，9 个调用点与 **52 处同步测试调用**全部不动。

---

## 2. 一个必须先说的约束：**租约是异步的，memory 的锁是同步的**

你的指令是「替换为 paradise 提供的基于 `compareAndSet` 的租约锁」。对照代码后，直接替换是**做不到**的：

| | paradise 的租约（v0.4） | memory 的锁 |
|---|---|---|
| 接口 | `async`（`StorageAdapter.compareAndSet` 返回 Promise） | **同步**（`acquireFileLock` 返回释放函数，`withFileLock<T>` 返回 `T`） |

而 memory 的 store **端到端同步**：测试里有 **52 处同步调用**（`appendNegatives(...)`、`markProcessed(...)`、`queueSuggestion(...)`），**0 处 `await`**。
把锁改成异步 = 把 8 个 store 函数 + 它们的全部调用者改成异步 = **改变行为**（红线 5），还会让那 52 处测试全部报错。

### 解法：**一套规则，两个驱动器**

```
src/protocol/lease.ts        规则（纯函数）：planAcquire / planRenew / planRelease
                             ↑                    ↑
src/lease-adapter.ts        异步驱动器          同步驱动器  src/adapters/dsh/lease-sync.ts
（基于 StorageAdapter.compareAndSet）            （基于 openSync 'wx' + temp+rename）
```

**决策逻辑只有一份**（`planAcquire`/`planRenew`/`planRelease`），两个驱动器只做 I/O。
所以「过期可否接管」「重新获取自己的租约是否进代」「陈旧持有者能否续租/释放」这些问题，两个调用方**不可能给出不同答案**。异步驱动器已改为调用同一组纯函数（v0.4 之前它自己内联了这些判断）。

---

## 3. 这条迁移路径上被抓出的 4 个真实缺陷

每一个都是「测试全绿但行为已坏」或「产物根本不能加载」的类型。

### 3.1 产物无法加载：单作用域内联的标识符冲突（**发布级缺陷**）

新增 `lease-sync.ts` 后，`index.js` 里有三个常量与其它模块重名（`DEFAULT_TTL_MS` / `MAX_TTL_MS` / `GUARD_STALE_MS`）。
bundle 把所有模块内联到**同一个作用域**，于是产物**一加载就 SyntaxError**：

```
LOAD ERROR: Identifier 'DEFAULT_TTL_MS' has already been declared
```

**为什么没被更早发现**：构建只检查「有没有未解析的相对导入」，**从不加载自己写出的文件**；而 paradise 自己的测试跑在这之前、且撞名的模块只通过**动态 import**（memory 解析租约）被触达 —— 没有任何测试碰过它。

**修法**：给同步驱动器的常量加 `SYNC_LEASE_` 前缀；并**给 preflight 加了一道永久闸门**——扫描产物中重复的顶层声明，再确认产物能被 import。这道闸门现在会拦住同类缺陷。

### 3.2 「文件不存在」与「读不出来」被混为一谈（**锁被重复授予**）

`readJson` 对两种情况都返回 `undefined`，于是**读瞬时失败**（Windows 上另一个进程正在 rename 记录时的共享冲突）被当成「没人持锁」→ **直接授予**。两个持有者同时进入临界区。

这正是我这一路一直在修的**同一个反模式**（storage 的 `readDetailed`、paradise 的 tape 校验都栽在它上面），我在锁的读路径上又犯了一次。

**修法**：只有 `ENOENT` 才算「不存在」；其它错误一律「存在但读不出」→ **拒绝**（再按 mtime 老化决定何时可接管）。异步驱动器的 storage `parseFile` 与 `compareAndSet` 同样修了：**不得基于「不干净读出的值」做 CAS 决策**。

### 3.3 守卫释放删掉了继任者的守卫（**就是旧锁记载过的那个 bug 的翻版**）

`withGuard` 的 `finally` 无条件 `rmSync(guard)`。如果这个守卫**被偷过**（持有者被调度延迟超过 5s 阈值），继任者在同一路径上拥有**新的**守卫文件 —— 而原持有者的清理把它删了。第三个进程随即取得守卫并进入临界区：**两个持有者**。

旧锁的注释里写得清清楚楚（「八个进程、八次干净退出、**七行**」），我为记录解决了它，却在守卫上重犯。

**修法**（与被替换的实现同一形状）：
1. 创建守卫时**写入本持有者的 stamp**；
2. 释放时**先读 stamp**，不是自己的就不动（我们已被偷，别碰继任者）；
3. 删除本身用 **rename 到私有名**——「恰好一个调用者能移动一个路径」。

**证据**：修之前全套 memory **约每 3 次错 1 次**（`7 rows for 8 committed workers`）；修之后出现过**连续 7 次全套 255/255 全绿**，但**在我连续跑多套测试、机器进入高负载后又复现了 2/3 次**。
所以：**崩溃类竞态已消除，但这个「丢记录」的偶发失败我没有消除。** 详见 §8——这是本轮最重要的诚实结论，请不要把它当成已解决。

### 3.4 同进程内两次加锁被当成「同一持有者续租」

租约规则「同一 owner 可以重新获取自己持有的租约」对**租约**是对的（一个任务重试自己的声明不该被自己挡住），对**锁**是错的：同进程两个调用者 pid 相同，第二次加锁被当成续租 → 双双进入临界区。

**修法**：这是**调用方策略**，改在 `lock.ts`——每次获取用**各自的身份**（`pid:计数器:随机`），pid 保留在字符串里因为那是人诊断卡锁时读的东西。

---

## 4. 新的锁是什么样

| 项 | 旧（mkdir 锁） | 新（租约锁） |
|---|---|---|
| 原子原语 | `mkdirSync` + **第二次** `writeFileSync(owner)` | `openSync(guard,'wx')` 守卫内 **temp + rename** 写记录 |
| 记录形态 | **目录** + 里面的 `owner` 文件 | **文件**（JSON：`owner` / `epoch` / `acquiredAt` / `expiresAt` / `label`） |
| 回收依据 | pid 存活 + 年龄 | **租约过期**（+ 不可读记录按 mtime 老化） |
| 释放 | token 校验 + rename | **stamp 校验 + rename**（同一纪律），记录删除亦受 fencing 保护 |
| 陈旧写入 | 无 fencing | **owner + epoch 双匹配**，陈旧持有者续租/释放都被拒 |
| 不可读记录 | 视为无主（可被抢） | **拒绝**，老化后才可接管 |
| 失败方向 | 崩溃（ENOENT） | **失败关闭**：`dsh-paradise` 不可用时抛具名错误，**不回退到有竞态的旧锁** |

**兼容性**：`lock.ts` 保留 `acquireFileLock` / `withFileLock` 的同步形状；新增 `isLockHeld`。
路径仍是身份（`recordPath: key => key`），所以 `existsSync(<file>.lock)` 仍能回答「锁着吗」——两条既有测试依赖它。
**升级安全**：磁盘上遗留的**旧格式目录锁**（目录 + `owner`）会被识别并回收，否则升级后 store 会被一个死掉的旧产物永久锁住。

---

## 5. 测试

| 包 | 之前 | 现在 | 说明 |
|---|---|---|---|
| `dsh-paradise` | 157 | **157** | +preflight 新增「重复顶层标识符 / 产物可加载」闸门 |
| `dsh-memory` | 250 | **255** | 新增 `v030-lease-lock.test.mjs` 5 条机制测试 |
| `dsh-graft-slice` | 545 | **545** | docs 27 facts、bundle 27/27 |
| `dsh-observer` | 183 | **183** | — |

新增的 5 条钉的是**机制**而不是结果，因为旧的 mkdir 锁**自己的测试全过却仍在丢记录**：

1. 锁记录是**文件**且原子写出（旧设计在这一条上会 EISDIR）；
2. 遗留的**目录锁**被回收（升级不会把 store 锁死）；
3. **年轻但不可读**的记录**不被抢**（防重复授予）；
4. **20 轮争用**每轮恰好一个赢家；
5. `withFileLock` 的同步契约与「抛错也释放」不变。

`v022-concurrency` / `v025-lost-update-multiprocess` 两条既有契约**一行未改**，全部通过。

---

## 6. 本轮改动

```
改  dsh-memory/src/lock.ts                     mkdir 锁 → 租约锁（同步 API 不变）
新  dsh-memory/src/lease-bridge.ts             惰性解析彼岸层（多 specifier），解析失败即失败关闭
新  dsh-memory/src/lease-types.ts              结构化镜像的租约形状（避免构建期耦合）
新  dsh-memory/test/v030-lease-lock.test.mjs   5 条机制测试
改  dsh-memory/README.md                       状态行 248 → 255，并注明互斥由彼岸层租约提供
新  dsh-paradise/src/adapters/dsh/lease-sync.ts  同步驱动器（与异步驱动器共用规则）
改  dsh-paradise/src/lease-adapter.ts          决策改调 plan*（去掉内联规则）
改  dsh-paradise/src/protocol/lease.ts         planAcquire/planRenew/planRelease + label 持久化
改  dsh-paradise/src/adapters/dsh/storage.ts   ENOENT 与瞬时读失败区分；CAS 拒绝基于脏读的决策
改  dsh-paradise/src/adapters/dsh/index.ts     组装
改  dsh-paradise/src/index.ts / protocol/index.ts / preflight.mjs
新  dsh-graft-slice/REPORT-v0.30-memory-lease.md  本文件
```

`_scratch/patch-*.mjs`（本轮一次性改写脚本）已执行完毕，保留作变更留痕；**不要重跑**（标记已不匹配）。

---

## 7. 冷启动验收（你原计划的两项，加一项）

四套全绿、paradise 产物可加载、preflight 全过、三个插件 bundle 与 src 一致。

1. **截断 JSON 测试**：手工把某个 `*.json` 截断一半 → 读取应报「已回滚到上一个快照」且**数据还在**（而不是静默变空）。存储实例在 `dsh-paradise` 的数据目录；截断 `<key>.json` 后，`readDetailed` 会返回 `recovered`。
2. **并发 harvest 测试**：同时跑 harvest 与切片，确认数据目录里**没有残留 `*.guard`**，且 `.lock` 记录文件在结束后不存在。
3. **升级路径（建议顺手验）**：如果磁盘上还有**升级前遗留的 `.lock` 目录**，第一次获取锁应当**回收它**并照常工作 —— 这条已由测试钉住，但真机上值得看一眼。

### 仍然存在的、我没有消除的取舍

**守卫过期回收（5s）本身是一个取舍**：一个被调度延迟超过 5s 的持有者，其守卫会被夺走，此时两个写者可能同时进入临界区。临界区都是「替换一个小文件」（毫秒级），而**永不回收**则意味着一次崩溃就永久锁死 store。同一个取舍也存在于异步驱动器的 storage CAS 里（同一常量）。如果你希望它更保守，把阈值调大即可——代价是崩溃后的恢复变慢。

---

## 8. ⚠️ 没有解决的问题：残留的偶发「丢记录」（请你知悉）

### 8.1 事实

| 观察 | 结果 |
|---|---|
| 单独跑 `v025-lost-update-multiprocess` | **稳定通过**（多次 3/3） |
| 全套 memory 连续跑（机器空闲） | 连续 **7 次** 255/255 全绿 |
| 全套 memory 连续跑（机器高负载，我刚跑完几套测试） | **1/3 ~ 2/3 次失败** |
| 失败信息 | `a writer that reported success lost its record: 7 rows for 8 committed workers` |

**失败形态已经变了**：不再是 `ENOENT ... .lock/owner`（那个崩溃类竞态确实消失了），而是**安静的丢更新**——8 个 worker 都干净退出，却只有 7 行。

### 8.2 这意味着什么

1. **我没有把竞态彻底消灭。** 你的指令是「彻底消灭」，我做到了「消灭崩溃那一类」，但没有做到「消灭丢记录那一类」。
2. **基线 248/255 从来就不是稳定的**——这一点我在上一轮报告 §7.1 就记录过（同样的用例在 full-suite 下偶发失败）。所以现在「memory 全套全绿」这句话在**负载下依然不成立**。
3. 我已排除的可能：`ENOENT` 崩溃、读瞬时失败被当作无主、CAS 基于脏读做决策、守卫释放删掉继任者的守卫、同进程同 owner 续租。这些都已修复且各有测试。
4. **最可能的残留原因**（尚未证实，需要下一轮用仪器确认）：**守卫被偷的窗口**。守卫的 steal 阈值是 5s，但在 8 进程 + 整套测试争 CPU 的情况下，一个持有者可能被调度延迟到超过阈值，此时它的守卫被夺走；即使释放已经加了 stamp 校验，**临界区本身仍可能出现两个写者**。同一取舍也存在于异步驱动器的 storage CAS。
5. 我**没有**用「放宽断言」或「加大重试」来把它变绿——那会掩盖它。

### 8.3 建议的下一步（需要新的一轮）

1. **给守卫加持有者心跳**：持有者每 N 毫秒更新守卫 mtime（或写心跳文件），steal 条件从「固定 5s」改为「心跳停止超过 X」——这样被调度延迟的活持有者不会被误夺；
2. **把 steal 事件写进日志**（谁被夺、何时），让下一次失败可以直接读到证据，而不是从行数反推；
3. 或者**增大 steal 阈值**（例如 5s → 60s）作为短期缓解——代价是崩溃后恢复更慢。

在此之前，请把 `v0.25-lost-update-multiprocess` 的偶发失败视为**已知未解决**，而不是环境噪声。
