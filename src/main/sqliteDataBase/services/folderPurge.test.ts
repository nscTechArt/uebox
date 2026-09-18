/**
 * folderPurge.test.ts — 文件夹清除（清空回收站 / 彻底删除）
 *
 * 第一条用例是**数据丢失复现**：它同时跑「今天的实现」和「新实现」，
 * 断言前者会连坐删掉用户已恢复的活跃资产、后者不会。
 */
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { initAssetDataModel } from '../models/assetData'
import { initAssetFolderModel } from '../models/assetFolder'
import {
  applyFolderPurgePlan,
  buildFolderPurgePlan,
  collectAllDeletedFolderKeys,
  collectDeletedSubtreeKeys
} from './folderPurge'

let db: Database.Database

function createTestDb(): Database.Database {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  initAssetFolderModel(database)
  initAssetDataModel(database)
  // 二次调用触发 ALTER TABLE 迁移，补齐 note/tags/color 等列
  initAssetDataModel(database)

  database.exec(`
    CREATE TABLE IF NOT EXISTS asset_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assetKey TEXT NOT NULL,
      itemType TEXT DEFAULT 'asset',
      userId INTEGER,
      vaultId TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(assetKey, itemType, userId, vaultId)
    );
    CREATE TABLE IF NOT EXISTS asset_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assetKey TEXT NOT NULL,
      tagId INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(assetKey, tagId)
    );
    CREATE TABLE IF NOT EXISTS folder_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folderKey TEXT NOT NULL,
      tagId INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(folderKey, tagId)
    );
  `)

  database
    .prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
    )
    .run()
  return database
}

function addFolder(folderKey: string, fatherKey: string | null, isDelete: number, depth = 1): void {
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES (?, ?, 'folder', ?, ?, '[]', ?, '[]', ?)`
  ).run(folderKey, fatherKey, folderKey, `/${folderKey}`, depth, isDelete)
}

function addAsset(
  assetKey: string,
  folderKey: string,
  isDelete: number,
  filePath = `/vault/assetData/${assetKey}.uasset`
): void {
  // customPoster 和 imgLocalPath 是两个独立的缩略图文件，清理清单必须都带上
  db.prepare(
    `INSERT INTO assetData (assetKey, folderKey, assetName, filePath, imgLocalPath, customPoster, isDelete)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    assetKey,
    folderKey,
    assetKey,
    filePath,
    `thumbnail-${assetKey}.png`,
    `custom-${assetKey}.png`,
    isDelete
  )
}

const folderRow = (folderKey: string): { fatherKey: string | null; depth: number } | undefined =>
  db.prepare(`SELECT fatherKey, depth FROM assetFolder WHERE folderKey = ?`).get(folderKey) as
    | { fatherKey: string | null; depth: number }
    | undefined

const assetRow = (assetKey: string): { folderKey: string; isDelete: number } | undefined =>
  db.prepare(`SELECT folderKey, isDelete FROM assetData WHERE assetKey = ?`).get(assetKey) as
    | { folderKey: string; isDelete: number }
    | undefined

const purgeAll = (): ReturnType<typeof applyFolderPurgePlan> => {
  const keys = collectAllDeletedFolderKeys(db)
  const plan = buildFolderPurgePlan(db, keys)
  return applyFolderPurgePlan(db, plan)
}

beforeEach(() => {
  db = createTestDb()
})

describe('数据丢失复现', () => {
  /**
   * 场景：用户删除文件夹 parent（连同子文件夹 child、资产一起进回收站），
   * 随后在回收站里单独「恢复」了 child 及里面的资产。
   * 此时点「清空回收站文件夹」—— 旧实现会把刚恢复的东西一起干掉。
   */
  const buildRestoredScenario = (): void => {
    addFolder('parent', 'ALL', 1)
    addFolder('child', 'parent', 0, 2) // 用户单独恢复了 child
    addAsset('assetActive', 'child', 0) // 以及里面的资产
    addAsset('assetDeleted', 'parent', 1)
  }

  it('旧实现：一句 DELETE 靠级联，把已恢复的资产和子文件夹一起删掉', () => {
    buildRestoredScenario()

    db.prepare(`DELETE FROM assetFolder WHERE isDelete = 1`).run()

    // 级联连坐：child 和 assetActive 明明是活的，却消失了
    expect(folderRow('child')).toBeUndefined()
    expect(assetRow('assetActive')).toBeUndefined()
  })

  it('新实现：已恢复的资产和子文件夹被保留，改挂到最近的存活祖先', () => {
    buildRestoredScenario()

    const result = purgeAll()

    // child 活下来，并挂到了 ALL（parent 被清除了）
    expect(folderRow('child')?.fatherKey).toBe('ALL')
    // 资产还在 child 里，且仍是活跃状态
    expect(assetRow('assetActive')).toEqual({ folderKey: 'child', isDelete: 0 })
    // 该删的删掉了
    expect(assetRow('assetDeleted')).toBeUndefined()
    expect(folderRow('parent')).toBeUndefined()
    expect(result.reparentedFolders).toBe(1)
    expect(result.deletedAssets).toBe(1)
  })
})

