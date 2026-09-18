import Database from 'better-sqlite3'
import {
  createNotebookChunk,
  deleteNotebookChunksBySource,
  getNotebookSourcesForIndex,
  insertNotebookChunkVector,
  searchNotebookChunks,
  searchNotebookChunksByKeyword,
  updateNotebookSourceIndexStatus,
  type NotebookChunkSearchResult
} from '../models/notebookRag'
import { buildFtsMatchQuery } from '../models/ftsText'
import { updateNotebookSource } from '../models/notebook'
import { getNoteById } from '../models/note'
import {
  getChunkOverlap,
  getChunkSize,
  getEmbeddingBatchSize,
  getEmbeddingDim,
  getEmbeddingModel,
  getRecallDistanceThreshold
} from './notebookRagConfig'
import { normalizeNotebookRagError } from './notebookRagErrors'
import { computeNotebookSourceContentHash } from './notebookSourceHash'
import { sanitizeEmbeddingInputs } from './textSanitizer'
import { ensureSqliteVecLoaded } from '../sqliteVec'
import { embedTexts as embedViaProvider, type EmbeddingTask } from '../../ai/embedding'
import { reconcileEmbeddingIndex, refreshEmbeddingModelTag } from './embeddingReconcile'

/**
 * 知识库的索引与检索。
 *
 * 两条路：
 *
 * - **关键词**（FTS5）：切片时本地建，零依赖。这是根基 —— 没配嵌入模型、
 *   密钥失效、扩展没加载，知识库都还能按关键词答问题。
 * - **向量**（sqlite-vec）：要调嵌入模型。有就建、建不了就记下原因跳过，
 *   **不拦住关键词那条路**。
 *
 * 来源的 `index_status` 由此多了一个值：`keyword` = 片段与全文索引是新的、
 * 向量还没有（原因写在 index_error 里）。`indexed` 仍然表示两路都齐。
 *
 * 检索时两路各自召回，按名次用 RRF 融合 —— 和资产库搜索是同一套做法。
 */

/** 每路召回多少候选再融合。只取 limit 的话，两路的长尾互补就体现不出来 */
const RECALL_CANDIDATE_FLOOR = 20
/** RRF 常数，压住尾部：排到第 500 名的命中不该和第 5 名差着 100 倍 */
const RRF_K = 60

interface NotebookSourceDiagnosticRow {
  sourceId: string
  title: string
  type: string
  loading: number
  indexStatus: string | null
  indexedAt: string | null
  updatedAt: string | null
  contentLength: number
  chunkCount: number
}

type NotebookSourceForIndex = ReturnType<typeof getNotebookSourcesForIndex>[number]

const previewText = (value: string, maxLength = 120): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, maxLength)

const summarizeSearchResults = (
  results: NotebookChunkSearchResult[]
): Array<{
  sourceId: string
  sourceTitle: string | null | undefined
  chunkIndex: number
  distance: number | null
  matchedBy: string | undefined
  contentPreview: string
}> =>
  results.map((result) => ({
    sourceId: result.sourceId,
    sourceTitle: result.sourceTitle,
    chunkIndex: result.chunkIndex,
    distance: result.distance === null ? null : Number(result.distance.toFixed(4)),
    matchedBy: result.matchedBy,
    contentPreview: previewText(result.content, 80)
  }))

const getNotebookSourceDiagnostics = (
  db: Database.Database,
  notebookId: string,
  sourceIds?: string[]
): NotebookSourceDiagnosticRow[] => {
  const sourceFilter =
    sourceIds && sourceIds.length > 0
      ? `AND s.source_id IN (${sourceIds.map(() => '?').join(',')})`
      : ''
  const stmt = db.prepare(`
    SELECT
      s.source_id as sourceId,
      s.title as title,
      s.type as type,
      s.loading as loading,
      s.index_status as indexStatus,
      s.indexed_at as indexedAt,
      s.updated_at as updatedAt,
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
      s.loading,
      s.index_status,
      s.indexed_at,
      s.updated_at,
      s.content
    ORDER BY s.updated_at DESC
  `)

  return stmt.all(notebookId, ...(sourceIds ?? [])) as NotebookSourceDiagnosticRow[]
}

