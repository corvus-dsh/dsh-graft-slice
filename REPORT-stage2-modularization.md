# 阶段 2 报告：模块搬出（S3 搬运节点 N1–N7）

> **结论句（按裁定固定）**：**阶段 2 完成：模块搬出，剩余部分需要依赖倒置。**
>
> 这**不是**「S3 完成」。`src/index.ts` 仍是 **12,354 行**的单文件（起点 13,827，净 −1,473 行，约 10.7%）。
> 拆分远未完成；本阶段只吃掉了「闭包闭合、≤ 800 行、无模块级可变状态」的那一类叶子。

- 报告日期：2026-11-10
- 阶段：S3 搬运（阶段 2）
- 依据：`ARCHITECTURE.md` TD-1 / TD-21 / TD-22

---

## 一、搬出了什么（7 个模块）

| 节点 | 模块 | 声明 / 行 | 提交 |
|---|---|---|---|
| N1 | `core/command-guard.ts` | 15 / 119（闭包） | `5ff1c35` |
| N2 | `core/command-policy.ts` | 7 声明 | `695d1bf` |
| N3 | `core/host-noise.ts` | 7 / 35 | `4f87670` |
| N4 | `core/adaptive-depth.ts` | 2 / 124 | `d630111` |
| N5 | `core/task-board.ts` | 12 / 348 | `ab8d96b` |
| N6 | `core/instruction-card.ts` | 4 / 118 | `a772dbd` |
| N7 | `core/pending-state.ts` | 19 / 229 | `9e2f33e` |

`src/index.ts`：**13,827 → 12,354 行**（净 **−1,473**，约 **10.7%**）。
每个节点都是**纯位移**：`verify-pure-move` 全程 **IDENTICAL（19098 = 19098）**，导出面 **182 不变**，
测试数只随新增判据上升，`src/` 的内容行多重集合从未改变。

## 二、为什么停在这里（三类明确不搬）

| 目标 | 闭包 | 为什么不是节点 |
|---|---|---|
| `buildTape` | **48 / 1,750** | **超过 800 行硬上限** —— 是**容器**，必须先剥到 ≤ 800 才进队列 |
| `buildInjectionPlan` | **110 / 3,705** | 同上（且它是所有候选的超集） |
| `recoverGraftTransactions` | 34 / 505 | **闭包含 7 个 `let`** → 触发 STOP 判据（「那不是闭包，是共享状态」） |
| `graftSliceAndInjectUnlocked` | 190 / 5,851 | 同上，7 个 `let`，且超上限 |
| `graftSliceAndInject` | 195 / 5,903 | 同上，7 个 `let`，且超上限 |
| `apply()` | 312 / 10,852，16 个 `let` | **TD-21**：2,344 行的 `apply()` 属「依赖倒置 + handler 提取」，明确**不并入本阶段** |

**搬运队列已空**：剩下的都是**容器**或**被 STOP 判据挡住的共享状态**。要推进必须先做依赖倒置
（改签名 / 提 handler / 参数化存储路径），那是**行为面改动**，须单独立项。

## 三、⑥ 真机切片：判据与没走通的部分

**判据（三条）**：
- **C1** 插件在**实时 profile** 里可挂载（manifest / patch / 依赖可达）；
- **C2** 一次切片写入**真实 session store**，目标会话在实时 UI 里可打开；
- **C3** 点火在**实时会话**里触发并留下痕迹。

**实际执行（`_scratch/wrapup-realmachine.mjs`，只读取证）**：

| 项 | 结果 |
|---|---|
| `package.json` 的 `dsh.bundle.patch` | `./cordis.patch.yml`，文件**存在** |
| 产物 `index.js` 在普通 node 进程加载 | **成功**：182 个导出，`apply` 与 `graftSliceAndInject` 均为 function |
| 实时 session store 可读（只读） | **可读**：`~/.dsh/sessions` 下 11 个 workspace 目录、179 个会话目录（一层） |
| `manifest.json` 的 `dsh.bundle` | **缺失**（`dsh: null`）—— 发现路径若读 manifest 而非 package.json，则 `dsh plugin add` 会忽略本包 |
| 插件是否已装进实时 profile | **三个已知路径全部 absent**：`~/.dsh/plugins/node_modules/…`、`~/.dsh/node_modules/…`、`~/.dsh/profiles/default/node_modules/…` |

**没走通的部分（如实）**：
1. **C2 / C3 未执行。** 对真实会话执行切片会**退休该会话（不可逆）**，超出本会话授权；
   且插件在三个已知路径下**均未安装**，即使执行也无从挂载。
   → 需要你（或已授权的一次操作）在实时 GUI 里跑一次 `graft_slice_and_inject`。
2. **`manifest.json` 缺 `dsh.bundle`** 是一条**待确认的发现**，不是已判定的缺陷：我无法确认宿主
   从哪个文件读 bundle 声明。若读 `package.json`（`verify-bundle` 的注释认为如此），则无影响；
   若读 `manifest.json`，则这是安装级问题。
3. **只查了三个路径**，没有扫盘（红线禁止）。因此「未安装」的结论**限于这三个路径**。

## 四、⑧ 性能：五次原始读数（n=50，T1 graft-only）

**方法**：同一台机器、同一基线来源（`622345a` 的产物）、两组各跑 5 次、**期间无其它负载**
（首轮测量被并发的 10× tally 任务污染，读数 3.19–6.74 ms，已作废并重测）。

| 组 | run 1 | run 2 | run 3 | run 4 | run 5 | min | **median** | max |
|---|---|---|---|---|---|---|---|---|
| 基线（N1 前，`622345a`） | 3.11 | 3.14 | 2.91 | 1.93 | 2.28 | 1.93 | **2.91** | 3.14 |
| 当前（N7 后） | 2.06 | 2.30 | 2.28 | 3.23 | 2.65 | 2.06 | **2.30** | 3.23 |

