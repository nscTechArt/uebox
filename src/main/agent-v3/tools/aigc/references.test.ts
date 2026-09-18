/**
 * @vitest-environment node
 *
 * 参考图的读取。
 *
 * 这一层最容易出的错是**静默**的：路径不对就少传一张参考图，出来的图看着
 * 也挺像样，只是和用户的白盒毫无关系。所以每一条读不进来的路都要抛。
 */

import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const toBuffer = vi.fn(async () => Buffer.from('shrunk'))
const jpeg = vi.fn(() => ({ toBuffer }))
const resize = vi.fn(() => ({ jpeg }))

vi.mock('../../../utils/sharpLoader', () => ({
  getSharp: async () => () => ({ resize })
}))

import { loadReferenceImage, loadReferenceImages, VIDEO_REFERENCE_BUDGET } from './references'

async function writeTempImage(name: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aigc-refs-'))
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

afterEach(() => {
  resize.mockClear()
})

describe('本地文件', () => {
  it('按扩展名给出正确的媒体类型 —— 认错了厂商会当成损坏的图', async () => {
    const path = await writeTempImage('shot.jpg', Buffer.from('jpeg-bytes'))

    expect(await loadReferenceImage(path)).toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`
    )
  })

  it('大图先缩再发 —— 一张 4K PNG 原样发过去换来的是一次 413', async () => {
    const path = await writeTempImage('huge.png', Buffer.alloc(5 * 1024 * 1024, 1))

    const loaded = await loadReferenceImage(path)

    expect(resize).toHaveBeenCalledWith({ width: 2048, withoutEnlargement: true })
    expect(loaded).toBe(`data:image/jpeg;base64,${Buffer.from('shrunk').toString('base64')}`)
  })

  it('小图不动它 —— 重新编码只会白白掉画质', async () => {
    const path = await writeTempImage('small.png', Buffer.from('tiny'))

    await loadReferenceImage(path)

    expect(resize).not.toHaveBeenCalled()
  })
})

/**
 * 生视频那条路的账完全不同：一次最多 30 张参考图（Seedance 2.5 全模态参考）
 * 挤在同一个 64MB 的请求体里，而 base64 还要撑到 4/3。
 *
 * 按生图那套「4MB 以下不动」来，30 张 1080p 的 PNG 截图就是 150MB —— 必然 413，
 * 而 413 在界面上只表现为「生成失败」，没人查得出问题在参考图上。
 */
describe('视频那条路的预算', () => {
  it('不管多小都归一化 —— 30 张挤一个请求体，原样 PNG 一定超', async () => {
    const path = await writeTempImage('small.png', Buffer.from('tiny'))

    await loadReferenceImage(path, VIDEO_REFERENCE_BUDGET)

    expect(resize).toHaveBeenCalledWith({ width: 1536, withoutEnlargement: true })
  })

  it('限宽比生图更紧，但仍远在厂商要求的 [300, 6000] 区间内', () => {
    expect(VIDEO_REFERENCE_BUDGET.maxWidth).toBeGreaterThanOrEqual(300)
    expect(VIDEO_REFERENCE_BUDGET.maxWidth).toBeLessThanOrEqual(6000)
  })

  it('整批都按同一个预算走，不会有几张漏掉', async () => {
    const a = await writeTempImage('a.png', Buffer.from('tiny'))
    const b = await writeTempImage('b.png', Buffer.from('tiny'))

    await loadReferenceImages([a, b], VIDEO_REFERENCE_BUDGET)

    expect(resize).toHaveBeenCalledTimes(2)
  })
})

describe('挡下来的输入', () => {
  it('相对路径', async () => {
    await expect(loadReferenceImage('shots/a.png')).rejects.toThrow(/绝对路径/)
  })

  it('空字符串', async () => {
    await expect(loadReferenceImage('   ')).rejects.toThrow(/空字符串/)
  })

  it('凭据目录 —— 生图参数也是一条能把私钥读出去的路', async () => {
    await expect(loadReferenceImage('C:\\Users\\me\\.ssh\\id_rsa')).rejects.toThrow(/凭据/)
  })

  it('文件不存在时说清去哪拿一张', async () => {
    await expect(loadReferenceImage('H:\\不存在的目录\\a.png')).rejects.toThrow(/ue_screenshot/)
  })
})

describe('直接放行的输入', () => {
  it('http(s) 直链原样递给适配器', async () => {
    expect(await loadReferenceImage('https://example.com/a.png')).toBe('https://example.com/a.png')
  })

  it('data URI 原样递过去', async () => {
    expect(await loadReferenceImage('data:image/png;base64,AAAA')).toBe(
      'data:image/png;base64,AAAA'
    )
  })
})

describe('多张', () => {
  it('保持顺序 —— 多数厂商把第一张当主图', async () => {
    const first = await writeTempImage('a.png', Buffer.from('a'))
    const second = await writeTempImage('b.png', Buffer.from('b'))

    const loaded = await loadReferenceImages([first, 'https://example.com/c.png', second])

    expect(loaded).toEqual([
      `data:image/png;base64,${Buffer.from('a').toString('base64')}`,
      'https://example.com/c.png',
      `data:image/png;base64,${Buffer.from('b').toString('base64')}`
    ])
  })
})
