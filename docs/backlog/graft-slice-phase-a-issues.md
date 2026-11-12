# graft-slice 已知问题清单（阶段 A 交付物）

> 用途：**只登记，不修**。阶段 A 的产出是这张表；修哪一条、按什么顺序修，等看过这张表再发令。
>
> 所有数字都注明来源命令，没有手算值。采集时间：2026-11-12，仓库 `dsh-graft-slice` HEAD `518bfa7` 之后。

---

## 一、类型层的三笔账（`scripts/type-check.mjs`）

`type-check` 把 35 条诊断分成三类，三类**不能互相抵消**：

```
CODE HEALTH: 1        ← 真缺陷
ENVIRONMENT: 33       ← 缺 @types/node，不是代码缺陷
COMPILER ARTIFACT: 1  ← strict:false 的假阳性
```

`--strict-comparison` 现测：`{"strictFalse":35,"strictTrue":44}`。

### A-1. `5097` — `.ts` 后缀，tsc 与 Node ESM 解析器互相矛盾（刻意保留）

| 项 | 内容 |
|---|---|
| 是什么 | `contracts/model-wording.contracts.ts` 里 `import … from './model-wording.ts'`。tsc 报 `5097 An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled`（`type-check --code 5097` 实测：1 条，文件就是它）。 |
| 为什么会有这一行 | 该文件被 `test/contracts-model-wording.test.mjs` **直接由 Node 加载**，而 Node 的 ESM 解析器**不会**把 `.js` 改写成 `.ts`。写成 `.js` 会让 `tsc` 干净，但测试立刻 `ERR_MODULE_NOT_FOUND`。两个解析器没有交集。 |
| 为什么现在不修 | 三条可能的修法都会动到构建契约：① 开 `allowImportingTsExtensions` + `noEmit` —— 只对 tsc 生效，等于把「这个包不做 emit 类型检查」写进配置；② 给测试加自定义 loader —— 引入运行时钩子；③ 把契约改成 `.js` —— 丢掉类型检查。**这是本仓库唯一已知的「两边都对不上」的取舍，不是疏忽。** |
| 修它要动什么 | `tsconfig`（目前不存在独立文件，选项由 `type-check.mjs` 传入）＋ `type-check.mjs` 的编译选项＋`contracts-model-wording.test.mjs` 的 import。 |
| 风险 | 改错方向会让测试红或让类型检查失效，但**两者只会红一个**，所以任何一次改动都必须同时跑 `type-check` 与那一个测试文件。 |

### A-2. `ENVIRONMENT 33` — `@types/node` 缺位（零依赖是刻意的）

| 项 | 内容 |
|---|---|
| 是什么 | `2307 × 18`（cannot resolve a node builtin's type declarations）＋ `2580 × 15`（cannot find the node global \`process\`）。 |
| 为什么现在不修 | `package.json` **不声明任何依赖**，CI 的安装步骤字面叫 `Install (no dependencies expected)`。加 `@types/node` 就破坏了这个前提：它会变成 devDependency，而「零依赖」是发布形态的一部分。`type-check` 自己也写着 `do NOT "fix" these by editing code`。 |
| 修它要动什么 | `package.json` 的 `devDependencies`、`ci.yml` 的安装步骤、`type-budget.mjs` 的两张基线表（计数与身份多重集都会变），以及「零依赖」这条对外承诺的措辞。 |
| 代价/收益 | 收益是 33 条噪声消失、`strict:true` 下的真实信号更容易看；代价是包不再零依赖。**这是产品决策，不是技术债。** |

### A-3. `COMPILER ARTIFACT 1` — `strict:false` 的 `2339` 假阳性

| 项 | 内容 |
|---|---|
| 是什么 | `index.ts:9495` `[2339] Property 'reason' does not exist on type '{ ok: true } \| { ok: false; … }'`。判别联合在 `strict:false` 下不做 `strictNullChecks` 收窄，于是 `!safety.ok` 之后 `safety.reason` 看起来不存在。**`strict:true` 这里报 0。** |
| 为什么现在不修 | 它不是我写的代码的缺陷，是编译选项的产物。在 `strict:false` 下「修」它等于加一段在 `strict:true` 下多余的守卫 —— 为了满足一个我们并不使用的设置而改代码，方向是反的。 |
| 修它要动什么 | 二选一：① 在该处加显式守卫（3–5 行，但属于为 `strict:false` 而写）；② 启用 `strict:true`（现测 `--strict-comparison` 给出 `strictTrue:44`，逐条处理 44 条 —— 其中 33 条仍是 ENVIRONMENT，所以真实增量是 10 条左右；改 options + 逐条处理，工作量最大）。 |
| 备注 | 这条的价值是**提醒**：「`strict:false` 下干净 ≠ 类型安全」。它被 `type-budget.mjs` 按「文件+代码+消息」的身份钉住，不是按行号。 |

