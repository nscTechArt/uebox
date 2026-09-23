/**
 * @vitest-environment node
 *
 * search_assets 工具层：跨库归并、放宽、中文回退、语义单列、各种「说清楚」。
 *
 * 单个库里怎么按相关度取前 N 个，在 models/assetRankedSearch.test.ts 里用真 SQLite 测；
 * 这里把它 mock 掉，只测工具怎么把各库的结果拼起来、怎么对调用方说话。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 会被提升到文件顶部，工厂里不能引用还没初始化的 const —— 用 vi.hoisted
const {
  searchAssets,
  getDeletedAssetData,
  getTagByName,
  resolveFolder,
  vaultManager,
  rankedSearchVault,
  semanticOnlyIds,
  getAssetRowsByIds,
  isAssetVectorEnabled,
  semanticRecall,
  embedSearchQuery,
  ensureAssetSearchIndexWarm
} = vi.hoisted(() => ({
  searchAssets: vi.fn(),
  getDeletedAssetData: vi.fn(),
  getTagByName: vi.fn(),
  resolveFolder: vi.fn(),
  vaultManager: {
    getAllVaults: vi.fn(),
    getCurrentVault: vi.fn(),
    withVaultDatabase: vi.fn()
  },
  rankedSearchVault: vi.fn(),
  semanticOnlyIds: vi.fn(),
  getAssetRowsByIds: vi.fn(),
  isAssetVectorEnabled: vi.fn(),
  semanticRecall: vi.fn(),
  embedSearchQuery: vi.fn(),
  ensureAssetSearchIndexWarm: vi.fn()
}))

/** 每个库的连接要是**稳定的对象** —— 用它来判断某一趟查的是哪个库 */
const LIBRARY_DB = { __vault: 'default' }
const AIGC_DB = { __vault: 'aigc' }

const DEFAULT_VAULT = { id: 'system_vault_default', name: '默认保管库', path: 'C:/v/default' }
const AIGC_VAULT = { id: 'system_vault_aigc', name: 'AIGC 资产库', path: 'C:/v/aigc' }
const DB_BY_VAULT: Record<string, unknown> = {
  [DEFAULT_VAULT.id]: LIBRARY_DB,
  [AIGC_VAULT.id]: AIGC_DB
}

/**
 * 这台机器上有哪几个保管库、当前站在哪个上。
 *
 * 默认只有一个 —— 单库的行为是绝大多数用例的前提。要测跨库的用例自己调它。
 */
const setupVaults = (vaults: Array<{ id: string; name: string }>, current = vaults[0]): void => {
  vaultManager.getAllVaults.mockReturnValue(vaults)
  vaultManager.getCurrentVault.mockReturnValue(current ?? null)
  vaultManager.withVaultDatabase.mockImplementation(
    async (id: string, op: (db: unknown) => unknown) => await op(DB_BY_VAULT[id])
  )
}

vi.mock('../../../../agent/tools/app-control/asset-manager/AssetSearcher', () => ({
  searchAssets,
  // 筛选条件原样透传，方便断言传下去的是什么
  buildSearchCriteria: (params: Record<string, unknown>) => ({ ...params }),
  attachTagNames: () => {}
}))
vi.mock('../../../../agent/tools/app-control/asset-manager/AssetFormatter', () => ({
  formatAssets: (rows: unknown[]) => rows
}))
vi.mock('../../../../sqliteDataBase', () => ({
  getPublicDatabase: () => ({}),
  getVaultDatabase: () => LIBRARY_DB,
  getDatabaseManager: () => ({ getVaultManager: () => vaultManager })
}))
vi.mock('../../../../sqliteDataBase/models/assetData', () => ({ getDeletedAssetData }))
vi.mock('../../../../sqliteDataBase/models/tag', () => ({ getTagByName }))
vi.mock('../../../../sqliteDataBase/models/assetRankedSearch', async (importOriginal) => ({
  compareScores: (
    await importOriginal<typeof import('../../../../sqliteDataBase/models/assetRankedSearch')>()
  ).compareScores,
  rankedSearchVault,
  semanticOnlyIds,
  getAssetRowsByIds
}))
vi.mock('../../../../sqliteDataBase/models/assetVectorIndex', () => ({ isAssetVectorEnabled }))
vi.mock('../../../../sqliteDataBase/services/assetSemanticService', () => ({
  semanticRecall,
  embedSearchQuery
}))
vi.mock('./folderLookup', () => ({ resolveFolder }))
vi.mock('../../../../sqliteDataBase/services/assetSearchIndexService', () => ({
  ensureAssetSearchIndexWarm
}))

