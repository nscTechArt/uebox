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
    'localhost:3000',
    'not a url'
  ])('拒绝非法或危险地址 %s', (input) => {
    expect(() => normalizeBrowserAddress(input)).toThrow()
  })
})