describe('改挂目标的选取', () => {
  it('挂到最近的存活祖先，而不是一律扔进 ALL', () => {
    addFolder('A', 'ALL', 0)
    addFolder('B', 'A', 1, 2)
    addFolder('C', 'B', 1, 3)
    addFolder('D', 'C', 0, 4)

    purgeAll()

    expect(folderRow('D')?.fatherKey).toBe('A')
  })

  it('整条链路都被清除时兜底到 ALL', () => {
    addFolder('A', 'ALL', 1)
    addFolder('B', 'A', 1, 2)
    addFolder('C', 'B', 0, 3)

    purgeAll()

    expect(folderRow('C')?.fatherKey).toBe('ALL')
  })

  it('跳过仍在回收站里的祖先，不把恢复出来的东西又藏回去', () => {
    addFolder('A', 'ALL', 0)
    addFolder('B', 'A', 1, 2) // 仍在回收站，但不在本次清除集合里
    addFolder('C', 'B', 1, 3)
    addFolder('D', 'C', 0, 4)

    // 只清除 C
    const plan = buildFolderPurgePlan(db, ['C'])
    applyFolderPurgePlan(db, plan)

    expect(folderRow('D')?.fatherKey).toBe('A')
  })

  it('改挂后重算路径字段', () => {
    addFolder('A', 'ALL', 0)
    addFolder('B', 'A', 1, 2)
    addFolder('D', 'B', 0, 3)

    purgeAll()

    const d = folderRow('D')
    expect(d?.fatherKey).toBe('A')
    // depth 由 updateFolderPathsRecursively 按新父级重算：A 在 depth 1，D 应为 2
    expect(d?.depth).toBe(2)
  })

  it('父子文件夹同时在清除集合里也不出错', () => {
    addFolder('P', 'ALL', 1)
    addFolder('C', 'P', 1, 2)

    expect(() => purgeAll()).not.toThrow()
    expect(folderRow('P')).toBeUndefined()
    expect(folderRow('C')).toBeUndefined()
  })

  it('父子环不会死循环', () => {
    addFolder('X', 'ALL', 1)
    addFolder('Y', 'X', 1, 2)
    // 人为造环
    db.prepare(`UPDATE assetFolder SET fatherKey = 'Y' WHERE folderKey = 'X'`).run()
    addAsset('orphan', 'X', 0)

    const plan = buildFolderPurgePlan(db, ['X', 'Y'])
    applyFolderPurgePlan(db, plan)

    expect(assetRow('orphan')?.folderKey).toBe('ALL')
  })

  it('子树收集遇到环也要收敛 —— 它跑在同步事务里，转不出来就是主进程冻死', () => {
    addFolder('X', 'ALL', 1)
    addFolder('Y', 'X', 1, 2)
    db.prepare(`UPDATE assetFolder SET fatherKey = 'Y' WHERE folderKey = 'X'`).run()

    // 旧实现用 UNION ALL，递归永不终止（挂死而不是报错）
    const keys = collectDeletedSubtreeKeys(db, 'X')

    expect([...keys].sort()).toEqual(['X', 'Y'])
  })
})