import { createSearchAssetsTool } from './searchAssets'

const tool = createSearchAssetsTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

const LIBRARY = [
  { name: 'SM_Chair_Wood', assetType: 'StaticMesh' },
  { name: 'T_Wood_Diffuse', assetType: 'Texture2D' }
]

const AIGC_ASSETS = [
  { name: '赛博朋克街道_1.png', assetType: 'AIGC', real_path: 'C:/vault/aigc/AIGC/图片/a.png' },
  { name: '赛博朋克街道_2.png', assetType: 'AIGC', real_path: 'C:/vault/aigc/AIGC/图片/b.png' }
]

/** 库里的行：id → 整行（getAssetRowsByIds 的 mock 按 id 回） */
const ROWS: Record<string, Record<number, Record<string, unknown>>> = {
  default: {
    1: { id: 1, name: 'SM_Chair_Wood', assetType: 'StaticMesh' },
    2: { id: 2, name: 'SM_Police_Car_01', assetType: 'StaticMesh', engineVersion: '5.7.0' }
  },
  aigc: {
    11: { id: 11, name: 'chair_render.png', assetType: 'AIGC' },
    12: { id: 12, name: 'bgm.mp3', assetType: 'AIGC' },
    13: { id: 13, name: 'horse_photo.png', assetType: 'AIGC' }
  }
}

type Hit = { id: number; tier: 0 | 1; score: number }
const ranked = (hits: Hit[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  hits,
  total: hits.length,
  totalIsLowerBound: false,
  indexPending: 0,
  pendingSearched: false,
  route: 'candidates',
  ...extra
})

/** 两个库：默认保管库 1 个资产，AIGC 库 2 个（浏览模式用） */
const twoVaults = (current = DEFAULT_VAULT): void => {
  setupVaults([DEFAULT_VAULT, AIGC_VAULT], current)
  searchAssets.mockImplementation(async (_params: unknown, db: unknown) =>
    db === AIGC_DB
      ? { success: true, count: AIGC_ASSETS.length, assets: AIGC_ASSETS }
      : { success: true, count: 1, assets: [LIBRARY[0]] }
  )
}

beforeEach(() => {
  searchAssets.mockReset().mockResolvedValue({ success: true, count: 0, assets: [] })
  // 默认：只有一个保管库。跨库的用例自己调 twoVaults()。
  vaultManager.getAllVaults.mockReset()
  vaultManager.getCurrentVault.mockReset()
  vaultManager.withVaultDatabase.mockReset()
  setupVaults([DEFAULT_VAULT])
  getDeletedAssetData.mockReset().mockReturnValue({ list: [], total: 0 })
  // 默认：库里每个标签名都认得，id 按名字长度随便给一个
  getTagByName.mockReset().mockImplementation((_db: unknown, name: string) => ({
    id: name.length,
    name
  }))
  resolveFolder.mockReset().mockReturnValue({
    folderKey: 'k_tree',
    folder: { folderKey: 'k_tree', folderName: 'Trees', fullPath: '/Trees' }
  })
  rankedSearchVault.mockReset().mockReturnValue(ranked([]))
  semanticOnlyIds.mockReset().mockImplementation((_db: unknown, ids: number[]) => ids)
  getAssetRowsByIds
    .mockReset()
    .mockImplementation((db: { __vault: string }, ids: number[]) =>
      ids.map((id) => ROWS[db.__vault]![id]).filter(Boolean)
    )
  isAssetVectorEnabled.mockReset().mockReturnValue(false)
  semanticRecall.mockReset().mockResolvedValue([])
  embedSearchQuery.mockReset().mockResolvedValue([0.1, 0.2])
})

/** 取最后一次传给底层 searchAssets 的条件 */
const lastCriteria = (): Record<string, unknown> =>
  searchAssets.mock.calls[searchAssets.mock.calls.length - 1]![0] as Record<string, unknown>

