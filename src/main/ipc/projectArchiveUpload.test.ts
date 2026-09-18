/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 整包上传 / 取回这两个 IPC 入口的门禁。
 *
 * 底下的服务（projectArchiveUpload / projectArchivePull）各自有测试，但**接线**没有：
 * 解析服务器地址、算目标文件夹在库里的路径、建任务记录、把失败翻成界面事件 ——
 * 全在这一层，而且全都是「错了不会崩、只会传到错地方或者悄悄没留痕」的那种错。
 */

const registry = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      registry.handlers.set(channel, fn)
    }
  }
}))
const handlers = registry.handlers

const state = vi.hoisted(() => ({
  vault: null as { id: string; networkPath: string } | null,
  apiKey: undefined as string | undefined,
  /** folderKey -> 相对路径；null 表示「算不出来」（父链断了或成环） */
  folderRelPaths: new Map<string, string | null>(),
  folderRecords: new Map<string, Record<string, unknown>>(),
  uploadResult: {} as Record<string, unknown>,
  pullResult: {} as Record<string, unknown>,
  pullError: null as Error | null,
  uploadArgs: [] as Array<Record<string, unknown>>,
  pullArgs: [] as Array<Record<string, unknown>>,
  tasks: [] as Array<Record<string, unknown>>,
  taskUpdates: [] as Array<{ taskId: string; patch: Record<string, unknown> }>,
  pulledVaults: [] as string[]
}))

vi.mock('../sqliteDataBase', () => ({
  getDatabaseManager: () => ({
    getCurrentVault: () => state.vault,
    getVaultManager: () => ({ getNetworkVaultApiKey: () => state.apiKey })
  }),
  getPublicDatabase: () => ({ name: 'publicDb' }),
  getVaultDatabase: () => ({ name: 'vaultDb' })
}))

vi.mock('../sqliteDataBase/models/assetFolder', () => ({
  getAssetFolderByKey: (_db: unknown, key: string) => state.folderRecords.get(key) ?? null
}))

vi.mock('../sqliteDataBase/services/networkFolderPath', () => ({
  buildNetworkFolderRelPath: (_db: unknown, key: string) => state.folderRelPaths.get(key) ?? null
}))

vi.mock('../sqliteDataBase/models/importTask', () => ({
  createImportTask: (_db: unknown, task: Record<string, unknown>) => {
    state.tasks.push(task)
    return 1
  },
  updateImportTask: (_db: unknown, taskId: string, patch: Record<string, unknown>) => {
    state.taskUpdates.push({ taskId, patch })
    return 1
  }
}))

vi.mock('../networkV2/VaultServiceManager', () => ({
  VaultServiceManager: {
    getInstance: () => ({
      getClient: (vaultId: string) => ({
        pullChanges: async () => {
          state.pulledVaults.push(vaultId)
        }
      })
    })
  }
}))

vi.mock('../networkV2/vaultAccessKeys', () => ({
  vaultAccessKeyHeadersFromUrl: () => ({ 'X-Vault-Key': 'discovered' })
}))

vi.mock('../services/asset/projectArchiveUpload', () => ({
  uploadProjectArchive: async (args: Record<string, unknown>) => {
    state.uploadArgs.push(args)
    return state.uploadResult
  }
}))

vi.mock('../services/asset/projectArchivePull', () => ({
  buildVaultFileUrl: (serverUrl: string, vaultId: string, remotePath: string) =>
    `${serverUrl}/api/vaults/${vaultId}/files/${remotePath}`,
  pullProjectArchive: async (args: Record<string, unknown>) => {
    state.pullArgs.push(args)
    if (state.pullError) throw state.pullError
    return state.pullResult
  }
}))

import './projectArchiveUpload'

interface SentEvent {
  channel: string
  payload: Record<string, unknown>
}

function makeEvent(sent: SentEvent[]): { sender: { send: (c: string, p: unknown) => void } } {
  return {
    sender: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload: payload as Record<string, unknown> })
      }
    }
  }
}

const invokeUpload = async (
  sent: SentEvent[],
  sourcePath: string,
  folderKey?: string | null,
  taskId?: string
): Promise<{ success: boolean; error?: string; data?: Record<string, unknown> }> =>
  (await handlers.get('asset:uploadProjectArchive')!(
    makeEvent(sent),
    sourcePath,
    folderKey,
    taskId
  )) as { success: boolean; error?: string; data?: Record<string, unknown> }

const invokePull = async (
  sent: SentEvent[],
  params: Record<string, unknown>
): Promise<{ success: boolean; error?: string; data?: Record<string, unknown> }> =>
  (await handlers.get('asset:pullProjectArchive')!(makeEvent(sent), params)) as {
    success: boolean
    error?: string
    data?: Record<string, unknown>
  }

beforeEach(() => {
  state.vault = { id: 'local-1', networkPath: 'http://nas:18900/vault_remote' }
  state.apiKey = 'node-key'
  state.folderRelPaths = new Map([['f-2026', '工程库/2026']])
  state.folderRecords = new Map([['f-2026', { folderKey: 'f-2026', folderName: '2026' }]])
  state.uploadResult = { status: 'committed', sessionId: 'sess-1', archiveName: 'Demo.zip' }
  state.pullResult = { localPath: 'D:/out/Demo', extracted: true, fileCount: 3, mbPerSec: 90 }
  state.pullError = null
  state.uploadArgs = []
  state.pullArgs = []
  state.tasks = []
  state.taskUpdates = []
  state.pulledVaults = []
})

