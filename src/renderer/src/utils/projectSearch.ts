interface SearchableProject {
  projectName?: string | null
  projectPath?: string | null
  originPath?: string | null
  projectKey?: string | null
}

/** Lower ranks are more relevant. Empty searches preserve the existing order. */
export function projectSearchRank(project: SearchableProject, keyword: string): number {
  const query = keyword.trim().toLowerCase()
  if (!query) return 0
  const name = (project.projectName || '').trim().toLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if ([project.projectPath, project.originPath].some((path) => path?.toLowerCase().includes(query)))
    return 3
  if (project.projectKey?.toLowerCase().includes(query)) return 4
  return 5
}

/** Stable sort keeps pinning/manual order only between equally relevant results. */
export function rankProjectSearch<T extends SearchableProject>(
  projects: T[],
  keyword: string
): T[] {
  if (!keyword.trim()) return projects
  return projects
    .filter((p) => projectSearchRank(p, keyword) < 5)
    .sort((a, b) => projectSearchRank(a, keyword) - projectSearchRank(b, keyword))
}
