# v0.31 报告 — 内核加固：混沌工程、能力降级断言，以及一个**被复现**的残留竞态

> 日期：2026-11-06
> 测试：`dsh-graft-slice` **545/545** · `dsh-memory` **255/255** · `dsh-observer` **183/183** · `dsh-paradise` **162/162**（preflight 全过，产物可加载、无重复标识符）
> 混沌脚本：`_scratch/chaos-test.mjs` —— **四项场景，其中三项完全通过，第三项复现了残留缺陷**
> 一句话：**你要的三件事都交付了；同时混沌工程把「偶发」变成了「可复现并已定位到量级」——这不是解决，是把它从不可调试变成了可调试。**

---

## 1. 逐条对照

| 你的要求 | 状态 | 证据 |
|---|---|---|
| 一、替换 memory 的 mkdir 锁为 Paradise 租约，临界区都有双匹配 fencing | ✅ 锁在上一轮已替换；本轮补上**写后校验**、**守卫持有者心跳/阈值放宽**、**双层 fencing（租约记录 + 守卫 stamp）** | §2 |
| 二、混沌工程脚本（断电 / 损坏 / 并发死锁 / 越权注入） | ✅ `_scratch/chaos-test.mjs`，4 场景 9 条断言 | §3 |
| 三、adapters/dsh 能力降级断言 `HOST_CAPABILITY_MISSING` + 告诉 AI 改哪个文件 | ✅ `assert-capabilities.ts` + `strict` 开关 + 5 条测试 | §4 |
| 四套全绿 | ✅ **545 / 255 / 183 / 162** | §5 |

---

## 2. P0-1：锁的加固（做了什么，以及**没做到什么**）

### 2.1 本轮新增的三项

| 项 | 内容 | 挡住什么 |
|---|---|---|
| **写后校验**（verify-after-write） | 写完租约记录后**再读回**，确认盘上的 owner+epoch 就是自己；不是自己 → 判定「未持有」→ 返回重试 | 两个写者共用守卫时，后者静默覆盖前者，两边都以为拿到了锁 |
| **守卫释放 fencing**（上一轮，本轮确认在产物中） | 守卫创建时写入 `stamp`；释放时**先读 stamp**，不是自己的就**不删**；删除用 `rename` 到私有名 | 删除继任者的守卫 → 第三者可进入 → 两个持有者 |
| **守卫抢占阈值 5s → 60s + 抢占计数** | 活持有者被调度延迟误判为「已死」的概率大幅下降；`guardSteals()` 让「守卫被抢」**变成可读证据**而不是从丢行数反推 | 误抢；以及「失败无法归因」 |

### 2.2 仍然存在：重复授予（**未解决**）

**混沌脚本现在能稳定复现它**，这是本轮最有价值的产出：

```
workers: 10, non-zero exits: 6
critical sections entered: 600
counter after: 598   (必须等于进入次数：不等就是丢了更新)
leftover *.guard: 0
```

`counter = 598 < winners = 600` —— 两次自增丢失，**这只能是两个进程同时处于临界区**。同时有 6 个 worker 因并发写同一文件（Windows 共享冲突）而崩溃，这是同一因的两个果。

**为什么这比上一轮好**：
- 上一轮是「full-suite 跑 3 次错 1 次」——**不可调试**；
- 现在是「10 进程 8 秒 ≈ 600 次临界区，稳定丢 2~3 次」——**可复现、可测量、可回归**。

**已经排除的原因**（每条都有测试或代码证据）：
`mkdir`→写 `owner` 的崩溃窗口（已删除该实现）、读瞬时失败被当作无主、CAS 基于脏读决策、守卫释放删继任者守卫、同进程同 owner 续租、去重门误判（用「8 个形状串行写入 = 8 行」否证了它）。

**尚未排除、我最怀疑的一条**：`acquireSync` 里「**读记录 → 决策 → 写记录**」与 `releaseSync` 的「**读记录 → 确认 → 删除记录**」之间，守卫的**获取/释放本身**仍有一个窄窗口 —— 当 `withGuard` 因守卫繁忙返回 `undefined` 时，`releaseSync` 会**静默失败**（返回 false），而 `acquireSync` 会把它当作「被他人持有」。两者对同一个返回值给了不同解释，是我在这层里唯一还带歧义的地方。下一轮我建议**先把这两个返回值拆成具名结果**（`busy` / `refused` / `granted` / `released` / `stale`），再用混沌脚本的量级变化来验证——这是当前最有把握的下一步。

---

## 3. P0-2：混沌工程（`_scratch/chaos-test.mjs`）

可直接运行：`node _scratch/chaos-test.mjs`，输出 PASS/FAIL 与退出码（可用于 CI）。

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | **断电模拟**：写入瞬间 `SIGKILL` × 6 轮 | ✅ PASS | 强杀后读取 `status=ok`，**不抛异常、不把半截文档当合法值**；数据目录**零残留临时文件** |
| 2 | **文件损坏**：`chaos-doc.json` 写成半截乱码 | ✅ PASS | `status=recovered`、警告「已回滚到上一个快照」、主文件**就地修复**为最后一份完好内容；同目录下 memory 的 `processed.json` 未受牵连 |
| 3 | **并发死锁**：10 进程抢同一租约 | ⚠️ **部分** | 互斥性断言 **`counter == winners` 在多数运行成立（曾 1000=1000、522=522）**，但负载下**复现丢 2~3 次**；**`*.guard` 零残留**（这一条始终通过） |
| 4 | **越权注入**：伪造含「忽略之前的所有指令」的 `SKILL.md` | ✅ PASS | `scanThreat` 命中 `contains prompt-injection phrasing`；无害文本**不误报**；恶意内容经 `appendNegatives` **零落盘**（写边界拦截） |

