# v7.7 报告 — 第二阶段：graft-slice 接入彼岸层（Dogfooding 第二轮）

> 日期：2026-11-05
> 版本：`dsh-graft-slice 1.0.1`（**542 / 542 全绿，数字未变**）· `dsh-paradise 0.3.0`（129 → **137**）· `dsh-observer 1.8.0`（**181 / 181**）
> 结论：**创建、写入、冷读校验、回滚、点火通道全部经 `dsh-paradise`；旧内联实现作为回退路径保留且未被触发。**
> 产物：`index.js` 697,142 字节，8 个内联模块；docs 27 项、bundle 27 项全过。

---

## 1. 你要的替换，逐条对照

| 你的指令 | 实际落地 | 证据 |
|---|---|---|
| `prepare + create + append + flush + close` → `paradise.session.create({cwd, items})` | ✅ 一整段换成一次调用，tape 通过 `tape` 字段整体交入 | `v200-graft-switch.mjs` §1：`layer create() calls 1` |
| 失败回滚 → `paradise.deleteSession(ctx, id, why)` | ✅ 冷读失败路径改走层；层不可用时回落到旧 `discardPartialTarget` | 同脚本 §4：`binding exposes deletes function` |
| `igniteTargetSession` 发起请求 → `paradise.session.trigger` | ✅ 通道段整体替换，graft 的外围策略（准入图 / 重试 / 种子增长 / 队列 / 回滚）全部保留 | `v200-ignition-switch.mjs` §1、§2：`layer trigger() calls 1` |
| 保留 graft 私有策略包装 | ✅ 准入 map、`targetAlreadyLive`、`targetAlreadyDriven`、pending 队列、`rollbackFailedIgnition` 一行未动 | 542 条测试内含 40+ 条点火/回滚专用断言 |
| 542 条全绿 | ✅ **542 / 542** | 见 §6 |
| 构建产物纯净 | ✅ docs 27 facts、bundle 27/27、`node --check` 无错 | 见 §6 |
| 0.2.2-rc1 是否有破坏性变更、adapters/dsh 是否只需改一两处 | ⚠️ **有，且正好就是「一两处」，但两处都在 adapters 里** | 见 §5 |

---

## 2. 一个必须先说的发现：**本轮开始时基线是红的**

上一代窗口在切片前正处在编辑中途，留下的状态是 **542 条测试里 104 条失败**，全部同一个错误：

```
[SEEDED_HEADER] GRAFT_ERROR: migrated header must be unseeded
```

根因：预写校验 `assertColdLog` 收到的合成 session 只有 `{ cwd }`，而它内部会调 `assertTopLevelHeader`，
要求 `isSeeded === false`。也就是说**每一笔迁移都在写出第一个字节之前就被自己的校验拒了**。

我把它修成「合成的 header 要描述层即将创建的那个 header」——补上 `isSeeded: false` 与 `id`/`createdAt`。
这不是重构引入的，是重构**暴露**的：v7.6 把校验搬走时，合成对象没有跟着改。

---

## 3. 四个协议缺陷：全部是「调用方的事实被当成宿主的规则」

这一节是本轮真正的产出。四条都不是 graft 写错，而是适配器把**第一个消费者（observer）的约定**当成了通用规则。

### 3.1 `isSeeded` —— 预写校验的合成 header 少了这一位

见 §2。104 条 -> 440 条。

### 3.2 可见消息的 `source.kind` —— `'user'` 是 observer 的约定，不是宿主要求

```ts
// 适配器原来的规则
if (briefingMessage?.source?.kind !== 'user') fail('RED_LINE_BRIEFING_SOURCE', ...)
```

graft 的回放 tape 里，承载目标的那条 `user/message` 是 `plugin:graft-replay` —— **故意如此**：
下一次切片重放日志时，插件自己写的话绝不能被读成用户下的命令。适配器把它拒了。

修法：把「合成路径」与「调用方 tape 路径」分开。宿主级规则仍对**两者**生效（必须带非空 `source.kind`、绝不能伪造 `rpcId`），
但「必须写成 `'user'`」只对**本适配器自己合成**的消息成立。

### 3.3 `assistant/message` 回显 —— 回显是「可见内容的双写约定」，不是宿主要求

同一类错误的第二个面。回显（user/message + assistant/message 双写）是 observer「把方案同时放进渲染面与模型面」的做法。
graft 的回放 tape 里**故意没有**回显：一条合成的 assistant 消息会被下一轮切片当作模型真的说过的话重放。