describe('连接表与文件清理', () => {
  it('清掉被删记录的关联行，幸存者的原封不动', () => {
    addFolder('parent', 'ALL', 1)
    addFolder('child', 'parent', 0, 2)
    addAsset('gone', 'parent', 1)
    addAsset('kept', 'child', 0)

    db.prepare(`INSERT INTO asset_tags (assetKey, tagId) VALUES ('gone', 1), ('kept', 1)`).run()
    db.prepare(
      `INSERT INTO asset_favorites (assetKey, itemType) VALUES ('gone', 'asset'), ('kept', 'asset'), ('parent', 'folder')`
    ).run()
    db.prepare(
      `INSERT INTO folder_tags (folderKey, tagId) VALUES ('parent', 1), ('child', 1)`
    ).run()

    purgeAll()

    const tagKeys = (
      db.prepare(`SELECT assetKey FROM asset_tags`).all() as { assetKey: string }[]
    ).map((r) => r.assetKey)
    expect(tagKeys).toEqual(['kept'])

    const favKeys = (
      db.prepare(`SELECT assetKey FROM asset_favorites`).all() as { assetKey: string }[]
    ).map((r) => r.assetKey)
    expect(favKeys).toEqual(['kept'])

    const folderTagKeys = (
      db.prepare(`SELECT folderKey FROM folder_tags`).all() as { folderKey: string }[]
    ).map((r) => r.folderKey)
    expect(folderTagKeys).toEqual(['child'])
  })

  it('待删文件清单只含被物理删除的资产', () => {
    addFolder('parent', 'ALL', 1)
    addAsset('gone', 'parent', 1, '/vault/assetData/gone.uasset')
    addAsset('kept', 'parent', 0, '/vault/assetData/kept.uasset')

    const plan = buildFolderPurgePlan(db, collectAllDeletedFolderKeys(db))

    expect(plan.files).toHaveLength(1)
    expect(plan.files[0].filePath).toBe('/vault/assetData/gone.uasset')
  })

  it('buildFolderPurgePlan 是纯读，不写库', () => {
    addFolder('parent', 'ALL', 1)
    addFolder('child', 'parent', 0, 2)
    addAsset('gone', 'parent', 1)

    const snapshot = JSON.stringify({
      folders: db.prepare(`SELECT * FROM assetFolder ORDER BY folderKey`).all(),
      assets: db.prepare(`SELECT * FROM assetData ORDER BY assetKey`).all()
    })

    buildFolderPurgePlan(db, collectAllDeletedFolderKeys(db))

    const after = JSON.stringify({
      folders: db.prepare(`SELECT * FROM assetFolder ORDER BY folderKey`).all(),
      assets: db.prepare(`SELECT * FROM assetData ORDER BY assetKey`).all()
    })
    expect(after).toBe(snapshot)
  })
})

/**
 * 同一个文件导入两遍 = 两条记录、两个 assetKey，但 filePath 是同一个。
 * 清掉子树里那条不代表文件没人用了 —— 照着 filePath 直接 unlink，
 * 还活着的那条当场指向一个不存在的文件。
 */
