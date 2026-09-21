import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

vi.mock('electron', async () => {
  const { resolve } = await import('node:path')
  return { app: { getPath: () => resolve('/Users/test') } }
})

// 压缩要拉 sharp 并真的解码图片，这里只关心「有没有压、压不动怎么办」
const compressForContext = vi.hoisted(() => vi.fn())
vi.mock('../contextImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contextImage')>()),
  compressForContext
}))

import { __testing } from './localFiles'

const { sizeHint, withViewedImageDetails, readImageProcessor, rejectOpaqueBinary } = __testing

/**
 * 敏感位置的拦截规则搬去了 `pathBoundary.ts`（碰盘的工具已经不止这里两个），
 * 用例跟着搬到 `pathBoundary.test.ts`。
 */
describe('文件大小显示', () => {
  it('按量级换单位', () => {
    expect(sizeHint(512)).toBe(' (512 B)')
    expect(sizeHint(2048)).toBe(' (2 KB)')
    expect(sizeHint(5 * 1024 * 1024)).toBe(' (5.0 MB)')
  })

  // 目录没有 size，不该显示 "(undefined)"
  it('没有大小时什么都不显示', () => {
    expect(sizeHint(undefined)).toBe('')
  })
})

/**
 * 读到图片时要把路径交给界面。
 *
 * 不交的话聊天里只剩一行「Read image file [image/png]」—— 模型看见了图，
 * 人没看见，也就没法判断它到底在看什么。
 */
describe('读到图片时挂上路径', () => {
  const imageResult = (): Parameters<typeof withViewedImageDetails>[0] =>
    ({
      content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ]
    }) as unknown as Parameters<typeof withViewedImageDetails>[0]

  it('把绝对路径挂到 details 上', () => {
    const imagePath = resolve('/素材/参考图.png')
    const out = withViewedImageDetails(imageResult(), imagePath)

    expect(out.details).toEqual({
      message: '看了图片 参考图.png',
      viewed_image_path: imagePath
    })
  })

  it('相对路径按用户目录补全 —— 界面拿到相对路径读不到文件', () => {
    const out = withViewedImageDetails(imageResult(), 'Pictures/a.png')

    expect((out.details as { viewed_image_path: string }).viewed_image_path).toBe(
      resolve('/Users/test', 'Pictures/a.png')
    )
  })

  it('读文本文件时什么都不加', () => {
    const text = { content: [{ type: 'text', text: '[EngineSettings]' }] } as unknown as Parameters<
      typeof withViewedImageDetails
    >[0]

    expect(withViewedImageDetails(text, 'H:/UE/Config/DefaultEngine.ini')).toBe(text)
  })
})

/**
 * 图片必须压过再进上下文。
 *
 * 不压的那一版在真机上炸过：一张 2048×2048 的 UV 图（3.5MB PNG）base64 撑到
 * 4.7MB，厂商网关按 1MB 上限退回 413。而 pi 每次请求都重发整条 transcript，
 * 那张图会把后续每一轮都打死 —— 点「继续尝试」只是再 413 一次。
 */
describe('读到图片时先压缩', () => {
  const run = (bytes: Buffer): ReturnType<typeof readImageProcessor> =>
    readImageProcessor(bytes, 'image/png', { autoResizeImages: true })

  const compressed = (source: [number, number], out: [number, number]): unknown => ({
    data: 'Y29tcHJlc3NlZA==',
    mimeType: 'image/jpeg',
    sourceWidth: source[0],
    sourceHeight: source[1],
    width: out[0],
    height: out[1]
  })

  beforeEach(() => {
    compressForContext.mockReset()
    compressForContext.mockResolvedValue(compressed([2048, 2048], [768, 768]))
  })

  it('交给模型的是压过的那份，不是原始字节', async () => {
    const original = Buffer.from('原始 PNG 字节')
    const out = await run(original)

    expect(compressForContext).toHaveBeenCalledWith(original)
    expect(out).toMatchObject({ ok: true, data: 'Y29tcHJlc3NlZA==', mimeType: 'image/jpeg' })
  })

  // 一张 2048 的 UV 图缩到 768 之后细小的标注是认不出来的。
  // 不说清楚，模型会把「看不清」当成「图上没有」。
  it('把确切的前后尺寸告诉模型', async () => {
    const hints = ((await run(Buffer.from('x'))) as { hints: string[] }).hints.join('')

    expect(hints).toContain('2048×2048')
    expect(hints).toContain('768×768')
  })

  // 每张图都挂一句「已压缩」会稀释真正要紧的提示
  it('没缩就不啰嗦', async () => {
    compressForContext.mockResolvedValue(compressed([640, 480], [640, 480]))

    expect((await run(Buffer.from('x'))) as { hints: string[] }).toMatchObject({ hints: [] })
  })

  // 悄悄塞一张坏图比不塞更糟：模型不知道自己看的是什么
  it('读不出来时不发图，明说看不到', async () => {
    compressForContext.mockResolvedValue(null)

    const out = await run(Buffer.from('BMP 之类 sharp 不认的格式'))

    expect(out.ok).toBe(false)
    expect((out as { message: string }).message).toContain('看不到')
  })
})

/**
 * 守那次真机事故：模型 `read_local_file` 读 mp4，pi 把字节按 UTF-8 解成 50KB 乱码，
 * 模型以为读到了东西，转头拿浏览器工具开 `file:`，被拒后反复重试撞上限流。
 * 拦在读之前，并且**指明该用哪个工具** —— 只说「不支持」的话，模型会换个姿势再试。
 */
describe('二进制挡在读取之前', () => {
  it.each([
    ['D:/素材/clip.mp4', 'analyze_video'],
    ['D:/录音/voice.m4a', 'analyze_video'],
    ['D:/需求/案子.pdf', 'read_document'],
    ['D:/工程/Mesh.uasset', 'ue_content_describe']
  ])('%s 指向 %s', (path, tool) => {
    const message = rejectOpaqueBinary(path)
    expect(message).toContain(tool)
    // 不指路的话模型会重试同一个路径，这句是拦截生效的另一半
    expect(message).toContain('不要重试同一个路径')
  })

  it('读得出字的文件照常放行', () => {
    expect(rejectOpaqueBinary('D:/工程/Config/DefaultEngine.ini')).toBeNull()
    expect(rejectOpaqueBinary('D:/log/run.log')).toBeNull()
    expect(rejectOpaqueBinary('D:/参考/ref.png')).toBeNull()
  })
})
