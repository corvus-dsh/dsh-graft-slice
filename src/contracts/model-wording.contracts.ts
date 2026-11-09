/**
 * ── E1: 只给测试用的契约元数据 —— 生产代码绝不能 import 这个文件 ────────────────────────────────
 *
 * 为什么单独一个文件：`bundle.mjs` 内联整个文件，所以元数据只要与生产正则同文件，就会随正则一起
 * 进入发布产物（实测：2 个 session id、5 个 `.jsonl.zstd`、8 个 `auto-graft-*`）。放进一个
 * `src/index.ts` 依赖图到不了的文件，「不进产物」才是结构性的。
 *
 * 正则从这里 import、不重新抄写，因此 `CONTRACT.re === REGEX` 结构性成立。
 */
import type { WordingPattern } from './types.js'
import { TODO_TOOL_NAME, CONSTRAINT_PATTERN, EMPHATIC, STANDING_PROHIBITION } from './model-wording.ts'

export const TODO_TOOL_NAME_CONTRACT: WordingPattern = {
  name: 'TODO_TOOL_NAME',
  re: TODO_TOOL_NAME,
  intent: '这次工具调用的名字是不是 todo_write（含 mcp__x__todo_write / foo/todo-write 这类命名空间写法）',
  samples: [
    {
      text: '- seq=4633 Turn 13 · todo_write',
      source: 'auto-graft-mw7jlaxh-8gtiyl/session.v4.jsonl.zstd',
      seq: 16,
    },
  ],
  nearMisses: [
    {
      text: '[系统提示] 这是长任务：请先制定或更新你的节点计划（Node Plan）——阶段 → 当前节点 → 卡点。写进 todo_write 时用「阶段 1:」前缀，切片会原样带走。',
      kind: 'real-nearby',
      why: '句中提到 todo_write，是宿主的节点计划提醒，不是「这次调用的是 todo_write」。正则要求结尾锚定，故正确地不命中。',
    },
    {
      text: '- `side session preset mounted standard` → `allow= 10 read,glob,grep,web_search,web_fetch,todo_write,working_directory,skill,job_l…',
      kind: 'real-nearby',
      why: '工具清单里的枚举项。todo_write 是逗号分隔列表中的一个名字，后面还有别的工具，因此不以它结尾。',
    },
  ],
  caveat:
    '结尾锚定 `$` 是这条契约的全部要害：去掉它，上面两条真实文本会立刻误命中，' +
    '而「模型被反复提醒要写 todo」会被读成「模型一直在写 todo」。' +
    'observer 侧有一份逐字相同的第二实现，跨仓 parity 测试读源文件比对（不能读 index.js，bundle 会做转义）。',
}

export const WIDE_CONSTRAINT: WordingPattern = {
  name: 'WIDE_CONSTRAINT',
  re: CONSTRAINT_PATTERN,
  intent: '这句话像不像一条持久的约束（**召回用**，宽；单独使用会误命中，见 caveat）',
  samples: [
    {
      text: '操作约束: Documents 读可写不可 → 第一步必须复制进 D:\\插件开发与安装\\dsh-lab\\ 并建 PATCHES.md 索引',
      source: 'session-64345616-2ef5-44ec-8152-c08696d498d2/session.v4.jsonl.zstd',
      seq: 376,
    },
  ],
  nearMisses: [
    {
      text: '- `diagnose-windows-sandbox-acl`: Use on Windows for unexpected DSH sandbox access denials: workspace writes or listing fail, or an ordinarily readable path cannot be read.',
      kind: 'real-misfire',
      why: '技能目录摘要：命中的是英文虚词 if / only / cannot，句子本身回答的是「这个 skill 什么时候用」，不是一条约束。',
    },
  ],
  caveat:
    '实测在 9153 条真实文本上命中 2126 条，误命中率很高且**无法靠收窄词表修好**——' +
    '约束的本质是主谓关系（"你必须做 X" vs "X 必须存在"），词表看不到关系。' +
    '所以本契约只做召回：真正的判定在调用点的 isHumanAuthored / isQuestionLike 两步过滤之后。' +
    '**不收窄词表**是刻意的：删掉 if/only 会损失真实约束的召回，误命中只会换个地方出现。',
}

