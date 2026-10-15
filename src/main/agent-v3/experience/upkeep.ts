/**
 * 经验库的两件维护活：修旧账、复查没核实过的 API 事实。整理员每次开工前做（`curator.ts`），
 * 盒子启动时也给通用层做一次修旧账（`scheduler.ts`）。
 *
 * ## 修旧账
 *
 * 2026-10-15 之前，每个工具最多 5 条，满了挤掉得分最低的 —— 还没出过场的都是 0 分，
 * 所以 `ue_run_python_script` 下引擎核实过的事实，被一条条新来的挤掉了。那时退休不记原因，
 * 但能确定地认出来：别的退休路径（照做了又错、被忽略、提升不够）都要先有出场记录，
 * 账本里一次都没出过场的退休经验，只可能是被容量挤掉的。把它们放回来。
 *
 * 顺带：后来认定「在 None 上取属性」是脚本 bug（`specificity.ts`），之前学进来的那种退休掉。
 * 已经在编辑器里核实过的 API 事实，按现在的规则就是已验证。
 *
 * 每一条都是幂等的：跑第二次什么也不改。
 *
 * ## 复查
 *
 * API 事实写入时编辑器没开，就只能先试用（`probe.ts` 回 unknown）。之后整理员每次开工时
 * 编辑器多半开着，顺手问一句：这个成员到底存不存在。一次只问几条，不和用户抢编辑器。
 */

import { retireAs } from './admission'
import type { ExperienceEntry } from './experienceFile'
import type { EntryStats } from './lifecycle'
import { probeTarget, type EditorProbe } from './probe'
import type { ExperienceLayer } from './recall'
import { isApiFact, isNoneAttribute } from './specificity'
import type { ExperienceStore } from './store'

/** 整理员一次开工最多复查几条 */
export const RECHECK_PER_CURATION = 3

/** 写入时编辑器里核实过的，`source` 里带着这一句（`curator.ts`） */
const CHECKED_IN_EDITOR = 'checked in editor'

function neverTested(stats: EntryStats | undefined): boolean {
  return !stats || (stats.shown === 0 && stats.holdout === 0)
}

function repaired(entry: ExperienceEntry, stats: EntryStats | undefined): ExperienceEntry {
  if (entry.status !== 'retired') {
    if (isNoneAttribute(entry.errorPattern)) return retireAs(entry, 'script-bug')
    if (entry.status === 'trial' && isApiFact(entry) && entry.source.includes(CHECKED_IN_EDITOR)) {
      return { ...entry, status: 'proven' }
    }
    return entry
  }
  // 有原因的退休是新规则下的结论，不动
  if (entry.retiredBecause || !neverTested(stats)) return entry
  if (isNoneAttribute(entry.errorPattern)) return retireAs(entry, 'script-bug')
  const back: ExperienceEntry = {
    ...entry,
    status: isApiFact(entry) && entry.source.includes(CHECKED_IN_EDITOR) ? 'proven' : 'trial'
  }
  delete back.retiredBecause
  return back
}

/** 修一层的旧账。回改了几条 */
export async function repairLayer(store: ExperienceStore): Promise<number> {
  const ledger = await store.readLedger()
  const tools = [...new Set((await store.readAll()).map((e) => e.tool))]
  let changed = 0
  for (const tool of tools) {
    await store.updateTool(tool, (list) => {
      const next = list.map((entry) => repaired(entry, ledger[entry.id]))
      const count = next.filter((entry, i) => entry !== list[i]).length
      changed += count
      return count > 0 ? next : undefined
    })
  }
  return changed
}

/**
 * 引擎的结论落到一条事实上。
 *
 * 通用层的事实记着「在哪些版本上成立」：在没验证过的版本上被否定，是这个版本不适用，
 * 记进 `notFor`，不退休；在它成立过的版本（或没记版本）上被否定，才是它错了。
 */
function applyVerdict(
  entry: ExperienceEntry,
  layer: ExperienceLayer,
  verdict: 'confirmed' | 'refuted',
  engine: string | undefined
): ExperienceEntry {
  const engines = entry.engines ?? []
  if (verdict === 'confirmed') {
    const addEngine = layer === 'global' && engine && !engines.includes(engine)
    return { ...entry, status: 'proven', ...(addEngine ? { engines: [...engines, engine] } : {}) }
  }
  if (layer === 'global' && engine && engines.length > 0 && !engines.includes(engine)) {
    const notFor = entry.notFor ?? []
    return notFor.includes(engine) ? entry : { ...entry, notFor: [...notFor, engine] }
  }
  return retireAs(entry, 'refuted')
}

/**
 * 复查几条还在试用的 API 事实。只查「类.成员」那种（探针只会查这种）。
 * 回问了几条；编辑器没开时每条都是 unknown，什么也不改。
 */
export async function recheckFacts(
  layers: { store: ExperienceStore; layer: ExperienceLayer }[],
  probe: EditorProbe,
  projectRoot: string,
  engine: string | undefined,
  limit: number = RECHECK_PER_CURATION
): Promise<number> {
  let asked = 0
  for (const { store, layer } of layers) {
    const pending = (await store.readAll()).filter(
      (e) =>
        e.status === 'trial' &&
        isApiFact(e) &&
        !!probeTarget(e.symbol ?? '') &&
        !(engine && e.notFor?.includes(engine))
    )
    for (const entry of pending) {
      if (asked >= limit) return asked
      const target = probeTarget(entry.symbol ?? '')
      if (!target) continue
      asked += 1
      const verdict = await probe({ projectRoot, ...target })
      if (verdict === 'unknown') continue
      await store.updateTool(entry.tool, (list) =>
        list.some((e) => e.id === entry.id && e.status === 'trial')
          ? list.map((e) => (e.id === entry.id ? applyVerdict(e, layer, verdict, engine) : e))
          : undefined
      )
    }
  }
  return asked
}
