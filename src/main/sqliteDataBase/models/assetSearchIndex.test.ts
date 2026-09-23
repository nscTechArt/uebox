/**
 * @vitest-environment node
 *
 * 全文检索索引。
 *
 * 这里最要紧的两条：
 * 1. **中文两个字也搜得到** —— 「椅子」必须命中「木头椅子」。做不到的话
 *    中文用户在自己的库里只能靠英文名找东西。
 * 2. **索引落后时不许假装搜全了** —— 待索引队列非空就该退回 LIKE。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { initAssetFolderModel } from './assetFolder'
import { initAssetDataModel } from './assetData'
import { initAssetTagModel } from './assetTag'
import {
  buildFtsMatchQuery,
  getAssetSearchIndexStatus,
  initAssetSearchIndexModel,
  isAssetSearchIndexReady,
  prepareIndexText,
  syncAssetSearchIndex,
  withAssetReplaceGuard
} from './assetSearchIndex'
import { searchAssetsByCriteria } from './assetSearch'

let db: Database.Database

function insertAsset(
  key: string,
  name: string,
  extra: { note?: string; folder?: string; type?: string; path?: string } = {}
): void {
  db.prepare(
    `INSERT INTO assetData (assetKey, folderKey, assetName, folderName, assetType, softPath, note, isDelete)
     VALUES (?, 'k_all', ?, ?, ?, ?, ?, 0)`
  ).run(
    key,
    name,
    extra.folder ?? 'Props',
    extra.type ?? 'StaticMesh',
    extra.path ?? `/Game/Props/${name}`,
    extra.note ?? null
  )
}

function sync(publicDb?: Database.Database): void {
  // 循环到追平，测试里数据量小，不需要分批
  let guard = 0
  while (!isAssetSearchIndexReady(db) && guard < 50) {
    syncAssetSearchIndex(db, { publicDb, budget: 100 })
    guard += 1
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  initAssetTagModel(db)
  initAssetSearchIndexModel(db)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys, isDelete)
     VALUES ('k_all', NULL, 'folder', 'ALL', '/', '[]', 0, '[]', 0)`
  ).run()
})

describe('buildFtsMatchQuery', () => {
  it('英文词加前缀匹配', () => {
    expect(buildFtsMatchQuery('chair')).toBe('"chair"*')
  })

  it('中文串拆成逐字短语', () => {
    expect(buildFtsMatchQuery('椅子')).toBe('"椅 子"')
  })

  it('多个词之间是 OR，中英混排也拆得开', () => {
    expect(buildFtsMatchQuery('木头 chair')).toBe('"木 头" OR "chair"*')
  })

  it('FTS5 的语法字符被当分隔符扔掉，不会让查询报语法错', () => {
    expect(buildFtsMatchQuery('"chair" AND (wood*')).toBe('"chair"* OR "and"* OR "wood"*')
  })

  it('没有任何可用字符时返回 null —— 不该走 FTS', () => {
    expect(buildFtsMatchQuery('  ***  ')).toBeNull()
    expect(buildFtsMatchQuery('')).toBeNull()
  })
})

describe('prepareIndexText', () => {
  it('汉字逐字拆开，英文原样保留', () => {
    expect(prepareIndexText('木头Chair')).toBe(' 木  头 Chair')
  })
})

describe('索引检索', () => {
  it('中文两个字命中中文名字', () => {
    insertAsset('a1', '木头椅子')
    insertAsset('a2', '石头桌子')
    sync()

    const rows = searchAssetsByCriteria(db, { ftsMatch: buildFtsMatchQuery('椅子')! })
    expect(rows.map((r) => r.assetKey)).toEqual(['a1'])
  })

  it('英文名按下划线切词，搜一段也命中', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    insertAsset('a2', 'SM_Table_Metal')
    sync()

    const rows = searchAssetsByCriteria(db, { ftsMatch: buildFtsMatchQuery('chair')! })
    expect(rows.map((r) => r.assetKey)).toEqual(['a1'])
  })

  it('名字命中排在备注命中前面 —— 这就是「答得准」的地方', () => {
    insertAsset('a_note', 'SM_Table_Metal', { note: '这张桌子配的是 chair 那一套' })
    insertAsset('a_name', 'SM_Chair_Wood')
    sync()

    const rows = searchAssetsByCriteria(db, {
      ftsMatch: buildFtsMatchQuery('chair')!,
      sortBy: 'relevance'
    })
    expect(rows.map((r) => r.assetKey)).toEqual(['a_name', 'a_note'])
  })

  it('两个词都命中的排在只命中一个的前面', () => {
    insertAsset('both', 'SM_Chair_Wood')
    insertAsset('one', 'SM_Chair_Metal')
    sync()

    const rows = searchAssetsByCriteria(db, { ftsMatch: buildFtsMatchQuery('chair wood')! })
    expect(rows[0].assetKey).toBe('both')
  })

  it('中文标签搜得到 —— 名字是英文也不耽误', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    insertAsset('a2', 'SM_Table_Metal')
    db.prepare('INSERT INTO asset_tags (assetKey, tagId) VALUES (?, ?)').run('a1', 7)

    const publicDb = new Database(':memory:')
    publicDb.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT)')
    publicDb.prepare('INSERT INTO tags (id, name) VALUES (7, ?)').run('家具')

    sync(publicDb)

    const rows = searchAssetsByCriteria(db, { ftsMatch: buildFtsMatchQuery('家具')! })
    expect(rows.map((r) => r.assetKey)).toEqual(['a1'])
    publicDb.close()
  })

  it('筛选条件和全文索引能叠加', () => {
    insertAsset('a1', 'SM_Chair_Wood', { type: 'StaticMesh' })
    insertAsset('a2', 'T_Chair_D', { type: 'Texture2D' })
    sync()

    const rows = searchAssetsByCriteria(db, {
      ftsMatch: buildFtsMatchQuery('chair')!,
      assetTypes: ['Texture2D']
    })
    expect(rows.map((r) => r.assetKey)).toEqual(['a2'])
  })
})

describe('混合召回（关键词 + 语义）', () => {
  /**
   * 语义那一路的意义就在这里：中文查询和英文资产名一个字都不重合，
   * 关键词永远召不回来，只有语义能。
   */
  it('语义召回的资产即使一个字都没命中也会进结果', async () => {
    insertAsset('a1', 'SM_Chair_Wood')
    insertAsset('a2', 'SM_Table_Metal')
    sync()
    const chairId = (
      db.prepare('SELECT id FROM assetData WHERE assetKey = ?').get('a1') as { id: number }
    ).id

    // 关键词那一路只命中 table，语义那一路指向 chair
    const rows = searchAssetsByCriteria(db, {
      ftsMatch: buildFtsMatchQuery('table')!,
      semanticIds: [chairId]
    })

    expect(rows.map((r) => r.assetKey).sort()).toEqual(['a1', 'a2'])
  })

  it('两路都命中的排在只有一路命中的前面', () => {
    insertAsset('both', 'SM_Chair_Wood')
    insertAsset('fts_only', 'SM_Chair_Metal')
    insertAsset('sem_only', 'SM_Stool_Plastic')
    sync()
    const idOf = (key: string): number =>
      (db.prepare('SELECT id FROM assetData WHERE assetKey = ?').get(key) as { id: number }).id

    const rows = searchAssetsByCriteria(db, {
      ftsMatch: buildFtsMatchQuery('chair')!,
      // 语义那一路把 both 排第一、sem_only 第二
      semanticIds: [idOf('both'), idOf('sem_only')]
    })

    expect(rows[0].assetKey).toBe('both')
    expect(rows.map((r) => r.assetKey).sort()).toEqual(['both', 'fts_only', 'sem_only'])
  })

  it('只有语义那一路时照样能出结果', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    insertAsset('a2', 'SM_Table_Metal')
    sync()
    const id = (
      db.prepare('SELECT id FROM assetData WHERE assetKey = ?').get('a1') as { id: number }
    ).id

    const rows = searchAssetsByCriteria(db, { semanticIds: [id] })

    expect(rows.map((r) => r.assetKey)).toEqual(['a1'])
  })

  it('筛选条件照样能把语义召回的东西挡在外面', () => {
    insertAsset('a1', 'SM_Chair_Wood', { type: 'StaticMesh' })
    sync()
    const id = (
      db.prepare('SELECT id FROM assetData WHERE assetKey = ?').get('a1') as { id: number }
    ).id

    const rows = searchAssetsByCriteria(db, { semanticIds: [id], assetTypes: ['Texture2D'] })

    expect(rows).toHaveLength(0)
  })
})