const ensureSourceContentFingerprint = (
  db: Database.Database,
  source: NotebookSourceForIndex
): void => {
  if (source.contentHash && source.contentRevision) {
    return
  }

  if (!source.content || source.content.trim().length === 0) {
    return
  }

  source.contentHash = computeNotebookSourceContentHash(source.content)
  source.contentRevision = Math.max(1, source.contentRevision ?? 1)
  updateNotebookSourceIndexStatus(db, source.sourceId, {
    contentHash: source.contentHash,
    contentRevision: source.contentRevision
  })
}

/** 取文本向量，走用户自己绑定的「嵌入」角色 Provider（见 ai/embedding.ts） */
const requestEmbeddings = async (inputs: string[], task: EmbeddingTask): Promise<number[][]> => {
  return embedViaProvider(inputs, task)
}

const embedTexts = async (
  inputs: string[],
  task: EmbeddingTask = 'document'
): Promise<number[][]> => {
  // 验证并清洗输入，防止无效 Unicode 或空字符串导致厂商接口 400
  const validatedInputs = sanitizeEmbeddingInputs(inputs, 'NotebookRAG')

  const batchSize = Math.max(1, getEmbeddingBatchSize())
  const allEmbeddings: number[][] = []
  for (let i = 0; i < validatedInputs.length; i += batchSize) {
    const batch = validatedInputs.slice(i, i + batchSize)
    const embeddings = await requestEmbeddings(batch, task)
    allEmbeddings.push(...embeddings)
  }
  return allEmbeddings
}

const findSplitIndex = (text: string, start: number, end: number): number => {
  const window = text.slice(start, end)
  const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')]
  const best = Math.max(...candidates)
  if (best > Math.floor(window.length * 0.6)) {
    return start + best
  }
  return end
}

const splitText = (text: string): string[] => {
  const chunkSize = Math.max(200, getChunkSize())
  let overlap = Math.max(0, getChunkOverlap())
  if (overlap >= chunkSize) {
    overlap = Math.floor(chunkSize / 2)
  }

  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const rawEnd = Math.min(text.length, start + chunkSize)
    const end = rawEnd < text.length ? findSplitIndex(text, start, rawEnd) : rawEnd
    if (end <= start) {
      break
    }
    chunks.push(text.slice(start, end).trim())
    if (end >= text.length) {
      break
    }
    start = end - overlap
    if (start < 0) start = 0
  }

  return chunks.filter((chunk) => chunk.length > 0)
}

export type NotebookVectorRoute = { available: true } | { available: false; reason: string }

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 这一轮能不能算向量。
 *
 * 探针一次、整轮复用：不配模型时每个来源都去撞一次同样的错没有意义。
 * 探针成功还顺带把维度对了一遍 —— 用户换过嵌入模型的话向量表要按新维度重建。
 */
const probeVectorRoute = async (db: Database.Database): Promise<NotebookVectorRoute> => {
  if (!ensureSqliteVecLoaded(db)) {
    return { available: false, reason: 'sqlite-vec 扩展未加载，本机暂时只能按关键词检索' }
  }
  try {
    await refreshEmbeddingModelTag()
    const [probe] = await embedTexts(['probe'])
    const dimension = probe?.length ?? 0
    if (dimension <= 0) {
      return { available: false, reason: '嵌入模型没有返回向量，检查一下服务商的配置' }
    }
    reconcileEmbeddingIndex(dimension)
    return { available: true }
  } catch (error) {
    return { available: false, reason: describeError(error) }
  }
}

const isSourceFingerprintIndexed = (source: NotebookSourceForIndex): boolean =>
  Boolean(source.contentHash) &&
  source.indexedContentHash === source.contentHash &&
  source.indexedRevision === source.contentRevision

