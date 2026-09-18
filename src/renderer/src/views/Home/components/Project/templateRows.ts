/**
 * 把「本地已有的模板」和「社区清单里列着的模板」合成一份列表。
 *
 * 这一步的意义在于：同一个模板可能同时以两种身份出现 —— 本地下载过一份、
 * 清单里还列着一条。界面上它们必须是**一行**，否则用户会看到两条同名的东西，
 * 还得自己想明白它们是不是一回事。
 *
 * 单独抽出来是为了能测：合并规则错了，界面上就是重复条目或者按钮点不动，
 * 这两种都不该靠人肉点弹窗发现。
 */
import {
  normalizeTemplateCategory,
  type CommunityFetchResult,
  type CommunityTemplate,
  type TemplateInfo,
  type TemplateOrigin
} from '@core/shared/projectTemplate'

/** 列表里的一行 */
export interface TemplateRow {
  /** 界面上的唯一键。本地有就用文件路径，纯清单条目用「源/模板 id」 */
  key: string
  name: string
  description: string
  category: string
  engineVersion: string
  origin: TemplateOrigin
  author?: string
  license?: string
  version?: string
  size: number
  previewImage?: string
  modifiedTime: number
  /** 本地那份，有就能直接建工程 */
  local: TemplateInfo | null
  /** 清单里那条，本地没有时用来下载 */
  remote: { sourceId: string; template: CommunityTemplate } | null
}

const DEFAULT_ENGINE_VERSION = '5.3'

/** 同一个源、同一个 id 就是同一个模板。缺任何一半都没法比对，当成独立的一条 */
function identityOf(sourceId?: string, templateId?: string): string | null {
  return sourceId && templateId ? `${sourceId}/${templateId}` : null
}

function rowFromLocal(tpl: TemplateInfo): TemplateRow {
  return {
    key: tpl.path,
    name: tpl.name,
    description: tpl.description || '',
    category: normalizeTemplateCategory(tpl.category),
    engineVersion: tpl.engineVersion || DEFAULT_ENGINE_VERSION,
    origin: tpl.origin,
    author: tpl.author,
    license: tpl.license,
    version: tpl.version,
    size: tpl.size,
    previewImage: tpl.previewImage,
    modifiedTime: tpl.modifiedTime,
    local: tpl,
    remote: null
  }
}

function rowFromRemote(sourceId: string, template: CommunityTemplate): TemplateRow {
  return {
    key: `${sourceId}/${template.id}`,
    name: template.name,
    description: template.description || '',
    category: normalizeTemplateCategory(template.category),
    engineVersion: template.engineVersion || DEFAULT_ENGINE_VERSION,
    origin: 'community',
    author: template.author,
    license: template.license,
    version: template.version,
    size: template.size,
    modifiedTime: 0,
    local: null,
    remote: { sourceId, template }
  }
}

/**
 * 合成列表。
 *
 * 三条规则：
 *   1. 本地同一个模板有两份（比如清单里改过名，下载后落成了两个文件名）
 *      → 用文件更新的那份。
 *   2. 清单里的条目能对上本地某一行 → 挂到那一行上（这行于是既能建工程、
 *      又知道自己来自哪个源），而不是新起一行。
 *   3. **不同源里 sha256 相同的条目是同一个模板**，只留一行。
 *      官方源有 GitHub 和国内镜像两份，装的是同一批包；两个都启用时
 *      不去重的话，用户会看到每个模板都出现两遍。
 *      sha256 相同意味着字节完全一样，这个判断不会误伤。
 */
export function buildTemplateRows(
  localTemplates: TemplateInfo[],
  communityResults: CommunityFetchResult[]
): TemplateRow[] {
  const byIdentity = new Map<string, TemplateRow>()
  const bySha = new Map<string, TemplateRow>()
  const rows: TemplateRow[] = []

  for (const tpl of localTemplates) {
    const row = rowFromLocal(tpl)
    const identity = identityOf(tpl.sourceId, tpl.templateId)

    if (!identity) {
      rows.push(row)
      continue
    }

    const existing = byIdentity.get(identity)
    if (!existing) {
      byIdentity.set(identity, row)
      rows.push(row)
      continue
    }

    // 同一个模板落成了两个文件：保留更新的那份
    if (row.modifiedTime > existing.modifiedTime) {
      rows.splice(rows.indexOf(existing), 1, row)
      byIdentity.set(identity, row)
    }
  }

  for (const result of communityResults) {
    for (const template of result.templates) {
      const identity = `${result.sourceId}/${template.id}`
      const sha = template.sha256

      const sameIdentity = byIdentity.get(identity)
      if (sameIdentity) {
        sameIdentity.remote = { sourceId: result.sourceId, template }
        if (sha) bySha.set(sha, sameIdentity)
        continue
      }

      // 镜像源里的同一个包：已经有一行了，不再来一行
      if (sha && bySha.has(sha)) continue

      const row = rowFromRemote(result.sourceId, template)
      byIdentity.set(identity, row)
      if (sha) bySha.set(sha, row)
      rows.push(row)
    }
  }

  return rows
}

/** 引擎版本从高到低。5.10 要排在 5.9 前面，所以不能按字符串比 */
export function collectEngineVersions(rows: TemplateRow[]): string[] {
  return Array.from(new Set(rows.map((r) => r.engineVersion))).sort((a, b) => {
    const [aMajor = 0, aMinor = 0] = a.split('.').map(Number)
    const [bMajor = 0, bMinor = 0] = b.split('.').map(Number)
    return bMajor - aMajor || bMinor - aMinor
  })
}

/**
 * 筛选条件。三个数组都是 `readonly` —— `filterAndSortRows` 只读不写。
 *
 * 写成可变数组的话，调用方传一个 `as const` 的字面量就编不过（测试里最容易撞上），
 * 而放宽成 readonly 不会影响任何现有调用点：可变数组本来就能赋给 readonly。
 */
export interface RowFilter {
  keyword: string
  sources: readonly TemplateOrigin[]
  categories: readonly string[]
  engineVersions: readonly string[]
}

export type RowSort = 'recommended' | 'name' | 'size' | 'added'

/** 筛 + 排。搜索是全局的：一个关键词搜所有来源，不分标签页 */
export function filterAndSortRows(
  rows: TemplateRow[],
  filter: RowFilter,
  sort: RowSort
): TemplateRow[] {
  const keyword = filter.keyword.trim().toLowerCase()

  const result = rows.filter((row) => {
    if (filter.sources.length && !filter.sources.includes(row.origin)) return false
    if (filter.categories.length && !filter.categories.includes(row.category)) return false
    if (filter.engineVersions.length && !filter.engineVersions.includes(row.engineVersion)) {
      return false
    }
    if (!keyword) return true
    return (
      row.name.toLowerCase().includes(keyword) || row.description.toLowerCase().includes(keyword)
    )
  })

  if (sort === 'name') {
    result.sort((a, b) => a.name.localeCompare(b.name))
  } else if (sort === 'size') {
    result.sort((a, b) => b.size - a.size)
  } else if (sort === 'added') {
    result.sort((a, b) => b.modifiedTime - a.modifiedTime)
  } else {
    // 推荐：能马上用的排前面，其次是自己做的，最后按名称
    result.sort(
      (a, b) =>
        Number(!!b.local) - Number(!!a.local) ||
        Number(b.origin === 'user') - Number(a.origin === 'user') ||
        a.name.localeCompare(b.name)
    )
  }

  return result
}