---

## 二、`name`：未被引用的导出 —— 定性为**宿主 API**，不是死代码

> ⚠️ **未验证项（不得悄悄变成"已验证"）**：「宿主加载器确实读 `module.name`」**没有验证**。
> 要证实必须读 DSH 的加载器源码，那不在本工作区（按红线不做）。下面的定性依据是**插件模块形态**
> 与**导出面契约**两条间接证据，**不是宿主源码**。任何据此说"宿主一定会读它"的说法都超出了这里的证据。

| 项 | 内容 |
|---|---|
| 是什么 | `src/index.ts:414` `export const name = 'dsh-graft-slice'`。树内**真实引用 0**。`who-references name` 现在直接报 `EXCLUDED`：这个文本有 **17 个声明点**（1 个模块级 + 16 个函数内局部 `const name`、对象属性 `name`），按名字匹配无法归因。 |
| 定性结论 | **宿主 API（Cordis 插件模块约定），不是死代码。** 依据是下面两条间接证据，不是宿主源码 —— 见文首警示。 |
| 证据 | ① 它和 `export const inject`（L473）、`export function apply`（L8994）同处一个声明块 —— 那是 Cordis 插件模块的三件套（`name` / `inject` / `apply`）；② 它在被钉住的导出面基线 `.export-surface.json` 里（该文件第 134 行），说明「导出面 182」这个契约把它当外部接口保护着；③ 树内 0 引用是**符合预期的**：消费它的应该是宿主加载器，不是这个包自己（"应该"—— 未验证，见文首）。 |
| **我没验证的** | 「宿主确实读 `module.name`」。要证实需要读 DSH 的加载器源码（不在本工作区，按红线不做）。**这条定性依据的是插件形态与导出面契约，不是宿主源码。** 复述一遍：本清单里 `name` 的结论是**间接证据下的定性**，不是实测。 |
| 为什么现在不动 | 删它会同时打破两个契约：导出面 182→181，以及「插件模块必须携带 name」的形态假设。即使宿主不读，它也至少是「开发者在堆栈/日志里看到的插件名」。 |
| 修它要动什么（如果哪天要删） | 先证明宿主不读 → 改 `.export-surface.json` → 跑 `verify-bundle` 确认 181 → 改 ARCHITECTURE 里「90+ 导出」的措辞。**顺序不能反：先证据，后改基线。** |
| 附带教训 | 这条之所以长期被误当成「有 12 个引用」，是因为 `who-references` 按 `\bname\b` 匹配行、不解析绑定。修法不是改消费者，是把「同名多声明」判成 AMBIGUOUS 并剔除（已做，见 v141 的 8 条断言）。 |

---

## 三、仪器剩余盲区（`families.mjs` / `who-references` / `closure --block`）

这三件工具共同回答「一个符号有多少调用者、一个族有多大」，它们的盲区会直接变成搬移决定错误。

### B-1. `who-references`：跨文件同名 = 一律剔除（宁漏不假）

| 项 | 内容 |
|---|---|
| 是什么 | 歧义判定是**按请求的符号名**在**全部被扫描文件**上做的：只要该名字有 ≥2 个声明点，就整体 `EXCLUDED`，哪怕两个声明点分别在两个不相干的文件里、且其中一个明显不是被测符号。 |
| 后果 | **过排除**。真有一个唯一调用者时也会被剔掉 —— 但方向是安全的：输出是 `EXCLUDED` 而不是 `0`，读者不会把「不知道」读成「没有」。 |
| 为什么现在不修 | 要真正区分「同名不同文件」需要**解析绑定**（TS 的 symbol resolver），那等于把 `who-references` 从文本工具改造成编译器前端工具。当前它存在的意义恰恰是「不依赖 tsc 也能回答」——CI 上没有编译器。 |
| 修它要动什么 | 有两条路：① 接 `closure.mjs` 已有的 typescript 依赖，用 checker 取真实符号（但 `who-references` 就变成需要编译器的工具，CI 上只能跳过）；② 保留文本匹配，把歧义判定细化到「同一文件内的多声明」（能解掉最常见的一类，跨文件同名仍然保守）。**②是低风险改进，①是换工具。** |

