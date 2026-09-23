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
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { initAssetFolderModel } from './assetFolder'
import { getAssetDataByFolderKey, initAssetDataModel } from './assetData'
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

describe('按名称排序', () => {
  const MIXED = [
    ['b1', 'b_rock'],
    ['a1', 'A_Hero'],
    ['c1', 'C_Tree'],
    ['a2', 'a_arm']
  ]

  it.each(['asc', 'desc'] as const)(
    '%s 不分大小写，和浏览那条路（getAssetDataByFolderKey）排得一样',
    (sortOrder) => {
      for (const [key, name] of MIXED) insertAsset(key, name, 'k_role')

      const searched = searchAssetsByCriteria(db, { folderKey: 'k_role', sortOrder })
      const browsed = getAssetDataByFolderKey(db, 'k_role', 'assetName', sortOrder)

      const expected = ['a_arm', 'A_Hero', 'b_rock', 'C_Tree']
      expect(searched.map((r) => r.assetName)).toEqual(
        sortOrder === 'asc' ? expected : [...expected].reverse()
      )
      expect(searched.map((r) => r.assetKey)).toEqual(browsed.map((r) => r.assetKey))
    }
  )

  it('含子文件夹时同样不分大小写', () => {
    for (const [key, name] of MIXED) insertAsset(key, name, 'k_role')

    const rows = searchAssetsByCriteria(db, { folderKey: 'k_role', includeSubfolders: true })

    expect(rows.map((r) => r.assetName)).toEqual(['a_arm', 'A_Hero', 'b_rock', 'C_Tree'])
  })

  /**
   * 守的是查询计划，不是结果。
   *
   * 名称索引是 NOCASE 建的，排序对不上它就是整表读出来再排；对上了又要防另一头：
   * 规划器估不出「某文件夹及其子文件夹」有多少行，会沿名称 / 类型索引把整张表走一遍
   * 去凑一页 —— 52 万行的库上，几十个资产的文件夹要 3 秒。夹具要够大、要 ANALYZE，
   * 规划器才会做出和真实保管库（VaultManager 打开时补 ANALYZE）一样的选择。
   */
  describe('查询计划', () => {
    beforeEach(() => {
      const folder = db.prepare(
        `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
         VALUES (?, 'ALL', 'folder', ?, ?, '[]', 1, '[]', 0)`
      )
      for (let i = 0; i < 50; i++) folder.run(`pf${i}`, `pf${i}`, `/pf${i}`)
      const asset = db.prepare(
        `INSERT INTO assetData (assetKey, folderKey, assetName, folderName, isDelete, assetType)
         VALUES (?, ?, ?, 'x', 0, ?)`
      )
      db.transaction(() => {
        for (let i = 0; i < 2000; i++) {
          asset.run(`p${i}`, `pf${i % 50}`, `N${(i * 7919) % 2000}`, `T${i % 5}`)
        }
      })()
      db.exec('ANALYZE')
    })

    /** 拦下主查询那一句，换成 EXPLAIN QUERY PLAN，拿到的「资产」就是计划行 */
    function planOf(criteria: Parameters<typeof searchAssetsByCriteria>[1]): string {
      const realPrepare = db.prepare.bind(db)
      const spy = vi
        .spyOn(db, 'prepare')
        .mockImplementation(((sql: string) =>
          realPrepare(
            sql.includes('tagIdList') ? `EXPLAIN QUERY PLAN ${sql}` : sql
          )) as typeof db.prepare)
      try {
        const rows = searchAssetsByCriteria(db, criteria) as unknown as { detail: string }[]
        return rows.map((r) => r.detail).join(' | ')
      } finally {
        spy.mockRestore()
      }
    }

    it.each(['asc', 'desc'] as const)('不圈文件夹时 %s 沿名称索引取，不临时排序', (sortOrder) => {
      const plan = planOf({ sortOrder, limit: 20 })
      expect(plan).toContain('idx_assetData_assetName')
      expect(plan).not.toContain('TEMP B-TREE')
    })

    it('单个文件夹沿 (folderKey, isDelete, assetName) 复合索引取，不临时排序', () => {
      const plan = planOf({ folderKey: 'pf1', limit: 20 })
      expect(plan).toContain('idx_assetData_folderKey_isDelete_assetName')
      expect(plan).not.toContain('TEMP B-TREE')
    })

    it.each(['assetName', 'assetType', 'modifiedTime', 'fileSize'] as const)(
      '含子文件夹按 %s 排时先按文件夹取行，不沿排序列的索引把整表走一遍',
      (sortBy) => {
        const plan = planOf({ folderKey: 'pf1', includeSubfolders: true, sortBy, limit: 20 })
        expect(plan).not.toMatch(/SCAN ad USING INDEX idx_assetData_(assetName|assetType)\b/)
        expect(plan).toContain('idx_assetData_folderKey_isDelete_assetName (folderKey=?')
      }
    )
  })
})

