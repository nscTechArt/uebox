/**
 * 保管库的表结构 —— **唯一**一份：建表 → 补列 → 建索引，顺序固定。
 *
 * 以前有两份：VaultManager.initializeVaultDatabase 里内联一份，models/assetData.ts 的
 * initAssetDataModel 里一份，两份各自漂移（索引清单早就对不上），改一处忘一处是常态。
 * 最近一次的代价：新加的部分索引引用了 deletedAt，在 models 那份里没问题（建表就有这列），
 * 在 VaultManager 那份里却排在补列之前 —— 新建保管库当场报 `no such column: deletedAt`，
 * 连首次安装的系统库都建不出来。
 *
 * 所以这里只做三件事，而且顺序写死：表（CREATE TABLE IF NOT EXISTS）→ 老库补列（ALTER）
 * → 索引。索引只能引用补完列之后一定存在的列。
 *
 * 纯模块：只依赖 better-sqlite3，不碰 electron —— 单测可以直接拿真库跑一遍。
 */
import type Database from 'better-sqlite3'

/**
 * assetData 的全部索引。VaultManager 和 initAssetDataModel 都从这里取，别再各写一份。
 */
export const ASSET_DATA_INDEX_DDL: readonly string[] = [
  // 不要在 isDelete 上建单列索引（老库里有的这里删掉）。只有 0/1 两个值、绝大多数是 0，
  // 它对「没删的」毫无筛选力，可没有统计信息或统计不准时规划器偏偏会挑它：先把全表按它
  // 取一遍再临时排序，52 万行的库上一页从 0.1 ms 变成好几秒。这个坑以前踩过好几回，
  // 每次都在单条查询上用 INDEXED BY 绕开，见 remoteImportPath.ts、searchAssetDataByExactName。
  'DROP INDEX IF EXISTS idx_assetData_isDelete',
  // 回收站要的是「删掉的那一小撮」，用部分索引：isDelete = 0 的查询根本用不上它
  'CREATE INDEX IF NOT EXISTS idx_assetData_deleted ON assetData(deletedAt) WHERE isDelete = 1',
  // 默认视图就是「全部资产按修改时间倒序」。没有它每一页都要把全表读一遍再排
  // （54 万行热缓存 0.15 s、冷缓存 2 s 以上）；有它沿索引取前 50 条，0 ms。
  // 窄筛选（大小、关键词、收藏……）沿它走反而更慢，那些查询不让规划器用它，
  // 见 assetSearchCore 的 narrowUnindexed
  'CREATE INDEX IF NOT EXISTS idx_assetData_updated_at_name ON assetData(updated_at, assetName COLLATE NOCASE)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_folderKey ON assetData(folderKey)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_folderKey_isDelete_assetName ON assetData(folderKey, isDelete, assetName COLLATE NOCASE)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_fileExtension ON assetData(fileExtension)',
  // 按扩展名筛选是 fileExtension IN (..) OR ext IN (..)：OR 的两边都得有索引，
  // SQLite 才会分别走索引再取并集；少一边整条退化成全表扫（52 万行点「音频」卡死）
  'CREATE INDEX IF NOT EXISTS idx_assetData_ext ON assetData(ext)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_assetType ON assetData(assetType)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_processorType ON assetData(processorType)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_softPath ON assetData(softPath)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_assetClass ON assetData(assetClass)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_className ON assetData(className)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_classNameCn ON assetData(classNameCn)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_fileMd5 ON assetData(fileMd5)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_filePath ON assetData(filePath)',
  // 远端导入按路径查重（remoteImportPath.ts）用的复合索引。单列 filePath 索引
  // 不够：那条查询同时按 originPath 查，缺一侧索引整条就退化成全表扫。
  'CREATE INDEX IF NOT EXISTS idx_assetData_filePath_isDelete ON assetData(filePath, isDelete)',
  'CREATE INDEX IF NOT EXISTS idx_assetData_originPath_isDelete ON assetData(originPath, isDelete)',
  // 名称等值 / 排序（Spotlight、工程导入按名找依赖）
  'CREATE INDEX IF NOT EXISTS idx_assetData_assetName ON assetData(assetName COLLATE NOCASE)',
  // 缩略图占用判断（vaultThumbnailRefs）与媒体读取权限（thumbnails.ts）按文件名等值查。
  // 部分索引：绝大多数行这两列为空，全列索引白占空间；等值条件蕴含 IS NOT NULL，规划器能用。
  //
  // 谓词只能写到 IS NOT NULL 为止，别加 "AND col != 空串"。SQLite 判定部分索引可用，
  // 要求查询条件蕴含谓词的**每一个** AND 分支："col = ?" 能蕴含 IS NOT NULL，却蕴含不了
  // "col != 空串"（? 的值在 prepare 时未知）。实测加了之后计划从
  // "SEARCH ... USING INDEX (imgLocalPath=?)" 退化成 "SCAN assetData"。
  'CREATE INDEX IF NOT EXISTS idx_assetData_imgLocalPath_present ON assetData(imgLocalPath) WHERE imgLocalPath IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_assetData_customPoster_present ON assetData(customPoster) WHERE customPoster IS NOT NULL',
  // 筛选下拉的类型聚合（getDistinctAssetTypes）只读索引不回表：52 万行从 7.9 s 降到 0.3 s
  'CREATE INDEX IF NOT EXISTS idx_assetData_types_cover ON assetData(classNameCn, isDelete, fileExtension, ext, className)'
]

