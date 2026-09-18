/**
 * 知识库（Notebook）数据模型
 * 本地持久化存储知识库及其来源数据
 */
import Database from 'better-sqlite3'
import { deleteNotebookChunksByNotebook } from './notebookRag'
import { computeNotebookSourceContentHash } from '../services/notebookSourceHash'
import {
  DEFAULT_NOTEBOOK_CONTEXT_LEVEL,
  normalizeNotebookContextLevel,
  type NotebookContextLevel
} from '../../../shared/notebookContext'

/**
 * 知识库数据库行类型
 */
interface NotebookRow {
  id: number
  notebook_id: string
  title: string
  description: string | null
  cover_style: string | null
  /** 自定义封面图片路径 */
  cover_image: string | null
  source_count: number
  created_at: string
  updated_at: string
}

/**
 * 来源数据库行类型
 */
interface NotebookSourceRow {
  id: number
  source_id: string
  notebook_id: string
  title: string
  type: string
  content: string
  /** 抓回来的原文。清洗是有损的，覆盖掉就再也拿不回来了 */
  raw_content: string | null
  source_url: string | null
  file_name: string | null
  /** 文件的本地路径（用于重试加载） */
  file_path: string | null
  /** 媒体 URL（用于视频的 临时媒体 URL） */
  media_url: string | null
  loading: number
  error: string | null
  /** 进上下文的档位：full / summary / excluded */
  context_level: string | null
  index_status: string | null
  indexed_at: string | null
  index_error: string | null
  embedding_model: string | null
  embedding_dim: number | null
  content_hash: string | null
  content_revision: number | null
  indexed_content_hash: string | null
  indexed_revision: number | null
  /** 摘要正文。「只给摘要」档送的就是它 */
  summary_content: string | null
  /** 摘要状态: pending, processing, completed, failed, skipped */
  summary_status: string | null
  created_at: string
  updated_at: string
}

/**
 * 知识库数据接口
 */
export interface NotebookData {
  id?: number
  notebookId: string
  title: string
  description?: string | null
  coverStyle?: string | null
  /** 自定义封面图片路径 */
  coverImage?: string | null
  sourceCount?: number
  createdAt?: string
  updatedAt?: string
}

/**
 * 来源数据接口
 */
export interface NotebookSourceData {
  id?: number
  sourceId: string
  notebookId: string
  title: string
  type: 'file' | 'link' | 'youtube' | 'bilibili' | 'text' | 'note' | 'ue-project' | 'wechat' | 'mp'
  content: string
  /** 抓回来的原文（仅清洗过的网页有）。清洗是有损的，原文必须留一份 */
  rawContent?: string | null
  sourceUrl?: string | null
  fileName?: string | null
  /** 文件的本地路径（用于重试加载） */
  filePath?: string | null
  /** 媒体 URL（用于视频的 临时媒体 URL） */
  mediaUrl?: string | null
  loading?: boolean
  error?: string | null
  /** 这条来源进上下文的档位。取代了原来的 `selected` 布尔值 */
  contextLevel?: NotebookContextLevel
  indexStatus?: string | null
  indexedAt?: string | null
  indexError?: string | null
  embeddingModel?: string | null
  embeddingDim?: number | null
  contentHash?: string | null
  contentRevision?: number | null
  indexedContentHash?: string | null
  indexedRevision?: number | null
  /** 摘要正文。「只给摘要」档送的就是它 */
  summaryContent?: string | null
  /** 摘要状态: pending, processing, completed, failed, skipped */
  summaryStatus?: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | null
  createdAt?: string
  updatedAt?: string
}

const NOTEBOOK_TABLE = 'notebooks'
const SOURCE_TABLE = 'notebook_sources'

/**
 * 初始化知识库数据表
 * @param db 数据库实例
 */
