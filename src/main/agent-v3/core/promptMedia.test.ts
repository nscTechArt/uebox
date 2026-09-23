/**
 * 守两件事：
 * - 能直接看视频的模型，在同一轮里收到的是厂商认的音视频块，而不是另一个模型的转述。
 * - 对话里那段引用**逐字不变**，换模型、对象被清理时换成同一句说明 —— 前缀缓存靠这个。
 */

import type { Context } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../ai/store', () => ({ readSettings: vi.fn() }))
vi.mock('../../services/objectStorage/objectStorageService', () => ({
  isObjectStorageReady: vi.fn(),
  uploadMediaFile: vi.fn()
}))
vi.mock('./promptAttachments', () => ({ savePromptAttachments: vi.fn() }))

const {
  contextHasMediaRefs,
  describePromptMedia,
  mediaRefText,
  mediaUrlKinds,
  modelTakesMediaUrl,
  parseMediaRef,
  preparePromptImages,
  preparePromptMedia,
  replaceMediaRefs,
  rewriteMediaInPayload
} = await import('./promptMedia')

const VIDEO = { filePath: 'C:\\素材\\clip.mp4', fileName: 'clip.mp4', kind: 'video' as const }
const AUDIO = { filePath: 'C:\\素材\\voice.m4a', fileName: 'voice.m4a', kind: 'audio' as const }
const REF = {
  kind: 'video' as const,
  key: 'uebox-media/abc.mp4',
  fileName: 'clip.mp4',
  filePath: VIDEO.filePath
}

type PrepareDeps = NonNullable<Parameters<typeof preparePromptMedia>[3]>

function deps(overrides: Partial<PrepareDeps> = {}): PrepareDeps {
  return {
    isReady: async () => true,
    canSend: async () => true,
    upload: async (filePath: string) => ({
      key: `uebox-media/${filePath.endsWith('.mp4') ? 'v' : 'a'}`
    }),
    ...overrides
  }
}

describe('引用的编解码', () => {
  it('写出去再读回来是同一个', () => {
    expect(parseMediaRef(mediaRefText(REF))).toEqual(REF)
  })

  it('普通文字不会被当成引用', () => {
    expect(parseMediaRef('[[uebox-media 不是 JSON]]')).toBeNull()
    expect(parseMediaRef('视频里有什么')).toBeNull()
  })
})

describe('preparePromptMedia', () => {
  it('模型能看、存储配好了：上传并生成引用，说明里写「已随消息发给你」', async () => {
    const prepared = await preparePromptMedia(
      [VIDEO, AUDIO],
      { providerId: 'p', modelId: 'm' },
      undefined,
      deps()
    )

    expect(prepared.refs.map((ref) => ref.key)).toEqual(['uebox-media/v', 'uebox-media/a'])
    expect(prepared.note).toContain('已随这条消息发给你')
    expect(prepared.note).not.toContain('analyze_video')
  })

  it('没配存储：不上传，只给路径并指明用哪个工具', async () => {
    const upload = vi.fn()
    const prepared = await preparePromptMedia(
      [VIDEO],
      { providerId: 'p', modelId: 'm' },
      undefined,
      deps({ isReady: async () => false, upload })
    )

    expect(upload).not.toHaveBeenCalled()
    expect(prepared.refs).toEqual([])
    expect(prepared.note).toContain(VIDEO.filePath)
    expect(prepared.note).toContain('analyze_video')
  })

  it('模型看不了视频：同样只给路径，存储配没配都不传', async () => {
    const upload = vi.fn()
    const prepared = await preparePromptMedia(
      [VIDEO],
      { providerId: 'p', modelId: 'm' },
      undefined,
      deps({ canSend: async () => false, upload })
    )

    expect(upload).not.toHaveBeenCalled()
    expect(prepared.refs).toEqual([])
  })

  it('上传失败不拦这一轮：退回路径，并把原因写给模型', async () => {
    const prepared = await preparePromptMedia(
      [VIDEO],
      { providerId: 'p', modelId: 'm' },
      undefined,
      deps({
        upload: async () => {
          throw new Error('签名不对')
        }
      })
    )

    expect(prepared.refs).toEqual([])
    expect(prepared.note).toContain('传到对象存储失败：签名不对')
  })

  it('没带音视频就什么都不做', async () => {
    expect(
      await preparePromptMedia([], { providerId: 'p', modelId: 'm' }, undefined, deps())
    ).toEqual({
      refs: [],
      note: ''
    })
  })
})

