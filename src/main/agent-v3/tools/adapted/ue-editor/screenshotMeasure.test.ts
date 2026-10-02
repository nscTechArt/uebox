/**
 * @vitest-environment node
 *
 * 截图测光的数字必须是对的：模型会拿它们去调灯，错一个分位数就是白调一轮。
 * 像素都是合成的，每个断言的期望值都能手算出来。
 */

import { describe, expect, it } from 'vitest'

import { getSharp } from '../../../../utils/sharpLoader'
import {
  formatMeasurement,
  hueName,
  measurePixels,
  measureScreenshot,
  toValueStudyTone,
  type ScreenshotMeasurement
} from './screenshotMeasure'

type RGB = [number, number, number]

/** 按行填色：rowColor(y) 决定第 y 行的颜色 */
function image(width: number, height: number, rowColor: (y: number) => RGB): Uint8Array {
  const pixels = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    const [r, g, b] = rowColor(y)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
    }
  }
  return pixels
}

describe('measurePixels', () => {
  it('一半纯白一半纯黑：爆白、死黑各占一半，分位数落在两端', () => {
    const m = measurePixels(
      image(10, 10, (y) => (y < 5 ? [255, 255, 255] : [0, 0, 0])),
      10,
      10,
      3
    )

    expect(m.clipped_high_percent).toBe(50)
    expect(m.crushed_low_percent).toBe(50)
    expect(m.luma_p5).toBe(0)
    expect(m.luma_p95).toBe(100)
    expect(m.luma_mean).toBe(50)
    expect(m.chroma_mean).toBe(0)
    expect(m.samples).toBe(100)
  })

  it('三条横带各算各的：上蓝、中灰、下暖', () => {
    // 9 行，每带正好 3 行
    const m = measurePixels(
      image(4, 9, (y) => (y < 3 ? [100, 150, 230] : y < 6 ? [128, 128, 128] : [200, 120, 40])),
      4,
      9,
      3
    )

    expect(m.bands.top.hue).toBe('蓝')
    expect(m.bands.top.warmth).toBeLessThan(0)
    expect(m.bands.middle.hue).toBe('灰')
    expect(m.bands.middle.chroma).toBe(0)
    expect(m.bands.middle.warmth).toBe(0)
    expect(m.bands.bottom.hue).toBe('橙')
    expect(m.bands.bottom.warmth).toBeGreaterThan(0)
    // 灰带的亮度能手算：128 / 255
    expect(m.bands.middle.luma).toBe(50.2)
  })

  it('主色板按占比排序，报的是格子里的真实平均色', () => {
    // 6 行绿、3 行红
    const m = measurePixels(
      image(2, 9, (y) => (y < 6 ? [30, 200, 60] : [220, 20, 20])),
      2,
      9,
      3
    )

    expect(m.palette).toEqual([
      { hex: '#1ec83c', percent: 66.7 },
      { hex: '#dc1414', percent: 33.3 }
    ])
  })

  it('带 alpha 的四通道像素只读前三个通道', () => {
    const pixels = new Uint8Array([255, 255, 255, 0, 0, 0, 0, 255])
    const m = measurePixels(pixels, 2, 1, 4)

    expect(m.clipped_high_percent).toBe(50)
    expect(m.crushed_low_percent).toBe(50)
  })
})

describe('hueName', () => {
  it.each<[RGB, string]>([
    [[220, 30, 30], '红'],
    [[230, 140, 30], '橙'],
    [[230, 220, 40], '黄'],
    [[40, 200, 60], '绿'],
    [[40, 200, 200], '青'],
    [[40, 80, 220], '蓝'],
    [[140, 40, 220], '紫'],
    [[120, 125, 122], '灰']
  ])('%j → %s', (rgb, name) => {
    expect(hueName(...rgb)).toBe(name)
  })
})

describe('toValueStudyTone', () => {
  it('按固定阈值归三档，边界值归上一档', () => {
    expect(toValueStudyTone(0)).toBe(40)
    expect(toValueStudyTone(84)).toBe(40)
    expect(toValueStudyTone(85)).toBe(128)
    expect(toValueStudyTone(169)).toBe(128)
    expect(toValueStudyTone(170)).toBe(220)
    expect(toValueStudyTone(255)).toBe(220)
  })
})

describe('formatMeasurement', () => {
  const base: ScreenshotMeasurement = {
    luma_mean: 50,
    luma_p5: 10,
    luma_p50: 50,
    luma_p95: 90,
    clipped_high_percent: 0.5,
    crushed_low_percent: 0.2,
    chroma_mean: 20,
    bands: {
      top: { luma: 70, chroma: 10, warmth: -8, hue: '蓝' },
      middle: { luma: 50, chroma: 20, warmth: 2, hue: '绿' },
      bottom: { luma: 35, chroma: 25, warmth: 6, hue: '黄绿' }
    },
    palette: [{ hex: '#88aacc', percent: 30 }],
    samples: 57600
  }

  it('健康的画面不报 ⚠️，但横带、色板都列出来', () => {
    const text = formatMeasurement(base, { exposure: 'manual', hasValueStudy: true })

    expect(text).not.toContain('⚠️')
    expect(text).toContain('上三分之一：亮度 70')
    expect(text).toContain('偏冷')
    expect(text).toContain('#88aacc 30%')
    expect(text).toContain('三阶')
  })

  it('爆白、死黑、发灰各自报出来', () => {
    const text = formatMeasurement(
      { ...base, clipped_high_percent: 7, crushed_low_percent: 9, luma_p5: 40, luma_p95: 65 },
      { exposure: 'manual', hasValueStudy: false }
    )

    expect(text).toContain('7% 的像素已经爆白')
    expect(text).toContain('9% 的像素是死黑')
    expect(text).toContain('跨度只有 25')
    expect(text).not.toContain('三阶')
  })

  it('没锁手动曝光时先说这些亮度没有基准', () => {
    expect(formatMeasurement(base, { exposure: 'auto', hasValueStudy: true })).toContain(
      '不是手动曝光'
    )
    // 老插件不报曝光：同样当成没有基准，不替它说锁了
    expect(formatMeasurement(base, { hasValueStudy: true })).toContain('不是手动曝光')
  })
})

describe('measureScreenshot（真 sharp）', () => {
  it('从一张 PNG 算出数字，并拼出两联明暗分区图', async () => {
    const sharp = await getSharp()
    const width = 640
    const height = 360
    const png = await sharp(
      Buffer.from(image(width, height, (y) => (y < height / 2 ? [180, 210, 240] : [60, 110, 40]))),
      { raw: { width, height, channels: 3 } }
    )
      .png()
      .toBuffer()

    const { measurement, valueStudy } = await measureScreenshot(png)

    // 统计前缩到 320 宽
    expect(measurement.samples).toBe(320 * 180)
    expect(measurement.bands.top.hue).toBe('蓝')
    expect(measurement.bands.bottom.hue).toBe('绿')
    expect(measurement.bands.top.luma).toBeGreaterThan(measurement.bands.bottom.luma)

    expect(valueStudy).not.toBeNull()
    expect(valueStudy?.mimeType).toBe('image/jpeg')
    // 左右两联，每联缩到 576 宽，拼起来正好是拼图档的 1152
    expect(valueStudy?.width).toBe(1152)
    expect(valueStudy?.height).toBe(324)
  })

  it('解不开的字节直接抛错，由调用方降级', async () => {
    await expect(measureScreenshot(Buffer.from('not an image'))).rejects.toThrow()
  })
})
