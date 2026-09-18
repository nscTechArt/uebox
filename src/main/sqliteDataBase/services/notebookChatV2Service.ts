import Database from 'better-sqlite3'
import { searchNotebookRag } from './notebookRagService'
import { normalizeNotebookRagError } from './notebookRagErrors'
import type { NotebookChunkSearchResult } from '../models/notebookRag'
import {
  normalizeNotebookContextLevel,
  type NotebookContextLevel
} from '../../../shared/notebookContext'

const DEFAULT_RAG_LIMIT = 5
const DEFAULT_CONTEXT_MAX_CHARS = 8000
const DEFAULT_SEARCH_TIMEOUT_MS = 8000

export type NotebookChatV2Mode =
  | 'rag'
  | 'no_selected_sources'
  | 'no_indexed_sources'
  | 'no_results'
  | 'search_failed'

export type NotebookChatV2SourceFreshness =
  | 'indexed'
  /** 片段与全文索引是新的，向量还没有 —— 关键词可检索 */
  | 'keyword'
  | 'stale'
  | 'pending'
  | 'indexing'
  | 'error'
  | 'empty'
  | 'loading'
  | 'unindexed'

export interface NotebookChatV2Warning {
  code: 'no_selected_sources' | 'no_indexed_sources' | 'some_sources_not_ready' | 'search_failed'
  message: string
  severity: 'info' | 'warning'
}

export interface NotebookChatV2SourceState {
  sourceId: string
  title: string
  type: string
  contextLevel: NotebookContextLevel
  loading: boolean
  hasContent: boolean
  indexStatus: string | null
  indexError: string | null
  indexedAt: string | null
  updatedAt: string | null
  chunkCount: number
  indexFreshness: NotebookChatV2SourceFreshness
  /** 能检索（至少关键词一路） */
  canSearch: boolean
  /** 向量也齐了，语义一路会参与 */
  vectorReady: boolean
  shouldIndex: boolean
  reason?: string
}

export interface NotebookChatV2Citation {
  id: string
  title: string
  url?: string | null
  filePath?: string | null
  content: string
  sourceId: string
  type?: string | null
}

export interface NotebookChatV2ContextMessage {
  role: 'user'
  content: string
}

export interface NotebookChatV2PrepareParams {
  notebookId: string
  query: string
  sourceIds?: string[]
  notebookTitle?: string
  limit?: number
  contextMaxChars?: number
  searchTimeoutMs?: number
}

export interface NotebookChatV2PrepareResult {
  ok: true
  mode: NotebookChatV2Mode
  citations: NotebookChatV2Citation[]
  contextMessage?: NotebookChatV2ContextMessage
  sourceStates: NotebookChatV2SourceState[]
  warnings: NotebookChatV2Warning[]
  diagnostics: {
    queryLength: number
    selectedSourceCount: number
    indexedSourceCount: number
    resultCount: number
    contextChars: number
    elapsedMs: number
    searchElapsedMs?: number
  }
}

interface NotebookChatV2SourceRow {
  sourceId: string
  title: string
  type: string
  sourceUrl: string | null
  fileName: string | null
  loading: number
  contextLevel: string | null
  indexStatus: string | null
  indexError: string | null
  indexedAt: string | null
  updatedAt: string | null
  contentHash: string | null
  contentRevision: number | null
  indexedContentHash: string | null
  indexedRevision: number | null
  contentLength: number
  chunkCount: number
}

const normalizeSourceIds = (sourceIds?: string[]): string[] =>
  Array.from(
    new Set(
      (sourceIds ?? []).map((sourceId) => sourceId.trim()).filter((sourceId) => sourceId.length > 0)
    )
  )

