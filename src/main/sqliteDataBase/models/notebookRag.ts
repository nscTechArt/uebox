import Database from 'better-sqlite3'
import { getEmbeddingDim } from '../services/notebookRagConfig'
import { FTS_TOKENIZER, prepareIndexText } from './ftsText'

/**
 * 知识库的分块、向量与全文索引。
 *
 * 一段来源切成若干 chunk 之后走**两条索引**：
 *
 * - `notebook_chunks_fts`：FTS5 全文索引，本地建、零依赖，切完片就有。
 *   没配嵌入模型的用户靠它检索；配了的用户它也参与融合排序。
 * - `notebook_chunk_vectors`：sqlite-vec 向量表，要调嵌入模型才建得起来。
 *
 * 全文索引是**根基**、向量是**加分项**：向量那条路不管因为什么挂了
 * （没配模型、密钥失效、扩展没加载），知识库都还能按关键词答问题。
 */

const NOTEBOOK_TABLE = 'notebooks'
const SOURCE_TABLE = 'notebook_sources'
const CHUNK_TABLE = 'notebook_chunks'
const VECTOR_TABLE = 'notebook_chunk_vectors'
export const NOTEBOOK_FTS_TABLE = 'notebook_chunks_fts'

/** 一条命中是哪路召回的。模型据此判断该信到什么程度 */
export type NotebookChunkMatchedBy = 'semantic' | 'keyword' | 'both'

interface NotebookChunkRow {
  id: number
  chunk_id: string
  notebook_id: string
  source_id: string
  content: string
  metadata: string | null
  chunk_index: number
  token_count: number | null
  created_at: string
  updated_at: string
  source_title?: string | null
  source_url?: string | null
  file_name?: string | null
  source_type?: string | null
  distance?: number | null
}

export interface NotebookChunkData {
  id?: number
  chunkId: string
  notebookId: string
  sourceId: string
  content: string
  metadata?: string | null
  chunkIndex: number
  tokenCount?: number | null
  createdAt?: string
  updatedAt?: string
}

export interface NotebookChunkSearchResult {
  chunkId: string
  notebookId: string
  sourceId: string
  content: string
  metadata?: string | null
  chunkIndex: number
  createdAt: string
  updatedAt: string
  /** 向量距离，越小越贴题。只按关键词命中的片段没有这个值 */
  distance: number | null
  /** 两路融合后的分数，越大越靠前。只在 searchNotebookRag 的结果上有 */
  score?: number
  matchedBy?: NotebookChunkMatchedBy
  sourceTitle?: string | null
  sourceUrl?: string | null
  fileName?: string | null
  type?: string | null
}

const mapChunkRow = (row: NotebookChunkRow): NotebookChunkSearchResult => ({
  chunkId: row.chunk_id,
  notebookId: row.notebook_id,
  sourceId: row.source_id,
  content: row.content,
  metadata: row.metadata,
  chunkIndex: row.chunk_index,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  distance: row.distance ?? null,
  sourceTitle: row.source_title ?? null,
  sourceUrl: row.source_url ?? null,
  fileName: row.file_name ?? null,
  type: row.source_type ?? null
})

