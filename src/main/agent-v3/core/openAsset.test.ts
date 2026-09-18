import { beforeEach, describe, expect, it, vi } from 'vitest'

const runEditorPython = vi.fn()
vi.mock('./editorPython', () => ({
  runEditorPython: (...args: unknown[]) => runEditorPython(...args)
}))

import { isContentPath, openAssetInEditor } from './openAsset'

describe('isContentPath', () => {
  it('引擎内的资产路径', () => {
    expect(isContentPath('/Game/GlowDemo/M_GlowBreath')).toBe(true)
    expect(isContentPath('/Engine/BasicShapes/Cube')).toBe(true)
    expect(isContentPath('/MyPlugin/Stuff/BP_Thing')).toBe(true)
  })

  it('Actor 名和本地文件路径都不是 —— 那两种在编辑器里打不开', () => {
    expect(isContentPath('Cube')).toBe(false)
    expect(isContentPath('D:/proj/说明.html')).toBe(false)
    expect(isContentPath('/Game')).toBe(false)
    expect(isContentPath('')).toBe(false)
  })
})

describe('openAssetInEditor', () => {
  beforeEach(() => {
    runEditorPython.mockReset()
  })

  it('不是资产路径就根本不去打扰引擎', async () => {
    expect(await openAssetInEditor('Cube')).toMatchObject({ success: false })
    expect(runEditorPython).not.toHaveBeenCalled()
  })

  it('打开成功', async () => {
    runEditorPython.mockResolvedValue({ success: true, output: { opened: true, missing: false } })

    expect(await openAssetInEditor('/Game/M_A')).toEqual({ success: true, opened: true })
  })

  it('资产已经开着时引擎回 false —— 那不是失败，用户要的窗口本来就在', async () => {
    runEditorPython.mockResolvedValue({ success: true, output: { opened: false, missing: false } })

    expect(await openAssetInEditor('/Game/M_A')).toMatchObject({ success: true })
  })

  it('资产不在了要说清楚，别只回一个 false', async () => {
    runEditorPython.mockResolvedValue({ success: true, output: { opened: false, missing: true } })

    const result = await openAssetInEditor('/Game/M_Gone')
    expect(result.success).toBe(false)
    expect(result.error).toContain('不存在')
  })

  it('引擎没连上时把原因透出去', async () => {
    runEditorPython.mockResolvedValue({ success: false, error: '没有连接的虚幻引擎项目' })

    expect(await openAssetInEditor('/Game/M_A')).toEqual({
      success: false,
      error: '没有连接的虚幻引擎项目'
    })
  })
})
