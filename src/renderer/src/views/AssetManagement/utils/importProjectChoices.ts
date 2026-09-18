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
  isPinned?: number | null
  sort_order?: number | null
  items?: ImportProjectChoice[]
}

export type ImportBrowserEntry =
  | { kind: 'project'; key: string; project: ImportProjectChoice; pinned: boolean }
  | {
      kind: 'collection'
      key: string
      collection: ImportProjectCollection
      projects: ImportProjectChoice[]
      pinned: boolean
    }

/**
 * Keep collection members together, including matches found by search or engine version.
 *
 * A collection entry carries its own members so the modal can expand it in place — there is
 * no drilled-in mode: picking an import target should never cost a round trip into a sub-view.
 */
export function importBrowserEntries(
  projects: ImportProjectChoice[],
  collections: ImportProjectCollection[],
  keyword: string,
  version: string,
  label: (association?: string | null) => string
): ImportBrowserEntry[] {
  const query = keyword.trim().toLowerCase()
  const matching = new Set(importProjectChoices(projects, [], keyword).map((p) => p.projectKey))
  // 一个工程可以同时在几个分组里，所以成员只认分组自己带回来的那份名单
  const members = (collection: ImportProjectCollection): ImportProjectChoice[] =>
    projects.filter((p) => collection.items?.some((item) => item.projectKey === p.projectKey))
  const matchesVersion = (p: ImportProjectChoice): boolean =>
    !version || label(p.EngineAssociation) === version
  const relevance = (entry: ImportBrowserEntry): number =>
    entry.kind === 'project'
      ? projectSearchRank(entry.project, query)
      : Math.min(
          projectSearchRank({ projectName: entry.collection.name }, query),
          ...entry.projects.map((p) => projectSearchRank(p, query))
        )
  const compare = (a: ImportBrowserEntry, b: ImportBrowserEntry): number =>
    relevance(a) - relevance(b) || Number(b.pinned) - Number(a.pinned)
  const compareProjects = (a: ImportProjectChoice, b: ImportProjectChoice): number =>
    projectSearchRank(a, query) - projectSearchRank(b, query) ||
    Number(b.isPinned === 1) - Number(a.isPinned === 1)
  const entry = (project: ImportProjectChoice): ImportBrowserEntry => ({
    kind: 'project',
    key: project.projectKey,
    project,
    pinned: project.isPinned === 1
  })
  const grouped = new Set(collections.flatMap((c) => members(c).map((p) => p.projectKey)))
  const entries: ImportBrowserEntry[] = collections
    .slice()
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .flatMap((collection) => {
      const items = members(collection)
        .filter(
          (p) =>
            matchesVersion(p) &&
            (!query || matching.has(p.projectKey) || collection.name?.toLowerCase().includes(query))
        )
        .sort(compareProjects)
      return items.length
        ? [
            {
              kind: 'collection' as const,
              key: collection.collectionKey,
              collection,
              projects: items,
              pinned: collection.isPinned === 1
            }
          ]
        : []
    })
  entries.push(
    ...projects
      .filter((p) => !grouped.has(p.projectKey) && matchesVersion(p) && matching.has(p.projectKey))
      .map(entry)
  )
  return entries.sort(compare)
}
