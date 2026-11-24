# TD-MG-1 · 四仓 `move-gate.mjs` 里的 `ambiguousNames` 只声明、零引用（死代码）

> 登记依据：A3 移植时发现，不在本轮修复范围内 —— **登记而非顺手改**。
> 状态：**已定性，未修**。不影响任何判定（它是纯报告结构，没有任何分支读它）。

## 一、现象

`scripts/move-gate.mjs` 在四仓里**逐字节相同**（A3 之后 `A7784C85DAFCBBBA`），
其中这段只被声明、从未被使用：

```
$ grep -n "ambiguousNames" scripts/move-gate.mjs
288: const ambiguousNames = (() => {
```

**零引用**。`node --test test/v138-move-gate.test.mjs` 11/11 绿，与它无关。

## 二、它是怎么来的

A3 把 `move-gate.mjs` 统一到 memory 版（`B4-B/⑩`：`resolveDeclaration(name, file)`
消歧 + 成员按 `文件:名字` 求并集）。`ambiguousNames` 是那一版里**同期引入的**
辅助结构，目的是「同名多声明要报出来，不假装没有」。

**但报出来这一步没写完**：结构算出来了，没有任何 `line(...)` 打印它。

## 三、为什么本轮不删

1. **四仓逐字节相同**是这一条的判据本身。只删一仓会让 `check-shared-sources` 红，
   而要删就必须四仓一起改、一起提交 —— 那是另一件事，与「移植半修复」不是同一批；
2. 它在**任何路径上都不影响判定**：没有分支读它，删与不删的输出逐字节相同；
3. 顺手删会掩盖一个更该问的问题：**memory 版当初为什么算了却不用？**
   那个答案（是漏了打印，还是刻意留作将来）只有 memory 的作者知道。

## 四、修法（二选一，先问再动）

- **A 删掉**：四个仓一起删，`shared-sources.json` 重新同步，一次提交。
- **B 用起来**：在报告里加一行，`ambiguousNames` 非空时打印
  `同名多声明: readJsonl (store.ts, causal.ts)`。**这一条更有价值**——
  A3 移植的正是「名字有歧义就会算错行数」，而能让人看见歧义的那一行现在不存在。

**倾向 B**，但它会改变 `move-gate` 的输出，需要先确认没有判据钉死当前输出。

## 五、判据（修完必须补的那条）

无论 A 还是 B，都要配一条判据把这件事关掉：

- 选 A ⇒ `assert.equal(source.includes('ambiguousNames'), false)`；
- 选 B ⇒ 喂一个**真的有同名声明**的树，断言输出里出现那两个文件名
  （只断言「有这一行」是源码形状断言，证明不了它报得对）。

**没有判据的修法会再长出第二个 `ambiguousNames`** —— 这正是本批反复见到的形状。