export const classifyNotebookChatV2Source = (
  row: Pick<
    NotebookChatV2SourceRow,
    | 'sourceId'
    | 'title'
    | 'type'
    | 'loading'
    | 'contextLevel'
    | 'indexStatus'
    | 'indexError'
    | 'indexedAt'
    | 'updatedAt'
    | 'contentHash'
    | 'contentRevision'
    | 'indexedContentHash'
    | 'indexedRevision'
    | 'contentLength'
    | 'chunkCount'
  >
): NotebookChatV2SourceState => {
  const loading = row.loading === 1
  const hasContent = row.contentLength > 0
  const indexStatus = row.indexStatus ?? null
  const isHashAligned =
    Boolean(row.contentHash) &&
    row.contentHash === row.indexedContentHash &&
    (row.indexedRevision ?? null) === (row.contentRevision ?? null)

  /**
   * 片段是不是当前内容切出来的。**能不能检索只看这个**，不看状态：
   * 向量化中途失败、后台队列把状态改回 pending 重试 —— 片段和全文索引
   * 都还在，关键词那一路照常能答，没理由让用户等。
   */
  const hasCurrentChunks = !loading && hasContent && row.chunkCount > 0 && isHashAligned

  let indexFreshness: NotebookChatV2SourceFreshness = 'unindexed'
  let reason: string | undefined

  if (loading) {
    indexFreshness = 'loading'
    reason = '来源内容仍在加载'
  } else if (!hasContent) {
    indexFreshness = 'empty'
    reason = '来源内容为空'
  } else if (indexStatus === 'indexing') {
    indexFreshness = 'indexing'
    reason = '来源正在建索引'
  } else if (indexStatus === 'error') {
    indexFreshness = 'error'
    reason = row.indexError || '来源建索引失败'
  } else if (indexStatus === 'indexed' && row.chunkCount > 0) {
    if (!isHashAligned) {
      indexFreshness = 'stale'
      reason = '来源内容已更新，需要重新建索引'
    } else {
      indexFreshness = 'indexed'
    }
  } else if (indexStatus === 'keyword' && row.chunkCount > 0) {
    if (!isHashAligned) {
      indexFreshness = 'stale'
      reason = '来源内容已更新，需要重新建索引'
    } else {
      indexFreshness = 'keyword'
      reason = row.indexError || '未配置嵌入模型，仅按关键词检索'
    }
  } else if (indexStatus === 'pending') {
    indexFreshness = 'pending'
    reason = '来源尚未建索引'
  } else {
    indexFreshness = 'unindexed'
    reason = '来源没有可用索引'
  }

  const canSearch = hasCurrentChunks
  const vectorReady = hasCurrentChunks && indexStatus === 'indexed'
  const shouldIndex =
    hasContent &&
    !loading &&
    (indexFreshness === 'pending' ||
      indexFreshness === 'stale' ||
      indexFreshness === 'unindexed' ||
      indexFreshness === 'error')

  return {
    sourceId: row.sourceId,
    title: row.title,
    type: row.type,
    contextLevel: normalizeNotebookContextLevel(row.contextLevel),
    loading,
    hasContent,
    indexStatus,
    indexError: row.indexError ?? null,
    indexedAt: row.indexedAt ?? null,
    updatedAt: row.updatedAt ?? null,
    chunkCount: row.chunkCount,
    indexFreshness,
    canSearch,
    vectorReady,
    shouldIndex,
    reason
  }
}

export const buildNotebookChatV2ContextMessage = (
  citations: NotebookChatV2Citation[],
  options: { notebookTitle?: string; maxChars?: number } = {}
): NotebookChatV2ContextMessage | undefined => {
  if (citations.length === 0) {
    return undefined
  }

  const maxChars = Math.max(1000, options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS)

  /*
    按**引用边界**装，不从字符串中间切。

    上一版是把所有引用拼成一整段再 `slice(0, maxChars)` —— 最后一条引用常常只剩
    半句，而它前面还挂着 `[3] 来源：xxx`。模型看到的是一条标着出处的残句，
    会把它当成完整的参考资料去引用。
  */
  const allBlocks = citations.map(
    (citation, index) => `[${index + 1}] 来源：${citation.title}\n内容：${citation.content}`
  )

  const blocks: string[] = []
  let used = 0

  for (const block of allBlocks) {
    const cost = block.length + (blocks.length > 0 ? 2 : 0) // +2 是块之间的空行
    if (used + cost > maxChars) break
    blocks.push(block)
    used += cost
  }

  // 第一条自己就超预算时，整段上下文会是空的 —— 与其什么都不给，
  // 不如把这一条截到预算内。这是唯一会从中间切的情况，而且会明说截了。
  const firstTruncated = blocks.length === 0
  if (firstTruncated) blocks.push(allBlocks[0].slice(0, maxChars))

  const droppedCount = citations.length - (firstTruncated ? 1 : blocks.length)

  let contextText = blocks.join('\n\n')
  if (firstTruncated) contextText += '\n\n...[这条内容过长，已截断]'
  if (droppedCount > 0) {
    contextText += `\n\n...[还有 ${droppedCount} 条相关内容因长度限制未列出]`
  }

  const title = options.notebookTitle?.trim()
  return {
    role: 'user',
    content: `【相关知识库上下文${title ? ` - ${title}` : ''}】
${contextText}

请结合以上参考知识回答我的问题；引用时请在句尾使用 [x] 标注来源。`
  }
}

