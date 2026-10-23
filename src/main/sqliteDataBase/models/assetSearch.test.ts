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
import { countAssetsByEngineVersion } from './assetSearchCore'

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
   * 界面收藏时写 userId=1 + 当前库 id；agent 搜的时候这两个都不带。
   * 原来「不带」被当成「必须是 NULL」，于是概况说有 3 个收藏，筛选一个也搜不到。
   */
  it('不带 userId / vaultId 时，界面写入的带 id 的收藏也要筛得出来', () => {
    insertAsset('a1', 'SM_Hero', 'k_role')
    insertAsset('a2', 'SM_Cape', 'k_role')
    db.prepare(
      'INSERT INTO asset_favorites (assetKey, itemType, userId, vaultId) VALUES (?, ?, ?, ?)'
    ).run('a1', 'asset', 1, 'vault-1')

    expect(
      searchAssetsByCriteria(db, { favoriteStatus: 'favorite' }).map((r) => r.assetKey)
    ).toEqual(['a1'])
    expect(
      searchAssetsByCriteria(db, { favoriteStatus: 'unfavorite' }).map((r) => r.assetKey)
    ).toEqual(['a2'])
    // 带了 id 就照旧按它筛
    expect(searchAssetsByCriteria(db, { favoriteStatus: 'favorite', vaultId: 'vault-2' })).toEqual(
      []
    )
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

    /**
     * 拦下取这一页的那句查询，用同样的参数跑一遍 EXPLAIN QUERY PLAN。
     *
     * 分页查询先只排 id（`SELECT ad.id AS id ...`），再按 id 取整行；要看的是前一句。
     * 不分页的调用一步查完，那句带 tagIdList 而不是 `WHERE ad.id IN`。
     */
    function planOf(criteria: Parameters<typeof searchAssetsByCriteria>[1]): string {
      const realPrepare = db.prepare.bind(db)
      let plan = ''
      const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
        const stmt = realPrepare(sql)
        const isPageQuery =
          sql.includes('SELECT ad.id AS id') ||
          (sql.includes('tagIdList') && !sql.includes('WHERE ad.id IN'))
        if (!isPageQuery || plan) return stmt
        const explain = realPrepare(`EXPLAIN QUERY PLAN ${sql}`)
        return new Proxy(stmt, {
          get(target, key) {
            if (key === 'all') {
              return (...args: unknown[]) => {
                plan = (explain.all(...args) as { detail: string }[])
                  .map((r) => r.detail)
                  .join(' | ')
                return target.all(...args)
              }
            }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }) as typeof db.prepare)
      try {
        searchAssetsByCriteria(db, criteria)
        return plan
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

    /**
     * 默认视图就是「全部资产按修改时间倒序」：沿时间索引取前一页，而不是每一页都把全表读出来
     * 再排（54 万行冷缓存 2 秒以上）。
     */
    it.each([
      ['不筛选', {}],
      ['只看主资产', { showDependencies: false }]
    ] as const)('%s按修改时间倒序：沿时间索引取前一页', (_label, extra) => {
      const plan = planOf({ sortBy: 'modifiedTime', sortOrder: 'desc', limit: 50, ...extra })
      expect(plan).toContain('idx_assetData_updated_at_name')
      expect(plan).not.toContain('USE TEMP B-TREE FOR ORDER BY')
    })

    /**
     * 反过来，规划器估不出命中多少行的窄条件（大小、关键词、收藏、日期……）沿排序索引走，
     * 是把整张索引连同逐行回表走完才凑得出一页 —— 比整表读一遍再排还慢 2~3 倍。
     */
    it.each([
      ['大小', { sizeRange: { min: 1 } }],
      ['关键词', { keyword: 'N1' }],
      ['收藏', { favoriteStatus: 'favorite' as const }],
      ['日期', { dateRange: { start: '2000-01-01', end: '2000-01-02' } }],
      ['类型', { assetTypes: ['T1'] }]
    ])('按%s筛时不沿时间 / 名称索引走', (_label, extra) => {
      for (const sortBy of ['modifiedTime', 'assetName'] as const) {
        const plan = planOf({ sortBy, sortOrder: 'desc', limit: 50, ...extra })
        expect(plan).not.toMatch(/idx_assetData_(updated_at_name|assetName)\b/)
      }
    })

    /**
     * 52 万行的库上点「音频」卡死：fileExtension IN (..) OR ext IN (..) 的 ext 那一边
     * 没有索引，整个 OR 退化成全表扫；按名字排时规划器还会沿名称索引把整张表走一遍
     * 去凑 50 个音频。两边都有索引之后应该各自按索引取行再取并集。
     */
    it.each(['assetName', 'modifiedTime'] as const)(
      '按扩展名筛选（按 %s 排）走扩展名索引，不扫全表',
      (sortBy) => {
        db.prepare(`UPDATE assetData SET fileExtension = 'uasset', ext = 'uasset'`).run()
        db.prepare(
          `UPDATE assetData SET fileExtension = 'wav', ext = NULL WHERE assetKey IN ('p1', 'p2', 'p3')`
        ).run()
        db.exec('ANALYZE')
        const plan = planOf({ fileExtensions: ['wav', 'mp3'], sortBy, limit: 50 })
        expect(plan).toContain('idx_assetData_fileExtension')
        expect(plan).toContain('idx_assetData_ext')
        expect(plan).not.toMatch(/SCAN ad\b(?! USING INDEX idx_assetData_(fileExtension|ext))/)
        expect(plan).not.toMatch(/USING INDEX idx_assetData_assetName/)
      }
    )
  })
})