export const initNotebookModel = (db: Database.Database): void => {
  // 创建知识库主表
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${NOTEBOOK_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notebook_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '新知识库',
      description TEXT DEFAULT NULL,
      cover_style TEXT DEFAULT NULL,
      cover_image TEXT DEFAULT NULL,
      source_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `)

  // 尝试添加 cover_style 字段（如果表已存在但没有此字段）
  try {
    db.exec(`ALTER TABLE ${NOTEBOOK_TABLE} ADD COLUMN cover_style TEXT DEFAULT NULL;`)
    console.log('已尝试添加 cover_style 字段')
  } catch {
    // 字段已存在或其他错误
  }

  // 尝试添加 cover_image 字段（自定义封面图片）
  try {
    db.exec(`ALTER TABLE ${NOTEBOOK_TABLE} ADD COLUMN cover_image TEXT DEFAULT NULL;`)
    console.log('已添加 cover_image 字段')
  } catch {
    // 字段已存在
  }

  // 这里曾经还有三列 `linked_project_*`（知识库自己的「关联工程」）。它和会话身上的
  // 工程归属重复，而且**从来没有传进主进程** —— 绑了也不会让 ue.* 工具指向那个工程，
  // 纯粹是界面上的一行字。现在统一走会话归属（见 `agent-v3/core/sessionScope.ts`）。
  //
  // 老库里那三列还留着（SQLite 删列麻烦，而且没必要）：不读不写，下次建库就没有了。

  // 创建来源表（完整版本，包含所有字段）
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SOURCE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL UNIQUE,
      notebook_id TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('file', 'link', 'youtube', 'bilibili', 'text', 'note', 'ue-project', 'wechat', 'mp')),
      content TEXT NOT NULL DEFAULT '',
      source_url TEXT DEFAULT NULL,
      file_name TEXT DEFAULT NULL,
      loading INTEGER NOT NULL DEFAULT 0,
      error TEXT DEFAULT NULL,
      index_status TEXT DEFAULT 'pending',
      indexed_at TEXT DEFAULT NULL,
      index_error TEXT DEFAULT NULL,
      embedding_model TEXT DEFAULT NULL,
      embedding_dim INTEGER DEFAULT NULL,
      content_hash TEXT DEFAULT NULL,
      content_revision INTEGER DEFAULT 1,
      indexed_content_hash TEXT DEFAULT NULL,
      indexed_revision INTEGER DEFAULT NULL,
      summary_content TEXT DEFAULT NULL,
      summary_status TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (notebook_id) REFERENCES ${NOTEBOOK_TABLE}(notebook_id) ON DELETE CASCADE
    );
  `)

  // 创建索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notebooks_id ON ${NOTEBOOK_TABLE}(notebook_id);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notebooks_updated ON ${NOTEBOOK_TABLE}(updated_at);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_notebook ON ${SOURCE_TABLE}(notebook_id);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_id ON ${SOURCE_TABLE}(source_id);`)

  // 兼容旧数据库：尝试添加可能缺少的字段
  const ensureSourceColumn = (columnSql: string): void => {
    try {
      db.exec(`ALTER TABLE ${SOURCE_TABLE} ADD COLUMN ${columnSql};`)
    } catch {
      // 字段已存在，忽略
    }
  }
  ensureSourceColumn('summary_content TEXT DEFAULT NULL')
  ensureSourceColumn('summary_status TEXT DEFAULT NULL')
  ensureSourceColumn("index_status TEXT DEFAULT 'pending'")
  ensureSourceColumn('indexed_at TEXT DEFAULT NULL')
  ensureSourceColumn('index_error TEXT DEFAULT NULL')
  ensureSourceColumn('embedding_model TEXT DEFAULT NULL')
  ensureSourceColumn('embedding_dim INTEGER DEFAULT NULL')
  ensureSourceColumn('content_hash TEXT DEFAULT NULL')
  ensureSourceColumn('content_revision INTEGER DEFAULT 1')
  ensureSourceColumn('indexed_content_hash TEXT DEFAULT NULL')
  ensureSourceColumn('indexed_revision INTEGER DEFAULT NULL')
  ensureSourceColumn('file_path TEXT DEFAULT NULL')
  ensureSourceColumn('selected INTEGER DEFAULT 1') // 老列，见文件末尾的迁移
  ensureSourceColumn('media_url TEXT DEFAULT NULL') // 视频 媒体 URL

  // 数据库迁移：为旧表添加 bilibili 类型支持
  // SQLite 不支持直接修改 CHECK 约束，需要重建表
  try {
    // 【健壮性修复】首先检测是否存在残留的 _old 表（上次迁移中断的痕迹）
    const oldTableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(`${SOURCE_TABLE}_old`) as { name: string } | undefined

    if (oldTableExists) {
      console.warn('[Notebook] 检测到残留的迁移表 notebook_sources_old，正在清理...')

      // 检查主表是否正常存在
      const mainTableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(SOURCE_TABLE) as { name: string } | undefined

      if (mainTableExists) {
        // 主表存在，直接删除残留的 _old 表
        db.exec(`DROP TABLE IF EXISTS ${SOURCE_TABLE}_old;`)
        console.log('[Notebook] 已清理残留的 notebook_sources_old 表')
      } else {
        // 主表不存在，需要从 _old 表恢复
        console.log('[Notebook] 主表不存在，从 _old 表恢复...')
        db.exec(`ALTER TABLE ${SOURCE_TABLE}_old RENAME TO ${SOURCE_TABLE};`)
        console.log('[Notebook] 已从 _old 表恢复主表')
      }
    }

    // 检测是否需要迁移：查询表定义，检查 CHECK 约束是否包含 bilibili
    const tableInfoStmt = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    const tableInfo = tableInfoStmt.get(SOURCE_TABLE) as { sql: string } | undefined

    if (tableInfo && tableInfo.sql) {
      // 检查表定义中是否已包含所有必要的类型和列
      const hasBilibiliSupport = tableInfo.sql.includes("'bilibili'")
      const hasNoteSupport = tableInfo.sql.includes("'note'")
      const hasFilePathColumn = tableInfo.sql.includes('file_path')
      const hasSelectedColumn = tableInfo.sql.includes('selected')

      if (!hasBilibiliSupport || !hasNoteSupport || !hasFilePathColumn || !hasSelectedColumn) {
        console.log('[Notebook] 检测到旧表结构不完整，开始迁移...', {
          hasBilibiliSupport,
          hasNoteSupport,
          hasFilePathColumn,
          hasSelectedColumn
        })

        // 使用事务确保迁移的原子性
        const migration = db.transaction(() => {
          // 1. 重命名旧表
          db.exec(`ALTER TABLE ${SOURCE_TABLE} RENAME TO ${SOURCE_TABLE}_old;`)

          // 2. 创建新表（带完整类型支持）
          db.exec(`
            CREATE TABLE ${SOURCE_TABLE} (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_id TEXT NOT NULL UNIQUE,
              notebook_id TEXT NOT NULL,
              title TEXT NOT NULL,
              type TEXT NOT NULL CHECK(type IN ('file', 'link', 'youtube', 'bilibili', 'text', 'note', 'ue-project', 'wechat', 'mp')),
              content TEXT NOT NULL DEFAULT '',
              source_url TEXT DEFAULT NULL,
              file_name TEXT DEFAULT NULL,
              file_path TEXT DEFAULT NULL,
              loading INTEGER NOT NULL DEFAULT 0,
              error TEXT DEFAULT NULL,
              selected INTEGER DEFAULT 1,
              index_status TEXT DEFAULT NULL,
              indexed_at TEXT DEFAULT NULL,
              index_error TEXT DEFAULT NULL,
              embedding_model TEXT DEFAULT NULL,
              embedding_dim INTEGER DEFAULT NULL,
              content_hash TEXT DEFAULT NULL,
              content_revision INTEGER DEFAULT 1,
              indexed_content_hash TEXT DEFAULT NULL,
              indexed_revision INTEGER DEFAULT NULL,
              summary_content TEXT DEFAULT NULL,
              summary_status TEXT DEFAULT NULL,
              created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
              FOREIGN KEY (notebook_id) REFERENCES ${NOTEBOOK_TABLE}(notebook_id) ON DELETE CASCADE
            );
          `)

          // 3. 复制数据（兼容旧表可能缺少的字段）
          db.exec(`
            INSERT INTO ${SOURCE_TABLE} (
              id, source_id, notebook_id, title, type, content,
              source_url, file_name, file_path, loading, error, selected,
              index_status, indexed_at, index_error,
              embedding_model, embedding_dim,
              content_hash, content_revision, indexed_content_hash, indexed_revision,
              summary_content, summary_status,
              created_at, updated_at
            )
            SELECT
              id, source_id, notebook_id, title, type, content,
              source_url, file_name, COALESCE(file_path, NULL), loading, error, COALESCE(selected, 1),
              COALESCE(index_status, NULL), COALESCE(indexed_at, NULL), COALESCE(index_error, NULL),
              COALESCE(embedding_model, NULL), COALESCE(embedding_dim, NULL),
              COALESCE(content_hash, NULL), COALESCE(content_revision, 1),
              COALESCE(indexed_content_hash, NULL), COALESCE(indexed_revision, NULL),
              COALESCE(summary_content, NULL), COALESCE(summary_status, NULL),
              created_at, updated_at
            FROM ${SOURCE_TABLE}_old;
          `)

          // 4. 删除旧表
          db.exec(`DROP TABLE ${SOURCE_TABLE}_old;`)

          // 5. 重建索引
          db.exec(
            `CREATE INDEX IF NOT EXISTS idx_sources_notebook ON ${SOURCE_TABLE}(notebook_id);`
          )
          db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_id ON ${SOURCE_TABLE}(source_id);`)
        })

        migration()
        console.log('[Notebook] 数据库迁移完成，已支持所有来源类型（包括 note, wechat, mp）')
      } else {
        console.log('[Notebook] 所有来源类型已受支持')
      }
    }
  } catch (migrationError) {
    console.error('[Notebook] 数据库迁移失败:', migrationError)
    // 【灾难恢复】尝试恢复数据库状态
    try {
      const oldTableStillExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(`${SOURCE_TABLE}_old`) as { name: string } | undefined
      const mainTableMissing = !db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(SOURCE_TABLE)

      if (oldTableStillExists && mainTableMissing) {
        console.warn('[Notebook] 尝试从 _old 表恢复...')
        db.exec(`ALTER TABLE ${SOURCE_TABLE}_old RENAME TO ${SOURCE_TABLE};`)
        console.log('[Notebook] 恢复成功')
      }
    } catch (recoveryError) {
      console.error('[Notebook] 恢复失败，数据库可能处于不一致状态:', recoveryError)
    }
  }

  // 下面两段必须排在重建之后：上面那次重建会照着一份写死的建表语句造新表，
  // 排在它前面加的列会在重建里丢掉。
  ensureSourceColumn('context_level TEXT DEFAULT NULL') // full / summary / excluded
  ensureSourceColumn('raw_content TEXT DEFAULT NULL') // 清洗前的网页原文

  // ---- 一次性迁移：selected 布尔值 → context_level 三档 ----
  //
  // `selected` 那一列还留在表里（SQLite 删列麻烦），但从这次起**不读也不写**，
  // 下次建库就不会再有它。
  try {
    db.prepare(
      `UPDATE ${SOURCE_TABLE}
       SET context_level = CASE WHEN selected = 0 THEN 'excluded' ELSE 'full' END
       WHERE context_level IS NULL`
    ).run()
  } catch (error) {
    console.warn('[Notebook] 迁移 selected → context_level 失败:', error)
  }

  // ---- 一次性清理：summary_content 里那份和正文一模一样的副本 ----
  //
  // 这个字段原本装的是网页来源「去噪清洗」后的正文，而清洗结果同时也写进了 content，
  // 于是两边一模一样 —— 拿它当摘要一个字都省不下来。「只给摘要」档要的是真摘要，
  // 所以把这些无用副本清掉，让它们回到「还没有摘要」的状态，按需重新生成。
  try {
    db.prepare(
      `UPDATE ${SOURCE_TABLE}
       SET summary_content = NULL, summary_status = NULL
       WHERE summary_content IS NOT NULL AND summary_content = content`
    ).run()
  } catch (error) {
    console.warn('[Notebook] 清理重复的 summary_content 失败:', error)
  }

  // ---- 每次启动清一次残留的 processing ----
  //
  // 摘要要跑几十秒，这期间关掉应用的话 `processing` 就永久留在库里，界面上那一条
  // 会一直转圈，而且再点「只给摘要」也没用（档位没变，界面直接 return）。
  // 进程都重启了，那次生成不可能还在跑，一律当没生成过。
  try {
    db.prepare(
      `UPDATE ${SOURCE_TABLE} SET summary_status = NULL WHERE summary_status = 'processing'`
    ).run()
  } catch (error) {
    console.warn('[Notebook] 清理残留的 processing 摘要状态失败:', error)
  }

  console.log('知识库数据表初始化完成')
}

/**
 * 将数据库行映射为 NotebookData
 */
const mapNotebookRow = (row: NotebookRow): NotebookData => ({
  id: row.id,
  notebookId: row.notebook_id,
  title: row.title,
  description: row.description,
  coverStyle: row.cover_style,
  coverImage: row.cover_image,
  sourceCount: row.source_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

/**
 * 将数据库行映射为 NotebookSourceData
 */
const mapSourceRow = (row: NotebookSourceRow): NotebookSourceData => ({
  id: row.id,
  sourceId: row.source_id,
  notebookId: row.notebook_id,
  title: row.title,
  type: row.type as NotebookSourceData['type'],
  content: row.content,
  rawContent: row.raw_content,
  sourceUrl: row.source_url,
  fileName: row.file_name,
  filePath: row.file_path,
  mediaUrl: row.media_url,
  loading: row.loading === 1,
  error: row.error,
  contextLevel: normalizeNotebookContextLevel(row.context_level),
  indexStatus: row.index_status,
  indexedAt: row.indexed_at,
  indexError: row.index_error,
  embeddingModel: row.embedding_model,
  embeddingDim: row.embedding_dim,
  contentHash: row.content_hash,
  contentRevision: row.content_revision,
  indexedContentHash: row.indexed_content_hash,
  indexedRevision: row.indexed_revision,
  summaryContent: row.summary_content,
  summaryStatus: row.summary_status as NotebookSourceData['summaryStatus'],
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const getNotebookSourceRowBySourceId = (
  db: Database.Database,
  sourceId: string
): NotebookSourceRow | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${SOURCE_TABLE} WHERE source_id = ?`)
  return stmt.get(sourceId) as NotebookSourceRow | undefined
}

// ========== 知识库 CRUD ==========

/**
 * 创建知识库
 */
export const createNotebook = (db: Database.Database, data: Partial<NotebookData>): string => {
  const notebookId =
    data.notebookId || `nb-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  const stmt = db.prepare(`
    INSERT INTO ${NOTEBOOK_TABLE} (
      notebook_id,
      title,
      description,
      cover_style,
      cover_image
    )
    VALUES (?, ?, ?, ?, ?)
  `)

  stmt.run(
    notebookId,
    data.title ?? '新知识库',
    data.description ?? null,
    data.coverStyle ?? null,
    data.coverImage ?? null
  )

  return notebookId
}

/**
 * 获取单个知识库
 */
export const getNotebookById = (
  db: Database.Database,
  notebookId: string
): NotebookData | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${NOTEBOOK_TABLE} WHERE notebook_id = ?`)
  const row = stmt.get(notebookId) as NotebookRow | undefined
  return row ? mapNotebookRow(row) : undefined
}

/**
 * 获取知识库列表
 */
export const listNotebooks = (
  db: Database.Database,
  options: { limit?: number; offset?: number } = {}
): NotebookData[] => {
  const limit = options.limit ?? 100
  const offset = options.offset ?? 0

  const stmt = db.prepare(`
    SELECT * FROM ${NOTEBOOK_TABLE}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `)

  const rows = stmt.all(limit, offset) as NotebookRow[]
  console.log('[notebook model] listNotebooks rows:', rows)
  return rows.map(mapNotebookRow)
}

/**
 * 更新知识库
 */
export const updateNotebook = (
  db: Database.Database,
  notebookId: string,
  updates: Partial<NotebookData>
): boolean => {
  const fields: string[] = []
  const values: (string | number | null)[] = []

  if (updates.title !== undefined) {
    fields.push('title = ?')
    values.push(updates.title)
  }

  if (updates.description !== undefined) {
    fields.push('description = ?')
    values.push(updates.description ?? null)
  }

  if (updates.coverStyle !== undefined) {
    fields.push('cover_style = ?')
    values.push(updates.coverStyle ?? null)
  }

  if (updates.coverImage !== undefined) {
    fields.push('cover_image = ?')
    values.push(updates.coverImage ?? null)
  }

  if (fields.length === 0) return false

  fields.push("updated_at = datetime('now', 'localtime')")
  values.push(notebookId)

  const sql = `
    UPDATE ${NOTEBOOK_TABLE}
    SET ${fields.join(', ')}
    WHERE notebook_id = ?
  `
  // console.log('[notebook model] updateNotebook sql:', sql, 'values:', values)
  const stmt = db.prepare(sql)

  const result = stmt.run(...values)
  return result.changes > 0
}

/**
 * 删除知识库（级联删除来源）
 */
export const deleteNotebook = (db: Database.Database, notebookId: string): boolean => {
  try {
    deleteNotebookChunksByNotebook(db, notebookId)
  } catch (error) {
    console.warn('[Notebook] Failed to clean notebook vectors before delete:', error)
  }

  const stmt = db.prepare(`DELETE FROM ${NOTEBOOK_TABLE} WHERE notebook_id = ?`)
  const result = stmt.run(notebookId)
  return result.changes > 0
}

/**
 * 获取知识库数量
 */
export const countNotebooks = (db: Database.Database): number => {
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM ${NOTEBOOK_TABLE}`)
  const result = stmt.get() as { count: number }
  return result.count
}

// ========== 来源 CRUD ==========

/**
 * 添加来源
 */
export const createNotebookSource = (
  db: Database.Database,
  data: Omit<NotebookSourceData, 'id' | 'createdAt' | 'updatedAt'>
): string => {
  const sourceId = data.sourceId || `src-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  const content = data.content ?? ''
  const contentHash = computeNotebookSourceContentHash(content)
  const initialRevision = 1

  const stmt = db.prepare(`
    INSERT INTO ${SOURCE_TABLE} (
      source_id, notebook_id, title, type, content, raw_content, source_url, file_name, file_path,
      loading, error, context_level, content_hash, content_revision, index_status, index_error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    sourceId,
    data.notebookId,
    data.title,
    data.type,
    content,
    data.rawContent ?? null,
    data.sourceUrl ?? null,
    data.fileName ?? null,
    data.filePath ?? null,
    data.loading ? 1 : 0,
    data.error ?? null,
    normalizeNotebookContextLevel(data.contextLevel ?? DEFAULT_NOTEBOOK_CONTEXT_LEVEL),
    contentHash,
    initialRevision,
    data.loading ? 'pending' : 'pending',
    null
  )

  // 更新来源数量
  updateSourceCount(db, data.notebookId)

  return sourceId
}

/**
 * 获取知识库的所有来源
 */
export const getNotebookSources = (
  db: Database.Database,
  notebookId: string
): NotebookSourceData[] => {
  const stmt = db.prepare(`
    SELECT * FROM ${SOURCE_TABLE}
    WHERE notebook_id = ?
    ORDER BY created_at ASC
  `)

  const rows = stmt.all(notebookId) as NotebookSourceRow[]
  return rows.map(mapSourceRow)
}

export const getNotebookSourceBySourceId = (
  db: Database.Database,
  sourceId: string
): NotebookSourceData | undefined => {
  const row = getNotebookSourceRowBySourceId(db, sourceId)
  return row ? mapSourceRow(row) : undefined
}

/**
 * 更新来源
 */
export const updateNotebookSource = (
  db: Database.Database,
  sourceId: string,
  updates: Partial<NotebookSourceData>
): boolean => {
  const existingRow = getNotebookSourceRowBySourceId(db, sourceId)
  if (!existingRow) return false

  const fields: string[] = []
  const values: (string | number | null)[] = []
  let nextContent = existingRow.content
  let contentChanged = false

  if (updates.title !== undefined) {
    fields.push('title = ?')
    values.push(updates.title)
  }

  if (updates.type !== undefined) {
    fields.push('type = ?')
    values.push(updates.type)
  }

  if (updates.content !== undefined) {
    fields.push('content = ?')
    values.push(updates.content)
    nextContent = updates.content
    contentChanged = updates.content !== existingRow.content
  }

  if (updates.rawContent !== undefined) {
    fields.push('raw_content = ?')
    values.push(updates.rawContent ?? null)
  }

  if (updates.sourceUrl !== undefined) {
    fields.push('source_url = ?')
    values.push(updates.sourceUrl ?? null)
  }

  if (updates.fileName !== undefined) {
    fields.push('file_name = ?')
    values.push(updates.fileName ?? null)
  }

  if (updates.filePath !== undefined) {
    fields.push('file_path = ?')
    values.push(updates.filePath ?? null)
  }

  if (updates.loading !== undefined) {
    fields.push('loading = ?')
    values.push(updates.loading ? 1 : 0)
  }

  if (updates.error !== undefined) {
    fields.push('error = ?')
    values.push(updates.error ?? null)
  }

  // 预压缩摘要内容
  if (updates.summaryContent !== undefined) {
    fields.push('summary_content = ?')
    values.push(updates.summaryContent ?? null)
  }

  // 预压缩状态
  if (updates.summaryStatus !== undefined) {
    fields.push('summary_status = ?')
    values.push(updates.summaryStatus ?? null)
  }

  // 进上下文的档位
  if (updates.contextLevel !== undefined) {
    fields.push('context_level = ?')
    values.push(normalizeNotebookContextLevel(updates.contextLevel))
  }

  // 媒体 URL（视频 媒体 URL）
  if (updates.mediaUrl !== undefined) {
    fields.push('media_url = ?')
    values.push(updates.mediaUrl ?? null)
  }

  if (contentChanged) {
    const nextContentHash = computeNotebookSourceContentHash(nextContent)
    const nextContentRevision = Math.max(1, (existingRow.content_revision ?? 1) + 1)
    fields.push('content_hash = ?')
    values.push(nextContentHash)
    fields.push('content_revision = ?')
    values.push(nextContentRevision)
    fields.push('index_status = ?')
    values.push('pending')
    fields.push('index_error = ?')
    values.push(null)

    // 正文变了，旧摘要就是错的。清掉比留着强 —— 留着的话「只给摘要」档会一直
    // 拿上一版内容去回答，而界面上没有任何地方看得出它过期了。
    // 同一次调用里显式给了新摘要的除外（导入流程会一次把正文和摘要都写进来）。
    if (updates.summaryContent === undefined) {
      fields.push('summary_content = ?')
      values.push(null)
      fields.push('summary_status = ?')
      values.push(null)
    }
  }

  if (fields.length === 0) return false

  fields.push("updated_at = datetime('now', 'localtime')")
  values.push(sourceId)

  const stmt = db.prepare(`
    UPDATE ${SOURCE_TABLE}
    SET ${fields.join(', ')}
    WHERE source_id = ?
  `)

  const result = stmt.run(...values)
  return result.changes > 0
}

/**
 * 删除来源（同时清理对应的向量数据）
 */
export const deleteNotebookSource = (db: Database.Database, sourceId: string): boolean => {
  // 先获取 notebookId
  const getStmt = db.prepare(`SELECT notebook_id FROM ${SOURCE_TABLE} WHERE source_id = ?`)
  const row = getStmt.get(sourceId) as { notebook_id: string } | undefined

  if (!row) return false

  // 清理向量数据（必须在删除来源之前执行，因为向量表的 chunk 会关联到 source_id）
  try {
    // 删除 chunk vectors（先删除向量表，因为它依赖 chunks 表的 rowid）
    const deleteVectorsStmt = db.prepare(`
      DELETE FROM notebook_chunk_vectors
      WHERE rowid IN (SELECT id FROM notebook_chunks WHERE source_id = ?)
    `)
    deleteVectorsStmt.run(sourceId)

    // 删除 chunks
    const deleteChunksStmt = db.prepare(`DELETE FROM notebook_chunks WHERE source_id = ?`)
    deleteChunksStmt.run(sourceId)

    console.log(`[Notebook] 已清理来源 ${sourceId} 的向量数据`)
  } catch (error) {
    // 向量表可能不存在（未启用 RAG），忽略错误
    console.warn(`[Notebook] 清理向量数据时出错（可能未启用 RAG）:`, error)
  }

  // 删除来源记录
  const stmt = db.prepare(`DELETE FROM ${SOURCE_TABLE} WHERE source_id = ?`)
  const result = stmt.run(sourceId)

  if (result.changes > 0) {
    updateSourceCount(db, row.notebook_id)
  }

  return result.changes > 0
}

/**
 * 更新知识库的来源数量
 */
const updateSourceCount = (db: Database.Database, notebookId: string): void => {
  const countStmt = db.prepare(
    `SELECT COUNT(*) as count FROM ${SOURCE_TABLE} WHERE notebook_id = ?`
  )
  const result = countStmt.get(notebookId) as { count: number }

  const updateStmt = db.prepare(`
    UPDATE ${NOTEBOOK_TABLE}
    SET source_count = ?, updated_at = datetime('now', 'localtime')
    WHERE notebook_id = ?
  `)

  updateStmt.run(result.count, notebookId)
}
