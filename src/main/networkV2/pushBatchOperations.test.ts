/**
 * 批量推送的语义必须和单条推送一致。
 *
 * 修复前：client 角色下未连接直接抛异常，调用方一律 `catch → console.warn`。
 * 于是**多选删除**（前端走的正是批量这条路）在客户端上只删本地，同事全然不知；
 * 本端下一次对账看到服务端那些行还活着，又把它们盖回来 ——
 * 用户看到的是「删了又回来」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

const currentVault = { id: 'vault_local', vaultType: 'network' }
vi.mock('../sqliteDataBase/index', () => ({
  getDatabaseManager: () => ({ getCurrentVault: () => currentVault })
}))

const fakeClient = {
  isConnected: false,
  batch: vi.fn(),
  enqueueOutbox: vi.fn(),
  markLocalWrite: vi.fn()
}
let role: 'server' | 'client' | 'none' = 'client'
vi.mock('./VaultServiceManager', () => ({
  VaultServiceManager: {
    getInstance: () => ({
      getRole: () => role,
      getClient: () => fakeClient,
      getServer: () => null
    })
  }
}))

import { pushBatchOperations } from './NetworkSyncBridge'

const deleteOps = (
  ...keys: string[]
): Array<{
  type: 'delete'
  table: 'assetData'
  data: Record<string, unknown>
}> => keys.map((assetKey) => ({ type: 'delete', table: 'assetData', data: { assetKey } }))

beforeEach(() => {
  role = 'client'
  fakeClient.isConnected = false
  fakeClient.batch.mockReset()
  fakeClient.enqueueOutbox.mockReset().mockReturnValue(3)
  fakeClient.markLocalWrite.mockReset()
})

describe('pushBatchOperations（client 角色）', () => {
  it('未连接时逐条入队，而不是抛异常让调用方吞掉', async () => {
    const result = await pushBatchOperations(deleteOps('a1', 'a2', 'a3'))

    expect(result.status).toBe('queued')
    expect(result.reason).toBe('offline')
    expect(fakeClient.enqueueOutbox).toHaveBeenCalledTimes(3)
    expect(fakeClient.enqueueOutbox).toHaveBeenCalledWith({
      op: 'delete',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: null
    })
  })

  it('推送失败同样入队，不静默丢掉', async () => {
    fakeClient.isConnected = true
    fakeClient.batch.mockRejectedValue(new Error('socket hang up'))

    const result = await pushBatchOperations(deleteOps('a1', 'a2'))

    expect(result.status).toBe('queued')
    expect(result.reason).toBe('push_failed')
    expect(result.error).toContain('socket hang up')
    expect(fakeClient.enqueueOutbox).toHaveBeenCalledTimes(2)
  })

  it('连着且成功时走一次批量请求，并登记本地写', async () => {
    fakeClient.isConnected = true
    fakeClient.batch.mockResolvedValue(undefined)

    const result = await pushBatchOperations(deleteOps('a1', 'a2'))

    expect(result.status).toBe('pushed')
    expect(fakeClient.batch).toHaveBeenCalledTimes(1)
    expect(fakeClient.enqueueOutbox).not.toHaveBeenCalled()
    expect(fakeClient.markLocalWrite).toHaveBeenCalledWith('assetData', 'a1')
    expect(fakeClient.markLocalWrite).toHaveBeenCalledWith('assetData', 'a2')
  })

  it('insert 入队时带上整行 payload', async () => {
    await pushBatchOperations([
      { type: 'insert', table: 'assetData', data: { assetKey: 'a1', assetName: '战士' } }
    ])

    expect(fakeClient.enqueueOutbox).toHaveBeenCalledWith({
      op: 'insert',
      tableName: 'assetData',
      recordKey: 'a1',
      payload: { assetKey: 'a1', assetName: '战士' }
    })
  })

  it('空列表不做任何事', async () => {
    const result = await pushBatchOperations([])

    expect(result.status).toBe('skipped')
    expect(fakeClient.enqueueOutbox).not.toHaveBeenCalled()
  })

  it('非网络库角色不推送', async () => {
    role = 'none'

    const result = await pushBatchOperations(deleteOps('a1'))

    expect(result.status).toBe('skipped')
    expect(fakeClient.enqueueOutbox).not.toHaveBeenCalled()
  })
})