export const indexNotebookRag = async (
  db: Database.Database,
  notebookId: string,
  options?: { sourceIds?: string[] }
): Promise<{ indexedSources: number; indexedChunks: number }> => {
  const sources = getNotebookSourcesForIndex(db, notebookId, options?.sourceIds)
  const vectorRoute = await probeVectorRoute(db)

  const model = vectorRoute.available ? getEmbeddingModel() : null
  const dim = vectorRoute.available ? getEmbeddingDim() : null
  const sourceDiagnostics = getNotebookSourceDiagnostics(db, notebookId, options?.sourceIds)

  console.log('[NotebookRAG] Index start', {
    notebookId,
    requestedSourceIds: options?.sourceIds ?? null,
    sourceCount: sources.length,
    vectorRoute,
    model,
    dim,
    chunkSize: getChunkSize(),
    chunkOverlap: getChunkOverlap(),
    batchSize: getEmbeddingBatchSize(),
    sources: sourceDiagnostics
  })

  /**
   * 检查外键引用是否仍然存在
   * 防止在异步 embedTexts 调用期间数据被删除导致的外键约束失败
   */
  const checkForeignKeysExist = db.prepare(`
    SELECT 1 FROM notebooks WHERE notebook_id = ?
    UNION ALL
    SELECT 1 FROM notebook_sources WHERE source_id = ?
  `)
  const foreignKeysExist = (sourceId: string): boolean =>
    (checkForeignKeysExist.all(notebookId, sourceId) as unknown[]).length >= 2

  /** 旧片段删掉、新片段连同全文索引一起写入。原子的：搜索看到的要么全旧要么全新 */
  const replaceChunksTx = db.transaction((chunkContents: string[], sourceId: string) => {
    if (!foreignKeysExist(sourceId)) {
      console.warn(`[NotebookRAG] Skipping source ${sourceId}: notebook or source no longer exists`)
      return null
    }
    deleteNotebookChunksBySource(db, sourceId)
    return chunkContents.map((content, index) =>
      createNotebookChunk(db, {
        chunkId: `${sourceId}-${index}`,
        notebookId,
        sourceId,
        content,
        chunkIndex: index
      })
    )
  })

  const insertVectorsTx = db.transaction(
    (rowIds: number[], embeddings: number[][], sourceId: string) => {
      if (!foreignKeysExist(sourceId)) {
        console.warn(`[NotebookRAG] Skipping vectors of ${sourceId}: source no longer exists`)
        return false
      }
      rowIds.forEach((rowId, index) => {
        insertNotebookChunkVector(db, rowId, JSON.stringify(embeddings[index]))
      })
      return true
    }
  )

  let indexedSources = 0
  let indexedChunks = 0

  for (const source of sources) {
    let forceIndex = false

    // 特殊处理：如果是笔记类型（type='text'），尝试从 notes 表拉取最新内容
    if (source.type === 'text') {
      try {
        const noteId = parseInt(source.sourceId)
        if (!isNaN(noteId)) {
          const note = getNoteById(db, noteId)
          if (note) {
            // 如果笔记内容有更新，同步到 source
            // 注意：即使 note.content 为空，也应该同步，以反映用户清空笔记的操作
            const noteContent = note.content || ''
            const noteTitle = note.title || 'Untitled Note'

            if (noteContent !== source.content || noteTitle !== source.title) {
              console.log(`[NotebookRAG] Syncing note ${noteId} to source ${source.sourceId}`)
              updateNotebookSource(db, source.sourceId, {
                title: noteTitle,
                content: noteContent
              })
              // 更新内存中的 source 对象，以便后续切片使用最新内容
              source.content = noteContent
              source.title = noteTitle
              source.contentHash = computeNotebookSourceContentHash(noteContent)
              source.contentRevision = Math.max(1, (source.contentRevision ?? 1) + 1)
              source.indexStatus = 'pending'
              forceIndex = true
            }
          } else {
            console.warn(`[NotebookRAG] Note ${noteId} not found for source ${source.sourceId}`)
          }
        }
      } catch (err) {
        console.warn(
          `[NotebookRAG] Failed to sync note content for source ${source.sourceId}:`,
          err
        )
      }
    }

    ensureSourceContentFingerprint(db, source)

    // 增量更新检查：片段是新的，且要么向量也齐了、要么这轮本来就算不了向量 —— 跳过。
    // 「仅关键词」的来源在向量路恢复之后会在这里落空，从而补上向量。
    if (!forceIndex && isSourceFingerprintIndexed(source)) {
      const complete = source.indexStatus === 'indexed'
      const keywordOnlyAndStuck = source.indexStatus === 'keyword' && !vectorRoute.available
      if (complete || keywordOnlyAndStuck) {
        if (keywordOnlyAndStuck) {
          // 原因可能变了（上次是没配模型，这次是密钥失效），标签要说当前的
          updateNotebookSourceIndexStatus(db, source.sourceId, { error: vectorRoute.reason })
        }
        console.log('[NotebookRAG] Skip up-to-date source', {
          notebookId,
          sourceId: source.sourceId,
          title: source.title,
          indexStatus: source.indexStatus,
          contentRevision: source.contentRevision,
          indexedRevision: source.indexedRevision
        })
        continue
      }
    }

    updateNotebookSourceIndexStatus(db, source.sourceId, {
      status: 'indexing',
      indexedAt: null,
      error: null,
      embeddingModel: model,
      embeddingDim: dim
    })

    if (source.loading === 1 || !source.content || source.content.trim().length === 0) {
      console.warn('[NotebookRAG] Source cannot be indexed because content is not ready', {
        notebookId,
        sourceId: source.sourceId,
        title: source.title,
        loading: source.loading,
        contentLength: source.content?.length ?? 0
      })
      updateNotebookSourceIndexStatus(db, source.sourceId, {
        status: 'error',
        error: 'Source content is empty or still loading'
      })
      continue
    }

    const chunks = splitText(source.content)
    console.log('[NotebookRAG] Source split complete', {
      notebookId,
      sourceId: source.sourceId,
      title: source.title,
      type: source.type,
      contentLength: source.content.length,
      chunkCount: chunks.length,
      forceIndex
    })
    if (chunks.length === 0) {
      updateNotebookSourceIndexStatus(db, source.sourceId, {
        status: 'error',
        error: 'No chunks generated from content'
      })
      continue
    }

    // ── 第一步：切片 + 全文索引。本地完成，到这里知识库就已经能按关键词搜了 ──
    const chunkRowIds = replaceChunksTx(chunks, source.sourceId)
    if (!chunkRowIds) {
      continue
    }

    const indexedContentHash =
      source.contentHash ?? computeNotebookSourceContentHash(source.content)
    const indexedRevision = source.contentRevision ?? 1
    updateNotebookSourceIndexStatus(db, source.sourceId, {
      status: 'keyword',
      indexedAt: new Date().toISOString(),
      error: vectorRoute.available ? null : vectorRoute.reason,
      embeddingModel: null,
      embeddingDim: null,
      indexedContentHash,
      indexedRevision
    })
    indexedSources += 1
    indexedChunks += chunks.length

    if (!vectorRoute.available) {
      console.log('[NotebookRAG] Source indexed by keyword only', {
        notebookId,
        sourceId: source.sourceId,
        title: source.title,
        chunkCount: chunks.length,
        reason: vectorRoute.reason
      })
      continue
    }

    // ── 第二步：向量。失败只影响语义那一路，片段和全文索引都还在 ──
    try {
      const embeddings = await embedTexts(chunks)
      if (embeddings.length !== chunks.length) {
        updateNotebookSourceIndexStatus(db, source.sourceId, {
          status: 'keyword',
          error: 'Embedding count mismatch'
        })
        continue
      }
      if (embeddings[0] && embeddings[0].length !== dim) {
        updateNotebookSourceIndexStatus(db, source.sourceId, {
          status: 'keyword',
          error: `Embedding dimension mismatch (expected ${dim}, got ${embeddings[0].length})`
        })
        continue
      }

      console.log('[NotebookRAG] Embeddings ready for source', {
        notebookId,
        sourceId: source.sourceId,
        title: source.title,
        embeddingCount: embeddings.length,
        embeddingDim: embeddings[0]?.length ?? 0
      })

      if (!insertVectorsTx(chunkRowIds, embeddings, source.sourceId)) {
        continue
      }

      updateNotebookSourceIndexStatus(db, source.sourceId, {
        status: 'indexed',
        indexedAt: new Date().toISOString(),
        error: null,
        embeddingModel: model,
        embeddingDim: dim
      })

      console.log('[NotebookRAG] Source indexed successfully', {
        notebookId,
        sourceId: source.sourceId,
        title: source.title,
        indexedSources,
        indexedChunks,
        chunkCount: chunks.length
      })
    } catch (error) {
      const normalizedError = normalizeNotebookRagError(error, 'index')
      console.error('[NotebookRAG] Source vectorization failed, keyword index kept', {
        notebookId,
        sourceId: source.sourceId,
        title: source.title,
        error: normalizedError.message
      })
      updateNotebookSourceIndexStatus(db, source.sourceId, {
        status: 'keyword',
        error: normalizedError.message
      })
      // 仍然抛出：后台队列靠它安排重试，网络抖一下不该让向量永远缺着
      throw normalizedError
    }
  }

  console.log('[NotebookRAG] Index complete', {
    notebookId,
    requestedSourceIds: options?.sourceIds ?? null,
    indexedSources,
    indexedChunks
  })
  return { indexedSources, indexedChunks }
}

