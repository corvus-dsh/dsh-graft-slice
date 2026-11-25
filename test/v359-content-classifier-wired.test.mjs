/**
 * ── v359：S7 / N8 —— 内容分类器真正接上生产路径，且五条纪律各有一条判据 ────────────────────────────
 *
 * 病（实测，不是推测）：`core/content-classifier.ts` 296 行，`src/` 里**零 import**
 * （唯一提及是 `compaction-guard.ts` 的一行注释），只有 `v219` / `v326` 从 `.ts` 直接加载它。
 * 于是计划 §2.3 的 D1–D5 五条纪律**只被它自己的测试执行**——也就是说，在生产上一条都没执行。
 *
 * 本判据分两半：
 *
 *   **甲、production_call_exists** —— 分类器出现在**生产代码**里，而且出现在**各自该在的位置**。
 *      只看「有没有 import」是不够的：`import` 一行就能满足那个问题，而它证明不了任何调用点。
 *
 *   **乙、D1–D5 各一条行为判据** —— 每条都从**生产入口**喂进去、看**产物**。
 *
 * 甲里的「位置」为什么必须断言：五条纪律分属五个不同的摄取点，把 `classifyBySource` 只接在
 * 别的哪一处（比如只用于 D5 的统计），`import` 一样在，但 D1 仍然没生效——这正是本仓反复出现的
 * 「一个 import 让修好的函数看起来被用了」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-assertion.mjs'
import {
  CONTENT_CLASSES,
  classifyBySource,
  classifyHumanText,
  summarizeUnclassified,
} from '../src/core/content-classifier.ts'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INDEX = join(ROOT, 'src', 'index.ts')
const GOAL = join(ROOT, 'src', 'core', 'goal-extraction.ts')

const indexText = readFileSync(INDEX, 'utf8')
const indexCode = stripComments(indexText)
const goalCode = stripComments(readFileSync(GOAL, 'utf8'))

test('v359 甲: the classifier is imported by PRODUCTION code — and by the module each discipline lives in', () => {
  assert.ok(/from '\.\/core\/content-classifier\.js'/u.test(indexCode),
    '甲 index.ts 必须 import 分类器（生产入口就是它）')
  assert.ok(/from '\.\/content-classifier\.js'/u.test(goalCode),
    '甲 goal-extraction.ts 必须 import 它 —— D2 的唯一落点在这里（「原始用户要求」由它产出）')

  /**
   * 每一个被 import 的名字都必须**真的被调用**。一个只被 import、从未被调用的符号，
   * 与「零 import」在行为上完全相同，而前者会让任何「有没有接线」的 grep 判据变绿。
   */
  for (const name of ['classifyBySource', 'summarizeUnclassified', 'CONTENT_CLASSES']) {
    assert.ok(indexCode.includes(name), `甲 index.ts 必须提到 ${name}`)
    const callSites = indexCode.split(`${name}`).length - 1
    assert.ok(callSites >= 2, `甲 ${name} 必须被**调用**（import + 至少一处使用），实测提及 ${callSites} 次`)
  }
  assert.ok(goalCode.split('classifyHumanText').length - 1 >= 2,
    '甲 goal-extraction 必须**调用** classifyHumanText，而不只是 import 它')
})

test('v359 D1: an injection is not a human instruction — it cannot reach the constraint pool', () => {
  /**
   * 机制断言（生产代码里那一跳真的在）：继承分支必须先问 `classifyBySource` 的 provenance，
   * 不是只看 `isGraftAuthored`。前者回答「这条是谁放进来的」，后者只回答「是不是我写的壳」。
   */
  assert.ok(indexCode.includes('D1_NOT_SELF'),
    'D1 生产代码里必须有这条显形记录（静默跳过等于没有纪律）')
  const inheritBlock = indexCode.slice(indexCode.indexOf('if (isGraftAuthored(event.data?.source))'))
  const guard = inheritBlock.indexOf("graftClass.provenance !== 'self'")
  const use = inheritBlock.indexOf('const recorded = constraintBlockOf')
  assert.ok(guard >= 0, 'D1 继承分支里必须有 provenance 判定')
  assert.ok(guard < use, 'D1 provenance 判定必须在读取约束块**之前** —— 顺序反了等于没判')

  /** 行为侧：分类器把明显的注入判成非 human/self。 */
  for (const kind of ['dsh-host-snapshot', 'project:time-context', 'plugin:graft-replay']) {
    const cls = classifyBySource(kind)
    assert.notEqual(cls.provenance, 'human', `D1 ${kind} 不得被判成 human`)
  }
  assert.equal(classifyBySource('user').provenance, 'human', 'D1 真正的人写消息仍然是 human')
})

