/**
 * 笔记里的图片从 base64 搬到磁盘。
 *
 * 这里的每一条都是「会丢用户东西」的红灯：
 *   - 迁移动的是用户写的 HTML，正则多吃一个字符他那段话就没了；
 *   - 落盘失败时必须留住原来的 base64，把 src 换成一个还不存在的路径等于删图。
 */
import { describe, expect, it } from 'vitest'

import {
  collectInlineImages,
  hasInlineImages,
  parseInlineImage,
  replaceInlineImageSources
} from './noteImages'

/** 1×1 透明 PNG */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgG'

describe('parseInlineImage', () => {
  it('认出 data URL 并解出字节', () => {
    const parsed = parseInlineImage(PNG)
    expect(parsed?.ext).toBe('png')
    expect(parsed?.bytes.length).toBeGreaterThan(0)
  })

  it('jpeg 落盘用 jpg', () => {
    expect(parseInlineImage(JPG)?.ext).toBe('jpg')
  })

  it('不是 data URL 的一律 null —— 已经搬走的图别再搬一次', () => {
    expect(parseInlineImage('local-resource://C:/vault/Notes/images/a.png')).toBeNull()
    expect(parseInlineImage('https://example.com/a.png')).toBeNull()
    expect(parseInlineImage('')).toBeNull()
  })

  it('坏掉的 base64 返回 null 而不是抛 —— 一张坏图不该让整篇笔记迁移失败', () => {
    expect(parseInlineImage('data:image/png;base64,@@@不是base64@@@')).toBeNull()
  })

  /*
    主进程 `note:saveImage` 的白名单只有 png/jpg/gif/webp/bmp，别的一律改写成 `png`。
    所以这边报了一个它存不了的格式，文件就会以 `.png` 落盘、里面是别的格式的字节；
    本地资源按扩展名给 Content-Type，那张图再也渲染不出来 —— 而正文里的 base64
    已经被换成这个路径了，等于把用户的图删了。
    存不了的格式返回 null，继续以 base64 留在正文里，照样显示。
  */
  it('主进程存不了的格式一律 null，宁可不搬也不能搬坏', () => {
    // SVG 尤其不能搬：它能带 <script>，作为本地资源加载等于开一个脚本执行入口
    expect(parseInlineImage('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull()
    expect(parseInlineImage('data:image/avif;base64,AAAAIGZ0eXBhdmlm')).toBeNull()
    expect(parseInlineImage('data:image/tiff;base64,SUkqAA==')).toBeNull()
    expect(parseInlineImage('data:image/heic;base64,AAAAIGZ0eXBoZWlj')).toBeNull()
  })

  it('白名单里的格式照旧搬', () => {
    expect(parseInlineImage('data:image/gif;base64,R0lGODlhAQABAAAAACw=')?.ext).toBe('gif')
    expect(parseInlineImage('data:image/webp;base64,UklGRhYAAABXRUJQ')?.ext).toBe('webp')
    expect(parseInlineImage('data:image/bmp;base64,Qk1GAAAAAAAAAA==')?.ext).toBe('bmp')
  })
})

describe('collectInlineImages', () => {
  it('找出正文里的 base64 图片', () => {
    const html = `<p>前</p><img src="${PNG}" class="editor-image"><p>后</p>`
    expect(collectInlineImages(html)).toHaveLength(1)
  })

  it('同一张图出现两次只搬一次', () => {
    const html = `<img src="${PNG}"><img src="${PNG}">`
    expect(collectInlineImages(html)).toHaveLength(1)
  })

  it('已经在磁盘上的图不算', () => {
    const html = '<img src="local-resource://C:/vault/Notes/images/a.png">'
    expect(collectInlineImages(html)).toHaveLength(0)
    expect(hasInlineImages(html)).toBe(false)
  })

  it('单双引号都认', () => {
    expect(collectInlineImages(`<img src='${PNG}'>`)).toHaveLength(1)
  })
})

describe('replaceInlineImageSources', () => {
  it('只替换搬走了的那些，其余原样留着', () => {
    const html = `<img src="${PNG}"><img src="${JPG}">`
    const next = replaceInlineImageSources(
      html,
      new Map([[PNG, 'local-resource://C:/vault/Notes/images/a.png']])
    )

    expect(next).toContain('local-resource://C:/vault/Notes/images/a.png')
    // 没搬成的那张必须还在 —— 换成一个不存在的路径等于把用户的图删了
    expect(next).toContain(JPG)
  })

  it('什么都没搬走时原样返回', () => {
    const html = `<p>正文</p><img src="${PNG}">`
    expect(replaceInlineImageSources(html, new Map())).toBe(html)
  })

  it('不碰正文里的其它内容', () => {
    const html = `<h1>标题</h1><p>一段<strong>重要</strong>的话</p><img src="${PNG}">`
    const next = replaceInlineImageSources(html, new Map([[PNG, 'local-resource://x.png']]))

    expect(next).toContain('<h1>标题</h1>')
    expect(next).toContain('一段<strong>重要</strong>的话')
  })

  it('同一张图的两处引用一起换掉', () => {
    const html = `<img src="${PNG}"><p>中间</p><img src="${PNG}">`
    const next = replaceInlineImageSources(html, new Map([[PNG, 'local-resource://x.png']]))

    expect(next).not.toContain('data:image/png')
    expect(next.match(/local-resource:\/\/x\.png/g)).toHaveLength(2)
  })
})
