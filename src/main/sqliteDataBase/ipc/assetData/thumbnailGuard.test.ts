/**
 * 缩略图写入与资产媒体读取的两道闸。
 *
 * 修复前：`asset:overwriteThumb` 把渲染层给的文件名直接 join 进缩略图目录再写文件
 * （传 `../../vault-data.db` 就能把一张 JPEG 覆盖到保管库数据库本体上），
 * `asset:readFileAsBase64` 把任意绝对路径原样读回 base64。
 */
import { resolve } from 'path'

import { describe, expect, it } from 'vitest'

import { denyMediaRead, isPlainFileName, isReadableMediaPath } from './thumbnailGuard'

describe('isPlainFileName', () => {
  it('普通文件名放行', () => {
    expect(isPlainFileName('cover.png')).toBe(true)
    expect(isPlainFileName('custom-1712-战士.jpg')).toBe(true)
  })

  it('带路径分隔符的一律拒绝', () => {
    expect(isPlainFileName('../../vault-data.db')).toBe(false)
    expect(isPlainFileName('..\\..\\vault-data.db')).toBe(false)
    expect(isPlainFileName('sub/cover.png')).toBe(false)
    expect(isPlainFileName('/etc/passwd')).toBe(false)
  })

  it('盘符形式也是路径，不是文件名', () => {
    expect(isPlainFileName('C:cover.png')).toBe(false)
    expect(isPlainFileName('C:\\Windows\\x.png')).toBe(false)
  })

  it('NUL 截断、空值、点目录一律拒绝', () => {
    expect(isPlainFileName('cover.png\u0000.txt')).toBe(false)
    expect(isPlainFileName('')).toBe(false)
    expect(isPlainFileName('   ')).toBe(false)
    expect(isPlainFileName('..')).toBe(false)
    expect(isPlainFileName(undefined)).toBe(false)
    expect(isPlainFileName(123)).toBe(false)
  })
})

describe('isReadableMediaPath', () => {
  it('图片与视频放行', () => {
    expect(isReadableMediaPath('D:/refs/a.PNG')).toBe(true)
    expect(isReadableMediaPath('D:/refs/clip.mp4')).toBe(true)
  })

  it('数据库、配置、源码一律拒绝', () => {
    expect(isReadableMediaPath('D:/vault/vault-data.db')).toBe(false)
    expect(isReadableMediaPath('C:/Users/me/.env')).toBe(false)
    expect(isReadableMediaPath('C:/app/main.js')).toBe(false)
    expect(isReadableMediaPath('C:/no-extension')).toBe(false)
  })
})

describe('denyMediaRead', () => {
  const VAULT = resolve('/vault')
  const scope = (isKnown = false): Parameters<typeof denyMediaRead>[1] => ({
    roots: [VAULT],
    isKnownAssetPath: () => isKnown
  })

  it('保管库里的图片放行', () => {
    expect(denyMediaRead(resolve('/vault/thumbnails/a.jpg'), scope())).toBeNull()
  })

  it('库外的图片，只要库里确实有这条资产就放行（引用型保管库）', () => {
    expect(denyMediaRead(resolve('/elsewhere/ref.png'), scope(true))).toBeNull()
  })

  it('库外、库里也没有的文件拒绝', () => {
    expect(denyMediaRead(resolve('/elsewhere/ref.png'), scope())).toContain('不属于当前资产库')
  })

  it('非媒体文件先被扩展名挡下，连库内也不例外', () => {
    expect(denyMediaRead(resolve('/vault/vault-data.db'), scope(true))).toContain('图片或视频')
  })

  it('空值不放行', () => {
    expect(denyMediaRead('', scope(true))).not.toBeNull()
    expect(denyMediaRead(undefined, scope(true))).not.toBeNull()
  })
})