test('v359 D2: a pasted transcript is NOT the requirement — it becomes a pointer', () => {
  /**
   * 机制断言：D2 的判定必须挂在「谁是需求」的选取上，而不是渲染时。
   *
   * ── 为什么这里读的是源码文本，而不是只跑行为 ──────────────────────────────────────────────────
   *
   * 「D2 生效」这件事有两个部分，行为测只能覆盖一半：
   *   (a) `classifyHumanText` 判得对 —— 行为可测（下面）；
   *   (b) **那个判定真的被用在选需求的路径上** —— 行为测不到，除非构造一整份日志走 `extractGoal`。
   * 本判据要的是 (b)，所以读源码里的**结构**（`newestSubstantive` 里那句 continue、
   * transcript 层里那句 ===）。
   *
   * ⚠️ 已知脆弱点（can-red 实测发现）：这些断言与**源码行的字面形状**绑定。D1 的 can-red 改的是
   * `if (graftClass.provenance !== 'self')` → `if (false)`，仍会连带让 D2 变红 —— 因为那处改动让
   * `goalCode` 之外的 `indexCode` 变了？不是：D1 改的是 index.ts，而这里读的是 goal-extraction.ts。
   * 实测两者都被改，是因为 can-red 用例把**两个文件**都写过（夹具顺序副作用），恢复后才分开。
   * 记在这里，免得下一个人把「连带红」误读成判据串味。
   */
  assert.ok(goalCode.includes('humanNature'),
    'D2 goal-extraction 必须把「是不是人写的」抽成一个可判定的函数')
  assert.ok(goalCode.includes("humanNature(text) !== 'human'"),
    'D2 newestSubstantive 必须排除转述（否则一份粘贴报告会冒充「用户改变了方向」）')
  assert.ok(goalCode.includes("humanNature(textOfMessage(event.data)) === 'human'"),
    'D2 transcript 层选人类消息时必须用同一个判定')

  /**
   * 行为侧：一份典型粘贴报告必须被判成 task-transcript，而一句普通需求必须留在 human。
   *
   * ── 第一版夹具是错的（实测 89 字 × 4 = 356 字，判成 human）──────────────────────────────────
   *
   * `PASTE_MIN_CHARS = 800` 是**每个 task-transcript 分支的前提**：报告结构/短语判据只在超过 800 字
   * 时才启用（理由写在实现里：「以下是我想问的」这种短句必须留在 human）。我的第一版夹具把一段
   * 89 字的小模板重复 4 次，得到 356 字 —— 判成 human 是**正确**的，错的是夹具不够长。
   *
   * 探针实测（`_scratch/probe-d2.mjs`）：同样内容 × 6 = 534 字 ⇒ human；× 10 = 890 字 ⇒ task-transcript。
   * 所以下面用 ×10，并在断言里**写明长度**，让下一个人一眼看出这条判据量的是「超过阈值之后」的行为。
   */
  const report = [
    '# 四插件完整总报告',
    '',
    '## 一、结论',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| 仓 | 4 |',
    '',
    '```',
    'npm run check',
    '```',
    '',
    '请你分析以上报告。',
    '',
  ].join('\n').repeat(10)
  assert.ok(report.length > 800, `夹具必须超过 800 字阈值（实测 ${report.length}）`)
  assert.equal(classifyHumanText(report), 'task-transcript', 'D2 超过阈值的长报告必须被判成转述')
  assert.equal(classifyHumanText('继续'), 'human', 'D2 一句「继续」仍然是人的话')
  assert.equal(classifyHumanText('把 S7 接完，然后跑四仓 check。'), 'human', 'D2 一句正常需求仍然是人的话')
})

test('v359 D3: an async result keeps {kind, seq, firstLine} — a pointer, not the body and not silence', () => {
  assert.ok(indexCode.includes('extractAsyncResultPointers'),
    'D3 必须有一个从日志产出指针的生产函数')
  assert.ok(indexCode.includes('asyncResultPointers:'),
    'D3 指针必须**进入交接产物**，否则它只是又一个没被调用的函数（N8 自己的病）')

  /** 表驱动的机制：async-result 的 continuation 必须是 pointer+first-line，由合同给出而不是猜。 */
  const asyncSpec = CONTENT_CLASSES.find((entry) => entry.id === 'async-result')
  assert.ok(asyncSpec !== undefined, 'D3 合同里必须有 async-result 这一类')
  assert.equal(asyncSpec.continuation, 'pointer+first-line',
    'D3 async-result 的处置必须是 pointer+first-line（本段正是照这张表实现的）')

  /** 指针的字段就是系统提示里写的那三个 —— 少一个都不叫指针。 */
  const pointerBlock = indexCode.slice(indexCode.indexOf('export interface AsyncResultPointer'), indexCode.indexOf('FIRST_LINE_MAX_CHARS'))
  for (const field of ['kind', 'seq', 'firstLine']) {
    assert.ok(pointerBlock.includes(field), `D3 指针必须带 ${field}`)
  }
})

