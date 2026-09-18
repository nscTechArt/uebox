/** @vitest-environment node */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const settings = {
  version: 2 as const,
  providers: [
    {
      id: 'my-gateway',
      displayName: '我的网关',
      kind: 'chat' as const,
      protocol: 'openai-completions' as const,
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: { kind: 'none' as const },
      models: [{ id: 'qwen-max' }]
    }
  ],
  roles: {} as Record<string, { providerId: string; modelId: string }>
}

vi.mock('./store', () => ({ readSettings: async () => settings }))

/** 最近一次交给 pi 的调用参数 */
let lastCall: { model: unknown; context: unknown; options: unknown } | null = null
/** pi 会回的那条消息，按测试改写 */
let reply: Record<string, unknown> = {
  role: 'assistant',
  content: [{ type: 'text', text: '好的' }],
  stopReason: 'stop'
}
/** 流式时依次吐出的事件 */
let events: Array<Record<string, unknown>> = []

vi.mock('@earendil-works/pi-ai', () => ({
  contentText: (content: Array<{ text?: string }>) =>
    content.map((part) => part.text ?? '').join(''),
  createModels: () => ({
    setProvider: () => undefined,
    getModel: (provider: string, id: string) => ({ id, provider }),
    complete: async (model: unknown, context: unknown, options: unknown) => {
      lastCall = { model, context, options }
      return reply
    },
    stream: (model: unknown, context: unknown, options: unknown) => {
      lastCall = { model, context, options }
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event
        },
        result: async () => reply
      }
    }
  })
}))

vi.mock('../agent-v3/core/piModel', () => ({
  toPiProvider: (config: { id: string; models: Array<{ id: string }> }) => ({
    id: config.id,
    getModels: () => config.models.map((model) => ({ id: model.id, provider: config.id }))
  })
}))

const { complete, completeText, resolveBinding, streamText, userMessage } = await import(
  './piCompletion'
)
const { ModelNotConfiguredError } = await import('./resolveModel')

beforeEach(() => {
  settings.roles = { chat: { providerId: 'my-gateway', modelId: 'qwen-max' } }
  settings.providers[0].models = [{ id: 'qwen-max' }]
  lastCall = null
  events = []
  reply = { role: 'assistant', content: [{ type: 'text', text: '好的' }], stopReason: 'stop' }
})

describe('一问一答', () => {
  it('系统提示词与消息原样进 pi 的 Context', async () => {
    await completeText(settings.providers[0], 'qwen-max', {
      system: '你是布线器',
      messages: [userMessage('排一下版')]
    })

    expect(lastCall?.context).toEqual({
      systemPrompt: '你是布线器',
      messages: [{ role: 'user', content: '排一下版', timestamp: 0 }]
    })
  })

  /** 没有系统提示词就**不发这个字段**，而不是发一个空字符串顶上去 */
  it('没给 system 时不发 systemPrompt', async () => {
    await completeText(settings.providers[0], 'qwen-max', { messages: [userMessage('ping')] })

    expect(lastCall?.context).not.toHaveProperty('systemPrompt')
  })

  it('取的是正文，不含模型的思考内容', async () => {
    reply = {
      role: 'assistant',
      content: [
        { type: 'thinking', text: '让我想想……' },
        { type: 'text', text: '答案是 42' }
      ],
      stopReason: 'stop'
    }

    expect(
      await completeText(settings.providers[0], 'qwen-max', { messages: [userMessage('x')] })
    ).toBe('答案是 42')
  })

  /**
   * pi 失败时**不 reject**，而是回一条 stopReason: 'error' 的消息。
   * 不翻成异常的话，调用方拿到的是一条内容为空的「正常」回复 ——
   * 界面上是模型答了个空，真正的报错没人看得见。
   */
  it.each(['error', 'aborted'])('stopReason=%s 时抛错，而不是回一段空文本', async (stopReason) => {
    reply = { role: 'assistant', content: [], stopReason, errorMessage: '密钥无效' }

    await expect(
      completeText(settings.providers[0], 'qwen-max', { messages: [userMessage('x')] })
    ).rejects.toThrow('密钥无效')
  })

  it('厂商没给原因时也有一句能看的话', async () => {
    reply = { role: 'assistant', content: [], stopReason: 'error' }

    await expect(
      complete(settings.providers[0], 'qwen-max', { messages: [userMessage('x')] })
    ).rejects.toThrow(/模型调用失败/)
  })

  it('取消信号与温度透到 pi', async () => {
    const controller = new AbortController()
    await completeText(settings.providers[0], 'qwen-max', {
      messages: [userMessage('x')],
      signal: controller.signal,
      temperature: 0.2
    })

    expect(lastCall?.options).toMatchObject({ signal: controller.signal, temperature: 0.2 })
  })

  it('没给温度就不发这个字段，用模型自己的默认', async () => {
    await completeText(settings.providers[0], 'qwen-max', { messages: [userMessage('x')] })

    expect(lastCall?.options).not.toHaveProperty('temperature')
  })

  /**
   * 绑定的模型不在清单里（用户在设置页删了它）。按绑定现场造一个，让调用仍然
   * 打得出去 —— 厂商不认这个 id 会给出明确的报错，比在这里拦下更有诊断价值。
   */
  it('模型不在清单里时按绑定现场造一个，而不是直接失败', async () => {
    settings.providers[0].models = []

    await completeText(settings.providers[0], 'gone-model', { messages: [userMessage('x')] })

    expect(lastCall?.model).toMatchObject({ id: 'gone-model' })
  })
})

