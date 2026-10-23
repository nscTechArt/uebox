import { describe, expect, it, vi } from 'vitest'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type TranscriptContext
} from '@earendil-works/pi-ai'

import {
  MIN_OUTPUT_TOKENS,
  OVERFLOW_SAFETY_TOKENS,
  outputRoomFor,
  overflowRecoveringStreamFn,
  parseOverflowNumbers
} from './contextOverflow'

/** 真机原话（DeepSeek V4，2026-10-18） */
const DEEPSEEK_OVERFLOW =
  '400: {"message":"This model\'s maximum context length is 1048576 tokens. However, you requested ' +
  '1289691 tokens (896475 in the messages, 393216 in the completion). Please reduce the length of ' +
  'the messages or completion."}'

const ANTHROPIC_OVERFLOW = 'prompt is too long: 213462 tokens > 200000 maximum'

const MODEL = {
  id: 'deepseek-v4-pro',
  api: 'openai-completions',
  provider: 'deepseek',
  contextWindow: 1_000_000,
  maxTokens: 393_216
} as unknown as Model<Api>

const CONTEXT = {
  messages: [{ role: 'user', content: '继续', timestamp: 0 }]
} as unknown as TranscriptContext

const message = (stopReason: 'stop' | 'error', errorMessage?: string): AssistantMessage => ({
  role: 'assistant',
  content: stopReason === 'stop' ? [{ type: 'text', text: '好' }] : [],
  api: MODEL.api,
  provider: MODEL.provider,
  model: MODEL.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: 0
})

/** 一条只推一个 error 的流 —— pi 在 HTTP 失败时就是这样 */
const failing = (errorMessage: string): ReturnType<typeof createAssistantMessageEventStream> => {
  const stream = createAssistantMessageEventStream()
  stream.push({ type: 'error', reason: 'error', error: message('error', errorMessage) })
  stream.end()
  return stream
}

const ok = (): ReturnType<typeof createAssistantMessageEventStream> => {
  const stream = createAssistantMessageEventStream()
  const done = message('stop')
  stream.push({ type: 'start', partial: done })
  stream.push({ type: 'done', reason: 'stop', message: done })
  stream.end()
  return stream
}

const collect = async (stream: AsyncIterable<{ type: string }>): Promise<string[]> => {
  const types: string[] = []
  for await (const event of stream) types.push(event.type)
  return types
}

describe('parseOverflowNumbers', () => {
  it('OpenAI 兼容：抠出上限和消息占的', () => {
    expect(parseOverflowNumbers(DEEPSEEK_OVERFLOW)).toEqual({ limit: 1_048_576, input: 896_475 })
  })

  it('Anthropic：prompt is too long', () => {
    expect(parseOverflowNumbers(ANTHROPIC_OVERFLOW)).toEqual({ limit: 200_000, input: 213_462 })
  })

  it('没有数字的报错什么都不抠', () => {
    expect(parseOverflowNumbers('Your input exceeds the context window of this model')).toEqual({})
  })
})

describe('outputRoomFor', () => {
  it('真实输入放得下：余量是上限 − 输入 − 安全余量', () => {
    expect(outputRoomFor({ limit: 1_048_576, input: 896_475 })).toBe(
      1_048_576 - 896_475 - OVERFLOW_SAFETY_TOKENS
    )
  })

  it('剩得太少（思考模型会被截断）、输入已超、缺数字，都不给，交给压缩', () => {
    expect(outputRoomFor({ limit: 100_000, input: 100_000 - MIN_OUTPUT_TOKENS })).toBeUndefined()
    expect(outputRoomFor({ limit: 200_000, input: 213_462 })).toBeUndefined()
    expect(outputRoomFor({ limit: 200_000 })).toBeUndefined()
  })
})

describe('overflowRecoveringStreamFn', () => {
  it('报错里的真实输入放得下：缩小输出上限重发，不压缩，调用方只看到成功', async () => {
    const inner = vi
      .fn<StreamFn>()
      .mockReturnValueOnce(failing(DEEPSEEK_OVERFLOW))
      .mockReturnValueOnce(ok())
    const compact = vi.fn()
    const stream = overflowRecoveringStreamFn(inner, { compact })

    const types = await collect(await stream(MODEL, CONTEXT, {}))

    expect(types).toEqual(['start', 'done'])
    expect(compact).not.toHaveBeenCalled()
    expect(inner).toHaveBeenCalledTimes(2)
    expect(inner.mock.calls[1][2]?.maxTokens).toBe(1_048_576 - 896_475 - OVERFLOW_SAFETY_TOKENS)
  })

  it('输入本身放不下：当场压缩，拿压完的消息重发', async () => {
    const compacted = [{ role: 'user', content: '【摘要】', timestamp: 0 }] as unknown as Message[]
    const inner = vi
      .fn<StreamFn>()
      .mockReturnValueOnce(failing(ANTHROPIC_OVERFLOW))
      .mockReturnValueOnce(ok())
    const compact = vi.fn(async () => compacted)
    const onRecover = vi.fn()
    const stream = overflowRecoveringStreamFn(inner, { compact, onRecover })

    const types = await collect(await stream(MODEL, CONTEXT, {}))

    expect(types).toEqual(['start', 'done'])
    expect(compact).toHaveBeenCalledTimes(1)
    expect(inner.mock.calls[1][1].messages).toBe(compacted)
    expect(onRecover).toHaveBeenCalledWith(expect.objectContaining({ action: 'compact' }))
  })

  it('压完还超、又缩不了输出：把厂商原话交给调用方，不无限重发', async () => {
    const inner = vi
      .fn<StreamFn>()
      .mockReturnValueOnce(failing(ANTHROPIC_OVERFLOW))
      .mockReturnValueOnce(failing(ANTHROPIC_OVERFLOW))
    const compact = vi.fn(async () => [] as Message[])
    const stream = overflowRecoveringStreamFn(inner, { compact })

    const result = await stream(MODEL, CONTEXT, {})

    expect(await collect(result)).toEqual(['error'])
    expect((await result.result()).errorMessage).toBe(ANTHROPIC_OVERFLOW)
    expect(inner).toHaveBeenCalledTimes(2)
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('压不动（返回 undefined）就直接报原话', async () => {
    const inner = vi.fn<StreamFn>().mockReturnValueOnce(failing(ANTHROPIC_OVERFLOW))
    const compact = vi.fn(async () => undefined)
    const stream = overflowRecoveringStreamFn(inner, { compact })

    expect(await collect(await stream(MODEL, CONTEXT, {}))).toEqual(['error'])
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('别的失败（鉴权、限流）原样放行，不碰', async () => {
    const inner = vi.fn<StreamFn>().mockReturnValueOnce(failing('401 invalid api key'))
    const compact = vi.fn()
    const stream = overflowRecoveringStreamFn(inner, { compact })

    expect(await collect(await stream(MODEL, CONTEXT, {}))).toEqual(['error'])
    expect(inner).toHaveBeenCalledTimes(1)
    expect(compact).not.toHaveBeenCalled()
  })
})