### B-2. `closure --block`：`OUTSIDE` 不建模作用域（会**多报**依赖）

| 项 | 内容 |
|---|---|
| 是什么 | 切出一个子块时，它报「这个块的 OUTSIDE 依赖」。实测它会把**块内局部声明遮蔽掉的同名模块级符号**也报成 OUTSIDE。 |
| 证据 | 附件指针块（`index.ts` L3534..L3569）报 `OUTSIDE: name`。但块内 L3554 就有 `const name = …`，把整块抽成独立模块后用 TS 编译 API 单独编译 → **0 条 `Cannot find name 'name'`**。所以那条 OUTSIDE 是伪报。 |
| 后果 | 多报会让一个本来闭合的子块看起来「需要额外依赖」，从而被误判为不可搬。方向与 B-1 相反（这里危险，因为 C4「不读容器局部变量」是搬移的许可证）。 |
| 为什么现在不修 | 与 B-1 同源：要区分遮蔽必须解析绑定。目前的做法是**逐条人工核对 `OUTSIDE` 里的名字**，并把这一条写进记录（`SCAN-buildTape-candidates.md` 里那处自我纠正的结论需要按本条更正 —— 当时把工具判对了、脚本判错了，实际两者都错在没建模遮蔽）。 |
| 修它要动什么 | `closure.mjs` 的 block 模式改用 TS checker 的 `getSymbolAtLocation`，而不是按名字集合差。风险：block 模式目前是「切一段连续行、看它需要什么」，改成符号级之后语义会变，需要重新校准 v135 的三组已知答案。 |

### B-3. `families.mjs`：只在 `index.ts` 内部建边

| 项 | 内容 |
|---|---|
| 是什么 | 族的连通边只取「引用行落在 `index.ts` 某个成员区间内」的那些。已经搬出去的模块不在图里。 |
| 后果 | 一个族如果通过**已搬出的模块**互相影响（例如两个成员都改同一个已搬模块的导出），族划分看不见。对「能不能整块搬走」的判断影响有限（真正决定的是 `closure`），但会低估「搬它要改几个调用点」。 |
| 为什么现在不修 | 叶子阶段已收口（`buildTape` 496 行是唯一剩余容器），再把跨模块边建进来属于下一阶段（切开闭包内部）才需要的能力。 |
| 修它要动什么 | 把 `verify-import-edges.mjs` 的边集合并进 `families.mjs`，并定义「跨模块影响」的判据。 |

### B-4. `verify-pure-move`：多重集相等 ≠ 逐行相等

| 项 | 内容 |
|---|---|
| 是什么 | 它比较的是「内容行的多重集」，且**排除 import/export 行**。所以：两行相同内容互换位置不会被发现；import 的增删也不可见。 |
| 为什么要这样 | 纯搬移本来就是「同一堆行换位置」。逐行比较会把合法搬移判红。 |
| 已知缺口由谁补 | import/export 的增删由 `verify-import-edges.mjs` 补（v136 专门钉住这个缺口「exists by design」）。 |
| 剩余不可见 | 相同行互换位置 —— 对纯搬移无实际后果（内容相同），记录在案即可。 |

### B-5. `measure-efficiency`：本机分辨率就是结论的上限

| 项 | 内容 |
|---|---|
| 是什么 | 它报的是**相对量 + 本机噪声底**。同一 bundle 自比得到的就是分辨率（实测在 ±0.73% 到 ±14.09% 之间随机器/负载浮动）。 |
| 规则 | `\|delta\| <= resolution` ⇒ 只能说「测不出回归」，**不能说「变快」或「变慢」**；`control > 10%` ⇒ 仪器自认 UNFIT 并 exit 2。 |
| 为什么不再收紧 | 再收紧就得换测量方法（多进程、pin CPU、或用 instruction count），那属于另一个工具。当前它对「纯搬移有没有引入回归」这个是非题已经够用：预期值是 0，而 0 永远落在分辨率内。 |

