import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import {
  createAssetData,
  deleteAssetData,
  getAssetsByKeys,
  getLiveAssetsByFilePath,
  getRetainedFilePaths,
  getSharedLiveFilePaths,
  initAssetDataModel
} from './assetData'
import { createAssetFolder, initAssetFolderModel } from './assetFolder'

/** 建一个能跑 createAssetData 的空库：assetData 上的 folderKey 有外键，文件夹得先在 */
function createSeededDb(): Database.Database {
  const db = new Database(':memory:')
  initAssetDataModel(db)
  initAssetFolderModel(db)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
  ).run()
  createAssetFolder(db, {
    folderKey: 'trees',
    fatherKey: 'ALL',
    type: 'folder',
    folderName: 'Trees'
  })
  return db
}

describe('assetData model', () => {
  it('binds note when creating an asset', () => {
    const run = vi.fn(() => ({ lastInsertRowid: 1 }))
    const prepare = vi.fn(() => ({ run }))
    const db = { prepare } as any

    createAssetData(db, {
      assetKey: 'asset_note_test',
      folderKey: 'AIGC_image',
      assetName: 'test.png',
      note: '一个测试提示词'
    })

    const prepareCalls = prepare.mock.calls as unknown as Array<[string]>
    const runCalls = run.mock.calls as unknown as unknown[][]
    expect(prepareCalls[0][0]).toContain('fileMd5, note, pluginInfo')
    expect(runCalls[0][29]).toBe('一个测试提示词')
  })

  it('creates a composite index for folder browsing queries', () => {
    const db = new Database(':memory:')
    initAssetDataModel(db)

    const index = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_assetData_folderKey_isDelete_assetName'`
      )
      .get() as { name: string } | undefined

    expect(index?.name).toBe('idx_assetData_folderKey_isDelete_assetName')
    db.close()
  })

  /**
   * 同一个文件夹导入两遍会留下两条记录、同一个 filePath。清理重复登记之前
   * 必须查得到这种共用 —— 不然「彻底删除」会把文件删掉，另一条当场指空。
   */
  it('finds the other live rows that share a file path', () => {
    const db = createSeededDb()
    const shared = 'C:/vault/assetData/tree.uasset'
    for (const assetKey of ['dup_1', 'dup_2', 'dup_3']) {
      createAssetData(db, { assetKey, folderKey: 'trees', assetName: 'SM_Tree', filePath: shared })
    }
    createAssetData(db, {
      assetKey: 'other',
      folderKey: 'trees',
      assetName: 'SM_Rock',
      filePath: 'C:/vault/assetData/rock.uasset'
    })

    const twins = getLiveAssetsByFilePath(db, shared, 'dup_1')
    expect(twins.map((t) => t.assetKey).sort()).toEqual(['dup_2', 'dup_3'])

    // 此查询只统计活跃引用；物理清理另用 getRetainedFilePaths 保护可恢复引用。
    deleteAssetData(db, 'dup_2')
    expect(getLiveAssetsByFilePath(db, shared, 'dup_1').map((t) => t.assetKey)).toEqual(['dup_3'])

    expect(getLiveAssetsByFilePath(db, '', 'dup_1')).toEqual([])
    db.close()
  })

  /**
   * 「清空回收站」的批量版：一次问出整批里哪些 filePath 还被活着的记录占着。
   * 占着的那几个不许 unlink，否则幸存记录当场指空。
   */
  it('reports which file paths a live row still holds, in one batch query', () => {
    const db = createSeededDb()
    const shared = 'C:/vault/assetData/tree.uasset'
    const lonely = 'C:/vault/assetData/rock.uasset'

    createAssetData(db, {
      assetKey: 'keep',
      folderKey: 'trees',
      assetName: 'SM_Tree',
      filePath: shared
    })
    createAssetData(db, {
      assetKey: 'trashed_twin',
      folderKey: 'trees',
      assetName: 'SM_Tree (1)',
      filePath: shared
    })
    createAssetData(db, {
      assetKey: 'trashed_only',
      folderKey: 'trees',
      assetName: 'SM_Rock',
      filePath: lonely
    })
    deleteAssetData(db, 'trashed_twin')
    deleteAssetData(db, 'trashed_only')

    // 传的是「待清空的那批」，回来的只有还被 keep 占着的那一个
    const stillUsed = getSharedLiveFilePaths(db, [shared, lonely])
    expect([...stillUsed]).toEqual([shared])

    // keep 也进回收站之后就没人占了 —— 这一轮清空可以把文件真删掉
    deleteAssetData(db, 'keep')
    expect([...getSharedLiveFilePaths(db, [shared, lonely])]).toEqual([])

    // 空值和重复项不该炸，也不该混进结果
    expect([...getSharedLiveFilePaths(db, [])]).toEqual([])
    expect([...getSharedLiveFilePaths(db, [null, undefined, ''])]).toEqual([])
    db.close()
  })

  /**
   * SQLite 一条语句最多绑 999 个变量，超了直接抛
   * "too many SQL variables"。回收站攒到上千条是常事，所以要分批。
   */
  it('chunks the batch query past the SQLite variable limit', () => {
    const db = createSeededDb()
    const paths = Array.from({ length: 1200 }, (_, i) => `C:/vault/assetData/a${i}.uasset`)
    createAssetData(db, {
      assetKey: 'live_1100',
      folderKey: 'trees',
      assetName: 'A1100',
      filePath: paths[1100]
    })

    expect([...getSharedLiveFilePaths(db, paths)]).toEqual([paths[1100]])
    db.close()
  })

  it('retains recycled references outside the exact purge set, including large batches', () => {
    const db = createSeededDb()
    const paths = Array.from({ length: 1200 }, (_, i) => `C:/vault/assetData/${i}.bin`)
    const purgedKeys = Array.from({ length: 1200 }, (_, i) => `purged_${i}`)
    for (const assetKey of ['purged_1100', 'recoverable']) {
      createAssetData(db, {
        assetKey,
        assetName: assetKey,
        folderKey: 'trees',
        filePath: paths[1100],
        isDelete: 1
      })
    }

    expect([...getRetainedFilePaths(db, [...paths, null, undefined, ''], purgedKeys)]).toEqual([
      paths[1100]
    ])
    expect([...getRetainedFilePaths(db, paths, [...purgedKeys, 'recoverable'])]).toEqual([])
    expect([...getRetainedFilePaths(db, [], purgedKeys)]).toEqual([])
    db.close()
  })

  it('一次查一批 assetKey，超过 SQLite 变量上限也能查全', () => {
    const db = createSeededDb()
    const keys = Array.from({ length: 1200 }, (_, i) => `batch_${i}`)
    for (const assetKey of keys) {
      createAssetData(db, { assetKey, assetName: assetKey, folderKey: 'trees' })
    }
    // 删掉的那条不该回来
    deleteAssetData(db, 'batch_7')

    const found = getAssetsByKeys(db, [...keys, 'batch_0', 'not_there', ''])

    expect(found).toHaveLength(keys.length - 1)
    expect(found.some((a) => a.assetKey === 'batch_7')).toBe(false)
    expect(getAssetsByKeys(db, [])).toEqual([])
    db.close()
  })
})
