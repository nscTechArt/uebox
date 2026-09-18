/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, params: Record<string, unknown>) => Promise<unknown>>()
)
const complete = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, params: Record<string, unknown>) => Promise<unknown>
    ) => handlers.set(channel, handler)
  }
}))

vi.mock('../ai/imageGeneration', () => ({
  generateImages: vi.fn(),
  getImageModelStatus: vi.fn()
}))
vi.mock('../ai/messageConverter', () => ({
  convertToPiMessages: (messages: unknown[]) => messages,
  extractSystemPrompt: () => undefined,
  messagesHaveImages: () => false
}))
/** 能力表要读 baseUrl 与 models，绑定按真实形状给 */
const provider = {
  id: 'my-gateway',
  baseUrl: 'https://gateway.example.com/v1',
  models: [{ id: 'qwen-max' }]
}

vi.mock('../ai/piCompletion', () => ({
  complete,
  streamText: vi.fn(),
  resolveBinding: async () => ({
    provider: {
      id: 'my-gateway',
      baseUrl: 'https://gateway.example.com/v1',
      models: [{ id: 'qwen-max' }]
    },
    modelId: 'qwen-max',
    role: 'chat'
  })
}))

const { registerAiIPC } = await import('./ai')
const { resetLearnedStructuredOutput } = await import('../ai/structuredOutput')
registerAiIPC()

/** 内核那边回的样子：正文在 content 里，用量是 pi 的 Usage 形状 */
function assistantReply(text: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  }
}

beforeEach(() => {
  complete.mockReset()
  // 能力是在运行中学到的，不清掉的话上一个用例的降级结论会漏给下一个
  resetLearnedStructuredOutput()
})

/**
 * 渲染层沿用 OpenAI 的 `response_format` 词汇提结构化输出的要求。
 *
 * 内核没有「结构化输出」这个抽象，但它的 `samplingParams` 会把字段原样并进
 * 请求体（OpenAI 兼容那几家会读，别家忽略）—— 而 `response_format` 本来就是
 * OpenAI 的词汇，透传正好。不透传的表现不是报错，是模型开始回散文，
 * 而渲染层那边等着解析 JSON。
 */