describe('索引新鲜度', () => {
  it('新建资产会进待索引队列，追平之前 ready 是 false', () => {
    insertAsset('a1', 'SM_Chair_Wood')

    expect(isAssetSearchIndexReady(db)).toBe(false)
    sync()
    expect(isAssetSearchIndexReady(db)).toBe(true)
  })

  it('改了名字，索引跟着变 —— 老名字搜不到，新名字搜得到', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    sync()

    // softPath 里也带着名字，一起改 —— 只改 assetName 的话路径列仍然命中 chair，
    // 那是索引正确工作的表现，不是漏掉了
    db.prepare('UPDATE assetData SET assetName = ?, softPath = ? WHERE assetKey = ?').run(
      'SM_Stool_Wood',
      '/Game/Props/SM_Stool_Wood',
      'a1'
    )
    sync()

    expect(searchAssetsByCriteria(db, { ftsMatch: buildFtsMatchQuery('chair')! })).toHaveLength(0)
    expect(searchAssetsByCriteria(db, { ftsMatch: buildFtsMatchQuery('stool')! })).toHaveLength(1)
  })

  it('软删除的资产会从索引里下掉', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    sync()

    db.prepare('UPDATE assetData SET isDelete = 1 WHERE assetKey = ?').run('a1')
    sync()

    expect(searchAssetsByCriteria(db, { ftsMatch: buildFtsMatchQuery('chair')! })).toHaveLength(0)
  })

  it('打标签会让这条资产重新进队列', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    sync()
    expect(isAssetSearchIndexReady(db)).toBe(true)

    db.prepare('INSERT INTO asset_tags (assetKey, tagId) VALUES (?, ?)').run('a1', 7)
    expect(isAssetSearchIndexReady(db)).toBe(false)
  })

  it('状态里的数字对得上', () => {
    insertAsset('a1', 'SM_Chair_Wood')
    insertAsset('a2', 'SM_Table_Metal')
    sync()

    const status = getAssetSearchIndexStatus(db)
    expect(status).toMatchObject({ indexed: 2, pending: 0, total: 2, ready: true })
  })
})