describe('分页先排 id 再取整行', () => {
  it('取回来的整行保持排序、带着标签', () => {
    for (let i = 0; i < 30; i++) insertAsset(`k${i}`, `Name${String(i).padStart(2, '0')}`, 'ALL')
    db.prepare(`INSERT INTO asset_tags (assetKey, tagId) VALUES ('k27', 5), ('k27', 9)`).run()

    const page = searchAssetsByCriteria(db, {
      sortBy: 'assetName',
      sortOrder: 'desc',
      limit: 5,
      offset: 2
    })
    expect(page.map((row) => row.assetKey)).toEqual(['k27', 'k26', 'k25', 'k24', 'k23'])
    const tagged = page[0] as unknown as { tagIdList: string; imports?: unknown }
    expect(tagged.tagIdList.split(',').sort()).toEqual(['5', '9'])
    // 整行：ad.* 的列都在
    expect(page[0]).toHaveProperty('folderKey', 'ALL')
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

/**
 * 旧 asset-server-standalone 扫描入库写的是 path.extname 的结果（'.wav'，带点），
 * 同步原样抄进本地库；本机导入写的是 'wav'。按扩展名筛选两种都要筛得出来。
 */
describe('按扩展名筛选，带点不带点都认', () => {
  beforeEach(() => {
    insertAsset('local', 'local_wav', 'k_role')
    insertAsset('synced', 'synced_wav', 'k_role')
    insertAsset('mesh', 'mesh', 'k_role')
    const setExt = db.prepare('UPDATE assetData SET fileExtension = ?, ext = ? WHERE assetKey = ?')
    setExt.run('wav', 'wav', 'local')
    setExt.run('.wav', '.wav', 'synced')
    setExt.run('uasset', 'uasset', 'mesh')
  })

  it.each([['wav'], ['.wav'], ['WAV']])('fileExtensions 传 %s', (ext) => {
    const rows = searchAssetsByCriteria(db, { fileExtensions: [ext] })
    expect(rows.map((r) => r.assetKey).sort()).toEqual(['local', 'synced'])
  })

  it('别名展开出来的 formatMatch 也一样', () => {
    const rows = searchAssetsByCriteria(db, { formatMatch: { extensions: ['wav', 'mp3'] } })
    expect(rows.map((r) => r.assetKey).sort()).toEqual(['local', 'synced'])
  })
})

describe('countAssetsByEngineVersion', () => {
  const setEngine = (key: string, version: string | null): void => {
    db.prepare('UPDATE assetData SET engineVersion = ? WHERE assetKey = ?').run(version, key)
  }

  /** 筛选里勾 5.3 会前缀命中 5.3.x，分面不按主.次合并的话旁边写的数就对不上 */
  it('按主.次合并、新版本在前、没标版本的不列、自身的版本条件不参与', () => {
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) insertAsset(key, key, 'k_role')
    setEngine('a', '5.3')
    setEngine('b', '5.3.2')
    setEngine('c', '4.27')
    setEngine('d', '5.10')
    setEngine('e', '')
    setEngine('f', null)

    expect(
      countAssetsByEngineVersion(db, { folderKey: 'k_role', engineVersions: ['4.27'] })
    ).toEqual([
      { value: '5.10', n: 1 },
      { value: '5.3', n: 2 },
      { value: '4.27', n: 1 }
    ])
  })

  it('跟着文件夹范围走', () => {
    insertAsset('a', 'a', 'k_role')
    insertAsset('b', 'b', 'k_env')
    setEngine('a', '5.3')
    setEngine('b', '5.4')

    expect(countAssetsByEngineVersion(db, { folderKey: 'k_env' })).toEqual([{ value: '5.4', n: 1 }])
  })
})
