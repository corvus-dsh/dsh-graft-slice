# dsh-graft-slice v0.9.0 — 模型主动觉知，自己决定何时转生

> **主动交接 · 断点优先 · 崩溃可恢复**
>
> 一个 DeepSeek Harness 插件：上下文水位到 70% 时，**由模型自己**判断是否跨阶段、
> 自己收尾、自己发起切片；系统只在 75% 作为兜底。交接产物零继承、可冷恢复、
> 每一条事实都能按 seq 回读。

---

## 一句话

**把"宿主到点强杀"变成"模型主动觉知"——正在干活的人最清楚哪里可以停。**

v4.0 的 `autoGraft` 在 75% 无条件迁移。对长任务这是物理打断：正在写的句子、
刚发出的工具调用，都随之中断；目标会话还可能把上一轮读成"当前任务"。
v7.6 给模型预留 5% 安全余量，让它在安全点自己交接，同时保留 75% 的硬兜底。

## 一、水位变成三段

| 水位 | 行为 |
|---|---|
| < 70% | 不变 |
| ≥ 70% 且 < 75% | 注入一条提示（每轮最多一次）：模型可自行交接 |
| ≥ 75% | 系统兜底：`autoGraft` 强制迁移，逻辑一行未改 |

提示原文：

```text
[系统提示] 当前上下文水位已达 73%。如果你觉得当前任务需要跨阶段进行，
请先调用 graft_prepare 查看交接单；确认无误后，调用 graft_slice_and_inject 进行自我切片。
```

### 为什么先 `graft_prepare`、再 `graft_slice_and_inject`

- `graft_prepare` 只读：模型先看清目标 / 进度 / 约束 / 遗留 / 哈希，再决定；
- 真切割走**单步**路径：模型在两步之间只要继续干活，源会话就继续增长，
  prepare 时的摘要必然漂移，`graft_commit` 会报 `SLICE_DIGEST_MISMATCH`。
  单步路径现场重切，没有这个窗口。

### 提示的传递纪律

- 走 `agent/pre-step` 的 `messages` 通道：**不写日志、不占 step 号**，不与 v4 时序冲突；
- 每个 `turn` 最多一次，同一轮跑多少 step 都不重复；
- 只是提示，不是闸门：模型判断不需要跨阶段，可以继续执行。

## 二、Target 自启：不再开局等用户

每个切片产物的 `pending-state` 底部固定追加：

```text
[系统提示] 你刚刚完成了一次自我切片。请直接接着“当前任务”继续执行，无需等待用户确认。
```

`pending-state` 是预算裁剪中的 protected chunk，**压得再紧也不会被截掉**。
`modelDrivenGraft: false` 时，这条与 70% 预警一并消失，行为回到 0.8.x。

## 三、配置

```yaml
modelDrivenGraft: true        # 默认 true
modelDrivenGraftAtRatio: 0.70 # 预警水位，须低于 autoGraftAtRatio
autoGraft: true               # 兜底防线（建议保持开启）
autoGraftAtRatio: 0.75        # 兜底强切
```

两条边界规则（都已写进测试）：

1. **不静默钳制**：预警水位配到 ≥ 兜底线时窗口为空、永不触发——配置错了就是没有预警，
   而不是被悄悄改成"看起来能用"的值。
2. **兜底线按会话实际生效情况算**：`autoGraft: false` 或被 `autoGraftSessionIds` 排除的会话
   没有强制兜底，预警窗口延伸到 100%——否则模型会误以为"后面还有系统接住"。

## 四、主动交接不等于放弃控制

- 自助切片走**同一条物理路径**：零继承、写盘后冷读校验、退休源会话。
  主动模式只改变"谁先决定"，不改变产物形状与安全不变量。
- **从自己的开放轮里切走是允许的**：`locateBoundary()` 把切点放在最后一个 `turn/end`，
  开放轮以 `open-turn-carryover` 块带过去（用户原话、助手正文、已完成工具结果的指针）。
  v7.4c 补上了"用户刚发指令、模型还没回答"的形状——此前它会被整块丢弃。
