/**
 * 一条经验的去留：试用 → 转正 → 退休。
 *
 * ## 记功只记被采纳的那一条
 *
 * 第一版设计是「出场后 5 步内同工具成功就 +1」，被研究否掉了两次：同时出场的几条
 * 会一起被加分（记忆奖励陷阱），而很多工具重试一次本来就会成功 —— 量到的是
 * 基础成功率，不是经验的功劳。于是这里只认两种证据：
 *
 * - **采纳后的结果**：出场后下一步照着做了（判据见 `ExpectedAction`），随后成了还是又错了。
 * - **对照组**：该出场的时候随机留一部分不给（见 `recall.ts`），两组成功率之差才是提升。
 *
 * ## 失效看证据，不看时间
 *
 * 照着做了却还是同一个错 —— 这是经验错了的直接证据，当场降级，不等攒够样本。
 * 很久没出场不算失效，只在容量满时被挤掉（见 `curator.ts`）。
 *
 * 阈值是初值，要拿评测数据校准（设计稿第 9 节）。
 */

import type { ExperienceEntry, ExperienceStatus } from './experienceFile'

export interface EntryStats {
  /** 出场次数，以及出场后同一工具随后成功的次数 */
  shown: number
  shownOk: number
  /** 对照组：该出场却没给的次数，以及随后成功的次数 */
  holdout: number
  holdoutOk: number
  /** 出场后被照着做了的次数，以及其中随后成功 / 又报同一个错的次数 */
  adopted: number
  adoptedOk: number
  adoptedFail: number
  /** 连续被忽略的次数。采纳一次就清零 */
  ignoredStreak: number
  lastShownAt?: string
}

export function emptyStats(): EntryStats {
  return {
    shown: 0,
    shownOk: 0,
    holdout: 0,
    holdoutOk: 0,
    adopted: 0,
    adoptedOk: 0,
    adoptedFail: 0,
    ignoredStreak: 0
  }
}

/** 一次出场（或一次对照）观察完的结论 */
export interface Outcome {
  arm: 'shown' | 'holdout'
  /** 下一步是否照着做了。对照组没有这个概念 */
  adopted: boolean
  /** 随后同一工具成了（true）、又报同一个错（false）、观察窗口里没再调它（undefined） */
  ok: boolean | undefined
}

export const PROMOTE_MIN_ADOPTED_OK = 3
export const PROMOTE_MIN_RATE = 0.7
export const HOLDOUT_MIN_SAMPLES = 3
export const RETIRE_MIN_SAMPLES = 10
export const IGNORED_STREAK_LIMIT = 5
export const TRIAL_ADOPTED_FAIL_LIMIT = 2

/**
 * 提升：出场组成功率 − 对照组成功率。对照样本不够时是 undefined ——
 * 这时拿不出无偏的估计，别硬算一个数出来冒充证据。
 */
export function lift(stats: EntryStats): number | undefined {
  if (stats.holdout < HOLDOUT_MIN_SAMPLES || stats.shown === 0) return undefined
  return stats.shownOk / stats.shown - stats.holdoutOk / stats.holdout
}

function canPromote(stats: EntryStats): boolean {
  if (stats.adoptedOk < PROMOTE_MIN_ADOPTED_OK) return false
  const measured = lift(stats)
  // 对照样本不够时退一步看采纳后的成功率。这是有偏的（设计稿 13.4），
  // 但样本少的工程要攒很久才凑得出对照组，不能让它们永远转不了正
  if (measured === undefined) return stats.adoptedOk / stats.adopted >= PROMOTE_MIN_RATE
  return measured > 0
}

export function applyOutcome(
  entry: Pick<ExperienceEntry, 'status' | 'pinned'>,
  before: EntryStats,
  outcome: Outcome,
  now: string = new Date().toISOString()
): { stats: EntryStats; status: ExperienceStatus } {
  const stats = { ...before }
  let status = entry.status
  const retire = (): void => {
    if (!entry.pinned) status = 'retired'
  }

  if (outcome.arm === 'holdout') {
    stats.holdout += 1
    if (outcome.ok) stats.holdoutOk += 1
  } else {
    stats.shown += 1
    stats.lastShownAt = now
    if (outcome.ok) stats.shownOk += 1

    if (outcome.adopted) {
      stats.adopted += 1
      stats.ignoredStreak = 0
      if (outcome.ok === true) stats.adoptedOk += 1
      if (outcome.ok === false) {
        stats.adoptedFail += 1
        // 照着做了还是同一个错：经验错了的直接证据，当场降级
        if (status === 'proven') status = 'trial'
        else if (stats.adoptedFail >= TRIAL_ADOPTED_FAIL_LIMIT) retire()
      }
    } else {
      stats.ignoredStreak += 1
      // 一直摆在眼前却没人照做：要么写得不好，要么不对路。留着只占位置
      if (stats.ignoredStreak >= IGNORED_STREAK_LIMIT) retire()
    }
  }

  if (status === 'retired') return { stats, status }

  const measured = lift(stats)
  const enoughSamples = stats.shown + stats.holdout >= RETIRE_MIN_SAMPLES
  // 样本够了、有对照，而出场并不比不出场好：它没用
  if (measured !== undefined && measured <= 0 && enoughSamples && !entry.pinned) {
    return { stats, status: 'retired' }
  }

  if (status === 'trial' && canPromote(stats)) status = 'proven'
  return { stats, status }
}

/** 容量满时谁先走：钉住的不走；试用先于转正；同档里提升（或采纳成功数）低的先走 */
export function evictionScore(entry: ExperienceEntry, stats: EntryStats): number {
  if (entry.pinned) return Number.POSITIVE_INFINITY
  const base = entry.status === 'proven' ? 1000 : 0
  return base + (lift(stats) ?? 0) * 100 + stats.adoptedOk
}
