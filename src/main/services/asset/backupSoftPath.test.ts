/**
 * 备份模式下 softPath 的兜底推导。
 *
 * 红灯用例是第一条：原兜底是 `/Game/<文件名>`，不含任何目录。而备份清单正是按
 * softPath 去重的 —— `A/preview.png` 和 `B/preview.png` 被判成同一个资产，
 * 其中一个直接被剔除出备份清单：它没被复制进保管库，数据库记录指向用户的原始目录，
 * **源文件夹一清理就变成死链接**。而同名文件在 UE 工程里是常态。
 */
import { describe, expect, it } from 'vitest'

import { deriveFallbackSoftPath, deriveSoftPathFromDiskPath } from './backupSoftPath'

describe('deriveFallbackSoftPath', () => {
  it('不同目录下的同名文件必须得到不同的 softPath', () => {
    const root = 'D:/src/Pack'
    const a = deriveFallbackSoftPath('D:/src/Pack/A/preview.png', root)
    const b = deriveFallbackSoftPath('D:/src/Pack/B/preview.png', root)

    // 旧实现：两个都是 `/Game/preview`，于是其中一个被丢掉
    expect(a).not.toBe(b)
    expect(a).toBe('/Game/Pack/A/preview')
    expect(b).toBe('/Game/Pack/B/preview')
  })

  it('保留相对于导入根目录的完整层级', () => {
    expect(deriveFallbackSoftPath('D:/src/Pack/Textures/Rock/T_Base.png', 'D:/src/Pack')).toBe(
      '/Game/Pack/Textures/Rock/T_Base'
    )
  })

  it('反斜杠路径（Windows）同样处理', () => {
    expect(deriveFallbackSoftPath('D:\\src\\Pack\\A\\preview.png', 'D:\\src\\Pack')).toBe(
      '/Game/Pack/A/preview'
    )
  })

  it('磁盘路径里有 UE 工程结构时优先按它推', () => {
    expect(deriveFallbackSoftPath('D:/MyProj/Content/Meshes/SM_Rock.uasset', 'D:/MyProj')).toBe(
      '/Game/Meshes/SM_Rock'
    )
  })

  it('散文件导入（根是 ALL）也不会撞', () => {
    const a = deriveFallbackSoftPath('D:/one/preview.png', 'ALL')
    const b = deriveFallbackSoftPath('E:/two/preview.png', 'ALL')

    expect(a).not.toBe(b)
    expect(a).toBe('/Game/one/preview')
    expect(b).toBe('/Game/two/preview')
  })

  it('文件不在导入根目录下时用它自己的完整目录', () => {
    expect(deriveFallbackSoftPath('D:/elsewhere/x.png', 'D:/src/Pack')).toBe('/Game/elsewhere/x')
  })

  it('同时导入两个同名子目录也不撞（根目录名也带上）', () => {
    const a = deriveFallbackSoftPath('D:/PackA/Common/icon.png', 'D:/PackA')
    const b = deriveFallbackSoftPath('D:/PackB/Common/icon.png', 'D:/PackB')

    expect(a).not.toBe(b)
  })

  it('空路径返回空串，不返回半截', () => {
    expect(deriveFallbackSoftPath('', 'D:/src')).toBe('')
  })
})

describe('deriveSoftPathFromDiskPath', () => {
  it('认出 Content 目录', () => {
    expect(deriveSoftPathFromDiskPath('D:/P/Content/Meshes/SM_A.uasset')).toBe('/Game/Meshes/SM_A')
  })

  it('认出 Game 目录', () => {
    expect(deriveSoftPathFromDiskPath('D:/backup/Game/Props/SM_B.uasset')).toBe('/Game/Props/SM_B')
  })

  it('认不出来返回空串，交给上层兜底', () => {
    expect(deriveSoftPathFromDiskPath('D:/random/a.png')).toBe('')
  })
})