/**
 * 两路召回按名次融合（Reciprocal Rank Fusion）：**只看名次，不看分数**。
 *
 * bm25 和向量距离不是同一个量纲 —— bm25 是负数、量级随词频飘，余弦距离在
 * 0~2 之间。直接加权相加的话权重要随库、随查询重新调，调不好就是一路完全
 * 压住另一路。名次没有这个问题：两边各自的第 1 名贡献一样多，
 * 两路都命中的片段自然浮到最前面。
 *
 * 只有一路有结果时退化为那一路的原序。
 */
export const fuseNotebookSearchResults = (
  semantic: NotebookChunkSearchResult[],
  keyword: NotebookChunkSearchResult[],
  limit: number
): NotebookChunkSearchResult[] => {
  const fused = new Map<string, NotebookChunkSearchResult>()

  semantic.forEach((result, index) => {
    fused.set(result.chunkId, {
      ...result,
      score: 1 / (RRF_K + index + 1),
      matchedBy: 'semantic'
    })
  })

  keyword.forEach((result, index) => {
    const score = 1 / (RRF_K + index + 1)
    const existing = fused.get(result.chunkId)
    if (existing) {
      existing.score = (existing.score ?? 0) + score
      existing.matchedBy = 'both'
      return
    }
    fused.set(result.chunkId, { ...result, score, matchedBy: 'keyword' })
  })

  return [...fused.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, Math.max(0, limit))
}