describe('共用同一个文件的重复登记', () => {
  const SHARED = '/vault/assetData/shared.uasset'
  const LONELY = '/vault/assetData/lonely.uasset'

  /** files 里认某一条：顺序由 SQL 决定，别按下标取 */
  const fileFor = (
    plan: ReturnType<typeof buildFolderPurgePlan>,
    assetKey: string
  ):
    | { filePath?: string | null; imgLocalPath?: string | null; customPoster?: string | null }
    | undefined => plan.files.find((file) => file.imgLocalPath === `thumbnail-${assetKey}.png`)

  it('库里别处还有活记录指着同一个文件时，不把这个文件放进清理清单', () => {
    addFolder('parent', 'ALL', 1)
    addFolder('live', 'ALL', 0)
    addAsset('trashedTwin', 'parent', 1, SHARED)
    addAsset('keep', 'live', 0, SHARED) // 幸存的那条重复登记
    addAsset('trashedOnly', 'parent', 1, LONELY)

    const plan = buildFolderPurgePlan(db, collectAllDeletedFolderKeys(db))

    // 文件留给幸存者；缩略图各是各的，照删
    expect(fileFor(plan, 'trashedTwin')).toEqual({
      filePath: null,
      imgLocalPath: 'thumbnail-trashedTwin.png',
      customPoster: 'custom-trashedTwin.png'
    })
    // 没人占的照常清
    expect(fileFor(plan, 'trashedOnly')).toEqual({
      filePath: LONELY,
      imgLocalPath: 'thumbnail-trashedOnly.png',
      customPoster: 'custom-trashedOnly.png'
    })
    // 数据库行照删，两条都在待删名单里
    expect([...plan.assetKeys].sort()).toEqual(['trashedOnly', 'trashedTwin'])

    applyFolderPurgePlan(db, plan)
    expect(assetRow('trashedTwin')).toBeUndefined()
    expect(assetRow('keep')).toEqual({ folderKey: 'live', isDelete: 0 })
  })

  it('同一子树里等着改挂的幸存资产同样算占用者', () => {
    addFolder('parent', 'ALL', 1)
    addAsset('trashed', 'parent', 1, SHARED)
    addAsset('survivor', 'parent', 0, SHARED) // 会被改挂到 ALL，文件一个都不能动

    const plan = buildFolderPurgePlan(db, collectAllDeletedFolderKeys(db))

    expect(fileFor(plan, 'trashed')?.filePath).toBeNull()
    expect(plan.reparentAssets).toEqual([{ assetKey: 'survivor', newFolderKey: 'ALL' }])

    applyFolderPurgePlan(db, plan)
    expect(assetRow('survivor')).toEqual({ folderKey: 'ALL', isDelete: 0 })
  })

  it('局部清除不能删掉另一棵回收站子树仍引用的文件', () => {
    addFolder('purged', 'ALL', 1)
    addFolder('retained', 'ALL', 1)
    addAsset('gone', 'purged', 1, SHARED)
    addAsset('recoverable', 'retained', 1, SHARED)

    const plan = buildFolderPurgePlan(db, collectDeletedSubtreeKeys(db, 'purged'))
    expect(fileFor(plan, 'gone')?.filePath).toBeNull()
    applyFolderPurgePlan(db, plan)
    expect(assetRow('recoverable')).toEqual({ folderKey: 'retained', isDelete: 1 })

    const finalPlan = buildFolderPurgePlan(db, collectDeletedSubtreeKeys(db, 'retained'))
    expect(fileFor(finalPlan, 'recoverable')?.filePath).toBe(SHARED)
  })

  it('回收站里的重复登记互相不算占用，一起清掉时文件该真被删', () => {
    addFolder('parent', 'ALL', 1)
    addAsset('trashedA', 'parent', 1, SHARED)
    addAsset('trashedB', 'parent', 1, SHARED)

    const plan = buildFolderPurgePlan(db, collectAllDeletedFolderKeys(db))

    expect(plan.files.every((file) => file.filePath === SHARED)).toBe(true)
  })

  it('占用判断没有把待删的这批算进去 —— 否则文件永远删不掉', () => {
    addFolder('parent', 'ALL', 1)
    addAsset('trashed', 'parent', 1, LONELY)

    const plan = buildFolderPurgePlan(db, collectAllDeletedFolderKeys(db))

    expect(fileFor(plan, 'trashed')?.filePath).toBe(LONELY)
  })

  /**
   * 封面图和素材文件走同一道闸。批量封面上传会把同一个文件名写进一个文件夹的 img
   * 和它下面 N 个资产的 customPoster —— 不判断的话，清掉一个文件夹会把还活着的
   * 资产和别的文件夹的封面一起削成裂图。
   */
  it('别处还活着的记录指着同一张封面时，封面不进清理清单', () => {
    addFolder('parent', 'ALL', 1)
    addFolder('live', 'ALL', 0)
    addAsset('trashed', 'parent', 1, LONELY)
    addAsset('keep', 'live', 0)
    // 两条指着同一张封面（批量封面上传的典型结果）
    db.prepare(
      `UPDATE assetData SET customPoster = 'custom-shared.png' WHERE assetKey IN (?, ?)`
    ).run('trashed', 'keep')

    const plan = buildFolderPurgePlan(db, collectAllDeletedFolderKeys(db))

    expect(fileFor(plan, 'trashed')).toEqual({
      filePath: LONELY,
      imgLocalPath: 'thumbnail-trashed.png',
      customPoster: null
    })
  })

  it('还活着的文件夹用着同一张封面时，也不删', () => {
    addFolder('parent', 'ALL', 1)
    addFolder('live', 'ALL', 0)
    addAsset('trashed', 'parent', 1, LONELY)
    db.prepare(`UPDATE assetFolder SET img = 'custom-trashed.png' WHERE folderKey = 'live'`).run()

    const plan = buildFolderPurgePlan(db, collectAllDeletedFolderKeys(db))

    expect(fileFor(plan, 'trashed')?.customPoster).toBeNull()
  })
})

describe('子树边界与 ALL 保护', () => {
  it('彻底删除只沿 isDelete=1 往下走，遇到已恢复的文件夹就停', () => {
    addFolder('parent', 'ALL', 1)
    addFolder('child', 'parent', 0, 2) // 用户已恢复
    addFolder('grandchild', 'child', 1, 3) // 仍在回收站

    expect(collectDeletedSubtreeKeys(db, 'parent')).toEqual(['parent'])

    const plan = buildFolderPurgePlan(db, collectDeletedSubtreeKeys(db, 'parent'))
    applyFolderPurgePlan(db, plan)

    // child 改挂保留，它下面仍在回收站的孙节点原样留着，等用户单独处理
    expect(folderRow('child')?.fatherKey).toBe('ALL')
    expect(folderRow('grandchild')?.fatherKey).toBe('child')
  })

  it('目标已被恢复时，子树为空', () => {
    addFolder('restored', 'ALL', 0)
    expect(collectDeletedSubtreeKeys(db, 'restored')).toEqual([])
  })

  it('ALL 永远不会被收集或清除', () => {
    db.prepare(`UPDATE assetFolder SET isDelete = 1 WHERE folderKey = 'ALL'`).run()

    expect(collectAllDeletedFolderKeys(db)).not.toContain('ALL')
    expect(collectDeletedSubtreeKeys(db, 'ALL')).toEqual([])
    expect(buildFolderPurgePlan(db, ['ALL']).folderKeys).toEqual([])
  })
})
