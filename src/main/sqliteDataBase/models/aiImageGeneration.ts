import Database from 'better-sqlite3'

/**
 * AI图片生成任务模型接口
 */
export interface AiImageGeneration {
  id?: number
  /** 前端任务ID */
  task_id?: string | null
  /** 提示词 */
  prompt?: string | null
  /** AI生成的任务名称 */
  name?: string | null
  /** 状态: pending | processing | completed | failed */
  status?: string | null
  /** 进度 (0-100) */
  progress?: number | null
  /** 生成的图片URL数组 (JSON) */
  image_urls?: string | null
  /**
   * 已存进资产库的本地文件路径数组 (JSON)，与 image_urls 同序。
   *
   * `image_urls` 存的是模型那边给的地址：远端链接会过期，base64 又特别长。
   * 本地副本才是这张图长期有效的那一份 —— 显示和另存为都优先走它。
   */
  local_paths?: string | null
  /** 参考图数组 (JSON，最多9张base64) */
  reference_images?: string | null
  /** 比例 */
  ratio?: string | null
  /** 分辨率 */
  resolution?: string | null
  /** 使用的模型 */
  model?: string | null
  /** 图像质量 */
  quality?: string | null
  /** 风格 */
  style?: string | null
  /** 生成张数 */
  count?: number | null
  /** 是否为材质模式 */
  material_mode?: number | null
  /** 错误信息 */
  error_msg?: string | null
  /** 服务提供商 */
  provider?: string | null
  created_at?: string
  updated_at?: string
}

const TABLE_NAME = 'ai_image_generations'

/**
 * 初始化 AI 图片生成任务表与索引
 * @param db 数据库实例
 */
export const initAiImageGenerationModel = (db: Database.Database): void => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE,
      prompt TEXT,
      name TEXT,
      status TEXT DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      image_urls TEXT,
      local_paths TEXT,
      reference_images TEXT,
      ratio TEXT,
      resolution TEXT,
      model TEXT,
      quality TEXT,
      style TEXT,
      count INTEGER DEFAULT 1,
      material_mode INTEGER DEFAULT 0,
      error_msg TEXT,
      provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `

  db.exec(createTableSQL)

  // 数据库迁移：添加 name 字段（如果不存在）
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all() as { name: string }[]
    const hasNameField = tableInfo.some((col) => col.name === 'name')
    if (!hasNameField) {
      db.exec(`ALTER TABLE ${TABLE_NAME} ADD COLUMN name TEXT`)
      console.log('[AiImageGeneration] 迁移: 添加 name 字段')
    }
    const requiredColumns: Array<[string, string]> = [
      ['resolution', 'TEXT'],
      ['material_mode', 'INTEGER DEFAULT 0'],
      ['quality', 'TEXT'],
      // 老库补这一列。补进来是空的，历史记录只能继续用会过期的远端链接 ——
      // 从这次升级之后新生成的图开始，重启也能显示和另存为。
      ['local_paths', 'TEXT']
    ]
    for (const [columnName, columnType] of requiredColumns) {
      const hasColumn = tableInfo.some((col) => col.name === columnName)
      if (!hasColumn) {
        db.exec(`ALTER TABLE ${TABLE_NAME} ADD COLUMN ${columnName} ${columnType}`)
        console.log(`[AiImageGeneration] 迁移: 添加 ${columnName} 字段`)
      }
    }
    const hasReferenceImage = tableInfo.some((col) => col.name === 'reference_image')
    const hasReferenceImages = tableInfo.some((col) => col.name === 'reference_images')

    // 如果有旧字段但没有新字段，添加新字段
    if (hasReferenceImage && !hasReferenceImages) {
      db.exec(`ALTER TABLE ${TABLE_NAME} ADD COLUMN reference_images TEXT`)
      // 迁移数据：将单张参考图转换为数组格式
      db.exec(
        `UPDATE ${TABLE_NAME} SET reference_images = '["' || reference_image || '"]' WHERE reference_image IS NOT NULL AND reference_image != ''`
      )
    }
    // 如果两个字段都没有（全新安装），表已经在上面的 CREATE 中包含 reference_images
  } catch (error) {
    console.error('[AiImageGeneration] 数据库迁移失败:', error)
  }

  // 索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_image_generations_task ON ${TABLE_NAME}(task_id);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_image_generations_status ON ${TABLE_NAME}(status);`)
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_ai_image_generations_created ON ${TABLE_NAME}(created_at);`
  )
}

/**
 * 创建图片生成任务记录
 * @param db 数据库实例
 * @param data 任务数据
 * @returns 新记录的自增ID
 */
export const createAiImageGeneration = (
  db: Database.Database,
  data: Partial<AiImageGeneration>
): number => {
  const stmt = db.prepare(`
    INSERT INTO ${TABLE_NAME} (
      task_id, prompt, name, status, progress, image_urls, local_paths, reference_images,
      ratio, resolution, model, quality, style, count, material_mode, error_msg, provider
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const result = stmt.run(
    data.task_id ?? null,
    data.prompt ?? null,
    data.name ?? null,
    data.status ?? 'pending',
    data.progress ?? 0,
    data.image_urls ?? null,
    data.local_paths ?? null,
    data.reference_images ?? null,
    data.ratio ?? null,
    data.resolution ?? null,
    data.model ?? null,
    data.quality ?? null,
    data.style ?? null,
    data.count ?? 1,
    data.material_mode ?? 0,
    data.error_msg ?? null,
    data.provider ?? null
  )
  return Number(result.lastInsertRowid)
}

