/**
 * @vitest-environment node
 *
 * 文件夹回收站。
 *
 * 守四条：不给参数只列不动手、认不准就整批不动（恢复错文件夹是无声的错误）、
 * 恢复完回读确认、网络库直接说做不了而不是改一半。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getDeletedAssetFolders,
  findDeletedAssetFolder,
  restoreAssetFolder,
  getAssetFolderByKey,
  folderWriteBlockReason,
  send
} = vi.hoisted(() => ({
  getDeletedAssetFolders: vi.fn(),
  findDeletedAssetFolder: vi.fn(),
  restoreAssetFolder: vi.fn(),
  getAssetFolderByKey: vi.fn(),
  folderWriteBlockReason: vi.fn(),
  send: vi.fn()
}))

vi.mock('../../../../sqliteDataBase', () => ({ getVaultDatabase: () => ({}) }))
vi.mock('../../../../sqliteDataBase/models/assetFolder', () => ({
  getDeletedAssetFolders,
  findDeletedAssetFolder,
  restoreAssetFolder,
  getAssetFolderByKey
}))
vi.mock('../../../../appWindows', () => ({ getAppWindows: () => [{ webContents: { send } }] }))
vi.mock('./networkVaultGuard', () => ({ folderWriteBlockReason }))

import { createRestoreFoldersTool } from './restoreFolders'

const tool = createRestoreFoldersTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

/** 回收站里躺着的文件夹，folderKey → 还在不在回收站 */
let trash: Array<{ folderKey: string; folderName: string; fullPath: string }>
let restored: Set<string>

beforeEach(() => {
  trash = [
    { folderKey: 'k_so', folderName: 'SoStylized', fullPath: '/ALL/SoStylized' },
    { folderKey: 'k_tex1', folderName: 'Textures', fullPath: '/ALL/SoStylized/Textures' },
    { folderKey: 'k_tex2', folderName: 'Textures', fullPath: '/ALL/EasyFog/Textures' }
  ]
  restored = new Set()
  getDeletedAssetFolders.mockReset().mockImplementation(() => ({
    list: trash.filter((f) => !restored.has(f.folderKey)),
    total: trash.filter((f) => !restored.has(f.folderKey)).length
  }))
  restoreAssetFolder
    .mockReset()
    .mockImplementation((_db: unknown, key: string) => (restored.add(key), true))
  getAssetFolderByKey
    .mockReset()
    .mockImplementation((_db: unknown, key: string) =>
      restored.has(key) ? { folderKey: key, folderName: 'x' } : undefined
    )
  // 列表里没有时才会问到它：回收站只列「这一次删除的根」，子孙层要按 key 单独找
  findDeletedAssetFolder.mockReset().mockReturnValue(undefined)
  folderWriteBlockReason.mockReset().mockReturnValue(undefined)
  send.mockReset()
})

describe('列回收站', () => {
  it('不给参数只列不动手 —— 模型得先看得见才拿得到 folderKey', async () => {
    const r = await run({})

    expect(r.count).toBe(3)
    expect((r.folders as Array<{ folderKey: string }>)[0].folderKey).toBe('k_so')
    expect(restoreAssetFolder).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('回收站空的时候明说是空的', async () => {
    trash = []
    const r = await run({})

    expect(r.count).toBe(0)
    expect(String(r.message)).toContain('没有')
  })
})

describe('恢复', () => {
  it('按 folderKey 恢复，回读确认之后才算成功，并通知界面', async () => {
    const r = await run({ folders: ['k_so'] })

    expect(restoreAssetFolder).toHaveBeenCalledWith(expect.anything(), 'k_so')
    expect(r.restored_count).toBe(1)
    expect(r.success).toBe(true)
    expect(send).toHaveBeenCalledWith(
      'asset:changed',
      expect.objectContaining({ source: 'agent', op: 'folder' })
    )
  })

  it('按完整路径也能指定 —— 同名文件夹靠它区分', async () => {
    const r = await run({ folders: ['/ALL/EasyFog/Textures'] })

    expect(restoreAssetFolder).toHaveBeenCalledWith(expect.anything(), 'k_tex2')
    expect(r.success).toBe(true)
  })

  it('子孙层不在列表里，但给了 folderKey 照样能单独恢复', async () => {
    // 回收站列的是删除的根；这个孙文件夹不在 list 里，只能靠精确查找认出来
    findDeletedAssetFolder.mockImplementation((_db: unknown, key: string) =>
      key === 'k_grandchild'
        ? { folderKey: 'k_grandchild', folderName: 'Sub', fullPath: '/ALL/SoStylized/Textures/Sub' }
        : undefined
    )

    const r = await run({ folders: ['k_grandchild'] })

    expect(restoreAssetFolder).toHaveBeenCalledWith(expect.anything(), 'k_grandchild')
    expect(r.success).toBe(true)
  })

  it('回读发现还在回收站就报「没确认」，不算成功', async () => {
    restoreAssetFolder.mockReturnValue(false) // 底层没恢复成

    const r = await run({ folders: ['k_so'] })

    const results = r.results as Array<{ status: string; reason?: string }>
    expect(results[0].status).toBe('unconfirmed')
    expect(results[0].reason).toContain('没有确认')
    expect(r.success).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('不动手的情况', () => {
  it('同名文件夹不猜，把候选列出来', async () => {
    const r = await run({ folders: ['Textures'] })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('2 个')
    expect(String(r.error)).toContain('k_tex1')
    expect(restoreAssetFolder).not.toHaveBeenCalled()
  })

  it('一个认不准就整批不动 —— 剩下那个也不恢复', async () => {
    const r = await run({ folders: ['k_so', '不存在的文件夹'] })

    expect(r.success).toBe(false)
    expect(restoreAssetFolder).not.toHaveBeenCalled()
  })

  it('不在回收站里的直接说清楚下一步怎么办', async () => {
    const r = await run({ folders: ['k_ghost'] })

    expect(String(r.error)).toContain('回收站里没有')
    expect(String(r.error)).toContain('不带参数')
  })

  it('网络库上不做，直接说去界面里操作', async () => {
    folderWriteBlockReason.mockReturnValue('当前是网络保管库，恢复文件夹还要动真实目录')

    const r = await run({ folders: ['k_so'] })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('网络保管库')
    expect(restoreAssetFolder).not.toHaveBeenCalled()
  })

  it('列回收站不受网络库限制 —— 那是只读的', async () => {
    folderWriteBlockReason.mockReturnValue('当前是网络保管库')

    const r = await run({})

    expect(r.success).toBe(true)
    expect(r.count).toBe(3)
  })
})
