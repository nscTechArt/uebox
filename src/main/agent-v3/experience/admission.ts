/**
 * 一条新经验能不能进门、进门时挤掉谁。整理员写新经验、以及工程经验升为通用时共用。
 *
 * ## 为什么不按工具限条数
 *
 * 早先每个工具最多 5 条，理由是防稀释：召回时几条互相挤占。可稀释是召回那一侧的事，
 * 召回早已按工具名、报错片段、API 钥匙三把钥匙精确对上，一次最多带 3 条
 * （`recall.ts`）—— 存得多不会让一次报错带上不相干的。按工具限条数防不了稀释，
 * 只会把不相干的知识挤在同一排座位上：`ue_run_python_script` 下所有 API 的坑抢 5 个位置，
 * 实际效果是「只留最近 5 条」，引擎核实过的事实被一条新来的挤掉（2026-10-15 用户发现）。
 *
 * 现在只按层限总量，防的是文件无限长；做法经验和 API 事实分开算（见 `isApiFact`）。
 */

import type { ExperienceEntry, RetireReason } from './experienceFile'
import { emptyStats, evictionScore, type EntryStats } from './lifecycle'
import { isApiFact, patternProblem } from './specificity'

/** 每一层（一个工程、或通用层）最多几条在用的做法经验 */
export const MAX_ACTIVE_PER_LAYER: Record<'project' | 'global', number> = {
  project: 60,
  global: 150
}
/**
 * 每一层最多几条在用的 API 事实。事实只在说的是同一个 API 时才出场，
 * 多存不会稀释召回；这个数只为文件不至于无限长
 */
export const MAX_FACTS_PER_LAYER: Record<'project' | 'global', number> = {
  project: 1000,
  global: 1000
}
/** 每个文件留几条已退休的，给用户看「它曾经这么以为过」 */
export const MAX_RETIRED_PER_TOOL = 10

/** 这一层里，和 `entry` 同一类（事实 / 做法）的在用条目最多几条 */
export function layerCapacity(layer: 'project' | 'global', entry: ExperienceEntry): number {
  return isApiFact(entry) ? MAX_FACTS_PER_LAYER[layer] : MAX_ACTIVE_PER_LAYER[layer]
}

export function retireAs(entry: ExperienceEntry, reason: RetireReason): ExperienceEntry {
  return { ...entry, status: 'retired', retiredBecause: reason }
}

/**
 * 这个报错是不是已经有在用的经验对得上。
 *
 * 和召回用同一套判据（`patternProblem`）：一条太宽、召回时会被跳过的旧经验，
 * 不能在这里挡住新经验 —— 否则那个报错永远学不到一条像样的。
 */
export function covered(entries: ExperienceEntry[], tool: string, error: string): boolean {
  return entries.some(
    (entry) =>
      entry.status !== 'retired' &&
      entry.tool === tool &&
      patternProblem(tool, entry.errorPattern, error) === undefined
  )
}

/**
 * 写入时的查重：拿**片段**和已有片段比，不是拿报错原文。
 *
 * 不能复用 `covered`：它要的是完整报错，上帝工具的片段不是一整行异常，
 * `patternProblem` 会判成「不是异常」，于是永远查不出重复。
 * 一个片段包含另一个就算同一件事。
 */
export function patternCovered(entries: ExperienceEntry[], tool: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase()
  return entries.some((entry) => {
    if (entry.status === 'retired' || entry.tool !== tool) return false
    const q = entry.errorPattern.trim().toLowerCase()
    return q !== '' && (p.includes(q) || q.includes(p))
  })
}

/** 最该走的那条：钉住的不走，试用先于转正，同档里提升低的先走 */
export function weakest(
  entries: ExperienceEntry[],
  ledger: Record<string, EntryStats>
): ExperienceEntry | undefined {
  const score = (entry: ExperienceEntry): number =>
    evictionScore(entry, ledger[entry.id] ?? emptyStats())
  return entries.filter((e) => e.status !== 'retired').sort((a, b) => score(a) - score(b))[0]
}

/**
 * 把新经验放进一个工具的条目里。回 undefined 表示不放。
 *
 * 不在这里限条数（见文件头），只做一件事：API 事实同一个 API 只留一条。
 * 已有的那条转正了或被钉住，说明它站得住，新来的不放；还在试用，就换成新的 ——
 * 新的那条是这次刚从引擎结果里学到的。
 */
export function admit(
  entries: ExperienceEntry[],
  incoming: ExperienceEntry
): ExperienceEntry[] | undefined {
  let next = [...entries]
  if (isApiFact(incoming)) {
    const same = entries.find(
      (e) => e.status !== 'retired' && isApiFact(e) && e.symbol === incoming.symbol
    )
    if (same) {
      if (same.pinned || same.status === 'proven') return undefined
      next = next.map((e) => (e.id === same.id ? retireAs(e, 'replaced') : e))
    }
  }
  next.push(incoming)
  const retired = next.filter((e) => e.status === 'retired')
  const drop = new Set(
    retired.slice(0, Math.max(0, retired.length - MAX_RETIRED_PER_TOOL)).map((e) => e.id)
  )
  return next.filter((e) => !drop.has(e.id))
}
