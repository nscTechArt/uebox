import Database from 'better-sqlite3'

// 资产数据模型接口 - 简化版本
export interface AssetData {
  [key: string]: unknown
  id?: number
  assetKey: string
  folderKey: string
  assetName: string
  filePath?: string
  fileSize?: number
  fileExtension?: string
  modifiedTime?: string
  processorType?: string
  assetType?: string
  engineVersion?: string
  isDelete?: number
  /**
   * 进回收站的时刻。没删过就是 null。
   *
   * 不能拿 updated_at 顶替：同步回推、改标签、改备注都会刷新它，于是「最近删除」
   * 会按一个和删除无关的时间排序，而界面上也没法如实说出「这是哪天删的」。
   * 文件夹级联删除时，整棵子树盖同一个时间戳 —— 恢复时靠它认出「这一次删的是哪些」。
   */
  deletedAt?: string | null

  // 核心字段 - 仿造file-processor.js的数据结构
  classKey?: string // 资产类型键值
  name?: string // 资产名称
  originPath?: string // 原始路径
  ext?: string // 文件扩展名
  folderName?: string // 文件夹名
  softPath?: string // 虚幻软路径
  assetClass?: string // 资产分类
  className?: string // 资产类名
  classNameCn?: string // 资产类名（中文）
  classColor?: string // 资产类颜色
  imports?: string // 导入依赖 (JSON字符串)
  imgLocalPath?: string // 缩略图路径
  customPoster?: string // 用户自定义封面图
  baiduyunPath?: string // 百度网盘云端路径
  webdavPath?: string // WebDAV云端路径
  size?: number // 文件大小
  assetConfig?: string // 资产配置
  assetConfigPath?: string // 资产配置路径
  note?: string // 一句话备注（纯文本，进全文搜索索引，agent 也读写它）
  noteId?: number | null // 关联的富文本说明书，指向 note 表；没写过就是 null
  tags?: string // 标签列表 (JSON数组字符串，如 '["角色","武器"]')
  color?: string // 用户自定义颜色（十六进制格式，如 #FF5733）
  isDependency?: number // 是否为依赖资产：0=主资产（用户直接导入）,1=依赖资产（自动收集的依赖）
  fileMd5?: string // 文件MD5值，用于去重
  pluginInfo?: string // 插件详情(JSON字符串)，包含friendlyName, description, category, createdBy, versionName等

  created_at?: string
  updated_at?: string
}

// 资产数据表名
const TABLE_NAME = 'assetData'

/**
 * 初始化资产数据模型（创建资产数据表）
 * @param db 数据库实例
 */
