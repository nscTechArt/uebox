import Database from 'better-sqlite3'

/**
 * 同步状态枚举
 * - local-only: 仅本地，从未同步过
 * - pending: 本地有更新，待同步
 * - synced: 已同步到云端
 * - sync-failed: 同步失败
 */
export type NoteSyncStatus = 'local-only' | 'pending' | 'synced' | 'sync-failed'

/**
 * 笔记数据接口
 */
export interface Note {
  id?: number
  title: string
  content: string
  created_at?: string
  updated_at?: string

  // 同步相关字段
  remote_id?: string | null // 云端笔记 ID（MongoDB ObjectId）
  sync_status: NoteSyncStatus // 同步状态
  last_sync_at?: string | null // 上次成功同步时间
  sync_error?: string | null // 同步失败错误信息

  // 分享相关字段
  is_shared: boolean // 是否已公开分享
  share_id?: string | null // 云端分享记录 ID
  share_url?: string | null // 分享链接

  // 标签支持
  tags?: string | null // JSON 格式的标签数组
}

const TABLE_NAME = 'notes'

/**
 * 初始化笔记数据表
 * @param db 数据库实例（公共数据库）
 */
export const initNoteModel = (db: Database.Database): void => {
  // 创建基础表结构
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '未命名笔记',
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),

      -- 同步相关字段
      remote_id TEXT DEFAULT NULL,
      sync_status TEXT NOT NULL DEFAULT 'local-only',
      last_sync_at TEXT DEFAULT NULL,
      sync_error TEXT DEFAULT NULL,

      -- 分享相关字段
      is_shared INTEGER NOT NULL DEFAULT 0,
      share_id TEXT DEFAULT NULL,
      share_url TEXT DEFAULT NULL,

      -- 标签支持
      tags TEXT DEFAULT NULL
    );
  `
  db.exec(createTableSQL)

  // 数据库迁移：为现有表添加新字段（如果不存在）
  const columns = db.pragma(`table_info(${TABLE_NAME})`) as { name: string }[]
  const columnNames = columns.map((c) => c.name)

  const migrateColumns = [
    { name: 'remote_id', sql: `ALTER TABLE ${TABLE_NAME} ADD COLUMN remote_id TEXT DEFAULT NULL` },
    {
      name: 'sync_status',
      sql: `ALTER TABLE ${TABLE_NAME} ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local-only'`
    },
    {
      name: 'last_sync_at',
      sql: `ALTER TABLE ${TABLE_NAME} ADD COLUMN last_sync_at TEXT DEFAULT NULL`
    },
    {
      name: 'sync_error',
      sql: `ALTER TABLE ${TABLE_NAME} ADD COLUMN sync_error TEXT DEFAULT NULL`
    },
    {
      name: 'is_shared',
      sql: `ALTER TABLE ${TABLE_NAME} ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0`
    },
    { name: 'share_id', sql: `ALTER TABLE ${TABLE_NAME} ADD COLUMN share_id TEXT DEFAULT NULL` },
    { name: 'share_url', sql: `ALTER TABLE ${TABLE_NAME} ADD COLUMN share_url TEXT DEFAULT NULL` },
    { name: 'tags', sql: `ALTER TABLE ${TABLE_NAME} ADD COLUMN tags TEXT DEFAULT NULL` }
  ]

  for (const col of migrateColumns) {
    if (!columnNames.includes(col.name)) {
      try {
        db.exec(col.sql)
        console.log(`笔记表迁移：添加字段 ${col.name}`)
      } catch (err) {
        console.error(`笔记表迁移失败：添加字段 ${col.name}`, err)
      }
    }
  }

  // 创建索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_created ON ${TABLE_NAME}(created_at);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_updated ON ${TABLE_NAME}(updated_at);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_remote_id ON ${TABLE_NAME}(remote_id);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_sync_status ON ${TABLE_NAME}(sync_status);`)

  console.log('笔记数据表初始化完成')
}

/**
 * 创建笔记
 * @param db 数据库实例
 * @param data 笔记数据
 * @returns 新笔记的ID
 */
export const createNote = (db: Database.Database, data: Partial<Note> = {}): number => {
  const stmt = db.prepare(`
    INSERT INTO ${TABLE_NAME} (title, content, sync_status, is_shared, tags)
    VALUES (?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    data.title ?? '未命名笔记',
    data.content ?? '',
    data.sync_status ?? 'local-only',
    data.is_shared ? 1 : 0,
    data.tags ?? null
  )
  return Number(result.lastInsertRowid)
}

/**
 * 根据ID获取笔记
 * @param db 数据库实例
 * @param id 笔记ID
 * @returns 笔记数据
 */
export const getNoteById = (db: Database.Database, id: number): Note | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`)
  const row = stmt.get(id) as NoteRow | undefined
  return row ? mapRowToNote(row) : undefined
}

