/**
 * trashLifecycle.test.ts —— 回收站的进出规则
 *
 * 守四条：
 *   1. 删除时间要记下来（`deletedAt`），不能拿 updated_at 顶替 —— 后者会被同步、
 *      改标签、改备注刷掉，「最近删除」就排不出「最近」；
 *   2. 回收站列的是**这一次删除的根**，删一个文件夹只出现一个条目，不是整棵子树；
 *   3. 恢复文件夹只带回「这一次删除带走的那些」，用户几个月前单独删掉的东西
 *      不能被顺手翻出来；
 *   4. 恢复资产要把它头顶那条已删的文件夹链一起救活，否则恢复出来的东西
 *      谁也看不见 —— 既不在树里，也不在回收站里。
 */
import Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import {
  createAssetData,
  deleteAssetData,
  deletionStamp,
  getDeletedAssetData,
  initAssetDataModel,
  restoreAssetData
} from './assetData'
import {
  createAssetFolder,
  deleteAssetFolder,
  findDeletedAssetFolder,
  getAssetFolderByKey,
  getDeletedAssetFolders,
  initAssetFolderModel,
  restoreAssetFolder
} from './assetFolder'

let db: Database.Database

function createTestDb(): Database.Database {
  const database = new Database(':memory:')
  initAssetFolderModel(database)
  initAssetDataModel(database)
  database
    .prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
    )
    .run()
  return database
}

/** pack ⊃ textures，各放一个资产 */
function seedTree(): void {
  createAssetFolder(db, { folderKey: 'pack', fatherKey: 'ALL', type: 'folder', folderName: 'Pack' })
  createAssetFolder(db, {
    folderKey: 'textures',
    fatherKey: 'pack',
    type: 'folder',
    folderName: 'Textures'
  })
  createAssetData(db, { assetKey: 'a_pack', folderKey: 'pack', assetName: 'SM_Rock' })
  createAssetData(db, { assetKey: 'a_tex', folderKey: 'textures', assetName: 'T_Rock_D' })
}

const isDeleted = (table: 'assetData' | 'assetFolder', key: string): number => {
  const column = table === 'assetData' ? 'assetKey' : 'folderKey'
  const row = db.prepare(`SELECT isDelete FROM ${table} WHERE ${column} = ?`).get(key) as {
    isDelete: number
  }
  return row.isDelete
}

const deletedAtOf = (table: 'assetData' | 'assetFolder', key: string): string | null => {
  const column = table === 'assetData' ? 'assetKey' : 'folderKey'
  const row = db.prepare(`SELECT deletedAt FROM ${table} WHERE ${column} = ?`).get(key) as {
    deletedAt: string | null
  }
  return row.deletedAt
}