test('v359 D4: dropped host noise is COUNTED, never silently removed', () => {
  assert.ok(indexCode.includes('noiseDropped'),
    'D4 必须有一个计数（替换本身是对的，无声明才是缺陷）')
  assert.ok(indexCode.includes('HOST_NOISE_MARKER') && indexCode.includes('FOLDED_OUTPUT_MARKER'),
    'D4 计数必须按两个标记数，而不是数「被改过的 chunk」个数')
  /**
   * `noiseDropped` 是**简写属性**（`noiseDropped,`）—— 第一版断言写的是 `noiseDropped:`（带冒号），
   * 于是它在一份完全正确的代码上变红。判据要量的是「这个值进了返回对象」，不是「用了哪种写法」：
   * 两种写法在运行时等价，而判据只能认一种时，它惩罚的是正确代码。
   */
  assert.ok(/^\s*noiseDropped,\s*$/mu.test(indexCode) || indexCode.includes('noiseDropped:'),
    'D4 计数必须进入交接产物（简写 `noiseDropped,` 或显式 `noiseDropped: …` 均可）')
  /**
   * ⚠️ 这两句的顺序是**生产代码里的真实缺陷检测**，不是风格检查。
   *
   * 第一版把 `if (noiseDropped > 0) warnings.push(…)` 写在 `const noiseDropped = …` **之前**：
   * `build.mjs` 用 `stripTypeScriptTypes`（纯类型擦除、不做检查），所以构建 exit 0，而运行时
   * `ReferenceError: Cannot access 'noiseDropped' before initialization`。
   * 这条断言就是那种错误的机器判据 —— 它检查「使用点在声明点之后」，不是「有没有那句话」。
   */
  const declaredAt = indexCode.indexOf('const noiseDropped = cleanedChunks')
  const usedAt = indexCode.indexOf('if (noiseDropped > 0)')
  assert.ok(declaredAt >= 0, 'D4 必须有 noiseDropped 的声明')
  assert.ok(usedAt >= 0, 'D4 必须有「有噪音时 push warning」的那一跳')
  assert.ok(declaredAt < usedAt,
    'D4 使用点必须在声明点之后（否则 strip 模式下构建通过、运行时 TDZ 抛错）')
  const warnPush = indexCode.slice(indexCode.indexOf('if (noiseDropped > 0)'), indexCode.indexOf('if (noiseDropped > 0)') + 400)
  assert.ok(warnPush.includes('warnings.push'), 'D4 有噪音时必须 push 一条 warning，而不是只算不报')

  /** 行为侧：两个标记确实是过滤器的产物（否则计数会永远是 0，而判据看起来通过）。 */
  assert.ok(readFileSync(join(ROOT, 'src', 'core', 'host-noise.ts'), 'utf8').includes('HOST_NOISE_MARKER ='),
    'D4 标记必须由 core/host-noise.ts 定义')
})

test('v359 D5: an unregistered source.kind is VISIBLE — never silently treated as noise', () => {
  assert.ok(indexCode.includes('summarizeUnclassified'),
    'D5 必须调用聚合出口')
  assert.ok(indexCode.includes('未登记的 source.kind'),
    'D5 必须在 warning 里显形，而不是只在返回值里留个字段')
  /**
   * ⚠️ 这条断言是 D5 的 can-red 靶子，第一版**漏了它**。
   *
   * 第一版只断言「源码里有那串字」。实测 can-red：把 `if (unclassifiedKinds.length > 0)` 改成
   * `if (false)`，判据**仍然全绿** —— 因为那串字还写在 `warnings.push(...)` 的参数里，而参数永远
   * 不被求值也在源码里。**「说过这句话」与「这句话会被执行」是两件事。**
   *
   * 所以这里断言的是**守卫的形式**：聚合结果必须被一个 `length > 0` 的条件守着。
   */
  assert.ok(/if \(unclassifiedKinds\.length > 0\)/u.test(indexCode),
    'D5 显形必须由 `if (unclassifiedKinds.length > 0)` 守着（否则 push 是死代码）')
  assert.ok(indexCode.includes('unclassifiedKinds:'),
    'D5 未登记 kind 必须进入交接产物')

  /** 行为侧：未登记 kind 既被分类器当成噪音，也**同时**出现在聚合结果里。 */
  const unknown = 'brand-new-kind-from-a-future-dsh'
  const cls = classifyBySource(unknown)
  assert.equal(cls.unclassified, true, 'D5 未登记 kind 必须标记 unclassified')
  assert.equal(cls.cls, 'host-noise', 'D5 未登记 kind 归入 host-noise（安全默认）')
  const summary = summarizeUnclassified([{ source: { kind: unknown } }, { source: { kind: 'user' } }])
  assert.deepEqual(summary, [unknown], 'D5 未登记 kind 必须显形，且已登记的不出现在里面')
  assert.deepEqual(summarizeUnclassified([]), [], 'D5 空输入 ⇒ 空数组（不是「全都未登记」）')
})