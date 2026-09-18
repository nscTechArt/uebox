type NotebookRouteQuery = Record<string, string>

export function createNotebookTabId(): string {
  const timestamp = Date.now().toString(36)
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return `notebook-tab-${timestamp}-${randomSuffix}`
}

export function buildNotebookDetailRoute(id: string, extraQuery: NotebookRouteQuery = {}) {
  return {
    name: 'NotebookDetail' as const,
    params: { id },
    query: {
      ...extraQuery,
      _tab_id: createNotebookTabId()
    }
  }
}

export function buildNotebookListRoute(tabId?: string, extraQuery: NotebookRouteQuery = {}) {
  const query: NotebookRouteQuery = { ...extraQuery }
  const normalizedTabId = String(tabId || '').trim()
  if (normalizedTabId) {
    query._tab_id = normalizedTabId
  }
  return {
    name: 'NotebookList' as const,
    query
  }
}

export function getNotebookTabIdFromQuery(query: Record<string, unknown>): string {
  const tabId = query._tab_id
  return typeof tabId === 'string' && tabId.trim() ? tabId : 'default'
}