describe('ai:chat-completion 的结构化输出要求', () => {
  it('response_format 原样透传给厂商', async () => {
    complete.mockResolvedValue(assistantReply('{"followUps":["继续展开"]}'))

    const schema = {
      type: 'object',
      properties: { followUps: { type: 'array', items: { type: 'string' } } }
    }
    const result = await handlers.get('ai:chat-completion')!(
      {},
      {
        messages: [],
        responseFormat: { type: 'json_schema', json_schema: { name: 'follow_ups', schema } }
      }
    )

    expect(complete).toHaveBeenCalledWith(
      provider,
      'qwen-max',
      expect.objectContaining({
        samplingParams: {
          response_format: { type: 'json_schema', json_schema: { name: 'follow_ups', schema } }
        }
      })
    )
    expect(result).toMatchObject({
      success: true,
      data: { content: '{"followUps":["继续展开"]}' }
    })
  })

  it('简写的 json_object 补成完整形状再发', async () => {
    complete.mockResolvedValue(assistantReply('{}'))

    await handlers.get('ai:chat-completion')!({}, { messages: [], responseFormat: 'json_object' })

    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ samplingParams: { response_format: { type: 'json_object' } } })
    )
  })

  it('没提要求时不发 samplingParams', async () => {
    complete.mockResolvedValue(assistantReply('好的'))

    await handlers.get('ai:chat-completion')!({}, { messages: [] })

    expect(complete.mock.calls[0][2]).not.toHaveProperty('samplingParams')
  })

  /**
   * 厂商不认这个字段时会照着提示词回一段可解析文本，渲染层一直是宽容解析。
   * 这里的要求只有一条：**原文原样交出去**，别替模型编一个格式。
   */
  it('模型回的是散文时原样交给渲染层兜底', async () => {
    complete.mockResolvedValue(assistantReply('1. 继续展开\n2. 给个示例'))

    const result = await handlers.get('ai:chat-completion')!(
      {},
      { messages: [], responseFormat: { type: 'json_schema', json_schema: { schema: {} } } }
    )

    expect(result).toMatchObject({
      success: true,
      data: { content: '1. 继续展开\n2. 给个示例' }
    })
  })

  it('用量按内核报的口径回给界面', async () => {
    complete.mockResolvedValue(assistantReply('好的'))

    const result = await handlers.get('ai:chat-completion')!({}, { messages: [] })

    expect(result).toMatchObject({
      success: true,
      data: { usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }
    })
  })

  /**
   * DeepSeek 只认 json_object。以前这里是原样透传，用户每次都白挨一个 400、
   * 追问建议恒为空 —— 而且界面上什么都不显示，只有控制台里有一行 error。
   */
  it('厂商说不认 json_schema 时降到 json_object 重来，并把 schema 写进提示词', async () => {
    complete
      .mockRejectedValueOnce(
        new Error('400: {"message":"This response_format type is unavailable now"}')
      )
      .mockResolvedValueOnce(assistantReply('{"followUps":["继续展开"]}'))

    const schema = { type: 'object', properties: { followUps: { type: 'array' } } }
    const result = await handlers.get('ai:chat-completion')!(
      {},
      {
        messages: [],
        responseFormat: { type: 'json_schema', json_schema: { name: 'follow_ups', schema } }
      }
    )

    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1][2]).toMatchObject({
      samplingParams: { response_format: { type: 'json_object' } }
    })
    // 降档不是放弃约束：schema 原文进提示词，而且顺带满足 DeepSeek
    // 「提示词里必须出现 json」那条硬规则
    expect(complete.mock.calls[1][2].system).toContain('json')
    expect(complete.mock.calls[1][2].system).toContain('followUps')
    expect(result).toMatchObject({ success: true, data: { content: '{"followUps":["继续展开"]}' } })
  })

  it('降到 json_object 还被拒就完全不发这个字段', async () => {
    complete
      .mockRejectedValueOnce(new Error('response_format is not supported'))
      .mockRejectedValueOnce(new Error('response_format is not supported'))
      .mockResolvedValueOnce(assistantReply('1. 继续展开'))

    const result = await handlers.get('ai:chat-completion')!(
      {},
      { messages: [], responseFormat: { type: 'json_schema', json_schema: { schema: {} } } }
    )

    expect(complete).toHaveBeenCalledTimes(3)
    expect(complete.mock.calls[2][2]).not.toHaveProperty('samplingParams')
    expect(result).toMatchObject({ success: true, data: { content: '1. 继续展开' } })
  })

  it('学到的能力当次运行记住：下一次调用直接从降好的档发', async () => {
    complete
      .mockRejectedValueOnce(
        new Error('400: {"message":"This response_format type is unavailable now"}')
      )
      .mockResolvedValue(assistantReply('{}'))

    const args = {
      messages: [],
      responseFormat: { type: 'json_schema', json_schema: { schema: {} } }
    }
    await handlers.get('ai:chat-completion')!({}, args)
    await handlers.get('ai:chat-completion')!({}, args)

    // 第一次两发（挨了一个 400），第二次只发一次，且一上来就是 json_object
    expect(complete).toHaveBeenCalledTimes(3)
    expect(complete.mock.calls[2][2]).toMatchObject({
      samplingParams: { response_format: { type: 'json_object' } }
    })
  })

  it('不是格式问题的报错不重试', async () => {
    complete.mockRejectedValue(new Error('余额不足'))

    const result = await handlers.get('ai:chat-completion')!(
      {},
      { messages: [], responseFormat: { type: 'json_schema', json_schema: { schema: {} } } }
    )

    expect(complete).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: false, error: '余额不足' })
  })

  it('模型调用失败时回 success:false 而不是抛到 IPC 外面', async () => {
    complete.mockRejectedValue(new Error('密钥无效'))

    expect(await handlers.get('ai:chat-completion')!({}, { messages: [] })).toEqual({
      success: false,
      error: '密钥无效'
    })
  })
})