const ensureColumn = (db: Database.Database, table: string, columnSql: string): void => {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnSql};`)
  } catch {
    // Column already exists or alter not supported
  }
}

export const initNotebookRagModel = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CHUNK_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id TEXT NOT NULL UNIQUE,
      notebook_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (notebook_id) REFERENCES ${NOTEBOOK_TABLE}(notebook_id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES ${SOURCE_TABLE}(source_id) ON DELETE CASCADE
    );
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_notebook_chunks_notebook ON ${CHUNK_TABLE}(notebook_id);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notebook_chunks_source ON ${CHUNK_TABLE}(source_id);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notebook_chunks_updated ON ${CHUNK_TABLE}(updated_at);`)

  initNotebookChunkFts(db)

  const dimension = getEmbeddingDim()
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE}
      USING vec0(
        embedding float[${dimension}]
      );
    `)
  } catch (error) {
    console.warn('[notebookRag] Failed to create vec0 table:', error)
  }

  ensureColumn(db, SOURCE_TABLE, "index_status TEXT DEFAULT 'pending'")
  ensureColumn(db, SOURCE_TABLE, 'indexed_at TEXT DEFAULT NULL')
  ensureColumn(db, SOURCE_TABLE, 'index_error TEXT DEFAULT NULL')
  ensureColumn(db, SOURCE_TABLE, 'embedding_model TEXT DEFAULT NULL')
  ensureColumn(db, SOURCE_TABLE, 'embedding_dim INTEGER DEFAULT NULL')
  ensureColumn(db, SOURCE_TABLE, 'content_hash TEXT DEFAULT NULL')
  ensureColumn(db, SOURCE_TABLE, 'content_revision INTEGER DEFAULT 1')
  ensureColumn(db, SOURCE_TABLE, 'indexed_content_hash TEXT DEFAULT NULL')
  ensureColumn(db, SOURCE_TABLE, 'indexed_revision INTEGER DEFAULT NULL')
}

/**
 * 建全文索引表。
 *
 * 不用 FTS5 的 external content 模式：汉字逐字拆分是 JS 干的事，索引里存的
 * 文本和 chunk 原文不一样，所以插入由 createNotebookChunk 显式写两张表。
 * 删除则交给触发器 —— chunk 删掉的路径不止一条（按来源删、按知识库删、
 * 外键级联），每条都手工同步一遍迟早会漏。
 *
 * 表是这次新加的：老库里已经有 chunk 但没有索引行，第一次建表时从
 * notebook_chunks 回填一遍，用户不用重新训练就能按关键词搜。
 */
const initNotebookChunkFts = (db: Database.Database): void => {
  const existed = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(NOTEBOOK_FTS_TABLE)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${NOTEBOOK_FTS_TABLE} USING fts5(
      content,
      ${FTS_TOKENIZER}
    );

    CREATE TRIGGER IF NOT EXISTS notebook_chunks_fts_delete AFTER DELETE ON ${CHUNK_TABLE} BEGIN
      DELETE FROM ${NOTEBOOK_FTS_TABLE} WHERE rowid = old.id;
    END;
  `)

  if (existed) return

  const rows = db.prepare(`SELECT id, content FROM ${CHUNK_TABLE}`).all() as Array<{
    id: number
    content: string
  }>
  if (rows.length === 0) return

  const insert = db.prepare(`INSERT INTO ${NOTEBOOK_FTS_TABLE} (rowid, content) VALUES (?, ?)`)
  db.transaction(() => {
    for (const row of rows) {
      insert.run(row.id, prepareIndexText(row.content))
    }
  })()
  console.log(`[notebookRag] 已为 ${rows.length} 个既有片段回填全文索引`)
}

