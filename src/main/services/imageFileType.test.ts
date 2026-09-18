import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_EXTENSION,
  decodeImageDataUri,
  mediaTypeFromContentType,
  resolveImageExtension
} from './imageFileType'

/** 造一段带指定文件头的字节 */
function bytes(...head: Array<number | string>): Uint8Array {
  const flat: number[] = []
  for (const part of head) {
    if (typeof part === 'number') flat.push(part)
    else flat.push(...[...part].map((char) => char.charCodeAt(0)))
  }
  return Uint8Array.from([...flat, 0, 0, 0, 0])
}

describe('decodeImageDataUri', () => {
  /**
   * 老代码用 `replace(/^data:image\/\w+;base64,/, '')` 把类型匹配到了又原地扔掉，
   * 扩展名于是只能写死 png。类型和数据必须一次取出，不能分两处各匹配一遍。
   */
  it('类型和数据一次取出', () => {
    expect(decodeImageDataUri('data:image/webp;base64,AAAA')).toEqual({
      mediaType: 'image/webp',
      base64: 'AAAA'
    })
  })

  it('类型大小写不敏感，统一成小写', () => {
    expect(decodeImageDataUri('data:IMAGE/JPEG;base64,AAAA').mediaType).toBe('image/jpeg')
  })

  it('没写类型的 data URI 只回数据', () => {
    expect(decodeImageDataUri('data:;base64,AAAA')).toEqual({ mediaType: null, base64: 'AAAA' })
  })

  it('压根不是 data URI 时原样当数据回，不抛错', () => {
    // 上游偶尔会直接给裸 base64，这里不该把整条链路弄崩
    expect(decodeImageDataUri('AAAA')).toEqual({ mediaType: null, base64: 'AAAA' })
  })
})

describe('mediaTypeFromContentType', () => {
  it('切掉参数部分', () => {
    expect(mediaTypeFromContentType('image/webp; charset=binary')).toBe('image/webp')
  })

  it('缺响应头时回 null 而不是空串', () => {
    expect(mediaTypeFromContentType(null)).toBeNull()
    expect(mediaTypeFromContentType('   ')).toBeNull()
  })
})

describe('resolveImageExtension', () => {
  it('厂商声明的类型优先', () => {
    expect(resolveImageExtension({ mediaType: 'image/webp' })).toBe('webp')
    expect(resolveImageExtension({ mediaType: 'image/gif' })).toBe('gif')
  })

  /** jpeg 统一写成 jpg，与用户手里的其它素材保持一致 */
  it('jpeg 与 jpg 都落到 jpg', () => {
    expect(resolveImageExtension({ mediaType: 'image/jpeg' })).toBe('jpg')
    expect(resolveImageExtension({ mediaType: 'image/jpg' })).toBe('jpg')
  })

  it('没有声明类型时看 URL 路径，且不被查询串里的 .png 骗到', () => {
    expect(resolveImageExtension({ url: 'https://cdn.example.com/a/b.webp?fallback=x.png' })).toBe(
      'webp'
    )
  })

  /** 域名里的点不是扩展名。`cdn.example.com/download` 曾经会被切出个 `com/download` */
  it('路径里没有扩展名时不拿域名的点当扩展名', () => {
    expect(resolveImageExtension({ url: 'https://cdn.example.com/download' })).toBe(
      DEFAULT_IMAGE_EXTENSION
    )
  })

  /**
   * 厂商回一个 application/octet-stream 是常有的事。这时候与其盲写 png，
   * 不如看文件头 —— 那几个字节不会说谎。
   */
  it.each([
    ['png', bytes(0x89, 'PNG')],
    ['jpg', bytes(0xff, 0xd8, 0xff)],
    ['gif', bytes('GIF8')],
    ['bmp', bytes('BM')],
    ['webp', bytes('RIFF', 0, 0, 0, 0, 'WEBP')],
    ['avif', bytes(0, 0, 0, 0x20, 'ftypavif')]
  ])('类型说不清时按文件头认出 %s', (expected, head) => {
    expect(resolveImageExtension({ mediaType: 'application/octet-stream', bytes: head })).toBe(
      expected
    )
  })

  it('声明的类型压过文件头 —— 认得出的声明就按声明来', () => {
    expect(resolveImageExtension({ mediaType: 'image/webp', bytes: bytes(0x89, 'PNG') })).toBe(
      'webp'
    )
  })

  /**
   * 兜底选 png 而不是 bin：认不出的东西绝大多数仍然是张图，
   * 给个图片扩展名至少双击能打开；给 .bin 是把「不确定」变成「肯定用不了」。
   */
  it('全都认不出来时回落到 png', () => {
    expect(resolveImageExtension({})).toBe(DEFAULT_IMAGE_EXTENSION)
    expect(
      resolveImageExtension({
        mediaType: 'application/octet-stream',
        url: 'https://cdn.example.com/download',
        bytes: bytes(0x00, 0x01, 0x02)
      })
    ).toBe('png')
  })
})
