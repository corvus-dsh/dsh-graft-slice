/**
 * ── 直接导入**源码模块**（而不是构建产物 `index.js`）────────────────────────────────────────────
 *
 * 源码里的相对 import 写成 `./state.js`（编译期约定，`.js` 后缀是给 ESM 看的），磁盘上的文件名却是
 * `state.ts`。Node 24 本身**支持**执行 `.ts`（`process.features.typescript === 'strip'`），缺的只是
 * 这一步解析：`.js` 找不到时退到同名 `.ts`。
 *
 * 一条 resolve 钩子就补上了，于是测试可以拿到**模块本身**：
 *
 *     registerSourceModules()
 *     const { resetRetiredSessions } = await import('../src/core/session-state-reset.ts')
 *     const state = await import('../src/core/state.ts')
 *     state.retiredSessions.add('x'); resetRetiredSessions(); assert.equal(state.retiredSessions.size, 0)
 *
 * ── 为什么不满足于 `import … from '../index.js'` ───────────────────────────────────────────────
 *
 * 构建产物是**一个文件**：42 个模块被内联进同一作用域，于是「模块边界」在测试里消失了。用产物测，
 * 测到的是「整个插件」，不是「这个模块」——搬动是否真的把依赖断开，产物层面看不出来。
 *
 * 这与 v351 ④ 里写的「Node 不能直接跑 `.ts`」相反：那句话在当时是在**没有钩子**的条件下测出的结论，
 * 被写成了 Node 的能力边界。真正的边界是解析，不是执行。
 */
import { registerHooks } from 'node:module'

let installed = false

export const registerSourceModules = () => {
  if (installed) return
  installed = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const isRelative = specifier.startsWith('.')
      if (isRelative && specifier.endsWith('.js')) {
        try {
          return nextResolve(specifier, context)
        } catch {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
        }
      }
      return nextResolve(specifier, context)
    },
  })
}