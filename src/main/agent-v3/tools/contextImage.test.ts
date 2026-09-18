// @vitest-environment node
/**
 * 进上下文的图片压缩。**用真的 sharp 跑**，不打桩：这一层的全部价值就是
 * 「压出来的东西到底多大、尺寸对不对」，桩掉就什么都没测。
 */

import { describe, expect, it } from 'vitest'

import {
  CONTEXT_IMAGE_MAX_BYTES,
  CONTEXT_IMAGE_MAX_HEIGHT,
  CONTEXT_IMAGE_MAX_WIDTH,
  compressForContext,
  describeResize
} from './contextImage'

/** 确定性噪声图 —— 同样的种子每次都得到同样的字节，测试不会随机飘 */
async function noisePng(width: number, height: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const raw = Buffer.alloc(width * height * 3)
  let seed = 12345
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    raw[i] = (seed >>> 16) & 255
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}

describe('压进上下文', () => {
  it('大图缩到限宽，转成 JPEG，落在预算之内', async () => {
    const result = await compressForContext(await noisePng(2048, 2048))

    expect(result).not.toBeNull()
    expect(result!.mimeType).toBe('image/jpeg')
    expect(result!.width).toBe(CONTEXT_IMAGE_MAX_WIDTH)
    expect(Buffer.from(result!.data, 'base64').byteLength).toBeLessThanOrEqual(
      CONTEXT_IMAGE_MAX_BYTES
    )
  }, 30_000)

  // 原始尺寸是给模型的判据（「细节看不清是因为缩过」），不能丢
  it('带回原图的真实尺寸', async () => {
    const result = await compressForContext(await noisePng(1600, 900))

    expect(result).toMatchObject({ sourceWidth: 1600, sourceHeight: 900 })
  }, 30_000)

  // 放大没有任何信息增益，只会白烧 token
  it('小图不放大', async () => {
    const result = await compressForContext(await noisePng(320, 240))

    expect(result).toMatchObject({ width: 320, height: 240, sourceWidth: 320, sourceHeight: 240 })
  }, 30_000)

  /**
   * 解不开就说解不开。悄悄塞一段解不出图的字节过去，换来的是厂商一句
   * 「invalid image」—— 那时候已经查不出是哪一步坏的了。
   */
  it('解不开的字节返回 null', async () => {
    expect(await compressForContext(Buffer.from('这不是一张图'))).toBeNull()
  })

  /**
   * JPEG 没有 alpha 通道，sharp 丢 alpha 时要把像素合成到某个底色上。
   *
   * 垫黑的话透明底**深色**字的 logo 压完是一块纯黑；垫白的话透明底**浅色**字的
   * 压完是一块纯白 —— 而浅色 logo 在美术资产里更常见。两种都要活下来，
   * 所以垫中性灰。模型对着一块纯色会照实报告「这个文件是空的」，
   * 而 describeResize 只会说它缩过，不会提颜色。
   */
  it.each([
    ['深色前景', 20],
    ['浅色前景', 245]
  ])(
    '透明底的 %s 压完仍然看得见',
    async (_label, level) => {
      const { default: sharp } = await import('sharp')
      const size = 64
      const raw = Buffer.alloc(size * size * 4, 0)
      for (let y = 20; y < 44; y++) {
        for (let x = 20; x < 44; x++) {
          const i = (y * size + x) * 4
          raw[i] = level
          raw[i + 1] = level
          raw[i + 2] = level
          raw[i + 3] = 255
        }
      }
      const png = await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
        .png()
        .toBuffer()

      const result = await compressForContext(png)
      const out = await sharp(Buffer.from(result!.data, 'base64')).raw().toBuffer({
        resolveWithObject: true
      })
      const at = (x: number, y: number): number =>
        out.data[(y * out.info.width + x) * out.info.channels]

      // 前景和透明处垫的底色之间要有肉眼可辨的差距
      expect(Math.abs(at(32, 32) - at(2, 2))).toBeGreaterThan(60)
    },
    30_000
  )

  /**
   * 高度也要限，挡的是 512×16384 那种贴图集：宽度本来就小于 768，不限高就
   * 一个像素都不缩，只是重新编一次码，压出来仍是好几 MB。
   */
  it('又高又窄的图会被缩，不是只看宽度', async () => {
    const result = await compressForContext(await noisePng(512, 4096))

    expect(result!.height).toBeLessThanOrEqual(CONTEXT_IMAGE_MAX_HEIGHT)
    expect(result!.height).toBeLessThan(4096)
  }, 30_000)

  /**
   * 但高度**不能**和宽度同一个数：`fit: 'inside'` 按两边比例的较小者缩，
   * 高度也给 768 的话每一张竖图都跟着变窄（1080×1920 → 432×768），
   * 比文件头论证过的 768 宽窄了 43%。
   */
  it('竖构图保住 768 的宽度', async () => {
    const result = await compressForContext(await noisePng(1080, 1920))

    expect(result!.width).toBe(CONTEXT_IMAGE_MAX_WIDTH)
  }, 30_000)
})

describe('告诉模型缩成了什么样', () => {
  const image = (
    source: [number, number],
    out: [number, number]
  ): Parameters<typeof describeResize>[0] => ({
    data: '',
    mimeType: 'image/jpeg',
    sourceWidth: source[0],
    sourceHeight: source[1],
    width: out[0],
    height: out[1]
  })

  // 给确切数字，不给「已压缩」这种空话 —— 模型据此判断细节能不能信
  it('缩过就给确切的前后尺寸', () => {
    expect(describeResize(image([2048, 2048], [768, 768]))).toContain('2048×2048')
    expect(describeResize(image([2048, 2048], [768, 768]))).toContain('768×768')
  })

  // 每张图都挂一句废话会稀释真正要紧的那几句
  it('没缩就什么都不说', () => {
    expect(describeResize(image([640, 480], [640, 480]))).toBeUndefined()
  })
})
