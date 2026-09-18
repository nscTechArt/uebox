/**
 * 把「宽高比」和「分辨率」合成一件事。
 *
 * 面板上曾经并排摆着两个控件，而它们说的是同一件事：`1536x1024` 就是 3:2，
 * `3840x2160` 就是 16:9。选了比例，分辨率会被悄悄改掉；选了分辨率，比例也会跳 ——
 * 联动逻辑一直都在（`getGptImageSizeForRatio` / `getGptImageRatioForSize`），
 * 只是界面从没说过，于是它看起来像个 bug。
 *
 * 这里把它翻译成用户真正在做的两个决定：**形状**（比例）和**大小**（档位）。
 * 档位只有 Auto / 1K / 2K / 4K 四种，具体像素由(比例 × 档位)推出来，
 * 并且**只列这个比例下真的存在的档位** —— 列一个选了就会把比例改掉的尺寸，
 * 就是上面那个 bug 换个地方重演。
 */
import {
  getGptImageSizeTier,
  getGptImageRatioForSize,
  getImageModelOption,
  normalizeImageResolutionForModel,
  type ImageAspectRatio,
  type ImageResolution
} from '../../../../shared/imageGenerationModels'

/** 大小档位。`auto` 表示交给模型决定 */
export type ImageSizeTier = 'auto' | '1K' | '2K' | '4K'

export interface ImageSizeTierOption {
  tier: ImageSizeTier
  /** 选中这个档位时真正提交的分辨率值，仍然是模型认识的那个字符串 */
  resolution: ImageResolution
  /** 具体像素；档位本身就是分辨率、或者 Auto 时为 null */
  pixels: string | null
}

/** 档位从小到大，Auto 排最前 —— 它是默认值，也是唯一一个「不用想」的选项 */
const TIER_ORDER: readonly ImageSizeTier[] = ['auto', '1K', '2K', '4K']

const PIXEL_SIZE_PATTERN = /^\d+x\d+$/i

function isTierKey(resolution: string): resolution is ImageSizeTier {
  return (TIER_ORDER as readonly string[]).includes(resolution)
}

/**
 * 这个模型 + 这个比例下可选的档位。
 *
 * 两类分辨率走同一条路：
 * · 本身就是档位的（Auto，以及将来可能出现的 1K/2K/4K 档）——与比例无关，全都列出来
 * · 具体像素的（GPT Image 2）——只保留比例对得上的那些，再按大小档位归类
 */
export function getSizeTierOptions(
  model: string | null | undefined,
  ratio: ImageAspectRatio
): ImageSizeTierOption[] {
  const option = getImageModelOption(model)
  const byTier = new Map<ImageSizeTier, ImageSizeTierOption>()

  for (const resolution of option.resolutions) {
    if (isTierKey(resolution)) {
      if (!byTier.has(resolution)) {
        byTier.set(resolution, { tier: resolution, resolution, pixels: null })
      }
      continue
    }
    if (!PIXEL_SIZE_PATTERN.test(resolution)) continue
    if (getGptImageRatioForSize(resolution) !== ratio) continue

    const tier = getGptImageSizeTier(resolution)
    if (!byTier.has(tier)) {
      byTier.set(tier, { tier, resolution, pixels: resolution })
    }
  }

  return TIER_ORDER.filter((tier) => byTier.has(tier)).map((tier) => byTier.get(tier)!)
}

/** 当前分辨率落在哪个档位上 —— 用来把档位按钮点亮 */
export function getActiveSizeTier(
  model: string | null | undefined,
  resolution: string | null | undefined
): ImageSizeTier {
  const normalized = normalizeImageResolutionForModel(model, resolution)
  if (isTierKey(normalized)) return normalized
  if (PIXEL_SIZE_PATTERN.test(normalized)) return getGptImageSizeTier(normalized)
  return 'auto'
}

/** 分辨率对应的具体像素；档位式分辨率和 Auto 没有确定像素，返回 null */
export function getResolutionPixels(
  model: string | null | undefined,
  resolution: string | null | undefined
): string | null {
  const normalized = normalizeImageResolutionForModel(model, resolution)
  return PIXEL_SIZE_PATTERN.test(normalized) ? normalized : null
}

/** 点某个档位时该提交的分辨率。该比例下没有这个档位就回落到第一个（通常是 Auto） */
export function resolveResolutionForTier(
  model: string | null | undefined,
  ratio: ImageAspectRatio,
  tier: ImageSizeTier,
  currentResolution: string | null | undefined
): ImageResolution {
  const options = getSizeTierOptions(model, ratio)
  if (options.length === 0) return normalizeImageResolutionForModel(model, currentResolution)
  const matched = options.find((option) => option.tier === tier)
  return (matched ?? options[0]).resolution
}

/**
 * 换比例时该提交的分辨率。
 *
 * 尽量守住用户已经选好的档位 —— 从 1:1 的 2K 换到 16:9，他要的是「还是 2K，换个形状」，
 * 不是回到 Auto。新比例下没有那个档位时才回落。
 */
export function resolveResolutionForRatio(
  model: string | null | undefined,
  ratio: ImageAspectRatio,
  currentResolution: string | null | undefined
): ImageResolution {
  return resolveResolutionForTier(
    model,
    ratio,
    getActiveSizeTier(model, currentResolution),
    currentResolution
  )
}
