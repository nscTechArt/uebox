/**
 * @vitest-environment node
 *
 * 回收站恢复工具。
 *
 * 它存在的理由就是给 delete_assets 兜底，所以最要紧的是**别谎报成功**：
 * 恢复完查不到这条记录，就说没确认上，而不是回一句「已恢复」。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getAssetDataByKey,
  restoreAssetData,
  pushAssetUpdate,
  getCurrentRemoteHttpVaultContext,
  send
} = vi.hoisted(() => ({
  getAssetDataByKey: vi.fn(),
  restoreAssetData: vi.fn(),
  pushAssetUpdate: vi.fn(),
  getCurrentRemoteHttpVaultContext: vi.fn(),
  send: vi.fn()
}))

vi.mock('../../../../sqliteDataBase', () => ({ getVaultDatabase: () => ({}) }))
vi.mock('../../../../sqliteDataBase/models/assetData', () => ({
  getAssetDataByKey,
  restoreAssetData
}))
vi.mock('../../../../networkV2/NetworkSyncBridge', () => ({ pushAssetUpdate }))
vi.mock('../../../../networkV2/currentRemoteHttpVault', () => ({
  getCurrentRemoteHttpVaultContext
}))
vi.mock('../../../../appWindows', () => ({ getAppWindows: () => [{ webContents: { send } }] }))

import { createRestoreAssetsTool } from './restoreAssets'

const tool = createRestoreAssetsTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

/** 回收站里的 key。恢复之后就回到库里，getAssetDataByKey 才查得到 */
let trash: Set<string>
let live: Set<string>

beforeEach(() => {
  trash = new Set(['d1'])
  live = new Set(['a1'])
  getAssetDataByKey
    .mockReset()
    .mockImplementation((_db: unknown, key: string) =>
      live.has(key) ? { assetKey: key, assetName: `SM_${key}` } : undefined
    )
  restoreAssetData.mockReset().mockImplementation((_db: unknown, key: string) => {
    if (!trash.has(key)) return false
    trash.delete(key)
    live.add(key)
    return true
  })
  pushAssetUpdate.mockReset().mockResolvedValue({ status: 'skipped' })
  getCurrentRemoteHttpVaultContext.mockReset().mockReturnValue(null)
  send.mockReset()
})

describe('恢复', () => {
  it('恢复完能查到才算成功，并通知界面刷新', async () => {
    const r = await run({ assetKeys: ['d1'] })

    expect(restoreAssetData).toHaveBeenCalledWith(expect.anything(), 'd1')
    expect(r.restored_count).toBe(1)
    expect((r.results as Array<{ status: string }>)[0].status).toBe('restored')
    expect(send).toHaveBeenCalledWith(
      'asset:changed',
      expect.objectContaining({ source: 'agent', op: 'restore' })
    )
  })

  it('恢复也要推同步，否则下一次对账会把它又软删回去', async () => {
    await run({ assetKeys: ['d1'] })

    expect(pushAssetUpdate).toHaveBeenCalledWith('d1', expect.objectContaining({ isDelete: 0 }))
  })

  it('本来就没被删的不动它', async () => {
    const r = await run({ assetKeys: ['a1'] })

    expect(restoreAssetData).not.toHaveBeenCalled()
    expect((r.results as Array<{ status: string }>)[0].status).toBe('not_in_trash')
  })

  it('恢复完还是查不到就报「没确认」，不许说已恢复', async () => {
    const r = await run({ assetKeys: ['ghost'] })

    const results = r.results as Array<{ status: string; reason?: string }>
    expect(results[0].status).toBe('unconfirmed')
    expect(results[0].reason).toContain('没有确认')
    expect(r.restored_count).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})