/** 写入一个片段，同时进全文索引。返回 chunk 的 rowid，向量表用它对齐 */
export const createNotebookChunk = (db: Database.Database, data: NotebookChunkData): number => {
  const stmt = db.prepare(`
    INSERT INTO ${CHUNK_TABLE} (
      chunk_id,
      notebook_id,
      source_id,
      content,
      metadata,
      chunk_index,
      token_count
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const result = stmt.run(
    data.chunkId,
    data.notebookId,
    data.sourceId,
    data.content,
    data.metadata ?? null,
    data.chunkIndex,
    data.tokenCount ?? null
  )

  const rowId = Number(result.lastInsertRowid)
  db.prepare(`INSERT INTO ${NOTEBOOK_FTS_TABLE} (rowid, content) VALUES (?, ?)`).run(
    rowId,
    prepareIndexText(data.content)
  )
  return rowId
}

/**
 * 删向量。vec0 表在扩展没加载的连接上打不开 —— 那种情况下向量本来就没法用，
 * 删不掉不该拦住片段与全文索引的清理，否则关键词那条路也跟着废了。
 */
const deleteVectorsWhereChunk = (db: Database.Database, column: string, value: string): void => {
  try {
    db.prepare(
      `DELETE FROM ${VECTOR_TABLE} WHERE rowid IN (
      SELECT id FROM ${CHUNK_TABLE} WHERE ${column} = ?
    )`
    ).run(value)
  } catch (error) {
    console.warn('[notebookRag] 向量表不可用，跳过向量清理:', error)
  }
}

export const deleteNotebookChunksBySource = (db: Database.Database, sourceId: string): void => {
  deleteVectorsWhereChunk(db, 'source_id', sourceId)
  db.prepare(`DELETE FROM ${CHUNK_TABLE} WHERE source_id = ?`).run(sourceId)
}

export const deleteNotebookChunksByNotebook = (db: Database.Database, notebookId: string): void => {
  deleteVectorsWhereChunk(db, 'notebook_id', notebookId)
  db.prepare(`DELETE FROM ${CHUNK_TABLE} WHERE notebook_id = ?`).run(notebookId)
}

export const insertNotebookChunkVector = (
  db: Database.Database,
  chunkRowId: number | bigint,
  embeddingJson: string
): void => {
  // sqlite-vec requires rowid to be INTEGER. Force BigInt to ensure correct binding.
  db.prepare(`INSERT INTO ${VECTOR_TABLE} (rowid, embedding) VALUES (?, ?)`).run(
    BigInt(chunkRowId),
    embeddingJson
  )
}

/**
 * 搜索知识库向量 chunks
 * @param db 数据库实例
 * @param notebookId 知识库 ID
 * @param embeddingJson 查询向量 JSON
 * @param limit 返回数量限制
 * @param sourceIds 可选，只搜索指定来源的 chunks
 */
export const searchNotebookChunks = (
  db: Database.Database,
  notebookId: string,
  embeddingJson: string,
  limit: number,
  sourceIds?: string[]
): NotebookChunkSearchResult[] => {
  // Use a subquery (CTE) to perform the vector search with a higher 'k' limit.
  // We multiply the requested limit by a factor (e.g., 20) to retrieve enough candidates
  // from the global vector index, increasing the chance that we find results belonging
  // to the specific notebookId after filtering.
  const k = limit * 20

  // 构建 sourceIds 过滤条件
  let sourceFilter = ''
  const params: Array<string | number> = [embeddingJson, k, notebookId]

  if (sourceIds && sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => '?').join(',')
    sourceFilter = `AND c.source_id IN (${placeholders})`
    params.push(...sourceIds)
  }

  params.push(limit)

  const stmt = db.prepare(`
    WITH matches AS (
      SELECT rowid, distance
      FROM ${VECTOR_TABLE}
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    )
    SELECT
      c.*,
      s.title as source_title,
      s.source_url,
      s.file_name,
      s.type as source_type,
      m.distance as distance
    FROM matches m
    JOIN ${CHUNK_TABLE} c ON c.id = m.rowid
    JOIN ${SOURCE_TABLE} s ON s.source_id = c.source_id
    WHERE c.notebook_id = ?
    ${sourceFilter}
    ORDER BY m.distance
    LIMIT ?
  `)

  const rows = stmt.all(...params) as NotebookChunkRow[]
  return rows.map(mapChunkRow)
}

/**
 * 按关键词搜片段（FTS5 + bm25 相关度）。
 *
 * @param matchExpr 已经由 buildFtsMatchQuery 转好的 MATCH 表达式，不接受用户原话
 */
export const searchNotebookChunksByKeyword = (
  db: Database.Database,
  notebookId: string,
  matchExpr: string,
  limit: number,
  sourceIds?: string[]
): NotebookChunkSearchResult[] => {
  let sourceFilter = ''
  const params: Array<string | number> = [matchExpr, notebookId]

  if (sourceIds && sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => '?').join(',')
    sourceFilter = `AND c.source_id IN (${placeholders})`
    params.push(...sourceIds)
  }

  params.push(limit)

  const stmt = db.prepare(`
    WITH hits AS (
      SELECT rowid AS chunk_row_id, bm25(${NOTEBOOK_FTS_TABLE}) AS rank
      FROM ${NOTEBOOK_FTS_TABLE}
      WHERE ${NOTEBOOK_FTS_TABLE} MATCH ?
    )
    SELECT
      c.*,
      s.title as source_title,
      s.source_url,
      s.file_name,
      s.type as source_type,
      NULL as distance
    FROM hits h
    JOIN ${CHUNK_TABLE} c ON c.id = h.chunk_row_id
    JOIN ${SOURCE_TABLE} s ON s.source_id = c.source_id
    WHERE c.notebook_id = ?
    ${sourceFilter}
    ORDER BY h.rank
    LIMIT ?
  `)

  const rows = stmt.all(...params) as NotebookChunkRow[]
  return rows.map(mapChunkRow)
}

export const getNotebookChunksCount = (db: Database.Database, notebookId: string): number => {
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM ${CHUNK_TABLE} WHERE notebook_id = ?`)
  const row = stmt.get(notebookId) as { count: number }
  return row.count
}