### B-6. `measure-efficiency`：**单次运行会报出假的 REGRESSION**（2026-11-12 实测）

| 项 | 内容 |
|---|---|
| 现象 | 同一条 A/B（`old-index.js` ← tag `v0.9.2-beta.1` vs `new-index.js` ← HEAD）、同一个函数 `buildTape`，单次运行给出过 **+23.83% 的 REGRESSION**（exit 1），而同一对 bundle 的其它运行全部指向 2–5% 甚至负值。 |
| 六次单次运行（同一对 bundle，`buildTape`，9×120） | 见下表 |
| 结论 | 那次「回归」**从未复现**。单次运行的分辨率（同轮自比噪声）可以小到 ±2.68%，于是噪声轻易越过阈值 —— 它测的不是「噪声有多大」，而是「这一次恰好有多安静」。 |
| 修法（已实现） | 多轮独立运行 + 符号一致性 + **用跨轮离散度当分辨率**；任一轮符号翻转即判 `NOT RESOLVABLE`。 |
| 为什么 | 分辨率不是机器常数。单轮自比只反映那一轮的负载；跨轮极差才反映这套测量真正的误差量级。而符号翻转说明差值连方向都不稳定 —— 那时再谈「大小」是自欺。 |
| 附带 | 该脚本结尾的 "Expected value for a pure move: 0%" 在**非纯位移**的 A/B（例如 tag → HEAD 跨 124 个提交）上会误导 —— 此时 0% 不是预期值。输出已不再断言这一点。 |

**单次运行表（同一对 bundle，`buildTape`，9 轮 × 120 次调用的采样配置）**

| # | delta | 本轮对照 | 旧判据会怎么说 |
|---|---|---|---|
| 1 | −3.67% | 3.93% | NOT RESOLVABLE（差值在对照内） |
| 2 | −4.42% | 7.45% | NOT RESOLVABLE |
| 3 | −0.77% | 0.81% | NOT RESOLVABLE |
| 4 | −2.03% | 4.66% | NOT RESOLVABLE |
| 5 | −4.19% | 2.89% | 超出对照但不足 10%（既非回归也非改进） |
| 6 | −1.38% | 1.92% | NOT RESOLVABLE |
| — | **+23.83%** | **2.68%** | **REGRESSION**（exit 1）← 同一对 bundle，不同采样配置（11×300），**假警** |

七行合起来说明：单次运行里 delta 可以在 **−4.42% 到 +23.83%** 之间跳，而每一次的对照都「通过」。
**「对照这一次通过」不等于「这一次的结论可信」。**

**修复后的同一对 bundle（5 次独立运行，9×120）**

| run | before (µs) | after (µs) | delta | 本轮 control |
|---|---|---|---|---|
| 1 | 34.31 | 33.74 | −1.66% | 1.20% |
| 2 | 24.17 | 25.86 | +6.99% | 3.43% |
| 3 | 23.61 | 22.13 | −6.30% | 5.99% |
| 4 | 22.89 | 24.05 | +5.06% | 2.59% |
| 5 | 22.19 | 21.93 | −1.18% | 4.41% |

符号：`− + − + −`（**翻转**）；中位数 −1.18%；跨轮极差 **±13.29%**；最差对照 5.99%。
→ **VERDICT: NOT RESOLVABLE**（方向不稳定，谈不上大小）。

**修它要动什么**（已完成）：`measure-efficiency.mjs` 结论段改为四档，新增 `--repeat N`（默认 5）。
**尚未做**：`--repeat` 的轮数没有下限断言；`--repeat 1` 仍可复现旧的单次行为（用于本表这类取证）。

---

## 四、已修复（留档，避免被当成现存问题）

