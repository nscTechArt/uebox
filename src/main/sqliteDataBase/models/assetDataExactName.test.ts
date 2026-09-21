import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  EXACT_NAME_INDEX_HINT,
  buildExactNameSQL,
  findAssetDataByExactName,
  initAssetDataModel
} from './assetData'
import { initAssetFolderModel } from './assetFolder'

/**
 * 回归：工程导入按依赖名找资产。
 *
 * 这条路上只有真 SQLite 才说得清问题 —— projectImport 那三个用例把
 * findAssetDataByExactName 整个 mock 成 `assets.filter(a => a.assetName === name)`，
 * 既不区分大小写形态也不带扩展名形态，正好盖住了这里要盯的两件事。
 */
function seed(): Database.Database {
  const db = new Database(':memory:')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  db.exec(
    `INSERT OR IGNORE INTO assetFolder (folderKey, fatherKey, type, folderName)
     VALUES ('ALL', NULL, 'system', 'ALL')`
  )
  const insert = db.prepare(
    `INSERT INTO assetData (assetKey, folderKey, assetName, softPath, isDelete)
     VALUES (?, 'ALL', ?, ?, ?)`
  )
  // 扫描器（networkVaultV2 的 performServerScan）写的是 basename，带扩展名
  insert.run('scanned', 'SM_Chair.uasset', '/Game/Props/SM_Chair', 0)
  // 另一条写入路径（ipc/assetData）写的是去掉扩展名的
  insert.run('stripped', 'SM_Chair', '/Game/Other/SM_Chair', 0)
  insert.run('map', 'SM_Chair.umap', '/Game/Maps/SM_Chair', 0)
  // 前缀相同但不是「同名 + 扩展名」，不能被范围查捎带进来
  insert.run('neighbour', 'SM_Chairz', '/Game/Nope/SM_Chairz', 0)
  insert.run('deleted', 'SM_Chair.uasset', '/Game/Trash/SM_Chair', 1)
  return db
}

describe('findAssetDataByExactName', () => {
  it('同时认「原名」和「原名.扩展名」两种形态，软删的不算', () => {
    const db = seed()
    const keys = findAssetDataByExactName(db, 'SM_Chair').map((row) => row.assetKey)

    // scanned 是关键：依赖名是从 softPath 切出来的、不带扩展名，
    // 只比 assetName = ? 的话扫描器建的行一条都命中不了，依赖会被静默丢掉
    expect(keys.sort()).toEqual(['map', 'scanned', 'stripped'])
    expect(keys).not.toContain('neighbour')
    expect(keys).not.toContain('deleted')
    db.close()
  })

  it('softPath 后缀命中的排在前面，截断不会把要的那条切掉', () => {
    const db = seed()
    const first = findAssetDataByExactName(db, 'SM_Chair', 1, '/Maps/SM_Chair')
    expect(first.map((row) => row.assetKey)).toEqual(['map'])
    db.close()
  })

  it('范围只认一段扩展名：SM_Chair.uasset.bak 这类旁支不算候选', () => {
    const db = seed()
    const insert = db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, softPath, isDelete)
       VALUES (?, 'ALL', ?, ?, 0)`
    )
    // 跟资产同名同目录的备份/源文件。只看 softPath 的话它们会顶掉真正的 .uasset
    insert.run('bak', 'SM_Chair.uasset.bak', '/Game/Props/SM_Chair')

    const keys = findAssetDataByExactName(db, 'SM_Chair').map((row) => row.assetKey)
    expect(keys).not.toContain('bak')
    db.close()
  })

  it('偏好后缀里的 _ 不当通配符用', () => {
    const db = seed()
    const insert = db.prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, softPath, isDelete)
       VALUES (?, 'ALL', ?, ?, 0)`
    )
    // softPath 是 SMxChair：不转义的话 `%/SM_Chair` 里的 _ 会把它也匹配上，
    // 于是这个冒牌货排到最前面，把真正要的那条挤出 LIMIT
    insert.run('decoy', 'SM_Chair', '/Game/MapsX/SMxChair')

    const first = findAssetDataByExactName(db, 'SM_Chair', 1, '/SM_Chair')
    expect(first.map((row) => row.assetKey)).not.toEqual(['decoy'])
    db.close()
  })

  it('两条分支都走 assetName 索引，不许退回 isDelete 那个两值索引', () => {
    const db = seed()
    // 没有 ANALYZE 的库上，规划器会挑 idx_assetData_isDelete（只有 0/1 两个值，
    // 等于全表扫）。52 万行的镜像库上那就是每个依赖一次全表扫。
    // 盯的必须是 findAssetDataByExactName 真正跑的那条语句。
    // 只 EXPLAIN 一个导出的 SQL 常量还不够 —— 那样只证明「这条 SQL 钉了索引」，
    // 证明不了函数选的是它；把调用处换成不钉索引的那个分支，断言照样绿（实测过）。
    // 所以这里钩住 prepare，把它实际编译的 SQL 抓出来再 EXPLAIN。
    const prepared: string[] = []
    const realPrepare = db.prepare.bind(db)
    ;(db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      prepared.push(sql)
      return realPrepare(sql)
    }) as typeof db.prepare

    findAssetDataByExactName(db, 'SM_Chair', 5, '/SM_Chair')
    ;(db as unknown as { prepare: typeof db.prepare }).prepare = realPrepare

    const used = prepared.find((sql) => sql.includes('UNION ALL'))
    expect(used).toBeDefined()
    expect(used).toContain(EXACT_NAME_INDEX_HINT.trim())
    // 顺带确认导出的构造器和实际用的是同一份，测试才不会盯着一份副本
    expect(used).toBe(buildExactNameSQL(EXACT_NAME_INDEX_HINT))

    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${used}`).all({
        stem: 'a',
        low: 'a.',
        high: 'a.￿',
        prefer: null,
        lim: 5
      }) as { detail: string }[]
    ).map((row) => row.detail)

    // 必须是 SEARCH（索引 seek）。只匹配索引名不够：`SCAN assetData USING INDEX
    // idx_assetData_assetName` 也含这个名字，那是退化成整索引扫，不是我们要的
    const seeks = plan.filter(
      (line) => line.startsWith('SEARCH') && line.includes('idx_assetData_assetName')
    )
    expect(seeks.length).toBe(2)
    expect(plan.some((line) => /\bidx_assetData_isDelete\b/.test(line))).toBe(false)
    db.close()
  })
})
