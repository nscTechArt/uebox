import { describe, expect, it } from 'vitest'
import { normalizeBrowserAddress } from './address'

describe('手动浏览器地址', () => {
  it.each([
    [' unrealengine.com/feed?tags=news ', 'https://unrealengine.com/feed?tags=news'],
    ['https://example.com/a#b', 'https://example.com/a#b'],
    ['http://example.com/', 'http://example.com/'],
    ['example.com:8443/path', 'https://example.com:8443/path'],
    ['//example.com/path', 'https://example.com/path']
  ])('补全地址 %s', (input, expected) => {
    expect(normalizeBrowserAddress(input)).toBe(expected)
  })
  it.each([
    '',
    ' ',
    null,
    {},
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://127.0.0.1',
    'localhost:3000'
  ])('拒绝非法或危险地址 %s', (input) => {
    expect(() => normalizeBrowserAddress(input)).toThrow()
  })
  it.each([
    ['not a url', 'https://www.bing.com/search?q=not%20a%20url'],
    ['unrealengine', 'https://www.bing.com/search?q=unrealengine'],
    [
      '  虚幻 5.4 材质 ',
      'https://www.bing.com/search?q=%E8%99%9A%E5%B9%BB%205.4%20%E6%9D%90%E8%B4%A8'
    ]
  ])('不像网址的输入拿去搜 %s', (input, expected) => {
    expect(normalizeBrowserAddress(input)).toBe(expected)
  })
})
