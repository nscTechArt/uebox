/**
 * 主进程内存健康判定
 *
 * Agent 跑终端、长对话时主进程堆涨到几百 MB 是正常负载，只看绝对值会一直误报。
 * 所以绝对阈值放宽，另外看趋势：连续多轮只涨不降（GC 也压不下来）才算可疑泄漏。
 */

export type MemoryStatus = 'healthy' | 'degraded' | 'unhealthy'

/** 超过这个值算偏高 */
export const MEMORY_DEGRADED_MB = 800
/** 超过这个值算过高 */
export const MEMORY_UNHEALTHY_MB = 1500
/** 趋势窗口：按 30 秒一次，10 个样本约 5 分钟 */
export const TREND_WINDOW = 10
/** 相邻样本回落不超过这个值，视为没降（排除测量抖动） */
const TREND_JITTER_MB = 10
/** 窗口内累计涨幅超过这个值，才算持续上涨 */
const TREND_MIN_GROWTH_MB = 100

/**
 * 窗口内是否持续上涨：样本填满、几乎每轮都没降、总涨幅够大。
 * 只要中间有一次明显回落（GC 回收了），就不算。
 */
export function isSteadilyGrowing(samplesMB: readonly number[]): boolean {
  if (samplesMB.length < TREND_WINDOW) return false
  const window = samplesMB.slice(-TREND_WINDOW)
  for (let i = 1; i < window.length; i++) {
    if (window[i] < window[i - 1] - TREND_JITTER_MB) return false
  }
  return window[window.length - 1] - window[0] >= TREND_MIN_GROWTH_MB
}

export function evaluateMemory(
  heapUsedMB: number,
  samplesMB: readonly number[]
): { status: MemoryStatus; reason?: string } {
  if (heapUsedMB > MEMORY_UNHEALTHY_MB) return { status: 'unhealthy', reason: '内存使用过高' }
  if (heapUsedMB > MEMORY_DEGRADED_MB) return { status: 'degraded', reason: '内存使用较高' }
  if (isSteadilyGrowing(samplesMB)) {
    const window = samplesMB.slice(-TREND_WINDOW)
    const growth = window[window.length - 1] - window[0]
    return {
      status: 'degraded',
      reason: `内存持续上涨（近 ${TREND_WINDOW} 轮涨了 ${growth.toFixed(0)}MB，未回落）`
    }
  }
  return { status: 'healthy' }
}