| 缺陷 | 症状 | 修法 | 证据 |
|---|---|---|---|
| 测试往真实 `src/` 写探针 | 整套测试**间歇性**报 v144 失败，而 v144 单跑是绿的；真正受害的可能是任何读树的测试 | `check-cycles` / `closure` / `who-references` / `move-gate` 各自支持 `GRAFT_*_SRC` 指向副本；v138、v141、`calibrate-who-references` 全部改为 mkdtemp 副本 | 整套并行**连跑 5 次**：`pass=804 fail=0` × 5 |
| `verify-pure-move` 空洞运行 | 干净树上跑默认 `--against HEAD` 打印 `IDENTICAL` 并 exit 0（两侧同一提交） | 无差异时打印 `VACUOUS` + exit 2 | v136x 断言 |
| `who-references` 同名多声明 | 12 条伪边把 17 个声明粘成一个族 | AMBIGUOUS 剔除 + 打印声明点清单 | v141 共 8 条 |
| `families.mjs` spanOf | 无分号单行声明被放大（`name` 1 行报成 20 行） | 三种括号一起配平 + 自校验「跨度之和 == closure 总行数」 | 863 = 863 |

---

## 五、明确不做的事（本阶段边界）

- **不动 beta.1**：registry 上 `0.9.0-beta.1` / `0.9.0-beta.2` 已是历史，仓库版本 `0.9.2-beta.1` 未发布。发布与否等裁定。
- **不开始另外三个仓**：等这份清单被看过再发令。
- **不再搬单件**：叶子搬移已尽（TD-1 现状行），剩余为 `buildTape` 496 行（`families.mjs` 当时实测的声明跨度），退出条件需重新立项。

---

## 六、tag → HEAD 差分实测（2026-11-12）

**基线**：`old-index.js` 来自 tag `v0.9.2-beta.1` = `e026a75`（构建脚本 `_scratch/build-old-baseline.mjs`，
产出 `_scratch/baseline.json`：old 780,721 B / sha256 `E6020471…`，new 868,503 B / sha256 `1C5E2BAA…`）。
中间隔 **124 个提交**，所以这里的差异是「124 个提交带来的行为变化」，**不是**纯搬移回归。

**输入**：`test/fixtures/corpus-sample.json`（真实持久化 v4 日志，213 事件）＋ 本项目两份真实会话日志
（`auto-graft-mw21oowu-e7kcmk` 920 事件、`auto-graft-mw1jox7o-gs23bp` 7,202 事件），
经 `scripts/read-session-log.mjs` 读取。

**方法**：12 个 case × 3 份输入 = 36 次比较，稳定序列化（键排序）后逐字符比。
脚本 `_scratch/diff-harness.mjs`。

### 结果：36 次中 8 次不同，集中在 3 个函数

| 函数 | 不同的输入 | 差异 | 引入提交（**二分实测**） | 是否预期 |
|---|---|---|---|---|
| `inheritedConstraintAnchor(events, id, 3)` | 2 份真实日志 | `第 1 代会话` / `当前是第 2 代` → `第 3 代会话` / `当前是第 4 代` | `cbf5962` | **预期**：该提交让第三参（代数）真正生效；旧版**完全不读**第三参（实测 `cbf5962^` 三参两参输出相同） |
| `inheritedConstraintAnchor(events, id)`（不传代数） | 2 份真实日志 | `第 1 代会话` + `当前是第 N 代` 行 → `原始会话` + 该行消失 | `cbf5962` | **预期**：新签名第三参默认 0，0 表示「不知道代数」，于是按原始会话表述 |
| `buildTape` | 2 份真实日志 | `pendingStateText` 里锚点文案随之改变 | 下游于 `cbf5962` | **预期**（同一原因） |
| `buildInjectionPlan` | 2 份真实日志 | ① `chunks[6].text` 锚点文案；② 约束条数 **4→3**（另一份 74→68 候选 / 69→63 归档）；③ `totalTapeChars` 3442→3483 | ① `cbf5962`；②③ `da3da13` | **预期**：`da3da13`（shape 步 2/8）让抽取门与名额门共用结构判据，被丢掉的那条是 `"请立刻执行真机切片测试："` —— 以冒号结尾的**截断片段** |

**corpus-sample 上 12/12 全部相同**（包括 `buildTape`、`buildInjectionPlan`）。

### 一次必须记的自我纠正（且其中一半还要再纠正一次）

差分脚本第一版把三个函数的参数**传错了**：`buildTape` 的参数顺序写成了 `(events, config, boundary, id)`
（真实签名 `(events, boundary, config, id)`）、`extractOpenTurnCarryover` 的第二个参数传了对象
（真实是 `fromSeqExclusive: number`）、`buildInjectionPlan` 传了 events
（真实是 `log: {session, inheritedEventCount, events}`）。