/**
 * 通过 ID 获取记录
 * @param db 数据库实例
 * @param id 记录ID
 */
export const getAiImageGenerationById = (
  db: Database.Database,
  id: number
): AiImageGeneration | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`)
  return stmt.get(id) as AiImageGeneration | undefined
}

/**
 * 通过 task_id 获取记录
 * @param db 数据库实例
 * @param task_id 任务ID
 */
export const getAiImageGenerationByTaskId = (
  db: Database.Database,
  task_id: string
): AiImageGeneration | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE task_id = ?`)
  return stmt.get(task_id) as AiImageGeneration | undefined
}

/**
 * 更新记录
 * @param db 数据库实例
 * @param id 记录ID
 * @param updates 更新字段
 */
export const updateAiImageGeneration = (
  db: Database.Database,
  id: number,
  updates: Partial<AiImageGeneration>
): boolean => {
  const fields: string[] = []
  const values: unknown[] = []

  Object.entries(updates).forEach(([key, value]) => {
    if (key !== 'id' && key !== 'created_at') {
      fields.push(`${key} = ?`)
      values.push(value)
    }
  })

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
 * 列表查询
 * @param db 数据库实例
 * @param options 查询选项
 */
export const listAiImageGenerations = (
  db: Database.Database,
  options: { status?: string; limit?: number; offset?: number } = {}
): AiImageGeneration[] => {
  const { status, limit = 50, offset = 0 } = options
  const conditions: string[] = []
  const params: unknown[] = []

  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `
    SELECT *
    FROM ${TABLE_NAME}
    ${whereClause}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `
  const stmt = db.prepare(sql)
  return stmt.all(...params, limit, offset) as AiImageGeneration[]
}

/**
 * 统计图片生成记录总数
 * @param db 数据库实例
 */
export const countAiImageGenerations = (db: Database.Database): number => {
  const stmt = db.prepare(`SELECT COUNT(*) AS total FROM ${TABLE_NAME}`)
  const row = stmt.get() as { total?: number } | undefined
  return Number(row?.total || 0)
}

/**
 * 删除记录
 * @param db 数据库实例
 * @param id 记录ID
 */
export const deleteAiImageGeneration = (db: Database.Database, id: number): boolean => {
  const stmt = db.prepare(`DELETE FROM ${TABLE_NAME} WHERE id = ?`)
  const result = stmt.run(id)
  return result.changes > 0
}
