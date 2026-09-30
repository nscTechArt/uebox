/**
 * 一条新经验能不能进门、进门时挤掉谁。整理员写新经验、以及工程经验升为通用时共用。
 */

import type { ExperienceEntry } from './experienceFile'
import { emptyStats, evictionScore, type EntryStats } from './lifecycle'

/** 每个工具最多几条在用的。多了召回时互相挤占，研究里叫稀释 */
export const MAX_ACTIVE_PER_TOOL = 5
/** 每一层（一个工程、或通用层）最多几条在用的 */
export const MAX_ACTIVE_PER_LAYER: Record<'project' | 'global', number> = {
  project: 60,
  global: 150
}
/** 每个文件留几条已退休的，给用户看「它曾经这么以为过」 */
export const MAX_RETIRED_PER_TOOL = 10

/** 这个报错是不是已经有在用的经验对得上 */
export function covered(entries: ExperienceEntry[], tool: string, error: string): boolean {
  return entries.some(
    (entry) =>
      entry.status !== 'retired' &&
      entry.tool === tool &&
      entry.errorPattern !== '' &&
      error.includes(entry.errorPattern.toLowerCase())
  )
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
 * 把新经验放进一个工具的条目里：满了挤掉最该走的；
 * 最该走的是钉住的（全满且全钉住）就不放，回 undefined。
 */
export function admit(
  entries: ExperienceEntry[],
  incoming: ExperienceEntry,
  ledger: Record<string, EntryStats>
): ExperienceEntry[] | undefined {
  let next = [...entries]
  if (entries.filter((e) => e.status !== 'retired').length >= MAX_ACTIVE_PER_TOOL) {
    const victim = weakest(entries, ledger)
    if (!victim || victim.pinned) return undefined
    next = next.map((e) => (e.id === victim.id ? { ...e, status: 'retired' as const } : e))
  }
  next.push(incoming)
  const retired = next.filter((e) => e.status === 'retired')
  const drop = new Set(
    retired.slice(0, Math.max(0, retired.length - MAX_RETIRED_PER_TOOL)).map((e) => e.id)
  )
  return next.filter((e) => !drop.has(e.id))
}
