/**
 * @vitest-environment node
 *
 * 素材库的移动工具。
 *
 * 守三条：目标文件夹认不准就**不动手**（重名会搬错地方且无声无息）、
 * 搬完回读确认、一条失败不带垮整批。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAssetDataByKey,
  updateAssetData,
  pushAssetUpdate,
  getCurrentRemoteHttpVaultContext,
  resolveFolder,
  selectFolderAssetKeys,
  send
} = vi.hoisted(() => ({
  getAssetDataByKey: vi.fn(),
  updateAssetData: vi.fn(),
  pushAssetUpdate: vi.fn(),
  getCurrentRemoteHttpVaultContext: vi.fn(),
  resolveFolder: vi.fn(),
  selectFolderAssetKeys: vi.fn(),
  send: vi.fn()
}))

vi.mock('../../../../sqliteDataBase', () => ({ getVaultDatabase: () => ({}) }))
vi.mock('../../../../sqliteDataBase/models/assetData', () => ({
  getAssetDataByKey,
  updateAssetData
}))
vi.mock('../../../../networkV2/NetworkSyncBridge', () => ({ pushAssetUpdate }))
vi.mock('../../../../networkV2/currentRemoteHttpVault', () => ({
  getCurrentRemoteHttpVaultContext
}))
vi.mock('../../../../appWindows', () => ({ getAppWindows: () => [{ webContents: { send } }] }))
vi.mock('./folderLookup', () => ({ resolveFolder }))
vi.mock('./folderAssets', () => ({ selectFolderAssetKeys }))

import { createMoveAssetsTool } from './moveAssets'

const tool = createMoveAssetsTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

/** 库里的资产，assetKey → folderKey。updateAssetData 会就地改它，回读读的也是它 */
let library: Map<string, string>

beforeEach(() => {
  library = new Map([
    ['a1', 'inbox'],
    ['a2', 'inbox']
  ])
  getAssetDataByKey
    .mockReset()
    .mockImplementation((_db: unknown, key: string) =>
      library.has(key)
        ? { assetKey: key, assetName: `SM_${key}`, folderKey: library.get(key) }
        : undefined
    )
  updateAssetData
    .mockReset()
    .mockImplementation((_db: unknown, key: string, updates: { folderKey: string }) => {
      library.set(key, updates.folderKey)
      return true
    })
  pushAssetUpdate.mockReset().mockResolvedValue({ status: 'skipped' })
  getCurrentRemoteHttpVaultContext.mockReset().mockReturnValue(null)
  resolveFolder.mockReset().mockReturnValue({
    folderKey: 'k_tree',
    folder: { folderKey: 'k_tree', folderName: 'Trees', fullPath: '/Trees' }
  })
  selectFolderAssetKeys.mockReset().mockReturnValue({
    folderKey: 'inbox',
    folderLabel: '/Inbox',
    assetKeys: ['a1', 'a2'],
    total: 2,
    offset: 0,
    hasMore: false
  })
  send.mockReset()
})

describe('正常移动', () => {
  it('改的是 folderKey，回读确认之后才算成功，并通知界面', async () => {
    const r = await run({ assetKeys: ['a1', 'a2'], targetFolder: 'Trees' })

    expect(updateAssetData).toHaveBeenCalledTimes(2)
    expect(library.get('a1')).toBe('k_tree')
    expect(r.moved_count).toBe(2)
    expect(r.success).toBe(true)
    expect(send).toHaveBeenCalledWith(
      'asset:changed',
      expect.objectContaining({ source: 'agent', op: 'move' })
    )
  })

  it('本来就在目标文件夹里的不重复搬，也不算失败', async () => {
    library.set('a1', 'k_tree')

    const r = await run({ assetKeys: ['a1'], targetFolder: 'Trees' })

    expect(updateAssetData).not.toHaveBeenCalled()
    expect((r.results as Array<{ status: string }>)[0].status).toBe('already_there')
    expect(r.success).toBe(true)
  })
})