const OTHER_INDEX_DDL: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_assetFolder_fatherKey ON assetFolder(fatherKey)',
  'CREATE INDEX IF NOT EXISTS idx_assetFolder_depth ON assetFolder(depth)',
  'CREATE INDEX IF NOT EXISTS idx_assetFolder_fullPath ON assetFolder(fullPath)',
  'CREATE INDEX IF NOT EXISTS idx_assetFolder_isDelete ON assetFolder(isDelete)',
  'CREATE INDEX IF NOT EXISTS idx_asset_favorites_assetKey ON asset_favorites(assetKey)',
  'CREATE INDEX IF NOT EXISTS idx_asset_favorites_itemType ON asset_favorites(itemType)',
  'CREATE INDEX IF NOT EXISTS idx_asset_favorites_userId ON asset_favorites(userId)',
  'CREATE INDEX IF NOT EXISTS idx_asset_favorites_vaultId ON asset_favorites(vaultId)',
  'CREATE INDEX IF NOT EXISTS idx_asset_tags_assetKey ON asset_tags(assetKey)',
  'CREATE INDEX IF NOT EXISTS idx_asset_tags_tagId ON asset_tags(tagId)',
  'CREATE INDEX IF NOT EXISTS idx_folder_tags_folderKey ON folder_tags(folderKey)',
  'CREATE INDEX IF NOT EXISTS idx_folder_tags_tagId ON folder_tags(tagId)'
]