describe('asset:uploadProjectArchive', () => {
  it('splits the vault networkPath and passes the resolved folder path through', async () => {
    const sent: SentEvent[] = []
    const res = await invokeUpload(sent, 'D:/Projects/Demo', 'f-2026', 'task-1')

    expect(res.success).toBe(true)
    expect(state.uploadArgs[0]).toMatchObject({
      serverUrl: 'http://nas:18900',
      vaultId: 'vault_remote',
      apiKey: 'node-key',
      sourcePath: 'D:/Projects/Demo',
      targetFolderKey: 'f-2026',
      targetFolderPath: '工程库/2026'
    })
    expect(state.tasks[0]).toMatchObject({ taskId: 'task-1', vaultId: 'local-1', totalItems: 1 })
    expect(state.pulledVaults).toEqual(['local-1'])
  })

  it('aborts instead of uploading to a shallower path when the folder chain is broken', async () => {
    // buildNetworkFolderRelPath 返回 null = 父链断了或成环。
    // 这里最危险的不是报错，而是「当成根目录继续传」——包会落到别的目录去。
    state.folderRelPaths.set('f-2026', null)
    const sent: SentEvent[] = []
    const res = await invokeUpload(sent, 'D:/Projects/Demo', 'f-2026', 'task-1')

    expect(res.success).toBe(false)
    expect(state.uploadArgs).toHaveLength(0)
    expect(sent.some((e) => e.channel === 'asset:folderImportError')).toBe(true)
  })

  it('refuses non-HTTP vaults before touching the network', async () => {
    state.vault = { id: 'local-1', networkPath: '\\\\nas\\share\\vault' }
    const sent: SentEvent[] = []
    const res = await invokeUpload(sent, 'D:/Projects/Demo', 'ALL', 'task-1')

    expect(res.success).toBe(false)
    expect(state.uploadArgs).toHaveLength(0)
    expect(state.tasks).toHaveLength(0)
    expect(sent.some((e) => e.channel === 'asset:folderImportError')).toBe(true)
  })

  it('marks the task failed and reports the service-level failure result', async () => {
    state.uploadResult = { status: 'failed', error: '服务器拒绝', errorCode: 'DISK_FULL' }
    const sent: SentEvent[] = []
    const res = await invokeUpload(sent, 'D:/Projects/Demo', 'ALL', 'task-1')

    expect(res.success).toBe(false)
    expect(res.error).toBe('服务器拒绝')
    expect(state.taskUpdates.some((u) => u.patch.status === 'failed')).toBe(true)
    expect(sent.some((e) => e.channel === 'asset:folderImportCompleted')).toBe(false)
  })

  it('omits mode on completion so the renderer does not stack a second success toast', async () => {
    const sent: SentEvent[] = []
    await invokeUpload(sent, 'D:/Projects/Demo', 'ALL', 'task-1')

    const completed = sent.find((e) => e.channel === 'asset:folderImportCompleted')
    expect(completed).toBeTruthy()
    expect(completed!.payload.remoteSyncStatus).toBe('committed')
    expect(completed!.payload.mode).toBeUndefined()
  })
})

describe('asset:pullProjectArchive', () => {
  it('builds the file URL and merges both credential sources into the headers', async () => {
    const sent: SentEvent[] = []
    const res = await invokePull(sent, {
      remotePath: '工程库/2026/Demo.zip',
      fileName: 'Demo.zip',
      destDir: 'D:/out',
      taskId: 'pull-1'
    })

    expect(res.success).toBe(true)
    expect(state.pullArgs[0]).toMatchObject({
      fileUrl: 'http://nas:18900/api/vaults/vault_remote/files/工程库/2026/Demo.zip',
      fileName: 'Demo.zip',
      destDir: 'D:/out'
    })
    expect(state.pullArgs[0].headers).toEqual({
      'X-Vault-Key': 'discovered',
      'X-API-Key': 'node-key'
    })
  })

  it('records a task for the pull too, so a crashed download leaves a trace', async () => {
    const sent: SentEvent[] = []
    await invokePull(sent, {
      remotePath: 'Demo.zip',
      fileName: 'Demo.zip',
      destDir: 'D:/out',
      taskId: 'pull-1'
    })

    expect(state.tasks[0]).toMatchObject({ taskId: 'pull-1', vaultId: 'local-1', totalItems: 1 })
    expect(state.taskUpdates.some((u) => u.patch.status === 'completed')).toBe(true)
  })

  it('marks the task failed and emits an error event when the download throws', async () => {
    const sent: SentEvent[] = []
    state.pullError = new Error('下载不完整')

    const res = await invokePull(sent, {
      remotePath: 'Demo.zip',
      fileName: 'Demo.zip',
      destDir: 'D:/out',
      taskId: 'pull-1'
    })

    expect(res.success).toBe(false)
    expect(res.error).toBe('下载不完整')
    expect(state.taskUpdates.some((u) => u.patch.status === 'failed')).toBe(true)
    const errorEvent = sent.find((e) => e.channel === 'asset:folderImportError')
    expect(errorEvent?.payload).toMatchObject({ taskId: 'pull-1', message: '下载不完整' })
  })
})
