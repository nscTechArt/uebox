// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getSharp } from '../utils/sharpLoader'
import { prepareReferenceUpload } from './referenceImageUpload'

describe('reference image upload compression', () => {
  it('preserves small images byte for byte', async () => {
    const blob = new Blob(['unchanged'], { type: 'image/png' })
    expect(await prepareReferenceUpload(blob, new AbortController().signal)).toBe(blob)
  })

  it('compresses a real oversized PNG within the limit, keeping alpha and aspect ratio', async () => {
    const sharp = await getSharp()
    const original = await sharp({
      create: {
        width: 2400,
        height: 1200,
        channels: 4,
        background: { r: 80, g: 140, b: 200, alpha: 0.5 }
      }
    })
      .png({ compressionLevel: 0 })
      .toBuffer()
    expect(original.byteLength).toBeGreaterThan(10_000_000)
    const source = new Blob([new Uint8Array(original)], { type: 'image/png' })
    const result = await prepareReferenceUpload(source, new AbortController().signal)
    expect(result.type).toBe('image/webp')
    expect(result.size).toBeLessThanOrEqual(9_500_000)
    const metadata = await sharp(Buffer.from(await result.arrayBuffer())).metadata()
    expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([2400, 1200, true])
    expect(Buffer.from(await source.arrayBuffer()).equals(original)).toBe(true)
  })

  it('reports unreadable oversized images without returning them for upload', async () => {
    const blob = new Blob([new Uint8Array(10_000_001)], { type: 'image/png' })
    await expect(prepareReferenceUpload(blob, new AbortController().signal)).rejects.toThrow(
      '自动压缩未完成'
    )
  })

  it('honors cancellation before processing', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(prepareReferenceUpload(new Blob(['image']), controller.signal)).rejects.toThrow()
  })
})
