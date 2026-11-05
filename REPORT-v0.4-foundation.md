# v0.4 报告 — 地基的最后一锤：存储加固、租约、生命周期，以及**一处必须请示的范围裁决**

> 日期：2026-11-06
> 版本：`dsh-paradise **0.4.0**`（137 → **157**）· `dsh-graft-slice` **545/545** · `dsh-memory` **250/250** · `dsh-observer` **183/183**
> 结论：**存储层的原子写 + 半截 JSON 自恢复 + 基于 storage 的租约（Epoch/PID/fencing）已落地并锁测试；三个插件的监听器生命周期已审计并加护栏。**
> 但**「废弃 memory 内部 fs、全部换成 paradise.storage」我没有照做** —— 因为按你给的事实对照代码，前提有两处不成立，硬做会改变行为。§5 是完整取证与三个可选方案。

---

## 1. 先说结论：三件事做完了，一件事需要你裁决

| 你的要求 | 状态 | 证据 |
|---|---|---|
| 一.1 `client.js` 无宿主内部对象访问、有 ErrorBoundary | ✅ **本来就已满足**（见 §2） | `MemoryPanelBoundary` + `host.call` |
| 一.2 `extract.ts` / `retrieve.ts` 无 fs / 硬编码绝对路径 | ✅ **基本已满足**；`extract.ts` 零 fs（见 §2） | 逐文件清单 |
| 二.3 storage 原子写 + 半截 JSON 自恢复降级 | ✅ **本轮实现**（原来只有原子写，没有恢复） | `test/storage-lease.test.mjs` 5 条 |
| 二.1/2.2 memory 的 skills/negatives/processed 改走 storage | ⛔ **未做，需你裁决**（前提不成立 + 会改行为） | §5 |
| 三 基于 storage 的乐观锁 / 租约（Epoch/PID 校验） | ✅ **本轮实现**（含 fencing、过期回收、有界等待） | `test/storage-lease.test.mjs` 12 条 |
| 四.1 三个插件的 dispose 清理 | ✅ 审计完成 + 加护栏测试 | 三个 `lifecycle-dispose.test.mjs` |
| 四.2 跑通四套测试 | ✅ 545 / 250 / 183 / 157 | §7 |

---

## 2. 阶段一审计：三处「排查」，两处本来就干净

### 2.1 `dsh-memory/client.js` —— 已经有错误边界，且只走稳定 RPC

| 检查项 | 结果 |
|---|---|
| ErrorBoundary | ✅ `MemoryPanelBoundary`（`React.Component` + `getDerivedStateFromError` + `componentDidCatch`），渲染崩溃时显示红色卡片与堆栈，**不白屏** |
| 宿主调用 | ✅ 只用 `host.call(...)` |
| 其它访问面 | ✅ `ctx.get('remote')` → `remote.commands.execute` / `remote.session.list`（稳定 RPC），无内部对象直取 |
| `window` 访问 | ✅ `window.localStorage` 有 `typeof window !== 'undefined'` 守卫；`window.__ModuleLoader__.load` 是插件入口的标准写法 |

**我没有改动它** —— 没有发现问题就不动它，比「顺手重构」更有价值。

### 2.2 `extract.ts` / `retrieve.ts`

| 文件 | fs 调用 | 说明 |
|---|---|---|
| `extract.ts` | **0** | 纯提取逻辑，零文件系统接触 |
| `retrieve.ts` | 8 处，**全是读**（`readFileSync` / `readdirSync` / `existsSync`） | 检索期读 `SKILL.md` 与 JSONL 建索引，不写 |

**硬编码绝对路径**：全仓库只有一处疑似——`store.ts:34` 的 `defaultSkillsDir() = join(homedir(), '.agents', 'skills')`。
但这不是「写死的本机路径」，而是**设计本身**：技能目录是用户级、可手工编辑的共享目录（见 §5.1）。运行时由 `homedir()` 推导，没有把任何人的机器路径烧进代码。

---

## 3. 阶段二：存储层加固（原子写 → 原子写 **+ 可恢复**）

### 3.1 原来的缺口，说精确

旧 `read` 的实现是：

```ts
try { return JSON.parse(readFileSync(pathOf(key), 'utf8')) } catch { return undefined }
```

`undefined` 同时意味着**三件不同的事**：从未写过、被删除、**文件损坏**。
调用方无法区分「你自己的数据毁了」和「你还没写过」——于是它会当成空数据从头开始，**把残骸覆盖掉**。

原子写（tmp + rename）挡的是「读者看到半截」；它挡不住「半截已经躺在那里」——rename 前后被杀、磁盘写满、或人手工编辑。

### 3.2 现在的行为

