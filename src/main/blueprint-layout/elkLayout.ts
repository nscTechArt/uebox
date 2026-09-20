import type { ELK } from 'elkjs/lib/elk.bundled.js'

/**
 * 懒加载 elkjs。
 *
 * elk.bundled.js 是一个 7MB 以上的 GWT 产物，顶层 import + `new ELK()`
 * 会让它在每次开机时都被加载并实例化一次。
 *
 * 蓝图排版已经不用它了（走 `blueprintLayout.ts` 的分层布局），现在只有材质
 * （`ue-material/layout.ts`）和 PCG（`ue-pcg/layout.ts`）这两张**纯数据流**的图
 * 还需要通用分层算法 —— 两边共用这一个实例，各 new 一个等于加载两遍。
 */
let cachedElk: ELK | null = null

export async function getElk(): Promise<ELK> {
  if (!cachedElk) {
    const mod = await import('elkjs/lib/elk.bundled.js')
    const ElkCtor = (mod.default ?? mod) as unknown as new () => ELK
    cachedElk = new ElkCtor()
  }
  return cachedElk
}
