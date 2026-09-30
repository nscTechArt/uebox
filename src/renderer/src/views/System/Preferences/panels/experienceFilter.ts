/**
 * 「经验」分组的筛选。抽成纯函数：筛选规则是这一段里最容易悄悄写错的地方，
 * 放在组件里只能靠挂载整页去测。
 */

export type ExperienceScope = 'all' | 'global' | 'project'

export interface ExperienceFilter {
  scope: ExperienceScope
  /** scope 为 project 时看哪个工程 */
  projectPath?: string
  /** 已淘汰的默认不列 —— 它们不再起作用，只在想回头看时才需要 */
  showRetired: boolean
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function filterExperiences(
  entries: AgentV3Experience[],
  filter: ExperienceFilter
): AgentV3Experience[] {
  return entries
    .filter((e) => filter.showRetired || e.status !== 'retired')
    .filter((e) => {
      if (filter.scope === 'global') return e.layer === 'global'
      if (filter.scope === 'project') {
        return e.layer === 'project' && samePath(e.projectPath, filter.projectPath)
      }
      return true
    })
    .sort((a, b) => rank(b) - rank(a))
}

/** 已验证的在前，试用的其次，已淘汰的最后 */
function rank(entry: AgentV3Experience): number {
  return { proven: 2, trial: 1, retired: 0 }[entry.status]
}

/** 有经验的工程，给「工程」那一档的下拉用。没有经验的工程不列 —— 选了也是空的 */
export function experienceProjects(entries: AgentV3Experience[]): { name: string; path: string }[] {
  const seen = new Map<string, { name: string; path: string }>()
  for (const e of entries) {
    if (e.layer !== 'project' || !e.projectPath) continue
    const key = e.projectPath.replace(/\\/g, '/').toLowerCase()
    if (!seen.has(key)) seen.set(key, { name: e.projectName ?? e.projectPath, path: e.projectPath })
  }
  return [...seen.values()]
}

export function activeCount(entries: AgentV3Experience[]): number {
  return entries.filter((e) => e.status !== 'retired').length
}

/** 界面回传给主进程的定位信息 */
export function refOf(entry: AgentV3Experience): AgentV3ExperienceRef {
  return {
    layer: entry.layer,
    tool: entry.tool,
    id: entry.id,
    ...(entry.projectPath ? { projectPath: entry.projectPath } : {})
  }
}

/** 对照组比较，四舍五入到整数百分比。样本不够时 undefined */
export function liftPercents(
  stats: AgentV3Experience['stats']
): { with: number; without: number } | undefined {
  if (stats.lift === undefined || stats.shown === 0 || stats.holdout === 0) return undefined
  return {
    with: Math.round((stats.shownOk / stats.shown) * 100),
    without: Math.round((stats.holdoutOk / stats.holdout) * 100)
  }
}