| 能力 | 实现 |
|---|---|
| 原子写 | 同目录临时文件 + `rename`（保留） |
| **快照** | 每次写成功后，把**刚写下的那份**原子地复制一份到 `<key>.json.bak` |
| **自恢复** | `read` 发现主文件半截/非法 → 回退到快照 → **就地修复主文件** → 返回 `status: 'recovered'` + 警告 |
| **三值诊断** | 新增可选 `readDetailed()`：`ok` / `missing` / `recovered` / `corrupt`。`corrupt` 与 `missing` **绝不混同** |
| 删除 | 连快照一起删（否则销毁过的数据会被「恢复」回来——**复活比丢失更坏**，因为它看起来像一次成功的读取） |
| `keys()` | 快照 / 临时文件 / 守卫文件永不进入列表 |

**为什么快照取「刚写下的」而不是「被替换的」**：取被替换的那份就要**先写快照再写主文件**，于是快照撕裂与主文件撕裂不可区分，唯一的完好副本就没了。取刚写下的那份，主文件永远不比快照旧，且快照在构造上就是一份成功写入的副本。

---

## 4. 阶段三：租约（Epoch + PID 校验）

### 4.1 设计

位置：`src/protocol/lease.ts`（**中性类型 + 纯函数**）+ `src/lease-adapter.ts`（**一份实现，两个宿主共用**）+ `src/lease.ts`（`withLease` 调用规则）。

```
LeaseRecord { key, owner, epoch, acquiredAt, expiresAt }
```

| 机制 | 做法 | 挡住什么 |
|---|---|---|
| **互斥** | `storage.compareAndSet(key, verify)` —— 守卫文件 `wx` 独占创建，`verify` 在守卫内运行 | 两个进程都读到「无锁」然后都写（lost update） |
| **过期回收** | 租约带 `expiresAt`；过期的可被他人接管 | 持有者崩溃后**永久锁死**（任何超时都救不回来的死锁） |
| **Fencing** | 每次获取 `epoch + 1`；`renew`/`release` 必须 **owner + epoch 同时匹配** | 卡住的旧持有者醒来后覆盖继任者的工作 |
| **过期守卫回收** | 守卫文件超过 5s 视为被弃，直接夺回 | 守卫自身成为死锁源 |
| **有界等待** | `withLease(waitMs)` 是**有界循环**，不是队列；超时返回具名 `LEASE_BUSY` | 「某个任务慢」升级成「这个进程永不结束」 |
| **拒绝提示性宿主** | `adapter.exclusive !== true` → 直接 `LEASE_UNAVAILABLE`，不回退 | 无原子 CAS 的宿主上「大概没事」地并发写 |

### 4.2 为什么它属于层级而非宿主目录

`lease-adapter.ts` **只 import 协议**。它用 `StorageAdapter.compareAndSet`，而内存宿主也实现了这个方法（串行化自己的回调）——所以**同一份租约代码在两个宿主上跑**，两个宿主不可能在 fencing 规则上漂移。
`test/isolation.test.mjs` 新增一条守卫：`lease-adapter.ts` / `lease.ts` **不得 import 任何宿主适配器**，一旦越界立刻失败。

### 4.3 `withLease` 的三个失败模式（都有测试）

1. **泄漏**：正文抛错也一定释放（`finally`）——否则 key 会一直锁到 TTL 过期，一个「没人解释得清」的延迟；
2. **死锁**：等待有界，拒绝具名；
3. **陈旧写**：正文跑完后再查一次租约；若正文期间租约已过期且现任换了人，即使正文干净返回也报 `LEASE_LOST`，**不假装成功**。

---

## 5. ⛔ 没有照做的那件事：memory 的 fs → storage 全量替换

### 5.1 前提与代码不符（两处）

| 你的表述 | 代码事实 |
|---|---|
| 「废弃 fs 读写 **`skills.jsonl`**」 | **`skills.jsonl` 在 src/ 与 test/ 中都不存在**（全量 grep 为空）。技能存的是 **`SKILL.md` 文件树**（`store.ts:170` `join(skillsDir, name, 'SKILL.md')`），默认根目录是 `~/.agents/skills` |
| 「negatives.jsonl、processed.json」 | ✅ 这两个存在，属于插件私有状态 |

### 5.2 为什么「全部替换为 storage.read/write」不是机械替换

`StorageAdapter` 的契约是**键 → JSON 文档**：

```
read(key) / write(key, value) / remove(key) / keys(prefix)
KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/     ← 键里不能有 '/'，不能表达目录树
```

而 memory 的真实存储模型是**四类不同的东西**：

