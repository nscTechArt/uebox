import Database from 'better-sqlite3'

import type { ProjectRecord } from './project'

// 工程合集数据表接口（公共数据库）
export interface ProjectCollectionRecord {
  id?: number
  collectionKey: string
  name?: string | null
  description?: string | null
  color?: string | null
  icon?: string | null
  sort_order?: number | null
  isPinned?: number | null // 置顶标记：0/1
  created_at?: string
  updated_at?: string
}

const TABLE_NAME = 'project_collections'

/**
 * 成员关系表。
 *
 * 分组在界面上是一排筛选按钮（「UE 5.5」「教学用」），同一个工程完全可能
 * 既属于版本组又属于用途组。原来成员关系是 `projects.collectionKey` 这一列，
 * 一个工程只能待在一个组里 —— 加进 B 就等于被踢出 A，用户拖第二次的时候
 * 第一次的分组无声无息地没了。关联表让一个工程同时属于多个分组。
 */
const MEMBER_TABLE = 'project_collection_items'

/**
 * 把旧的单值列搬进关联表，然后把列删掉。
 *
 * 不留着那一列：两处都存成员关系的话，读的人迟早读到过期的那一处。删列失败时
 * 整笔回滚 —— 否则列还在、数据也搬过去了，用户在界面上把工程移出分组，
 * 下次启动这个迁移又照着旧列把它塞回去。
 */
const migrateLegacyMembershipColumn = (db: Database.Database): void => {
  const columns = db.pragma(`table_info(projects)`) as Array<{ name: string }>
  // 新库：projects 表还没建，没有旧数据要搬
  if (!columns.length) return
  if (!columns.some((col) => col.name === 'collectionKey')) return

  try {
    db.transaction(() => {
      db.exec(`
        INSERT OR IGNORE INTO ${MEMBER_TABLE} (projectKey, collectionKey)
        SELECT projectKey, collectionKey FROM projects
        WHERE collectionKey IS NOT NULL AND TRIM(collectionKey) <> ''
      `)
      db.exec(`DROP INDEX IF EXISTS idx_projects_collectionKey`)
      db.exec(`ALTER TABLE projects DROP COLUMN collectionKey`)
    })()
  } catch (error) {
    console.warn('迁移工程分组成员关系时出错:', error)
  }
}

/**
 * 初始化工程合集数据表（在主/公共数据库中）
 */
export const initProjectCollectionModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collectionKey TEXT NOT NULL UNIQUE,
      name TEXT,
      description TEXT,
      color TEXT,
      icon TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      isPinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `

  db.exec(createTableSQL)

  const createIndexSQL = `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_collections_key ON ${TABLE_NAME}(collectionKey);
    CREATE INDEX IF NOT EXISTS idx_project_collections_name ON ${TABLE_NAME}(name);
    CREATE INDEX IF NOT EXISTS idx_project_collections_pinned ON ${TABLE_NAME}(isPinned);
    CREATE INDEX IF NOT EXISTS idx_project_collections_sort ON ${TABLE_NAME}(sort_order);
  `
  db.exec(createIndexSQL)

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MEMBER_TABLE} (
      projectKey TEXT NOT NULL,
      collectionKey TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (projectKey, collectionKey)
    )
  `)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_project_collection_items_collection ON ${MEMBER_TABLE}(collectionKey);`
  )

  migrateLegacyMembershipColumn(db)

  // 工程被删掉时，成员关系不再跟着那一行一起消失了，扫一遍留下的孤儿。
  // 新库里 projects 表还没建（这个模型先于它初始化），那就没有孤儿可扫
  if ((db.pragma(`table_info(projects)`) as unknown[]).length > 0) {
    db.exec(`DELETE FROM ${MEMBER_TABLE} WHERE projectKey NOT IN (SELECT projectKey FROM projects)`)
  }
}

// ========================
// CRUD & 查询方法
// ========================

export const createProjectCollection = (
  db: Database.Database,
  record: ProjectCollectionRecord
): number => {
  const stmt = db.prepare(`
    INSERT INTO ${TABLE_NAME} (
      collectionKey, name, description, color, icon, sort_order, isPinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const info = stmt.run(
    record.collectionKey,
    record.name ?? null,
    record.description ?? null,
    record.color ?? null,
    record.icon ?? null,
    record.sort_order ?? 0,
    record.isPinned ?? 0
  )
  return Number(info.lastInsertRowid)
}

