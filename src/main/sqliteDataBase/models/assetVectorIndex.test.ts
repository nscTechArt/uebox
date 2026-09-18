/**
 * @vitest-environment node
 *
 * 语义索引的开关和「资产卡」拼装。
 *
 * 向量检索本身要 sqlite-vec 原生扩展，在测试环境里未必加载得上 ——
 * 所以这里测的是**不依赖扩展也必须成立**的那几条：
 * 卡片里该有的信息一样不少、关掉之后不留痕迹、扩展没有时如实报错而不是假装开了。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 测试里不加载原生扩展。默认返回 false，正好用来验证「建不起来要说出来」；
 * 单个用例可以把它翻成 true，验证状态跟着变。
 */
const vecAvailable = { value: false }
vi.mock('../sqliteVec', () => ({
  ensureSqliteVecLoaded: () => vecAvailable.value
}))

import { initAssetFolderModel } from './assetFolder'
import { initAssetDataModel } from './assetData'
import { initAssetTagModel } from './assetTag'
import {
  disableAssetVectorIndex,
  enableAssetVectorIndex,
  getAssetVectorStatus,
  isAssetVectorEnabled,
  takePendingVectorAssets,
  VECTOR_DIRTY_TABLE
} from './assetVectorIndex'

let db: Database.Database
let publicDb: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  initAssetTagModel(db)
  db.exec(`CREATE TABLE IF NOT EXISTS vault_metadata (
    key TEXT PRIMARY KEY, value TEXT, type TEXT DEFAULT 'string',
    created_at TEXT, updated_at TEXT)`)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES ('k_all', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
  ).run()

  publicDb = new Database(':memory:')
  publicDb.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT)')
  vecAvailable.value = false
})

function insertAsset(key: string, name: string, note?: string): void {
  db.prepare(
    `INSERT INTO assetData (assetKey, folderKey, assetName, folderName, assetType, classNameCn, note, softPath, isDelete)
     VALUES (?, 'k_all', ?, '家具', 'StaticMesh', '静态网格体', ?, '/Game/Props/' || ?, 0)`
  ).run(key, name, note ?? null, name)
}

describe('语义索引开关', () => {
  it('sqlite-vec 加载不上时如实报错，不假装开了', () => {
    const result = enableAssetVectorIndex(db, 1024)

    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('sqlite-vec')
    expect(isAssetVectorEnabled(db)).toBe(false)
  })

  it('维度不合法直接拒绝 —— vec0 建表时就把维度写死了，猜错会静默失败', () => {
    expect(enableAssetVectorIndex(db, 0).ok).toBe(false)
    expect(enableAssetVectorIndex(db, -1).ok).toBe(false)
    expect(enableAssetVectorIndex(db, Number.NaN).ok).toBe(false)
  })

  it('没开的时候状态里 enabled 是 false，但资产总数照样报得出来', () => {
    insertAsset('a1', 'SM_Chair_Wood')

    const status = getAssetVectorStatus(db)

    expect(status.enabled).toBe(false)
    expect(status.available).toBe(false)
    expect(status.total).toBe(1)
  })

  /**
   * available 问的是「这条连接**能不能**用 sqlite-vec」，不是「有没有人加载过它」。
   *
   * 原来这里查的是 isSqliteVecLoaded —— 一个只记录「谁调用过 loadSqliteVec」的
   * WeakSet。而扩展此前只在公共库那条连接上加载过，保管库是另一条连接，
   * 于是 available 恒为 false：界面上永远显示「扩展没能加载」，
   * 开关还因为 available === false 被禁用，用户连打开都打不开。
   */
  it('从没被加载过的连接，只要现在能加载就算可用', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    vecAvailable.value = true

    expect(getAssetVectorStatus(db).available).toBe(true)
  })

  it('关闭时把队列和触发器清干净，不留半吊子状态', () => {
    // 手动摆出「开着」的样子（扩展在测试里加载不上，走不到 enable 的成功分支）
    db.exec(`CREATE TABLE ${VECTOR_DIRTY_TABLE} (assetId INTEGER PRIMARY KEY)`)
    db.exec(`CREATE TRIGGER assetData_vec_insert AFTER INSERT ON assetData BEGIN
      INSERT OR REPLACE INTO ${VECTOR_DIRTY_TABLE}(assetId) VALUES (new.id); END`)
    expect(isAssetVectorEnabled(db)).toBe(true)

    disableAssetVectorIndex(db)

    expect(isAssetVectorEnabled(db)).toBe(false)
    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_vec_%'`)
      .all()
    expect(triggers).toEqual([])
  })
})

describe('资产卡', () => {
  beforeEach(() => {
    db.exec(`CREATE TABLE ${VECTOR_DIRTY_TABLE} (assetId INTEGER PRIMARY KEY)`)
  })

  function queueAll(): void {
    db.exec(`INSERT OR REPLACE INTO ${VECTOR_DIRTY_TABLE}(assetId) SELECT id FROM assetData`)
  }

  it('名字、类型、文件夹、标签、备注、路径都进卡片', () => {
    insertAsset('a1', 'SM_Chair_Wood', '客厅那套里的')
    publicDb.prepare('INSERT INTO tags (id, name) VALUES (7, ?)').run('木质')
    db.prepare('INSERT INTO asset_tags (assetKey, tagId) VALUES (?, ?)').run('a1', 7)
    queueAll()

    const [card] = takePendingVectorAssets(db, publicDb, 10)

    expect(card.gone).toBe(false)
    for (const piece of ['SM_Chair_Wood', '静态网格体', '家具', '木质', '客厅那套里的']) {
      expect(card.card).toContain(piece)
    }
  })

  /**
   * 单看 SM_Chair_Wood 几乎没有语义可言 —— 「木头椅子」对得上它，
   * 靠的是卡片里那句「文件夹 家具、标签 木质」。所以标签必须进卡片。
   */
  it('没给公共库时卡片里就没有标签，但不会因此报错', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    db.prepare('INSERT INTO asset_tags (assetKey, tagId) VALUES (?, ?)').run('a1', 7)
    queueAll()

    const [card] = takePendingVectorAssets(db, undefined, 10)

    expect(card.card).toContain('SM_Chair_Wood')
    expect(card.card).not.toContain('标签')
  })

  it('已经删掉的资产标成 gone，不用花钱去算它', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    queueAll()
    db.prepare('UPDATE assetData SET isDelete = 1 WHERE assetKey = ?').run('a1')

    const [card] = takePendingVectorAssets(db, publicDb, 10)

    expect(card.gone).toBe(true)
    expect(card.card).toBe('')
  })

  it('队列里的行整个不见了也不炸', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    queueAll()
    db.prepare('DELETE FROM assetData WHERE assetKey = ?').run('a1')

    const [card] = takePendingVectorAssets(db, publicDb, 10)

    expect(card.gone).toBe(true)
  })

  it('budget 限制一次取多少', () => {
    for (let i = 0; i < 10; i += 1) insertAsset(`a${i}`, `SM_${i}`)
    queueAll()

    expect(takePendingVectorAssets(db, publicDb, 3)).toHaveLength(3)
  })
})
