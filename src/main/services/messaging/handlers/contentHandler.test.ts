import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pendingImports: [] as Array<(value: unknown) => void>,
  importFolderStructureWithMetadata: vi.fn(),
  getAppWindows: vi.fn(() => []),
  stat: vi.fn(),
  readdir: vi.fn(async () => [])
}))

vi.mock('fs/promises', () => ({
  default: { stat: mocks.stat, readdir: mocks.readdir },
  promises: { stat: mocks.stat, readdir: mocks.readdir }
}))

vi.mock('../../../appWindows', () => ({
  getAppWindows: mocks.getAppWindows
}))

vi.mock('../../../sqliteDataBase', () => ({
  getDatabaseManager: () => ({
    getVaultManager: () => ({
      getCurrentVault: () => ({ name: '默认保管库', path: 'C:/vault' })
    })
  })
}))

vi.mock('../../../sqliteDataBase/models/assetFolder', () => ({
  createAssetFolder: vi.fn(),
  getAssetFolderByKey: vi.fn(() => undefined)
}))

vi.mock('better-sqlite3', () => {
  class FakeDatabase {
    prepare(): { get: () => undefined; run: () => undefined } {
      return { get: () => undefined, run: () => undefined }
    }
    close(): boolean {
      return true
    }
  }
  return { default: FakeDatabase }
})

vi.mock('../../asset/AssetImportService', () => ({
  AssetImportService: class {
    importFolderStructureWithMetadata = mocks.importFolderStructureWithMetadata
  }
}))

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), debug: vi.fn() }
}))

import { ContentHandler } from './contentHandler'

const importEvent = (id: string): Record<string, unknown> => ({
  ver: '1.0',
  type: 'evt' as const,
  method: 'content.import_assets',
  id,
  payload: {
    asset_real_paths: ['C:/proj/Content/SoStylized'],
    asset_paths: ['/Game/SoStylized'],
    engine_version: '5.5.0',
    project_name: 'UALinkDev55'
  },
  time: 0
})

/** 装好路由，拿到 content.import_assets 的处理函数 */
const mountHandler = (): {
  handleImport: (envelope: unknown, connectionId: string) => Promise<void>
  sent: Array<Record<string, unknown>>
} => {
  const handler = new ContentHandler()
  const sent: Array<Record<string, unknown>> = []
  handler.setSender((_connectionId, message): boolean => {
    sent.push(message as unknown as Record<string, unknown>)
    return true
  })

  const handlers = new Map<string, (envelope: unknown, connectionId: string) => Promise<void>>()
  handler.registerRoutes({
    register: (method: string, fn: (envelope: unknown, connectionId: string) => Promise<void>) => {
      handlers.set(method, fn)
    }
  } as never)

  return { handleImport: handlers.get('content.import_assets')!, sent }
}

type BroadcastRecord = { channel: string; payload: Record<string, unknown> }

/** 收集广播出去的 IPC，模拟盒子自己的窗口 */
const mountWindows = (count = 2): BroadcastRecord[] => {
  const sends: BroadcastRecord[] = []
  const windows = Array.from({ length: count }, () => ({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => sends.push({ channel, payload })
    }
  }))
  mocks.getAppWindows.mockReturnValue(windows as never)
  return sends
}

describe('ContentHandler 界面反馈', () => {
  beforeEach(() => {
    mocks.importFolderStructureWithMetadata.mockReset()
    mocks.getAppWindows.mockReturnValue([])
    // 资产导入走的是「单文件批量」那条分支
    mocks.stat.mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 10,
      mtime: new Date(0)
    })
  })

  it('从开始到完成，进度挂件那套事件一条都不能少，且发给每一个窗口', async () => {
    const sends = mountWindows(2)
    mocks.importFolderStructureWithMetadata.mockImplementation(
      async (options: {
        onStageChange?: (stage: string) => void
        onProgress?: (progress: { total: number; done: number; percent: number }) => void
      }) => {
        options.onStageChange?.('writing')
        options.onProgress?.({ total: 1, done: 1, percent: 100 })
        return { success: true, data: { filesCreated: 1 } }
      }
    )

    const { handleImport } = mountHandler()
    await handleImport(importEvent('req-1'), 'conn-1')
    await vi.waitFor(() => expect(sends.some((s) => s.channel === 'asset-tree:refresh')).toBe(true))

    const channels = sends.map((s) => s.channel)
    for (const channel of [
      'asset:unrealImportStarted',
      'asset:folderImportStage',
      'asset:folderImportProgress',
      'asset:folderImportCompleted',
      'asset-tree:refresh'
    ]) {
      // 两个窗口各收一份
      expect(channels.filter((c) => c === channel)).toHaveLength(2)
    }

    // 挂件靠 taskId 认领这条任务：开始、进度、完成必须是同一个
    const taskIds = new Set(
      sends.filter((s) => s.channel !== 'asset-tree:refresh').map((s) => s.payload.taskId as string)
    )
    expect(taskIds.size).toBe(1)
    expect([...taskIds][0]).toMatch(/^ue-import-/)
  })

  it('导入失败时挂件收到的是 error，不是静悄悄什么都没有', async () => {
    const sends = mountWindows(1)
    mocks.importFolderStructureWithMetadata.mockResolvedValue({
      success: false,
      error: '磁盘满了'
    })

    const { handleImport } = mountHandler()
    await handleImport(importEvent('req-1'), 'conn-1')
    await vi.waitFor(() =>
      expect(sends.some((s) => s.channel === 'asset:folderImportError')).toBe(true)
    )

    const failure = sends.find((s) => s.channel === 'asset:folderImportError')!
    expect(failure.payload.error).toBe('磁盘满了')
    expect(sends.some((s) => s.channel === 'asset-tree:refresh')).toBe(false)
  })
})

describe('ContentHandler 导入去重', () => {
  beforeEach(() => {
    mocks.pendingImports.length = 0
    // 默认让导入挂住，模拟「大目录要跑一会儿」
    mocks.importFolderStructureWithMetadata.mockReset()
    mocks.importFolderStructureWithMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          mocks.pendingImports.push(resolve)
        })
    )
    mocks.stat.mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
      size: 0,
      mtime: new Date(0)
    })
  })

  it('同一批资产连点多次时只导入一次', async () => {
    const { handleImport, sent } = mountHandler()

    // 第一次导入还挂在后台
    const first = handleImport(importEvent('req-1'), 'conn-1')
    await vi.waitFor(() => expect(mocks.pendingImports).toHaveLength(1))

    // 用户等不到反馈，又连点了两次
    await handleImport(importEvent('req-2'), 'conn-1')
    await handleImport(importEvent('req-3'), 'conn-1')

    expect(mocks.importFolderStructureWithMetadata).toHaveBeenCalledTimes(1)
    // 两次重复点击都立刻拿到回执，没有真的再导一遍
    expect(sent).toHaveLength(2)
    expect(sent.map((msg) => (msg.payload as { count: number }).count)).toEqual([0, 0])

    mocks.pendingImports[0]({ success: true, data: { filesCreated: 0 } })
    await first
  })

  it('上一次导入结束后同一批资产可以再导一次', async () => {
    const { handleImport } = mountHandler()
    mocks.importFolderStructureWithMetadata.mockResolvedValue({
      success: true,
      data: { filesCreated: 0 }
    })

    await handleImport(importEvent('req-1'), 'conn-1')
    await handleImport(importEvent('req-2'), 'conn-1')

    expect(mocks.importFolderStructureWithMetadata).toHaveBeenCalledTimes(2)
  })
})
