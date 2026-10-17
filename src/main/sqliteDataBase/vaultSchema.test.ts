/**
 * 保管库 schema 的守卫。
 *
 * 起因：`models/index.ts` 里有个 `initVaultModels`，看起来就是保管库的建表入口，
 * 实际上**从来没人调用**。给保管库加了新表和新列、改进那个假入口、然后在运行时撞上
 * 「no such table: assetNote」。之后又有过两份建表清单各自漂移：新加的部分索引引用
 * deletedAt，在一份里没问题，在 VaultManager 那份里排在补列之前 —— 新建保管库当场报
 * `no such column: deletedAt`，首次安装连系统库都建不出来，而门禁全绿（以前这里只 grep 源码）。
 *
 * 所以现在：建表 → 补列 → 索引只在 vaultSchema.ts 一处，VaultManager 调它；
 * 这里**真的拿库跑一遍**：空库、没有 deletedAt 的老库都要建得起来。
 *
 * 运行方式: npx vitest run src/main/sqliteDataBase/vaultSchema.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'

// 取消 tests/setup.ts 里对 better-sqlite3 的全局 mock —— 这里要真的执行 SQL
vi.unmock('better-sqlite3')

import Database from 'better-sqlite3'
import {
  applyVaultSchema,
  EXTENSION_NORMALIZED_KEY,
  normalizeStoredExtensions,
  REINDEX_QUEUE_TABLES,
  VAULT_TABLE_DDL
} from './vaultSchema'
import { initAssetDataModel } from './models/assetData'
import { DIRTY_TABLE, initAssetSearchIndexModel } from './models/assetSearchIndex'

const source = readFileSync('src/main/sqliteDataBase/VaultManager.ts', 'utf8')

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)

const indexesOf = (db: Database.Database): string[] =>
  (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'assetData'`)
      .all() as { name: string }[]
  ).map((r) => r.name)

/**
 * 老保管库：表是早年那份 CREATE TABLE 建的，后加的列（deletedAt、note、noteId、tags、color）
 * 一个都没有，还挂着老的 isDelete 单列索引。
 */
function createOldVaultDb(): Database.Database {
  const db = new Database(':memory:')
  for (const sql of VAULT_TABLE_DDL) db.exec(sql)
  db.exec(`
    CREATE INDEX idx_assetData_isDelete ON assetData(isDelete);
    INSERT INTO assetFolder (folderKey, type, folderName) VALUES ('f1', 'folder', 'f1');
    INSERT INTO assetData (assetKey, folderKey, assetName) VALUES ('a1', 'f1', 'a1');
  `)
  expect(columnsOf(db, 'assetData')).not.toContain('deletedAt')
  return db
}

describe('保管库 schema：真的建一遍', () => {
  it('空库：建表、补列、索引一次过，有 ALL 根目录', () => {
    const db = new Database(':memory:')
    expect(() => applyVaultSchema(db)).not.toThrow()
    expect(columnsOf(db, 'assetData')).toEqual(
      expect.arrayContaining(['deletedAt', 'note', 'noteId', 'tags', 'color', 'fileMd5'])
    )
    expect(columnsOf(db, 'assetFolder')).toEqual(
      expect.arrayContaining(['deletedAt', 'note', 'noteId', 'color'])
    )
    expect(indexesOf(db)).toEqual(
      expect.arrayContaining(['idx_assetData_deleted', 'idx_assetData_ext'])
    )
    expect(
      db.prepare(`SELECT folderKey FROM assetFolder WHERE folderKey = 'ALL'`).get()
    ).toBeTruthy()
  })

  it('没有 deletedAt 的老库：先补列再建索引，老数据还在，isDelete 单列索引被删掉', () => {
    const db = createOldVaultDb()
    expect(() => applyVaultSchema(db)).not.toThrow()
    expect(columnsOf(db, 'assetData')).toContain('deletedAt')
    expect(columnsOf(db, 'assetFolder')).toContain('deletedAt')
    expect(indexesOf(db)).toContain('idx_assetData_deleted')
    expect(indexesOf(db)).not.toContain('idx_assetData_isDelete')
    expect(db.prepare(`SELECT assetKey FROM assetData`).all()).toEqual([{ assetKey: 'a1' }])
  })

  it('跑两遍不出错（每次打开保管库都会跑）', () => {
    const db = new Database(':memory:')
    applyVaultSchema(db)
    expect(() => applyVaultSchema(db)).not.toThrow()
  })

  it('initAssetDataModel 和 VaultManager 用同一份 assetData 索引清单', () => {
    const viaSchema = new Database(':memory:')
    applyVaultSchema(viaSchema)
    const viaModel = new Database(':memory:')
    viaModel.exec(`CREATE TABLE assetFolder (folderKey TEXT PRIMARY KEY)`)
    initAssetDataModel(viaModel)
    expect(indexesOf(viaModel).sort()).toEqual(indexesOf(viaSchema).sort())
  })

  it('VaultManager 真的走 applyVaultSchema，assetNote 也由它建', () => {
    expect(source).toContain('applyVaultSchema(vaultDb)')
    expect(source).toContain('initAssetNoteModel(vaultDb)')
  })
})

/**
 * 旧 asset-server-standalone 存的扩展名带点（'.wav'），以前同步原样抄进本地库，
 * 类型下拉、统计分桶、详情面板（都按 'wav' / 'uasset' 比）就对不上。这里钉住一次性迁移。
 */