export const updateProjectCollection = (
  db: Database.Database,
  collectionKey: string,
  updates: Partial<ProjectCollectionRecord>
): boolean => {
  const fields: string[] = []
  const params: any[] = []

  const assign = (col: keyof ProjectCollectionRecord, val: any) => {
    fields.push(`${String(col)} = ?`)
    params.push(val ?? null)
  }

  if (updates.name !== undefined) assign('name', updates.name)
  if (updates.description !== undefined) assign('description', updates.description)
  if (updates.color !== undefined) assign('color', updates.color)
  if (updates.icon !== undefined) assign('icon', updates.icon)
  if (updates.sort_order !== undefined) assign('sort_order', updates.sort_order)
  if (updates.isPinned !== undefined) assign('isPinned', updates.isPinned)

  if (fields.length === 0) return false

  const sql = `UPDATE ${TABLE_NAME} SET ${fields.join(', ')}, updated_at = datetime('now','localtime') WHERE collectionKey = ?`
  params.push(collectionKey)
  const info = db.prepare(sql).run(...params)
  return info.changes > 0
}

export const getAllProjectCollections = (db: Database.Database): ProjectCollectionRecord[] => {
  const stmt = db.prepare(
    `SELECT * FROM ${TABLE_NAME} ORDER BY isPinned DESC, sort_order ASC, updated_at DESC`
  )
  return stmt.all() as ProjectCollectionRecord[]
}

/**
 * 查询全部合集，并以单次查询聚合其下项目为 items 数组。
 * items 包含 projects 表的所有字段，项目按置顶与更新时间倒序。
 */
export const getAllProjectCollectionsWithItems = (
  db: Database.Database
): Array<ProjectCollectionRecord & { items: ProjectRecord[] }> => {
  const sql = `
    SELECT
      pc.id AS pc_id,
      pc.collectionKey AS pc_collectionKey,
      pc.name AS pc_name,
      pc.description AS pc_description,
      pc.color AS pc_color,
      pc.icon AS pc_icon,
      pc.sort_order AS pc_sort_order,
      pc.isPinned AS pc_isPinned,
      pc.created_at AS pc_created_at,
      pc.updated_at AS pc_updated_at,

      p.id AS p_id,
      p.projectKey AS p_projectKey,
      p.projectName AS p_projectName,
      p.EngineAssociation AS p_EngineAssociation,
      p.projectData AS p_projectData,
      p.projectPath AS p_projectPath,
      p.originPath AS p_originPath,
      p.projectConfig AS p_projectConfig,
      p.image AS p_image,
      p.note AS p_note,
      p.isPinned AS p_isPinned,
      p.created_at AS p_created_at,
      p.updated_at AS p_updated_at
    FROM ${TABLE_NAME} pc
    LEFT JOIN ${MEMBER_TABLE} m ON m.collectionKey = pc.collectionKey
    LEFT JOIN projects p ON p.projectKey = m.projectKey
    ORDER BY pc.isPinned DESC, pc.sort_order ASC, pc.updated_at DESC, p.isPinned DESC, p.updated_at DESC
  `

  const rows = db.prepare(sql).all()

  const map: Record<string, ProjectCollectionRecord & { items: ProjectRecord[] }> = {}
  for (const row of rows as any[]) {
    const cKey = row.pc_collectionKey as string
    let col = map[cKey]
    if (!col) {
      col = {
        id: row.pc_id,
        collectionKey: row.pc_collectionKey,
        name: row.pc_name,
        description: row.pc_description,
        color: row.pc_color,
        icon: row.pc_icon,
        sort_order: row.pc_sort_order,
        isPinned: row.pc_isPinned,
        created_at: row.pc_created_at,
        updated_at: row.pc_updated_at,
        items: []
      }
      map[cKey] = col
    }

    if (row.p_projectKey) {
      const proj: ProjectRecord = {
        id: row.p_id,
        projectKey: row.p_projectKey,
        projectName: row.p_projectName,
        EngineAssociation: row.p_EngineAssociation,
        projectData: row.p_projectData,
        projectPath: row.p_projectPath,
        originPath: row.p_originPath,
        projectConfig: row.p_projectConfig,
        image: row.p_image,
        note: row.p_note,
        isPinned: row.p_isPinned,
        created_at: row.p_created_at,
        updated_at: row.p_updated_at
      }
      col.items.push(proj)
    }
  }

  // 对于没有任何项目的合集，LEFT JOIN 仍会返回一行；若没有行（极端情况），需要补齐。
  if (rows.length === 0) {
    const emptyList = getAllProjectCollections(db)
    return emptyList.map((c) => ({ ...c, items: [] }))
  }

  return Object.values(map)
}

