import Database from 'better-sqlite3'

/**
 * 标签接口定义
 */
export interface Tag {
  id?: number
  name: string
  color?: string
  group_id?: number | null
  is_favorite?: boolean
  created_at?: string
  updated_at?: string
}

/**
 * 初始化标签表
 * @param db 数据库实例
 */
export const initTagModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#1890ff',
      group_id INTEGER,
      is_favorite BOOLEAN DEFAULT FALSE,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (group_id) REFERENCES tag_groups(id) ON DELETE SET NULL
    )
  `

  db.exec(createTableSQL)

  // 创建索引
  const createIndexSQL = `
    CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
    CREATE INDEX IF NOT EXISTS idx_tags_group_id ON tags(group_id);
    CREATE INDEX IF NOT EXISTS idx_tags_created_at ON tags(created_at);
    CREATE INDEX IF NOT EXISTS idx_tags_is_favorite ON tags(is_favorite);
  `

  db.exec(createIndexSQL)
  console.log('标签表初始化完成')
}

/**
 * 创建标签
 * @param db 数据库实例
 * @param tagData 标签数据
 * @returns 创建的标签ID
 */
export const createTag = (db: Database.Database, tagData: Tag): number => {
  const stmt = db.prepare(`
    INSERT INTO tags (name, color, group_id, is_favorite)
    VALUES (?, ?, ?, ?)
  `)

  const result = stmt.run(
    tagData.name,
    tagData.color || '#1890ff',
    tagData.group_id || null,
    tagData.is_favorite ? 1 : 0
  )

  return result.lastInsertRowid as number
}

/**
 * 根据ID获取标签
 * @param db 数据库实例
 * @param id 标签ID
 * @returns 标签对象或null
 */
export const getTagById = (db: Database.Database, id: number): Tag | null => {
  const stmt = db.prepare('SELECT * FROM tags WHERE id = ?')
  return stmt.get(id) as Tag | null
}

/**
 * 根据名称获取标签
 * @param db 数据库实例
 * @param name 标签名称
 * @returns 标签对象或null
 */
export const getTagByName = (db: Database.Database, name: string): Tag | null => {
  const stmt = db.prepare('SELECT * FROM tags WHERE name = ?')
  return stmt.get(name) as Tag | null
}

/**
 * 获取所有标签
 * @param db 数据库实例
 * @returns 标签列表
 */
export const getAllTags = (db: Database.Database): Tag[] => {
  const stmt = db.prepare('SELECT * FROM tags ORDER BY created_at DESC')
  return stmt.all() as Tag[]
}

/**
 * 根据标签组ID获取标签
 * @param db 数据库实例
 * @param groupId 标签组ID
 * @returns 标签列表
 */
export const getTagsByGroupId = (db: Database.Database, groupId: number): Tag[] => {
  const stmt = db.prepare('SELECT * FROM tags WHERE group_id = ? ORDER BY created_at DESC')
  return stmt.all(groupId) as Tag[]
}

/**
 * 获取未分组的标签
 * @param db 数据库实例
 * @returns 标签列表
 */
export const getUngroupedTags = (db: Database.Database): Tag[] => {
  const stmt = db.prepare('SELECT * FROM tags WHERE group_id IS NULL ORDER BY created_at DESC')
  return stmt.all() as Tag[]
}

/**
 * 更新标签
 * @param db 数据库实例
 * @param id 标签ID
 * @param updates 要更新的字段
 * @returns 是否更新成功
 */
export const updateTag = (db: Database.Database, id: number, updates: Partial<Tag>): boolean => {
  const fields: string[] = []
  const values: any[] = []

  if (updates.name !== undefined) {
    fields.push('name = ?')
    values.push(updates.name)
  }

  if (updates.color !== undefined) {
    fields.push('color = ?')
    values.push(updates.color)
  }

  if (updates.group_id !== undefined) {
    fields.push('group_id = ?')
    values.push(updates.group_id)
  }

  if (updates.is_favorite !== undefined) {
    fields.push('is_favorite = ?')
    values.push(updates.is_favorite ? 1 : 0)
  }

  if (fields.length === 0) {
    return false
  }

  // 添加 updated_at 字段，使用 SQLite 的 datetime 函数
  fields.push("updated_at = datetime('now', 'localtime')")

  const stmt = db.prepare(`
    UPDATE tags 
    SET ${fields.join(', ')} 
    WHERE id = ?
  `)

  // 只传入字段值，id 作为 WHERE 条件的参数
  const result = stmt.run(...values, id)
  return result.changes > 0
}

/**
 * 删除标签
 * @param db 数据库实例
 * @param id 标签ID
 * @returns 是否删除成功
 */
export const deleteTag = (db: Database.Database, id: number): boolean => {
  const stmt = db.prepare('DELETE FROM tags WHERE id = ?')
  const result = stmt.run(id)
  return result.changes > 0
}

/**
 * 搜索标签
 * @param db 数据库实例
 * @param keyword 搜索关键词
 * @returns 标签列表
 */
export const searchTags = (db: Database.Database, keyword: string): Tag[] => {
  const stmt = db.prepare(`
    SELECT * FROM tags 
    WHERE name LIKE ?
    ORDER BY created_at DESC
  `)
  const searchPattern = `%${keyword}%`
  return stmt.all(searchPattern) as Tag[]
}

/**
 * 获取常用标签
 * @param db 数据库实例
 * @returns 常用标签列表
 */
export const getFavoriteTags = (db: Database.Database): Tag[] => {
  const stmt = db.prepare('SELECT * FROM tags WHERE is_favorite = 1 ORDER BY created_at DESC')
  return stmt.all() as Tag[]
}

/**
 * 切换标签的常用状态
 * @param db 数据库实例
 * @param id 标签ID
 * @returns 是否切换成功
 */
export const toggleTagFavorite = (db: Database.Database, id: number): boolean => {
  // 先获取当前状态
  const tag = getTagById(db, id)
  if (!tag) {
    return false
  }

  // 切换状态
  const newFavoriteStatus = !tag.is_favorite
  return updateTag(db, id, { is_favorite: newFavoriteStatus })
}
