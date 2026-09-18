/**
 * 「技能」设置页的筛选逻辑。
 *
 * 抽出来是因为它有真的分支（来源 + 关键词两条独立条件、大小写、空白），
 * 而这些分支在 `.vue` 的 computed 里测不到。页面只负责把结果画出来。
 */

export type SkillSource = 'builtin' | 'plugin' | 'user'

/** 筛选档。`all` 不是来源，是「不筛」 */
export type SkillSourceFilter = 'all' | SkillSource

export interface SkillEntry {
  name: string
  description: string
  source: SkillSource
  /**
   * 用户有没有把它关掉。
   *
   * **筛选不看这个字段**：关掉的仍然要出现在清单里，否则用户没法再打开它。
   * 界面只是把它画暗一点、加一个「已关闭」的标。
   */
  enabled: boolean
}

export interface SkillFilter {
  /** 关键词。两头空白会被去掉，空串等于不筛 */
  query: string
  source: SkillSourceFilter
}

/**
 * 按来源和关键词筛。
 *
 * 关键词同时匹配名字和说明：技能名是 kebab-case 的英文（`ue-greybox-blockout`），
 * 用户记得住的往往是说明里那句「搭个灰盒场景」而不是名字。只搜名字的话，
 * 中文用户在这个搜索框里几乎搜不到任何东西。
 *
 * 顺序保持输入顺序 —— 主进程那边已经排过了，这里再排一次会让两个入口
 * （输入框的 `/` 菜单和这一页）对同一批技能给出不同的顺序。
 */
export function filterSkills(
  skills: readonly SkillEntry[],
  filter: SkillFilter
): readonly SkillEntry[] {
  const keyword = filter.query.trim().toLowerCase()

  return skills.filter((skill) => {
    if (filter.source !== 'all' && skill.source !== filter.source) return false
    if (!keyword) return true
    return (
      skill.name.toLowerCase().includes(keyword) ||
      skill.description.toLowerCase().includes(keyword)
    )
  })
}

/**
 * 每个来源各有几条。筛选标签上要显示 —— 用户不用逐个点开才知道哪档有东西。
 *
 * 三个键都会出现（值可能是 0），调用方不用处理 undefined。
 */
export function countSkillsBySource(
  skills: readonly SkillEntry[]
): Readonly<Record<SkillSource, number>> {
  const counts: Record<SkillSource, number> = { builtin: 0, plugin: 0, user: 0 }
  for (const skill of skills) counts[skill.source] += 1
  return counts
}