describe('按源文件夹整批搬', () => {
  it('sourceFolder 自己展开成 assetKey，不用调用方先枚举', async () => {
    const r = await run({ sourceFolder: 'Inbox', targetFolder: 'Trees' })

    expect(updateAssetData).toHaveBeenCalledTimes(2)
    expect(r.moved_count).toBe(2)
    expect(r.source_folder).toMatchObject({ folder: '/Inbox', total: 2 })
  })

  it('默认只搬这一层 —— 连子文件夹一起搬会把层级拍平，必须显式要求', async () => {
    await run({ sourceFolder: 'Inbox', targetFolder: 'Trees' })
    expect(selectFolderAssetKeys).toHaveBeenLastCalledWith(
      expect.anything(),
      'Inbox',
      expect.objectContaining({ includeSubfolders: false })
    )

    await run({ sourceFolder: 'Inbox', targetFolder: 'Trees', includeSubfolders: true })
    expect(selectFolderAssetKeys).toHaveBeenLastCalledWith(
      expect.anything(),
      'Inbox',
      expect.objectContaining({ includeSubfolders: true })
    )
  })

  it('没搬完时告诉调用方「原样再调一次」，不给偏移量 —— 搬走的已经不在源文件夹里了', async () => {
    selectFolderAssetKeys.mockReturnValue({
      folderKey: 'inbox',
      folderLabel: '/Inbox',
      assetKeys: ['a1'],
      total: 300,
      offset: 0,
      hasMore: true,
      nextOffset: 200
    })

    const r = await run({ sourceFolder: 'Inbox', targetFolder: 'Trees' })

    expect(selectFolderAssetKeys).toHaveBeenCalledWith(
      expect.anything(),
      'Inbox',
      expect.not.objectContaining({ offset: expect.anything() })
    )
    expect(String(r.message)).toContain('再调一次')
  })

  it('一个都没搬动时不再喊「还有下一批」，否则调用方会一直转圈', async () => {
    library.set('a1', 'k_tree')
    library.set('a2', 'k_tree')
    selectFolderAssetKeys.mockReturnValue({
      folderKey: 'inbox',
      folderLabel: '/Inbox',
      assetKeys: ['a1', 'a2'],
      total: 300,
      offset: 0,
      hasMore: true,
      nextOffset: 200
    })

    const r = await run({ sourceFolder: 'Inbox', targetFolder: 'Trees' })

    expect(r.moved_count).toBe(0)
    expect((r.source_folder as { hasMore: boolean }).hasMore).toBe(false)
  })

  it('源文件夹是空的就报错，不装作搬完了', async () => {
    selectFolderAssetKeys.mockReturnValue({
      folderKey: 'inbox',
      folderLabel: '/Inbox',
      assetKeys: [],
      total: 0,
      offset: 0,
      hasMore: false
    })

    const r = await run({ sourceFolder: 'Inbox', targetFolder: 'Trees' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('没有可搬的资产')
    expect(updateAssetData).not.toHaveBeenCalled()
  })
})

describe('不动手的情况', () => {
  it('assetKeys 和 sourceFolder 都没给时不动手', async () => {
    const r = await run({ targetFolder: 'Trees' })

    expect(r.success).toBe(false)
    expect(updateAssetData).not.toHaveBeenCalled()
  })

  it('目标文件夹重名时整批不动 —— 搬错地方是无声的错误', async () => {
    resolveFolder.mockReturnValue({ error: '库里有 2 个叫「Trees」的文件夹' })

    const r = await run({ assetKeys: ['a1'], targetFolder: 'Trees' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('2 个')
    expect(updateAssetData).not.toHaveBeenCalled()
  })

  it('一次搬太多直接拒绝', async () => {
    const r = await run({
      assetKeys: Array.from({ length: 201 }, (_, i) => `k${i}`),
      targetFolder: 'Trees'
    })

    expect(r.success).toBe(false)
    expect(updateAssetData).not.toHaveBeenCalled()
  })
})

describe('搬不动的时候', () => {
  it('回读发现还在原文件夹就报「没确认」，不算成功', async () => {
    updateAssetData.mockReturnValue(false) // 底层没改成，库里还是原来的 folderKey

    const r = await run({ assetKeys: ['a1'], targetFolder: 'Trees' })

    const results = r.results as Array<{ status: string; reason?: string }>
    expect(results[0].status).toBe('unconfirmed')
    expect(results[0].reason).toContain('没有确认')
    expect(r.moved_count).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('库里没有的 assetKey 单独报，其余照搬', async () => {
    const r = await run({ assetKeys: ['ghost', 'a1'], targetFolder: 'Trees' })

    const results = r.results as Array<{ assetKey: string; status: string }>
    expect(results.find((x) => x.assetKey === 'ghost')?.status).toBe('not_found')
    expect(results.find((x) => x.assetKey === 'a1')?.status).toBe('moved')
  })
})
