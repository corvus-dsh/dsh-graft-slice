# dsh-graft-slice v0.8.0 — 让长会话活着交班

> **自我切片 · 跨代审计 · 崩溃可恢复**
>
> 一个 DeepSeek Harness 插件：在上下文中断之前，把「正在做的事」切成一份零继承的交接会话——
> 不压缩、可回查、可撤销；即使进程被 `taskkill /F` 杀掉，也有一个状态机替你收尾。

---

## 一句话

**把 14,978 个事件的会话，压缩成 14,252 个字符的「断点」——然后让下一个窗口接着干，而不是重新学。**

真机实测：源会话 48 轮 / 9.5 MB 压缩日志，交接会话注入 1 轮封闭骨架 + 8 个回顾块，
包含 Goal、Task Status、Workspace Files、Pending State、可回读索引与断点块。
新会话在**零澄清提问**的情况下接上了工作。

## 这次发布的三个真本事

### 1. 自我切片（self-graft）

插件可以在**自己所在的会话里**完成迁移：

```
graft_prepare  →  看摘要（目标 / 进度 / 约束 / 遗留 / 哈希）
graft_commit   →  校验 preparedId、哈希、边界 seq 未漂移，才写盘并退休源
```

- **边界硬校验**：自嫁接时源会随着每次工具调用增长，判定看的是**边界 seq**（决定磁带结构的点），不是最后事件；
- **尾部刷新**：开放轮在审核后又长了一段？允许提交，但结果里明说
  `open-turn-carryover changed while the review was open (277 → 370 chars); the committed tape is newer than the one you approved.`

### 2. 跨代审计（cross-generation audit）

约束是逐代复制的，读到「HARD CONSTRAINTS」时没人知道它是不是这一代用户刚说的。
v7.4 在 pending 第一行钉一个锚点：

```
[高优锚点] 核心约束源自第 1 代会话（session-…），seq=2282，必要时请优先回读。
下面这段 HARD CONSTRAINTS 是插件从用户原话抽取的副本，不是这一代用户刚刚说的。
```

来源判定**只看人类 `user/message`**（`source.kind === 'user'`）——
插件自述、系统注入、技能目录、时间戳一律不算「用户指令」。

### 3. 崩溃可恢复（crash-safe transaction）

迁移被拆成四个可恢复状态，先写日志再动磁盘：

| 状态 | 含义 |
|---|---|
| `PREPARING` | 目标 id 可能已占用，可能是空壳 |
| `TARGET_FLUSHED` | 目标内容完整，未经冷读校验；源未退休 |
| `COLD_VERIFIED` | 目标可用；源仍未退休 |
| `COMMITTED` | 完成，记录删除 |

启动时扫描 `.txn/`：**让源可用、让目标诚实**，且幂等。
不变量：任何时刻 `sourceUsable ∨ targetUsable`。

## 崩溃注入实测（真实 `taskkill /F`）

在独立进程里跑真实插件代码 + 磁盘存储，父进程在指定阶段杀进程，每个场景跑两次恢复扫描：

| 场景 | 注入点 | 结果 |
|---|---|---|
| L1a | `create` 后 / `append` 前 | 源可用，目标 0 事件，日志回收 |
| L1b | 半截写入后 | 源可用 |
| L1c | `flush` 后 / 冷读前 | 源可用 |
| L2a | `flush` 抛 `ENOSPC` | 失败被记录，源可用 |
| L2b | ACL 拒绝写目录 | `create` 阶段失败，源可用 |
| L3 | 落盘数据被篡改 | 冷读拒绝，源可用 |
| L4 | 两进程同目标 id 并发 | **恰好 1 个成功** |
| L5 | 恢复扫描跑两次 | 第二次 `scanned=0` |

**7/7 通过。** 这轮测试还揪出一个静默 P0：恢复扫描用的 `readdirSync` 从未被 import，
`catch {}` 把 `ReferenceError` 变成「扫到 0 条」——事务日志写了一整版，恢复从来没真正跑过。
已修，并补上真正读取 journal 的回归测试。

## 其他 v7.4 改动

- **断点优先于状态**：开放轮 carryover 注入在最前，并注明它是「各步最终段落按时间拼接」，不是一条完整消息；
  pending 若与断点冲突，明说「这一项可能已经做完了，先核对，不要直接重跑」。
- **检索修复**：`[Workspace Files]` 改为引用 **tool/result 的 seq**（此前引用 `tool/call`，回读会得到 `No payload`）；真机 8/8 可读。
- **子代理报告去噪**：关键词必须落在结果开头，排除文件/日志转储；只保留最近 5 条。
- **已迁移源禁止再切**：默认拒绝，`allowReslice: true` 显式放行（此前同一源产出过 3 个 target）。
- **`autoAdaptiveTier`**（默认关）：有未完成 todo 或最近失败 → 回退 1 轮重放。

## 验证

```
node scripts/build.mjs         # 生成 index.js（397,206 B）
node --test test/*.test.mjs    # 265/265
node scripts/check-docs.mjs    # 文档与代码 22 项事实一致
node ../graft-e2e/crash/run.mjs # L1-L5 崩溃注入 7/7
```

## 已知限制

- **未提交的冷目标无法被「物理」标注**：宿主不提供 delete / open-for-append，`[损坏]` 标题只能写给活动会话。
  flush 之后崩溃会留一个内容完整但未提交的目标；v7.4 起用 `.graft-leftovers.json` 记账并在下一次 review 里点名，
  但用户不看摘要、直接续接它仍会造成分叉。这是 v7.5 的第一件事。
- 零重放（A 档）对「依赖早期结论」的任务是否够用，仍只有 n=1 的数据。

## 安装

```
# 插件目录放入 DSH profile 的 node_modules（或 junction 指向你的工作副本）
# 配置示例见 cordis.patch.yml：dataDir / recentTurns / adaptiveDepth / autoGraft
```

宿主版本：DeepSeek Harness 0.2.1-rc.5（Windows 桌面端）。
所有宿主行为均直接读取自 `app.asar` 真实源码，非推测。