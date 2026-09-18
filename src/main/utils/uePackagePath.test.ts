import { describe, expect, it } from 'vitest'
import {
  containsAsset,
  isSameAsset,
  isUeAssetPath,
  toObjectPath,
  toPackagePath
} from './uePackagePath'

describe('uePackagePath', () => {
  it('把对象路径归一化成包路径', () => {
    expect(toPackagePath('/Game/Materials/M_Rock.M_Rock')).toBe('/Game/Materials/M_Rock')
  })

  it('包路径原样不动', () => {
    expect(toPackagePath('/Game/Materials/M_Rock')).toBe('/Game/Materials/M_Rock')
  })

  it('子对象归到它所在的包', () => {
    expect(toPackagePath('/Game/X/BP_Door.BP_Door:EventGraph')).toBe('/Game/X/BP_Door')
  })

  it('不碰目录名里的点', () => {
    // 砍最后一段里的点就够了；把整条路径上第一个点之后全砍掉会指到别的地方
    expect(toPackagePath('/Game/v1.2/M_Rock')).toBe('/Game/v1.2/M_Rock')
    expect(toPackagePath('/Game/v1.2/M_Rock.M_Rock')).toBe('/Game/v1.2/M_Rock')
  })

  it('非 UE 路径原样返回', () => {
    expect(toPackagePath('D:/somewhere/file.uasset')).toBe('D:/somewhere/file.uasset')
    expect(toPackagePath('')).toBe('')
  })

  it('补出对象路径', () => {
    expect(toObjectPath('/Game/Materials/M_Rock')).toBe('/Game/Materials/M_Rock.M_Rock')
    expect(toObjectPath('/Game/Materials/M_Rock.M_Rock')).toBe('/Game/Materials/M_Rock.M_Rock')
  })

  it('两种形状判成同一个资产', () => {
    expect(isSameAsset('/Game/X/M', '/Game/X/M.M')).toBe(true)
    expect(isSameAsset('/Game/X/M', '/Game/X/N')).toBe(false)
  })

  it('大小写不同不算同一个资产', () => {
    // UE 的资产路径大小写敏感，放宽会把两个不同的资产判成一个
    expect(isSameAsset('/Game/X/M_Rock', '/Game/X/m_rock')).toBe(false)
  })

  it('空路径不算相同', () => {
    expect(isSameAsset('', '')).toBe(false)
    expect(isSameAsset('/Game/X/M', '')).toBe(false)
  })

  it('在 ue_save 的 saved 列表里找目标资产', () => {
    // 这正是 ue_save 回执的形状：saved 是包名，调用方手里可能是对象路径
    const saved = ['/Game/X/BP_Door', '/Game/Y/M_Other']
    expect(containsAsset(saved, '/Game/X/BP_Door.BP_Door')).toBe(true)
    expect(containsAsset(saved, '/Game/X/BP_Window')).toBe(false)
    expect(containsAsset([], '/Game/X/BP_Door')).toBe(false)
    expect(containsAsset(undefined, '/Game/X/BP_Door')).toBe(false)
  })

  it('识别 UE 资产路径', () => {
    expect(isUeAssetPath('/Game/X/M')).toBe(true)
    expect(isUeAssetPath('Game/X/M')).toBe(false)
    expect(isUeAssetPath('/')).toBe(false)
  })
})
