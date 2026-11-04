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