export const updateNotebookSourceIndexStatus = (
  db: Database.Database,
  sourceId: string,
  updates: {
    status?: string
    indexedAt?: string | null
    error?: string | null
    embeddingModel?: string | null
    embeddingDim?: number | null
    contentHash?: string | null
    contentRevision?: number | null
    indexedContentHash?: string | null
    indexedRevision?: number | null
  }
): void => {
  const fields: string[] = []
  const values: Array<string | number | null> = []

  if (updates.status !== undefined) {
    fields.push('index_status = ?')
    values.push(updates.status)
  }
  if (updates.indexedAt !== undefined) {
    fields.push('indexed_at = ?')
    values.push(updates.indexedAt)
  }
  if (updates.error !== undefined) {
    fields.push('index_error = ?')
    values.push(updates.error)
  }
  if (updates.embeddingModel !== undefined) {
    fields.push('embedding_model = ?')
    values.push(updates.embeddingModel)
  }
  if (updates.embeddingDim !== undefined) {
    fields.push('embedding_dim = ?')
    values.push(updates.embeddingDim)
  }
  if (updates.contentHash !== undefined) {
    fields.push('content_hash = ?')
    values.push(updates.contentHash)
  }
  if (updates.contentRevision !== undefined) {
    fields.push('content_revision = ?')
    values.push(updates.contentRevision)
  }
  if (updates.indexedContentHash !== undefined) {
    fields.push('indexed_content_hash = ?')
    values.push(updates.indexedContentHash)
  }
  if (updates.indexedRevision !== undefined) {
    fields.push('indexed_revision = ?')
    values.push(updates.indexedRevision)
  }

  if (fields.length === 0) return

  fields.push("updated_at = datetime('now', 'localtime')")
  values.push(sourceId)

  db.prepare(
    `
    UPDATE ${SOURCE_TABLE}
    SET ${fields.join(', ')}
    WHERE source_id = ?
  `
  ).run(...values)
}

export const getNotebookSourcesForIndex = (
  db: Database.Database,
  notebookId: string,
  sourceIds?: string[]
): Array<{
  sourceId: string
  notebookId: string
  title: string
  type: string
  content: string
  sourceUrl: string | null
  fileName: string | null
  loading: number
  indexStatus: string | null
  indexedAt: string | null
  updatedAt: string | null
  contentHash: string | null
  contentRevision: number | null
  indexedContentHash: string | null
  indexedRevision: number | null
}> => {
  if (sourceIds && sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => '?').join(',')
    const stmt = db.prepare(`
      SELECT source_id as sourceId,
             notebook_id as notebookId,
             title,
             type,
             content,
             source_url as sourceUrl,
             file_name as fileName,
             loading,
             index_status as indexStatus,
             indexed_at as indexedAt,
             updated_at as updatedAt,
             content_hash as contentHash,
             content_revision as contentRevision,
             indexed_content_hash as indexedContentHash,
             indexed_revision as indexedRevision
      FROM ${SOURCE_TABLE}
      WHERE notebook_id = ? AND source_id IN (${placeholders})
    `)
    return stmt.all(notebookId, ...sourceIds) as any
  }

  const stmt = db.prepare(`
    SELECT source_id as sourceId,
           notebook_id as notebookId,
           title,
           type,
           content,
           source_url as sourceUrl,
           file_name as fileName,
           loading,
           index_status as indexStatus,
           indexed_at as indexedAt,
           updated_at as updatedAt,
           content_hash as contentHash,
           content_revision as contentRevision,
           indexed_content_hash as indexedContentHash,
           indexed_revision as indexedRevision
    FROM ${SOURCE_TABLE}
    WHERE notebook_id = ?
  `)
  return stmt.all(notebookId) as any
}
