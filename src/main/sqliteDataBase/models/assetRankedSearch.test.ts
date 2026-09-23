/**
 * @vitest-environment node
 *
 * 按相关度取「一个库的前 N 个」。
 *
 * 最要紧的一条：**不管走哪条路，结果都必须和朴素做法（回表 + 全量排序）逐条一致**。
 * 这里的三条路都是为大库提速做的，提速不许以换掉结果为代价。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { initAssetFolderModel } from './assetFolder'
import { initAssetDataModel } from './assetData'
import { initAssetTagModel } from './assetTag'
import { buildAssetQueryParts, type AssetSearchCriteria } from './assetSearch'
import {
  BM25_EXPR,
  FTS_TABLE,
  initAssetSearchIndexModel,
  isAssetSearchIndexReady,
  syncAssetSearchIndex
} from './assetSearchIndex'
import { buildFtsAllTermsQuery, buildFtsMatchQuery } from './ftsText'
import {
  compareHits,
  getAssetRowsByIds,
  rankedSearchVault,
  semanticOnlyIds,
  type RankedHit
} from './assetRankedSearch'

let db: Database.Database

function insert(
  key: string,
  name: string,
  extra: { type?: string; note?: string; path?: string; folder?: string; isDelete?: number } = {}
): number {
  const r = db
    .prepare(
      `INSERT INTO assetData (assetKey, folderKey, assetName, folderName, assetType, softPath, note, isDelete)
       VALUES (?, 'k_all', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      key,
      name,
      extra.folder ?? 'Props',
      extra.type ?? 'StaticMesh',
      extra.path ?? `/Game/Props/${name}`,
      extra.note ?? null,
      extra.isDelete ?? 0
    )
  return Number(r.lastInsertRowid)
}

function sync(): void {
  let guard = 0
  while (!isAssetSearchIndexReady(db) && guard++ < 100) syncAssetSearchIndex(db, { budget: 500 })
}

/** 朴素做法：回表 + 全量排序，按 (层, bm25, id) 取前 need 个 */
function naive(query: string, filter: AssetSearchCriteria, need: number): RankedHit[] {
  // 全中层内用全中表达式的分数（只看 name/tags/folder/type），部分层用 OR 表达式的分数
  const all = new Map(
    (
      db
        .prepare(
          `SELECT rowid AS id, ${BM25_EXPR} AS s FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ?`
        )
        .all(buildFtsAllTermsQuery(query)) as Array<{ id: number; s: number }>
    ).map((r) => [r.id, r.s])
  )
  const parts = buildAssetQueryParts(db, filter)
  const cond = parts.whereSql.replace(/^\s*WHERE\s+/i, '')
  const rows = db
    .prepare(
      `${parts.withClause} SELECT ${FTS_TABLE}.rowid AS id, ${BM25_EXPR} AS s
       FROM ${FTS_TABLE} JOIN assetData ad ON ad.id = ${FTS_TABLE}.rowid ${parts.joinSql}
       WHERE ${cond} AND ${FTS_TABLE} MATCH ?`
    )
    .all(...parts.params, buildFtsMatchQuery(query)) as Array<{ id: number; s: number }>
  return rows
    .map((r) => ({ id: r.id, tier: (all.has(r.id) ? 1 : 0) as 0 | 1, score: all.get(r.id) ?? r.s }))
    .sort(compareHits)
    .slice(0, need)
}

const ids = (hits: RankedHit[]): number[] => hits.map((h) => h.id)

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

/** 一个有点规模、名字大量重复的库：模拟一堆同风格的资源包 */
function seedPacks(copies: number): void {
  const base = [
    ['SM_Env_Tree_Pine_01', 'StaticMesh'],
    ['SM_Env_Tree_Birch_01', 'StaticMesh'],
    ['SM_Env_Rock_Large_01', 'StaticMesh'],
    ['SM_Prop_Car_01', 'StaticMesh'],
    ['SK_Chr_Soldier_01', 'SkeletalMesh'],
    ['M_Env_Tree_Bark', 'Material'],
    ['T_Env_Tree_Bark_D', 'Texture2D'],
    ['SM_Prop_Scarf_01', 'StaticMesh'],
    ['SM_Env_Grass_01', 'StaticMesh']
  ]
  for (let c = 0; c < copies; c++) {
    for (const [name, type] of base)
      insert(`${name}_${c}`, name!, { type, path: `/Game/Pack${c}/${name}` })
  }
}

