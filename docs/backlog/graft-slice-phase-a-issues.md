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
| 是什么 | 它报的是**相对量 + 本机噪声底**。同一 bundle 自比得到的就是分辨率（实测在 ±0.94% 到 ±7.79% 之间随机器/负载浮动）。 |
| 规则 | `|delta| <= resolution` ⇒ 只能说「测不出回归」，**不能说「变快」或「变慢」**；`control > 10%` ⇒ 仪器自认 UNFIT 并 exit 2。 |
| 为什么不再收紧 | 再收紧就得换测量方法（多进程、pin CPU、或用 instruction count），那属于另一个工具。当前它对「纯搬移有没有引入回归」这个是非题已经够用：预期值是 0，而 0 永远落在分辨率内。 |

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
