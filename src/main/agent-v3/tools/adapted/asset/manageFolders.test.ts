/**
 * @vitest-environment node
 *
 * 文件夹改名 / 删除。
 *
 * 最要紧的两条：删文件夹会**连里面的资产一起带走**，这个数字必须报出来；
 * 网络库上这两件事还要动真实目录，工具做不了就明说，不做一半。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAssetFolderByKey,
  updateAssetFolder,
  updateFolderPathsRecursively,
  deleteAssetFolder,
  countAssetsInFolderTree,
  resolveFolder,
  folderWriteBlockReason,
  send
} = vi.hoisted(() => ({
  getAssetFolderByKey: vi.fn(),
  updateAssetFolder: vi.fn(),
  updateFolderPathsRecursively: vi.fn(),
  deleteAssetFolder: vi.fn(),
  countAssetsInFolderTree: vi.fn(),
  resolveFolder: vi.fn(),
  folderWriteBlockReason: vi.fn(),
  send: vi.fn()
}))

vi.mock('../../../../sqliteDataBase', () => ({ getVaultDatabase: () => ({}) }))
vi.mock('../../../../sqliteDataBase/models/assetFolder', () => ({
  getAssetFolderByKey,
  updateAssetFolder,
  updateFolderPathsRecursively,
  deleteAssetFolder,
  countAssetsInFolderTree
}))
vi.mock('../../../../appWindows', () => ({ getAppWindows: () => [{ webContents: { send } }] }))
vi.mock('./folderLookup', () => ({ resolveFolder }))
vi.mock('./networkVaultGuard', () => ({ folderWriteBlockReason }))

import { createDeleteFoldersTool, createRenameFolderTool } from './manageFolders'

const rename = createRenameFolderTool()
const remove = createDeleteFoldersTool()
const call = (
  tool: { execute?: unknown },
  input: Record<string, unknown>
): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

/** 库里还在的文件夹（回读读的是它） */
let livingFolders: Map<string, string>

beforeEach(() => {
  livingFolders = new Map([['k_tree', 'Trees']])
  getAssetFolderByKey.mockReset().mockImplementation((_db: unknown, key: string) =>
    livingFolders.has(key)
      ? {
          folderKey: key,
          folderName: livingFolders.get(key),
          fullPath: `/${livingFolders.get(key)}`
        }
      : undefined
  )
  updateAssetFolder
    .mockReset()
    .mockImplementation((_db: unknown, key: string, updates: { folderName?: string }) => {
      if (updates.folderName) livingFolders.set(key, updates.folderName)
      return true
    })
  updateFolderPathsRecursively.mockReset()
  deleteAssetFolder.mockReset().mockImplementation((_db: unknown, key: string) => {
    livingFolders.delete(key)
    return true
  })
  countAssetsInFolderTree.mockReset().mockReturnValue(0)
  resolveFolder.mockReset().mockReturnValue({
    folderKey: 'k_tree',
    folder: { folderKey: 'k_tree', folderName: 'Trees', fullPath: '/Trees' }
  })
  folderWriteBlockReason.mockReset().mockReturnValue(undefined)
  send.mockReset()
})

describe('rename_folder', () => {
  it('改完重算子孙路径，回读确认之后才算成功', async () => {
    const r = await call(rename, { folder: 'Trees', newName: '树木' })

    expect(updateAssetFolder).toHaveBeenCalledWith(expect.anything(), 'k_tree', {
      folderName: '树木'
    })
    // 不重算的话，子孙的 fullPath 里还留着旧名字，按路径就再也找不到它们
    expect(updateFolderPathsRecursively).toHaveBeenCalledWith(expect.anything(), 'k_tree')
    expect(r.success).toBe(true)
    expect(send).toHaveBeenCalled()
  })

  it('回读发现还是旧名字就不算成功', async () => {
    updateAssetFolder.mockReturnValue(false) // 底层没改成

    const r = await call(rename, { folder: 'Trees', newName: '树木' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('没有确认')
  })

  it('非法名字当场挡掉，不去动数据库', async () => {
    for (const bad of ['', 'ALL', 'a/b', 'x'.repeat(21)]) {
      const r = await call(rename, { folder: 'Trees', newName: bad })
      expect(r.success, bad).toBe(false)
    }
    expect(updateAssetFolder).not.toHaveBeenCalled()
  })

  it('ALL 根文件夹不能改名', async () => {
    resolveFolder.mockReturnValue({ folderKey: 'ALL' })

    const r = await call(rename, { folder: 'ALL', newName: '全部' })

    expect(r.success).toBe(false)
    expect(updateAssetFolder).not.toHaveBeenCalled()
  })

  it('网络库上不做一半 —— 直接说清楚要去界面里改', async () => {
    folderWriteBlockReason.mockReturnValue('当前是网络保管库，重命名文件夹…请在界面里操作。')

    const r = await call(rename, { folder: 'Trees', newName: '树木' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('界面')
    expect(updateAssetFolder).not.toHaveBeenCalled()
  })
})

describe('delete_folders', () => {
  it('把连带删掉的资产数说出来 —— 用户听到的不能只是「文件夹删了」', async () => {
    countAssetsInFolderTree.mockReturnValue(37)

    const r = await call(remove, { folders: ['Trees'] })

    expect(r.success).toBe(true)
    expect(r.assets_removed).toBe(37)
    expect(String(r.message)).toContain('37 个资产')
    // 撤销的去处要说出来：文件夹连里面的资产一起被带走了，捞回来靠 restore_folders
    expect(String(r.message)).toContain('restore_folders')
  })

  it('有一个文件夹认不准就整批不动', async () => {
    resolveFolder.mockImplementation((_db: unknown, name: string) =>
      name === 'Trees'
        ? { folderKey: 'k_tree', folder: { folderKey: 'k_tree', folderName: 'Trees' } }
        : { error: '库里有 2 个叫「UI」的文件夹' }
    )

    const r = await call(remove, { folders: ['Trees', 'UI'] })

    expect(r.success).toBe(false)
    expect(deleteAssetFolder).not.toHaveBeenCalled()
  })

  it('ALL 删不掉', async () => {
    resolveFolder.mockReturnValue({ folderKey: 'ALL' })

    const r = await call(remove, { folders: ['ALL'] })

    expect(r.success).toBe(false)
    expect(deleteAssetFolder).not.toHaveBeenCalled()
  })

  it('回读时文件夹还在就报「没确认」', async () => {
    deleteAssetFolder.mockReturnValue(false) // 底层没删掉，库里还查得到

    const r = await call(remove, { folders: ['Trees'] })

    expect((r.results as Array<{ status: string }>)[0].status).toBe('unconfirmed')
    expect(r.deleted_count).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})
