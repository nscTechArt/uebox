/**
 * @vitest-environment node
 *
 * 中文关键词落空时的自动回退。
 *
 * 资产名基本是英文而用户用中文问，这是素材库最高频的一次失败。
 * 以前工具只回一句「请换成英文词再搜」—— 调用方拿到零信息，只能凭空猜词，
 * 而这条知识被摊派到 skill 里（一整节加一张实测表）。
 * 现在工具自己去掉关键词再查一次，把库里真实存在的名字回过去。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 会被提升到文件顶部，工厂里不能引用还没初始化的 const —— 用 vi.hoisted
const { searchAssets, getDeletedAssetData, getTagByName, resolveFolder, vaultManager } = vi.hoisted(
  () => ({
    searchAssets: vi.fn(),
    getDeletedAssetData: vi.fn(),
    getTagByName: vi.fn(),
    resolveFolder: vi.fn(),
    vaultManager: {
      getAllVaults: vi.fn(),
      getCurrentVault: vi.fn(),
      withVaultDatabase: vi.fn()
    }
  })
)

/** 每个库的连接要是**稳定的对象** —— 用它来判断某一趟查的是哪个库 */
const LIBRARY_DB = { __vault: 'default' }
const AIGC_DB = { __vault: 'aigc' }

const DEFAULT_VAULT = { id: 'system_vault_default', name: '默认保管库' }
const AIGC_VAULT = { id: 'system_vault_aigc', name: 'AIGC 资产库' }
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
  searchAssets
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
vi.mock('./folderLookup', () => ({ resolveFolder }))

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

/** 两个库：默认保管库 1 个资产，AIGC 库 2 个 */
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
})

/** 取最后一次传给底层 searchAssets 的条件 */
const lastCriteria = (): Record<string, unknown> =>
  searchAssets.mock.calls[searchAssets.mock.calls.length - 1]![0] as Record<string, unknown>

describe('中文关键词落空', () => {
  it('自动去掉关键词再查一次，把库里真实存在的资产回给调用方', async () => {
    searchAssets
      .mockResolvedValueOnce({ success: true, count: 0, assets: [] })
      .mockResolvedValueOnce({ success: true, count: 2, assets: LIBRARY })

    const r = await run({ query: '椅子' })

    expect(searchAssets).toHaveBeenCalledTimes(2)
    // 第二次不带关键词
    expect(searchAssets.mock.calls[1]![0]).not.toHaveProperty('query')
    // 样本要标明每条来自哪个库 —— 否则调用方分不清它该去哪儿找
    expect(r.library_sample).toEqual(LIBRARY.map((a) => ({ ...a, vault: '默认保管库' })))
    expect(r.library_total).toBe(2)
    expect(r.dropped_query).toBe('椅子')
  })

  it('回退了必须说出来 —— 不能让调用方以为这就是搜索结果', async () => {
    searchAssets
      .mockResolvedValueOnce({ success: true, count: 0, assets: [] })
      .mockResolvedValueOnce({ success: true, count: 2, assets: LIBRARY })

    const r = await run({ query: '木头' })

    expect(String(r.hint)).toContain('中文关键词没有命中')
    // count 仍然是 0：真实的搜索结果不能被样本顶替
    expect(r.count).toBe(0)
  })

  it('其他过滤条件保留下来，回退的只是关键词', async () => {
    searchAssets
      .mockResolvedValueOnce({ success: true, count: 0, assets: [] })
      .mockResolvedValueOnce({ success: true, count: 1, assets: [LIBRARY[0]] })

    await run({ query: '椅子', assetType: 'StaticMesh' })

    expect(searchAssets.mock.calls[1]![0]).toMatchObject({ assetType: 'StaticMesh' })
  })
})

