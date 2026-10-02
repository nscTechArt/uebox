/**
 * 截图测光：把一张视口截图换成一组数字，外加一张明暗分区图。
 *
 * ## 为什么要有数字
 *
 * 模型看一张图判断「亮度对不对、对比够不够、远景有没有空气感」很不可靠 ——
 * 人眼也会被曝光骗，模型更甚，而它评自己做的场景时天然倾向于「已经很好了」。
 * 「有 7% 的像素爆白」「上三分之一比下三分之一还暗」是能核对的事实，
 * 「氛围感很强」不是。这里只给事实，不打分：好不好看由参考图和人来定。
 *
 * ## 为什么还要一张明暗分区图
 *
 * 美术判断明暗结构的老办法是去色、眯眼。灰度图去掉了颜色的干扰，三阶图
 * （暗 / 中 / 亮按固定阈值归档）把「主体和背景分不分得开、大块明暗有没有组织」
 * 直接画出来 —— 模型看这种抽象图，比看原图判断得准。两张拼成一张，只多占
 * 一张图的上下文。
 *
 * ## 口径
 *
 * - 算的是**磁盘上那张 PNG**，也就是 tonemap 之后、显示用的 sRGB 值，不是场景的
 *   物理亮度。这正是玩家看到的东西，但前提是曝光锁住了（见 `screenshot.ts` 的
 *   `describeExposure`）；自动曝光下这些数只代表这一帧。
 * - 亮度用 Rec.709 系数在 sRGB 编码值上加权，0–100；色度 = (max − min) / 255，0–100。
 * - 上 / 中 / 下三分之一只是**几何上的三条横带**，不是识别出来的天空和地面。
 *   户外平视镜头里上部通常是远景和天空，但俯拍时不是，由模型对照画面自己判断。
 * - 统计前先缩到 {@link MEASURE_SAMPLE_WIDTH} 宽：几万个样本对这些平均值和分位数
 *   已经足够，缩小还顺带抹掉了 TSR / Lumen 的高频噪点，免得被当成「死黑」「爆白」。
 */

import { getSharp } from '../../../../utils/sharpLoader'
import { CONTACT_SHEET_MAX_WIDTH, compressForContext, type ContextImage } from '../../contextImage'

/** 统计用的采样宽度 */
export const MEASURE_SAMPLE_WIDTH = 320

/** 亮度 ≥ 这个值（0–255）算爆白：细节已经没了 */
export const CLIP_HIGH = 250
/** 亮度 ≤ 这个值（0–255）算死黑 */
export const CLIP_LOW = 5

/** 三阶明暗图的阈值（0–255）：低于第一个是暗部，高于第二个是亮部 */
export const VALUE_STUDY_THRESHOLDS = [85, 170] as const
/** 三阶图里三档画成的灰度 */
const VALUE_STUDY_TONES = [40, 128, 220] as const

/** 明暗分区图每一半的宽度，两半拼起来正好是拼图档的宽度 */
const VALUE_STUDY_PANEL_WIDTH = Math.floor(CONTACT_SHEET_MAX_WIDTH / 2)

/** 主色板报几种颜色 */
const PALETTE_SIZE = 5

/** 色度低于这个百分比就叫「灰」，不再给色相名 —— 低饱和时色相是噪声 */
const NEUTRAL_CHROMA = 8

export interface BandStats {
  /** 平均亮度 0–100 */
  luma: number
  /** 平均色度 0–100 */
  chroma: number
  /** 冷暖：平均 (R − B)，−100–100，正数偏暖 */
  warmth: number
  /** 这一带平均颜色的色相名，色度太低时是「灰」 */
  hue: string
}

export interface PaletteEntry {
  hex: string
  /** 占画面的百分比 */
  percent: number
}

export interface ScreenshotMeasurement {
  /** 平均亮度 0–100 */
  luma_mean: number
  luma_p5: number
  luma_p50: number
  luma_p95: number
  /** 爆白像素占比（%） */
  clipped_high_percent: number
  /** 死黑像素占比（%） */
  crushed_low_percent: number
  /** 平均色度 0–100 */
  chroma_mean: number
  /** 上 / 中 / 下三条横带 */
  bands: { top: BandStats; middle: BandStats; bottom: BandStats }
  /** 占比最大的几种颜色，按占比从高到低 */
  palette: PaletteEntry[]
  /** 实际参与统计的像素数 */
  samples: number
}

const round1 = (value: number): number => Math.round(value * 10) / 10

const lumaOf = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