export const initAssetDataModel = (db: Database.Database): void => {
  // 检查表是否存在
  const tableExists = db
    .prepare(
      `
    SELECT name FROM sqlite_master WHERE type='table' AND name=?
  `
    )
    .get(TABLE_NAME)

  if (!tableExists) {
    // 创建新表
    const createTableSQL = `
      CREATE TABLE ${TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assetKey TEXT NOT NULL UNIQUE,
        folderKey TEXT NOT NULL,
        assetName TEXT NOT NULL,
        filePath TEXT,
        fileSize INTEGER,
        fileExtension TEXT,
        modifiedTime TEXT,
        processorType TEXT,
        assetType TEXT,
        engineVersion TEXT,
        isDelete INTEGER NOT NULL DEFAULT 0,
        deletedAt TEXT,
        isDependency INTEGER NOT NULL DEFAULT 0,

        -- 核心字段 - 仿造file-processor.js的数据结构
        classKey TEXT,
        name TEXT,
        originPath TEXT,
        ext TEXT,
        folderName TEXT,
        softPath TEXT,
        assetClass TEXT,
        className TEXT,
        classNameCn TEXT,
        classColor TEXT,
        imports TEXT,
        imgLocalPath TEXT,
        customPoster TEXT,
        baiduyunPath TEXT,
        webdavPath TEXT,
        size INTEGER,
        assetConfig TEXT,
        assetConfigPath TEXT,
        fileMd5 TEXT,
        note TEXT,
        tags TEXT,
        color TEXT,
        pluginInfo TEXT,

        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (folderKey) REFERENCES assetFolder(folderKey) ON DELETE CASCADE
      )
    `
    db.exec(createTableSQL)
  } else {
    // 检查并添加缺失的列
    const columns = db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all() as any[]
    const existingColumns = columns.map((col) => col.name)

    const newColumns = [
      // 软删除标记
      { name: 'isDelete', type: 'INTEGER NOT NULL DEFAULT 0' },
      // 进回收站的时刻（老库补列后为 NULL，排序时退回 updated_at）
      { name: 'deletedAt', type: 'TEXT' },
      // 核心字段
      { name: 'classKey', type: 'TEXT' },
      { name: 'name', type: 'TEXT' },
      { name: 'originPath', type: 'TEXT' },
      { name: 'ext', type: 'TEXT' },
      { name: 'softPath', type: 'TEXT' },
      { name: 'assetClass', type: 'TEXT' },
      { name: 'className', type: 'TEXT' },
      { name: 'classNameCn', type: 'TEXT' },
      { name: 'classColor', type: 'TEXT' },
      { name: 'imports', type: 'TEXT' },
      { name: 'imgLocalPath', type: 'TEXT' },
      { name: 'customPoster', type: 'TEXT' },
      { name: 'size', type: 'INTEGER' },
      { name: 'assetConfig', type: 'TEXT' },
      { name: 'assetConfigPath', type: 'TEXT' },
      { name: 'note', type: 'TEXT' },
      // 关联的富文本说明书，指向 note 表。note 这一列要留在全文搜索索引里、
      // 还要给 agent 读写，所以富内容另外挂，不动它
      { name: 'noteId', type: 'INTEGER' },
      { name: 'tags', type: 'TEXT' }, // 标签列表 (JSON数组字符串)
      { name: 'color', type: 'TEXT' }, // 用户自定义颜色
      { name: 'isDependency', type: 'INTEGER DEFAULT 0' }, // 是否为依赖资产
      { name: 'fileMd5', type: 'TEXT' }, // 文件MD5值，用于去重
      { name: 'baiduyunPath', type: 'TEXT' }, // 百度网盘云端路径
      { name: 'webdavPath', type: 'TEXT' }, // WebDAV云端路径
      { name: 'pluginInfo', type: 'TEXT' }, // 插件详情(JSON字符串)

      // 基本字段
      { name: 'filePath', type: 'TEXT' },
      { name: 'fileSize', type: 'INTEGER' },
      { name: 'fileExtension', type: 'TEXT' },
      { name: 'modifiedTime', type: 'TEXT' },
      { name: 'processorType', type: 'TEXT' },
      { name: 'assetType', type: 'TEXT' },
      { name: 'engineVersion', type: 'TEXT' },
      { name: 'folderName', type: 'TEXT' }
    ]

    for (const column of newColumns) {
      if (!existingColumns.includes(column.name)) {
        try {
          db.exec(`ALTER TABLE ${TABLE_NAME} ADD COLUMN ${column.name} ${column.type}`)
          console.log(`添加列 ${column.name} 到表 ${TABLE_NAME}`)
        } catch (error) {
          console.warn(`添加列 ${column.name} 失败:`, error)
        }
      }
    }
  }

  // 添加索引以提高查询性能
  const createIndexSQL = `
    CREATE INDEX IF NOT EXISTS idx_assetData_isDelete ON ${TABLE_NAME}(isDelete);
    CREATE INDEX IF NOT EXISTS idx_assetData_fileExtension ON ${TABLE_NAME}(fileExtension);
    CREATE INDEX IF NOT EXISTS idx_assetData_assetType ON ${TABLE_NAME}(assetType);
    CREATE INDEX IF NOT EXISTS idx_assetData_processorType ON ${TABLE_NAME}(processorType);
    CREATE INDEX IF NOT EXISTS idx_assetData_filePath ON ${TABLE_NAME}(filePath);
    CREATE INDEX IF NOT EXISTS idx_assetData_softPath ON ${TABLE_NAME}(softPath);
    CREATE INDEX IF NOT EXISTS idx_assetData_assetClass ON ${TABLE_NAME}(assetClass);
    CREATE INDEX IF NOT EXISTS idx_assetData_className ON ${TABLE_NAME}(className);
    CREATE INDEX IF NOT EXISTS idx_assetData_fileMd5 ON ${TABLE_NAME}(fileMd5);
    -- 远端导入按路径查重（remoteImportPath.ts）用的复合索引。单列 filePath 索引
    -- 不够：那条查询同时按 originPath 查，缺一侧索引整条就退化成全表扫。
    CREATE INDEX IF NOT EXISTS idx_assetData_filePath_isDelete ON ${TABLE_NAME}(filePath, isDelete);
    CREATE INDEX IF NOT EXISTS idx_assetData_originPath_isDelete ON ${TABLE_NAME}(originPath, isDelete);
    -- 名称等值 / 排序（Spotlight、工程导入按名找依赖）
    CREATE INDEX IF NOT EXISTS idx_assetData_assetName ON ${TABLE_NAME}(assetName COLLATE NOCASE);
    -- 缩略图占用判断（vaultThumbnailRefs）与媒体读取权限（thumbnails.ts）按文件名等值查。
    -- 部分索引：绝大多数行这两列为空，全列索引白占空间；等值条件蕴含 IS NOT NULL，规划器能用。
    --
    -- 谓词只能写到 IS NOT NULL 为止，别加 "AND col != 空串"。本仓库的「空」确实既有
    -- NULL 又有空串（写入方多数写空串），加上去看着更贴合实际，但 SQLite 判定部分索引
    -- 可用，要求查询条件蕴含谓词的**每一个** AND 分支："col = ?" 能蕴含 IS NOT NULL，
    -- 却蕴含不了 "col != 空串"（? 的值在 prepare 时未知）。实测加了之后计划从
    -- "SEARCH ... USING INDEX (imgLocalPath=?)" 退化成 "SCAN assetData"，强行 INDEXED BY
    -- 直接报 no query solution —— 想省空间反而把索引整个废掉。真要瘦身得在写入侧把
    -- 空串归一成 NULL，不是在这里加条件。
    CREATE INDEX IF NOT EXISTS idx_assetData_imgLocalPath_present
      ON ${TABLE_NAME}(imgLocalPath) WHERE imgLocalPath IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_assetData_customPoster_present
      ON ${TABLE_NAME}(customPoster) WHERE customPoster IS NOT NULL;
    -- 筛选下拉的类型聚合（getDistinctAssetTypes）只读索引不回表：52 万行从 7.9 s 降到 0.3 s
    CREATE INDEX IF NOT EXISTS idx_assetData_types_cover
      ON ${TABLE_NAME}(classNameCn, isDelete, fileExtension, ext, className);
    CREATE INDEX IF NOT EXISTS idx_assetData_folderKey_isDelete_assetName
      ON ${TABLE_NAME}(folderKey, isDelete, assetName COLLATE NOCASE);
  `

  db.exec(createIndexSQL)
  console.log(`资产数据表 ${TABLE_NAME} 初始化完成`)
}