更糟的是原规则还会去 tape 里找**第一条** `assistant/message` 并要求它的文本等于目标文本 —— 在回放 tape 里那是一条历史消息。
修法：整段回显契约只在 `composed: true` 时校验；**宿主级**的 assistant 规则（`stream: []`、role、producer-owned source kind）对任何 tape 都仍然强制。

### 3.4 `prompt` 的 marker 与 mode 词 —— 最贵的一条

| 项 | 适配器默认 | graft 实际 |
|---|---|---|
| marker | `[dsh-observer 点火]` | `[dsh-graft-slice 点火]` |
| mode | 协议词 `interrupt` | 宿主只认 `steer` |

如果直接替换：

- marker 不符 → 幂等检查在目标日志里永远找不到自己的 mark → **每次重试都把同一条指令再发一次**，目标把它读成两轮用户意图；
- mode 词不符 → 宿主要么拒绝，要么按未知词处理，而回执只会说「未被接受」，看起来像通道坏了。

修法：这两个都是**调用方的事实**，加进协议（`TurnTrigger.marker` / `TurnTrigger.fallbackModes`），
并把「协议词 → 宿主词」的翻译放在唯一同时知道两边词汇的地方（`adapters/dsh/session.ts`：`{ queue: 'queue', interrupt: 'steer' }`）。

---

## 4. 三个我自己引入、又被自己的验证抓出来的缺陷

这一节比上面更重要：**它们都是「测试全绿但行为已坏」的那一类**。

### 4.1 桥接按 ctx 缓存 —— 60+ 条测试报 `session "<id>" not found`

第一版 `ensureParadiseWrite` 无条件缓存解析结果。桌面端一个进程只有一个 ctx，所以永远看不出问题；
测试里每个用例建自己的宿主，于是**第二个用例拿到第一个用例的适配器**，写进了已经不存在的持久层。

修法：按 ctx 缓存。缓存的收益只在「同一个 ctx」成立，那就只在那里缓存。

### 4.2 重复发布 —— 每个目标在工作区挂载两次、在侧边栏通告两次

层和插件都能做「挂工作区 + 发 `api-session/added`」，两边都做了。
修法不是让一边别做，而是把「发布」变成**可委派**的：`CreateRequest.publish`（默认 true），
由**拥有那份回执语义**的调用方声明 `publish: false`（graft 要报 `workspace.id`、把拒绝写成 warning、并在同一时刻给源会话打 `[已转移]`）。

### 4.3 `resetParadiseWriteCache` 的预置从未生效 —— 而它恰好是「层缺失」测试的唯一入口

这是最阴的一个。我的端到端脚本第 3 节本应证明「层被拒绝时迁移必须具名失败」，结果打印：

```
refused with   tool returned ok=true (NO refusal — the layer was bypassed)
fallback writer used instead   YES — BAD
```

不是回退路径被触发了，而是**测试预置根本没被读到**：`resetParadiseWriteCache(prime)` 把值放进缓存槽，
但按 ctx 比对时那个 ctx 还不存在，于是桥接直接去解析**真实的层**并成功。
一个不生效的测试接缝，比没有更坏 —— 它会为它本该证伪的东西背书。

修法：预置放进独立槽位，**给下一个 ctx 用，且只用一次**（下下个 ctx 会走真实解析，防止把 mock 当成出厂行为）。
修完后同一条输出的正确形态是：

```
refused with   PARADISE_WRITE_UNAVAILABLE
artifacts left behind   0
fallback writer used instead   no
```

---

## 5. 关于 0.2.2-rc1：有变更，且正好落在 adapters 里

先说方法边界：**我无法联网核对官方 changelog**（本会话的 web_search 无 API key，npm 页面 403）。
所以下面不是「rc1 的更新日志」，而是**从本仓库的兼容性记录与本地宿主源码反推出的、与本轮改动直接相关的两处**。
如果你要的是官方发布说明，这一条我没能取到 —— 这是缺口，不假装已读。

这两处的来源是 `COMPAT-0.2.2-rc.1.md` §1.3（该文件自身记录的是 0.2.2-rc.1 环境的实测）：

1. **`prompt(request, signal)` 的 `signal` 是必填**，宿主首行 `signal.throwIfAborted()`。
   插件曾长期传 `undefined`，表现为「每次点火在写入任何事件前崩溃，目标永远静止」。