describe('流式', () => {
  it('逐段吐出新增文本', async () => {
    events = [
      { type: 'text_delta', delta: '你' },
      { type: 'thinking_delta', delta: '（先想想）' },
      { type: 'text_delta', delta: '好' }
    ]
    reply = { role: 'assistant', content: [{ type: 'text', text: '你好' }], stopReason: 'stop' }

    const chunks: string[] = []
    for await (const chunk of streamText(settings.providers[0], 'qwen-max', {
      messages: [userMessage('x')]
    })) {
      chunks.push(chunk)
    }

    // 思考增量不进正文：那是模型的自言自语，混进去就成了用户没要的推理过程
    expect(chunks).toEqual(['你', '好'])
  })

  /**
   * 有的 provider 只在结束时给全文、不发增量。不补的话用户看到的是一片空白，
   * 而且没有任何报错。
   */
  it('不发增量的厂商在收尾补齐全文', async () => {
    events = []
    reply = {
      role: 'assistant',
      content: [{ type: 'text', text: '一次性给完' }],
      stopReason: 'stop'
    }

    const chunks: string[] = []
    for await (const chunk of streamText(settings.providers[0], 'qwen-max', {
      messages: [userMessage('x')]
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(['一次性给完'])
  })

  it('流结束后失败同样抛错', async () => {
    events = [{ type: 'text_delta', delta: '半句' }]
    reply = { role: 'assistant', content: [], stopReason: 'error', errorMessage: '断了' }

    await expect(async () => {
      // 只关心最后抛不抛，中间吐了什么无所谓
      const stream = streamText(settings.providers[0], 'qwen-max', {
        messages: [userMessage('x')]
      })
      while (!(await stream.next()).done) {
        /* 读到底 */
      }
    }).rejects.toThrow('断了')
  })
})

describe('按角色找绑定', () => {
  it('回配置本身，交给 pi 去造模型', async () => {
    const binding = await resolveBinding({ role: 'chat' })

    expect(binding.provider.id).toBe('my-gateway')
    expect(binding.modelId).toBe('qwen-max')
  })

  it('没有任何绑定时报「还没配模型」，而不是静默用一个不存在的', async () => {
    settings.roles = {}

    await expect(resolveBinding({ role: 'chat' })).rejects.toBeInstanceOf(ModelNotConfiguredError)
  })

  it('绑定指向已删除的 Provider 时说清楚是哪一个', async () => {
    settings.roles = { chat: { providerId: 'gone', modelId: 'x' } }

    await expect(resolveBinding({ role: 'chat' })).rejects.toThrow(/gone/)
  })
})