/**
 * 界面一开筛选就从浏览（getAssetDataByFolderKey）切到搜索。两边排出来不一样的话，
 * 勾一个筛选列表就整个换了顺序 —— 默认视图恰好是「按时间倒序」。
 *
 * 夹具故意让 modifiedTime 和 updated_at 的先后相反、fileSize 有 NULL 也有 0、
 * 同一秒 / 同一大小的有好几个且名字大小写混着：直排 modifiedTime / fileSize、
 * 或者少了次序键，都会在这里排出不同的顺序。
 */
describe('按时间 / 大小排序和浏览那条路一致', () => {
  beforeEach(() => {
    const rows: [string, string, string, string | null, number | null][] = [
      // key, 名字, updated_at, modifiedTime, fileSize
      ['a', 'A_new', '2026-03-01 10:00:00', null, 300],
      ['b', 'b_mid', '2026-02-01 10:00:00', '2020-01-01T00:00:00.000Z', null],
      ['c', 'c_tie', '2026-01-01 10:00:00', '2030-01-01T00:00:00.000Z', 100],
      ['d', 'B_tie', '2026-01-01 10:00:00', '2010-01-01T00:00:00.000Z', 100],
      ['e', 'a_zero', '2026-02-15 10:00:00', '2025-01-01T00:00:00.000Z', 0]
    ]
    for (const [key, name, updatedAt, modifiedTime, fileSize] of rows) {
      insertAsset(key, name, 'k_role')
      db.prepare(
        'UPDATE assetData SET updated_at = ?, modifiedTime = ?, fileSize = ? WHERE assetKey = ?'
      ).run(updatedAt, modifiedTime, fileSize, key)
    }
  })

  const EXPECTED = {
    modifiedTime: { asc: ['d', 'c', 'b', 'e', 'a'], desc: ['a', 'e', 'b', 'd', 'c'] },
    fileSize: { asc: ['e', 'b', 'd', 'c', 'a'], desc: ['a', 'd', 'c', 'e', 'b'] }
  }

  describe.each(['modifiedTime', 'fileSize'] as const)('%s', (sortBy) => {
    it.each(['asc', 'desc'] as const)('%s', (sortOrder) => {
      const browsed = getAssetDataByFolderKey(db, 'k_role', sortBy, sortOrder)
      const searched = searchAssetsByCriteria(db, { folderKey: 'k_role', sortBy, sortOrder })
      // 含子文件夹是界面开了筛选后真正走的那条，排序列上套了一元 +
      const searchedSubtree = searchAssetsByCriteria(db, {
        folderKey: 'k_role',
        includeSubfolders: true,
        sortBy,
        sortOrder
      })

      const keys = (rows: { assetKey?: string }[]): (string | undefined)[] =>
        rows.map((r) => r.assetKey)
      expect(keys(browsed)).toEqual(EXPECTED[sortBy][sortOrder])
      expect(keys(searched)).toEqual(keys(browsed))
      expect(keys(searchedSubtree)).toEqual(keys(browsed))
    })
  })
})
