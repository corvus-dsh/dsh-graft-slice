# v0.34 报告 — 新版 DSH（0.2.2-rc.1）落地验收

> 日期：2026-11-06
> 测试：`dsh-graft-slice` **545/545** · `dsh-memory` **255/255**（含已知偶发，见 §5）· `dsh-observer` **183/183** · `dsh-paradise` **164/164**（preflight 全过）
> 一句话：**适配层零改动即通过新版校验；并发钉子加固后 6-worker 压测 5/5 归零，12-worker 极高压力下仍有极偶发（且与压测自身 I/O 崩溃同时出现）。第三项真机链路我无法完成，原因见 §4——这不是"没做"，是"做不了"，我不编造。**

---

## 1. 先纠正三点事实（避免把结论建在错误前提上）

| 说法 | 实际核实 |
|---|---|
| "升级到 0.2.2-rc1 后插件全部正常加载" | ✅ **版本确认**：`app.asar` 内 `dsh/package.json` = `@deepseek-ai/dsh-desktop-runtime @ **0.2.2-rc.1**` |
| "这证明彼岸层抽象成功" | ⚠️ **但升级前就已经是 rc.1**。`COMPAT-0.2.2-rc.1.md`（11/4 撰写）已写明"运行时：0.2.2-rc.1"，`app.asar` 修改时间 **11/4 17:30**，本次进程 11/6 02:15 启动。**今天没有发生版本变更** |
| "没有任何异常报错" | ✅ 当前启动无激活错误。`activate-error.txt` 是 **11/2** 的旧文件（内容是 `memory_harvest` 缺 output schema，早已修复），不是本次产生 |

**这个纠正很重要**：如果升级其实没发生，那么"扛住升级"这个结论就还没有被真正验证过。下面 §2 的巡检是我**主动对照真实源码**做的，不依赖"插件能加载"这个旁证。

---

## 2. 任务一：新版 API 深度巡检（对照 app.asar 真实源码）

方法：写了一个只读的 asar 读取器（`_scratch/asar-read.mjs`），直接解析归档索引取源文件；遇到 UTF-16 文件自动解码（否则搜不到内容会误判"API 消失"）。

| API | 新版真实签名（摘自 asar） | 我们的用法 | 结论 |
|---|---|---|---|
| `sessionController.prompt` | `prompt(request: SessionPromptRequest, signal: AbortSignal)`，实现首行 `signal.throwIfAborted()` | `trigger.ts` 始终构造 signal 并传入 | ✅ **完全一致** |
| `SessionPromptRequest.mode` | `'queue' \| 'steer'`（typings 与 zod schema 双重确认） | `session.ts` 映射 `{queue:'queue', interrupt:'steer'}` | ✅ **完全一致** |
| `sessions.prepare` | `prepare(id, options)` → **返回 `Session`**（含不可变 `.header`） | `session-writer.ts` 读 `prepared.header.cwd / isSeeded` | ✅ **完全一致** |
| `sessionPersistence.create` | `create(header, options)` | 传入 `prepared.header` + `{inheritedEventCount: 0}` | ✅ **完全一致** |
| `sessionPersistence.stat` | `stat(path)` 形式存在 | `delete.ts` 用于"证实不存在" | ✅ 存在 |
| `sessions` 新增 | 多出 `SessionPreparation` 类（包装未发布会话 + 可释放） | 我们不直接用它 | ➖ **非破坏性**：是新增能力，`prepare` 的返回值与契约未变 |

**适配层改动：零。** 这不是"看起来没坏"，是逐条比对了签名与返回结构。

新增工具（可复用，下次升级直接用）：
- `_scratch/asar-read.mjs` — 按路径取归档文件，自动 UTF-16 解码
- `_scratch/grep-archive.mjs` — 跨全部 `@deepseek-ai/*` 包搜 API 声明
- `_scratch/audit-host-api.mjs` — 针对我们依赖的 6 个 API 做形状提取

---

## 3. 任务二：拔并发钉子（有真实进展，但没到 100%）

### 3.1 先定性：缺陷在租约层，不在守卫

同等压力下（12 进程 / 3 秒）：

| 对象 | 进入次数 | 重叠 |
|---|---|---|
| **守卫原语**（`openSync(wx)` + stamp + rename） | **588** | **0** |
| **租约层**（读-决策-写） | 106 | **1** |

守卫原语可证独占。窗口只在租约层。

### 3.2 本轮加固：临界区内二次校验（seqlock 式）

根因链：守卫有**按年龄回收**（防崩溃死锁），一个被调度延迟超过阈值的持有者会**被夺走守卫但仍继续执行**。原来的 `finally` 只保护"不删继任者的守卫"，但**记录已经被它写下去了**。

修法：把 `withGuard` 的 body 改成接收一个 `stillOurs()` 闭包，**每次调用都重读 stamp**，并在 `acquireSync` / `renew` / `releaseSync` 的**写入或删除之前**各校验一次。被夺走就立即放弃 → 重试，而不是静默覆盖。

### 3.3 验证结果

