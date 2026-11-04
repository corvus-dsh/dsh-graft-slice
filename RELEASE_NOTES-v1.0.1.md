# dsh-graft-slice v1.0.1

**发布日期**：2026-11-04
**测试**：530 / 530 通过 · `check-docs` 27 facts 一致

## 修的是什么

v1.0.0 之后，重启并打开两个控制台，**面板显示的全是默认值**：开关永远 OFF、点了也不变色（但弹出「已保存到全局配置」），转生控制台写着「当前推导：读取失败」。

### 一条 if 造成的全部症状

```js
const settled = await commands.execute(target, line, [], undefined)
const text = settled && settled.result && typeof settled.result.text === 'string' ? settled.result.text : undefined
if (text !== undefined) return { ok: settled.result.kind !== 'error', text, via: 'remote.commands.execute' }
if (settled !== undefined) return { ok: true, text: JSON.stringify(settled), via: 'remote.commands.execute' }  // ←
```

宿主返回的是 **CommandExecution `{ kind, text }`**，桥接却只认 `{ result: CommandExecution }`。于是落到第二行：**把命令信封本身当成了面板状态**，而且报了 `ok: true`。

面板拿到的 state 是 `{ kind: 'success', text: '{"config":…}' }` —— 没有 `config`、没有 `thresholds`：

- 开关：`checked = config ? config.x === true : false` → 恒为 false；乐观更新写进空对象，下次读又被同一个信封覆盖 → 「永远不变色」；
- 「已保存」提示是真的：Host 确实写进了 `cordis.patch.yml`，错的只是回读；
- 「读取失败」：`state.thresholds` 不存在。

**旁证**：面板显示的 `桥接通道：remote.commands.execute` 说明 `execute` 正常返回（抛错会是 `via: none`），只可能走了「stringify 信封」这条分支。

## 修复

`unwrapExecution()`：
- 容忍 3 层包裹（`result` / `value` / `execution`）与字符串化信封；
- **认不出的形状一律报错**（「无法识别的返回形状」），绝不再猜一个状态出来；
- 放在 `makeBridge` 内部——只有桥用它，而且 `test/v022-console-bridge.mjs` 正是把 `makeBridge` 抽出来单测的。

新增回归：
- `v1.0.1: the bare CommandExecution envelope is unwrapped into panel state`（两个 bundle 都测，输入就是真实形状）
- `v1.0.1: an unrecognised reply shape is an error, never panel state`

## 升级

`client.js` 由页面加载，**刷新页面即可**，不需要重启宿主。

---

# 追加：v1.0.1 的第二个 P0 与三个新特性（同一次发布）

## 面板从未读到过数据：`gateway/input-invalid | field=agentId`

截图里的真实报错。`remote.commands.execute` 的**第一个参数**在整个生命周期里被网关拒绝过，而前一轮的 `JSON.stringify` 兜底把它伪装成了「成功」。桥接现在**按序探测三种参数形状**（`{id}` / 裸 id / `{agentId}`），记住成功的那一种，失败时只报 `code` 与 `field`。

## 特性一：目标演进

- 目标记录新增 `currentGoal` 与 `goalEvolution[{at,from,to,reason}]`；
- 看板顶部同时显示「原始用户要求」（审计）与「当前目标」（指令），并注明「目标曾发生过 N 次演进」；
- 新工具 `graft_update_goal({goal, reason})`，只改调用会话自己的记录；
- 修复 `loadGraftTargetStore` 只回填 4 个字段、重启后丢失 `seedEvents` 与目标演进的问题。

## 特性二：Skill 的代次 + commit 降权

- `SKILL.md` 记录 `generation` / `commitHash`（来自目标表与 git，绝不来自模型）；
- 当前 HEAD 与记录不一致 → 分数 ×0.45（不丢弃），提示最前面加粗：
  `[此经验来自第 N 代的旧提交 …，当前为 …，请谨慎使用]`；
- commit 未知时不降权。

## 特性三：UI 健康徽章

两个控制台顶部各一枚：绿=真实宿主数据 / 琥珀=连通但推导缺失 / 红=通道未连通或宿主自报降级，`title` 直接给原因。

## 测试

`538 / 538`（+6 目标演进、+2 健康徽章），`check-docs` 27 facts 一致。