/**
 * 网络协作库用 INSERT OR REPLACE 按 assetKey 覆盖写入。撞上时旧行被删、换了新 id，
 * 而 SQLite 默认不为这种隐式删除触发 DELETE 触发器 —— 旧 id 的全文条目就成了孤儿。
 */
describe('按 assetKey 覆盖写入', () => {
  const ftsRows = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM assetSearchIndex').get() as { n: number }).n
  const replace = (name: string): void => {
    db.prepare(
      `INSERT OR REPLACE INTO assetData (assetKey, folderKey, assetName, isDelete) VALUES ('k1', 'k_all', ?, 0)`
    ).run(name)
  }

  it('不包的话会留下孤儿条目（复现问题本身）', () => {
    insertAsset('k1', 'SM_Rock')
    sync()
    replace('SM_Tree')
    sync()

    expect(ftsRows()).toBe(2)
  })

  it('包上之后旧条目在下一轮同步时被清掉', () => {
    insertAsset('k1', 'SM_Rock')
    sync()
    withAssetReplaceGuard(db, 'k1', () => replace('SM_Tree'))
    sync()

    expect(ftsRows()).toBe(1)
    const hits = db
      .prepare('SELECT rowid FROM assetSearchIndex WHERE assetSearchIndex MATCH ?')
      .all(buildFtsMatchQuery('rock'))
    expect(hits).toEqual([])
  })
})
