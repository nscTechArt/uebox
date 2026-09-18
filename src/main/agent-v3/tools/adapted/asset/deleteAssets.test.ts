/**
 * @vitest-environment node
 *
 * 素材库删除工具。
 *
 * 这里守的是三条不能退的线：
 *   1. **回读不确认就不许报成功** —— 删完再查一次，还查得到就说「没确认上」。
 *   2. 一条失败不能带垮整批 —— 每个 assetKey 各报各的结果。
 *   3. 重复登记共用同一个文件时必须说出来 —— 用户接着去「清空回收站」会真删文件。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

const {
  getAssetDataByKey,
  deleteAssetData,
  getLiveAssetsByFilePath,
  pushAssetDelete,
  getCurrentRemoteHttpVaultContext,
  send,
  getAssetDataPath,
  getCurrentVaultPath
} = vi.hoisted(() => ({
  getAssetDataByKey: vi.fn(),
  deleteAssetData: vi.fn(),
  getLiveAssetsByFilePath: vi.fn(),
  pushAssetDelete: vi.fn(),
  getCurrentRemoteHttpVaultContext: vi.fn(),
  send: vi.fn(),
  getAssetDataPath: vi.fn(),
  getCurrentVaultPath: vi.fn()
}))

/** 另一个保管库里有没有这条 —— 用来测「说准，但不跨库动手」 */
const OTHER_VAULT_DB = { tag: 'other' }
let otherVaultHas: string[] = []

vi.mock('../../../../sqliteDataBase', () => ({
  getVaultDatabase: () => ({}),
  getDatabaseManager: () => ({
    getVaultManager: () => ({
      getAllVaults: () => [
        { id: 'v_cur', name: '默认保管库', isActive: true },
        { id: 'v_other', name: 'AIGC 资产库', isActive: false }
      ],
      getCurrentVault: () => ({ id: 'v_cur', name: '默认保管库', isActive: true }),
      withVaultDatabase: async (id: string, op: (db: unknown) => unknown) =>
        await op(id === 'v_other' ? OTHER_VAULT_DB : {})
    })
  })
}))
vi.mock('../../../../sqliteDataBase/models/assetData', () => ({
  getAssetDataByKey,
  deleteAssetData,
  getLiveAssetsByFilePath
}))
vi.mock('../../../../networkV2/NetworkSyncBridge', () => ({ pushAssetDelete }))
vi.mock('../../../../networkV2/currentRemoteHttpVault', () => ({
  getCurrentRemoteHttpVaultContext
}))
vi.mock('../../../../appWindows', () => ({
  getAppWindows: () => [{ webContents: { send } }]
}))
vi.mock('../../../../utils/PathManager', () => ({
  PathManager: { getInstance: () => ({ getAssetDataPath, getCurrentVaultPath }) }
}))

import { createDeleteAssetsTool } from './deleteAssets'

const tool = createDeleteAssetsTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

const VAULT = resolve('/vault')
const ASSET_ROOT = resolve(VAULT, 'assetData')

/** 库里活着的一条记录；删过之后再查就没了 */
function liveThenGone(key: string, extra: Record<string, unknown> = {}): void {
  getAssetDataByKey.mockImplementation((_db: unknown, k: string) =>
    k === key && !deleted.has(k) ? { assetKey: k, assetName: `SM_${k}`, ...extra } : undefined
  )
}

let deleted: Set<string>

beforeEach(() => {
  deleted = new Set()
  otherVaultHas = []
  getAssetDataByKey.mockReset()
  deleteAssetData.mockReset().mockImplementation((_db: unknown, key: string) => {
    deleted.add(key)
    return true
  })
  getLiveAssetsByFilePath.mockReset().mockReturnValue([])
  pushAssetDelete.mockReset().mockResolvedValue({ status: 'skipped' })
  getCurrentRemoteHttpVaultContext.mockReset().mockReturnValue(null)
  send.mockReset()
  getAssetDataPath.mockReset().mockReturnValue(ASSET_ROOT)
  getCurrentVaultPath.mockReset().mockReturnValue(VAULT)
})

/**
 * 搜索是**跨库**的，所以模型手上很可能拿着别的保管库的 assetKey。
 * 删除只在当前活跃库里做（这是故意的设计，切库是用户的动作）——
 * 但那时候绝不能回一句「库里没有这条记录」，那是在告诉用户他的素材没了。
 */
