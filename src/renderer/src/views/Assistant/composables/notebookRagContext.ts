export interface NotebookRagCitation {
  id: string
  title: string
  url?: string | null
  filePath?: string | null
  content: string
  sourceId: string
  type: 'file' | 'link' | 'youtube' | 'text'
}

export interface NotebookRagContextMessage {
  role: 'user'
  content: string
}

export interface NotebookRagWarning {
  code: 'no_selected_sources' | 'no_indexed_sources' | 'some_sources_not_ready' | 'search_failed'
  message: string
  severity: 'info' | 'warning'
}

export interface NotebookRagContextResult {
  citations: NotebookRagCitation[]
  contextMessage?: NotebookRagContextMessage
  warnings?: NotebookRagWarning[]
  queuedIndexSourceIds?: string[]
  mode?: string
}

interface BuildNotebookRagContextParams {
  notebookId: string
  query: string
  sourceIds?: string[]
  notebookTitle?: string
}

const RAG_LIMIT = 5
const DEFAULT_NOTEBOOK_TITLE = '当前知识库'

export interface NotebookRagTarget {
  notebookId: string
  title: string
}

interface ResolveNotebookRagTargetParams {
  boundNotebook?: NotebookRagTarget | null
  routeName?: unknown
  routeNotebookId?: unknown
  getNotebook?: (notebookId: string) => Promise<{ title?: string | null } | null>
}

const normalizeNotebookId = (value: unknown): string => {
  if (Array.isArray(value)) {
    return normalizeNotebookId(value[0])
  }
  return typeof value === 'string' ? value.trim() : ''
}

export async function resolveNotebookRagTarget(
  params: ResolveNotebookRagTargetParams
): Promise<NotebookRagTarget | null> {
  const boundNotebookId = normalizeNotebookId(params.boundNotebook?.notebookId)
  if (boundNotebookId) {
    return {
      notebookId: boundNotebookId,
      title: params.boundNotebook?.title?.trim() || DEFAULT_NOTEBOOK_TITLE
    }
  }

  if (params.routeName !== 'NotebookDetail') {
    return null
  }

  const routeNotebookId = normalizeNotebookId(params.routeNotebookId)
  if (!routeNotebookId) {
    return null
  }

  let title = DEFAULT_NOTEBOOK_TITLE
  try {
    const notebook = await params.getNotebook?.(routeNotebookId)
    title = notebook?.title?.trim() || title
  } catch (error) {
    console.warn('[notebookRagContext] Failed to resolve current notebook title:', error)
  }

  return {
    notebookId: routeNotebookId,
    title
  }
}

export function extractTextForNotebookRag(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter(
      (item) => item && typeof item === 'object' && (item as { type?: string }).type === 'text'
    )
    .map((item) => String((item as { text?: string }).text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export async function buildNotebookRagContext(
  params: BuildNotebookRagContextParams
): Promise<NotebookRagContextResult> {
  const query = params.query.trim()
  if (!params.notebookId || !query) {
    return { citations: [] }
  }

  const prepared = await window.api.notebook.chatV2Prepare({
    notebookId: params.notebookId,
    query,
    limit: RAG_LIMIT,
    notebookTitle: params.notebookTitle,
    sourceIds: params.sourceIds
  })

  let queuedIndexSourceIds: string[] = []
  const sourcesNeedingIndex = prepared.sourceStates
    .filter((source) => source.shouldIndex)
    .map((source) => source.sourceId)

  if (sourcesNeedingIndex.length > 0) {
    try {
      const queued = await window.api.notebook.ragQueueIndex({
        notebookId: params.notebookId,
        sourceIds: sourcesNeedingIndex
      })
      queuedIndexSourceIds = queued.queuedSourceIds
    } catch (error) {
      console.warn('[notebookRagContext] Failed to queue notebook indexing:', error)
    }
  }

  if (prepared.citations.length === 0) {
    return {
      citations: [],
      warnings: prepared.warnings,
      queuedIndexSourceIds,
      mode: prepared.mode
    }
  }

  const citations: NotebookRagCitation[] = prepared.citations.map((citation) => ({
    id: citation.id,
    title: citation.title,
    url: citation.url,
    filePath: citation.filePath,
    content: citation.content,
    sourceId: citation.sourceId,
    type:
      citation.type === 'file' ||
      citation.type === 'link' ||
      citation.type === 'youtube' ||
      citation.type === 'text'
        ? citation.type
        : 'text'
  }))

  return {
    citations,
    contextMessage: prepared.contextMessage,
    warnings: prepared.warnings,
    queuedIndexSourceIds,
    mode: prepared.mode
  }
}