describe('一次性迁移：扩展名去点', () => {
  function vaultWithRows(): Database.Database {
    const db = new Database(':memory:')
    applyVaultSchema(db)
    initAssetSearchIndexModel(db)
    const insert = db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, ext, fileExtension, updated_at)
       VALUES (?, 'ALL', ?, ?, ?, '2020-01-01 00:00:00')`
    )
    insert.run('a1', 'a1', '.wav', '.wav')
    insert.run('a2', 'a2', 'uasset', 'uasset')
    insert.run('a3', 'a3', '.UASSET', null)
    insert.run('a4', 'a4', null, null)
    insert.run('a5', 'a5', '.png', '.png')
    // 插入时触发器排的队清掉；a5 本来就在等重建（比如刚改过名），迁移不能把它踢出去
    db.exec(`DELETE FROM ${DIRTY_TABLE}`)
    db.prepare(
      `INSERT INTO ${DIRTY_TABLE}(assetId) SELECT id FROM assetData WHERE assetKey = 'a5'`
    ).run()
    return db
  }

  const rows = (db: Database.Database): unknown[] =>
    db
      .prepare(`SELECT assetKey, ext, fileExtension, updated_at FROM assetData ORDER BY assetKey`)
      .all()

  it('分块改成小写不带点，不刷 updated_at，不把改过的行排进索引重建', async () => {
    const db = vaultWithRows()
    let yields = 0
    const fixed = await normalizeStoredExtensions(db, {
      chunkRows: 2,
      yieldFn: async () => {
        yields += 1
      }
    })

    expect(fixed).toBe(3)
    // 5 行、每块 2 行 → 3 块，块间都让出过
    expect(yields).toBe(3)
    const stamp = '2020-01-01 00:00:00'
    expect(rows(db)).toEqual([
      { assetKey: 'a1', ext: 'wav', fileExtension: 'wav', updated_at: stamp },
      { assetKey: 'a2', ext: 'uasset', fileExtension: 'uasset', updated_at: stamp },
      { assetKey: 'a3', ext: 'uasset', fileExtension: null, updated_at: stamp },
      { assetKey: 'a4', ext: null, fileExtension: null, updated_at: stamp },
      { assetKey: 'a5', ext: 'png', fileExtension: 'png', updated_at: stamp }
    ])
    const queued = db
      .prepare(`SELECT a.assetKey FROM ${DIRTY_TABLE} d JOIN assetData a ON a.id = d.assetId`)
      .pluck()
      .all()
    expect(queued).toEqual(['a5'])
    // 读的地方按不带点比，现在对得上了
    expect(db.prepare(`SELECT COUNT(*) FROM assetData WHERE ext = 'uasset'`).pluck().get()).toBe(2)
  })

  it('每个库只跑一次', async () => {
    const db = vaultWithRows()
    await normalizeStoredExtensions(db)
    expect(
      db
        .prepare(`SELECT value FROM vault_metadata WHERE key = ?`)
        .pluck()
        .get(EXTENSION_NORMALIZED_KEY)
    ).toBe('3')
    db.prepare(`UPDATE assetData SET ext = '.wav' WHERE assetKey = 'a2'`).run()
    expect(await normalizeStoredExtensions(db)).toBeNull()
    expect(db.prepare(`SELECT ext FROM assetData WHERE assetKey = 'a2'`).pluck().get()).toBe('.wav')
  })

  it('中途被停掉不记完成，下次打开接着改', async () => {
    const db = vaultWithRows()
    let calls = 0
    const stopped = await normalizeStoredExtensions(db, {
      chunkRows: 2,
      shouldStop: () => (calls += 1) > 1,
      yieldFn: async () => {}
    })
    expect(stopped).toBeNull()
    expect(
      db.prepare(`SELECT 1 FROM vault_metadata WHERE key = ?`).get(EXTENSION_NORMALIZED_KEY)
    ).toBeUndefined()
    // 第一块（a1、a2）已改，剩下的下次补
    expect(await normalizeStoredExtensions(db)).toBe(2)
  })

  it('重建队列表名和索引模块一致；VaultManager 在后台跑它', () => {
    const vectorSource = readFileSync('src/main/sqliteDataBase/models/assetVectorIndex.ts', 'utf8')
    expect(REINDEX_QUEUE_TABLES).toContain(DIRTY_TABLE)
    for (const name of REINDEX_QUEUE_TABLES.filter((n) => n !== DIRTY_TABLE)) {
      expect(vectorSource).toContain(`VECTOR_DIRTY_TABLE = '${name}'`)
    }
    expect(source).toContain('normalizeStoredExtensions(vaultDb)')
  })
})

/**
 * 上面那条只保证「列会被补上」。这条保证「万一没补上也别把整个库拖下水」：
 * 同步用的列一律先和真实表结构取交集（SyncClient.resolveSyncColumns 就是干这个的），
 * 不许再有哪句 SQL 绕过它硬写某个列名。
 */
describe('同步语句不许假设某个列一定存在', () => {
  const syncClient = readFileSync('src/main/networkV2/SyncClient.ts', 'utf8')

  it('软删除语句按真实列拼，不是写死 deletedAt', () => {
    const prepareBody = syncClient.slice(
      syncClient.indexOf('private prepareStatements()'),
      syncClient.indexOf('private prepareStatements()') + 2000
    )
    expect(prepareBody).not.toMatch(/SET isDelete = 1, deletedAt =/)
  })
})

describe('那个会误导人的假入口已经删掉', () => {
  const modelsIndex = readFileSync('src/main/sqliteDataBase/models/index.ts', 'utf8')

  it('models/index.ts 里不再有 initVaultModels', () => {
    // 留着它，下一个加字段的人还会掉进同一个坑
    expect(modelsIndex).not.toMatch(/export const initVaultModels/)
  })

  it('但留了一段说明，指向真正该改的地方', () => {
    expect(modelsIndex).toContain('VaultManager.initializeVaultDatabase()')
  })
})
