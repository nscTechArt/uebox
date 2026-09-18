export const GPT_IMAGE_PROVIDER = 'sora'
export const GPT_IMAGE_MODEL = 'gpt-image-2'

export type ImageProvider = typeof GPT_IMAGE_PROVIDER
export type ImageResolution =
  | '1K'
  | '2K'
  | '4K'
  | '1024x1024'
  | '1536x1024'
  | '1024x1536'
  | '2048x2048'
  | '2048x1152'
  | '3840x2160'
  | '2160x3840'
  | 'auto'
  | (string & {})
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto'
export type ImageAspectRatio =
  | '1:1'
  | '1:4'
  | '1:8'
  | '2:3'
  | '3:2'
  | '3:4'
  | '4:1'
  | '4:3'
  | '4:5'
  | '5:4'
  | '8:1'
  | '9:16'
  | '16:9'
  | '21:9'

export interface ImageModelCapability {
  /** 稳定标识。下拉框选中值、localStorage、任务历史里存的就是它，见文件头 */
  key: string
  provider: ImageProvider
  /** 模型服务使用的模型 id，与本地历史记录的稳定标识分离 */
  model: string
  /**
   * 这个模型用过的旧标识。
   *
   * 历史任务里存的是当时那个字符串，靠它继续认得出来 —— 否则换一次模型 id，
   * 用户之前生成的图会在历史面板里显示成另一个模型画的（`getImageModelOption`
   * 认不出就回落到列表第一项，不报错，只是说了件假的事）。
   */
  aliases?: readonly string[]
  label: string
  ratios: readonly ImageAspectRatio[]
  resolutions: readonly ImageResolution[]
  qualities: readonly ImageQuality[]
  defaultRatio: ImageAspectRatio
  defaultResolution: ImageResolution
  defaultQuality: ImageQuality
  usesResolution: boolean
  usesQuality: boolean
}

export const GPT_IMAGE_RATIOS = [
  '1:1',
  '3:2',
  '2:3',
  '16:9',
  '9:16'
] as const satisfies readonly ImageAspectRatio[]
export const GPT_IMAGE_RESOLUTIONS = [
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840',
  'auto'
] as const satisfies readonly ImageResolution[]
export const GPT_IMAGE_QUALITIES = [
  'low',
  'medium',
  'high'
] as const satisfies readonly ImageQuality[]
export const GPT_IMAGE_QUALITY_OPTIONS = [
  'auto',
  ...GPT_IMAGE_QUALITIES
] as const satisfies readonly ImageQuality[]

export const GPT_IMAGE_SIZE_BY_RATIO: Partial<Record<ImageAspectRatio, string>> = {
  '1:1': '1024x1024',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
  '9:16': '2160x3840',
  '16:9': '2048x1152'
}

export const GPT_IMAGE_RATIO_BY_SIZE: Partial<Record<string, ImageAspectRatio>> = {
  '1024x1024': '1:1',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '2048x2048': '1:1',
  '2048x1152': '16:9',
  '3840x2160': '16:9',
  '2160x3840': '9:16'
}

const GPT_IMAGE_MIN_PIXELS = 655360
const GPT_IMAGE_MAX_PIXELS = 8294400
const GPT_IMAGE_MAX_EDGE = 3840

function normalizePixelSize(size: string): string | null {
  const match = size.match(/^(\d+)x(\d+)$/i)
  if (!match) return null
  return `${Number(match[1])}x${Number(match[2])}`
}

function isValidGptImageSize(size: string): boolean {
  const match = size.match(/^(\d+)x(\d+)$/)
  if (!match) return false

  const width = Number(match[1])
  const height = Number(match[2])
  const longEdge = Math.max(width, height)
  const shortEdge = Math.min(width, height)
  const pixels = width * height

  return (
    longEdge <= GPT_IMAGE_MAX_EDGE &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    longEdge / shortEdge <= 3 &&
    pixels >= GPT_IMAGE_MIN_PIXELS &&
    pixels <= GPT_IMAGE_MAX_PIXELS
  )
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) {
    const next = x % y
    x = y
    y = next
  }
  return x || 1
}