- **兜底永远在**：模型忽略提示，75% 仍然强制迁移。

## 五、同版本线的两处关键修复

### 1. 开放轮携带（v7.4c）

水位命中常常发生在模型干活中途。旧防护只把"指针 + 助手正文"算作内容，
于是"只有用户指令、还没有助手回答"的开放轮被整块丢掉，目标会话把上一轮当成任务。
现在 `userTexts` 也算内容，并明确写出"这一轮尚未结束、没有助手正文"。

### 2. `phase-roadmap` 计入尾部块

v0.8.0 的节点计划块漏算进"尾部块"，导致 `graft_commit` 在摘要完全一致时仍报
`SLICE_DIGEST_MISMATCH`。修正后 commit 校验与真实切片一致。

## 六、继承自 0.8.x 的保证（未变）

- **崩溃可恢复**：`PREPARING → TARGET_FLUSHED → COLD_VERIFIED → COMMITTED` 四状态事务；
  启动扫描 `.txn/`，不变量 `sourceUsable ∨ targetUsable`；真实 `taskkill /F` 注入 7/7 通过。
- **跨代审计**：继承的 HARD CONSTRAINTS 在 pending 首行带来源锚点
  （第 N 代 / seq=Y / 必要时优先回读）。
- **来源判定只看人类**：`source.kind === 'user'` 才算用户指令；插件自述、系统注入、
  技能目录、时间戳一律不算。
- **已迁移源默认拒绝再切**，`allowReslice: true` 显式放行。

## 七、与 dsh-memory 的能力飞轮

```
dsh-graft-slice：让长任务物理上不断（上下文交接）
dsh-memory     ：让每一代经验上不丢（四层认知 + SKILL.md）
```

主动交接把断点从"系统随机选的位置"变成"模型选的安全位置"，交接单里的
PendingState / 约束 / 遗留因此更真实；退休的源会话又会被 dsh-memory 采成
Fact / Experience / Negative Path / Skill，喂给下一代。

**交接 → 记忆 → 更好的下一次交接**，这是"持久层能力架构"的闭环。

## 八、升级步骤

1. 更新插件 → 重建 `index.js` → **重启宿主**（宿主只加载启动时的构建）。
2. 确认 `autoGraft: true` + `autoGraftAtRatio: 0.75`；新字段可省略（默认已开启）。
3. 体验：到 70% 看提示 → `graft_prepare` 看交接单 → `graft_slice_and_inject` 切走 →
   新会话直接接着干。
4. 暂时不想让模型参与：`modelDrivenGraft: false`。

## 九、测试与文档门禁

```
node scripts/build.mjs          # 生成 index.js
node --test test/*.test.mjs     # 284/284
node scripts/check-docs.mjs     # 22 条事实一致
```

新增 `test/v76-model-driven.test.mjs`（10 条）：70% 注入、每轮一次、低于 70% 不注入、
关闭开关不注入、75% 强制兜底、无兜底时窗口延伸、排除会话窗口延伸、Target 自启文案、
默认值，以及**端到端**：收到提示 → 调 `graft_slice_and_inject` → 目标落盘含自启提示。

## 十、已知限制

- 水位来自宿主 `tokenMeter`（或日志 usage / 字符估算），`source` 字段会说明来源；
  估算模式下预警时机会有偏差。
- 70% 提示是建议：模型可以判断"还不需要交接"并继续，直到 75% 被强制迁移——
  这是设计内的兜底，不是故障。
- 75% 的强制迁移仍可能落在不理想时点；它是最后保险，不是常用路径。
- 未提交的冷目标无法被物理标注（宿主不提供 open-for-append），靠 `.graft-leftovers.json` 记账点名。

## 十一、隐私与安全

- 插件只读写本地会话日志与自己声明的 `dataDir`；不发起网络请求。
- 交接产物不含密钥、环境变量或宿主机凭据；运行时状态由目标会话自己的 agent loop 重建，
  不伪造 `request/header`、不复制权限事件。
- 文档与示例中的路径均为占位符或虚构工作目录。