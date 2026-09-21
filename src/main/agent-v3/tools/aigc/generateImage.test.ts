/**
 * @vitest-environment node
 *
 * 生图工具。
 *
 * 盯的是这四件容易悄悄坏掉的事：
 *   1. 参考图真的传下去了 —— 漏了不会报错，只会出一张和白盒无关的图
 *   2. 出的图存进素材库并把**绝对路径**回出来 —— 界面和 ue_content_import 都靠它
 *   3. 存盘失败不吞图 —— 钱已经花了
 *   4. 进上下文的图有张数上限 —— 八张原图能把上下文烧穿
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateImages = vi.fn()
const readSettings = vi.fn()
const saveAIGCAssetFromBuffer = vi.fn()

vi.mock('../../../ai/imageGeneration', () => ({
  generateImages: (...args: unknown[]) => generateImages(...args)
}))
vi.mock('../../../ai/store', () => ({
  readSettings: () => readSettings()
}))
vi.mock('../../../services/aigc/assetSaver', () => ({
  saveAIGCAssetFromBuffer: (...args: unknown[]) => saveAIGCAssetFromBuffer(...args)
}))
// 压缩本身在 contextImage 里，这里只关心「压了几张」
vi.mock('../contextImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contextImage')>()),
  compressForContext: async () => ({ data: 'compressed', mimeType: 'image/jpeg' })
}))

import { createGenerateImageTool } from './generateImage'

const tool = createGenerateImageTool()

const SETTINGS_WITH_ARK = {
  version: 2,
  providers: [
    {
      id: 'ark',
      displayName: '火山方舟',
      kind: 'image',
      protocol: 'openai-completions',
      baseUrl: 'https://ark.example/v1',
      apiKey: { kind: 'none' },
      models: [{ id: 'doubao-seedream-4-0' }, { id: 'doubao-pro', supportsTools: true }]
    }
  ],
  roles: { image: { providerId: 'ark', modelId: 'doubao-seedream-4-0' } }
}

const textOf = (result: unknown): string =>
  (result as { content: { text?: string }[] }).content.map((part) => part.text ?? '').join('')

const imagesOf = (result: unknown): unknown[] =>
  (result as { content: { type: string }[] }).content.filter((part) => part.type === 'image')

const detailsOf = (result: unknown): Record<string, unknown> =>
  (result as { details: Record<string, unknown> }).details

function oneImage(): { base64: string; mediaType: string }[] {
  return [{ base64: Buffer.from('fake-png').toString('base64'), mediaType: 'image/png' }]
}

beforeEach(() => {
  generateImages.mockReset().mockResolvedValue(oneImage())
  readSettings.mockReset().mockResolvedValue(SETTINGS_WITH_ARK)
  saveAIGCAssetFromBuffer
    .mockReset()
    .mockImplementation(async (_bytes: Buffer, _type: string, options: { extension: string }) => ({
      success: true,
      filePath: `H:\\素材库\\AIGC\\图片\\out.${options.extension}`,
      assetKey: 'aigc_image_1'
    }))
})

describe('元数据', () => {
  it('是改动类工具 —— 它花用户的钱，ask 档要问一次', () => {
    expect(tool.unrealBox.risk).toBe('mutating')
    expect(tool.unrealBox.namespace).toBe('aigc')
  })

  it('描述里写清白盒出图那条流程，否则模型不会想到先截图', () => {
    expect(tool.description).toContain('ue_screenshot')
    expect(tool.description).toContain('reference_images')
    expect(tool.description).toContain('ue_content_import')
  })

  // 「把这个场景渲染成成品」两边都通：要么是 AI 概念图，要么是 MRQ 出片。
  // 猜错了拿 AI 图顶上，用户要到很久以后才发现那张图根本不能用
  it('描述里说清它不是引擎渲染，且「渲染」有歧义时要先问', () => {
    expect(tool.description).toContain('不是引擎渲染结果')
    expect(tool.description).toContain('Movie Render Queue')
    expect(tool.description).toContain('先问一句')
  })

  it('通用改图保留原图约束，多图说明角色，不用 seed 承诺一致性', () => {
    expect(tool.description).toContain('image-generation')
    expect(tool.description).toContain('只改 X；保持 Y 不变')
    expect(tool.description).toContain('每轮重申')
    expect(tool.description).toContain('多图按输入顺序写明每张的角色')
    expect(tool.description).toContain('不靠 seed 保证构图')
    expect(tool.description).not.toContain('不说参考图里已经有什么')
  })

  it('明确数量、逐字文字、禁止擅自扩写以及出图验收', () => {
    expect(tool.description).toContain('明确主体数量')
    expect(tool.description).toContain('文字逐字引用')
    expect(tool.description).toContain('不擅自增加人物')
    expect(tool.description).toContain('不同素材分别写提示词')
    expect(tool.description).toContain('逐项检查主体、数量、构图、文字、保留项和禁止项')
    expect(tool.description).toContain('最终提示词')
  })
})

describe('出图', () => {
  it('提示词、张数、比例、尺寸、种子原样传给生图接口', async () => {
    await tool.execute('c1', {
      prompt: '写实渲染的中世纪石屋',
      count: 2,
      aspect_ratio: '16:9',
      size: '2K',
      seed: 42
    })

    expect(generateImages).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '写实渲染的中世纪石屋',
        count: 2,
        aspectRatio: '16:9',
        size: '2K',
        seed: 42
      })
    )
  })

  it('不填 count 就出一张 —— 张数直接乘在账单上', async () => {
    await tool.execute('c1', { prompt: '一把椅子' })

    expect(generateImages.mock.calls[0]![0]).toMatchObject({ count: 1 })
  })

  it('没指定模型时不传绑定，也不在返回值里编一个模型名', async () => {
    const result = await tool.execute('c1', { prompt: '一把椅子' })

    expect(generateImages.mock.calls[0]![0]).not.toHaveProperty('modelId')
    expect(detailsOf(result).model).toBe('火山方舟:doubao-seedream-4-0')
  })
})

describe('参考图', () => {
  it('本地绝对路径读成 data URI 传下去（白盒截图就是这么进来的）', async () => {
    const { writeFile, mkdtemp } = await import('fs/promises')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = await mkdtemp(join(tmpdir(), 'aigc-ref-'))
    const shot = join(dir, 'blockout.png')
    await writeFile(shot, Buffer.from('shot-bytes'))

    await tool.execute('c1', { prompt: '出成品图', reference_images: [shot] })

    const sent = generateImages.mock.calls[0]![0] as { referenceImages: string[] }
    expect(sent.referenceImages).toHaveLength(1)
    expect(sent.referenceImages[0]).toBe(
      `data:image/png;base64,${Buffer.from('shot-bytes').toString('base64')}`
    )
  })

  it('路径写错就报错，不静默丢掉参考图', async () => {
    await expect(
      tool.execute('c1', { prompt: '出成品图', reference_images: ['H:\\不存在\\a.png'] })
    ).rejects.toThrow(/读不到/)

    expect(generateImages).not.toHaveBeenCalled()
  })

  it('相对路径直接挡下来，并告诉它去哪拿绝对路径', async () => {
    await expect(
      tool.execute('c1', { prompt: '出成品图', reference_images: ['shots/a.png'] })
    ).rejects.toThrow(/绝对路径/)
  })

  it('没有参考图时不发这个字段 —— 有的厂商收到空数组会当成图生图', async () => {
    await tool.execute('c1', { prompt: '一把椅子' })

    expect(generateImages.mock.calls[0]![0]).not.toHaveProperty('referenceImages')
  })
})

describe('选模型', () => {
  it('写模型 id 的片段就能命中，返回值里说清用的是谁', async () => {
    const result = await tool.execute('c1', { prompt: '一把椅子', model: 'seedream' })

    expect(generateImages.mock.calls[0]![0]).toMatchObject({
      providerId: 'ark',
      modelId: 'doubao-seedream-4-0'
    })
    expect(detailsOf(result).model).toBe('火山方舟:doubao-seedream-4-0')
  })

  it('模型名不存在时把可选清单报回去，而不是拿绑定的顶上', async () => {
    await expect(tool.execute('c1', { prompt: '一把椅子', model: 'midjourney' })).rejects.toThrow(
      /doubao-seedream-4-0/
    )

    expect(generateImages).not.toHaveBeenCalled()
  })

  it('一个生图模型都没配时说清该去哪配', async () => {
    readSettings.mockResolvedValue({ version: 2, providers: [], roles: {} })

    await expect(tool.execute('c1', { prompt: '一把椅子', model: 'seedream' })).rejects.toThrow(
      /设置 → 模型/
    )
  })
})

describe('落盘与回执', () => {
  it('存进素材库，绝对路径进 path（界面靠它显示缩略图）', async () => {
    const result = await tool.execute('c1', { prompt: '中世纪石屋' })

    expect(saveAIGCAssetFromBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image',
      expect.objectContaining({ extension: 'png', prompt: '中世纪石屋' })
    )
    expect(detailsOf(result).path).toBe('H:\\素材库\\AIGC\\图片\\out.png')
    expect(detailsOf(result).image_paths).toEqual(['H:\\素材库\\AIGC\\图片\\out.png'])
    expect(detailsOf(result).asset_keys).toEqual(['aigc_image_1'])
  })

  it('多张图分别编号存盘', async () => {
    generateImages.mockResolvedValue([...oneImage(), ...oneImage()])

    await tool.execute('c1', { prompt: '石屋', count: 2 })

    const names = saveAIGCAssetFromBuffer.mock.calls.map(
      (call) => (call[2] as { suggestedName: string }).suggestedName
    )
    expect(names).toEqual(['石屋_1', '石屋_2'])
  })

  it('jpeg 存成 .jpg —— 扩展名不对界面就不当它是图', async () => {
    generateImages.mockResolvedValue([{ base64: 'AAAA', mediaType: 'image/jpeg' }])

    await tool.execute('c1', { prompt: '石屋' })

    expect(saveAIGCAssetFromBuffer.mock.calls[0]![2]).toMatchObject({ extension: 'jpg' })
  })

  it('存盘失败也把图交出去 —— 钱已经花了，扔掉最亏', async () => {
    saveAIGCAssetFromBuffer.mockResolvedValue({
      success: false,
      filePath: '',
      assetKey: '',
      error: 'AIGC 资产库未初始化'
    })

    const result = await tool.execute('c1', { prompt: '石屋' })

    expect(imagesOf(result)).toHaveLength(1)
    expect(textOf(result)).toContain('AIGC 资产库未初始化')
    expect(detailsOf(result).save_error).toBe('AIGC 资产库未初始化')
  })
})

/**
 * 真机上出现过：三次调用全失败，模型只拿到一句「返回的是 HTML 不是 JSON」，
 * 于是判定「生图服务不可用，去检查 key」—— 而用户的 key 是好的，
 * AI 创作面板里同一个模型出图正常。差别在于那边没有参考图，走的是另一个端点。
 */