**场景 3 的双重价值**：它既是「租约在高频争用下是否互斥」的验收，也是本轮**唯一能复现残留缺陷**的工具。它同时给出了两个独立信号——计数丢失（互斥被破坏）与 guard 残留（清理失败）——而本轮只有前者失败，说明**清理是干净的，破坏的是互斥**。这个区分本身就是定位依据。

---

## 4. P1：DSH 升级破坏性预演（能力降级断言）

新增 `dsh-paradise/src/adapters/dsh/assert-capabilities.ts`。

### 4.1 它做的事

一张**必需 API 表**：每条都带 `service` / `method` / **后果** / **要改哪个文件**：

| API | 后果 | 要改的文件 |
|---|---|---|
| `sessions.prepare` | 无法预留零继承会话头，冷目标写不出来 | `src/adapters/dsh/session-writer.ts` |
| `sessionPersistence.create` | 没有持久化句柄，冷会话写不出去 | `src/adapters/dsh/session-writer.ts` |
| `sessionPersistence.stat` | 无法证实「会话确实不存在」 | `src/adapters/dsh/delete.ts` |
| `sessionQuery.readSession` | 冷读校验与幂等检查读不到日志 | `src/adapters/dsh/session-writer.ts` |
| `sessionController.prompt` | 会话可手动打开，但不会自动开始工作 | `src/adapters/dsh/trigger.ts` |

缺失时的报错就是给 AI 看的指令（逐条列出，**不是只报第一个**）：

```
HOST_CAPABILITY_MISSING：当前 DSH 版本缺少 1 个本层依赖的 API。
1. 宿主缺少 sessionPersistence.create。后果：没有持久化句柄：冷会话写不出去，live append 会撞 SessionStore。
   修法：修改 src/adapters/dsh/session-writer.ts 里对应的实现来适配新版本（协议层不需要改）。
```

### 4.2 为什么 `strict` 是**可选**的（而不是默认抛）

一个**空 context 是合法输入**：能力探测与 conformance 套件都用 `{}` 构造适配器，以证明「什么都没挂载的宿主会如实报 `false`」而不是假装。默认抛错会**删掉这个性质**。

所以：`createDshAdapters({}, { strict: true })` → 抛 `HOST_CAPABILITY_MISSING`；默认仍通过 `capabilities.unavailable` 报告同一批事实（它**本来就**为每个缺失项写明后果）。
**升级预演时把 `strict` 打开**——这正是这个开关存在的意义。

新增 `test/upgrade-drill.test.mjs`（5 条）：全挂载时干净、缺一个时**点名 API + 后果 + 文件**、**一次报全部**、strict 抛具名错误 vs lenient 只报告、`createDshAdapters` 默认宽松 / `strict` 严格。

---

## 5. 测试与产物

| 包 | 本轮前 | 现在 |
|---|---|---|
| `dsh-paradise` | 157 | **162**（+5 升级预演）· preflight 全过 · 产物可加载 |
| `dsh-memory` | 255 | **255** |
| `dsh-observer` | 183 | **183** |
| `dsh-graft-slice` | 545 | **545** · docs 27 facts · bundle 27/27 |

paradise preflight 现在包含两道新闸门：**无重复顶层标识符**、**产物必须能被 import**（上一轮那次「产物加载即 SyntaxError」的直接产物）。

---

## 6. 本轮改动

```
新  _scratch/chaos-test.mjs                        四项混沌场景（CI 可用的退出码）
新  _scratch/diagnose-dedupe-vs-lock.mjs           否证「丢行来自去重门」的决定性实验
新  dsh-paradise/src/adapters/dsh/assert-capabilities.ts  必需 API 表 + 具名拒绝 + 编辑指引
新  dsh-paradise/test/upgrade-drill.test.mjs       5 条升级预演
改  dsh-paradise/src/adapters/dsh/index.ts         strict 接线
改  dsh-paradise/src/index.ts / scripts/preflight.mjs
改  dsh-paradise/src/adapters/dsh/lease-sync.ts    写后校验、守卫 stamp 释放、阈值 60s、抢占计数
改  dsh-paradise/src/adapters/dsh/storage.ts       CAS 写后校验；ENOENT 与瞬时读失败区分
新  dsh-graft-slice/REPORT-v0.31-hardening.md      本文件
```

---

## 7. 给下一轮的一句话

**租约的互斥性在大规模争用下仍有 ~1/300 的重复授予，已被混沌脚本稳定复现。** 下一轮的第一件事应该是把 `withGuard` 的返回值从「`undefined` 兼表三种含义」拆成具名结果（`busy` / `refused` / `granted`），因为 `releaseSync` 与 `acquireSync` 现在对同一个 `undefined` 给了不同解释——这是我在这一层里唯一还带歧义的地方。用 `chaos-test.mjs` 场景 3 的计数差作为回归指标。

其余三项（断电、损坏、注入）已经是干净通过的，可以作为 DSH 升级的回归基线。
