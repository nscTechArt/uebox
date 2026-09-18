import { describe, expect, it } from 'vitest'
import { resolveAssetThumbnailRefs, resolveVaultThumbnailName } from './remoteThumbnailRefs'

/** 只有这几个文件名当作「本地缩略图目录里真有这个文件」 */
function existsAmong(...names: string[]): (fileName: string) => boolean {
  return (fileName) => names.includes(fileName)
}

describe('resolveVaultThumbnailName', () => {
  it('普通文件名原样返回', () => {
    expect(resolveVaultThumbnailName('thumbnail-abc.jpeg')).toBe('thumbnail-abc.jpeg')
  })

  it('目录前缀要剥掉 —— 库里存过好几种形态', () => {
    expect(resolveVaultThumbnailName('thumbnails/custom-1.png')).toBe('custom-1.png')
    expect(resolveVaultThumbnailName('.thumbnails/custom-1.png')).toBe('custom-1.png')
    expect(resolveVaultThumbnailName('assetData\\custom-1.png')).toBe('custom-1.png')
    expect(resolveVaultThumbnailName('C:/vault/thumbnails/custom-1.png')).toBe('custom-1.png')
    expect(resolveVaultThumbnailName('file:///C:/vault/thumbnails/custom-1.png')).toBe(
      'custom-1.png'
    )
  })

  it('外链封面不归缩略图目录管', () => {
    expect(resolveVaultThumbnailName('http://host/a.png')).toBeNull()
    expect(resolveVaultThumbnailName('https://cdn.example.com/a.png')).toBeNull()
  })

  it('穿越被拆成纯文件名，跑不出缩略图目录', () => {
    // 剥到最后一段就没有 `..` 了，join 出来必然还在 thumbnails/ 里面
    expect(resolveVaultThumbnailName('../../secret.png')).toBe('secret.png')
    expect(resolveVaultThumbnailName('..\\..\\secret.png')).toBe('secret.png')
  })

  it('剥完不是纯文件名的、以及空值，一律不认', () => {
    expect(resolveVaultThumbnailName('..')).toBeNull()
    expect(resolveVaultThumbnailName('../..')).toBeNull()
    expect(resolveVaultThumbnailName('a\0.png')).toBeNull()
    expect(resolveVaultThumbnailName('')).toBeNull()
    expect(resolveVaultThumbnailName('   ')).toBeNull()
    expect(resolveVaultThumbnailName(undefined)).toBeNull()
    expect(resolveVaultThumbnailName(123)).toBeNull()
  })
})

describe('resolveAssetThumbnailRefs', () => {
  it('文件在，引用原样保留并进上传清单', () => {
    const asset = { assetKey: 'k1', imgLocalPath: 'thumbnail-k1.jpeg' }
    const result = resolveAssetThumbnailRefs(asset, existsAmong('thumbnail-k1.jpeg'))

    expect(result.queued).toEqual(['thumbnail-k1.jpeg'])
    expect(result.pending).toEqual([])
    // 没改动就不复制，调用方手上那份记录也没被动过
    expect(result.asset).toBe(asset)
  })

  it('带前缀的引用要拉平成文件名，而不是判成丢失', () => {
    const asset = { assetKey: 'k1', customPoster: 'thumbnails/custom-1.png' }
    const result = resolveAssetThumbnailRefs(asset, existsAmong('custom-1.png'))

    // 探测用的是剥掉前缀之后的名字
    expect(result.queued).toEqual(['custom-1.png'])
    expect(result.pending).toEqual([])
    // 发出去的值也得是那个名字，否则服务端拿原值比对照样对不上
    expect(result.asset.customPoster).toBe('custom-1.png')
    // 本地库里那行不动
    expect(asset.customPoster).toBe('thumbnails/custom-1.png')
  })

  it('file:// 形态同样要认出来，不能当外链放过去', () => {
    const asset = { assetKey: 'k1', customPoster: 'file:///C:/vault/thumbnails/custom-1.png' }
    const result = resolveAssetThumbnailRefs(asset, existsAmong('custom-1.png'))

    expect(result.queued).toEqual(['custom-1.png'])
    expect(result.asset.customPoster).toBe('custom-1.png')
  })

  it('本地没有只进 pending，不当场摘掉 —— 服务器上可能有', () => {
    const asset = { assetKey: 'k1', imgLocalPath: 'thumbnail-k1.jpeg' }
    const result = resolveAssetThumbnailRefs(asset, existsAmong())

    expect(result.queued).toEqual([])
    expect(result.pending).toEqual([{ field: 'imgLocalPath', fileName: 'thumbnail-k1.jpeg' }])
    // 这一步不许动值：抹掉是整条 upsert 上去的，会洗掉所有人的封面
    expect(result.asset.imgLocalPath).toBe('thumbnail-k1.jpeg')
  })

  it('http 封面不查存在性，也不许被抹掉', () => {
    const asset = { assetKey: 'k1', customPoster: 'https://cdn.example.com/a.png' }
    const result = resolveAssetThumbnailRefs(asset, existsAmong())

    expect(result.asset.customPoster).toBe('https://cdn.example.com/a.png')
    expect(result.queued).toEqual([])
    expect(result.pending).toEqual([])
  })

  it('穿越路径被拆成文件名，探测和上传都留在缩略图目录里', () => {
    const asset = { assetKey: 'k1', imgLocalPath: '../../secret.png' }
    // 原值那种形态永远探不到，只有剥干净的 secret.png 才会被问
    const result = resolveAssetThumbnailRefs(asset, existsAmong('../../secret.png'))

    expect(result.queued).toEqual([])
    expect(result.pending).toEqual([{ field: 'imgLocalPath', fileName: 'secret.png' }])
    expect(result.asset.imgLocalPath).toBe('secret.png')
  })

  it('剥完不成文件名的值原样放过，不上传也不摘', () => {
    const asset = { assetKey: 'k1', imgLocalPath: '../..' }
    const result = resolveAssetThumbnailRefs(asset, existsAmong())

    expect(result.queued).toEqual([])
    expect(result.pending).toEqual([])
    expect(result.asset).toBe(asset)
  })

  it('两个字段指同一个文件时上传清单只留一份', () => {
    const asset = {
      assetKey: 'k1',
      imgLocalPath: 'same.jpeg',
      customPoster: 'thumbnails/same.jpeg'
    }
    const result = resolveAssetThumbnailRefs(asset, existsAmong('same.jpeg'))

    expect(result.queued).toEqual(['same.jpeg'])
    expect(result.pending).toEqual([])
  })

  it('没有缩略图字段时什么也不做', () => {
    const asset = { assetKey: 'k1' }
    const result = resolveAssetThumbnailRefs(asset, existsAmong())

    expect(result.asset).toBe(asset)
    expect(result.queued).toEqual([])
    expect(result.pending).toEqual([])
  })
})