describe('assetKey 其实在别的保管库里', () => {
  it('说清楚在哪个库、要用户自己去切，而不是说「没有这条记录」', async () => {
    getAssetDataByKey.mockImplementation((db: unknown, k: string) =>
      db === OTHER_VAULT_DB && otherVaultHas.includes(k) ? { assetKey: k } : undefined
    )
    otherVaultHas = ['a1']

    const r = await run({ assetKeys: ['a1'] })

    const results = r.results as Array<{ status: string; reason?: string }>
    expect(results[0]!.status).toBe('not_found')
    expect(results[0]!.reason).toContain('AIGC 资产库')
    expect(results[0]!.reason).toContain('switch_vault')
    expect(results[0]!.reason).toContain('不要告诉用户「库里没有这个东西」')
  })

  it('绝不代替用户跨库删 —— 别的库里那条原封不动', async () => {
    getAssetDataByKey.mockImplementation((db: unknown, k: string) =>
      db === OTHER_VAULT_DB && otherVaultHas.includes(k) ? { assetKey: k } : undefined
    )
    otherVaultHas = ['a1']

    await run({ assetKeys: ['a1'] })

    expect(deleteAssetData).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('哪个库都没有时还是原来那句话，不编「在别的库里」', async () => {
    getAssetDataByKey.mockReturnValue(undefined)

    const r = await run({ assetKeys: ['a1'] })

    const results = r.results as Array<{ status: string; reason?: string }>
    expect(results[0]!.reason).not.toContain('switch_vault')
  })
})

describe('正常删除', () => {
  it('软删除 + 回读确认，并通知界面刷新', async () => {
    liveThenGone('a1')

    const r = await run({ assetKeys: ['a1'] })

    expect(deleteAssetData).toHaveBeenCalledWith(expect.anything(), 'a1')
    expect(r.success).toBe(true)
    expect(r.deleted_count).toBe(1)
    expect(String(r.message)).toContain('回收站')
    expect(send).toHaveBeenCalledWith(
      'asset:changed',
      expect.objectContaining({ source: 'agent', op: 'delete' })
    )
  })

  it('重复的 assetKey 只算一次', async () => {
    liveThenGone('a1')

    const r = await run({ assetKeys: ['a1', 'a1', ' a1 '] })

    expect(r.requested_count).toBe(1)
    expect(deleteAssetData).toHaveBeenCalledTimes(1)
  })
})

describe('删不掉的时候', () => {
  it('回读还在就报「没确认上」，不许算成功', async () => {
    // 删了但记录还在（比如底层 UPDATE 没生效）
    getAssetDataByKey.mockReturnValue({ assetKey: 'a1', assetName: 'SM_A' })

    const r = await run({ assetKeys: ['a1'] })

    const results = r.results as Array<{ status: string; reason?: string }>
    expect(results[0].status).toBe('unconfirmed')
    expect(results[0].reason).toContain('没有确认删掉')
    expect(r.deleted_count).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('库里没有这条记录时不假装删成功', async () => {
    getAssetDataByKey.mockReturnValue(undefined)

    const r = await run({ assetKeys: ['ghost'] })

    expect((r.results as Array<{ status: string }>)[0].status).toBe('not_found')
    expect(deleteAssetData).not.toHaveBeenCalled()
  })

  it('一次删太多直接拒绝，让调用方分批跟用户核对', async () => {
    const r = await run({ assetKeys: Array.from({ length: 101 }, (_, i) => `k${i}`) })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('分批')
    expect(deleteAssetData).not.toHaveBeenCalled()
  })
})

describe('共用同一个文件的重复登记', () => {
  it('删掉一条之后，另一条还指着同一个保管库副本 —— 必须提醒别清空回收站', async () => {
    liveThenGone('dup1', { filePath: `${ASSET_ROOT}/tree.uasset` })
    getLiveAssetsByFilePath.mockReturnValue([{ assetKey: 'dup2', assetName: 'SM_Tree' }])

    const r = await run({ assetKeys: ['dup1'] })

    expect(String((r.shared_file_warnings as string[])[0])).toContain('清空回收站')
  })

  it('文件在保管库外面（原地引用）就不提醒 —— 清回收站根本不会动它', async () => {
    liveThenGone('ref1', { filePath: 'D:/我的素材/tree.fbx' })
    getLiveAssetsByFilePath.mockReturnValue([{ assetKey: 'ref2', assetName: 'SM_Tree' }])

    const r = await run({ assetKeys: ['ref1'] })

    expect(r.shared_file_warnings).toBeUndefined()
  })
})
