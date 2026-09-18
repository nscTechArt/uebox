import Database from 'better-sqlite3'

import {
  projectComparisonKey,
  projectComparisonKeyWithoutFs,
  toNativeProjectPath
} from '../../utils/projectPath'
import { inheritCollectionMemberships, removeProjectFromCollection } from './projectCollection'

// 项目数据表接口
export interface ProjectRecord {
  id?: number
  projectKey: string
  projectName?: string | null
  EngineAssociation?: string | null
  projectData?: string | null // 原始 .uproject JSON 字符串
  projectPath?: string | null // 规范化后的项目目录路径
  originPath?: string | null // .uproject 文件绝对路径
  projectConfig?: string | null // INI 汇总/JSON 快照
  image?: string | null // 封面文件名或路径
  note?: string | null
  isPinned?: number | null // 置顶标记：0/1
  sort_order?: number | null // 排序顺序
  created_at?: string
  updated_at?: string
}

const TABLE_NAME = 'projects'

/**
 * 初始化项目数据表（在主数据库中）
 * 字段来源于需求：id, projectKey, projectName, EngineAssociation,
 * projectData, projectPath, originPath, projectConfig, image, note
 */
export const initProjectModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectKey TEXT NOT NULL UNIQUE,
      projectName TEXT,
      EngineAssociation TEXT,
      projectData TEXT,
      projectPath TEXT,
      originPath TEXT,
      projectConfig TEXT,
      image TEXT,
      note TEXT,
      isPinned INTEGER NOT NULL DEFAULT 0,
      sort_order REAL NOT NULL DEFAULT 0.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `

  db.exec(createTableSQL)

  // 迁移：为已存在的表添加 sort_order 列（如果没有）
  try {
    // 检查列是否存在
    const tableInfo = db.pragma(`table_info(${TABLE_NAME})`)
    const hasSortOrder = tableInfo.some((col: any) => col.name === 'sort_order')

    if (!hasSortOrder) {
      console.log('检测到旧版数据库，正在添加 sort_order 列...')
      db.exec(`ALTER TABLE ${TABLE_NAME} ADD COLUMN sort_order REAL NOT NULL DEFAULT 0.0`)
      console.log('sort_order 列添加成功')
    }
  } catch (error) {
    console.warn('迁移 sort_order 列时出错:', error)
  }

  // 索引：唯一键、置顶标记、排序字段
  const createIndexSQL = `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_projectKey ON ${TABLE_NAME}(projectKey);
    CREATE INDEX IF NOT EXISTS idx_projects_isPinned ON ${TABLE_NAME}(isPinned);
    CREATE INDEX IF NOT EXISTS idx_projects_sort_order ON ${TABLE_NAME}(sort_order);
  `

  db.exec(createIndexSQL)

  // 收拾老的判重逻辑留下的重复记录：先把路径写法统一，再把同一个工程的
  // 多条合并成一条。放在这里是因为它必须跑在任何人读这张表之前
  try {
    canonicalizeProjectPaths(db)
    mergeDuplicateProjectPaths(db)
  } catch (error) {
    console.warn('合并重复项目记录时出错:', error)
  }

  console.log('项目数据表初始化完成')
}

// ========================
// CRUD & 查询方法
// ========================

export const createProject = (db: Database.Database, record: ProjectRecord): number => {
  const stmt = db.prepare(`
    INSERT INTO ${TABLE_NAME} (
      projectKey, projectName, EngineAssociation, projectData,
      projectPath, originPath, projectConfig, image, note, isPinned, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const info = stmt.run(
    record.projectKey,
    record.projectName ?? null,
    record.EngineAssociation ?? null,
    record.projectData ?? null,
    record.projectPath ?? null,
    record.originPath ?? null,
    record.projectConfig ?? null,
    record.image ?? null,
    record.note ?? null,
    record.isPinned ?? 0,
    record.sort_order ?? 0.0
  )
  return Number(info.lastInsertRowid)
}