export const getProjectCollectionByKey = (
  db: Database.Database,
  collectionKey: string
): ProjectCollectionRecord | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE collectionKey = ? LIMIT 1`)
  return stmt.get(collectionKey) as ProjectCollectionRecord | undefined
}

export const deleteProjectCollectionByKey = (
  db: Database.Database,
  collectionKey: string
): boolean => {
  const stmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE collectionKey = ?`)
  const info = stmt.run(collectionKey)
  return info.changes > 0
}

export const projectCollectionExists = (db: Database.Database, collectionKey: string): boolean => {
  const stmt = db.prepare(`SELECT 1 FROM ${TABLE_NAME} WHERE collectionKey = ? LIMIT 1`)
  return !!stmt.get(collectionKey)
}

export const searchProjectCollections = (
  db: Database.Database,
  keyword: string
): ProjectCollectionRecord[] => {
  const like = `%${keyword}%`
  const stmt = db.prepare(`
    SELECT * FROM ${TABLE_NAME}
    WHERE (name LIKE ? OR description LIKE ?)
    ORDER BY isPinned DESC, sort_order ASC, updated_at DESC
  `)
  return stmt.all(like, like) as ProjectCollectionRecord[]
}

// ========================
// 与项目的关联操作（project_collection_items 表）
// ========================

/** 加进分组。一个工程可以同时在多个分组里，加进 B 不会把它从 A 里踢出来 */
export const assignProjectToCollection = (
  db: Database.Database,
  projectKey: string,
  collectionKey: string
): boolean => {
  db.prepare(`INSERT OR IGNORE INTO ${MEMBER_TABLE} (projectKey, collectionKey) VALUES (?, ?)`).run(
    projectKey,
    collectionKey
  )
  return isProjectInCollection(db, projectKey, collectionKey)
}

/**
 * 移出分组。不给 collectionKey 就是从所有分组里移出去 —— 界面上「未分组」
 * 那颗筛选按钮接住拖拽时要的正是这个意思。
 */
export const removeProjectFromCollection = (
  db: Database.Database,
  projectKey: string,
  collectionKey?: string | null
): boolean => {
  const key = String(collectionKey ?? '').trim()
  const info = key
    ? db
        .prepare(`DELETE FROM ${MEMBER_TABLE} WHERE projectKey = ? AND collectionKey = ?`)
        .run(projectKey, key)
    : db.prepare(`DELETE FROM ${MEMBER_TABLE} WHERE projectKey = ?`).run(projectKey)
  return info.changes > 0
}

export const isProjectInCollection = (
  db: Database.Database,
  projectKey: string,
  collectionKey: string
): boolean =>
  !!db
    .prepare(`SELECT 1 FROM ${MEMBER_TABLE} WHERE projectKey = ? AND collectionKey = ? LIMIT 1`)
    .get(projectKey, collectionKey)

/** 一个工程现在在哪些分组里 */
export const getCollectionKeysOfProject = (db: Database.Database, projectKey: string): string[] =>
  (
    db
      .prepare(`SELECT collectionKey FROM ${MEMBER_TABLE} WHERE projectKey = ?`)
      .all(projectKey) as Array<{ collectionKey: string }>
  ).map((row) => row.collectionKey)

/**
 * 把一个工程的全部分组归属搬到另一个工程名下。
 * 合并重复工程记录时用：被删的那条上的分组不能跟着一起没。
 */
export const inheritCollectionMemberships = (
  db: Database.Database,
  fromProjectKey: string,
  toProjectKey: string
): void => {
  db.prepare(
    `INSERT OR IGNORE INTO ${MEMBER_TABLE} (projectKey, collectionKey)
     SELECT ?, collectionKey FROM ${MEMBER_TABLE} WHERE projectKey = ?`
  ).run(toProjectKey, fromProjectKey)
  db.prepare(`DELETE FROM ${MEMBER_TABLE} WHERE projectKey = ?`).run(fromProjectKey)
}

export const clearProjectsOfCollection = (db: Database.Database, collectionKey: string): number => {
  const info = db.prepare(`DELETE FROM ${MEMBER_TABLE} WHERE collectionKey = ?`).run(collectionKey)
  return Number(info.changes || 0)
}

export const getProjectsByCollectionKey = (db: Database.Database, collectionKey: string): any[] => {
  const stmt = db.prepare(
    `SELECT p.* FROM projects p
     JOIN ${MEMBER_TABLE} m ON m.projectKey = p.projectKey
     WHERE m.collectionKey = ?
     ORDER BY p.isPinned DESC, p.updated_at DESC`
  )
  return stmt.all(collectionKey) as any[]
}

export type { Database }