const keywordRecall = (
  db: Database.Database,
  notebookId: string,
  query: string,
  limit: number,
  sourceIds?: string[]
): NotebookChunkSearchResult[] => {
  const matchExpr = buildFtsMatchQuery(query)
  // 输入里一个字母数字汉字都没有（比如全是标点）—— 没什么可搜的
  if (!matchExpr) return []
  return searchNotebookChunksByKeyword(db, notebookId, matchExpr, limit, sourceIds)
}

interface SemanticRecall {
  results: NotebookChunkSearchResult[]
  /** 这一路为什么没跑。null = 跑了 */
  skipped: string | null
}

/**
 * 语义那一路。**任何一步出问题都回空**，原因记下来给日志 —— 关键词那一路
 * 照常出结果，用户不该因为没配嵌入模型或者厂商抽风就搜不了东西。
 */
const semanticRecall = async (
  db: Database.Database,
  notebookId: string,
  query: string,
  limit: number,
  threshold: number,
  sourceIds?: string[]
): Promise<SemanticRecall> => {
  if (!ensureSqliteVecLoaded(db)) {
    return { results: [], skipped: 'sqlite-vec extension not loaded' }
  }

  try {
    await refreshEmbeddingModelTag()
    const [embedding] = await embedTexts([query], 'query')
    if (!embedding || embedding.length === 0) {
      return { results: [], skipped: '嵌入模型没有返回向量' }
    }

    // 检索这一侧同样要对模型：用户可能换了嵌入模型之后**直接搜**而没有先重建索引。
    // 不在这里对，sqlite-vec 会抛「Expected 1024 dimensions but received 768」，
    // 对用户来说完全不知所云。重建后向量这轮自然搜不到东西（关键词照常），
    // 来源已标回待补向量，下一轮索引任务会把它补上。
    if (reconcileEmbeddingIndex(embedding.length)) {
      console.warn('[NotebookRAG] 嵌入模型已变更，向量索引已重置，本次只走关键词')
      return { results: [], skipped: '嵌入模型已变更，向量索引待重建' }
    }

    const results = searchNotebookChunks(
      db,
      notebookId,
      JSON.stringify(embedding),
      limit,
      sourceIds
    )
    return {
      results: results.filter((chunk) => chunk.distance !== null && chunk.distance <= threshold),
      skipped: null
    }
  } catch (error) {
    const reason = describeError(error)
    console.warn('[NotebookRAG] 向量检索不可用，本次只走关键词:', reason)
    return { results: [], skipped: reason }
  }
}