- 中位数比值 = **0.79**（−21%）
- 中位数差 = **−0.61 ms**；基线 min–max 跨度 = **1.21 ms**
- **判定：不可判定**（中位数差 **小于** 基线 min–max 跨度 —— 按本轮钉死的口径，
  这种情况不挑方向写结论）

单次运行各自的 `spread(p95)` 在两组里都是 37%–198%，与上述判定一致：**这一档的噪声大于任何位移效应**。

## 五、门禁与判据的演变（本阶段真正的产出）

| 判据 | 它抓的是哪一类失效 |
|---|---|
| `test/v126` 文件集 | 扫描集合悄悄少一个文件（`.bak-cut`） |
| `test/v127` 闭包仪器 | 仪器对 `const`/`let` 全盲、`mutable` 恒为 `none`（**STOP 判据从未生效**） |
| `test/v128` skip 分类器 | `RESOURCE:` 前缀未识别、`\# SKIP` 转义、`git unavailable` |
| `test/v129` 门禁覆盖 | **门禁存在但 CI 从不运行**（`check-readme-counts`、`check-docs` 都中过一次） |
| `test/v130` 模块 800 行上限 | 上限只是散文；两个模块早已超限；范围/分母可被悄悄收窄 |
| `check-docs` PASS 下限 27 | `0 FAIL` ≠「检查都在」（27 → 26 静默少一条） |
| `check-readme-counts` 非空行数 | 同一行里「行数」被查、「非空」没人查，后者当场错了 5 |
| `verify-pure-move` 的 `export type {…}` | 类型再导出被当成内容行 |

**共同教训**：这一类失效都是「输入悄悄收窄」——文件集、分母、跳过分类、门禁清单、文档事实数。
修实例不够，必须让**判据去管判据**。

## 六、工具语义变更（下一阶段必须遵守）

`scripts/closure.mjs` **不编码跨簇引用**：它只沿**同一文件**内的模块级声明扩展闭包，跨文件依赖
按定义算「导入」。因此当候选各自成模块后，**重叠矩阵必然为空**（本阶段实测：N7 后打不出任何非空交集）。

→ 标准 ③「被其它簇引用者先搬」**下一阶段必须改读 import 边**（哪个模块被谁 import、import 了几个符号）。
拿恒空矩阵排序会得出「没有依赖」的假结论。

## 七、未解决项（本阶段不关闭）

1. **TD-21**：`apply()` **2,344 行**（L11333..13676）占 `src/index.ts` 的 17%，而 TD-1 的退出条件写着
   `index.ts ≤ 300 行`。现状是目标的 **40 倍**（12,354 / 300）。**不属于搬运节点**，须依赖倒置 + handler 提取，单独立项。
2. **三个含 7 个 `let` 的目标**（`recoverGraftTransactions` / `graftSliceAndInjectUnlocked` /
   `graftSliceAndInject`）：被 TD-1 的 STOP 判据挡住，需要参数化存储路径后才能进队列。
3. **TD-22**：`GLOBAL_SEARCH` 分支的误报（`/` 作分隔符、`|` 作模式串，实测三例）。未修（行为面）。
4. **`check-readme-tally` 的一次未复现观测**：
   - 观测时间：2026-11-10T21:02:54+08:00 前后
   - 命令：`node scripts/check-readme-tally.mjs`
   - 现象：`measured: tests=720 pass=717 fail=0 skipped=2` —— 有一条测试既未通过也未跳过
   - 复现尝试：同一命令连跑 **10 次**（2026-11-10T21:09:06 结束），**10/10 均为 `pass=718`**，**未复现**
   - 处置：不称噪声、不阻断收尾；**列为未解决项**
5. **`manifest.json` 缺 `dsh.bundle`**：待确认宿主从哪个文件读 bundle 声明（见 §三.2）。

## 八、验收与 CI

| 项 | 结果 |
|---|---|
| tests / pass / fail / skipped | **720 / 718 / 0 / 2** |
| check-docs | 27 facts |
| check-readme-counts | 24 checkable，其中**真比对数字 2 条**（总行数、非空行数） |
| check-readme-tally | 2 claims |
| verify-bundle | **28/28**，导出面 **182 不变** |
| verify-pure-move | **IDENTICAL（19098 = 19098）** |
| 构建确定性 | `build.mjs` ×3 SHA256 相同 |
| 三仓 | paradise **354/354**、memory **423/423**、observer **204/204** |

**CI（四仓各贴）**：

| 仓 | run | 结论 | sha |
|---|---|---|---|
| dsh-graft-slice | **#77**（N7 后的重测提交） | success | `32bdf73` |
| dsh-graft-slice | #76（N7） | success | `9e2f33e` |
| dsh-paradise | **#35** | success | `4036cca` |
| dsh-memory | **#30** | success | `88e432f` |
| dsh-observer | **#24** | success | `c17c622` |

## 九、下一步（不在本阶段内）

1. **依赖倒置专项**：`buildTape`（48 / 1,750）与 `buildInjectionPlan`（110 / 3,705）剥到 ≤ 800 行，
   需先提 handler / 参数化；三个 `let` 目标同理。
2. **TD-21**：`apply()` 的 handler 清单 → 拆分提案（行为面等价验收，`verify-pure-move` **不适用**）。
3. **真机切片**：在实时 profile 安装本包后，于 GUI 内执行一次并记录 C2 / C3。
4. 规则 ③ 改用 **import 边**排序。
