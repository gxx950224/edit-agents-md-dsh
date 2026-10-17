/**
 * edit-agents-md-dsh 宿主半入口（加载器外壳）。
 *
 * 为什么要有这一层：
 *   DSH 的插件模块被 ESM **按包名缓存**，重新挂载插件**不会**重新导入模块
 *   （已实测：改 main、改行内容都无效，只有换包名才生效）。这会让宿主半几乎无法迭代。
 *
 *   绕法：本外壳自己会被缓存，但它每次 `apply` 都用一个**唯一查询串**动态导入
 *   `./impl.js`，强制 Node 重新求值。而 `apply` 在每次重挂载时都会重跑
 *   （实测：每次 toggle / patch 变更都会重新执行 apply），于是改 impl.js 后
 *   只要重新挂载插件就生效，**不需要换包名、不需要重启**。
 *
 * 注意：真正需要进程重启才能生效的，只有本外壳自身与静态 `inject` 声明。
 *
 * 本外壳**刻意不重新导出** impl.js 的任何符号：`export *` 会缓存住首次求值的
 * 绑定，让上面的绕法失效。单测请直接 import `./impl.js`（这也是本包的约定，
 * 见 test/*.test.mjs）。
 */
export const name = "@gxx-labs/edit-agents-md-dsh"

let generation = 0

/**
 * 插件入口。委托给带唯一查询串重新求值的 impl.js。
 *
 * @param ctx - 宿主插件上下文
 * @returns impl.apply(ctx) 的结果
 */
export async function apply(ctx) {
  generation += 1
  const stamp = `${Date.now().toString(36)}${generation.toString(36)}`
  const module = await import(`./impl.js?g=${stamp}`)
  return module.apply(ctx)
}

export default { name, apply }
