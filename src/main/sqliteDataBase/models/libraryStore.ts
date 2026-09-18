/**
 * 蓝图库 / 材质库的本地持久化模型（公共数据库）
 *
 * 这两个库以前整库序列化后写在渲染进程的 localStorage 里。localStorage 只有几 MB，
 * 写满之后 setItem 抛 QuotaExceededError —— 而存盘是二十多个用户操作的最后一步，
 * 于是「库大了就什么都干不了」。搬到 SQLite 之后没有这个上限，而且可以只写变动的行。
 *
 * 放公共数据库而不是保管库数据库：这两个库原本就不随保管库切换，搬家不改变这一点。
 */

import Database from 'better-sqlite3'

/** 哪个库。两个库共用同一张表，靠这一列区分。 */
export type LibraryName = 'blueprint' | 'material'

/** 一行记录是一个条目还是一个分组 */
export type LibraryRecordKind = 'entry' | 'collection'

/** 一条记录：整条对象序列化成 JSON 存在 data 里 */
export interface LibraryStoreRecord {
  kind: LibraryRecordKind
  id: string
  /** 整条记录的 JSON 文本 */
  data: string
  /** 保留内存数组里的原始顺序 */
  sortIndex: number
}

/** 一次读取的完整结果 */
export interface LibraryStoreSnapshot {
  records: LibraryStoreRecord[]
  /** 界面偏好（排序、视图模式、筛选…）的 JSON 文本，从未写过时为 null */
  ui: string | null
  /** 是否已经从 localStorage 迁移过 */
  migratedFromLocal: boolean
}

/** 一次增量写入：只带变动的行 */
export interface LibraryStorePatch {
  upserts?: LibraryStoreRecord[]
  deletes?: Array<{ kind: LibraryRecordKind; id: string }>
  /** 传 undefined 表示界面偏好没变，不要动已存的那份 */
  ui?: string
}

export function initLibraryStoreModel(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_store_record (
      library TEXT NOT NULL,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      sort_index INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (library, kind, id)
    );

    CREATE INDEX IF NOT EXISTS idx_library_store_record_order
      ON library_store_record(library, kind, sort_index);

    CREATE TABLE IF NOT EXISTS library_store_ui (
      library TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      migrated_from_local INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `)
  console.log('[LibraryStore] 表初始化完成')
}

interface RecordRow {
  kind: string
  id: string
  data: string
  sort_index: number
}

interface UiRow {
  data: string
  migrated_from_local: number
}

export function loadLibraryStore(
  db: Database.Database,
  library: LibraryName
): LibraryStoreSnapshot {
  const rows = db
    .prepare(
      `SELECT kind, id, data, sort_index
         FROM library_store_record
        WHERE library = ?
        ORDER BY kind, sort_index, id`
    )
    .all(library) as RecordRow[]

  const uiRow = db
    .prepare('SELECT data, migrated_from_local FROM library_store_ui WHERE library = ?')
    .get(library) as UiRow | undefined

  return {
    records: rows.map((row) => ({
      kind: row.kind as LibraryRecordKind,
      id: row.id,
      data: row.data,
      sortIndex: row.sort_index
    })),
    ui: uiRow ? uiRow.data : null,
    migratedFromLocal: Boolean(uiRow?.migrated_from_local)
  }
}

/**
 * 写入界面偏好，但**不碰**迁移标记 —— 标记只由迁移那一步置位。
 * 用 COALESCE 从已有行取旧值，行不存在时落到 0。
 */
function upsertUi(db: Database.Database, library: LibraryName, ui: string, now: number): void {
  db.prepare(
    `INSERT INTO library_store_ui (library, data, migrated_from_local, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(library) DO UPDATE SET
       data = excluded.data,
       updated_at = excluded.updated_at`
  ).run(library, ui, now)
}

export function applyLibraryStorePatch(
  db: Database.Database,
  library: LibraryName,
  patch: LibraryStorePatch
): void {
  const now = Date.now()
  const upsertRecord = db.prepare(
    `INSERT INTO library_store_record (library, kind, id, data, sort_index, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(library, kind, id) DO UPDATE SET
       data = excluded.data,
       sort_index = excluded.sort_index,
       updated_at = excluded.updated_at`
  )
  const deleteRecord = db.prepare(
    'DELETE FROM library_store_record WHERE library = ? AND kind = ? AND id = ?'
  )

  db.transaction(() => {
    for (const record of patch.upserts || []) {
      upsertRecord.run(library, record.kind, record.id, record.data, record.sortIndex, now)
    }
    for (const target of patch.deletes || []) {
      deleteRecord.run(library, target.kind, target.id)
    }
    if (patch.ui !== undefined) {
      upsertUi(db, library, patch.ui, now)
    }
  })()
}

/**
 * 把 localStorage 里那份旧数据一次性搬进来。
 *
 * 整体在一个事务里：数据和「已迁移」标记要么一起落库，要么都不落。中途崩了下次启动
 * 看到标记还是 0，会原样重来 —— 所以渲染层必须等这里返回 true 之后才删 localStorage。
 *
 * @returns 真正执行了迁移返回 true；已经迁移过返回 false（幂等，重复调用安全）
 */
export function migrateLibraryStoreFromLocal(
  db: Database.Database,
  library: LibraryName,
  payload: { records: LibraryStoreRecord[]; ui: string }
): boolean {
  const now = Date.now()
  const upsertRecord = db.prepare(
    `INSERT INTO library_store_record (library, kind, id, data, sort_index, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(library, kind, id) DO UPDATE SET
       data = excluded.data,
       sort_index = excluded.sort_index,
       updated_at = excluded.updated_at`
  )

  return db.transaction(() => {
    const existing = db
      .prepare('SELECT migrated_from_local FROM library_store_ui WHERE library = ?')
      .get(library) as { migrated_from_local: number } | undefined
    if (existing?.migrated_from_local) return false

    for (const record of payload.records) {
      upsertRecord.run(library, record.kind, record.id, record.data, record.sortIndex, now)
    }
    db.prepare(
      `INSERT INTO library_store_ui (library, data, migrated_from_local, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(library) DO UPDATE SET
         data = excluded.data,
         migrated_from_local = 1,
         updated_at = excluded.updated_at`
    ).run(library, payload.ui, now)
    return true
  })()
}
