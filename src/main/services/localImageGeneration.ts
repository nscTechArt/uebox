import { generateImages } from '../ai/imageGeneration'

/**
 * 将创作任务参数映射为用户配置的生图模型请求。统一输出内联图片，供入库、重试和多图任务使用。
 */

/** 与 imagePollingService 里的 `ImageGenerateApiResult` 结构兼容的最小子集 */
export interface LocalImageGenerationResult {
  ok: true
  status: 'completed'
  images: Array<{ base64: string }>
}

/** 主图与多图（image / images）统一为参考图数组 */
function collectReferenceImages(requestBody: Record<string, unknown>): string[] {
  const multiple = Array.isArray(requestBody.images)
    ? (requestBody.images as unknown[]).filter((item): item is string => typeof item === 'string')
    : []
  if (multiple.length > 0) return multiple

  return typeof requestBody.image === 'string' ? [requestBody.image] : []
}

export async function generateWithLocalImageModel(
  requestBody: Record<string, unknown>,
  signal?: AbortSignal
): Promise<LocalImageGenerationResult> {
  const images = await generateImages({
    prompt: String(requestBody.prompt || ''),
    providerId: typeof requestBody.provider === 'string' ? requestBody.provider : undefined,
    modelId: typeof requestBody.model === 'string' ? requestBody.model : undefined,
    // imageSize 可以是 1K/2K/4K 这种档位，只有写成 1024x1024
    // 时才是真尺寸。generateImages 认不出来就当没填、回落到按比例出图 ——
    // 正是这里想要的，所以原样递过去而不是自己先判一遍。
    size: typeof requestBody.imageSize === 'string' ? requestBody.imageSize : undefined,
    aspectRatio: typeof requestBody.aspectRatio === 'string' ? requestBody.aspectRatio : undefined,
    count: typeof requestBody.batchSize === 'number' ? requestBody.batchSize : 1,
    referenceImages: collectReferenceImages(requestBody),
    signal
  })

  return {
    ok: true,
    status: 'completed',
    // 回 data URI 而不是外链：本机 provider 根本不给外链，而给外链的那几家
    // 链接几小时后就失效，存进资产库的图会集体变成裂图。
    images: images.map((image) => ({ base64: `data:${image.mediaType};base64,${image.base64}` }))
  }
}
