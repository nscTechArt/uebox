/**
 * @vitest-environment node
 *
 * 筛选条件拼 SQL。
 *
 * 这里守的是**占位符和参数对得上**。这类错误不会抛异常、不会报错，
 * 只会安静地返回一堆和用户要求无关的资产 —— 除非有测试盯着，
 * 否则只能靠用户自己发现「怎么搜出来的不是我要的」。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { initAssetFolderModel } from './assetFolder'
import { initAssetDataModel } from './assetData'
import { initAssetFavoriteModel } from './assetFavorite'
import { initAssetTagModel } from './assetTag'
import { searchAssetsByCriteria } from './assetSearch'

let db: Database.Database

function insertAsset(key: string, name: string, folderKey: string): void {
  db.prepare(
    `INSERT INTO assetData (assetKey, folderKey, assetName, folderName, isDelete)
     VALUES (?, ?, ?, ?, 0)`
  ).run(key, folderKey, name, folderKey)
}

/** 导入时自动带进来的依赖资产（isDependency = 1） */
function insertDependency(key: string, name: string, folderKey: string): void {
  db.prepare(
    `INSERT INTO assetData (assetKey, folderKey, assetName, folderName, isDelete, isDependency)
     VALUES (?, ?, ?, ?, 0, 1)`
  ).run(key, folderKey, name, folderKey)
}

beforeEach(() => {
  db = new Database(':memory:')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  initAssetFavoriteModel(db)
  initAssetTagModel(db)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES ('ALL', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
  ).run()
  for (const [key, path] of [
    ['k_role', '/角色'],
    ['k_env', '/场景']
  ]) {
    db.prepare(
      `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
       VALUES (?, 'ALL', 'folder', ?, ?, '[]', 1, '[]', 0)`
    ).run(key, path.slice(1), path)
  }
})

