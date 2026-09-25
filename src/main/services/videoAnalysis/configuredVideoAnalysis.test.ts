/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderSettings } from '../../ai/types'

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  resolveApiKey: vi.fn()
}))

vi.mock('../../ai/store', () => ({ readSettings: mocks.readSettings }))
vi.mock('../../ai/credentials', () => ({ resolveApiKey: mocks.resolveApiKey }))

const { analyzeVideoWithConfiguredModel, findConfiguredVideoModel, parseChatCompletion } =
  await import('./configuredVideoAnalysis')

const settings = (supportsVideo = true): AiProviderSettings => ({
  version: 2,
  providers: [
    {
      id: 'alibaba',
      displayName: '阿里云百炼',
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: { kind: 'literal', id: 'provider:alibaba' },
      models: [{ id: 'qwen3.5-omni-plus', supportsVideo }]
    }
  ],
  roles: {}
})

beforeEach(() => {
  vi.unstubAllGlobals()
  mocks.readSettings.mockReset()
  mocks.resolveApiKey.mockReset()
  mocks.readSettings.mockResolvedValue(settings())
  mocks.resolveApiKey.mockResolvedValue('test-key')
})

describe('配置的视频模型', () => {
  it('只认显式勾选 supportsVideo 的模型', () => {
    expect(findConfiguredVideoModel(settings(false))).toBeNull()
    expect(findConfiguredVideoModel(settings())?.model.id).toBe('qwen3.5-omni-plus')
  })

  it('把本地视频按 OpenAI 兼容的 video_url 格式发给已配置模型', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"视频摘要"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await analyzeVideoWithConfiguredModel({ data: 'AAAA', mimeType: 'video/mp4' })

    expect(result).toMatchObject({ success: true, markdown: '视频摘要', content: '视频摘要' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('qwen3.5-omni-plus')
    expect(body.messages[0].content[0]).toEqual({
      type: 'video_url',
      video_url: { url: 'data:video/mp4;base64,AAAA' }
    })
    expect(body.modalities).toEqual(['text'])
  })

  it('没有视频模型时返回 null，由调用方提示配置', async () => {
    mocks.readSettings.mockResolvedValue(settings(false))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(
      await analyzeVideoWithConfiguredModel({ data: 'AAAA', mimeType: 'video/mp4' })
    ).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('能合并 OpenAI 流式响应里的多个文本分片', () => {
    expect(
      parseChatCompletion(
        'data: {"choices":[{"delta":{"content":"片段一"}}]}\n' +
          'data: {"choices":[{"delta":{"content":"片段二"}}]}\n' +
          'data: [DONE]\n'
      )
    ).toBe('片段一片段二')
  })
})

it.each(['openai-completions', 'google-generative-ai'] as const)(
  '按 %s 协议发送视频字节，保留问题和模型信息',
  async (protocol) => {
    const config = settings()
    config.providers[0].protocol = protocol
    mocks.readSettings.mockResolvedValue(config)
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify(
            protocol === 'openai-completions'
              ? { choices: [{ message: { content: '摘要' } }] }
              : { candidates: [{ content: { parts: [{ text: '摘要' }] } }] }
          )
        )
      )
    vi.stubGlobal('fetch', fetchMock)
    const result = await analyzeVideoWithConfiguredModel({
      data: 'BBBB',
      mimeType: 'video/mp4',
      prompt: '镜头如何运动'
    })
    expect(result).toMatchObject({ success: true, model: '阿里云百炼:qwen3.5-omni-plus' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    if (protocol === 'openai-completions') {
      expect(body.messages[0].content).toEqual([
        { type: 'video_url', video_url: { url: 'data:video/mp4;base64,BBBB' } },
        { type: 'text', text: '镜头如何运动' }
      ])
    } else {
      expect(body.contents[0].parts).toEqual([
        { inlineData: { mimeType: 'video/mp4', data: 'BBBB' } },
        { text: '镜头如何运动' }
      ])
    }
  }
)

/**
 * 远端地址不能转手给厂商去 fetch：B 站直链要 Referer，Gemini 的 fileUri 只认
 * Files API 和 YouTube。所以这里只收字节，拿不到内容就当场说清楚。
 */
it('没有视频内容时直接报错，不发请求', async () => {
  mocks.readSettings.mockResolvedValue(settings())
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  expect(await analyzeVideoWithConfiguredModel({ data: '', mimeType: 'video/mp4' })).toMatchObject({
    success: false,
    error: '没有拿到视频内容'
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('远端报 Param Incorrect 时把 param、code 和状态码一起带出来', async () => {
  mocks.readSettings.mockResolvedValue(settings())
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: '400',
            message: 'Param Incorrect',
            param: 'failed to download or process media content'
          }
        }),
        { status: 400 }
      )
    )
  )
  const result = await analyzeVideoWithConfiguredModel({ data: 'AAAA', mimeType: 'video/mp4' })
  expect(result?.success).toBe(false)
  expect(result?.error).toContain('HTTP 400: Param Incorrect')
  expect(result?.error).toContain('failed to download or process media content')
})