/** 建表语句（不含后加的列 —— 那些走 ASSET_DATA_COLUMN_MIGRATIONS 补）。导出给单测造老库用 */
export const VAULT_TABLE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS vault_metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    type TEXT DEFAULT 'string',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS assetFolder (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folderKey TEXT NOT NULL UNIQUE,
    fatherKey TEXT,
    img TEXT,
    type TEXT NOT NULL,
    folderName TEXT NOT NULL,
    fullPath TEXT,
    pathArray TEXT,
    depth INTEGER DEFAULT 0,
    ancestorKeys TEXT,
    isDelete INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (fatherKey) REFERENCES assetFolder(folderKey) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS assetData (
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
    isDependency INTEGER NOT NULL DEFAULT 0,
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
    pluginInfo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (folderKey) REFERENCES assetFolder(folderKey) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS asset_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assetKey TEXT NOT NULL,
    itemType TEXT DEFAULT 'asset',
    userId INTEGER,
    vaultId TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(assetKey, itemType, userId, vaultId)
  )`,
  `CREATE TABLE IF NOT EXISTS asset_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assetKey TEXT NOT NULL,
    tagId INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(assetKey, tagId)
  )`,
  `CREATE TABLE IF NOT EXISTS folder_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folderKey TEXT NOT NULL,
    tagId INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(folderKey, tagId)
  )`
]

/**
 * 老保管库补列。
 *
 * 建表用的是 `CREATE TABLE IF NOT EXISTS` —— 老库的表早就建好了，改建表语句对它们一点
 * 作用都没有，只有这里的 ALTER 补得上。新加列一定要进这两份清单。
 */
export const ASSET_DATA_COLUMN_MIGRATIONS: readonly { name: string; type: string }[] = [
  { name: 'note', type: 'TEXT' },
  // 关联的详细说明（保管库的 assetNote 表）
  { name: 'noteId', type: 'INTEGER' },
  { name: 'isDependency', type: 'INTEGER DEFAULT 0' },
  { name: 'fileMd5', type: 'TEXT' },
  { name: 'pluginInfo', type: 'TEXT' },
  { name: 'tags', type: 'TEXT' },
  { name: 'color', type: 'TEXT' },
  // 进回收站的时刻。少了它，SyncClient 的软删语句 prepare 当场就报错，所有网络库离线
  // （2026-09-17 的事故）；回收站的部分索引也建不起来
  { name: 'deletedAt', type: 'TEXT' }
]

export const ASSET_FOLDER_COLUMN_MIGRATIONS: readonly { name: string; type: string }[] = [
  { name: 'color', type: 'TEXT' },
  // 文件夹也能写备注和详细说明
  { name: 'note', type: 'TEXT' },
  { name: 'noteId', type: 'INTEGER' },
  // 进回收站的时刻（同上，少了它网络库全部离线）
  { name: 'deletedAt', type: 'TEXT' }
]

/** 给一张已存在的表补列。补不上的列只记日志，不挡住保管库打开 */
export function migrateColumns(
  db: Database.Database,
  table: string,
  migrations: readonly { name: string; type: string }[]
): void {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    const existing = new Set(columns.map((col) => col.name))
    for (const col of migrations) {
      if (existing.has(col.name)) continue
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`)
        console.log(`[vaultSchema] 迁移: 添加列 ${col.name} 到 ${table}`)
      } catch (e) {
        console.warn(`[vaultSchema] 添加列 ${col.name} 失败:`, e)
      }
    }
  } catch (e) {
    console.warn(`[vaultSchema] ${table} 列迁移检查失败:`, e)
  }
}

/**
 * 建表 → 补列 → 建索引 → 根目录。新库和老库走同一条路，顺序不许动。
 */