function toHex(r: number, g: number, b: number): string {
  const part = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** 平均颜色的色相名。用平均色而不是逐像素求色相均值：后者在红色附近会绕圈 */
export function hueName(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = max - min
  if ((chroma / 255) * 100 < NEUTRAL_CHROMA) return '灰'

  let hue: number
  if (max === r) hue = ((g - b) / chroma) % 6
  else if (max === g) hue = (b - r) / chroma + 2
  else hue = (r - g) / chroma + 4
  hue = (hue * 60 + 360) % 360

  if (hue < 15 || hue >= 345) return '红'
  if (hue < 40) return '橙'
  if (hue < 65) return '黄'
  if (hue < 90) return '黄绿'
  if (hue < 150) return '绿'
  if (hue < 195) return '青'
  if (hue < 255) return '蓝'
  if (hue < 290) return '紫'
  return '品红'
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
  )
  return sorted[index]
}

/**
 * 在一块原始像素上算统计。纯函数，不碰 sharp，测试直接喂合成像素。
 *
 * @param pixels 逐行排列的 8 位像素，`channels` ≥ 3，只读前三个通道
 */
export function measurePixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number
): ScreenshotMeasurement {
  const count = width * height
  const lumas = new Float64Array(count)
  let lumaSum = 0
  let chromaSum = 0
  let clippedHigh = 0
  let crushedLow = 0

  // 三条横带各自累加 r / g / b / 亮度 / 色度 / 像素数
  const bandSums = [0, 1, 2].map(() => ({ r: 0, g: 0, b: 0, luma: 0, chroma: 0, n: 0 }))
  const bandOf = (y: number): number => Math.min(2, Math.floor((y * 3) / height))

  // 主色板：每通道量化成 8 档（共 512 格），每格记像素数和颜色总和，
  // 报的是格子里的真实平均色，而不是格子中心那个人造颜色
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>()

  for (let y = 0; y < height; y++) {
    const band = bandSums[bandOf(y)]
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const r = pixels[i]
      const g = pixels[i + 1]
      const b = pixels[i + 2]
      const luma = lumaOf(r, g, b)
      const chroma = Math.max(r, g, b) - Math.min(r, g, b)

      lumas[y * width + x] = luma
      lumaSum += luma
      chromaSum += chroma
      if (luma >= CLIP_HIGH) clippedHigh++
      if (luma <= CLIP_LOW) crushedLow++

      band.r += r
      band.g += g
      band.b += b
      band.luma += luma
      band.chroma += chroma
      band.n++

      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)
      const bin = bins.get(key)
      if (bin) {
        bin.n++
        bin.r += r
        bin.g += g
        bin.b += b
      } else {
        bins.set(key, { n: 1, r, g, b })
      }
    }
  }

  lumas.sort()
  const toPercent = (v: number): number => round1((v / 255) * 100)
  const share = (n: number): number => (count === 0 ? 0 : round1((n / count) * 100))

  const bandStats = bandSums.map((s): BandStats => {
    if (s.n === 0) return { luma: 0, chroma: 0, warmth: 0, hue: '灰' }
    const r = s.r / s.n
    const g = s.g / s.n
    const b = s.b / s.n
    return {
      luma: toPercent(s.luma / s.n),
      chroma: toPercent(s.chroma / s.n),
      warmth: toPercent(r - b),
      hue: hueName(r, g, b)
    }
  })

  const palette = [...bins.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, PALETTE_SIZE)
    .map((bin) => ({
      hex: toHex(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n),
      percent: share(bin.n)
    }))

  return {
    luma_mean: count === 0 ? 0 : toPercent(lumaSum / count),
    luma_p5: toPercent(percentile(lumas, 5)),
    luma_p50: toPercent(percentile(lumas, 50)),
    luma_p95: toPercent(percentile(lumas, 95)),
    clipped_high_percent: share(clippedHigh),
    crushed_low_percent: share(crushedLow),
    chroma_mean: count === 0 ? 0 : toPercent(chromaSum / count),
    bands: { top: bandStats[0], middle: bandStats[1], bottom: bandStats[2] },
    palette,
    samples: count
  }
}

/** 灰度值按固定阈值归成三档。导出给测试 */
export function toValueStudyTone(gray: number): number {
  if (gray < VALUE_STUDY_THRESHOLDS[0]) return VALUE_STUDY_TONES[0]
  if (gray < VALUE_STUDY_THRESHOLDS[1]) return VALUE_STUDY_TONES[1]
  return VALUE_STUDY_TONES[2]
}

/**
 * 左灰度、右三阶明暗，拼成一张。压不进上下文时返回 null，统计照给。
 */