2. **`prompt` 的 `mode` 词汇是 `'queue' | 'steer'`**。

对你的问题「adapters/dsh 是否只需改一两处就能兼容」，答案是 **是，但恰好是两处，而且都在 adapters 内、不需要协议改动之外的返工**：

| 改动点 | 位置 | 是否影响解耦能力 |
|---|---|---|
| 协议词 `interrupt` → 宿主词 `steer` | `adapters/dsh/session.ts` 一处字典 | ✅ 正是解耦生效的证据：协议保留中性词汇，宿主词汇只活在 adapter 里 |
| marker 由调用方传入 | `adapters/dsh/trigger.ts`（`options.marker`）+ 协议 `TurnTrigger.marker` | ✅ 调用方方言留在调用方，层不理解「谁的点火」 |

**这恰好验证了彼岸层的护城河**：宿主换词，改的是 adapter 的一张映射表；插件一行没动。

---

## 6. 测试与产物

| 包 | 测试 | 其他检查 |
|---|---|---|
| `dsh-graft-slice` | **542 / 542**（与基线数字完全一致） | docs 27 facts、bundle 27/27、`node --check` 干净 |
| `dsh-paradise` | **137 / 137**（129 → 137，新增 8） | preflight 13 项全过 |
| `dsh-observer` | **181 / 181** | — |

新增 `dsh-paradise/test/caller-contract.test.mjs`（8 条），每一条都是上面某个缺陷的**回归钉**：

| 用例 | 钉住什么 |
|---|---|
| marker 被前置，且不掺入层的 marker | 调用方方言不被覆盖 |
| 同一个 marker 就是幂等检查搜索的串 | 暖目标不会被再发一次 |
| `interrupt` 在线上变成 `steer` | 协议词不出门 |
| `queue` 两边拼写一致 | 防止下一次改词改错方向 |
| 默认：被拒的 queue 会以 interrupt 重试 | 保底行为没被误删 |
| `fallbackModes:false` 时拒绝就是失败 | 调用方的「不升级」策略被尊重 |
| 默认发布：挂工作区 + 通告 | 默认行为没退 |
| `publish:false`：两者都不做 | 重复发布不再发生 |

---

## 7. 两个端到端探针（在 `_scratch/`，不进包）

`v200-graft-switch.mjs`：

```
layer create() calls                  1
refused with                          PARADISE_WRITE_UNAVAILABLE
artifacts left behind                 0
fallback writer used instead          no
carrying message source               plugin:graft-replay
contains a tool/result                false
cwd matches source                    true
```

`v200-ignition-switch.mjs`：

```
prompts admitted                      1
mode on the wire                      queue
prompt leads with graft marker        true
AbortSignal passed                    true
receipt channel                       sessionController.prompt
layer trigger() calls                 1
protocol word "interrupt" on the wire no
```

这两张表是「**真的走了层**」的凭据，不是「测试还是绿的」的凭据。

---

## 8. 本轮改动的文件

```
改  dsh-graft-slice/src/index.ts                    调用点：create / rollback / trigger 参数 / 桥接再导出
改  dsh-graft-slice/src/core/paradise-write.ts      按 ctx 缓存 + 预置槽 + trigger 面
改  dsh-graft-slice/src/core/ignition.ts            通道段换成层调用；marker/mode 方言保留
改  dsh-graft-slice/test/inject.test.mjs            一处错误文案（行为未变，见 §9）
改  dsh-paradise/src/adapters/dsh/inject.ts         composed vs caller-tape 两类契约分开
改  dsh-paradise/src/adapters/dsh/session-writer.ts publish 可委派；冷读沿用同一契约
改  dsh-paradise/src/adapters/dsh/trigger.ts        marker / fallbackModes / remote 解析修复
改  dsh-paradise/src/adapters/dsh/session.ts        协议词→宿主词映射
改  dsh-paradise/src/protocol/adapters.ts           CreateRequest.publish
改  dsh-paradise/src/protocol/types.ts              TurnTrigger.marker / fallbackModes
新  dsh-paradise/test/caller-contract.test.mjs      8 条回归钉
改  dsh-graft-slice/ARCHITECTURE.md                TD-1/6/7 更新 + 新增 TD-8
新  dsh-graft-slice/REPORT-v7.7-paradise.md         本文件
新  _scratch/v200-graft-switch.mjs                   端到端：写入确实经层
新  _scratch/v200-ignition-switch.mjs               端到端：点火确实经层
```

