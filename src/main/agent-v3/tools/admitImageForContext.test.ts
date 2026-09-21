// @vitest-environment node
/**
 * 钉住「进上下文的图只有一道门」这件事。**用真的 sharp 跑**，不打桩 ——
 * 关口的价值就是「进来的东西到底多大」，桩掉就什么都没测。
 *
 * 守的是那类最难查的事故：一张没压住的大图进了 transcript，而 pi 每轮重发
 * 整条 transcript —— 于是**之后每一轮**都带着它，直到厂商网关回 413。
 * 出问题的那一轮和闯祸的那一轮隔着十几轮，现场早没了。
 *
 * 这里测的是**关口的行为契约**：什么放行、什么压、压不动怎么办 ——
 * 以及任何一种结局都不能是静默丢弃。压缩本身怎么压是 contextImage.test.ts 的事。
 */

import { describe, expect, it } from 'vitest'

import {
  CONTACT_SHEET_MAX_WIDTH,
  CONTEXT_IMAGE_MAX_BYTES,
  CONTEXT_IMAGE_MAX_WIDTH,
  admitImageForContext
} from './contextImage'

/** 确定性噪声图 —— 噪声压不动，正好用来造「超预算」的输入 */
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

type AdmittedBlock =
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'text'; text: string }

function blocksOf(result: Awaited<ReturnType<typeof admitImageForContext>>): AdmittedBlock[] {
  return Array.isArray(result) ? result : [result]
}

describe('进上下文的唯一关口', () => {
  it('预算内的原样通过，一个字节都不动', async () => {
    const small = await noisePng(64, 64)
    expect(small.byteLength).toBeLessThanOrEqual(CONTEXT_IMAGE_MAX_BYTES)

    const result = await admitImageForContext({ data: small, mimeType: 'image/png' })

    // 重编一次省不下多少体积，画质却实打实掉一档
    expect(result).toEqual({
      type: 'image',
      data: small.toString('base64'),
      mimeType: 'image/png'
    })
  }, 30_000)

  it('超预算的自动压掉 —— 这是工具忘了压缩时的兜底', async () => {
    const huge = await noisePng(2048, 2048)
    expect(huge.byteLength).toBeGreaterThan(CONTEXT_IMAGE_MAX_BYTES)

    const blocks = blocksOf(await admitImageForContext({ data: huge, mimeType: 'image/png' }))
    const image = blocks.find((b) => b.type === 'image')

    expect(image).toBeDefined()
    const bytes = Buffer.from((image as { data: string }).data, 'base64').byteLength
    expect(bytes).toBeLessThanOrEqual(CONTEXT_IMAGE_MAX_BYTES)
  }, 30_000)

  it('缩过就要说清缩成了什么样', async () => {
    const blocks = blocksOf(
      await admitImageForContext({ data: await noisePng(2048, 2048), mimeType: 'image/png' })
    )
    const notice = blocks.find((b) => b.type === 'text')

    // 模型不知道自己看的是缩过的版本时，会把「看不清」当成「图上没有」
    expect(notice).toBeDefined()
    expect((notice as { text: string }).text).toContain('2048×2048')
  }, 30_000)

  it('解不开的字节换成一段说明，而不是什么都不放', async () => {
    const blocks = blocksOf(
      await admitImageForContext({
        data: Buffer.alloc(CONTEXT_IMAGE_MAX_BYTES + 1, 7),
        mimeType: 'image/png'
      })
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    // 静默丢弃是最坏的结局：模型会把「看不到图」当成「这个文件是空的」
    expect((blocks[0] as { text: string }).text).toContain('没能进上下文')
  }, 30_000)

  it('拼图用更宽的那档，单张图不受影响', async () => {
    const sheet = await noisePng(2400, 1350)

    const wide = blocksOf(
      await admitImageForContext({
        data: sheet,
        mimeType: 'image/png',
        maxWidth: CONTACT_SHEET_MAX_WIDTH
      })
    ).find((b) => b.type === 'image')
    const narrow = blocksOf(
      await admitImageForContext({ data: sheet, mimeType: 'image/png' })
    ).find((b) => b.type === 'image')

    // 同一张图走拼图档要比单张档大 —— 格子里的东西得看得清
    const wideBytes = Buffer.from((wide as { data: string }).data, 'base64').byteLength
    const narrowBytes = Buffer.from((narrow as { data: string }).data, 'base64').byteLength
    expect(wideBytes).toBeGreaterThan(narrowBytes)
    // 但字节预算不跟着放宽：像素多了就让质量阶梯自己往下掉一档
    expect(wideBytes).toBeLessThanOrEqual(CONTEXT_IMAGE_MAX_BYTES)
    expect(CONTACT_SHEET_MAX_WIDTH).toBeGreaterThan(CONTEXT_IMAGE_MAX_WIDTH)
  }, 60_000)
})