async function buildValueStudy(bytes: Buffer): Promise<ContextImage | null> {
  const sharp = await getSharp()
  const { data, info } = await sharp(bytes)
    .resize({ width: VALUE_STUDY_PANEL_WIDTH, withoutEnlargement: true })
    .flatten({ background: '#808080' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height } = info
  const gray = Buffer.alloc(width * height)
  const tones = Buffer.alloc(width * height)
  for (let i = 0; i < width * height; i++) {
    const value = data[i * info.channels]
    gray[i] = value
    tones[i] = toValueStudyTone(value)
  }

  const panel = (pixels: Buffer): Promise<Buffer> =>
    sharp(pixels, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer()

  const sheet = await sharp({
    create: { width: width * 2, height, channels: 3, background: '#000000' }
  })
    .composite([
      { input: await panel(gray), left: 0, top: 0 },
      { input: await panel(tones), left: width, top: 0 }
    ])
    .png()
    .toBuffer()

  return compressForContext(sheet, { maxWidth: CONTACT_SHEET_MAX_WIDTH })
}

/**
 * 读一张截图做测光。图解不开时抛错，由调用方降级成「这次没测成」。
 */
export async function measureScreenshot(
  bytes: Buffer
): Promise<{ measurement: ScreenshotMeasurement; valueStudy: ContextImage | null }> {
  const sharp = await getSharp()
  const { data, info } = await sharp(bytes)
    .resize({ width: MEASURE_SAMPLE_WIDTH, withoutEnlargement: true })
    .flatten({ background: '#808080' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const measurement = measurePixels(data, info.width, info.height, info.channels)
  const valueStudy = await buildValueStudy(bytes)
  return { measurement, valueStudy }
}

function describeBand(name: string, band: BandStats): string {
  const temperature = band.warmth > 3 ? '偏暖' : band.warmth < -3 ? '偏冷' : '中性'
  return `${name}：亮度 ${band.luma}，色度 ${band.chroma}，${temperature}（R−B ${band.warmth}），主色相 ${band.hue}`
}

/**
 * 测光结果写成给模型看的几行字。
 *
 * 只在数字本身已经说明问题时才加 ⚠️（爆白、死黑、亮暗跨度太窄），
 * 这几条与风格无关，任何画面都不该有。上下横带的比较只陈述事实并给出
 * 户外场景的常见规律，不下「对 / 错」的结论 —— 室内、俯拍、刻意的风格
 * 都可能反着来，那要对照参考图和画面自己判断。
 */
export function formatMeasurement(
  m: ScreenshotMeasurement,
  context: { exposure?: string; hasValueStudy: boolean }
): string {
  const lines: string[] = [
    '',
    '【测光】（数值 0–100，按磁盘上那张图算，tonemap 之后、玩家看到的值）'
  ]

  if (context.exposure !== 'manual') {
    lines.push(
      '⚠️ 这一帧不是手动曝光，下面的亮度数字只代表这一帧收敛到的样子，不能当场景的基准。先锁曝光再拿它调灯。'
    )
  }

  const range = round1(m.luma_p95 - m.luma_p5)
  lines.push(
    `整体：平均亮度 ${m.luma_mean}，中位 ${m.luma_p50}，5%–95% 分位 ${m.luma_p5}–${m.luma_p95}（跨度 ${range}），平均色度 ${m.chroma_mean}`,
    `爆白（≥98）${m.clipped_high_percent}%，死黑（≤2）${m.crushed_low_percent}%`
  )

  if (m.clipped_high_percent > 2) {
    lines.push(`⚠️ ${m.clipped_high_percent}% 的像素已经爆白，那部分细节没了（常见于天空、高光面）`)
  }
  if (m.crushed_low_percent > 5) {
    lines.push(`⚠️ ${m.crushed_low_percent}% 的像素是死黑，暗部细节没了`)
  }
  if (range < 40) {
    lines.push(`⚠️ 亮暗跨度只有 ${range}，画面发灰、没有明暗层次`)
  }

  lines.push(
    describeBand('上三分之一', m.bands.top),
    describeBand('中三分之一', m.bands.middle),
    describeBand('下三分之一', m.bands.bottom),
    '（三条横带只是几何划分，不是识别出的天空和地面。户外平视镜头里，远景通常在上部：' +
      '比近景更亮、色度更低、更冷，纵深才拉得开；室内、俯拍或刻意的风格可以反着来，对照画面判断）',
    `主色板：${m.palette.map((p) => `${p.hex} ${p.percent}%`).join('，')}`
  )

  if (context.hasValueStudy) {
    lines.push(
      '附图是明暗分区：左边灰度，右边三阶（暗 < 33、中、亮 ≥ 67 各归一档）。' +
        '看三阶那一半：主体和背景是不是落在不同的档、大块明暗有没有组织；一片中灰说明明暗没拉开。'
    )
  }

  return lines.join('\n')
}
