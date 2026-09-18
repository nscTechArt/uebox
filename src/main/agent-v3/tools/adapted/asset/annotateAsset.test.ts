/**
 * @vitest-environment node
 *
 * 写完备注/标签要通知界面。
 *
 * 不通知的后果不是「晚一点更新」，而是用户正开着素材库页面、agent 说「写好了」、
 * 列表纹丝不动 —— 看起来就是在骗他。
 *
 * 另一半是批量：用户说的是「把这个包都标上」，一次只能写一个的话等于做不了。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { addAssetNote, addAssetTags, selectFolderAssetKeys, send } = vi.hoisted(() => ({
  addAssetNote: vi.fn(),
  addAssetTags: vi.fn(),
  selectFolderAssetKeys: vi.fn(),
  send: vi.fn()
}))

vi.mock('../../../../agent/tools/app-control/asset-manager/AssetController', () => ({
  addAssetNote,
  addAssetTags
}))
vi.mock('../../../../appWindows', () => ({ getAppWindows: () => [{ webContents: { send } }] }))
vi.mock('../../../../sqliteDataBase', () => ({ getVaultDatabase: () => ({}) }))
vi.mock('./folderAssets', () => ({ selectFolderAssetKeys }))

import { createAnnotateAssetTool } from './annotateAsset'

const tool = createAnnotateAssetTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

beforeEach(() => {
  addAssetNote.mockReset().mockResolvedValue({ success: true })
  addAssetTags.mockReset().mockResolvedValue({ success: true })
  selectFolderAssetKeys.mockReset().mockReturnValue({
    folderKey: 'k_so',
    folderLabel: '/ALL/SoStylized',
    assetKeys: ['a1', 'a2', 'a3'],
    total: 3,
    offset: 0,
    hasMore: false
  })
  send.mockReset()
})

describe('annotate_asset', () => {
  it('写备注之后通知界面刷新', async () => {
    await run({ assetKey: 'a1', note: '主角用的' })

    expect(send).toHaveBeenCalledWith(
      'asset:changed',
      expect.objectContaining({ source: 'agent', op: 'annotate' })
    )
  })

  it('只打标签也通知', async () => {
    await run({ assetKey: 'a1', tagNames: ['角色'] })

    expect(addAssetTags).toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('底层没写成就不通知 —— 界面没有需要刷新的东西', async () => {
    addAssetNote.mockResolvedValue({ success: false, error: '资产不存在' })

    const r = await run({ assetKey: 'ghost', note: 'x' })

    expect(r.success).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('什么都不给时直接拒绝，不空跑一趟', async () => {
    const r = await run({ assetKey: 'a1' })

    expect(r.success).toBe(false)
    expect(addAssetNote).not.toHaveBeenCalled()
    expect(addAssetTags).not.toHaveBeenCalled()
  })

  it('一个目标都没有时直接拒绝', async () => {
    const r = await run({ note: 'x' })

    expect(r.success).toBe(false)
    expect(addAssetNote).not.toHaveBeenCalled()
  })
})

describe('批量写', () => {
  it('assetKeys 一次写一批，界面只通知一次', async () => {
    const r = await run({ assetKeys: ['a1', 'a2'], tagNames: ['角色'] })

    expect(addAssetTags).toHaveBeenCalledTimes(2)
    expect(r.written_count).toBe(2)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('folder 自己展开成一批 —— 不用调用方先枚举', async () => {
    const r = await run({ folder: 'SoStylized', tagNames: ['风格化'] })

    expect(selectFolderAssetKeys).toHaveBeenCalledWith(
      expect.anything(),
      'SoStylized',
      expect.objectContaining({ limit: 200 })
    )
    expect(addAssetTags).toHaveBeenCalledTimes(3)
    expect(r.written_count).toBe(3)
    expect(r.folder_selection).toMatchObject({ folder: '/ALL/SoStylized', total: 3 })
  })

  it('文件夹没写完时把下一批的偏移量说出来', async () => {
    selectFolderAssetKeys.mockReturnValue({
      folderKey: 'k_so',
      folderLabel: '/ALL/SoStylized',
      assetKeys: ['a1'],
      total: 776,
      offset: 0,
      hasMore: true,
      nextOffset: 200
    })

    const r = await run({ folder: 'SoStylized', tagNames: ['风格化'] })

    expect(r.folder_selection).toMatchObject({ hasMore: true, nextFolderOffset: 200 })
    expect(String(r.message)).toContain('folderOffset=200')
  })

  it('重复的 key 只写一次', async () => {
    await run({ assetKey: 'a1', assetKeys: ['a1', 'a2'], tagNames: ['角色'] })

    expect(addAssetTags).toHaveBeenCalledTimes(2)
  })

  it('一条失败不带垮整批，但整体不算成功', async () => {
    addAssetTags
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: '资产不存在' })

    const r = await run({ assetKeys: ['a1', 'ghost'], tagNames: ['角色'] })

    expect(r.written_count).toBe(1)
    expect(r.success).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('一次写太多直接拒绝', async () => {
    const r = await run({
      assetKeys: Array.from({ length: 201 }, (_, i) => `k${i}`),
      tagNames: ['角色']
    })

    expect(r.success).toBe(false)
    expect(addAssetTags).not.toHaveBeenCalled()
  })

  it('文件夹是空的就报错，不装作写完了', async () => {
    selectFolderAssetKeys.mockReturnValue({
      folderKey: 'k_so',
      folderLabel: '/ALL/SoStylized',
      assetKeys: [],
      total: 0,
      offset: 0,
      hasMore: false
    })

    const r = await run({ folder: 'SoStylized', tagNames: ['风格化'] })

    expect(r.success).toBe(false)
    expect(addAssetTags).not.toHaveBeenCalled()
  })

  it('文件夹认不准时整批不动', async () => {
    selectFolderAssetKeys.mockReturnValue({ error: '库里有 2 个叫「Textures」的文件夹' })

    const r = await run({ folder: 'Textures', tagNames: ['贴图'] })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('2 个')
    expect(addAssetTags).not.toHaveBeenCalled()
  })
})
