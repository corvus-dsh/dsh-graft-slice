# 压缩上限：让切片先于宿主压缩（v0.37）

> 适用：DSH 0.2.2-rc.1（实测 2026-11-16）。改动本文件描述的任何配置都需要**重启** DSH。

## 为什么必须处理

宿主插件 `@deepseek-ai/dsh-compaction-basic` **默认 `auto: true`**：它在每个 `agent/pre-step`
用下面的阈值判断是否自动压缩历史：

```
threshold = floor(min(W × thresholdRatio, W − O − headroomTokens))
```

- `W` = 模型上下文窗口（`deepseek-flash` = 1,048,576）
- `O` = 单次请求预留的输出 token（adapter 默认 256,000）
- `thresholdRatio` = 0.8，`headroomTokens` = 65,536（宿主默认值）

对本 profile：

```
min(1,048,576 × 0.8, 1,048,576 − 256,000 − 65,536)
= min(838,860.8, 727,040)
= 727,040  →  69.34%
```

而 graft 的水位是 **70% 提示 / 75% 强制切片**。`69.34% < 70% < 75%` —— **压缩在 graft 连预警
都还没发的时候就已经压完了**。用户要求的「设计里不触发压缩，到水位切片」由此被违反；
graft 旧代码里那句「`compaction-basic` runs with `auto: false`」是**假陈述**（已在本版订正）。

## 代码侧的补救（已实现，不需要配置）

`src/core/compaction-guard.ts` 会：

1. 从 loader 读每个 `compaction-basic` 挂载点的 `config`（`auto` / `thresholdRatio` /
   `headroomTokens`，缺省用宿主默认值）；
2. 从 session 的请求头读 `O`（读不到时回退 `llm.resolveModelInfo` 的 `defaultMaxTokens`）；
3. 算出宿主有效阈值，并把 graft 的 `hardAt` 压到 `阈值 − 0.02`、`warnAt = hardAt − 0.03`；
4. 算不出来时落到**保守 `hardAt = 0.55`**，并在日志与 `graft_debug_status.compaction`
   里明说这是 RESOURCE 条件、不是通过。

所以**即使不改配置，切片也不会再输给压缩**（只要 `O ≤ 0.3875W`；超过这个比例 0.55 也不够，
见下）。代码侧的上限只是兜底；要做到用户要求的「压缩根本不发生」，仍需在配置层关掉 auto。

`graft_debug_status` 的 `compaction` 字段会报告：

```json
"compaction": {
  "present": true,
  "auto": true,
  "thresholdRatio": 0.6934,
  "source": "computed",
  "effectiveHardAt": 0.6734,
  "effectiveWarnAt": 0.6434,
  "reason": "compaction-basic auto is ON (preset:cordis); host threshold 0.6934; ..."
}
```

`source: "conservative"` 表示阈值算不出来（W 或 O 不可读）——那时 `effectiveHardAt` 是 0.55，
且 `reason` 会写明「RESOURCE … not a pass」。**不要把 conservative 当成通过**。

## 怎么彻底关掉（配置层，Desktop / Web）

Desktop/Web 的压缩后端**不在 host plane**：`dsh-web-app` 把 host 行 `disabled: true`，真正生效的是
**每个 agent preset 里的隔离组**（`presets/cordis.patch.yml` 的 `compaction` group）。因此：

- ❌ 在 profile patch 顶层加 `- id: compaction-basic` **无效**（那是已被禁用的 host 行，且 preset 的
  child 在另一个 Loader 树里）。
- ✅ 覆盖 **preset 行本身**的 `config.plugins`，在 `compaction` group 的 `compaction-basic` 子行上加
  `config.auto: false`。

有两条路：

1. **Web UI**：设置 → Agent preset → 选中 `cordis` → 编辑 `compaction` 组里的
   `dsh-compaction-basic` 行，把 `auto` 设为 `false`。编辑器写进 profile patch 的就是下面这层 override。
2. **手工**：在 `C:\Users\<user>\.dsh\profiles\<profile>\cordis.patch.yml` 里写：

```yaml
- id: preset-cordis          # 与 web-app presets/cordis.patch.yml 插入的行 id 相同
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: cordis
    order: 4
    plugins:                 # ⚠️ 这一列是「整份替换」，不是按子行合并
      # …把 shipped presets/cordis.patch.yml 的 plugins 列表整份复制过来…
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
            config:
              auto: false    # ← 唯一改动
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config:
              thresholdChars: 8192
              headChars: 4096
              tailChars: 1024
      # …其余 plugins 原样…
```

**坑（务必知道）**：`@deepseek-ai/dsh-agent-preset` 的 registry 文档写明 *A user override replaces
the complete child list*（`dsh-agent-preset-registry/README.md:99`）。所以手工覆盖 `plugins` 时
必须把 shipped preset 的**整份列表**复制过来，只改 `compaction-basic` 那一行；漏掉的行不会
自动继承。

改完**重启 DSH**（配置在激活时解析，preset 会重新挂载）。

## 关掉之后

- **自动压缩不再发生**：`auto: false` 让 `compaction-basic` 干脆不注册 `agent/pre-step` /
  `agent/request` / `agent/request-error` 三条自动监听器。
- **手动 `/compact` 仍然可用**：`dsh-command-compact` 直接调 `ctx.compaction.compactNow()`，
  不看 `auto`。若连手动也不要，把 preset 里的 `command-compact` 行也删掉。
- 该 preset 下**所有**会话都不再自动压缩（preset 是跨会话共享的）；这是「graft 会话不压缩」
  的实现方式——本 profile 的会话都用 `cordis` preset。

## 边界

- 保守上限 `0.55` 的前提是 `O ≤ 0.3875W`（`1 − O/W − 0.0625 ≥ 0.55`）。若某模型的输出预留
  超过窗口的 38.75%，0.55 也压不住压缩——那种情况只能靠上面的配置层关掉 auto。
- TUI / headless 没有 web presets：压缩后端来自 `dsh-base` 的 host 行。那里可以直接在 profile
  patch 顶层写 `- id: compaction-basic` + `config: { auto: false }`（host 行没被禁用时）。