export const EMPHATIC_CONTRACT: WordingPattern = {
  name: 'EMPHATIC',
  re: EMPHATIC,
  intent: '这句话里有没有硬强调词（**加权 +2 用**，不作门禁）',
  samples: [
    {
      text: '- 新建 dsh-sidecar/docs/DOCS-DRIFT.md：32 条三列对账(D-01..D-32)+ §2 必须改代码(8 项)',
      source: 'session-3b99cdc6-957a-4c7c-9396-56177c0eb5b1/session.v4.jsonl.zstd',
      seq: 877,
    },
  ],
  nearMisses: [
    {
      text: 'task-3 done. Deliverable: D:\\插件开发与安装\\dsh-sidecar\\docs\\RECOVERY-TESTS.md (UTF-8, 5 sections). Only that file + .tmp\\recon-tests written',
      kind: 'real-misfire',
      why: '完成汇报：`Only that file … written` 是在限定「只写了这一个文件」，是对已发生事实的描述，不是禁令。',
    },
    {
      text: 'task-4 COMPLETE. Deliverable: dsh-sidecar\\docs\\RECOVERY-DEPLOY.md (273 lines, UTF-8 中文). No restart, no source…',
      kind: 'real-nearby',
      why: '同样是完成汇报，但 `No restart` 不在本契约词表内，因此正确地不命中。它证明边界的位置。',
    },
  ],
  caveat:
    '`only` / `cannot` / `no …` 在**描述性英文**里极常见，而模型汇报工作时正好这样写。' +
    '所以这条只能加分，不能单独决定「这是一条约束」。' +
    '**本契约与生产 `hard` 逐字相同（13 个词），不含 `strong` 的 只能/始终/绝不/不要**——' +
    '取并集是更合理的设计，但会改变加权，需单独一轮验证（见 ARCHITECTURE TD-14）。',
}

export const PROHIBITION_PLUS_ACT: WordingPattern = {
  name: 'PROHIBITION_PLUS_ACT',
  re: STANDING_PROHIBITION,
  intent: '这是不是一条针对破坏性动作的**持久禁令**（区别于「删掉 D:\\X\\repair-log.cjs」这类一次性操作）',
  samples: [
    {
      text: '破坏性命令红线：禁止 rm -rf /、Remove-Item -Recurse 指向盘符根目录 / 用户目录 / 工作区之外的路径；',
      source: 'auto-graft-mw7jlaxh-8gtiyl/session.v4.jsonl.zstd',
      seq: 7693,
    },
    {
      text: '6. **resolve 层"最多 8 项"是死代码**（3 项白名单+去重，永远到不了）→ 删掉，上限只留在 `encodeSecurityCapabilities` 的结构边界。',
      source: 'auto-graft-mw7jlaxh-8gtiyl/session.v4.jsonl.zstd',
      seq: 5679,
    },
  ],
  nearMisses: [
    {
      text: '清理提示：%TEMP% 下 final-*/tgzfinal-*/broken-* 因沙箱禁止递归删除未能自动清除，可手动删；不在工作区与 release 内。',
      kind: 'real-misfire',
      why: '状态说明：`沙箱禁止递归删除` 解释的是「为什么没删掉」，不是用户下的禁令。12 字符窗口内 禁止+删除 齐备，字面与禁令完全同形。',
    },
  ],
  caveat:
    '**已知未修的边界**：`因沙箱禁止递归删除未能自动清除` 与 `禁止删除任何脚本` 在这条正则看来一模一样。' +
    '区分它们需要看主语（谁在禁止谁），而正则没有主语的概念。' +
    '12 字符窗口是刻意的（更宽会保留本应丢弃的句子），但窗口救不了这个 case。',
}

export const ALL_CONTRACTS: readonly WordingPattern[] = [
  TODO_TOOL_NAME_CONTRACT,
  WIDE_CONSTRAINT,
  EMPHATIC_CONTRACT,
  PROHIBITION_PLUS_ACT,
]