/**
 * 列出所有笔记
 * @param db 数据库实例
 * @param options 查询选项
 * @returns 笔记列表
 */
export const listNotes = (
  db: Database.Database,
  options: { limit?: number; offset?: number } = {}
): Note[] => {
  const limit = Number.isFinite(options.limit) ? options.limit! : 100
  const offset = Number.isFinite(options.offset) ? options.offset! : 0

  const stmt = db.prepare(`
    SELECT * FROM ${TABLE_NAME}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `)
  const rows = stmt.all(limit, offset) as NoteRow[]
  return rows.map(mapRowToNote)
}

/**
 * 搜索笔记
 * @param db 数据库实例
 * @param keyword 搜索关键词
 * @param options 查询选项
 * @returns 匹配的笔记列表
 */
export const searchNotes = (
  db: Database.Database,
  keyword: string,
  options: { limit?: number; offset?: number } = {}
): Note[] => {
  const limit = Number.isFinite(options.limit) ? options.limit! : 100
  const offset = Number.isFinite(options.offset) ? options.offset! : 0

  const stmt = db.prepare(`
    SELECT * FROM ${TABLE_NAME}
    WHERE title LIKE ? OR content LIKE ?
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `)
  const searchPattern = `%${keyword}%`
  const rows = stmt.all(searchPattern, searchPattern, limit, offset) as NoteRow[]
  return rows.map(mapRowToNote)
}

/**
 * 数据库行类型（SQLite存储格式）
 */
interface NoteRow {
  id: number
  title: string
  content: string
  created_at: string
  updated_at: string
  remote_id: string | null
  sync_status: string
  last_sync_at: string | null
  sync_error: string | null
  is_shared: number
  share_id: string | null
  share_url: string | null
  tags: string | null
}

/**
 * 将数据库行映射为 Note 对象
 * @param row 数据库行
 * @returns Note 对象
 */
const mapRowToNote = (row: NoteRow): Note => ({
  id: row.id,
  title: row.title,
  content: row.content,
  created_at: row.created_at,
  updated_at: row.updated_at,
  remote_id: row.remote_id,
  sync_status: row.sync_status as NoteSyncStatus,
  last_sync_at: row.last_sync_at,
  sync_error: row.sync_error,
  is_shared: row.is_shared === 1,
  share_id: row.share_id,
  share_url: row.share_url,
  tags: row.tags
})

/**
 * 更新笔记
 * @param db 数据库实例
 * @param id 笔记ID
 * @param updates 更新字段
 * @returns 是否更新成功
 */
export const updateNote = (db: Database.Database, id: number, updates: Partial<Note>): boolean => {
  const fields: string[] = []
  const values: (string | number | null)[] = []

  if (updates.title !== undefined) {
    fields.push('title = ?')
    values.push(updates.title)
  }

  if (updates.content !== undefined) {
    fields.push('content = ?')
    values.push(updates.content)
  }

  if (updates.remote_id !== undefined) {
    fields.push('remote_id = ?')
    values.push(updates.remote_id ?? null)
  }

  if (updates.sync_status !== undefined) {
    fields.push('sync_status = ?')
    values.push(updates.sync_status)
  }

  if (updates.last_sync_at !== undefined) {
    fields.push('last_sync_at = ?')
    values.push(updates.last_sync_at ?? null)
  }

  if (updates.sync_error !== undefined) {
    fields.push('sync_error = ?')
    values.push(updates.sync_error ?? null)
  }

  if (updates.is_shared !== undefined) {
    fields.push('is_shared = ?')
    values.push(updates.is_shared ? 1 : 0)
  }

  if (updates.share_id !== undefined) {
    fields.push('share_id = ?')
    values.push(updates.share_id ?? null)
  }

  if (updates.share_url !== undefined) {
    fields.push('share_url = ?')
    values.push(updates.share_url ?? null)
  }

  if (updates.tags !== undefined) {
    fields.push('tags = ?')
    values.push(updates.tags ?? null)
  }

  if (fields.length === 0) {
    return false
  }

  // 总是更新 updated_at
  fields.push("updated_at = datetime('now', 'localtime')")
  values.push(id)

  const stmt = db.prepare(`
    UPDATE ${TABLE_NAME}
    SET ${fields.join(', ')}
    WHERE id = ?
  `)
  const result = stmt.run(...values)
  return result.changes > 0
}

/**
 * 删除笔记
 * @param db 数据库实例
 * @param id 笔记ID
 * @returns 是否删除成功
 */
export const deleteNote = (db: Database.Database, id: number): boolean => {
  const stmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE id = ?`)
  const result = stmt.run(id)
  return result.changes > 0
}