/** 取最后一次传给 rankedSearchVault 的筛选条件 */
const lastRankedFilter = (): Record<string, unknown> =>
  (
    rankedSearchVault.mock.calls[rankedSearchVault.mock.calls.length - 1]![1] as {
      filter: Record<string, unknown>
    }
  ).filter

/**
 * 真机上的那一次：用户站在 AIGC 库（155 个 AI 图），搜 horse / grass / SM_Env，
 * 8 次里 7 次首页全是 AIGC 的东西 —— 因为关键词结果也是「当前库排最前、首尾相接」。
 */
describe('关键词：所有库按相关度统一排序', () => {
  it('另一个库里全中的排在当前库只中一部分的前面', async () => {
    setupVaults([DEFAULT_VAULT, AIGC_VAULT], AIGC_VAULT)
    rankedSearchVault.mockImplementation((db: unknown) =>
      db === AIGC_DB
        ? ranked([{ id: 11, tier: 0, score: -9 }])
        : ranked([{ id: 2, tier: 1, score: -3 }])
    )

    const r = await run({ query: 'police car' })

    expect(
      (r.assets as Array<{ name: string; vault: string }>).map((a) => [a.name, a.vault])
    ).toEqual([
      ['SM_Police_Car_01', '默认保管库'],
      ['chair_render.png', 'AIGC 资产库']
    ])
  })

  it('同层按分数、同分按库顺序排', async () => {
    twoVaults()
    rankedSearchVault.mockImplementation((db: unknown) =>
      db === AIGC_DB
        ? ranked([
            { id: 11, tier: 1, score: -5 },
            { id: 12, tier: 1, score: -2 }
          ])
        : ranked([{ id: 1, tier: 1, score: -2 }])
    )

    const r = await run({ query: 'chair' })

    expect((r.assets as Array<{ name: string }>).map((a) => a.name)).toEqual([
      'chair_render.png',
      'SM_Chair_Wood',
      'bgm.mp3'
    ])
  })

  it('每个库要的是前 offset+limit 个，工具再切出这一页', async () => {
    twoVaults()
    rankedSearchVault.mockImplementation((db: unknown) =>
      db === AIGC_DB
        ? ranked([
            { id: 11, tier: 1, score: -5 },
            { id: 12, tier: 0, score: -1 }
          ])
        : ranked([
            { id: 1, tier: 1, score: -4 },
            { id: 2, tier: 0, score: -2 }
          ])
    )

    const r = await run({ query: 'chair', offset: 1, limit: 2 })

    expect((rankedSearchVault.mock.calls[0]![1] as { need: number }).need).toBe(3)
    expect((r.assets as Array<{ name: string }>).map((a) => a.name)).toEqual([
      'SM_Chair_Wood',
      'SM_Police_Car_01'
    ])
    expect(r.nextOffset).toBe(3)
  })

  it('count 是各库之和，by_vault 各库分列', async () => {
    twoVaults()
    rankedSearchVault.mockImplementation((db: unknown) =>
      db === AIGC_DB
        ? ranked([{ id: 11, tier: 1, score: -1 }], { total: 40 })
        : ranked([{ id: 1, tier: 1, score: -1 }], { total: 3 })
    )

    const r = await run({ query: 'chair' })

    expect(r.count).toBe(43)
    expect(r.by_vault).toEqual({ 默认保管库: 3, 'AIGC 资产库': 40 })
    expect(r.searched_vaults).toEqual(['默认保管库', 'AIGC 资产库'])
  })

  it('某个库数到上限停下时，count 标成下限', async () => {
    rankedSearchVault.mockReturnValue(
      ranked([{ id: 1, tier: 1, score: -1 }], { total: 1000, totalIsLowerBound: true })
    )

    const r = await run({ query: 'chair', assetType: 'StaticMesh', limit: 1 })

    expect(r.count_is_lower_bound).toBe(true)
    expect(r.hasMore).toBe(true)
    expect(String(r.message)).toContain('1000+')
  })

  /**
   * 总数是全文索引表数的，可能比回得了表的多（旧的孤儿行）。翻到头那一页一个都没有时
   * 还说「后面还有，用 offset=N 再调」，N 又正好是这一次的 offset —— 模型会一直重调。
   */
  it('这一页一个都没拿到时不说「后面还有」', async () => {
    rankedSearchVault.mockReturnValue(ranked([{ id: 1, tier: 1, score: -1 }], { total: 2 }))

    const r = await run({ query: 'tree', offset: 1 })

    expect(r.hasMore).toBeUndefined()
    expect(String(r.message)).not.toContain('offset=')
  })

  it('筛选条件逐库透传，不带 relax（放宽由工具层统一做）', async () => {
    rankedSearchVault.mockReturnValue(ranked([{ id: 1, tier: 1, score: -1 }]))

    await run({ query: 'chair', folder: 'Trees', assetType: 'StaticMesh' })

    expect(lastRankedFilter()).toMatchObject({
      folderKey: 'k_tree',
      includeSubfolders: true,
      assetType: 'StaticMesh',
      relax: false
    })
  })

  it('还没建完索引的库要说出来', async () => {
    rankedSearchVault.mockReturnValue(
      ranked([{ id: 1, tier: 1, score: -1 }], { indexPending: 50000 })
    )

    const r = await run({ query: 'chair' })

    expect(r.index_pending).toEqual({ 默认保管库: 50000 })
    expect(String(r.message)).toContain('还没建完索引')
    // 「过一会儿再搜」得是真的：这一搜顺手把后台补齐推起来，不然队列会一直躺着
    expect(ensureAssetSearchIndexWarm).toHaveBeenCalledWith(LIBRARY_DB, expect.anything())
  })

  it('一个库坏了不拖垮其余的，但必须说出来是哪个坏了', async () => {
    twoVaults()
    rankedSearchVault.mockImplementation((db: unknown) => {
      if (db === AIGC_DB) throw new Error('库文件不存在')
      return ranked([{ id: 1, tier: 1, score: -1 }])
    })

    const r = await run({ query: 'chair' })

    expect(r.success).toBe(true)
    expect(r.count).toBe(1)
    expect(String((r.unsearched_vaults as string[])[0])).toContain('AIGC 资产库')
  })

  it('所有库都坏了要报失败，不能说成「库里没有」', async () => {
    twoVaults()
    rankedSearchVault.mockImplementation(() => {
      throw new Error('数据库没打开')
    })

    const r = await run({ query: 'chair' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('所有保管库都没能搜到')
  })

  it('vault 填库名时只搜那一个', async () => {
    twoVaults()
    rankedSearchVault.mockReturnValue(ranked([{ id: 11, tier: 1, score: -1 }]))

    const r = await run({ query: 'street', vault: 'AIGC 资产库' })

    expect(rankedSearchVault).toHaveBeenCalledTimes(1)
    expect(rankedSearchVault.mock.calls[0]![0]).toBe(AIGC_DB)
    expect(r.count).toBe(1)
  })

  it('vault 填了不存在的库名就报错，并把有哪些库列出来', async () => {
    twoVaults()

    const r = await run({ query: 'street', vault: '不存在的库' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('默认保管库')
    expect(rankedSearchVault).not.toHaveBeenCalled()
  })

  it('没有全文索引表的老库退回老路，排在有分数的结果后面', async () => {
    twoVaults()
    rankedSearchVault.mockImplementation((db: unknown) =>
      db === AIGC_DB ? null : ranked([{ id: 1, tier: 0, score: -1 }])
    )

    const r = await run({ query: 'street' })

    expect((r.assets as Array<{ name: string }>).map((a) => a.name)).toEqual([
      'SM_Chair_Wood',
      ...AIGC_ASSETS.map((a) => a.name)
    ])
    expect(r.count).toBe(3)
  })
})

describe('没有全文索引表的老库', () => {
  it('按 500 一页取到 offset+limit 为止，深翻页不漏', async () => {
    rankedSearchVault.mockReturnValue(null)
    const page = (n: number): Array<{ name: string }> =>
      Array.from({ length: n }, (_, i) => ({ name: `SM_Tree_${i}` }))
    searchAssets.mockImplementation(async (p: { offset: number; limit: number }) => ({
      success: true,
      count: 3000,
      assets: page(p.limit)
    }))

    const r = await run({ query: 'tree', offset: 600, limit: 100 })

    expect(
      searchAssets.mock.calls.map((c) => [
        (c[0] as { offset: number }).offset,
        (c[0] as { limit: number }).limit
      ])
    ).toEqual([
      [0, 500],
      [500, 200]
    ])
    expect(r.returnedCount).toBe(100)
  })
})

describe('AIGC 导入提示只在这一页真有 AIGC 资产时出现', () => {
  it('页里没有 AIGC 的就不说', async () => {
    twoVaults()
    rankedSearchVault.mockImplementation((db: unknown) =>
      db === AIGC_DB ? ranked([]) : ranked([{ id: 1, tier: 1, score: -1 }])
    )

    const r = await run({ query: 'chair' })

    expect(String(r.message)).not.toContain('ue_content_import')
  })

  it('页里有就说', async () => {
    twoVaults()
    rankedSearchVault.mockImplementation((db: unknown) =>
      db === AIGC_DB ? ranked([{ id: 11, tier: 1, score: -1 }]) : ranked([])
    )

    const r = await run({ query: 'chair' })

    expect(String(r.message)).toContain('ue_content_import')
  })
})

describe('语义命中单独列出，不混进结果、不计数', () => {
  it('纯语义命中进 semantic_matches，count 只算全文', async () => {
    setupVaults([DEFAULT_VAULT, AIGC_VAULT], AIGC_VAULT)
    isAssetVectorEnabled.mockImplementation((db: unknown) => db === AIGC_DB)
    semanticRecall.mockResolvedValue([12, 13])
    rankedSearchVault.mockImplementation((db: unknown) =>
      db === AIGC_DB ? ranked([]) : ranked([{ id: 2, tier: 1, score: -1 }])
    )

    const r = await run({ query: 'horse' })

    expect(r.count).toBe(1)
    expect((r.assets as Array<{ name: string }>).map((a) => a.name)).toEqual(['SM_Police_Car_01'])
    expect(
      (r.semantic_matches as Array<{ name: string; vault: string }>).map((a) => a.name)
    ).toEqual(['bgm.mp3', 'horse_photo.png'])
    expect(String(r.semantic_note)).toContain('不算进 count')
  })

  it('字面结果已经填满一页时不带语义那几个 —— 它们只会白占上下文', async () => {
    isAssetVectorEnabled.mockReturnValue(true)
    semanticRecall.mockResolvedValue([12])
    rankedSearchVault.mockReturnValue(
      ranked(
        [
          { id: 1, tier: 1, score: -2 },
          { id: 2, tier: 1, score: -1 }
        ],
        { total: 65 }
      )
    )

    const r = await run({ query: 'pine tree', limit: 2 })

    expect(r.semantic_matches).toBeUndefined()
  })

  it('查询向量整次调用只算一次，各库复用', async () => {
    twoVaults()
    isAssetVectorEnabled.mockReturnValue(true)
    semanticRecall.mockImplementation(
      async (_db: unknown, _q: string, _k: unknown, getEmbedding: () => Promise<unknown>) => {
        await getEmbedding()
        return []
      }
    )

    await run({ query: 'horse' })

    expect(semanticRecall).toHaveBeenCalledTimes(2)
    expect(embedSearchQuery).toHaveBeenCalledTimes(1)
  })
})

describe('放宽：只在所有库都落空时做一次', () => {
  it('一个库有真命中时，别的库不放宽', async () => {
    twoVaults()
    rankedSearchVault.mockImplementation((db: unknown) =>
      db === AIGC_DB ? ranked([]) : ranked([{ id: 1, tier: 1, score: -1 }])
    )

    const r = await run({ query: 'chair', assetType: 'SkeletalMesh' })

    expect(r.relaxed).toBeUndefined()
    // 每个库只搜了一次
    expect(rankedSearchVault).toHaveBeenCalledTimes(2)
  })

  it('全部落空：去掉类型/格式重搜一次，并明说「这些不是你要的类型」', async () => {
    rankedSearchVault.mockImplementation(
      (_db: unknown, opts: { filter: Record<string, unknown> }) =>
        opts.filter.assetType ? ranked([]) : ranked([{ id: 1, tier: 1, score: -1 }])
    )

    const r = await run({ query: 'chair', assetType: 'SkeletalMesh' })

    expect(r.relaxed).toBe(true)
    expect(r.count).toBe(1)
    expect(String(r.message)).toContain('不是你要的那个类型')
  })

  it('浏览模式也一样：底层不许自己放宽', async () => {
    await run({ assetType: 'SkeletalMesh' })

    expect(lastCriteria().relax).toBe(false)
  })
})

describe('中文关键词落空', () => {
  it('自动去掉关键词再查一次，把库里真实存在的资产回给调用方', async () => {
    searchAssets.mockResolvedValue({ success: true, count: 2, assets: LIBRARY })

    const r = await run({ query: '椅子' })

    // 样本那一次不带关键词
    expect(lastCriteria()).not.toHaveProperty('query')
    // 样本要标明每条来自哪个库 —— 否则调用方分不清它该去哪儿找
    expect(r.library_sample).toEqual(LIBRARY.map((a) => ({ ...a, vault: '默认保管库' })))
    expect(r.library_total).toBe(2)
    expect(r.dropped_query).toBe('椅子')
  })

  it('回退了必须说出来 —— 不能让调用方以为这就是搜索结果', async () => {
    searchAssets.mockResolvedValue({ success: true, count: 2, assets: LIBRARY })

    const r = await run({ query: '木头' })

    expect(String(r.hint)).toContain('中文关键词没有命中')
    // count 仍然是 0：真实的搜索结果不能被样本顶替
    expect(r.count).toBe(0)
  })

  it('其他过滤条件保留下来，回退的只是关键词', async () => {
    searchAssets.mockResolvedValue({ success: true, count: 1, assets: [LIBRARY[0]] })

    await run({ query: '椅子', assetType: 'StaticMesh' })

    expect(lastCriteria()).toMatchObject({ assetType: 'StaticMesh' })
  })

  it('没开语义时提示可以去开；开了就不再这么说', async () => {
    const off = await run({ query: '椅子' })
    expect(String(off.hint)).toContain('语义搜索')

    isAssetVectorEnabled.mockReturnValue(true)
    const on = await run({ query: '椅子' })
    expect(String(on.hint)).not.toContain('语义搜索')
  })

  it('样本那一次允许底层放宽 —— 类型落空时样本不能是空的', async () => {
    searchAssets.mockResolvedValue({ success: true, count: 1, assets: [LIBRARY[0]] })

    await run({ query: '椅子', assetType: 'Foliage' })

    expect(lastCriteria().relax).toBeUndefined()
  })

  it('样本轮流从各库取 —— 只从排在前面的库取，样本本身就是偏的', async () => {
    setupVaults([DEFAULT_VAULT, AIGC_VAULT], AIGC_VAULT)
    searchAssets.mockImplementation(async (_params: unknown, db: unknown) =>
      db === AIGC_DB
        ? { success: true, count: 2, assets: AIGC_ASSETS }
        : { success: true, count: 2, assets: LIBRARY }
    )

    const r = await run({ query: '椅子' })

    expect(r.library_total).toBe(4)
    expect((r.library_sample as Array<{ vault: string }>).map((a) => a.vault)).toEqual([
      'AIGC 资产库',
      '默认保管库',
      'AIGC 资产库',
      '默认保管库'
    ])
  })
})

describe('不该回退的情况', () => {
  it('中文搜到了就不啰嗦 —— 中文标签本来就搜得到', async () => {
    rankedSearchVault.mockReturnValue(ranked([{ id: 1, tier: 1, score: -1 }]))

    const r = await run({ query: '家具' })

    expect(searchAssets).not.toHaveBeenCalled()
    expect(r.hint).toBeUndefined()
  })

  it('英文关键词落空是真的没有，不回退', async () => {
    const r = await run({ query: 'spaceship' })

    expect(searchAssets).not.toHaveBeenCalled()
    expect(r.library_sample).toBeUndefined()
  })

  it('搜索本身失败时不回退，原样把失败报上去', async () => {
    rankedSearchVault.mockImplementation(() => {
      throw new Error('数据库没打开')
    })

    const r = await run({ query: '椅子' })

    expect(searchAssets).not.toHaveBeenCalled()
    expect(r.success).toBe(false)
  })
})

describe('翻页窗口', () => {
  it('offset + limit 超过 1 万直接说该收窄条件', async () => {
    const r = await run({ query: 'tree', offset: 9950, limit: 100 })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('收窄条件')
    expect(rankedSearchVault).not.toHaveBeenCalled()
  })
})

/**
 * 底层 `AssetSearchCriteria` 一直支持按文件夹 / 标签 / 收藏 / 时间筛，
 * 工具层长期没透出来 —— 于是「Trees 文件夹里有什么」只能全库翻页去凑。
 */
describe('透传给底层的筛选条件', () => {
  it('文件夹按名字给就行，默认连子文件夹一起搜', async () => {
    const r = await run({ folder: 'Trees' })

    expect(lastCriteria()).toMatchObject({ folderKey: 'k_tree', includeSubfolders: true })
    expect(r.searched_folder).toBe('/Trees')
  })

  it('显式关掉子文件夹', async () => {
    await run({ folder: 'Trees', includeSubfolders: false })
    expect(lastCriteria().includeSubfolders).toBe(false)
  })

  it('文件夹认不准时整个查询不发出去，把原因原样报上来', async () => {
    resolveFolder.mockReturnValue({ error: '库里有 2 个叫「Trees」的文件夹' })

    const r = await run({ folder: 'Trees' })

    expect(r.success).toBe(false)
    expect(searchAssets).not.toHaveBeenCalled()
  })

  it('标签名换成 id 再往下传，匹配方式默认 any', async () => {
    await run({ tags: ['角色'] })

    expect(lastCriteria().tagFilter).toEqual({ includeTagIds: [2], matchMode: 'any' })
  })

  it('tagsMatch: all 要求全都有', async () => {
    await run({ tags: ['角色', '武器'], tagsMatch: 'all' })

    expect(lastCriteria().tagFilter).toMatchObject({ matchMode: 'all' })
  })

  it('标签名库里没有时直接报错 —— 否则筛选条件为空会把全库当成筛选结果回去', async () => {
    getTagByName.mockReturnValue(undefined)

    const r = await run({ tags: ['不存在的标签'] })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('不存在的标签')
    expect(searchAssets).not.toHaveBeenCalled()
  })

  it('排除标签里有不存在的名字：照常搜，但要说出来哪几个没起作用', async () => {
    getTagByName.mockImplementation((_db: unknown, name: string) =>
      name === '废弃' ? undefined : { id: 7, name }
    )

    const r = await run({ excludeTags: ['废弃'] })

    expect(searchAssets).toHaveBeenCalledTimes(1)
    expect(r.ignored_exclude_tags).toEqual(['废弃'])
  })

  it('收藏筛选映射成底层的 favoriteStatus', async () => {
    await run({ favorite: true })
    expect(lastCriteria().favoriteStatus).toBe('favorite')

    await run({ favorite: false })
    expect(lastCriteria().favoriteStatus).toBe('unfavorite')
  })

  it('只给一端时间时补上另一端 —— 底层两端都要有值才生效', async () => {
    await run({ changedAfter: '2026-08-01' })

    const range = lastCriteria().dateRange as { start: string; end: string }
    expect(range.start).toBe('2026-08-01 00:00:00')
    expect(range.end.startsWith('9999')).toBe(true)
  })

  it('changedBefore 含当天整天', async () => {
    await run({ changedBefore: '2026-08-31' })

    const range = lastCriteria().dateRange as { start: string; end: string }
    expect(range.end).toBe('2026-08-31 23:59:59')
  })
})

describe('回收站', () => {
  it('deleted: true 走另一条查询，并告诉调用方还能恢复', async () => {
    getDeletedAssetData.mockReturnValue({
      list: [{ assetKey: 'd1', assetName: 'SM_Tree' }],
      total: 3
    })

    const r = await run({ deleted: true, limit: 1 })

    expect(searchAssets).not.toHaveBeenCalled()
    expect(r.count).toBe(3)
    expect(r.hasMore).toBe(true)
    expect(r.nextOffset).toBe(1)
    expect(String(r.message)).toContain('restore_assets')
  })

  it('回收站不支持别的筛选，明说而不是悄悄忽略', async () => {
    const r = await run({ deleted: true, folder: 'Trees' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('folder')
    expect(getDeletedAssetData).not.toHaveBeenCalled()
  })

  it('回收站只查当前库，显式给了 vault 就报错而不是悄悄按主库回收站回答', async () => {
    const r = await run({ deleted: true, vault: 'aigc' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('vault')
    expect(getDeletedAssetData).not.toHaveBeenCalled()
  })
})

/**
 * 浏览（没有关键词）没有相关度可比，仍是当前库在前、首尾相接。
 *
 * 真机上这条 bug 的样子：用户的活跃库是 AIGC 库（59 个 AI 生成的图），
 * 他的 776 个素材连同 `SoStylized` 文件夹全在默认保管库里。他说
 * 「把 SoStylized 导入到项目里」，工具如实回答「整个素材库共 59 个资产，
 * 没有 SoStylized」—— 数字是真的，结论是错的，而且**错得看不出来**。
 */
describe('浏览：跨保管库', () => {
  it('默认所有库一起列，并且标明每一条来自哪个库', async () => {
    twoVaults()

    const r = await run({})

    expect(r.assets).toEqual([
      { ...LIBRARY[0], vault: '默认保管库' },
      ...AIGC_ASSETS.map((a) => ({ ...a, vault: 'AIGC 资产库' }))
    ])
    expect(r.count).toBe(3)
    expect(r.by_vault).toEqual({ 默认保管库: 1, 'AIGC 资产库': 2 })
  })

  it('站在 AIGC 库上时照样列得到默认保管库', async () => {
    twoVaults(AIGC_VAULT)

    const r = await run({})

    expect(r.count).toBe(3)
    expect(r.searched_vaults).toEqual(['AIGC 资产库', '默认保管库'])
  })

  it('文件夹只在其中一个库里存在时照样搜得到', async () => {
    twoVaults()
    resolveFolder.mockImplementation((db: unknown) =>
      db === AIGC_DB
        ? { folderKey: 'AIGC_image', folder: { folderName: '图片', fullPath: '/AIGC/图片' } }
        : { error: '找不到文件夹「图片」' }
    )

    const r = await run({ folder: '图片' })

    expect(r.success).toBe(true)
    expect(r.count).toBe(2)
    expect(r.searched_folder).toBe('/AIGC/图片')
  })

  it('所有库都认不出这个文件夹才算失败，报错只说一次', async () => {
    twoVaults()
    resolveFolder.mockReturnValue({ error: '找不到文件夹「不存在的」' })

    const r = await run({ folder: '不存在的' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('所有保管库里都没有文件夹')
    expect(String(r.error)).toContain('默认保管库、AIGC 资产库')
    expect(String(r.error)).not.toContain('create_folders')
  })

  it('同名文件夹不止一个是「认不准」，不能报成「没有」，原因原样带上', async () => {
    twoVaults()
    resolveFolder.mockReturnValue({
      error: '库里有 2 个叫「Trees」的文件夹，不知道你要哪一个：/A/Trees、/B/Trees。'
    })

    const r = await run({ folder: 'Trees' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('认不准')
    expect(String(r.error)).toContain('/A/Trees')
    expect(String(r.error)).not.toContain('都没有文件夹')
  })

  it('一个库认出来了、另一个库认不准：照常搜，但说出来哪个库没搜', async () => {
    twoVaults()
    resolveFolder.mockImplementation((db: unknown) =>
      db === AIGC_DB
        ? { error: '库里有 2 个叫「Trees」的文件夹' }
        : { folderKey: 'k_tree', folder: { folderName: 'Trees', fullPath: '/Trees' } }
    )

    const r = await run({ folder: 'Trees' })

    expect(r.success).toBe(true)
    expect(String((r.folder_unresolved as string[])[0])).toContain('AIGC 资产库')
  })

  it('folder 填的其实是库名：直接指出来，让它用 vault', async () => {
    twoVaults()
    resolveFolder.mockReturnValue({ error: '找不到文件夹' })

    const r = await run({ folder: 'AIGC 资产库' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('vault: "AIGC 资产库"')
  })
})
