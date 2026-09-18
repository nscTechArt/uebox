/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { assertMatchesReported, PngError, readPngHeader } from './png.js'
import { fakePng } from './testServer.js'

describe('readPngHeader', () => {
  it('读出宽高和字节数', () => {
    expect(readPngHeader(fakePng(1920, 1080))).toEqual({ width: 1920, height: 1080, bytes: 88 })
  })

  /** 「文件在那儿」和「文件是张图」是两回事。0 字节是最常见的失败形态 */
  it('空文件被挡下', () => {
    expect(() => readPngHeader(Buffer.alloc(0))).toThrow(PngError)
    expect(() => readPngHeader(Buffer.alloc(0))).toThrow(/空的/)
  })

  it('截断的文件被挡下', () => {
    expect(() => readPngHeader(fakePng(100, 100).subarray(0, 12))).toThrow(/不完整/)
  })

  it('不是 PNG 的文件被挡下', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)])
    expect(() => readPngHeader(jpeg)).toThrow(/不是 PNG/)
  })

  it('第一个块不是 IHDR 时被挡下', () => {
    const broken = fakePng(10, 10)
    broken.write('IDAT', 12, 'ascii')
    expect(() => readPngHeader(broken)).toThrow(/IHDR/)
  })

  it('尺寸为零时被挡下', () => {
    expect(() => readPngHeader(fakePng(0, 100))).toThrow(/尺寸不合理/)
  })
})

describe('assertMatchesReported', () => {
  const info = { width: 1920, height: 1080, bytes: 100 }

  it('对得上就放行', () => {
    expect(() => assertMatchesReported(info, { width: 1920, height: 1080 })).not.toThrow()
  })

  /**
   * 对不上多半是读到了上一次遗留的文件。这种时候「成功」二字最危险 ——
   * 用户会拿一张旧图去判断他刚改的东西。
   */
  it('对不上时报错，并把两个尺寸都说出来', () => {
    expect(() => assertMatchesReported(info, { width: 1280, height: 720 })).toThrow(
      /1920×1080.*1280×720/
    )
  })

  /** 旧插件不报尺寸。说不准的时候不说，也不因此判失败 */
  it('引擎没报尺寸时不比对', () => {
    expect(() => assertMatchesReported(info, { width: null, height: null })).not.toThrow()
  })
})
