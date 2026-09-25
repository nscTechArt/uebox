import { describe, it, expect } from 'vitest'
import { toLocalResourceUrl } from './localResource'

describe('toLocalResourceUrl', () => {
  it('把 Windows 绝对路径转成 local-resource:// URL', () => {
    expect(toLocalResourceUrl('C:\\Users\\me\\Pictures\\cover.png')).toBe(
      'local-resource://C:/Users/me/Pictures/cover.png'
    )
  })

  it('保留盘符里的冒号，不做百分号编码', () => {
    const url = toLocalResourceUrl('D:/a/b.png') as string
    expect(url.startsWith('local-resource://D:/')).toBe(true)
  })

  it('对中文等特殊字符按段编码', () => {
    expect(toLocalResourceUrl('H:/资产库/封面 1.png')).toBe(
      `local-resource://H:/${encodeURIComponent('资产库')}/${encodeURIComponent('封面 1.png')}`
    )
  })

  it('把 file:/// URL 转成 local-resource://（并还原百分号转义）', () => {
    expect(toLocalResourceUrl('file:///C:/db/thumbnails/project_cover_1.png')).toBe(
      'local-resource://C:/db/thumbnails/project_cover_1.png'
    )
    expect(toLocalResourceUrl(`file:///H:/${encodeURIComponent('资产库')}/a.png`)).toBe(
      `local-resource://H:/${encodeURIComponent('资产库')}/a.png`
    )
  })

  it('POSIX 绝对路径去掉前导斜杠后交给协议还原', () => {
    expect(toLocalResourceUrl('/home/me/cover.png')).toBe('local-resource://home/me/cover.png')
  })

  it('http/https/data/blob/uebox-asset/uebox-preview 原样返回', () => {
    const passthrough = [
      'https://cdn.example.com/a.png',
      'http://127.0.0.1:8766/a.png',
      'data:image/png;base64,AAAA',
      'blob:file:///abc',
      'uebox-asset://file?path=a',
      'uebox-preview://thumb/ab/s256?l=k&u=x',
      'local-resource://C:/a.png'
    ]
    for (const url of passthrough) {
      expect(toLocalResourceUrl(url)).toBe(url)
    }
  })

  it('空值返回 undefined，让调用方回落到占位图', () => {
    expect(toLocalResourceUrl(undefined)).toBeUndefined()
    expect(toLocalResourceUrl(null)).toBeUndefined()
    expect(toLocalResourceUrl('')).toBeUndefined()
    expect(toLocalResourceUrl('   ')).toBeUndefined()
  })

  it('UNC 路径保持 file:// 形式（local-resource 还原不了主机名）', () => {
    expect(toLocalResourceUrl('\\\\nas\\share\\cover.png')).toBe('file://nas/share/cover.png')
  })
})