export function applyVaultSchema(db: Database.Database): void {
  for (const sql of VAULT_TABLE_DDL) db.exec(sql)

  migrateColumns(db, 'assetData', ASSET_DATA_COLUMN_MIGRATIONS)
  migrateColumns(db, 'assetFolder', ASSET_FOLDER_COLUMN_MIGRATIONS)

  for (const sql of ASSET_DATA_INDEX_DDL) db.exec(sql)
  for (const sql of OTHER_INDEX_DDL) db.exec(sql)

  db.prepare(
    `INSERT OR IGNORE INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ALL', null, 'system', 'ALL', '/ALL', '["ALL"]', 0, '["ALL"]')
}

// ─────────────────────── 一次性：扩展名去点 ───────────────────────

/** 完成标记，记在 vault_metadata。值是这次改了多少行，只供排查 */
export const EXTENSION_NORMALIZED_KEY = 'migration.extension_no_dot.v1'

/**
 * 全文 / 向量索引的待重建队列（assetSearchIndex.ts 的 DIRTY_TABLE、assetVectorIndex.ts 的
 * VECTOR_DIRTY_TABLE）。assetData 上任何 UPDATE 都会被触发器排进去，可扩展名两个索引都不收 ——
 * 迁移改的行不该因此全库重建一遍（向量开着时还要重新算向量）。
 * 这里写死名字是为了保持本模块只依赖 better-sqlite3，单测核对两边一致
 */
export const REINDEX_QUEUE_TABLES = ['assetSearchDirty', 'assetVectorDirty'] as const

/** 和 SyncClient.normalizeExtensionValue 同一个口径：去掉开头的一个点、转小写 */
const normalizedExt = (col: string): string =>
  `lower(CASE WHEN substr(${col}, 1, 1) = '.' THEN substr(${col}, 2) ELSE ${col} END)`

export interface ExtensionMigrationOptions {
  /** 每块按 rowid 扫多少行。一块一个事务，块间让出事件循环 */
  chunkRows?: number
  /** 返回 true 就停（连接被关）；没跑完不记完成，下次打开从头扫 —— 已改过的行不会再匹配 */
  shouldStop?: () => boolean
  yieldFn?: () => Promise<void>
}

/**
 * 把同步进来的带点扩展名（'.wav'）改成本机的口径（'wav'）。每个库只跑一次。
 *
 * 新写入的行 SyncClient 已经在入口规整了，这里只收拾升级前落库的老行。
 * 54 万行的库不能一句 UPDATE 了事（主线程一口气占好几秒），所以按 rowid 分块：
 * 每块 1000 行、一个事务，块间让出。不刷 updated_at（按修改时间排序会整个乱掉），
 * 也不让触发器把改过的行排进索引重建队列（原本就在队列里的照留）。
 *
 * @returns 改了多少行；已经跑过、被停掉或出错时返回 null
 */
export async function normalizeStoredExtensions(
  db: Database.Database,
  options: ExtensionMigrationOptions = {}
): Promise<number | null> {
  const chunkRows = options.chunkRows ?? 1000
  const shouldStop = options.shouldStop ?? ((): boolean => !db.open)
  const yieldFn =
    options.yieldFn ?? ((): Promise<void> => new Promise((resolve) => setImmediate(resolve)))
  try {
    if (db.prepare(`SELECT 1 FROM vault_metadata WHERE key = ?`).get(EXTENSION_NORMALIZED_KEY)) {
      return null
    }
    const queues = REINDEX_QUEUE_TABLES.filter((name) =>
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)
    )
    const nextBound = db.prepare(
      `SELECT max(id) AS hi FROM (SELECT id FROM assetData WHERE id > ? ORDER BY id LIMIT ?)`
    )
    const pick = db
      .prepare(
        `SELECT id FROM assetData WHERE id > ? AND id <= ?
           AND (ext IS NOT ${normalizedExt('ext')}
                OR fileExtension IS NOT ${normalizedExt('fileExtension')})`
      )
      .pluck()
    const fix = db.prepare(
      `UPDATE assetData
       SET ext = ${normalizedExt('ext')}, fileExtension = ${normalizedExt('fileExtension')}
       WHERE id IN (SELECT value FROM json_each(?))`
    )
    const queued = queues.map((name) =>
      db
        .prepare(`SELECT assetId FROM ${name} WHERE assetId IN (SELECT value FROM json_each(?))`)
        .pluck()
    )
    const unqueue = queues.map((name) =>
      db.prepare(`DELETE FROM ${name} WHERE assetId IN (SELECT value FROM json_each(?))`)
    )

    const runChunk = db.transaction((lo: number, hi: number): number => {
      const ids = pick.all(lo, hi) as number[]
      if (ids.length === 0) return 0
      const json = JSON.stringify(ids)
      const before = queued.map((stmt) => new Set(stmt.all(json) as number[]))
      fix.run(json)
      before.forEach((already, i) => {
        const added = ids.filter((id) => !already.has(id))
        if (added.length > 0) unqueue[i].run(JSON.stringify(added))
      })
      return ids.length
    })

    let cursor = 0
    let fixed = 0
    for (;;) {
      if (shouldStop()) return null
      const hi = (nextBound.get(cursor, chunkRows) as { hi: number | null }).hi
      if (hi === null) break
      fixed += runChunk(cursor, hi)
      cursor = hi
      await yieldFn()
    }
    if (shouldStop()) return null
    db.prepare(
      `INSERT OR REPLACE INTO vault_metadata (key, value, type) VALUES (?, ?, 'number')`
    ).run(EXTENSION_NORMALIZED_KEY, String(fixed))
    if (fixed > 0) console.log(`[vaultSchema] 扩展名去点：改了 ${fixed} 行`)
    return fixed
  } catch (err) {
    console.warn('[vaultSchema] 扩展名去点迁移失败（下次打开再试，不影响使用）:', err)
    return null
  }
}
