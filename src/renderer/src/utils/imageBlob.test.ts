import { describe, it, expect, vi, afterEach } from 'vitest'
import { dataUrlToBlob, loadImageBlob, getImageExtension, downloadImage } from './imageBlob'

/** 1x1 透明 PNG */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('dataUrlToBlob', () => {
  it('base64 载荷按字节还原，MIME 跟着 data URL 走', async () => {
    const blob = dataUrlToBlob(PNG_DATA_URL)

    expect(blob.type).toBe('image/png')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(bytes.length).toBe(atob(PNG_BASE64).length)
  })

  it('非 base64 载荷按百分号编码还原（svg 常见）', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
    const blob = dataUrlToBlob(`data:image/svg+xml,${encodeURIComponent(svg)}`)

    expect(blob.type).toBe('image/svg+xml')
    expect(await blob.text()).toBe(svg)
  })

  it('不是 data URL 就直接报错，不要静默产出空图', () => {
    expect(() => dataUrlToBlob('https://example.com/a.png')).toThrow()
    expect(() => dataUrlToBlob('data:image/png;base64')).toThrow()
  })
})

describe('loadImageBlob', () => {
  it('data URL 自己解码，绝不走 fetch —— CSP 的 connect-src 不放行 data:', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const blob = await loadImageBlob(PNG_DATA_URL)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(blob.type).toBe('image/png')
  })

  it('其余协议照常走 fetch', async () => {
    const expected = new Blob(['x'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => expected })
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadImageBlob('local-resource://C:/a.png')).resolves.toBe(expected)
    expect(fetchMock).toHaveBeenCalledWith('local-resource://C:/a.png')
  })

  it('fetch 失败时抛错，不返回半个 Blob', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, statusText: 'Not Found' }))

    await expect(loadImageBlob('https://example.com/a.png')).rejects.toThrow('Not Found')
  })
})

describe('getImageExtension', () => {
  it('优先按 MIME 类型判断', () => {
    expect(getImageExtension('image/jpeg', 'https://example.com/a')).toBe('jpg')
    expect(getImageExtension('image/webp', 'https://example.com/a.png')).toBe('webp')
  })

  it('MIME 认不出就退回 URL 后缀', () => {
    expect(getImageExtension('', 'https://example.com/a.GIF?v=1')).toBe('gif')
  })

  it('两边都认不出按 png 处理', () => {
    expect(getImageExtension('application/octet-stream', 'data:image/png;base64,AAAA')).toBe('png')
  })
})

describe('downloadImage', () => {
  it('data URL 也能下载：不发请求，文件名带扩展名', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn()
    })
    const clickedDownloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clickedDownloads.push(this.download)
    })

    await downloadImage(PNG_DATA_URL)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(clickedDownloads).toHaveLength(1)
    expect(clickedDownloads[0]).toMatch(/^image_.*\.png$/)
    expect(document.querySelector('a')).toBeNull()
  })
})
