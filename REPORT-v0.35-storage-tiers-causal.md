# v0.35 报告 — P0 依赖修复、分层存储（L0/L1）、因果 Schema

> 日期：2026-11-06
> 测试：`dsh-graft-slice` **545/545** · `dsh-memory` **263/263**（+8）· `dsh-observer` **183/183** · `dsh-paradise` **174/174**（+10）· preflight 全过
> 一句话：**P0 已修（裸 specifier 实测可解析）；L0/L1 分层存储落地（50 并发零重叠且正确落盘）；四层因果 Schema 落地（时间单调、因果指针、反向链检索）。**

---

## 1. P0：依赖部署已修复（含一个关键发现）

| 你的要求 | 落地 |
|---|---|
| 加入 profile 依赖管理 | ✅ `dependencies['dsh-paradise'] = 'link:D:/workspace/dsh-paradise'`，原文件已备份 |
| 加入 `dsh.profile.bundles` | ✅ 且**排在 `dsh-graft-slice` 之前**（顺序即「层先于消费者加载」） |
| node_modules 软链接 | ✅ 用 **Junction**（SymbolicLink 需管理员权限，Junction 不需要） |

### 关键发现：只建 profile 的链接**不够**

第一次只建了 `profiles/desktop/node_modules/dsh-paradise` 后，从 profile 根能解析，但**从插件目录仍然失败**：

```
graft -> bare specifier: FAIL (ERR_MODULE_NOT_FOUND)
```

原因：Node 解析软链时走**真实路径** `D:\workspace\dsh-graft-slice`，于是去 workspace 根找 `node_modules`。

**所以还必须在 workspace 根建立 `node_modules`**，四个包各一个 Junction。补上后：

```
graft  -> bare specifier: OK
memory -> bare specifier: OK
```

这是"看起来修好了、实际没修好"的典型——如果只验证了 profile 根，就会交付一个仍然依赖目录巧合的修复。

---

## 2. 并发边界：已固化，不再死磕

`dsh-memory/ARCHITECTURE.md` 新增 **TD-M8**，记录：
- 已排除的 7 类原因（每条有证据）；
- 已确认的事实：**守卫原语 588 次进入 / 0 重叠**，窗口在租约层的读-决策-写；
- 已做的加固（`stillOurs()` 二次校验，6-worker 5/5 全零）；
- **归类为操作系统层面的文件系统极限**，并指向 L1 作为正解；
- 复查方式与**判据是「重叠区间数」而非「重复 epoch」**（后者每次持有后合法从 1 重开）。

---

## 3. 分层存储：L0 / L1

### 3.1 协议层（保持统一接口）

`StorageAdapter` 原有 `read/write/remove/keys/readDetailed/compareAndSet` **一字未改**，新增两项可选能力：

| 新增 | 作用 |
|---|---|
| `tier?: 'file' \| 'memory'` | 诊断用，让调用方知道哪个引擎在跑，**不得据此改变语义** |
| `transaction?(body, {retries})` | 多键原子性。读己之写；外部读到旧值直到 commit；抛错/abort 全部丢弃 |

### 3.2 L0（`file`）—— 现有实现，未动

原子重命名 + 快照恢复 + fencing 租约，全部保留，`tier: 'file'` 只是标明身份。

### 3.3 L1（`memory`）—— 新增 `src/storage-memory.ts`

| 机制 | 实现 |
|---|---|
| 互斥 | **纯内存对象**（Promise 链），无 I/O，故无窗口 |
| 持久化 | **write-behind** 防抖批量落盘（默认 50ms），`flushNow()` 可强制 |
| 事务 | 暂存区 + 提交时统一发布；`transactionQueue` 串行化 |
| **落盘不覆盖新写** | flush 期间写入的值**不会被误标记为已落盘**（否则是 flush 自己制造的丢更新） |
| **崩溃不空启动** | 构造时从 L0 快照加载，崩溃后回来的是最后持久状态而非空库 |
| **降级回 L0** | 锚点不可读 → 返回 file adapter + **具名警告**，绝不静默 |

### 3.4 配置开关

```js
parseStorageTier('memory')   // 'memory'
parseStorageTier(undefined)  // 'file'  ← 默认是安全的那一个
parseStorageTier('sqlite')   // 'file'  ← 未实现的 tier 回落到安全值
```

**默认 `file` 的理由**：memory 层在崩溃窗口内会丢写，这是相对 L0 的真实退化。配置写错时不该静默买到风险更高的模型。

### 3.5 验证（你指定的两项）

| 验证 | 结果 |
|---|---|
| 原有 164 条 paradise 测试全绿 | ✅ 现在 **174/174**（164 + 新增 10） |
| `storageTier: 'memory'` 下 50 次并发临界区 | ✅ **重叠 0，计数正好 50，且最终值正确落盘** |

> 附带修掉一个测试自身的错误：第一版断言"50 个并发应全部瞬间获取租约"，那只有**互斥失效**时才会成立。改为 `withLease` 有界等待——50 个调用者**依次**通过才是正确行为。

---

## 4. 四层因果 Schema

### 4.1 事实层：严格单调时间（物理迹）

`monotonicTimestamp()` 返回 `max(now, lastIssued + 1ms)`。**时钟跳回也不会让因果倒序**（NTP 校正、VM 还原、双机时钟差都是真实场景）。

**关键取舍**：历史记录**没有** timestamp 时，**不补造**。补造会伪造从未观测到的顺序证据。读取方看到的是"位置未知"，并在 `warnings` 里被告知。

### 4.2 经验层：cause / effect / action