/**
 * 创建资产数据
 * @param db 数据库实例
 * @param asset 资产数据
 * @returns 创建的资产ID
 */
export const createAssetData = (db: Database.Database, asset: AssetData): number => {
  // 将传入值规整为 better-sqlite3 支持的绑定类型
  const normalize = (value: unknown): number | string | bigint | Buffer | null => {
    if (value === undefined) return null
    if (value === null) return null
    if (value instanceof Date) return value.toISOString()
    return value as number | string | bigint | Buffer | null
  }

  const stmt = db.prepare(`
    INSERT INTO ${TABLE_NAME} (
      assetKey, folderKey, assetName, filePath, fileSize, fileExtension,
      modifiedTime, processorType, assetType, engineVersion,
      isDelete, isDependency,
      classKey, name, originPath, ext, folderName, softPath, assetClass,
      className, classNameCn, classColor, imports, imgLocalPath, customPoster, size, assetConfig, assetConfigPath, fileMd5, note, pluginInfo
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  // 将 undefined 值转换为 null，Date 对象转换为字符串，确保 SQLite 兼容性
  const result = stmt.run(
    normalize(asset.assetKey),
    normalize(asset.folderKey),
    normalize(asset.assetName),
    normalize(asset.filePath),
    normalize(asset.fileSize),
    normalize(asset.fileExtension),
    normalize(asset.modifiedTime),
    normalize(asset.processorType),
    normalize(asset.assetType),
    normalize(asset.engineVersion),
    asset.isDelete ?? 0,
    asset.isDependency ?? 0,
    normalize(asset.classKey),
    normalize(asset.name),
    normalize(asset.originPath),
    normalize(asset.ext),
    normalize(asset.folderName),
    normalize(asset.softPath),
    normalize(asset.assetClass),
    normalize(asset.className),
    normalize(asset.classNameCn),
    normalize(asset.classColor),
    normalize(asset.imports),
    normalize(asset.imgLocalPath),
    normalize(asset.customPoster),
    normalize(asset.size),
    normalize(asset.assetConfig),
    normalize(asset.assetConfigPath),
    normalize(asset.fileMd5),
    normalize(asset.note),
    normalize(asset.pluginInfo)
  )
  return result.lastInsertRowid as number
}

/**
 * 根据assetKey获取资产数据
 * @param db 数据库实例
 * @param assetKey 资产键值
 * @returns 资产数据
 */
export const getAssetDataByKey = (
  db: Database.Database,
  assetKey: string
): AssetData | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE assetKey = ? AND isDelete = 0`)
  return stmt.get(assetKey) as AssetData | undefined
}

/**
 * 根据folderKey获取资产数据列表
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @param sortBy 排序字段
 * @param sortOrder 排序顺序
 * @param showDependencies 是否显示依赖资产，默认true显示所有，false只显示主资产
 * @returns 资产数据列表
 */
export const getAssetDataByFolderKey = (
  db: Database.Database,
  folderKey: string,
  sortBy: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType' = 'assetName',
  sortOrder: 'asc' | 'desc' = 'asc',
  showDependencies: boolean = true,
  limit?: number,
  offset?: number
): AssetData[] => {
  const validOrders = ['asc', 'desc']
  const safeSortOrder = validOrders.includes(sortOrder.toLowerCase())
    ? sortOrder.toUpperCase()
    : 'ASC'

  let dbSortCol = 'assetName'
  if (sortBy === 'modifiedTime') {
    // 使用 updated_at 作为修改时间排序依据，因为它由系统自动维护且一定有值
    dbSortCol = 'updated_at'
  } else if (sortBy === 'fileSize') {
    // 处理 fileSize 为空的情况，默认为 0
    dbSortCol = 'COALESCE(fileSize, 0)'
  } else if (sortBy === 'assetType') {
    // 处理 assetType 为空的情况，排到末尾
    dbSortCol = "COALESCE(assetType, '')"
  } else {
    dbSortCol = 'assetName'
  }

  // 时间 / 大小也要名字做次序键：updated_at 只到秒，一次导入整批同一秒，
  // 没有次序键就既不稳定、分页也可能重复或漏掉。搜索那条路（assetSearch.ts）用的是同一套
  const orderByClause =
    dbSortCol === 'assetName'
      ? `${dbSortCol} COLLATE NOCASE ${safeSortOrder}`
      : dbSortCol === "COALESCE(assetType, '')"
        ? `${dbSortCol} COLLATE NOCASE ${safeSortOrder}, assetName COLLATE NOCASE ASC`
        : `${dbSortCol} ${safeSortOrder}, assetName COLLATE NOCASE ASC`

  // 如果不显示依赖资产，添加 isDependency = 0 条件
  const dependencyCondition = showDependencies ? '' : ' AND isDependency = 0'

  const limitClause =
    typeof limit === 'number' ? ` LIMIT ?${typeof offset === 'number' ? ' OFFSET ?' : ''}` : ''

  const stmt = db.prepare(
    `SELECT * FROM ${TABLE_NAME} WHERE folderKey = ? AND isDelete = 0${dependencyCondition} ORDER BY ${orderByClause}${limitClause}`
  )
  const params: Array<string | number> = [folderKey]
  if (typeof limit === 'number') {
    params.push(limit)
    if (typeof offset === 'number') {
      params.push(offset)
    }
  }
  return stmt.all(...params) as AssetData[]
}