| 类别 | 现状 | 能否进 storage |
|---|---|---|
| **技能** | `SKILL.md` 目录树，**默认在用户级共享目录** `~/.agents/skills`，人可手工编辑，别的工具也读 | ⛔ **不能**。内容非 JSON（Markdown+frontmatter）；位置在插件数据目录**之外**；键无法表达树 |
| **层文档** | `negatives.jsonl` / `facts.jsonl` / `experiences.jsonl`，**逐行追加** | ⚠️ 技术上可行，但**落盘格式变了**（JSONL→JSON 数组），老用户的文件需要迁移 |
| **键值小状态** | `processed.json`、`suggestions.jsonl` | ✅ 干净匹配 |
| **审计与隔离** | `.memory-audit.jsonl`（追加日志）、`quarantine/` 目录（移动/删除） | ⛔ 追加日志与目录搬迁都不是文档读写 |

### 5.3 硬做的代价

1. **改变落盘格式 = 改变行为**（红线 5）。`negatives.jsonl` 是逐行容错的（`readJsonl` 容忍半个尾行），换成单文档 JSON 后，一次撕裂就是**整个文件不可读**。
2. **技能一旦搬进 storage 就搬出了用户的世界**。`SKILL.md` 是这套记忆系统对外的**唯一可审计面**：人能打开、能改、能 diff。把它变成插件私有 JSON，等于把「记忆」从用户手里收走——这不是解耦，是功能倒退。
3. **约 80 条测试用例直接调用路径式 store API**（`appendNegatives(memoryDir, …)` 等 15 个文件），签名一变就要逐条改，回归面很大。
4. 会**同时存在两套存储世界**（技能在磁盘、层文档在 storage），比现状更难维护。

### 5.4 三个可选方案，请你选一个

| 方案 | 做法 | 代价 | 我的评价 |
|---|---|---|---|
| **A. 只搬「干净匹配」的那部分** | `processed.json` / `suggestions.jsonl` 走 storage；技能与 JSONL 层文档留在磁盘；**格式加迁移**（读旧→写新→备份旧） | 中：需要一次性迁移代码 + 兼容读；收益有限（这两个文件不是并发热点） | 可做，但收益最小 |
| **B. 给协议加「文本/分片」能力，再整体搬** | 给 `StorageAdapter` 增补中性能力（如 `readText/writeText` 或 `appendLog`），使 Markdown 与追加日志都能表达；然后迁移 | 大：协议扩张 + 迁移 + 80 条测试 | **如果目标真是「内核不残缺」，这是正解** |
| **C. 明确边界：技能与追加日志**按设计**留在磁盘** | storage 只承载「键值小状态」；把这条边界写进架构文档与测试守卫 | 小 | **我推荐**，但需要你确认这是接受的设计而非缺口 |

**我倾向 C，其次 B。** 理由：你说的「如果它继续直接使用 fs 读写，内核就是残缺的」——我完全同意**内核要有一条统一的、原子的、可恢复的持久化通道**；但「内核残缺」的判据不是「有没有 import node:fs」，而是「**同一份状态的并发与恢复有没有统一出处**」。
按这个判据：`processed.json` 与 `suggestions.jsonl` 确实应该进 storage（它们有并发写）；而 `SKILL.md` 的归宿本来就是用户的文件系统，它的问题不是「用了 fs」，而是「**没有租约保护**」——那个本轮已经提供了：`createStorageLeaseAdapter` + `withLease` 可以给**任何**临界区加锁，包括磁盘上的 SKILL.md 写入。

---

## 6. 阶段四：生命周期 / dispose

### 6.1 审计结果

| 插件 | 监听器 | 注册方式 | 清理 |
|---|---|---|---|
| `dsh-memory` | 1 个：`agent/pre-step` | `ctx.on?.(...)` | ✅ 框架副作用域内，随插件卸载回收 |
| `dsh-graft-slice` | 4 个：`agent/pre-step`、`agent/turn-stopping`、`agent/request-error`、`tools/pre-execute` | `ctx.on(...)` | ✅ 同上 |
| `dsh-observer` | 2 个：`session/event`、`graft/session-transferred` | `ctx.on?.(...)` | ✅ 同上 |

- **没有 `setInterval`**（三个插件全零），不会维持事件循环或泄漏定时器。
- 唯一的 `setTimeout` 是 graft 的空操作保活（`() => {}`），不持有资源。
- **没有任何监听器注册在「游离副本」上**：graft 有一个 `stableCtx = {...ctx, get(){...}}` 用于延迟绑定服务，它**继承了 `ctx.on`** ——如果有人在它上面注册监听器，框架永远不会回收。本轮用测试把这条钉死了。

### 6.2 新增护栏（三个插件各一份 `test/lifecycle-dispose.test.mjs`）

机械检查 `src/index.ts` 里**每一处 `.on(` 调用点**是否都落在插件自己的 `ctx` 上；任何其它形状直接失败并打印行号。
外加一条「不得存在模块级 handler 集合」的检查——那种数组会跨卸载存活，并在下次加载时重复注册。

---