---

## 9. 唯一一处「改了测试」的说明（请你复核）

`test/inject.test.mjs` 里那条 lineage 用例，原来断言的是 graft 自己的错误串：

```js
/GRAFT_ERROR: lineage must be empty/
```

现在 `sessions.prepare` 由层调用，拒绝串变成层的 `LINEAGE_NOT_EMPTY`（且带 `@prepare` 阶段）。
**行为完全没变**——迁移仍被拒、仍不留下任何产物—，变的只是这条消息的归属。
我把断言放宽成 `/LINEAGE_NOT_EMPTY|GRAFT_ERROR: lineage must be empty/u`，并在测试里写清了理由。

这是本轮**唯一**一处测试改动。其余 541 条一行未动。如果你认为错误文案本身也是契约的一部分，
需要把 `LINEAGE_NOT_EMPTY` 映射回 graft 的旧串——那是一个明确的取舍，我按你的判断改。

---

## 10. 下一步（等你重启真机验收）

按你说的，现在可以重启并做一次真实切片验收了。验收时值得盯的三件事：

1. **侧边栏**：新会话出现**一次**（不是两次）——§4.2 的重复发布已修；
2. **卡片**：`点火` 卡片里 `channel` 应为 `sessionController.prompt`（不带 `(queue)` 后缀）；
3. **自动点火**：目标会话自己开始干活，且 `report.ignition.ok === true`。

若出现「目标会话出现但不动」，第一件事看 `.graft-audit.jsonl` 最后一条 `ignite` 的 `detail`：
它会说明是 **no-channel**、**refused**、还是 **timeout** —— 这三个现在彼此可分（TD-5 的可观测性因此部分达成）。

---

## 11. 一个我必须如实报告的**既有**红线偏离（不是本轮引入）

在核对本轮改动是否符合你的硬约束时（约束 3：「不要用 `live.append`，也绝对不要用 `{turn: 0, step: 0}`」），
我在**我没有改过的**一段代码里找到了这个：

```
dsh-graft-slice/src/core/ignition.ts:894   live.append('developer/message', {
dsh-graft-slice/src/core/ignition.ts:896       turn: 0,
dsh-graft-slice/src/core/ignition.ts:897       step: 0,
```

这是**回滚通知**（`ROLLBACK_NOTICE`，告诉用户「点火失败已回滚到当前会话」）写进源会话的那条日志。

### 为什么它不是本轮引入的

| 证据 | 结论 |
|---|---|
| `src/core/ignition.ts.bak-cut`（v7.6 切割前的基线备份，**2026-11-05 22:35**）第 605–606 行已有 `turn: 0` / `step: 0` | 早于我本轮的第一次编辑（23:59） |
| 本轮我对 `ignition.ts` 的改动只发生在「通道段」（`request()`/channels 那 40 行）与文件头注释 | `rollbackFailedIgnition` 一行未动 |

### 为什么我没有顺手改掉它

按你的红线 5（**绝对不能因为重构改变了行为**），这不是「重构」，是**行为变更**：
那条 `developer/message` 是回滚通知唯一能到达模型/用户的通道之一，换个写法（或走 pre-step `messages`）
会改变「回滚之后用户看到什么、模型下一轮知道什么」。这属于需要你拍板的取舍，不属于重构可以顺手做的事。

### 需要你判断的点

`{turn: 0, step: 0}` 在**结构上**是合法的（宿主 `SessionEventMap` 里 `developer/message` 要求 `turn`/`step` 两个 number），
问题在于**语义**：`turn: 0` 不是一个真实发生过的轮次。宿主是否接受、以及它被折叠进投影时会不会被当成第 0 轮，
**我无法在不真机验证的情况下断言**。三个选项：

1. **保持现状**（风险：若宿主拒绝 `turn: 0`，回滚通知静默丢失 —— 但它是 best-effort，不会让迁移失败）；
2. **改成 pre-step `messages` 通道**（回滚通知不落日志，只在该会话下一轮模型请求时出现，且不消耗 step 号）——
   这更符合「不要用 live.append」的精神，但**会改变可观测性**：日志里不再有这条记录，你的 `.graft-audit.jsonl` 之外的取证会少一份；
3. **改成写 `turn: <当前真实轮次>`**（需要先读源会话日志拿到当前轮次，多一次 I/O，且写活在正在运行的会话上）。

