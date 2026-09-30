import { projectSearchRank } from '@renderer/utils/projectSearch'

export interface ImportProjectChoice {
  isPinned?: number | null
  id?: number
  projectKey: string
  projectName?: string | null
  projectPath?: string | null
  originPath?: string | null
  EngineAssociation?: string | null
  image?: string | null
}

interface ConnectedChoice {
  connectionId: string
  projectName?: string
  projectPath?: string
  engineVersion?: string
  isConnected?: boolean
}

export function importProjectConnection(
  project: ImportProjectChoice,
  connected: ConnectedChoice[]
): string | undefined {
  const paths = [project.projectPath, project.originPath]
    .map((path) => projectDirectory(path).toLowerCase())
    .filter(Boolean)
  return connected.find(
    (item) => item.isConnected && paths.includes(projectDirectory(item.projectPath).toLowerCase())
  )?.connectionId
}

export function projectDirectory(path?: string | null): string {
  return String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/\/[^/]+\.uproject$/i, '')
}

/** Merge before filtering: a search must never replace a saved cover with a synthetic record. */
export function importProjectChoices(
  saved: ImportProjectChoice[],
  connected: ConnectedChoice[],
  keyword: string
): ImportProjectChoice[] {
  const choices = [...saved]
  const connectedPaths = new Set<string>()
  for (const project of connected) {
    if (!project.isConnected || !project.projectPath) continue
    const directory = projectDirectory(project.projectPath)
    const key = directory.toLowerCase()
    connectedPaths.add(key)
    const match = choices.find((item) =>
      [item.projectPath, item.originPath].some(
        (path) => projectDirectory(path).toLowerCase() === key
      )
    )
    if (match) continue
    choices.push({
      projectKey: `ws-${key}`,
      projectName: project.projectName,
      projectPath: directory,
      originPath: project.projectPath,
      EngineAssociation: String(project.engineVersion || '').match(/\d+\.\d+/)?.[0] || null
    })
  }
  const query = keyword.trim().toLowerCase()
  const isConnected = (item: ImportProjectChoice): number =>
    Number(
      [item.projectPath, item.originPath].some((path) =>
        connectedPaths.has(projectDirectory(path).toLowerCase())
      )
    )
  return choices
    .filter((item) => projectSearchRank(item, query) < 5)
    .sort(
      (a, b) =>
        projectSearchRank(a, query) - projectSearchRank(b, query) ||
        Number(b.isPinned === 1) - Number(a.isPinned === 1) ||
        isConnected(b) - isConnected(a)
    )
}

export interface ImportProjectCollection {
  collectionKey: string
  name?: string | null
  items?: ImportProjectChoice[]
}

/** 「全部」「未分组」不是真分组，用哨兵值占位 —— 跟首页「我的项目」那一排是同一套 */
export const IMPORT_FILTER_ALL = '__all__'
export const IMPORT_FILTER_UNGROUPED = '__ungrouped__'

export interface ImportFilterChip {
  key: string
  /** 真分组的名字；「全部」「未分组」是 null，由界面自己翻译 */
  name: string | null
  projects: ImportProjectChoice[]
}

/**
 * 分组筛选条，跟首页「我的项目」一致：全部 / 各分组 / 未分组。
 *
 * projects 是已经按搜索词和版本筛过、排好序的那批 —— 每颗按钮的计数和点进去看到的
 * 卡片读的是同一份，按钮上标着 6、点进去只有 2 的情况不会出现。
 * 一个工程可以同时在几个分组里，所以成员只认分组自己带回来的那份名单。
 */
export function importFilterChips(
  projects: ImportProjectChoice[],
  collections: ImportProjectCollection[]
): ImportFilterChip[] {
  const grouped = new Set(collections.flatMap((c) => (c.items || []).map((p) => p.projectKey)))
  const chips: ImportFilterChip[] = [{ key: IMPORT_FILTER_ALL, name: null, projects }]
  // 顺序照数据库给的来，跟首页那一排一致
  for (const collection of collections) {
    const members = new Set((collection.items || []).map((p) => p.projectKey))
    chips.push({
      key: collection.collectionKey,
      name: collection.name || '',
      projects: projects.filter((p) => members.has(p.projectKey))
    })
  }
  // 一个分组都没有的时候不单列「未分组」，那等于把「全部」说两遍
  if (collections.length) {
    chips.push({
      key: IMPORT_FILTER_UNGROUPED,
      name: null,
      projects: projects.filter((p) => !grouped.has(p.projectKey))
    })
  }
  return chips
}
