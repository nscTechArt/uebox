import { expect, it } from 'vitest'
import { listThumbnailUrl } from './listThumbnail'

it('requests small local images without changing the original URL or cache query', () => {
  const original = 'local-resource://C:/images/a.png?v=2'
  expect(listThumbnailUrl(original)).toBe(`${original}&listThumbnail=400`)
  expect(listThumbnailUrl(listThumbnailUrl(original))).toBe(`${original}&listThumbnail=400`)
  expect(original).toBe('local-resource://C:/images/a.png?v=2')
  expect(listThumbnailUrl('file:///C:/images/a.png')).toBe(
    'local-resource://C:/images/a.png?listThumbnail=400'
  )
})

it('preserves absent, remote and video resources', () => {
  for (const url of [undefined, 'https://example.com/a.png', 'local-resource://C:/a.mp4']) {
    expect(listThumbnailUrl(url)).toBe(url)
  }
})

it('requests a static GIF thumbnail and a fresh request after folder reload', () => {
  const url = 'local-resource://C:/a.gif'
  expect(listThumbnailUrl(url, 1)).toBe(`${url}?listThumbnail=400&revision=1`)
  expect(listThumbnailUrl(url, 2)).not.toBe(listThumbnailUrl(url, 1))
})