我倾向 **2**，但那是一次独立的行为改动，应当单独一轮 + 单独真机验收，不混在这轮 Dogfooding 里。

---

## 12. 附：⑪ 已按你的决定修完（同一轮内的追加改动）

你选择了 **选项 2（pre-step `messages` 通道）**，并指出这个写法的隐患是「必然触发 `SessionFormatError`」。
已执行，改动如下。

### 12.1 做了什么

| 项 | 之前 | 现在 |
|---|---|---|
| 通知的落点 | `live.append('developer/message', { turn: 0, step: 0 })` 写进源会话日志 | 登记进 `rollbackNotices`（按源会话 id 的队列） |
| 投递通道 | 日志事件 | 源会话自己的 `agent/pre-step` 返回的 `messages` |
| 消耗 step | 会（伪造第 0 轮） | 不会，什么都写不进日志 |
| 幂等 | `rollbackNoticed` 集合 | 同一集合 + **TAKE 语义**（取出即删） |
| 角色 | `developer` | `user` + `[系统提示]` 头部（与既有约束注入同一形状） |

新增/改动的符号：`takeRollbackNotice(agentId)`（导出，供 pre-step 与测试直接调用）、
`IgnitionDeps.rollbackNotices`、`index.ts` 的 `rollbackNotices` 与 `resetRetiredSessions()` 里的清理。

### 12.2 三条性质，每条都有测试钉住

`test/v021-ignition-rollback.test.mjs`（7 → 8 条）：

1. **投递到模型**：源会话下一次 `pre-step` 返回的 `messages` 里**有且仅有 1 条**通知文本，且逐字等于 `ROLLBACK_NOTICE`；
2. **不写日志**：`ctx._sourceDeveloperAppends.length === 0` —— 断言里点名了「那个事件需要 `turn:0/step:0`」；
3. **一次性 + 按源会话寻址**：第二次 `pre-step` 不再有；`takeRollbackNotice('某个无关会话')` 返回 `undefined`。

第 3 条是新增的独立用例。它钉的是**机制**而不只是行为：如果把 `take` 写成 `get`，
恢复后的会话会每一步都被告知「迁移失败过」，模型会为一个已经解决的错误反复道歉。

### 12.3 端到端证据（`_scratch/v210-rollback-notice.mjs`）

```
rollback.sourceRestored                         true
rollback.noticeAppended (queued)                true
developer/message appends to source             0
rollback notices injected                       1
injected text === ROLLBACK_NOTICE               true
injected role (must be user, not developer)     user
notices on the 2nd step                         0
target events carrying turn 0                   0
developer/message events in the SOURCE log      0
```

### 12.4 一处需要你知道的**可观测性变化**

通知不再落在日志里，所以它**事后不可取证**：`.graft-audit.jsonl` 里仍有
`"kind":"ignite-rollback"` 与 `sourceRestored=true`，但「用户到底被告知了什么」不再有事件可查。
`out.noticeAppended` 的含义因此从「盘上有这条事件」变成「通知已入队待投递」——注释与审计行都改成了这个措辞。
这是这次换通道**必然的代价**，不是遗漏。

### 12.5 顺带查清：剩下的 `live.append` 是不是同类问题

grep 出另外 4 处 `live.append`，逐一核对：

| 位置 | 写什么 | 是否同类 |
|---|---|---|
| `index.ts:6946 / 8033 / 8604 / 10844` | `session/title`（`messageSeqs: []`） | ❌ 不是。无 `turn`/`step`，是宿主的合法日志事件写法 |
| `index.ts:10840` | `developer/message` 转场卡 | ❌ 不是。用的是**真实打开的** `open.turn` / `open.step`，且写入前跑 `validateAppendIsLifecycleSafe(events, card)` 预检 |

所以只有回滚通知那一处是伪造轮次。其余四处保持原样——改它们属于「为改而改」，会动到已经被测试锁住的转场与标题路径。

### 12.6 本轮最终数字

| 包 | 测试 | 说明 |
|---|---|---|
| `dsh-graft-slice` | **543 / 543** | 542 条原有全部保留 + 1 条新增（一次性/按源寻址）；docs 27 facts、bundle 27/27 |
| `dsh-paradise` | **137 / 137** | 未改动 |
| `dsh-observer` | **181 / 181** | 未改动 |

README（中/英）的测试计数已同步到 543 —— 这是 `check-docs.mjs` 的「文档数字必须等于真实数字」抓出来的，不是我主动改的。
