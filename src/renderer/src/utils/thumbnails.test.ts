import { describe, it, expect } from 'vitest'
import {
  buildCompressedThumbnailUrl,
  buildDirectFileUrl,
  buildThumbnailUrl,
  toThumbFilename
} from './thumbnails'

describe('buildThumbnailUrl', () => {
  it('本地库拼出 local-resource:// URL（file:/// 在 dev 模式下加载不了）', () => {
    expect(buildThumbnailUrl('H:/vault', 'cover.png', false)).toBe(
      'local-resource://H:/vault/thumbnails/cover.png'
    )
  })

  it('网络库用 .thumbnails 目录', () => {
    expect(buildThumbnailUrl('H:/vault', 'cover.png', true)).toBe(
      'local-resource://H:/vault/.thumbnails/cover.png'
    )
  })

  it('已经带目录前缀时按库类型纠正', () => {
    expect(buildThumbnailUrl('H:/vault', '.thumbnails/cover.png', false)).toBe(
      'local-resource://H:/vault/thumbnails/cover.png'
    )
  })

  it('绝对路径直接转换，不再拼库路径', () => {
    expect(buildThumbnailUrl('H:/vault', 'D:/else/cover.png', false)).toBe(
      'local-resource://D:/else/cover.png'
    )
  })

  it('中文按段编码，盘符冒号保持原样', () => {
    expect(buildThumbnailUrl('H:/资产库', 'cover.png', false)).toBe(
      `local-resource://H:/${encodeURIComponent('资产库')}/thumbnails/cover.png`
    )
  })

  it('远程 HTTP 库仍然走 uebox-asset 代理', () => {
    expect(buildThumbnailUrl('http://127.0.0.1:8766/vault-1', 'cover.png', true)).toMatch(
      /^uebox-asset:\/\/file\?/
    )
  })

  it('缺参数返回 undefined', () => {
    expect(buildThumbnailUrl(undefined, 'cover.png')).toBeUndefined()
    expect(buildThumbnailUrl('H:/vault', undefined)).toBeUndefined()
  })
})

describe('buildCompressedThumbnailUrl', () => {
  it('自动换成 _thumb.jpg', () => {
    expect(toThumbFilename('cover.png')).toBe('cover_thumb.jpg')
    expect(buildCompressedThumbnailUrl('H:/vault', 'cover.png', false)).toBe(
      'local-resource://H:/vault/thumbnails/cover_thumb.jpg'
    )
  })
})

describe('buildDirectFileUrl', () => {
  it('本地库拼出 local-resource:// URL', () => {
    expect(buildDirectFileUrl('H:/vault', 'sub/pic.png')).toBe(
      'local-resource://H:/vault/sub/pic.png'
    )
  })

  it('绝对路径直接转换', () => {
    expect(buildDirectFileUrl('H:/vault', 'D:/else/pic.png')).toBe(
      'local-resource://D:/else/pic.png'
    )
  })

  it('远程库走 uebox-asset 代理，绝对路径无法代理时返回 undefined', () => {
    expect(buildDirectFileUrl('http://127.0.0.1:8766/vault-1', 'sub/pic.png', true)).toMatch(
      /^uebox-asset:\/\/file\?/
    )
    expect(buildDirectFileUrl('http://127.0.0.1:8766/vault-1', 'D:/pic.png', true)).toBeUndefined()
  })
})