/**
 * 搜索知识库：关键词 + 向量两路召回，RRF 融合。
 *
 * @param db 数据库实例
 * @param notebookId 知识库 ID
 * @param query 查询文本
 * @param options 选项（limit、distanceThreshold、sourceIds）
 */
export const searchNotebookRag = async (
  db: Database.Database,
  notebookId: string,
  query: string,
  options?: { limit?: number; distanceThreshold?: number; sourceIds?: string[] }
): Promise<NotebookChunkSearchResult[]> => {
  if (!query || query.trim().length === 0) {
    return []
  }

  if (options?.sourceIds && options.sourceIds.length === 0) {
    return []
  }

  const limit = options?.limit ?? 8
  const candidateLimit = Math.max(limit * 3, RECALL_CANDIDATE_FLOOR)
  // 使用传入的阈值或配置中的默认阈值
  const threshold = options?.distanceThreshold ?? getRecallDistanceThreshold()
  const sourceDiagnostics = getNotebookSourceDiagnostics(db, notebookId, options?.sourceIds)

  console.log('[NotebookRAG] Search start', {
    notebookId,
    queryLength: query.length,
    queryPreview: previewText(query),
    limit,
    threshold,
    sourceIds: options?.sourceIds ?? null,
    sourceDiagnostics
  })

  const keywordResults = keywordRecall(db, notebookId, query, candidateLimit, options?.sourceIds)
  const semantic = await semanticRecall(
    db,
    notebookId,
    query,
    candidateLimit,
    threshold,
    options?.sourceIds
  )
  const fusedResults = fuseNotebookSearchResults(semantic.results, keywordResults, limit)

  console.log('[NotebookRAG] Search complete', {
    notebookId,
    queryPreview: previewText(query),
    keywordResultCount: keywordResults.length,
    semanticResultCount: semantic.results.length,
    semanticSkipped: semantic.skipped,
    fusedResultCount: fusedResults.length,
    threshold,
    results: summarizeSearchResults(fusedResults)
  })

  return fusedResults
}
