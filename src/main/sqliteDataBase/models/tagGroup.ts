import Database from 'better-sqlite3'

/**
 * 标签组接口定义
 */
export interface TagGroup {
  id?: number
  name: string
  color?: string
  sort_order?: number
  created_at?: string
  updated_at?: string
}

/**
 * 初始化标签组表
 * @param db 数据库实例
 */
export const initTagGroupModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS tag_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#52c41a',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `

  db.exec(createTableSQL)

  // 创建索引
  const createIndexSQL = `
    CREATE INDEX IF NOT EXISTS idx_tag_groups_name ON tag_groups(name);
    CREATE INDEX IF NOT EXISTS idx_tag_groups_sort_order ON tag_groups(sort_order);
    CREATE INDEX IF NOT EXISTS idx_tag_groups_created_at ON tag_groups(created_at);
  `

  db.exec(createIndexSQL)
  console.log('标签组表初始化完成')
}

/**
 * 创建标签组
 * @param db 数据库实例
 * @param groupData 标签组数据
 * @returns 创建的标签组ID
 */
export const createTagGroup = (db: Database.Database, groupData: TagGroup): number => {
  const stmt = db.prepare(`
    INSERT INTO tag_groups (name, color, sort_order)
    VALUES (?, ?, ?)
  `)

  const result = stmt.run(groupData.name, groupData.color || '#52c41a', groupData.sort_order || 0)

  return result.lastInsertRowid as number
}

/**
 * 根据ID获取标签组
 * @param db 数据库实例
 * @param id 标签组ID
 * @returns 标签组对象或null
 */
export const getTagGroupById = (db: Database.Database, id: number): TagGroup | null => {
  const stmt = db.prepare('SELECT * FROM tag_groups WHERE id = ?')
  return stmt.get(id) as TagGroup | null
}

/**
 * 根据名称获取标签组
 * @param db 数据库实例
 * @param name 标签组名称
 * @returns 标签组对象或null
 */
export const getTagGroupByName = (db: Database.Database, name: string): TagGroup | null => {
  const stmt = db.prepare('SELECT * FROM tag_groups WHERE name = ?')
  return stmt.get(name) as TagGroup | null
}

/**
 * 获取所有标签组
 * @param db 数据库实例
 * @returns 标签组列表
 */
export const getAllTagGroups = (db: Database.Database): TagGroup[] => {
  const stmt = db.prepare('SELECT * FROM tag_groups ORDER BY sort_order ASC, created_at DESC')
  return stmt.all() as TagGroup[]
}

/**
 * 更新标签组
 * @param db 数据库实例
 * @param id 标签组ID
 * @param updates 要更新的字段
 * @returns 是否更新成功
 */
export const updateTagGroup = (
  db: Database.Database,
  id: number,
  updates: Partial<TagGroup>
): boolean => {
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

  if (updates.sort_order !== undefined) {
    fields.push('sort_order = ?')
    values.push(updates.sort_order)
  }

  if (fields.length === 0) {
    return false
  }

  // 添加 updated_at 字段，使用 SQLite 的 datetime 函数
  fields.push("updated_at = datetime('now', 'localtime')")

  const stmt = db.prepare(`
    UPDATE tag_groups 
    SET ${fields.join(', ')} 
    WHERE id = ?
  `)

  // 只传入字段值，id 作为 WHERE 条件的参数
  const result = stmt.run(...values, id)
  return result.changes > 0
}

/**
 * 删除标签组
 * @param db 数据库实例
 * @param id 标签组ID
 * @returns 是否删除成功
 */
export const deleteTagGroup = (db: Database.Database, id: number): boolean => {
  // 先将该组下的所有标签的group_id设为null
  const updateTagsStmt = db.prepare('UPDATE tags SET group_id = NULL WHERE group_id = ?')
  updateTagsStmt.run(id)

  // 然后删除标签组
  const deleteStmt = db.prepare('DELETE FROM tag_groups WHERE id = ?')
  const result = deleteStmt.run(id)
  return result.changes > 0
}

/**
 * 搜索标签组
 * @param db 数据库实例
 * @param keyword 搜索关键词
 * @returns 标签组列表
 */
export const searchTagGroups = (db: Database.Database, keyword: string): TagGroup[] => {
  const stmt = db.prepare(`
    SELECT * FROM tag_groups 
    WHERE name LIKE ?
    ORDER BY sort_order ASC, created_at DESC
  `)
  const searchPattern = `%${keyword}%`
  return stmt.all(searchPattern) as TagGroup[]
}

/**
 * 获取标签组的标签数量
 * @param db 数据库实例
 * @param groupId 标签组ID
 * @returns 标签数量
 */
export const getTagCountByGroupId = (db: Database.Database, groupId: number): number => {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM tags WHERE group_id = ?')
  const result = stmt.get(groupId) as { count: number }
  return result.count
}

/**
 * 批量更新标签组排序
 * @param db 数据库实例
 * @param sortData 排序数据数组 [{id: number, sort_order: number}]
 * @returns 是否更新成功
 */
export const batchUpdateTagGroupSort = (
  db: Database.Database,
  sortData: Array<{ id: number; sort_order: number }>
): boolean => {
  const transaction = db.transaction(() => {
    const stmt = db.prepare(
      'UPDATE tag_groups SET sort_order = ?, updated_at = datetime("now", "localtime") WHERE id = ?'
    )

    for (const item of sortData) {
      stmt.run(item.sort_order, item.id)
    }
  })

  try {
    transaction()
    return true
  } catch (error) {
    console.error('批量更新标签组排序失败:', error)
    return false
  }
}