export const updateProject = (
  db: Database.Database,
  projectKey: string,
  updates: Partial<ProjectRecord>
): boolean => {
  const fields: string[] = []
  const params: any[] = []

  const assign = (col: keyof ProjectRecord, val: any) => {
    fields.push(`${String(col)} = ?`)
    params.push(val ?? null)
  }

  if (updates.projectName !== undefined) assign('projectName', updates.projectName)
  if (updates.EngineAssociation !== undefined)
    assign('EngineAssociation', updates.EngineAssociation)
  if (updates.projectData !== undefined) assign('projectData', updates.projectData)
  if (updates.projectPath !== undefined) assign('projectPath', updates.projectPath)
  if (updates.originPath !== undefined) assign('originPath', updates.originPath)
  if (updates.projectConfig !== undefined) assign('projectConfig', updates.projectConfig)
  if (updates.image !== undefined) assign('image', updates.image)
  if (updates.note !== undefined) assign('note', updates.note)
  if (updates.isPinned !== undefined) assign('isPinned', updates.isPinned)
  if (updates.sort_order !== undefined) assign('sort_order', updates.sort_order)

  // 没有可更新字段时直接返回
  if (fields.length === 0) return false

  const sql = `UPDATE ${TABLE_NAME} SET ${fields.join(', ')}, updated_at = datetime('now','localtime') WHERE projectKey = ?`
  params.push(projectKey)
  const info = db.prepare(sql).run(...params)
  return info.changes > 0
}

export const upsertProject = (db: Database.Database, record: ProjectRecord): number => {
  const exists = projectExists(db, record.projectKey)
  if (exists) {
    updateProject(db, record.projectKey, record)
    const row = getProjectByKey(db, record.projectKey)
    return row?.id ?? 0
  }
  return createProject(db, record)
}

export const getProjectByKey = (
  db: Database.Database,
  projectKey: string
): ProjectRecord | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE projectKey = ?`)
  return stmt.get(projectKey) as ProjectRecord | undefined
}

export const getProjectById = (db: Database.Database, id: number): ProjectRecord | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`)
  return stmt.get(id) as ProjectRecord | undefined
}

export const getAllProjects = (db: Database.Database): ProjectRecord[] => {
  const stmt = db.prepare(
    `SELECT * FROM ${TABLE_NAME} ORDER BY isPinned DESC, sort_order ASC, id ASC`
  )
  return stmt.all() as ProjectRecord[]
}