## 7. 测试

| 包 | 本轮前 | 现在 | 说明 |
|---|---|---|---|
| `dsh-paradise` | 137 | **157** | 新增 `storage-lease.test.mjs`（17 条）+ 租约纯度守卫（1 条）等 |
| `dsh-graft-slice` | 543 | **545** | 新增 `lifecycle-dispose.test.mjs`（2 条）；docs 27 facts、bundle 27/27 |
| `dsh-memory` | 248 | **250** | 新增 `lifecycle-dispose.test.mjs`（2 条） |
| `dsh-observer` | 181 | **183** | 新增 `lifecycle-dispose.test.mjs`（2 条） |

paradise preflight：**17 项 dependent-facing 导出全在**（新增 `createStorageLeaseAdapter` / `withLease` / `LEASE_RELEASE` / `isLeaseExpired`），全部检查通过。

### 7.1 我发现的一处**既有**并发缺陷（不在本轮修复范围，但必须报）

`dsh-memory` 的 `lock.ts` 用 `mkdir` 做文件锁，然后往锁目录里写 `owner` 文件：

```
mkdirSync(lockDir)          ← 原子，抢到了
writeFileSync(lockDir/owner) ← 另一个进程的「过期锁回收」在这两步之间删掉了目录 → ENOENT → 该 worker 直接崩溃
```

**证据**：full-suite 跑 `v025-lost-update-multiprocess.test.mjs` 时偶发失败，报
`ENOENT ... negatives.jsonl.lock\owner`（8 进程争用）；单独跑 3/3 通过，全套重跑 248/248 通过。
即：**它是负载敏感的竞态，不是稳定失败**——所以「基线 248 全绿」这句话本身是不稳的。

这正是本轮租约要解决的问题（原子 CAS + 过期回收 + 有界等待）。但**迁移 memory 的锁会改变它的临界区行为**，属于行为变更，我没有顺手做。若你选 §5.4 的方案 B 或 C，建议把这条一起纳入那一轮。

---

## 8. 本轮改动的文件

```
新  dsh-paradise/src/protocol/lease.ts            中性租约类型 + 纯规则（无宿主词汇）
新  dsh-paradise/src/lease-adapter.ts             一份租约实现，两个宿主共用
新  dsh-paradise/src/lease.ts                     withLease：有界等待 + 必释放 + 陈旧检测
改  dsh-paradise/src/adapters/dsh/storage.ts      原子写 + 快照 + 自恢复 + readDetailed + compareAndSet
改  dsh-paradise/src/adapters/dsh/index.ts        组装 lease
改  dsh-paradise/src/adapters/memory/index.ts     内存宿主补 compareAndSet 与 lease（同一实现）
改  dsh-paradise/src/protocol/adapters.ts         StorageReadReport / compareAndSet / host.lease
改  dsh-paradise/src/protocol/index.ts            导出
改  dsh-paradise/src/index.ts                     导出 + 裸再导出（bundle 守卫要求）
改  dsh-paradise/scripts/preflight.mjs            4 个新导出纳入 backstop
改  dsh-paradise/test/isolation.test.mjs          白名单 + 「租约不 import 宿主」守卫
新  dsh-paradise/test/storage-lease.test.mjs      17 条：原子/恢复/互斥/竞争/fencing/有界等待
新  dsh-graft-slice/test/lifecycle-dispose.test.mjs
新  dsh-memory/test/lifecycle-dispose.test.mjs
新  dsh-observer/test/lifecycle-dispose.test.mjs
改  dsh-graft-slice/README.md / README.en.md      测试计数 543 → 545
新  dsh-graft-slice/REPORT-v0.4-foundation.md     本文件
```

---

## 9. 真机验收准备

四套测试全绿、paradise preflight 全过、三个 bundle 重建且与 src 一致。**可以重启做最终冷启动验收。**

建议验收顺序与观察点：

1. **冷启动**：插件全部加载，无 `ParadiseError` / `PROTOCOL` 类报错；
2. **切片一次**：目标只出现一次、点火卡片 `channel = sessionController.prompt`、目标自动开始运行（上一轮的三个观察点仍然有效）；
3. **存储恢复**（可选，值得做一次）：手工把某个 `lease-*.json` 或 plugin 数据目录里的 `*.json` 截断一半，再触发一次读取——应当看到「已回滚到上一个快照」的警告，且**数据还在**，而不是静默变成空；
4. **并发**：同时跑一次 harvest 与一次切片（两个后台任务），确认没有文件锁残留（`*.json.guard` 不应留在数据目录里）。

如果你要先解决 §5 的范围裁决，我建议顺序是：**先重启验收（确认本轮地基无回归）→ 再决定 A/B/C → 再动 memory 的存储与锁**。这样任何回归都能明确归因到其中一轮。
