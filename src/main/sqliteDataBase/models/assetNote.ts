import Database from 'better-sqlite3'

/**
 * 资产 / 文件夹的「详细说明」。
 *
 * 为什么单独一张表、而且在**保管库**里：这种笔记是跟着资产和文件夹走的，
 * 保管库换机器、做备份、整个拷走，它必须一起走。正文里引用的图片和视频
 * 本来就落在 `<保管库>/Notes/` 下，笔记正文却留在公共库，那是两半。
 *
 * 和公共库那张 `note` 表的分工：
 * - `assetNote`（这张，保管库）—— 用户看得见的说明，入口是详情面板的「备注」
 * - `note`（公共库）—— 知识库文本来源的内部存储，没有独立入口
 *
 * 字段只留用得上的。`note` 表带着 sync_status / is_shared / share_url /
 * remote_id 这些云同步和分享的列，那是知识库时代的包裹，这里一个都不需要 ——
 * 说明书跟着保管库走，保管库自己就是同步单位。
 */
export interface AssetNote {
  id?: number
  title: string
  content: string
  created_at?: string
  updated_at?: string
}

const TABLE_NAME = 'assetNote'

export const initAssetNoteModel = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `)

  // 挂载点反查（删笔记时要把指向它的 noteId 清掉）走的是 assetData /
  // assetFolder 的 noteId 列，索引建在那两张表上，见各自的 init
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assetNote_updated ON ${TABLE_NAME}(updated_at);`)
}

export const createAssetNote = (db: Database.Database, data: Partial<AssetNote> = {}): number => {
  const stmt = db.prepare(`INSERT INTO ${TABLE_NAME} (title, content) VALUES (?, ?)`)
  const result = stmt.run(data.title ?? '', data.content ?? '')
  return Number(result.lastInsertRowid)
}

export const getAssetNoteById = (db: Database.Database, id: number): AssetNote | undefined => {
  return db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`).get(id) as AssetNote | undefined
}

/**
 * 按关键词搜说明。
 *
 * 正文存的是 HTML，所以 `content LIKE` 会匹配到标签本身（搜 "p" 命中所有段落）。
 * 这不是新问题 —— 公共库那张表也一样 —— 但这里的调用方是输入框的 @ 补全，
 * 一个字就开搜，所以标题权重必须更高：标题命中的排前面。
 */
export const searchAssetNotes = (
  db: Database.Database,
  keyword: string,
  options: { limit?: number } = {}
): AssetNote[] => {
  const limit = Number.isFinite(options.limit) ? options.limit! : 50
  const pattern = `%${keyword}%`

  if (!keyword.trim()) {
    return db
      .prepare(`SELECT * FROM ${TABLE_NAME} ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as AssetNote[]
  }

  return db
    .prepare(
      `SELECT * FROM ${TABLE_NAME}
       WHERE title LIKE ? OR content LIKE ?
       ORDER BY (CASE WHEN title LIKE ? THEN 0 ELSE 1 END), updated_at DESC
       LIMIT ?`
    )
    .all(pattern, pattern, pattern, limit) as AssetNote[]
}

export const updateAssetNote = (
  db: Database.Database,
  id: number,
  updates: Partial<AssetNote>
): boolean => {
  const fields = (['title', 'content'] as const).filter((key) => updates[key] !== undefined)
  if (fields.length === 0) return false

  const setClause = fields.map((field) => `${field} = ?`).join(', ')
  const values = fields.map((field) => updates[field])
  const result = db
    .prepare(
      `UPDATE ${TABLE_NAME} SET ${setClause}, updated_at = datetime('now', 'localtime') WHERE id = ?`
    )
    .run(...values, id)
  return result.changes > 0
}

export const deleteAssetNote = (db: Database.Database, id: number): boolean => {
  return db.prepare(`DELETE FROM ${TABLE_NAME} WHERE id = ?`).run(id).changes > 0
}