后果：第一版报出的「差异」里有 `（transcript，未声明目标）` 这样的伪差异。改用仓库自己的 `locateBoundary()`
与正确签名后，corpus-sample 变成 12/12 全同，我当时判断那条后缀是**调用错误造成的伪差异**。

**这个判断只对了一半（2026-11-12 扩面后更正）**：参数确实传错了，但 `（transcript，未声明目标）`
是一条**真实的行为变化**，只是 corpus-sample 那份日志不走「目标来自转录」那条分支，所以看不到。
走 `graft_prepare`（转录取目标）时它确实出现 —— 见下面第七节。真正的伪差异是同一批里另外那几条
（`goalSource: 'placeholder'` 造成的分支差异），它们确实消失了。

**教训升级版**：一个差异消失，只能证明「在这条输入上它不出现」，不能证明「它不存在」。
把「这次看不到」写成「这是假的」，是把覆盖面不足当成了证伪。

### 未验证

- 两份真实日志的**真实代数真值**未知：`第 1 代` 与 `原始会话` 哪一个更对，我没有独立证据判定。
  只能说新版的取值来自调用方传入的代数（`cbf5962` 的声明意图），而旧版是硬编码/正则推断。
- 只覆盖 12 个函数。「同一批日志过两版」的覆盖面取决于 case 清单，清单在 `_scratch/diff-harness.mjs` 里。

---

## 七、三条工具链路的差分（2026-11-12 扩面）

三条链路都不是顶层导出，而是 `apply(ctx)` 里 `ctx.tools.register({ name, execute })` 注册的处理器，
所以走**工具处理器**：同一套假宿主（`test/fake-harness.mjs` 不 import 包本身，两版可共用）、
同一份 `makeSourceLog({turns:6})`、同一个 args。脚本 `_scratch/diff-tools.mjs`。

| 链路 | 结果 |
|---|---|
| `graft_prepare` | **DIFF**（3 处，见下） |
| `graft_slice_and_inject` | **SAME** |
| `graft_read_result` | **SAME** |

`graft_prepare` 的三处差异（归一化只抹 id/时间戳/临时路径，判断性内容一个字段没动）：

| 差异 | 引入提交（`git log -S`） | 是否预期 |
|---|---|---|
| `pendingStateText` / `chunks[6].text`：目标行末尾多出 `（transcript，未声明目标）` | **`1322f09`** `fix(goal): C1 规则 2 仲裁落地 + goalLayer 到达渲染层` | **预期**：该提交给「目标来自转录」的情形加来源标注。corpus-sample 不触发该分支，所以第六节看不到它 |
| 新增字段 `handoverPendingCount: 0` / `handoverNoteCount: 0` | **`aafce29`** `feat(handover): TD-11 落地 —— graft_prepare 可选 handover{pending,notes}；不提供时渲染逐字节不变` | **预期**：纯增量字段；该提交自己声明「不提供时渲染逐字节不变」，而实测渲染文本除上面那条外确实只差这两个计数 |
| `digest` / `preparedId` 随之改变 | 下游于上面两条 | 预期（digest 是内容哈希） |

**注意**：`graft_prepare` 的差异**不包含**锚点代数的变化 —— 因为这条夹具里没有 HARD CONSTRAINTS 块，
`inheritedConstraintAnchor` 返回 undefined。代数那条只在第六节的真实日志上出现。

### 为什么不再扩到更多导出

- `apply` 本身不比对：它的输出是注册副作用，两版注册的工具名集合已经由 `verify-bundle`（182 个导出）
  与工具注册测试覆盖，用差分比它的副作用没有额外信息。
- 其余导出分两类：纯函数（已被第六节 12 个 case 覆盖）与依赖外部状态（store/mark/lock）的函数。
  后者要差分必须给两版各准备一份**同构的状态**，而 store 布局在这 124 个提交里本身变过 ——
  那样比出来的是「两份状态之间的差异」，不是「代码行为之间的差异」。
- 因此本节的结论边界是：**三条主链路已比对；没有比对的是「依赖外部状态的辅助导出」**，
  而它们被两版共用的工具链路间接覆盖（三条链路内部调用了它们）。
