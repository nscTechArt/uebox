import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generateImages: vi.fn()
}))

vi.mock('../ai/imageGeneration', () => ({
  generateImages: mocks.generateImages
}))

const { generateWithLocalImageModel } = await import('./localImageGeneration')

/** 创作任务请求参数的最小示例 */
function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'gemini',
    model: 'gemini-3.1-flash-image-preview',
    prompt: '一把中世纪的剑',
    imageSize: '1K',
    aspectRatio: '16:9',
    batchSize: 1,
    ...overrides
  }
}

beforeEach(() => {
  mocks.generateImages.mockReset()
  mocks.generateImages.mockResolvedValue([{ base64: 'AAAA', mediaType: 'image/png' }])
})

describe('generateWithLocalImageModel 的字段映射', () => {
  it('提示词、比例、张数照原样递过去', async () => {
    await generateWithLocalImageModel(requestBody({ batchSize: 2 }))

    expect(mocks.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '一把中世纪的剑', aspectRatio: '16:9', count: 2 })
    )
  })

  /**
   * imageSize 在官方那边多数时候是 1K/2K/4K 这种档位而不是像素尺寸。
   * 这里不自己判、原样递给 generateImages，由它认不出来时回落到按比例出图 ——
   * 在这一层先判一遍就会有两份「什么算尺寸」的规则，早晚对不上。
   */
  it('imageSize 原样递过去，不在这一层预判是档位还是像素', async () => {
    await generateWithLocalImageModel(requestBody({ imageSize: '1K' }))
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.objectContaining({ size: '1K' }))

    await generateWithLocalImageModel(requestBody({ imageSize: '1024x1024' }))
    expect(mocks.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ size: '1024x1024' })
    )
  })

  it('没给 batchSize 时按一张算，而不是把 undefined 递下去', async () => {
    await generateWithLocalImageModel(requestBody({ batchSize: undefined }))

    expect(mocks.generateImages).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))
  })

  /**
   * 参考图漏传是这层映射最典型的静默失败：不报错，只是「图生图」悄悄退化成
   * 「文生图」，用户得对着一张完全不像参考图的结果自己猜。
   */
  it('多张参考图优先于单张主图', async () => {
    await generateWithLocalImageModel(requestBody({ image: 'primary', images: ['a', 'b', 'c'] }))

    expect(mocks.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImages: ['a', 'b', 'c'] })
    )
  })

  it('只有单张主图时也要接上', async () => {
    await generateWithLocalImageModel(requestBody({ image: 'primary' }))

    expect(mocks.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImages: ['primary'] })
    )
  })

  it('没有参考图时给空数组', async () => {
    await generateWithLocalImageModel(requestBody())

    expect(mocks.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImages: [] })
    )
  })

  it('取消信号一路传到底 —— 点了取消要真的停下来', async () => {
    const controller = new AbortController()

    await generateWithLocalImageModel(requestBody(), controller.signal)

    expect(mocks.generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal })
    )
  })
})

describe('generateWithLocalImageModel 的返回形状', () => {
  it('伪装成官方那份已完成的结果，下游一行都不用改', async () => {
    mocks.generateImages.mockResolvedValue([
      { base64: 'AAAA', mediaType: 'image/png' },
      { base64: 'BBBB', mediaType: 'image/jpeg' }
    ])

    const result = await generateWithLocalImageModel(requestBody({ batchSize: 2 }))

    expect(result).toEqual({
      ok: true,
      status: 'completed',
      images: [
        { base64: 'data:image/png;base64,AAAA' },
        // 各家返回的类型不一定是 png，前缀得跟着走，否则预览是一张裂图
        { base64: 'data:image/jpeg;base64,BBBB' }
      ]
    })
  })

  it('模型报错原样抛出，由上层统一转成用户能看懂的话', async () => {
    mocks.generateImages.mockRejectedValue(new Error('厂商拒绝了这个提示词'))

    await expect(generateWithLocalImageModel(requestBody())).rejects.toThrow('厂商拒绝了这个提示词')
  })
})

it('keeps the image provider and model explicitly selected by the user', async () => {
  await generateWithLocalImageModel(
    requestBody({ provider: 'my-image-provider', model: 'my-image-model' })
  )
  expect(mocks.generateImages).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: 'my-image-provider',
      modelId: 'my-image-model'
    })
  )
})