describe('searchAssetsByCriteria 的参数绑定', () => {
  it.each(['asc', 'desc'] as const)('按类型 %s 排序不退回名称排序', (sortOrder) => {
    insertAsset('mesh', 'A_Mesh', 'k_role')
    insertAsset('animation', 'Z_Animation', 'k_role')
    db.prepare('UPDATE assetData SET assetType = ? WHERE assetKey = ?').run('StaticMesh', 'mesh')
    db.prepare('UPDATE assetData SET assetType = ? WHERE assetKey = ?').run(
      'Animation',
      'animation'
    )
    const rows = searchAssetsByCriteria(db, { folderKey: 'k_role', sortBy: 'assetType', sortOrder })
    expect(rows.map((row) => row.assetKey)).toEqual(
      sortOrder === 'asc' ? ['animation', 'mesh'] : ['mesh', 'animation']
    )
  })

  /**
   * `ad.folderKey = ?` 走 WHERE，收藏走 JOIN。JOIN 在 SQL 文本里排在 WHERE 前面，
   * 但代码里是 WHERE 先 push —— 参数错位的话 folderKey 会被绑到收藏表的 userId 上，
   * 于是「这个文件夹里我收藏的」返回的是别的文件夹的东西，一声不吭。
   */
  it('指定文件夹（不含子文件夹）+ 只看收藏，两个条件都要真的生效', () => {
    insertAsset('a1', 'SM_Hero', 'k_role')
    insertAsset('a2', 'SM_Rock', 'k_env')
    insertAsset('a3', 'SM_Cape', 'k_role')
    db.prepare('INSERT INTO asset_favorites (assetKey, itemType) VALUES (?, ?)').run('a1', 'asset')
    db.prepare('INSERT INTO asset_favorites (assetKey, itemType) VALUES (?, ?)').run('a2', 'asset')

    const rows = searchAssetsByCriteria(db, {
      folderKey: 'k_role',
      includeSubfolders: false,
      favoriteStatus: 'favorite'
    })

    expect(rows.map((r) => r.assetKey)).toEqual(['a1'])
  })

  it('指定文件夹（含子文件夹）+ 只看没收藏的', () => {
    insertAsset('a1', 'SM_Hero', 'k_role')
    insertAsset('a2', 'SM_Cape', 'k_role')
    db.prepare('INSERT INTO asset_favorites (assetKey, itemType) VALUES (?, ?)').run('a1', 'asset')

    const rows = searchAssetsByCriteria(db, {
      folderKey: 'k_role',
      includeSubfolders: true,
      favoriteStatus: 'unfavorite'
    })

    expect(rows.map((r) => r.assetKey)).toEqual(['a2'])
  })
  /**
   * 「只看主资产」这个筛选原来只有浏览那条路认得。它一旦生效，列表就因为
   * hasActiveFilters 变真而转去走搜索，而搜索不认这个条件 —— 用户看到筛选开着、
   * 徽标是 1、依赖资产却一个没少。
   */
  describe('只看主资产', () => {
    it('showDependencies=false 时挡掉自动带进来的依赖', () => {
      insertAsset('a1', 'SM_Hero', 'k_role')
      insertDependency('d1', 'T_Hero_D', 'k_role')

      const rows = searchAssetsByCriteria(db, { folderKey: 'k_role', showDependencies: false })

      expect(rows.map((r) => r.assetKey)).toEqual(['a1'])
    })

    it('缺省和 true 都是全都显示', () => {
      insertAsset('a1', 'SM_Hero', 'k_role')
      insertDependency('d1', 'T_Hero_D', 'k_role')

      for (const criteria of [
        { folderKey: 'k_role' },
        { folderKey: 'k_role', showDependencies: true }
      ]) {
        const rows = searchAssetsByCriteria(db, criteria)
        expect(rows.map((r) => r.assetKey).sort()).toEqual(['a1', 'd1'])
      }
    })

    it('和别的筛选条件叠加时仍然生效', () => {
      insertAsset('a1', 'SM_Hero', 'k_role')
      insertDependency('d1', 'SM_Hero_LOD', 'k_role')
      db.prepare('INSERT INTO asset_favorites (assetKey, itemType) VALUES (?, ?)').run(
        'a1',
        'asset'
      )
      db.prepare('INSERT INTO asset_favorites (assetKey, itemType) VALUES (?, ?)').run(
        'd1',
        'asset'
      )

      const rows = searchAssetsByCriteria(db, {
        folderKey: 'k_role',
        favoriteStatus: 'favorite',
        showDependencies: false
      })

      expect(rows.map((r) => r.assetKey)).toEqual(['a1'])
    })
  })

  /**
   * 回收站原来走自己那条 getDeleted 接口，不认识任何筛选条件 ——
   * 在「最近删除」里改格式、改类型、改标签，列表一行都不会变。
   */
  describe('只看回收站', () => {
    it('deletedOnly 时只返回删掉的那些', () => {
      insertAsset('a1', 'SM_Hero', 'k_role')
      insertAsset('a2', 'SM_Rock', 'k_role')
      db.prepare('UPDATE assetData SET isDelete = 1 WHERE assetKey = ?').run('a2')

      const rows = searchAssetsByCriteria(db, { deletedOnly: true })

      expect(rows.map((r) => r.assetKey)).toEqual(['a2'])
    })

    it('缺省和 false 都只看没删的', () => {
      insertAsset('a1', 'SM_Hero', 'k_role')
      insertAsset('a2', 'SM_Rock', 'k_role')
      db.prepare('UPDATE assetData SET isDelete = 1 WHERE assetKey = ?').run('a2')

      for (const criteria of [{}, { deletedOnly: false }]) {
        const rows = searchAssetsByCriteria(db, criteria)
        expect(rows.map((r) => r.assetKey)).toEqual(['a1'])
      }
    })

    /** 回收站里的筛选要真的筛得动，否则等于没接 */
    it('和别的筛选条件叠加时仍然只看回收站', () => {
      insertAsset('a1', 'SM_Hero', 'k_role')
      insertAsset('a2', 'SM_Rock', 'k_role')
      insertDependency('d1', 'SM_Rock_LOD', 'k_role')
      db.prepare('UPDATE assetData SET isDelete = 1 WHERE assetKey IN (?, ?)').run('a2', 'd1')

      const rows = searchAssetsByCriteria(db, { deletedOnly: true, showDependencies: false })

      expect(rows.map((r) => r.assetKey)).toEqual(['a2'])
    })

    /**
     * 删一个文件夹会把里面的资产全标成删除。界面上列的是**文件夹**那一条，
     * 里面的东西不单独铺出来 —— 否则删一个包会在回收站里炸出几百个条目，
     * 而它们本来就跟着文件夹一起恢复。
     */
    it('excludeInsideDeletedFolders：跟着文件夹走的资产不单独列', () => {
      insertAsset('alone', 'SM_Hero', 'k_role')
      insertAsset('inside', 'SM_Rock', 'k_env')
      db.prepare('UPDATE assetData SET isDelete = 1').run()
      db.prepare(`UPDATE assetFolder SET isDelete = 1 WHERE folderKey = 'k_env'`).run()

      const rows = searchAssetsByCriteria(db, {
        deletedOnly: true,
        excludeInsideDeletedFolders: true
      })

      expect(rows.map((r) => r.assetKey)).toEqual(['alone'])
    })

    it('按删除时间排序；老库里没写过 deletedAt 的退回 updated_at，不会掉到一头去', () => {
      insertAsset('old', 'SM_Old', 'k_role')
      insertAsset('newer', 'SM_New', 'k_role')
      insertAsset('legacy', 'SM_Legacy', 'k_role')
      db.prepare('UPDATE assetData SET isDelete = 1').run()
      db.prepare(
        `UPDATE assetData SET deletedAt = '2026-01-01 10:00:00' WHERE assetKey = 'old'`
      ).run()
      db.prepare(
        `UPDATE assetData SET deletedAt = '2026-03-01 10:00:00' WHERE assetKey = 'newer'`
      ).run()
      // 补列之前删掉的那些：deletedAt 是空的，只有 updated_at
      db.prepare(
        `UPDATE assetData SET deletedAt = NULL, updated_at = '2026-02-01 10:00:00' WHERE assetKey = 'legacy'`
      ).run()

      const rows = searchAssetsByCriteria(db, {
        deletedOnly: true,
        sortBy: 'deletedAt',
        sortOrder: 'desc'
      })

      expect(rows.map((r) => r.assetKey)).toEqual(['newer', 'legacy', 'old'])
    })
  })
})