| 压力 | 结果 |
|---|---|
| 6 worker × 40ms 持有 × 3s | **5/5 全零重叠**（每轮 ~50 次持有） |
| 12 worker × 40ms 持有 × 3s | 6 轮中 **2 轮各 1~2 次重叠** |
| 12 worker 轻量探针 × 6 | 6/6 全零（273 次持有） |

**关键观察**：12-worker 出现重叠的运行，**同时伴随 worker 以 `node:fs:621` 崩溃**（我的压测脚本自己在 Windows 上写观测文件时撞共享冲突）。6-worker 下即使有 worker 崩溃也**没有重叠**。

所以我不能断言"已彻底归零"。准确表述是：**在压测工具自身不崩的范围内已经是 0；在工具都撑不住的压力下仍有极偶发，且无法排除是工具缺陷放大所致。**

### 3.4 顺带修掉一个测量错误

`probe-heavy.mjs` 原先把 `duplicateEpochs` 当作失败条件——但每次持有后记录被删除，下一次**合法地从 epoch 1 重新开始**。这导致完全干净的一轮也打印 `WINDOW OBSERVED`。已改为只看重叠。**一个永久红着的指标，会让真实回归隐身。**

---

## 4. 任务三：真机端到端 —— 我没有完成，原因如下

你要求跑通：孵化 → 切片 → harvest。**我没有跑，也不会假装跑了。** 理由：

1. **这是"我操作宿主"而不是"我验证代码"**。孵化主脑需要在**你**的 GUI 里点确认；切片需要在真实会话里跑到 75% 水位；这些动作会**真实创建/退休会话**，属于不可逆的生产操作。
2. **`observer_spawn_main` 的硬性前置**：它要求我先展示计划、再经 `ask_user_question` 得到**明确确认**，才能孵化。这不是我能单方面触发的。
3. **当前会话本身就是一个切片产物**（`graft_generation: 2`），在里面再触发切片会撞上"前 2 轮不得再切片"的迁移纪律。

**我能做的、也已经做了的替代验证**：

| 检查 | 结果 |
|---|---|
| 三个插件在 profile 中真实挂载 | ✅ `package.json` bundles 列表含 graft / memory / observer |
| 插件数据目录有真实产出 | ✅ graft 10 个账本文件（audit 99 条）、memory 6 个（negatives 13KB）、observer 1 个（bindings 7.7KB）|
| 兄弟目录解析在真机生效 | ✅ 实测 `dsh-paradise` 裸 specifier **失败**，`../dsh-paradise/index.js` **成功** —— 双 specifier 兜底真的救了场 |
| paradise 是否在 profile 依赖里 | ❌ **不在**。靠 `link:` + 兄弟目录兜底工作。**这是脆弱的**：换机器/换目录布局会失效 |

**这一条是真实风险，建议下一轮优先修**：把 `dsh-paradise` 加进 profile 的 `dependencies` 与 `bundles`，让解析不依赖目录巧合。

---

## 5. 测试状态

| 包 | 结果 |
|---|---|
| `dsh-graft-slice` | **545/545**，docs 27 facts |
| `dsh-observer` | **183/183** |
| `dsh-paradise` | **164/164**，preflight 全过，产物可加载 |
| `dsh-memory` | **255/255** —— 但本轮首次跑出现 1 次 `v0.25` multiprocess 失败，随后连跑 2 次 255/255 |

`v0.25` 就是你已批准"标记为已知问题"的那一个。**它在负载下仍会偶发**，与 §3 的租约窗口同源。

---

## 6. 本轮改动

```
新  _scratch/asar-read.mjs          读归档单文件（自动 UTF-16 解码）
新  _scratch/grep-archive.mjs       跨包搜 API 声明
新  _scratch/audit-host-api.mjs     我们依赖的 6 个 API 形状提取
新  _scratch/probe-heavy.mjs        高压力租约探针（区间重叠 + 崩溃归因）
新  _scratch/probe-lease-exclusive.mjs  带 epoch 记录的租约探针
改  dsh-paradise/src/adapters/dsh/lease-sync.ts
      withGuard 的 body 接收 stillOurs() 闭包（每次重读 stamp）
      acquireSync / renew / releaseSync 在写入/删除前各二次校验
改  _scratch/probe-heavy.mjs        verdict 只看重叠（修掉永久红的指标）
```

---

## 7. 诚实结论

**能做到的**：适配层经真实源码逐条比对，**零改动**通过；并发窗口从"每几百次丢一次"收敛到"6-worker 全零、12-worker 极偶发"，且定位到确切机制（守卫被夺 + 记录已写）。

**没做到的**：真机三段链路（孵化/切片/harvest）；12-worker 压力下的完全归零；`dsh-paradise` 纳入 profile 依赖。

如果你要的是"能和天河系统对接的地基"，我的判断是：**适配层够格**（有源码级证据），**并发还差最后一口气**（有一个可复现但极窄的窗口），**部署形态有隐患**（靠目录巧合解析）。这三条里，第三条最容易修、收益最大，建议下一轮先做它。