describe('describePromptMedia', () => {
  it('混着来：发出去的和只给路径的分别写清', () => {
    const note = describePromptMedia([VIDEO, AUDIO], new Set([VIDEO.filePath]))
    expect(note).toContain('视频：clip.mp4（已随这条消息发给你')
    expect(note).toContain('音频：voice.m4a（本地路径：')
  })
})

interface TestPayload {
  model: string
  messages: Array<{ role: string; content: unknown }>
}

describe('发请求时的改写', () => {
  const payload = (): TestPayload => ({
    model: 'mimo-v2.6-pro',
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '视频里有什么' },
          { type: 'text', text: mediaRefText(REF) },
          { type: 'text', text: mediaRefText({ ...REF, kind: 'audio', key: 'uebox-media/a.m4a' }) }
        ]
      }
    ]
  })

  it('视频换成 video_url，音频换成 input_audio（MIMO 文档的形状）', async () => {
    const rewritten = (await rewriteMediaInPayload(payload(), {
      urlFor: async (key) => `https://bucket.example.com/${key}?sig=1`,
      isRemoved: async () => false
    })) as ReturnType<typeof payload>

    expect(rewritten.messages[1].content).toEqual([
      { type: 'text', text: '视频里有什么' },
      {
        type: 'video_url',
        video_url: { url: 'https://bucket.example.com/uebox-media/abc.mp4?sig=1' }
      },
      {
        type: 'input_audio',
        input_audio: { data: 'https://bucket.example.com/uebox-media/a.m4a?sig=1' }
      }
    ])
  })

  it('清理掉的对象换成说明，不把 404 的链接发给厂商', async () => {
    const rewritten = (await rewriteMediaInPayload(payload(), {
      urlFor: async () => 'https://x',
      isRemoved: async (key) => key === REF.key
    })) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> }

    expect(rewritten.messages[1].content[1]).toMatchObject({ type: 'text' })
    expect(rewritten.messages[1].content[1].text).toContain('已经从对象存储里清理掉了')
  })

  it('存储不可用时也换成说明', async () => {
    const rewritten = (await rewriteMediaInPayload(payload(), {
      urlFor: async () => null,
      isRemoved: async () => false
    })) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> }

    expect(rewritten.messages[1].content[1].text).toContain('对象存储现在不可用')
  })

  it('没有引用就返回 undefined，让 pi 用原来的请求体', async () => {
    const plain = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
    expect(
      await rewriteMediaInPayload(plain, { urlFor: async () => 'x', isRemoved: async () => false })
    ).toBeUndefined()
  })
})

describe('当前模型收不了链接', () => {
  const context = (): Context => ({
    systemPrompt: 'sys',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '视频里有什么' },
          { type: 'text', text: mediaRefText(REF) }
        ],
        timestamp: 1
      }
    ]
  })

  it('引用换成同一句说明 —— 每轮逐字相同', () => {
    const first = replaceMediaRefs(context())
    const second = replaceMediaRefs(context())
    expect(contextHasMediaRefs(first)).toBe(false)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(JSON.stringify(first)).toContain('当前模型收不了视频链接')
  })

  it('只换副本，不动原来那份（它要原样落进 JSONL）', () => {
    const original = context()
    replaceMediaRefs(original)
    expect(contextHasMediaRefs(original)).toBe(true)
  })
})

describe('modelTakesMediaUrl', () => {
  const settings = (protocol: string, supportsVideo: boolean, supportsVision = false): never =>
    ({
      providers: [{ id: 'p', protocol, models: [{ id: 'm', supportsVideo, supportsVision }] }],
      roles: {}
    }) as never

  it('图片看「视觉」，音视频看「视频」，各算各的', () => {
    expect([...mediaUrlKinds(settings('openai-completions', false, true), 'p', 'm')]).toEqual([
      'image'
    ])
    expect([...mediaUrlKinds(settings('openai-completions', true, true), 'p', 'm')]).toEqual([
      'image',
      'video',
      'audio'
    ])
    expect(mediaUrlKinds(settings('anthropic-messages', true, true), 'p', 'm').size).toBe(0)
  })

  it('勾了视频、又是 OpenAI 兼容协议才走链接', () => {
    expect(modelTakesMediaUrl(settings('openai-completions', true), 'p', 'm')).toBe(true)
    expect(modelTakesMediaUrl(settings('openai-completions', false), 'p', 'm')).toBe(false)
    // Gemini 的 fileUri 只认自家 Files API 和 YouTube，桶里的链接会被 400 顶回来
    expect(modelTakesMediaUrl(settings('google-generative-ai', true), 'p', 'm')).toBe(false)
  })
})