/**
 * 根据资产名称搜索资产数据
 * @param db 数据库实例
 * @param searchTerm 搜索关键词
 * @returns 匹配的资产数据列表
 */
export const searchAssetDataByName = (
  db: Database.Database,
  searchTerm: string,
  limit?: number
): AssetData[] => {
  // 前置通配的 LIKE 用不上索引，52 万行的库每次 5 秒多，而且是同步的。
  // 交互式搜索（Spotlight）应优先走 FTS（见 ipc/spotlight.ts），这里只是兜底，
  // 所以至少把结果集封住，别把整表搬进内存。
  const cappedLimit =
    Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : 0
  const pattern = `%${searchTerm}%`
  if (cappedLimit) {
    // 强制沿 assetName 索引按序走：常见词凑够 LIMIT 条就停；生僻词也只是扫一遍索引
    // （不回表），实测 52 万行从 6 秒降到零点几秒。规划器自己不会选这条路，
    // 没有统计信息时它更喜欢 isDelete 那个两值索引 + 整表排序。
    try {
      return db
        .prepare(
          `SELECT * FROM ${TABLE_NAME} INDEXED BY idx_assetData_assetName
            WHERE isDelete = 0 AND assetName LIKE ?
            ORDER BY assetName COLLATE NOCASE ASC
            LIMIT ${cappedLimit}`
        )
        .all(pattern) as AssetData[]
    } catch (err) {
      // 只有「索引不存在」才该退回慢路（极老的库、或建库脚本没跑完）。
      // 以前这里是个裸 catch：SQLITE_BUSY、中断、索引损坏也会被它吞掉，
      // 然后悄悄跑回这个方法专门要消灭的整表扫，日志里一个字都没有。
      const message = err instanceof Error ? err.message : String(err)
      if (!/no such index/i.test(message)) throw err
      console.warn('[assetData] idx_assetData_assetName 缺失，本次搜索退回全表扫:', message)
    }
  }
  const stmt = db.prepare(
    // 排序必须和快路一致，否则同一次搜索走哪条路会得到不同的 top-N：
    // 快路是 NOCASE，这里不写 COLLATE 就是 BINARY，大小写混排的结果对不上
    `SELECT * FROM ${TABLE_NAME} WHERE isDelete = 0 AND assetName LIKE ? ORDER BY assetName COLLATE NOCASE ASC` +
      (cappedLimit ? ` LIMIT ${cappedLimit}` : '')
  )
  return stmt.all(pattern) as AssetData[]
}

/**
 * 按资产名查（不区分大小写），走 idx_assetData_assetName。
 *
 * 工程导入按依赖名找资产原来用 searchAssetDataByName 模糊查再在 JS 里做精确过滤，
 * 每个依赖一次全表扫。这里换成索引等值查，但**不能只比 assetName = ?**：
 * 库里同一列存着两种形态。扫描器（networkVaultV2.ts 的 performServerScan）写的是
 * `basename(fullPath)`，带扩展名，例如 `SM_Chair.uasset`；而依赖名是从 softPath
 * 切出来的，softPath 早就把扩展名去掉了，只有 `SM_Chair`。只比等值的话，
 * 网络库里由扫描器建的行一条都命中不了，依赖被静默丢掉，导入出来的工程引用全是红的。
 * 所以再带一段 `名字.` 前缀的范围查 —— 同样是索引 seek，不是扫表。
 *
 * 范围只认**一段**扩展名：`instr(substr(...))` 把 `SM_Chair.uasset.bak` 这类挡在外面。
 * 不挡的话，调用方那边第一道过滤只看 softPath，`.bak` / `.fbx` / `.png` 这些跟资产同名
 * 同目录的旁支会顶掉真正的 `.uasset`（并列时还按 id DESC 让最近导入的那个赢）。
 *
 * 结果按「softPath 后缀是否命中」优先排序再截断：同名资产在 UE 工程里是常态，
 * 无序的 LIMIT 会让调用方真正要的那一行恰好落在窗口外。
 */
/** LIKE 的元字符要转义：UE 资产名里 `_` 满地都是，不转义它就是个单字符通配符 */
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, '\\$&')

/** 导出给执行计划的回归测试 EXPLAIN 用 —— 测试抄一份副本的话，钉索引被删了它也发现不了 */
export const buildExactNameSQL = (indexed: string): string =>
  `SELECT * FROM (
      SELECT * FROM ${TABLE_NAME}${indexed}
        WHERE isDelete = 0 AND assetName = @stem COLLATE NOCASE
      UNION ALL
      SELECT * FROM ${TABLE_NAME}${indexed}
        WHERE isDelete = 0
          AND assetName > @low COLLATE NOCASE
          AND assetName < @high COLLATE NOCASE
          AND instr(substr(assetName, length(@stem) + 2), '.') = 0
    )
    ORDER BY CASE WHEN softPath LIKE @prefer ESCAPE '\\' THEN 0 ELSE 1 END, id DESC
    LIMIT @lim`