const getNotebookChatV2SourceRows = (
  db: Database.Database,
  notebookId: string,
  sourceIds?: string[]
): NotebookChatV2SourceRow[] => {
  if (sourceIds && sourceIds.length === 0) {
    return []
  }

  const params: string[] = [notebookId]
  // 「不进上下文」的来源也不检索：检索到的片段最后照样会进提示词，
  // 让它可检索等于没排除。
  let sourceFilter = `AND COALESCE(s.context_level, 'full') <> 'excluded'`

  if (sourceIds) {
    sourceFilter = `AND s.source_id IN (${sourceIds.map(() => '?').join(',')})`
    params.push(...sourceIds)
  }

  const stmt = db.prepare(`
    SELECT
      s.source_id as sourceId,
      s.title as title,
      s.type as type,
      s.source_url as sourceUrl,
      s.file_name as fileName,
      s.loading as loading,
      s.context_level as contextLevel,
      s.index_status as indexStatus,
      s.index_error as indexError,
      s.indexed_at as indexedAt,
      s.updated_at as updatedAt,
      s.content_hash as contentHash,
      s.content_revision as contentRevision,
      s.indexed_content_hash as indexedContentHash,
      s.indexed_revision as indexedRevision,
      LENGTH(COALESCE(s.content, '')) as contentLength,
      COUNT(c.id) as chunkCount
    FROM notebook_sources s
    LEFT JOIN notebook_chunks c ON c.source_id = s.source_id
    WHERE s.notebook_id = ?
      ${sourceFilter}
    GROUP BY
      s.source_id,
      s.title,
      s.type,
      s.source_url,
      s.file_name,
      s.loading,
      s.context_level,
      s.index_status,
      s.index_error,
      s.indexed_at,
      s.updated_at,
      s.content_hash,
      s.content_revision,
      s.indexed_content_hash,
      s.indexed_revision,
      s.content
    ORDER BY s.updated_at DESC
  `)

  return stmt.all(...params) as NotebookChatV2SourceRow[]
}

const resolveCitationType = (result: NotebookChunkSearchResult): string => {
  if (result.type === 'youtube') return 'youtube'
  if (result.type === 'bilibili') return 'bilibili'
  if (result.sourceUrl?.includes('youtube.com') || result.sourceUrl?.includes('youtu.be')) {
    return 'youtube'
  }
  if (result.sourceUrl) return 'link'
  if (result.fileName) return 'file'
  return result.type || 'text'
}

const buildCitations = (results: NotebookChunkSearchResult[]): NotebookChatV2Citation[] =>
  results.map((result, index) => ({
    id: String(index + 1),
    title: result.sourceTitle || result.fileName || '未知来源',
    url: result.sourceUrl,
    filePath: result.fileName,
    content: result.content,
    sourceId: result.sourceId,
    type: resolveCitationType(result)
  }))