describe('不该回退的情况', () => {
  it('中文搜到了就不啰嗦 —— 中文标签本来就搜得到', async () => {
    searchAssets.mockResolvedValueOnce({ success: true, count: 1, assets: [LIBRARY[0]] })

    const r = await run({ query: '家具' })

    expect(searchAssets).toHaveBeenCalledTimes(1)
    expect(r.hint).toBeUndefined()
  })

  it('英文关键词落空是真的没有，不回退', async () => {
    searchAssets.mockResolvedValueOnce({ success: true, count: 0, assets: [] })

    const r = await run({ query: 'spaceship' })

    expect(searchAssets).toHaveBeenCalledTimes(1)
    expect(r.library_sample).toBeUndefined()
  })

  it('搜索本身失败时不回退，原样把失败报上去', async () => {
    searchAssets.mockResolvedValueOnce({ success: false, error: '数据库没打开' })

    const r = await run({ query: '椅子' })

    expect(searchAssets).toHaveBeenCalledTimes(1)
    expect(r.success).toBe(false)
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
 * 用户的资产分散在**多个保管库**里，工具过去只查当前活跃的那一个。
 *
 * 真机上这条 bug 的样子：用户的活跃库是 AIGC 库（59 个 AI 生成的图），
 * 他的 776 个素材连同 `SoStylized` 文件夹全在默认保管库里。他说
 * 「把 SoStylized 导入到项目里」，工具如实回答「整个素材库共 59 个资产，
 * 没有 SoStylized」—— 数字是真的，结论是错的，而且**错得看不出来**。
 */
describe('跨保管库', () => {
  it('默认所有库一起搜，并且标明每一条来自哪个库', async () => {
    twoVaults()

    const r = await run({ query: 'street' })

    expect(r.assets).toEqual([
      { ...LIBRARY[0], vault: '默认保管库' },
      ...AIGC_ASSETS.map((a) => ({ ...a, vault: 'AIGC 资产库' }))
    ])
  })

  it('count 是所有库之和，by_vault 说清楚各有多少', async () => {
    twoVaults()

    const r = await run({ query: 'street' })

    expect(r.count).toBe(3)
    expect(r.by_vault).toEqual({ 默认保管库: 1, 'AIGC 资产库': 2 })
    expect(r.searched_vaults).toEqual(['默认保管库', 'AIGC 资产库'])
  })

  it('站在 AIGC 库上时照样搜得到默认保管库 —— 这就是真机上翻车的那一次', async () => {
    twoVaults(AIGC_VAULT)

    const r = await run({ query: 'SoStylized' })

    // 当前库排最前，但另一个库一个都不能少
    expect(r.count).toBe(3)
    expect(r.searched_vaults).toEqual(['AIGC 资产库', '默认保管库'])
  })

  it('vault 填库名时只搜那一个', async () => {
    twoVaults()

    const r = await run({ query: 'street', vault: 'AIGC 资产库' })

    expect(searchAssets).toHaveBeenCalledTimes(1)
    expect(searchAssets.mock.calls[0]![1]).toBe(AIGC_DB)
    expect(r.count).toBe(2)
  })

  it('vault 填了不存在的库名就报错，并把有哪些库列出来', async () => {
    twoVaults()

    const r = await run({ query: 'street', vault: '不存在的库' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('默认保管库')
    expect(searchAssets).not.toHaveBeenCalled()
  })

  it('一个库坏了不拖垮其余的，但必须说出来是哪个坏了', async () => {
    twoVaults()
    searchAssets.mockImplementation(async (_p: unknown, db: unknown) => {
      if (db === AIGC_DB) throw new Error('库文件不存在')
      return { success: true, count: 1, assets: [LIBRARY[0]] }
    })

    const r = await run({ query: 'chair' })

    expect(r.success).toBe(true)
    expect(r.count).toBe(1)
    expect(String((r.unsearched_vaults as string[])[0])).toContain('AIGC 资产库')
  })

  it('所有库都坏了要报失败，不能说成「库里没有」', async () => {
    twoVaults()
    searchAssets.mockRejectedValue(new Error('数据库没打开'))

    const r = await run({ query: 'chair' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('所有保管库都没能搜到')
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

  it('所有库都认不出这个文件夹才算失败', async () => {
    twoVaults()
    resolveFolder.mockReturnValue({ error: '找不到文件夹「不存在的」' })

    const r = await run({ folder: '不存在的' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('所有保管库里都没有文件夹')
  })

  it('中文落空时的样本也要跨库取，否则样本本身就是偏的', async () => {
    twoVaults()
    searchAssets.mockImplementation(async (params: { query?: string }, db: unknown) => {
      if (params.query) return { success: true, count: 0, assets: [] }
      return db === AIGC_DB
        ? { success: true, count: 2, assets: AIGC_ASSETS }
        : { success: true, count: 1, assets: [LIBRARY[0]] }
    })

    const r = await run({ query: '椅子' })

    expect(r.library_total).toBe(3)
    expect((r.library_sample as Array<{ vault: string }>).map((a) => a.vault)).toEqual([
      '默认保管库',
      'AIGC 资产库',
      'AIGC 资产库'
    ])
  })
})