describe('排序：全中的排在只中一部分的前面', () => {
  it('查询词全中的资产排第一，哪怕另一个资产 bm25 更好', () => {
    // 这个资产的名字里 car 出现很多次，bm25 很好，但没有 police
    insert('a', 'Car_Car_Car_Car')
    const target = insert('b', 'SM_Police_Car_01')
    sync()

    const r = rankedSearchVault(db, { query: 'police car', need: 5, filter: {} })!

    expect(r.hits[0]!.id).toBe(target)
    expect(r.hits[0]!.tier).toBe(1)
  })

  it('只在备注（生成提示词）里全中不算全中 —— 真机上这会把效果图顶到首页', () => {
    const aigc = insert('a', 'villa_render.png', { note: 'a lake with rock and mountain behind' })
    const real = insert('b', 'SM_Rock_Mountain_01')
    sync()

    const r = rankedSearchVault(db, { query: 'rock mountain', need: 5, filter: {} })!

    expect(r.hits[0]!.id).toBe(real)
    expect(r.hits.find((h) => h.id === aigc)?.tier).toBe(0)
  })

  it('同分的按 id 排，翻页稳定：前 10 个一定是前 20 个的前缀', () => {
    for (let i = 0; i < 30; i++) insert(`t${i}`, 'SM_Tree')
    sync()

    const a = rankedSearchVault(db, { query: 'tree', need: 10, filter: {} })!
    const b = rankedSearchVault(db, { query: 'tree', need: 20, filter: {} })!

    expect(ids(b.hits).slice(0, 10)).toEqual(ids(a.hits))
    expect(ids(b.hits)).toEqual([...ids(b.hits)].sort((x, y) => x - y))
  })
})

describe('三条路的结果都和朴素做法逐条一致', () => {
  beforeEach(() => {
    seedPacks(40)
    sync()
  })

  const queries = ['tree', 'SM_Env', 'pine tree', 'police car', 'rock', 'bark']

  it.each(queries)('纯关键词「%s」', (q) => {
    for (const need of [1, 7, 50, 200]) {
      const r = rankedSearchVault(db, { query: q, need, filter: {} })!
      expect(ids(r.hits)).toEqual(ids(naive(q, {}, need)))
    }
  })

  // 窄类型（这里 SkeletalMesh 只占 1/9）直接走类型集合；宽类型先走候选
  it.each(queries)('窄类型 → 类型集合子查询「%s」', (q) => {
    const filter = { assetTypes: ['SkeletalMesh'] }
    const r = rankedSearchVault(db, { query: q, need: 30, filter })!
    expect(r.route).toBe('filter-subquery')
    expect(ids(r.hits)).toEqual(ids(naive(q, filter, 30)))
  })

  it.each(queries)('宽类型 → 候选「%s」', (q) => {
    const filter = { assetTypes: ['StaticMesh'] }
    const r = rankedSearchVault(db, {
      query: q,
      need: 30,
      filter,
      limits: { typeSetDirectLimit: 0 }
    })!
    expect(ids(r.hits)).toEqual(ids(naive(q, filter, 30)))
  })

  it.each(queries)('宽类型但候选凑不够 → 退到类型集合子查询「%s」', (q) => {
    const filter = { assetTypes: ['Material'] }
    const r = rankedSearchVault(db, {
      query: q,
      need: 30,
      filter,
      limits: { typeSetDirectLimit: 0, candidateMultiplier: 1, candidateFloor: 1 }
    })!
    expect(ids(r.hits)).toEqual(ids(naive(q, filter, 30)))
  })

  it.each(queries)('非类型的窄筛选、候选凑不够 → JOIN「%s」', (q) => {
    // 只有 Soldier 标了引擎版本：一个非类型、而且很窄的筛选
    db.prepare("UPDATE assetData SET engineVersion = '5.1.0' WHERE assetName LIKE 'SK_%'").run()
    sync()
    const filter = { engineVersions: ['5.1'] }
    const r = rankedSearchVault(db, {
      query: q,
      need: 30,
      filter,
      limits: { candidateMultiplier: 1, candidateFloor: 1 }
    })!
    expect(ids(r.hits)).toEqual(ids(naive(q, filter, 30)))
  })

  it('确实走到了每一条路（不是全被候选挡掉了）', () => {
    db.prepare("UPDATE assetData SET engineVersion = '5.1.0' WHERE assetName LIKE 'SK_%'").run()
    sync()
    const small = { candidateMultiplier: 1, candidateFloor: 1 }
    const route = (filter: AssetSearchCriteria, limits: object = {}): string =>
      rankedSearchVault(db, { query: 'SM_Env', need: 30, filter, limits })!.route

    expect(route({ assetTypes: ['StaticMesh'] }, { typeSetDirectLimit: 0 })).toBe('candidates')
    expect(route({ assetTypes: ['SkeletalMesh'] })).toBe('filter-subquery')
    expect(route({ assetTypes: ['Material'] }, { typeSetDirectLimit: 0, ...small })).toBe(
      'filter-subquery'
    )
    expect(route({ engineVersions: ['5.1'] }, small)).toBe('join')
  })

  it('类型集合和原来的类型条件口径一致：逗号分隔的多类型也认', () => {
    const bp = insert('bp', 'BP_Tree_Spawner', { type: 'Blueprint, BlueprintGeneratedClass' })
    sync()
    const filter = { assetTypes: ['BlueprintGeneratedClass'] }

    const r = rankedSearchVault(db, { query: 'tree', need: 10, filter })!

    expect(ids(r.hits)).toEqual([bp])
    expect(ids(r.hits)).toEqual(ids(naive('tree', filter, 10)))
  })
})