function getRatioFromPixelSize(size: string): ImageAspectRatio | null {
  const match = size.match(/^(\d+)x(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}` as ImageAspectRatio
}

export const IMAGE_MODEL_OPTIONS: readonly ImageModelCapability[] = [
  {
    key: GPT_IMAGE_MODEL,
    provider: GPT_IMAGE_PROVIDER,
    model: GPT_IMAGE_MODEL,
    label: 'GPT Image 2',
    ratios: GPT_IMAGE_RATIOS,
    resolutions: GPT_IMAGE_RESOLUTIONS,
    qualities: GPT_IMAGE_QUALITY_OPTIONS,
    defaultRatio: '1:1',
    defaultResolution: 'auto',
    defaultQuality: 'auto',
    usesResolution: true,
    usesQuality: true
  }
]

/**
 * 按任意一种标识找模型，找不到返回 undefined。
 *
 * 三种标识都认：线上 id、稳定 key、以及用过的旧标识。历史任务里存的可能是
 * 其中任何一种 —— 只认一种的话，换过一次 id 之后旧记录就查不到了。
 *
 * 与 `getImageModelOption` 的分工：这个如实回答「认不认识」，那个负责
 * 「认不出就给个能用的默认值」。需要准确识别模型身份的地方要用这个。
 */
export function findImageModelOption(model?: string | null): ImageModelCapability | undefined {
  if (!model) return undefined
  return IMAGE_MODEL_OPTIONS.find(
    (option) =>
      option.model === model || option.key === model || option.aliases?.includes(model) === true
  )
}

export function getImageModelOption(model?: string | null): ImageModelCapability {
  return findImageModelOption(model) || IMAGE_MODEL_OPTIONS[0]
}

/**
 * 界面上「现在是谁在画」这句话。
 *
 * 认不出来时回落到**模型 id 本身**，而不是像别的 getter 那样回落到第一个选项 ——
 * 社区版用户绑的是自己配的模型（doubao-seedream / flux / 本机推理），
 * 一律回落的话，进度条上会写着「正在使用 Nano Banana 生成图片」，
 * 而那个模型压根没参与这次生成。界面陈述一件不存在的事，比难看严重得多。
 */
export function getImageModelLabel(model?: string | null): string {
  const known = findImageModelOption(model)
  if (known) return known.label
  return String(model || '').trim() || IMAGE_MODEL_OPTIONS[0].label
}

export function getImageProviderForModel(model?: string | null): ImageProvider {
  return getImageModelOption(model).provider
}

export function normalizeImageRatioForModel(
  model: string | null | undefined,
  ratio: string | null | undefined
): ImageAspectRatio {
  const option = getImageModelOption(model)
  const normalized = String(ratio || option.defaultRatio).trim() as ImageAspectRatio
  return option.ratios.includes(normalized) ? normalized : option.defaultRatio
}

export function normalizeImageQuality(quality?: string | null): ImageQuality {
  const normalized = String(quality || 'auto')
    .trim()
    .toLowerCase() as ImageQuality
  return GPT_IMAGE_QUALITY_OPTIONS.includes(normalized) ? normalized : 'auto'
}

export function normalizeImageResolutionForModel(
  model: string | null | undefined,
  resolution: string | null | undefined
): ImageResolution {
  const option = getImageModelOption(model)
  const raw = String(resolution || option.defaultResolution).trim()
  const normalized =
    raw.toLowerCase() === 'auto'
      ? 'auto'
      : raw.match(/^\d+x\d+$/i)
        ? normalizePixelSize(raw) || raw.toLowerCase()
        : raw.toUpperCase()
  if (
    option.model === GPT_IMAGE_MODEL &&
    typeof normalized === 'string' &&
    isValidGptImageSize(normalized)
  ) {
    return normalized as ImageResolution
  }
  return option.resolutions.includes(normalized as ImageResolution)
    ? (normalized as ImageResolution)
    : option.defaultResolution
}

export function getGptImageSizeForRatio(ratio?: string | null): string {
  const normalized = normalizeImageRatioForModel(GPT_IMAGE_MODEL, ratio)
  return GPT_IMAGE_SIZE_BY_RATIO[normalized as keyof typeof GPT_IMAGE_SIZE_BY_RATIO] || '1024x1024'
}

export function getGptImageRatioForSize(size?: string | null): ImageAspectRatio {
  const normalized = normalizeImageResolutionForModel(GPT_IMAGE_MODEL, size)
  if (GPT_IMAGE_RATIO_BY_SIZE[normalized]) {
    return GPT_IMAGE_RATIO_BY_SIZE[normalized]!
  }
  const derivedRatio = getRatioFromPixelSize(normalized)
  if (derivedRatio && getImageModelOption(GPT_IMAGE_MODEL).ratios.includes(derivedRatio)) {
    return derivedRatio
  }
  return getImageModelOption(GPT_IMAGE_MODEL).defaultRatio
}

export function getGptImageSizeTier(resolution?: string | null): '1K' | '2K' | '4K' {
  const normalized = normalizeImageResolutionForModel(GPT_IMAGE_MODEL, resolution)
  const upper = String(normalized || 'auto')
    .trim()
    .toUpperCase()

  if (upper === '1K' || upper === '2K' || upper === '4K') {
    return upper
  }
  if (!upper || upper === 'AUTO') {
    return '1K'
  }

  const match = upper.match(/^(\d+)X(\d+)$/)
  if (!match) {
    return '1K'
  }

  const width = Number(match[1])
  const height = Number(match[2])
  const longEdge = Math.max(width, height)
  if (longEdge > 2048) return '4K'
  if (longEdge > 1536) return '2K'
  return '1K'
}