const searchWithTimeout = async (
  searchPromise: Promise<NotebookChunkSearchResult[]>,
  timeoutMs: number
): Promise<NotebookChunkSearchResult[]> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let raceSettled = false

  searchPromise.catch((error) => {
    if (raceSettled) {
      console.warn('[NotebookChatV2] Late RAG search failure:', error)
    }
  })

  const timeoutPromise = new Promise<NotebookChunkSearchResult[]>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Notebook Chat V2 search timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  })

  try {
    return await Promise.race([searchPromise, timeoutPromise])
  } finally {
    raceSettled = true
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

const buildReadinessWarnings = (
  sourceStates: NotebookChatV2SourceState[],
  indexedSourceCount: number
): NotebookChatV2Warning[] => {
  if (sourceStates.length === 0) {
    return [
      {
        code: 'no_selected_sources',
        message: '当前没有选中的知识库来源。',
        severity: 'info'
      }
    ]
  }

  if (indexedSourceCount === 0) {
    return [
      {
        code: 'no_indexed_sources',
        message: '当前选中的知识库来源还没有建好索引，本轮将先按普通对话继续。',
        severity: 'info'
      }
    ]
  }

  const notReadyCount = sourceStates.filter((source) => !source.canSearch).length
  if (notReadyCount > 0) {
    return [
      {
        code: 'some_sources_not_ready',
        message: `${notReadyCount} 个选中来源暂不可检索，已使用 ${indexedSourceCount} 个就绪来源回答。`,
        severity: 'info'
      }
    ]
  }

  return []
}

const emptyResult = (
  mode: NotebookChatV2Mode,
  params: {
    startedAt: number
    queryLength: number
    sourceStates: NotebookChatV2SourceState[]
    warnings?: NotebookChatV2Warning[]
  }
): NotebookChatV2PrepareResult => ({
  ok: true,
  mode,
  citations: [],
  sourceStates: params.sourceStates,
  warnings: params.warnings ?? [],
  diagnostics: {
    queryLength: params.queryLength,
    selectedSourceCount: params.sourceStates.length,
    indexedSourceCount: params.sourceStates.filter((source) => source.canSearch).length,
    resultCount: 0,
    contextChars: 0,
    elapsedMs: Date.now() - params.startedAt
  }
})

export const prepareNotebookChatV2 = async (
  db: Database.Database,
  params: NotebookChatV2PrepareParams
): Promise<NotebookChatV2PrepareResult> => {
  const startedAt = Date.now()
  const query = params.query.trim()
  const explicitSourceIds = params.sourceIds !== undefined
  const sourceIds = explicitSourceIds ? normalizeSourceIds(params.sourceIds) : undefined
  const sourceRows = getNotebookChatV2SourceRows(db, params.notebookId, sourceIds)
  const sourceStates = sourceRows.map(classifyNotebookChatV2Source)
  const indexedSourceIds = sourceStates
    .filter((source) => source.canSearch)
    .map((source) => source.sourceId)
  const readinessWarnings = buildReadinessWarnings(sourceStates, indexedSourceIds.length)

  if (!query) {
    return emptyResult('no_results', {
      startedAt,
      queryLength: 0,
      sourceStates,
      warnings: readinessWarnings
    })
  }

  if (sourceStates.length === 0) {
    return emptyResult('no_selected_sources', {
      startedAt,
      queryLength: query.length,
      sourceStates,
      warnings: readinessWarnings
    })
  }

  if (indexedSourceIds.length === 0) {
    return emptyResult('no_indexed_sources', {
      startedAt,
      queryLength: query.length,
      sourceStates,
      warnings: readinessWarnings
    })
  }

  let results: NotebookChunkSearchResult[] = []
  let searchElapsedMs: number | undefined

  try {
    const searchStartedAt = Date.now()
    results = await searchWithTimeout(
      searchNotebookRag(db, params.notebookId, query, {
        limit: params.limit ?? DEFAULT_RAG_LIMIT,
        sourceIds: indexedSourceIds
      }),
      params.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
    )
    searchElapsedMs = Date.now() - searchStartedAt
  } catch (error) {
    const normalizedError = normalizeNotebookRagError(error, 'search')
    const warnings: NotebookChatV2Warning[] = [
      ...readinessWarnings,
      {
        code: 'search_failed',
        message: normalizedError.message,
        severity: 'warning'
      }
    ]
    return emptyResult('search_failed', {
      startedAt,
      queryLength: query.length,
      sourceStates,
      warnings
    })
  }

  const citations = buildCitations(results)
  const contextMessage = buildNotebookChatV2ContextMessage(citations, {
    notebookTitle: params.notebookTitle,
    maxChars: params.contextMaxChars ?? DEFAULT_CONTEXT_MAX_CHARS
  })

  return {
    ok: true,
    mode: citations.length > 0 ? 'rag' : 'no_results',
    citations,
    contextMessage,
    sourceStates,
    warnings: readinessWarnings,
    diagnostics: {
      queryLength: query.length,
      selectedSourceCount: sourceStates.length,
      indexedSourceCount: indexedSourceIds.length,
      resultCount: citations.length,
      contextChars: contextMessage?.content.length ?? 0,
      elapsedMs: Date.now() - startedAt,
      searchElapsedMs
    }
  }
}