describe('回收站的进出规则', () => {
  beforeEach(() => {
    db = createTestDb()
    seedTree()
  })

  afterEach(() => {
    db.close()
  })

  describe('删除时间', () => {
    it('软删除会记下删除时间，恢复会把它清掉', () => {
      deleteAssetData(db, 'a_pack')
      expect(deletedAtOf('assetData', 'a_pack')).toBeTruthy()

      restoreAssetData(db, 'a_pack')
      expect(deletedAtOf('assetData', 'a_pack')).toBeNull()
    })

    it('一次文件夹删除里，整棵子树盖的是同一个时间戳', () => {
      deleteAssetFolder(db, 'pack')

      const stamp = deletedAtOf('assetFolder', 'pack')
      expect(stamp).toBeTruthy()
      expect(deletedAtOf('assetFolder', 'textures')).toBe(stamp)
      expect(deletedAtOf('assetData', 'a_pack')).toBe(stamp)
      expect(deletedAtOf('assetData', 'a_tex')).toBe(stamp)
    })

    it('回收站按删除时间倒序，刚删的排最前', () => {
      deleteAssetData(db, 'a_pack', deletionStamp(new Date('2026-01-01T10:00:00')))
      deleteAssetData(db, 'a_tex', deletionStamp(new Date('2026-03-01T10:00:00')))

      const { list } = getDeletedAssetData(db)
      expect(list.map((row) => row.assetKey)).toEqual(['a_tex', 'a_pack'])
    })
  })

  describe('回收站列什么', () => {
    it('删一个文件夹只出现一个条目 —— 子孙不铺出来', () => {
      deleteAssetFolder(db, 'pack')

      const { list, total } = getDeletedAssetFolders(db)
      expect(total).toBe(1)
      expect(list.map((folder) => folder.folderKey)).toEqual(['pack'])
    })

    it('父级还活着的那个子文件夹，自己就是一次删除的根', () => {
      deleteAssetFolder(db, 'textures')

      const { list } = getDeletedAssetFolders(db)
      expect(list.map((folder) => folder.folderKey)).toEqual(['textures'])
    })

    it('子孙层不在列表里，但按 folderKey 精确找得到（用于单独恢复）', () => {
      deleteAssetFolder(db, 'pack')

      expect(getDeletedAssetFolders(db).list.map((f) => f.folderKey)).toEqual(['pack'])
      expect(findDeletedAssetFolder(db, 'textures')?.folderKey).toBe('textures')
      // 没删的那些一个都不该认
      restoreAssetFolder(db, 'pack')
      expect(findDeletedAssetFolder(db, 'textures')).toBeUndefined()
    })
  })

  describe('恢复文件夹', () => {
    it('把这一次删除带走的子文件夹和资产一起带回来', () => {
      deleteAssetFolder(db, 'pack')
      restoreAssetFolder(db, 'pack')

      expect(isDeleted('assetFolder', 'pack')).toBe(0)
      expect(isDeleted('assetFolder', 'textures')).toBe(0)
      expect(isDeleted('assetData', 'a_pack')).toBe(0)
      expect(isDeleted('assetData', 'a_tex')).toBe(0)
    })

    it('之前单独删掉的资产不跟着回来 —— 用户当初是特意删的', () => {
      // 先单独删掉一个（更早的时间戳）
      deleteAssetData(db, 'a_tex', deletionStamp(new Date('2026-01-01T10:00:00')))
      // 再删整个文件夹
      deleteAssetFolder(db, 'pack')

      restoreAssetFolder(db, 'pack')

      expect(isDeleted('assetFolder', 'pack')).toBe(0)
      expect(isDeleted('assetData', 'a_pack')).toBe(0)
      // 它的删除时间和这一次不是同一个，留在回收站里
      expect(isDeleted('assetData', 'a_tex')).toBe(1)
    })

    it('恢复子文件夹时，头顶那条已删的链一起活过来', () => {
      deleteAssetFolder(db, 'pack')

      restoreAssetFolder(db, 'textures')

      // 父级不救活的话，恢复出来的文件夹挂在一个还在回收站里的父节点下，树上看不见
      expect(isDeleted('assetFolder', 'pack')).toBe(0)
      expect(isDeleted('assetFolder', 'textures')).toBe(0)
      // 但父级里那个资产不该被顺手恢复：用户要的是这个子文件夹
      expect(isDeleted('assetData', 'a_pack')).toBe(1)
    })
  })

  describe('恢复资产', () => {
    it('资产所在的文件夹还在回收站里时，把那条链一起恢复', () => {
      deleteAssetFolder(db, 'pack')

      restoreAssetData(db, 'a_tex')

      expect(isDeleted('assetData', 'a_tex')).toBe(0)
      // 不做这一步的话，这个资产既不在树里也不在回收站里 —— 谁也看不见
      expect(getAssetFolderByKey(db, 'textures')).toBeTruthy()
      expect(getAssetFolderByKey(db, 'pack')).toBeTruthy()
      // 文件夹里其余还在回收站的东西不受影响
      expect(isDeleted('assetData', 'a_pack')).toBe(1)
    })

    it('本来就没删的资产，恢复返回 false，不动任何文件夹', () => {
      deleteAssetFolder(db, 'pack')
      restoreAssetData(db, 'a_tex')
      const before = isDeleted('assetData', 'a_pack')

      expect(restoreAssetData(db, 'a_tex')).toBe(false)
      expect(isDeleted('assetData', 'a_pack')).toBe(before)
    })
  })
})