export const EXACT_NAME_INDEX_HINT = ' INDEXED BY idx_assetData_assetName'

/**
 * 每个库缓存一份 prepare 好的语句。
 *
 * 这个函数在工程导入里是「每个依赖调一次」，实测 2000 次里 db.prepare() 本身就占了
 * 111 ms —— 5000 个文件 × 8 个依赖那种规模下是 2.2 秒纯粹浪费在重复编译同一条 SQL。
 * WeakMap 挂在 Database 上，库关掉就跟着回收。
 */
const exactNameStmtCache = new WeakMap<
  Database.Database,
  { pinned?: Database.Statement; plain?: Database.Statement }
>()

function exactNameStatement(db: Database.Database, indexed: string): Database.Statement {
  let entry = exactNameStmtCache.get(db)
  if (!entry) {
    entry = {}
    exactNameStmtCache.set(db, entry)
  }
  const key = indexed ? 'pinned' : 'plain'
  const cached = entry[key]
  if (cached) return cached
  const stmt = db.prepare(buildExactNameSQL(indexed))
  entry[key] = stmt
  return stmt
}

export const findAssetDataByExactName = (
  db: Database.Database,
  assetName: string,
  limit = 50,
  preferSoftPathSuffix?: string
): AssetData[] => {
  if (!assetName) return []
  const params = {
    stem: assetName,
    low: `${assetName}.`,
    high: `${assetName}.￿`,
    // 没给偏好后缀就传 null：`softPath LIKE NULL` 恒为 NULL，稳稳落到 ELSE 1。
    // 这里以前传 ''，而 `'' LIKE ''` 为真 —— softPath 确实可能是空串，那些行会被
    // 顶到排序最前面，正好挤掉调用方要的那一条
    prefer: preferSoftPathSuffix ? `%${escapeLikePattern(preferSoftPathSuffix)}` : null,
    lim: Math.max(1, Math.floor(limit))
  }
  // 两条分支都得把索引钉死。库里没有统计信息时规划器会挑 idx_assetData_isDelete ——
  // 一个只有 0/1 两个值的索引，52 万行上等于全表扫，正是 a1ef7de 要消灭的那个形状。
  // 实测（4 行的内存库、未 ANALYZE）不钉就会选它。
  try {
    return exactNameStatement(db, EXACT_NAME_INDEX_HINT).all(params) as AssetData[]
  } catch (err) {
    // 只有「索引不存在」才退回让规划器自己选（极老的库、建库脚本没跑完）
    const message = err instanceof Error ? err.message : String(err)
    if (!/no such index/i.test(message)) throw err
    console.warn('[assetData] idx_assetData_assetName 缺失，按名找依赖退回全表扫:', message)
    return exactNameStatement(db, '').all(params) as AssetData[]
  }
}

/**
 * 找出 imports 里可能包含某个 softPath 的资产（反向引用候选）。
 *
 * imports 是 JSON 文本列建不了索引，只能扫。但把 instr() 放进 SQL 让 SQLite 在 C 里扫，
 * 而不是把 52 万行整表捞进 JS 再逐行 JSON.parse：后者实测 50 秒、1.5 GB 堆，
 * 前者约 7 秒、几乎不占内存。返回的是候选，调用方仍需 parseImports 精确确认。
 */
export const findAssetsPossiblyImporting = (
  db: Database.Database,
  softPath: string,
  excludeAssetKey: string
): AssetData[] => {
  if (!softPath) return []
  const stmt = db.prepare(
    `SELECT * FROM ${TABLE_NAME}
      WHERE isDelete = 0 AND assetKey != ? AND imports IS NOT NULL AND instr(imports, ?) > 0`
  )
  return stmt.all(excludeAssetKey, softPath) as AssetData[]
}

/**
 * 更新资产数据
 * @param db 数据库实例
 * @param assetKey 资产键值
 * @param updates 更新数据
 * @returns 是否更新成功
 */
export const updateAssetData = (
  db: Database.Database,
  assetKey: string,
  updates: Partial<AssetData>
): boolean => {
  // 列名要拼进 SQL，绑定参数保护不到它 —— 必须先跟真实表结构对一遍。
  // 隔壁 updateAssetFolder 一直是这么做的，这里漏了：调用方一路通到
  // 渲染层的 db:assetData:update 和服务端的 PUT /assets/:key，网络可达。
  const tableColumns = db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all() as { name: string }[]
  const existingColumnNames = new Set(tableColumns.map((col) => col.name))

  const fields = Object.keys(updates).filter(
    (key) => key !== 'assetKey' && key !== 'id' && existingColumnNames.has(key)
  )
  if (fields.length === 0) return false

  const setClause = fields.map((field) => `${field} = ?`).join(', ')
  // 统一规整绑定值，避免传入 Date/undefined 等不被支持的类型
  const normalize = (value: unknown): number | string | bigint | Buffer | null => {
    if (value === undefined) return null
    if (value === null) return null
    if (value instanceof Date) return value.toISOString()
    return value as number | string | bigint | Buffer | null
  }
  const values = fields.map((field) => normalize(updates[field as keyof AssetData]))

  console.log('[DB] updateAssetData fields:', fields)
  console.log('[DB] updateAssetData values:', values)
  console.log('[DB] updateAssetData setClause:', setClause, 'assetKey:', assetKey)

  const stmt = db.prepare(`
    UPDATE ${TABLE_NAME}
    SET ${setClause}, updated_at = datetime('now', 'localtime')
    WHERE assetKey = ?
  `)

  const result = stmt.run(...values, assetKey)
  console.log('[DB] updateAssetData changes:', result.changes)
  return result.changes > 0
}