```ts
cause?:  EvidenceRef   // 前置状态指针
effect?: EvidenceRef   // 结果状态指针
action?: string        // 中间做了什么
```

三者构成完整的一步因果。**可选**：只看到结果的会话没有可观测的"之前"，记录猜测比不记录更糟——它看起来像证据。

### 4.3 负知识 / 技能

| 层 | 字段 | 类比 |
|---|---|---|
| Negative | `blocked_condition` | 编译器的**停机断言**（谓词，不是建议） |
| Skill | `dependencies` | 宏展开的**前置事实指针** |
| Skill | `target_effect` | 宏展开的**预期结果** |

这三个字段会在 `SKILL.md` frontmatter 与 JSONL 中**真实读写往返**（有测试钉住），而不是只在类型里声明。

### 4.4 因果链检索（`src/causal.ts`）

```ts
causalChain(memoryDir, skillsDir, '重启开发服务器')
```

从**目标动作**反向拉取：Skill（谁声称能做）→ dependencies（前置）→ blocked_condition（谁禁止）→ Experience（为什么）→ Fact（底层证据）。**不靠词法重合**。

测试钉住了那个关键场景：**负知识的措辞与目标毫无共同词**，只因 `blocked_condition` 适用就被找到——这正是词法检索会漏掉、而漏掉就会重犯已知错误的情形。

---

## 5. 本轮抓出的三个真实缺陷（都由测试当场抓出）

### 5.1 `require` 在 ESM 里未定义，导致因果链**永远返回空**

`causal.ts` 最初用 `require('node:fs')` 读 JSONL，外层 `try/catch` 把 `ReferenceError` 吞成"这个文件没有记录"。**每一层都静默为空**，代码看起来完全合理。

这类缺陷只有测试能抓到，而它确实是被测试抓到的。已改为静态 import，`catch` 现在只容忍真实的读取失败。

### 5.2 中文匹配的碎片逻辑带着空格

目标 `"部署脚本 失败"` 从各偏移切片后**仍含空格**，因此永远不是句子的子串。症状是：事实文本里明明有"部署脚本"，却被判为不存在。改为**先按空白切分，再逐片匹配**（阈值 2 字，中文两字即有意义）。

### 5.3 两处重复对象键

`store.ts` 里 `domain` 在同一对象字面量中**声明了两次**（appendLayer 与 renderSkill 各一处）。第二次静默胜出，恰好值相同，所以从未失败——**直到有人只改其中一处**。已合并并加注释说明。

---

## 6. observer 的三条测试被更新，理由必须说清

P0 修复后，`dsh-paradise` 可以**裸 specifier 解析**了，于是三条旧测试失败，因为它们断言 `via === 'sibling'`（必须走兄弟目录兜底）。

**这是断言过期，不是代码回归。** 兄弟兜底存在的目的就是"裸 specifier 解析不了时仍能用"；现在能直接解析，说明目标达成了。若继续钉住 `sibling`，等于**要求退回脆弱状态**。

保留的核心性质：层必须解析成功，且回执必须**如实报告走了哪条路**。

---

## 7. 改动清单

```
P0   profile/package.json                      paradise 加入 dependencies + bundles（原文件已备份）
P0   profiles/.../node_modules/dsh-paradise    Junction
P0   workspace/node_modules/{4 个 junction}    让真实路径解析也能工作 ← 关键补充
新   dsh-paradise/src/storage-memory.ts        L1：内存 Map + write-behind + transaction + 降级
新   dsh-paradise/src/storage-tiers.ts         工厂 + 安全默认 + 降级报告
改   dsh-paradise/src/protocol/adapters.ts     tier + transaction + StorageTransaction（其余不变）
改   dsh-paradise/src/adapters/dsh/storage.ts  tier: 'file' 声明
新   dsh-paradise/test/storage-tiers.test.mjs  10 条（含 50 并发零重叠）
新   dsh-memory/src/causal.ts                  因果链反向检索
改   dsh-memory/src/extract.ts                 Fact.timestamp / Experience.cause-effect-action / Negative.blocked_condition / Skill.dependencies+target_effect
改   dsh-memory/src/store.ts                   单调时钟、因果字段读写往返、修两处重复键
改   dsh-memory/src/index.ts                   导出因果 API 与 store 写面
新   dsh-memory/test/v032-causal-schema.test.mjs  8 条
改   dsh-memory/ARCHITECTURE.md                TD-M8 已知并发边界
改   dsh-observer/test/paradise-bridge.test.mjs   3 条断言与时俱进
```

---

## 8. 诚实结论

**做到的**：P0 依赖修复（实测裸 specifier 可解析，含"只建 profile 链接不够"这一关键补充）；L0/L1 分层存储，含事务、write-behind、崩溃加载与降级；四层因果 Schema 与反向链检索，历史数据平滑兼容（`timestamp` 缺失即缺失，不补造）。

**没做到的**：三个插件**尚未接入** `storageTier` 开关（接口与实现已就绪，接线是下一步）；L1 的跨进程互斥**不成立**（它靠内存对象，只在单进程内互斥——多进程必须留在 L0）；因果链**只走一跳**，不做传递闭包（数据不支持，硬做会产生自信的胡说）。

**给天河的一句**：因果模型现在能回答"做这件事需要什么前置、谁禁止它、证据在哪"——这是调度协议可以直接消费的形状。但**跨节点的一致性**还没解决：L1 的互斥是进程内的，L0 的是文件锁，两者都不跨机器。天河若要多节点，那一层需要新设计，不能靠现有两档顶替。