describe('总数', () => {
  beforeEach(() => {
    seedPacks(20)
    sync()
  })

  it('纯关键词数得精确', () => {
    const r = rankedSearchVault(db, { query: 'tree', need: 5, filter: {} })!
    expect(r.total).toBe(naive('tree', {}, 100000).length)
    expect(r.totalIsLowerBound).toBe(false)
  })

  it('非类型筛选时数到上限就停，并说明是下限', () => {
    db.prepare("UPDATE assetData SET engineVersion = '5.1.0'").run()
    sync()
    const r = rankedSearchVault(db, {
      query: 'SM_Env',
      need: 5,
      filter: { engineVersions: ['5.1'] },
      limits: { countCap: 10 }
    })!
    expect(r.total).toBe(10)
    expect(r.totalIsLowerBound).toBe(true)
  })

  it('封顶时待索引的行也算在上限里，不能封完顶再往上加', () => {
    // 不同步：所有行都在待索引队列里，全靠 JS 比对
    db.prepare("UPDATE assetData SET engineVersion = '5.1.0'").run()
    const r = rankedSearchVault(db, {
      query: 'SM_Env',
      need: 5,
      filter: { engineVersions: ['5.1'] },
      limits: { countCap: 10 }
    })!
    expect(r.pendingSearched).toBe(true)
    expect(r.total).toBe(10)
    expect(r.totalIsLowerBound).toBe(true)
  })

  it.each([
    ['窄类型', {}],
    ['宽类型走候选', { typeSetDirectLimit: 0 }]
  ])('类型筛选的总数是精确的（%s）', (_label, limits) => {
    for (const type of ['StaticMesh', 'Material']) {
      const filter = { assetTypes: [type] }
      const r = rankedSearchVault(db, { query: 'SM_Env', need: 5, filter, limits })!
      expect(r.total).toBe(naive('SM_Env', filter, 100000).length)
      expect(r.totalIsLowerBound).toBe(false)
    }
  })
})

describe('索引里的脏数据', () => {
  it('孤儿条目（资产行已经没了）不会出现在结果里', () => {
    const live = insert('a', 'SM_Tree_A')
    sync()
    // 模拟 INSERT OR REPLACE 换 id 留下的孤儿：FTS 里有，assetData 里没有
    db.prepare(`INSERT INTO ${FTS_TABLE} (rowid, name) VALUES (9999, 'sm tree ghost')`).run()

    const r = rankedSearchVault(db, { query: 'tree', need: 10, filter: {} })!

    expect(ids(r.hits)).toEqual([live])
  })

  it('已删除的不出现', () => {
    insert('a', 'SM_Tree_A', { isDelete: 1 })
    const live = insert('b', 'SM_Tree_B')
    sync()

    const r = rankedSearchVault(db, { query: 'tree', need: 10, filter: {} })!

    expect(ids(r.hits)).toEqual([live])
  })
})