/**
 * 这一次删除的时间戳。
 *
 * 由 JS 生成而不是让每条 SQL 各自 `datetime('now')`：一次文件夹删除会分成
 * 「文件夹一批、资产一批」好几条语句，跨秒边界就会拿到两个不一样的值，
 * 而「恢复这一次删的东西」正是靠时间戳相等认出来的。
 */
export const deletionStamp = (date: Date = new Date()): string => {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 删除资产数据
 * @param db 数据库实例
 * @param assetKey 资产键值
 * @param deletedAt 删除时刻，不传就现取（文件夹级联删除会传同一个值）
 * @returns 是否删除成功
 */
export const deleteAssetData = (
  db: Database.Database,
  assetKey: string,
  deletedAt: string = deletionStamp()
): boolean => {
  const stmt = db.prepare(
    `UPDATE ${TABLE_NAME} SET isDelete = 1, deletedAt = ?, updated_at = datetime('now', 'localtime') WHERE assetKey = ? AND isDelete = 0`
  )
  const result = stmt.run(deletedAt, assetKey)
  return result.changes > 0
}

/**
 * 恢复资产数据（将 isDelete 置为 0）
 * @param db 数据库实例
 * @param assetKey 资产键值
 * @returns 是否恢复成功
 */
export const restoreAssetData = (db: Database.Database, assetKey: string): boolean => {
  const stmt = db.prepare(
    `UPDATE ${TABLE_NAME} SET isDelete = 0, deletedAt = NULL, updated_at = datetime('now', 'localtime') WHERE assetKey = ? AND isDelete = 1`
  )
  const result = stmt.run(assetKey)
  if (result.changes === 0) return false
  restoreAncestorFolders(db, assetKey)
  return true
}

/**
 * 把资产头顶上那条已被删除的文件夹链一起恢复。
 *
 * 不做这一步的话，「恢复」出来的是一个**谁也看不见的**资产：文件夹树只显示
 * isDelete = 0 的文件夹，所以它不在树里的任何位置；而它又已经不在回收站里了。
 * 用户看到的就是「点了恢复，东西没了」。
 *
 * 只恢复这条链上的文件夹本身，不碰它们下面其余仍在回收站里的东西 ——
 * 用户要的是「把这一个拿回来」，不是「把整个文件夹倒回来」。
 */
const restoreAncestorFolders = (db: Database.Database, assetKey: string): void => {
  const row = db.prepare(`SELECT folderKey FROM ${TABLE_NAME} WHERE assetKey = ?`).get(assetKey) as
    | { folderKey?: string }
    | undefined
  if (!row?.folderKey) return

  const selectFolder = db.prepare(
    `SELECT folderKey, fatherKey, isDelete FROM assetFolder WHERE folderKey = ?`
  )
  const reviveFolder = db.prepare(
    `UPDATE assetFolder SET isDelete = 0, deletedAt = NULL, updated_at = datetime('now', 'localtime')
      WHERE folderKey = ? AND isDelete = 1`
  )

  const seen = new Set<string>()
  let cursor: string | null | undefined = row.folderKey
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const folder = selectFolder.get(cursor) as
      | { folderKey: string; fatherKey: string | null; isDelete: number }
      | undefined
    if (!folder) return
    if (folder.isDelete === 1) reviveFolder.run(folder.folderKey)
    cursor = folder.fatherKey
  }
}

/**
 * 批量删除指定文件夹下的所有资产数据
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @param deletedAt 删除时刻，不传就现取
 * @returns 删除的资产数量
 */
export const deleteAssetDataByFolderKey = (
  db: Database.Database,
  folderKey: string,
  deletedAt: string = deletionStamp()
): number => {
  const stmt = db.prepare(
    `UPDATE ${TABLE_NAME} SET isDelete = 1, deletedAt = ?, updated_at = datetime('now', 'localtime') WHERE folderKey = ? AND isDelete = 0`
  )
  const result = stmt.run(deletedAt, folderKey)
  return result.changes
}

/**
 * 获取所有资产数据
 * @param db 数据库实例
 * @returns 资产数据列表
 */