describe('只收得了一部分种类的模型', () => {
  it('能看图不能看视频：图片引用留着，视频引用换成说明', () => {
    const imageRef = { ...REF, kind: 'image' as const, key: 'uebox-media/i.png' }
    const context: Context = {
      systemPrompt: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: mediaRefText(imageRef) },
            { type: 'text', text: mediaRefText(REF) }
          ],
          timestamp: 1
        }
      ]
    }

    const out = replaceMediaRefs(context, new Set(['image']))
    const parts = (out.messages[0] as { content: Array<{ text: string }> }).content
    expect(parseMediaRef(parts[0].text)).toEqual(imageRef)
    expect(parts[1].text).toContain('当前模型收不了视频链接')
  })

  it('图片引用改写成 image_url 链接', async () => {
    const imageRef = { ...REF, kind: 'image' as const, key: 'uebox-media/i.png' }
    const rewritten = (await rewriteMediaInPayload(
      { messages: [{ role: 'user', content: [{ type: 'text', text: mediaRefText(imageRef) }] }] },
      { urlFor: async (key) => `https://b/${key}`, isRemoved: async () => false }
    )) as { messages: Array<{ content: unknown[] }> }

    expect(rewritten.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'https://b/uebox-media/i.png' } }
    ])
  })
})

describe('preparePromptImages：先走对象存储，走不通再 base64', () => {
  const PNG = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }
  const JPG = { type: 'image' as const, data: 'd29ybGQ=', mimeType: 'image/jpeg' }
  const MODEL = { providerId: 'p', modelId: 'm' }

  function imageDeps(
    overrides: Partial<NonNullable<Parameters<typeof preparePromptImages>[2]>> = {}
  ): NonNullable<Parameters<typeof preparePromptImages>[2]> {
    return {
      isReady: async () => true,
      canSend: async () => true,
      save: async (image) => `C:/tmp/${image.mimeType === 'image/png' ? 'a.png' : 'b.jpg'}`,
      upload: async (filePath) => ({ key: `uebox-media/${filePath.slice(-5)}` }),
      ...overrides
    }
  }

  it('都走得通：全部变成引用，base64 一张不留', async () => {
    const result = await preparePromptImages([PNG, JPG], MODEL, imageDeps())
    expect(result.refs.map((ref) => ref.kind)).toEqual(['image', 'image'])
    expect(result.inline).toEqual([])
  })

  it('没配存储：原样交回 base64，不落盘不上传', async () => {
    const upload = vi.fn()
    const result = await preparePromptImages(
      [PNG],
      MODEL,
      imageDeps({ isReady: async () => false, upload })
    )
    expect(result).toEqual({ refs: [], inline: [PNG] })
    expect(upload).not.toHaveBeenCalled()
  })

  it('模型收不了图片链接：原样交回 base64', async () => {
    const result = await preparePromptImages(
      [PNG],
      MODEL,
      imageDeps({ canSend: async () => false })
    )
    expect(result).toEqual({ refs: [], inline: [PNG] })
  })

  it('一张传失败只退这一张，不连累别的', async () => {
    const result = await preparePromptImages(
      [PNG, JPG],
      MODEL,
      imageDeps({
        upload: async (filePath) => {
          if (filePath.endsWith('.jpg')) throw new Error('网断了')
          return { key: 'uebox-media/a.png' }
        }
      })
    )
    expect(result.refs.map((ref) => ref.key)).toEqual(['uebox-media/a.png'])
    expect(result.inline).toEqual([JPG])
  })

  it('判断本身出错（设置读不出来）也退回 base64，不打断这一轮', async () => {
    const result = await preparePromptImages(
      [PNG],
      MODEL,
      imageDeps({
        canSend: async () => {
          throw new Error('models.json 坏了')
        }
      })
    )
    expect(result).toEqual({ refs: [], inline: [PNG] })
  })

  it('落不了盘也退回 base64', async () => {
    const result = await preparePromptImages([PNG], MODEL, imageDeps({ save: async () => null }))
    expect(result).toEqual({ refs: [], inline: [PNG] })
  })
})
