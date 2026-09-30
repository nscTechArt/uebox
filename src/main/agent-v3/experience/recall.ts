/**
 * 召回：一次报错该带上哪几条经验。
 *
 * ## 为什么不做语义检索
 *
 * 旧长期记忆栽在「召回不准」上，而研究也显示嵌入检索的效果随模型大幅波动。
 * 这里只有确定性的规则：工具名精确相等，归一化后的报错里含有经验写的那一段。
 * 对不上就不出场 —— 宁可漏，不可错。
 *
 * ## 为什么只在报错时出场
 *
 * 有选择的注入优于常驻注入（设计稿第 5 节）。报错那一刻是它最有用、
 * 也最不会搞错对象的时候；首次调用时就塞，等于常驻。
 *
 * ## 两层
 *
 * 本工程的（`<工程>/.uebox/experience/`）和通用的（`<userData>/experience/`）一起查，
 * 本工程的排前面：同一个错，工程自己踩出来的做法比通用做法更贴近现场。
 * 通用经验在「照着做了还是同一个错」的引擎版本上不出场（`notFor`）。
 */

import type { ExperienceEntry } from './experienceFile'
import { patternProblem } from './specificity'

export type ExperienceLayer = 'project' | 'global'

export type LayeredEntry = ExperienceEntry & { layer: ExperienceLayer }

/** 一次最多带几条。多了互相挤占，模型也读不过来 */
export const MAX_SHOWN = 3

/**
 * 对照组比例：该出场时随机留多少不给。
 *
 * 转正的也留一点，用来持续确认它还有效。只在「已经报错」的时刻留，
 * 不给的代价最多是多走几步排查，不会让操作变危险。
 */
export const HOLDOUT_RATE: Record<'trial' | 'proven', number> = { trial: 0.15, proven: 0.05 }

export function matchEntries(
  entries: LayeredEntry[],
  tool: string,
  normalizedError: string,
  engine?: string
): LayeredEntry[] {
  const rank = (entry: LayeredEntry): number =>
    (entry.layer === 'project' ? 2 : 0) + (entry.status === 'proven' ? 1 : 0)
  return entries
    .filter(
      (entry) =>
        entry.status !== 'retired' &&
        entry.tool === tool &&
        // 不只是「含有」：片段还得对这一次的报错足够具体（见 specificity.ts）。
        // 这一道也兜住手改过的、以及这条规则之前写下的旧经验
        patternProblem(tool, entry.errorPattern, normalizedError) === undefined &&
        !(engine && entry.notFor?.includes(engine))
    )
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, MAX_SHOWN)
}

function describe(entry: LayeredEntry, engine: string | undefined): string {
  const facts = [entry.status === 'proven' ? 'proven' : 'on trial']
  if (entry.layer === 'global') {
    const engines = entry.engines ?? []
    if (engine && !engines.includes(engine) && engines.length > 0) {
      // 跨版本：照样给，但说清楚没在这个版本上验证过 —— API 一个大版本就可能变
      facts.push(`general; worked on UE ${engines.join(', ')}, not yet confirmed on UE ${engine}`)
    } else {
      facts.push(engines.length ? `general; worked on UE ${engines.join(', ')}` : 'general')
    }
  } else {
    facts.push('this project')
    if (entry.verified) {
      facts.push(
        `verified ${entry.verified.date}${entry.verified.engine ? ` on UE ${entry.verified.engine}` : ''}`
      )
    }
  }
  if (entry.source) facts.push(`from ${entry.source}`)
  return `- ${entry.title}: ${entry.advice} (${facts.join('; ')})`
}

/**
 * 挂在报错后面的那段话。
 *
 * 带上引擎版本和验证日期：越强的模型越容易信「看起来很新」的过期记忆，
 * 把元数据摆出来有帮助。措辞写成提示不写成命令 —— 经验可能过时，
 * 这一次引擎返回的才是事实。
 */
export function formatExperienceNote(entries: LayeredEntry[], engine?: string): string {
  return (
    '\n\n[Experience from earlier runs — this same error was hit before, and this is how it was got past. ' +
    'It may be outdated; what the engine returns now wins.]\n' +
    entries.map((entry) => describe(entry, engine)).join('\n')
  )
}