export const getAllAssetData = (db: Database.Database): AssetData[] => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE isDelete = 0 ORDER BY assetName ASC`)
  return stmt.all() as AssetData[]
}

/**
 * 检查资产数据是否存在
 * @param db 数据库实例
 * @param assetKey 资产键值
 * @returns 是否存在
 */
export const assetDataExists = (db: Database.Database, assetKey: string): boolean => {
  const stmt = db.prepare(
    `SELECT COUNT(*) as count FROM ${TABLE_NAME} WHERE assetKey = ? AND isDelete = 0`
  )
  const result = stmt.get(assetKey) as { count: number }
  return result.count > 0
}

/**
 * 获取指定文件夹下的资产数量
 * @param db 数据库实例
 * @param folderKey 文件夹键值
 * @returns 资产数量
 */
export const getAssetCountByFolderKey = (db: Database.Database, folderKey: string): number => {
  const stmt = db.prepare(
    `SELECT COUNT(*) as count FROM ${TABLE_NAME} WHERE folderKey = ? AND isDelete = 0`
  )
  const result = stmt.get(folderKey) as { count: number }
  return result.count
}

/**
 * Get the asset count for a folder while preserving the dependency filter semantics.
 */
export const getFilteredAssetCountByFolderKey = (
  db: Database.Database,
  folderKey: string,
  showDependencies: boolean = true
): number => {
  const dependencyCondition = showDependencies ? '' : ' AND isDependency = 0'
  const stmt = db.prepare(
    `SELECT COUNT(*) as count FROM ${TABLE_NAME} WHERE folderKey = ? AND isDelete = 0${dependencyCondition}`
  )
  const result = stmt.get(folderKey) as { count: number }
  return result.count
}

/**
 * 获取所有已软删除的资产数据（isDelete = 1），支持分页
 * @param db 数据库实例
 * @param page 页码（从1开始），如果未提供则返回所有
 * @param pageSize 每页数量
 * @returns 资产列表和总数
 */
export const getDeletedAssetData = (
  db: Database.Database,
  page?: number,
  pageSize?: number
): { list: AssetData[]; total: number } => {
  // 获取总数
  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM ${TABLE_NAME} WHERE isDelete = 1`)
  const total = (countStmt.get() as { count: number }).count

  // 按删除时间倒序。老库补列之前删的那些 deletedAt 是 NULL，退回 updated_at
  let sql = `SELECT * FROM ${TABLE_NAME} WHERE isDelete = 1
             ORDER BY COALESCE(deletedAt, updated_at) DESC, assetName ASC`

  // 应用分页
  if (page && pageSize) {
    const offset = (page - 1) * pageSize
    sql += ` LIMIT ${pageSize} OFFSET ${offset}`
  } else if (total > 2000) {
    // 安全防护：如果未指定分页且数据量过大，强制限制 2000 条
    console.warn('[AssetData] 警告：回收站数据量过大且未指定分页，强制限制返回前2000条')
    sql += ` LIMIT 2000`
  }

  const list = db.prepare(sql).all() as AssetData[]
  return { list, total }
}
export const getAssetDataBySoftPath = (
  db: Database.Database,
  softPath: string
): AssetData | undefined => {
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE softPath = ? AND isDelete = 0 LIMIT 1`)
  return stmt.get(softPath) as AssetData | undefined
}
/**
 * 一次查一批 assetKey。
 *
 * 批量导入原来是循环里一个资产一条 `getAssetDataByKey`，一万个资产就是一万条
 * SELECT。SQLite 的变量个数有上限，按 500 一组切开。
 */
export const getAssetsByKeys = (db: Database.Database, assetKeys: string[]): AssetData[] => {
  if (!Array.isArray(assetKeys) || assetKeys.length === 0) return []

  const unique = Array.from(new Set(assetKeys.filter(Boolean)))
  const CHUNK_SIZE = 500
  const rows: AssetData[] = []

  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    const stmt = db.prepare(
      `SELECT * FROM ${TABLE_NAME} WHERE isDelete = 0 AND assetKey IN (${placeholders})`
    )
    rows.push(...(stmt.all(...chunk) as AssetData[]))
  }

  return rows
}

/**
 * 一次查一批 softPath。
 *
 * 和 getAssetsByKeys 一样按 500 一组切：一个资产的 imports 可能上千条，
 * 一次性摊成 IN (?,?,…) 会撞上 SQLite 的绑定变量上限。
 */
export const getAssetsBySoftPaths = (db: Database.Database, softPaths: string[]): AssetData[] => {
  if (!Array.isArray(softPaths) || softPaths.length === 0) return []

  const unique = Array.from(new Set(softPaths.filter(Boolean)))
  const CHUNK_SIZE = 500
  const rows: AssetData[] = []

  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(',')
    const stmt = db.prepare(
      `SELECT * FROM ${TABLE_NAME} WHERE isDelete = 0 AND softPath IN (${placeholders})`
    )
    rows.push(...(stmt.all(...chunk) as AssetData[]))
  }

  return rows
}

/**
 * 根据文件MD5查找已存在的资产
 * @param db 数据库实例
 * @param fileMd5 文件MD5值
 * @returns 已存在的资产数据，如果不存在则返回 undefined
 */
export const getAssetDataByMd5 = (
  db: Database.Database,
  fileMd5: string
): AssetData | undefined => {
  if (!fileMd5) return undefined
  const stmt = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE fileMd5 = ? AND isDelete = 0 LIMIT 1`)
  return stmt.get(fileMd5) as AssetData | undefined
}

/**
 * 同一个文件夹里内容相同的资产（本地库重复导入去重用）。
 *
 * 为什么要带 folderKey：同一个源文件**可以**被有意导入到两个不同文件夹
 * （引用型/备份型保管库的正常用法），那是两条独立记录。
 * 但同一个文件夹里出现两条内容相同的记录，只可能是重复导入的产物。
 */
export const getAssetDataByMd5InFolder = (
  db: Database.Database,
  fileMd5: string,
  folderKey: string
): AssetData | undefined => {
  if (!fileMd5 || !folderKey) return undefined
  const stmt = db.prepare(
    `SELECT * FROM ${TABLE_NAME} WHERE fileMd5 = ? AND folderKey = ? AND isDelete = 0 LIMIT 1`
  )
  return stmt.get(fileMd5, folderKey) as AssetData | undefined
}

/**
 * 根据 originPath 查找资产（用于网络库去重）
 * @param db 数据库实例
 * @param originPath 原始路径
 * @returns 已存在的资产数据，如果不存在则返回 undefined
 */
