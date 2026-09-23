/**
 * 上次拉到的清单里某个角色的规格（能力下限）。**不发请求**，只读 `creator-plan.json` 里的缓存。
 *
 * 调用分支拿它卡本地上限（生图张数、配音单次字数、音乐时长、3D 扩展选项……），
 * 早一步拦下来比等服务端回一个 400 强。读不到（没缓存、文件坏了）回 null，
 * 调用方照常发，由服务端按协议报错 —— 400 不计额度。
 */

import type { ModelRole } from '../../../shared/aiProvider'

export async function cachedPlanSpec(role: ModelRole): Promise<Record<string, unknown> | null> {
  try {
    // 懒加载：planState 连着 electron，静态引会让每个引到适配器的测试都去碰它
    const { readPlanState } = await import('./planState')
    const spec = (await readPlanState()).manifest?.roles?.[role]
    return spec && typeof spec === 'object' ? (spec as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 规格里的一个正整数上限。没有就回 undefined */
export function specLimit(spec: Record<string, unknown> | null, key: string): number | undefined {
  const value = spec?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