export const deleteProjectByKey = (db: Database.Database, projectKey: string): boolean => {
  const stmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE projectKey = ?`)
  const info = stmt.run(projectKey)
  // 分组归属现在是单独一张表，工程行删掉不会把它带走
  removeProjectFromCollection(db, projectKey)
  return info.changes > 0
}

export const projectExists = (db: Database.Database, projectKey: string): boolean => {
  const stmt = db.prepare(`SELECT 1 FROM ${TABLE_NAME} WHERE projectKey = ? LIMIT 1`)
  return !!stmt.get(projectKey)
}

export const searchProjects = (db: Database.Database, keyword: string): ProjectRecord[] => {
  const like = `%${keyword}%`
  const stmt = db.prepare(`
    SELECT * FROM ${TABLE_NAME}
    WHERE (projectName LIKE ? OR projectPath LIKE ? OR originPath LIKE ?)
    ORDER BY isPinned DESC, sort_order ASC, id ASC
  `)
  return stmt.all(like, like, like) as ProjectRecord[]
}

/**
 * 基于项目路径的唯一性查询与判断。
 *
 * 比较前两边都过一遍 `projectComparisonKey`，不能直接拿字符串相等去查：
 * 同一个工程从不同入口进来，路径写法不一样 —— 首页点导入拿到的是
 * `I:\UE Project\X`，UE 插件上报的是 `I:/UE Project/X`。字符串比就都判成
 * 「没见过」，于是一个工程在首页上出现两张卡片（实际发生过）。
 *
 * 全表拉出来在 JS 里比，是为了让「算不算同一个工程」只有一处定义：
 * 用 SQL 拼一套等价的大小写 / 分隔符处理，早晚会和这个函数漂开。
 * 项目库是用户手动攒起来的，几十条的量级，扫一遍不值得优化掉这份一致性。
 *
 * 但分两趟比：`projectComparisonKey` 在 POSIX 上要 `realpath`，那是同步系统调用，
 * 掉线的网络盘会卡到超时才返回，而主进程正卡在这儿。所以先用纯字符串比一遍，
 * 命中就走人 —— 打开工程这类高频查询压根不碰文件系统。
 */
export const getProjectByPath = (
  db: Database.Database,
  projectPath: string
): ProjectRecord | undefined => {
  const raw = String(projectPath ?? '')
  const cheap = projectComparisonKeyWithoutFs(raw)
  if (!cheap) return undefined

  const rows = db.prepare(`SELECT * FROM ${TABLE_NAME}`).all() as ProjectRecord[]
  const direct = rows.find(
    (row) => projectComparisonKeyWithoutFs(String(row.projectPath ?? '')) === cheap
  )
  if (direct) return direct

  // 字符串比不出来才动文件系统：软链接和大小写别名只有 realpath 认得。
  const wanted = projectComparisonKey(raw)
  if (!wanted) return undefined
  return rows.find((row) => projectComparisonKey(String(row.projectPath ?? '')) === wanted)
}

export const projectExistsByPath = (db: Database.Database, projectPath: string): boolean => {
  return !!getProjectByPath(db, projectPath)
}

/**
 * 迁移：把库里存着的路径统一成本机写法。
 *
 * 判重已经改成规范化后再比，功能上不依赖这一步。但库里长期躺着两种斜杠
 * 会一直坑到下一个人 —— 任何一处拿原始字符串做比较、做 `LIKE`、做去重，
 * 都会在「同一个工程的两种写法」上翻车。趁启动统一掉，只改这一列的写法，
 * 不动磁盘上的任何东西。
 */
export const canonicalizeProjectPaths = (db: Database.Database): void => {
  const rows = db
    .prepare(`SELECT id, projectPath, originPath FROM ${TABLE_NAME}`)
    .all() as ProjectRecord[]

  const stmt = db.prepare(`UPDATE ${TABLE_NAME} SET projectPath = ?, originPath = ? WHERE id = ?`)
  for (const row of rows) {
    const projectPath = toNativeProjectPath(String(row.projectPath ?? ''))
    const originPath = toNativeProjectPath(String(row.originPath ?? ''))
    if (projectPath === row.projectPath && originPath === row.originPath) continue
    stmt.run(projectPath || null, originPath || null, row.id)
  }
}

/**
 * 迁移：同一个工程在库里有多条记录时，合并成一条。
 *
 * 这些重复是老的判重逻辑留下的（见 `getProjectByPath`）：路径写法一变就判不出
 * 重复，于是用 UE 打开过的工程又被自动登记了一遍，首页上并排两张一样的卡片。
 *
 * 留最早的那一条 —— 用户先看到的就是它，排序、置顶都是围着它调的。被删的那条
 * 上面如果有留最早那条没有的封面 / 备注 / 分组，先补过来再删，免得合并完
 * 卡片反而变白板。**只删数据库记录，磁盘上的工程一个都不碰。**
 */
export const mergeDuplicateProjectPaths = (db: Database.Database): void => {
  const rows = db.prepare(`SELECT * FROM ${TABLE_NAME} ORDER BY id ASC`).all() as ProjectRecord[]

  const groups = new Map<string, ProjectRecord[]>()
  for (const row of rows) {
    const key = projectComparisonKey(String(row.projectPath ?? ''))
    if (!key) continue // 没有路径就无从判重，留着
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  for (const group of groups.values()) {
    const [keep, ...dupes] = group
    if (dupes.length === 0) continue

    const inherited: Partial<ProjectRecord> = {}
    for (const field of ['image', 'note'] as const) {
      if (keep[field]) continue
      const donor = dupes.find((dupe) => dupe[field])
      if (donor) inherited[field] = donor[field]
    }
    if (Object.keys(inherited).length > 0) updateProject(db, keep.projectKey, inherited)

    for (const dupe of dupes) {
      inheritCollectionMemberships(db, dupe.projectKey, keep.projectKey)
      deleteProjectByKey(db, dupe.projectKey)
    }
    console.log(
      `[项目库] 合并重复记录: ${keep.projectName || keep.projectPath} —— 删掉 ${dupes.length} 条`
    )
  }
}

// 注意：根据需求导入时不允许重复，如需按路径更新现有记录，请显式调用 updateProject
export const upsertProjectByPath = (db: Database.Database, record: ProjectRecord): number => {
  const byPath = getProjectByPath(db, String(record.projectPath ?? ''))
  if (byPath) {
    // 需求强调“不导入重复”，此处返回已有记录ID而不更新
    return Number(byPath.id || 0)
  }
  return createProject(db, record)
}

export type { Database }