export const getAssetDataByOriginPath = (
  db: Database.Database,
  originPath: string
): AssetData | undefined => {
  if (!originPath) return undefined
  const stmt = db.prepare(
    `SELECT * FROM ${TABLE_NAME} WHERE originPath = ? AND isDelete = 0 LIMIT 1`
  )
  return stmt.get(originPath) as AssetData | undefined
}

/**
 * 同一个 filePath 上还活着的其他记录。
 *
 * 同一个文件被导入两遍会留下两条记录、两个 assetKey，但 `filePath` 是同一个。
 * 删掉其中一条只是软删除，磁盘上什么都没动；可一旦在界面里对它「彻底删除」
 * 或「清空回收站」，`deleteVaultBackupAndThumbnail` 会把这个文件删掉 ——
 * 留下来的那条记录当场指空。清理重复登记时必须先知道有没有这种共用。
 *
 * @param db 数据库实例
 * @param filePath 文件路径
 * @param excludeAssetKey 排除掉的 assetKey（通常是刚被删的那条）
 * @returns 仍未删除、且指向同一个文件的其他资产
 */
export const getLiveAssetsByFilePath = (
  db: Database.Database,
  filePath: string | undefined | null,
  excludeAssetKey?: string
): AssetData[] => {
  if (!filePath) return []
  const stmt = db.prepare(
    `SELECT * FROM ${TABLE_NAME} WHERE filePath = ? AND isDelete = 0 AND assetKey != ?`
  )
  return stmt.all(filePath, excludeAssetKey ?? '') as AssetData[]
}

/** SQLite 单条语句的变量数上限是 999，留点余量 */
const FILE_PATH_PARAM_BATCH = 500

/** 物理清理只能排除本次实际删除的记录；回收站中的其余记录仍需要文件来恢复。 */
export const getRetainedFilePaths = (
  db: Database.Database,
  filePaths: readonly (string | undefined | null)[],
  purgedAssetKeys: readonly string[]
): Set<string> => {
  const candidates = [...new Set(filePaths.filter((p): p is string => Boolean(p)))]
  const purged = new Set(purgedAssetKeys)
  const retained = new Set<string>()

  for (let i = 0; i < candidates.length; i += FILE_PATH_PARAM_BATCH) {
    const batch = candidates.slice(i, i + FILE_PATH_PARAM_BATCH)
    const marks = batch.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT assetKey, filePath FROM ${TABLE_NAME} WHERE filePath IN (${marks})`)
      .all(...batch) as Array<{ assetKey: string; filePath: string }>
    for (const row of rows) {
      if (!purged.has(row.assetKey)) retained.add(row.filePath)
    }
  }
  return retained
}

/**
 * 一批 filePath 里，哪些还被 isDelete = 0 的记录占着。
 *
 * 批量清理（清空回收站）用的版本：一次算完，不逐条查 —— 回收站里几千条记录
 * 就是几千次 SELECT，而且全跑在事务里，主进程会明显卡住。
 *
 * 只看 isDelete = 0，所以调用方不需要把「正在删的这批」排除掉：它们本来就是
 * 软删除态，不会被算成占用者。**只有「清空回收站」能用这一版** —— 那一次把
 * 所有软删除的行一起清掉。只清其中一部分时必须走 [getRetainedFilePaths]，
 * 它按 assetKey 排除，留在回收站里的其他记录仍然算占用者（它们还能恢复）。
 *
 * @param db 数据库实例
 * @param filePaths 候选文件路径（可以有空值和重复，内部会清理）
 * @returns 仍被占用的路径集合
 */
export const getSharedLiveFilePaths = (
  db: Database.Database,
  filePaths: readonly (string | undefined | null)[]
): Set<string> => {
  const candidates = [...new Set(filePaths.map((p) => (p ? String(p) : '')).filter(Boolean))]
  const shared = new Set<string>()

  for (let i = 0; i < candidates.length; i += FILE_PATH_PARAM_BATCH) {
    const batch = candidates.slice(i, i + FILE_PATH_PARAM_BATCH)
    const marks = batch.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT DISTINCT filePath FROM ${TABLE_NAME}
         WHERE isDelete = 0 AND filePath IN (${marks})`
      )
      .all(...batch) as Array<{ filePath: string }>
    for (const row of rows) shared.add(row.filePath)
  }

  return shared
}

/**
 * 获取所有去重的资产类型列表（用于筛选下拉菜单）
 * 使用 SQL GROUP BY 按中文类型名去重，性能远高于读取所有数据
 * @param db 数据库实例
 * @returns 资产类型列表 { className, classNameCn }[]
 */
export const getDistinctAssetTypes = (
  db: Database.Database
): { className: string; classNameCn: string }[] => {
  // 使用 GROUP BY classNameCn 确保每个中文类型名只出现一次
  // MAX(className) 用于选取一个对应的英文类名
  const stmt = db.prepare(`
    SELECT MAX(className) as className, classNameCn
    FROM ${TABLE_NAME}
    WHERE isDelete = 0
      AND classNameCn IS NOT NULL
      AND classNameCn != ''
      AND (fileExtension = 'uasset' OR fileExtension = 'umap' OR ext = 'uasset' OR ext = 'umap')
    GROUP BY classNameCn
    ORDER BY classNameCn
  `)
  return stmt.all() as { className: string; classNameCn: string }[]
}