describe('索引还没追平', () => {
  it('刚改名还没进索引：新名字搜得到，旧名字搜不到', () => {
    const id = insert('a', 'SM_Rock_01')
    sync()
    db.prepare(
      `UPDATE assetData SET assetName = 'SM_Tree_01', softPath = '/Game/Props/SM_Tree_01' WHERE id = ?`
    ).run(id)

    const tree = rankedSearchVault(db, { query: 'tree', need: 10, filter: {} })!
    const rock = rankedSearchVault(db, { query: 'rock', need: 10, filter: {} })!

    expect(ids(tree.hits)).toEqual([id])
    expect(tree.pendingSearched).toBe(true)
    expect(tree.total).toBe(1)
    expect(rock.hits).toEqual([])
    expect(rock.total).toBe(0)
  })

  it.each([
    ['类型筛选（类型集合精确计数）', { assetTypes: ['StaticMesh'] }],
    ['非类型筛选（封顶计数）', { engineVersions: ['5.1'] }]
  ])('带筛选时待索引的行不重复计数：%s', (_label, filter) => {
    const id = insert('a', 'SM_Tree_01')
    insert('b', 'SM_Tree_02')
    db.prepare("UPDATE assetData SET engineVersion = '5.1.0'").run()
    sync()
    // 改名但还没进索引：FTS 里是旧内容，JS 比对又会命中一次
    db.prepare("UPDATE assetData SET assetName = 'SM_Tree_Big' WHERE id = ?").run(id)

    const r = rankedSearchVault(db, { query: 'tree', need: 1, filter })!

    expect(r.pendingSearched).toBe(true)
    expect(r.total).toBe(2)
  })

  it('没进索引的行按词前缀比对，和 FTS 口径一致：car 不命中 Scarf', () => {
    insert('a', 'SM_Prop_Scarf_01')
    const car = insert('b', 'SM_Prop_Car_01')

    const r = rankedSearchVault(db, { query: 'car', need: 10, filter: {} })!

    expect(ids(r.hits)).toEqual([car])
  })

  it('没进索引的行也分层：名字全中的排在只中一部分的前面', () => {
    const partial = insert('a', 'SM_Car_01')
    const full = insert('b', 'SM_Police_Car_01')

    const r = rankedSearchVault(db, { query: 'police car', need: 10, filter: {} })!

    expect(r.hits.map((h) => [h.id, h.tier])).toEqual([
      [full, 1],
      [partial, 0]
    ])
  })

  it('待索引太多时不扫，结果里明说有多少没算进来', () => {
    insert('a', 'SM_Tree_01')
    insert('b', 'SM_Tree_02')

    const r = rankedSearchVault(db, {
      query: 'tree',
      need: 10,
      filter: {},
      limits: { pendingScanLimit: 1 }
    })!

    expect(r.pendingSearched).toBe(false)
    expect(r.indexPending).toBe(2)
    expect(r.hits).toEqual([])
  })
})

describe('查询表达式', () => {
  it('纯中文、中英混合都不报错', () => {
    insert('a', '木头椅子')
    const mixed = insert('b', 'SM_木头椅子')
    sync()

    expect(ids(rankedSearchVault(db, { query: '椅子', need: 10, filter: {} })!.hits)).toHaveLength(
      2
    )
    expect(rankedSearchVault(db, { query: 'SM 椅子', need: 10, filter: {} })!.hits[0]!.id).toBe(
      mixed
    )
    expect(rankedSearchVault(db, { query: '马', need: 10, filter: {} })!.hits).toEqual([])
  })

  it('没有能搜的字符时交还给调用方', () => {
    expect(rankedSearchVault(db, { query: '!!!', need: 10, filter: {} })).toBeNull()
  })
})

describe('辅助函数', () => {
  it('semanticOnlyIds 只留全文没中、且满足筛选的，保持传入顺序', () => {
    const tree = insert('a', 'SM_Tree')
    const horse = insert('b', 'SK_Horse', { type: 'SkeletalMesh' })
    const mp3 = insert('c', 'bgm.mp3', { type: 'Audio' })
    const gone = insert('d', 'SK_Pony', { type: 'SkeletalMesh', isDelete: 1 })
    sync()

    expect(semanticOnlyIds(db, [mp3, tree, horse, gone], 'tree', {})).toEqual([mp3, horse])
    expect(semanticOnlyIds(db, [mp3, horse], 'tree', { assetTypes: ['SkeletalMesh'] })).toEqual([
      horse
    ])
  })

  it('getAssetRowsByIds 按传入顺序回整行', () => {
    const a = insert('a', 'A')
    const b = insert('b', 'B')

    const rows = getAssetRowsByIds(db, [b, a]) as Array<{ assetName: string }>

    expect(rows.map((r) => r.assetName)).toEqual(['B', 'A'])
  })
})