describe('失败时报得够不够排查', () => {
  it('带参考图失败时点明端点不同，并给出分清两者的做法', async () => {
    const failure = Object.assign(
      new Error('生图接口报错 HTTP 404（POST /images/edits）：返回的是 HTML 网页而不是 JSON'),
      { url: 'https://gateway.example/v1/images/edits' }
    )
    generateImages.mockRejectedValue(failure)

    await expect(
      tool.execute('c1', { prompt: '石屋', reference_images: ['data:image/png;base64,AAAA'] })
    ).rejects.toThrow(/images\/edits/)

    const message = await tool
      .execute('c1', { prompt: '石屋', reference_images: ['data:image/png;base64,AAAA'] })
      .catch((error: Error) => error.message)
    // 报出实际模型和地址，但不引导自动花钱改成文生图诊断
    expect(message).toContain('火山方舟:doubao-seedream-4-0')
    expect(message).toContain('https://gateway.example/v1/images/edits')
    expect(message).toContain('不要自动去掉 reference_images 再调一次')
    expect(message).toContain('先取得用户授权')
    expect(message).not.toContain('成功就说明这家网关不支持图生图')
    // 最要紧的一句：别让模型把用户支到「去查 key」上去
    expect(message).toContain('AI 创作面板里同一个模型能出图')
  })

  it('纯文生图失败时给的是另一套排查顺序', async () => {
    generateImages.mockRejectedValue(new Error('生图接口报错 HTTP 401：invalid api key'))

    const message = await tool
      .execute('c1', { prompt: '石屋' })
      .catch((error: Error) => error.message)

    expect(message).toContain('这次没有带参考图')
    expect(message).toContain('API 地址')
    expect(message).not.toContain('去掉 reference_images')
  })
})

describe('进上下文的图', () => {
  it('图片走图片块，不塞进文本里', async () => {
    const result = await tool.execute('c1', { prompt: '石屋' })

    expect(imagesOf(result)).toHaveLength(1)
    expect(textOf(result)).not.toContain('compressed')
  })

  it('最多四张进上下文，其余只给路径 —— 八张能把上下文烧穿', async () => {
    generateImages.mockResolvedValue(Array.from({ length: 8 }, () => oneImage()[0]!))

    const result = await tool.execute('c1', { prompt: '石屋', count: 8 })

    expect(imagesOf(result)).toHaveLength(4)
    expect(detailsOf(result).image_paths).toHaveLength(8)
    expect(textOf(result)).toContain('前 4 张')
  })
})
