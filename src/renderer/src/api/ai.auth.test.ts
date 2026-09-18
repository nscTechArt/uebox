import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/common/http', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
vi.mock('@renderer/store/modules/aiConfig', () => ({ useAIConfigStore: () => ({}) }))
vi.mock('../i18n', () => ({ default: { global: { t: (key: string) => key } } }))

const generateImage = vi.fn()

const aiAPI = (await import('./ai')).default

beforeEach(() => {
  localStorage.clear()
  generateImage.mockReset()
  generateImage.mockResolvedValue({
    success: true,
    data: { images: [{ base64: 'QUJD', mediaType: 'image/webp' }] }
  })
  ;(window as unknown as { api: unknown }).api = { ai: { generateImage } }
})

describe('generateImage 在没有官方会话时的回落', () => {
  it('走本地生图模型，而不是抛「未登录」', async () => {
    const response = await aiAPI.generateImage({ prompt: '一把中世纪的剑' })

    expect(generateImage).toHaveBeenCalledTimes(1)
    expect(response.ok).toBe(true)
  })

  /**
   * 图片装成完整的 data URI 放在 `url` 里，而不是把裸 base64 放 `base64`：
   * 调用方拿到 `base64` 会自己拼 `data:image/png;base64,` 前缀，
   * 而本机模型出的可能是 webp —— 拼错前缀的表现是一张显示不出来的裂图。
   */
  it('图片装成 data URI 放进 url，媒体类型跟着模型走', async () => {
    const response = await aiAPI.generateImage({ prompt: 'x' })

    expect(response.images[0].url).toBe('data:image/webp;base64,QUJD')
    expect(response.images[0].base64).toBeUndefined()
  })

  it('参考图透下去，图生图照常可用', async () => {
    await aiAPI.generateImage({ prompt: 'x', image: 'data:image/png;base64,AAAA' })

    expect(generateImage.mock.calls[0][0].referenceImages).toEqual(['data:image/png;base64,AAAA'])
  })

  it('多张参考图优先于单张', async () => {
    await aiAPI.generateImage({ prompt: 'x', image: 'one', images: ['a', 'b'] })

    expect(generateImage.mock.calls[0][0].referenceImages).toEqual(['a', 'b'])
  })

  it('尺寸与比例原样递给主进程，由它决定认不认', async () => {
    await aiAPI.generateImage({ prompt: 'x', imageSize: '2K', aspectRatio: '16:9' })

    expect(generateImage.mock.calls[0][0]).toMatchObject({ size: '2K', aspectRatio: '16:9' })
  })

  it('信息图选中的 Provider 与模型原样递给主进程', async () => {
    await aiAPI.generateImage({
      prompt: 'x',
      localProviderId: 'my-images',
      localModelId: 'flux-dev'
    })

    expect(generateImage.mock.calls[0][0]).toMatchObject({
      providerId: 'my-images',
      modelId: 'flux-dev'
    })
  })

  it('本地模型没配好时把主进程给的说明透出来，而不是一句「生成失败」', async () => {
    generateImage.mockResolvedValue({ success: false, error: '还没有配置「生图」模型。' })

    await expect(aiAPI.generateImage({ prompt: 'x' })).rejects.toThrow('还没有配置「生图」模型。')
  })

  it('有官方会话但明确选择本地模型时仍按选择生成', async () => {
    localStorage.setItem('auth-token', 'official-token')

    await aiAPI.generateImage({
      prompt: 'x',
      localProviderId: 'my-images',
      localModelId: 'flux-dev'
    })

    expect(generateImage).toHaveBeenCalledTimes(1)
  })
})

it.each(['auth-token', 'auth-refresh-token'])(
  'ignores a legacy %s when generating an image',
  async (key) => {
    localStorage.setItem(key, 'stale-test-token')
    const response = await aiAPI.generateImage({ prompt: 'x' })
    expect(generateImage).toHaveBeenCalledOnce()
    expect(response.images[0].url).toBe('data:image/webp;base64,QUJD')
  }
)
