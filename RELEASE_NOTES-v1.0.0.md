# dsh-graft-slice v1.0.0

**发布日期**：2026-11-04
**兼容基线**：DeepSeek Harness 0.2.2-rc.1
**测试**：527 / 527 通过 · `check-docs` 27 facts 一致 · `node --check` 通过

---

## 这个版本解决什么

三个 P0，全部是「发生在真实宿主里、而单元测试看不见」的那一类——测试替身比契约更宽松，于是用例常绿、功能常死。

### P0-1 切片写入失败：`cannot append outside a SessionStore`

**症状**：物理切片在真机上永远抛 `cannot append outside a SessionStore`，目标会话从未被创建。

**根因**：`SessionHandle.append` 只在活跃 `SessionStore` 上成立；冷目标没有 store，而切片走的是 `prepared.append`。

**修复**：`materializeTape` — 把切片内容直接物化进目标 tape，目标全程保持 **COLD**，由宿主的冷恢复路径加载，不再借用活跃 store 的写入口。

### P0-2 自动点火失效（两处）

**(a) `signal` 是必填参数。** 实时契约：

```ts
@Remote('prompt') async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
```

Host 第一行就是 `signal.throwIfAborted()`，而我们一直传 `undefined` → `Cannot read properties of undefined (reading 'throwIfAborted')`。编译期看不出来（`.ts` 走 Node 类型剥离，没有 typecheck），运行期只留一行审计。

**修复**：`ignitionDeadline()` 为每次点火建真实 `AbortController`，signal 兼作 20s 超时载体，两个通道（`sessionController.prompt` / `remote.session.prompt`）都收到真实 signal。

**(b) 读不到日志被当成「已经点过火」。** `alreadyIgnited()` 的 catch 分支 `return !/not found|enoent|no such/.test(msg)`：①0.2.2 的错误码是 `session/not-found`（连字符），正则匹配不到；②默认值反了——`readSession` 在 replay 校验失败时会 throw，而目标 live 且正在跑时这属正常。

**修复**：`SESSION_MISSING` 正则覆盖连字符形态；未知错误不再返回 true，改抛 `cannot read target log: …` → 报 `ok:false` 并**保留重试队列**。重试路径三道闸：先问 Host `state().active` 判活 → 再看日志是否越过切片写入的 `seedEvents`（新写入 `.graft-targets.json`）→ 都不满足才点火。

**真机证据**（`.graft-audit.jsonl`）：

```json
{"at":"2026-11-04T11:57:25.546Z","kind":"ignite",
 "detail":"ok via sessionController.prompt","pid":5516}
```

修复前同一文件：`ignite-failed … reading 'throwIfAborted'`。

### P0-3 控制台开关全部写不进去：`withTimeout is not defined`

**症状**：点任何开关 → 红卡 `错误详情：{"message":"withTimeout is not defined","via":"remote.commands.execute"}`，并退回灰字「以上开关显示的是插件默认值」。

**根因**：`withTimeout` 声明在 `React.useEffect` 内部，而 `write`（开关处理器）是组件作用域闭包——effect 能看见，处理器看不见。ReferenceError，每次必现。

**修复**：`withTimeout` 提升到 factory 作用域。新增静态回归测试 `test/v100-console-scope.test.mjs`：只允许一处声明，且必须在第一个 `React.useEffect` 之前。

---

## P1 / P2（同版本内）

- **P1 任务看板陈旧**：三种能产生过期 Todo 的形状（跨轮缓存、指纹不随内容变、看板从错误快照派生）已修；新增看板为「当前会话」而非「上一会话」的状态。
- **P2 `INJECTED_KIND` 与 0.2.2 `producerKind()`**：旧正则覆盖不了新枚举，方向也错了（用白名单而非黑名单），已改。

---

## 真机验收（2026-11-04）

| 项 | 结果 |
|---|---|
| 切片写入不再抛 SessionStore 错 | ✅ 目标保持 COLD |
| `ignition.ok` | ✅ `true` |
| `ignition.channel` | ✅ `sessionController.prompt`（主通道，非兜底） |
| 目标自启动 | ✅ 无需人工点击 |
| 冷恢复首轮看板 / 事件链 | ✅ 看板 + PendingState + 117 处回读指针齐全 |
| `.graft-pending-ignition.json` | `[]`，且是真成功后才清空 |

---

## 升级注意

- **版本号**：`package.json` / `manifest.json` 统一到 `1.0.0`（与 `dsh-memory` 对齐）。
- **重启生效**：插件是 Host 侧模块，改完必须重启 DSH 才会重新导入 `index.js` / `client.js`。
- **审计文件**：`%DSH_PROFILE_DIR%\data\dsh-graft-slice\.graft-audit.jsonl`，点火成功/失败都有一行，`detail` 措辞可区分真假成功（`ok via sessionController.prompt` vs `ok (already ignited)`）。
