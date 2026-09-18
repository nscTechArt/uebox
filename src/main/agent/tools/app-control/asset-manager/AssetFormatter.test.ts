import { describe, expect, it, vi } from 'vitest'
import path from 'path'

/**
 * PathManager 在这里只当「当前活跃保管库是谁」的替身 ——
 * 测的是不传 vaultPath 时会不会错拼到活跃库上。
 */
const CURRENT_VAULT = path.join('C:', 'vaults', 'aigc')

vi.mock('../../../../utils/PathManager', () => ({
  PathManager: {
    getInstance: () => ({
      getCurrentVaultPath: () => CURRENT_VAULT,
      getThumbnailsPath: () => path.join(CURRENT_VAULT, 'thumbnails')
    })
  }
}))

import { formatAssets } from './AssetFormatter'

const DEFAULT_VAULT = path.join('D:', 'vaults', 'default')

/** 备份类型的库导入完就是这个样子：库里存相对路径，来源留在 originPath */
const backupRow = {
  assetName: 'AS_Idle',
  assetKey: 'key-1',
  folderKey: 'folder-1',
  filePath: path.join('20260906_120000', 'Game', 'KawaiiAnimations', 'AS_Idle.uasset'),
  originPath: path.join('I:', 'tmp', 'KawaiiAnimations', 'AS_Idle.uasset')
}

describe('formatAssets 的 real_path', () => {
  it('备份库的相对 filePath 拼回保管库，而不是回退到导入来源', () => {
    const [asset] = formatAssets([backupRow], { vaultPath: DEFAULT_VAULT })

    expect(asset.real_path).toBe(path.join(DEFAULT_VAULT, backupRow.filePath))
    expect(asset.realPath).toBe(asset.real_path)
  })

  it('跨库搜索时按资产自己那个库拼，不按当前活跃库', () => {
    const [asset] = formatAssets([backupRow], { vaultPath: DEFAULT_VAULT })

    expect(asset.real_path?.startsWith(DEFAULT_VAULT)).toBe(true)
    expect(asset.real_path?.startsWith(CURRENT_VAULT)).toBe(false)
  })

  it('绝对 filePath 原样用（引用库、AIGC 生成的文件都是这一路）', () => {
    const absolute = path.join(DEFAULT_VAULT, 'AIGC', '图片', 'a.png')
    const [asset] = formatAssets([{ ...backupRow, filePath: absolute }], {
      vaultPath: DEFAULT_VAULT
    })

    expect(asset.real_path).toBe(absolute)
  })

  it('缩略图不许顶替原文件 —— 它是 1024 以内的压缩件，导进工程就错了', () => {
    const [asset] = formatAssets([{ ...backupRow, imgLocalPath: 'thumbnail-key-1.png' }], {
      vaultPath: DEFAULT_VAULT
    })

    expect(asset.real_path).toBe(path.join(DEFAULT_VAULT, backupRow.filePath))
    // 缩略图本身照常从 imageUrl 出去，图生图那边还要用
    expect(asset.imageUrl).toBe('thumbnail-key-1.png')
  })

  it('没有 filePath 才轮到导入来源', () => {
    const [asset] = formatAssets([{ ...backupRow, filePath: undefined }], {
      vaultPath: DEFAULT_VAULT
    })

    expect(asset.real_path).toBe(backupRow.originPath)
  })

  it('两个路径都没有时才拿缩略图垫底，且挂在给定的库上', () => {
    const [asset] = formatAssets(
      [{ ...backupRow, filePath: undefined, originPath: undefined, imgLocalPath: 'thumb.png' }],
      { vaultPath: DEFAULT_VAULT }
    )

    expect(asset.real_path).toBe(path.join(DEFAULT_VAULT, 'thumbnails', 'thumb.png'))
  })

  it('不给 vaultPath 就按当前活跃库拼', () => {
    const [asset] = formatAssets([backupRow])

    expect(asset.real_path).toBe(path.join(CURRENT_VAULT, backupRow.filePath))
  })

  it('http / data: 不是本地路径，不能当 real_path', () => {
    const [asset] = formatAssets(
      [
        {
          ...backupRow,
          filePath: undefined,
          originPath: undefined,
          customPoster: 'https://example.com/a.png'
        }
      ],
      { vaultPath: DEFAULT_VAULT }
    )

    expect(asset.real_path).toBeUndefined()
  })
})

/**
 * 引擎版本要跟着结果一起回。
 *
 * .uasset 只能平进或往高版本进，所以这一栏是「能不能导进我这个工程」的唯一判据。
 * 它缺席的那段时间里，挑素材完全是盲的：真机上 51 个资产导进 5.5 工程，
 * 16 个因为是 5.7 存的被整条挡回来，而事前没有任何入口看得见这件事。
 */
describe('formatAssets 的 engineVersion', () => {
  it('库里记了版本就带上', () => {
    const [asset] = formatAssets([{ ...backupRow, engineVersion: '5.7.0' }])

    expect(asset.engineVersion).toBe('5.7.0')
  })

  it('库里没记就整个字段不出现 —— 不编一个版本号出来', () => {
    const [asset] = formatAssets([backupRow])

    expect('engineVersion' in asset).toBe(false)
  })
})
