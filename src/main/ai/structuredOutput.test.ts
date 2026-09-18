/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  degradeStructuredOutputApi,
  isStructuredOutputRejection,
  planStructuredOutput,
  resetLearnedStructuredOutput,
  resolveStructuredOutputApi,
  runWithStructuredOutput,
  withSystemHint,
  type ResponseFormatRequest
} from './structuredOutput'
import type { ModelConfig, ProviderConfig } from './types'

function providerOf(baseUrl: string, models: ModelConfig[] = []): ProviderConfig {
  return {
    id: 'p',
    displayName: 'P',
    kind: 'chat',
    protocol: 'openai-completions',
    baseUrl,
    apiKey: { kind: 'none' },
    models
  }
}

const SCHEMA_FORMAT: ResponseFormatRequest = {
  type: 'json_schema',
  json_schema: { name: 'follow_ups', schema: { type: 'object', required: ['followUps'] } }
}

beforeEach(() => {
  resetLearnedStructuredOutput()
})

/**
 * 能力表只写**厂商的硬规则**：DeepSeek 官方文档只有 json_object 一种模式，
 * 给它 json_schema 是一句 400，不是「回得差一点」。
 */
describe('能力表', () => {
  it('DeepSeek 官方地址只到 json_object', () => {
    expect(resolveStructuredOutputApi(providerOf('https://api.deepseek.com/v1'), 'anything')).toBe(
      'json-object'
    )
  })

  it('聚合网关上的 DeepSeek 按模型名认出来', () => {
    const gateway = providerOf('https://openrouter.ai/api/v1')
    expect(resolveStructuredOutputApi(gateway, 'deepseek/deepseek-chat')).toBe('json-object')
    expect(resolveStructuredOutputApi(gateway, 'deepseek-ai/DeepSeek-V3')).toBe('json-object')
  })

  it('名字里带 deepseek 但不在开头的不算（别把 OpenAI 系误伤成低档）', () => {
    expect(
      resolveStructuredOutputApi(providerOf('https://api.openai.com/v1'), 'gpt-4o-deepseek-tuned')
    ).toBe('json-schema')
  })

  it('没有已知硬规则时按最强的一档发', () => {
    expect(resolveStructuredOutputApi(providerOf('https://api.openai.com/v1'), 'gpt-4o')).toBe(
      'json-schema'
    )
  })

  it('模型自己声明的能力盖过猜的', () => {
    const provider = providerOf('https://api.deepseek.com/v1', [
      { id: 'deepseek-chat', structuredOutputApi: 'json-schema' }
    ])
    expect(resolveStructuredOutputApi(provider, 'deepseek-chat')).toBe('json-schema')
  })
})

describe('这一档怎么发', () => {
  it('json-schema：原样发', () => {
    const plan = planStructuredOutput(SCHEMA_FORMAT, 'json-schema')
    expect(plan.samplingParams).toEqual({ response_format: SCHEMA_FORMAT })
    expect(plan.systemHint).toBeUndefined()
  })

  it('简写的 json_object 补成完整形状', () => {
    expect(planStructuredOutput('json_object', 'json-schema').samplingParams).toEqual({
      response_format: { type: 'json_object' }
    })
  })

  it('json-object：降成 json_object，schema 转成提示词', () => {
    const plan = planStructuredOutput(SCHEMA_FORMAT, 'json-object')
    expect(plan.samplingParams).toEqual({ response_format: { type: 'json_object' } })
    expect(plan.systemHint).toContain('followUps')
    // DeepSeek 的第二条硬规则：提示词里必须出现 “json”
    expect(plan.systemHint).toContain('json')
  })

  it('none：这个字段一个字都不发，只留提示词', () => {
    const plan = planStructuredOutput(SCHEMA_FORMAT, 'none')
    expect(plan.samplingParams).toBeUndefined()
    expect(plan.systemHint).toContain('json')
  })

  it('没提要求（或者要的就是 text）时什么都不加', () => {
    expect(planStructuredOutput(undefined, 'json-object')).toEqual({ api: 'json-object' })
    expect(planStructuredOutput('text', 'none')).toEqual({ api: 'none' })
  })

  it('提示词接在原系统提示词后面，原本没有就自己当系统提示词', () => {
    const plan = planStructuredOutput(SCHEMA_FORMAT, 'none')
    expect(withSystemHint('你是助手', plan)).toMatch(/^你是助手\n\n/)
    expect(withSystemHint(undefined, plan)).toBe(plan.systemHint)
    expect(withSystemHint('你是助手', { api: 'json-schema' })).toBe('你是助手')
  })
})

describe('认出「不认这个 response_format」的报错', () => {
  it.each([
    '400: {"message":"This response_format type is unavailable now"}',
    "Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'",
    'Invalid parameter: response_format',
    'json_schema is not supported by this model',
    '该模型不支持 response_format'
  ])('%s', (message) => {
    expect(isStructuredOutputRejection(message)).toBe(true)
  })

  it.each(['余额不足', '401 Unauthorized', 'context length exceeded', '模型 json 输出被截断'])(
    '不是这一类：%s',
    (message) => {
      expect(isStructuredOutputRejection(message)).toBe(false)
    }
  )
})

describe('降级链', () => {
  it('json-schema → json-object → 不发，到底就没有下一档', () => {
    expect(degradeStructuredOutputApi('json-schema')).toBe('json-object')
    expect(degradeStructuredOutputApi('json-object')).toBe('none')
    expect(degradeStructuredOutputApi('none')).toBeUndefined()
  })
})

describe('兜底降级', () => {
  const binding = { provider: providerOf('https://api.openai.com/v1'), modelId: 'gpt-4o' }
  const rejection = new Error('400: {"message":"This response_format type is unavailable now"}')

  it('被拒一次就降一档重来', async () => {
    const run = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValueOnce('ok')

    expect(await runWithStructuredOutput(binding, SCHEMA_FORMAT, run)).toBe('ok')
    expect(run.mock.calls[0][0].api).toBe('json-schema')
    expect(run.mock.calls[1][0].api).toBe('json-object')
  })

  it('学到的结论当次运行记住', async () => {
    await runWithStructuredOutput(
      binding,
      SCHEMA_FORMAT,
      vi.fn().mockRejectedValueOnce(rejection).mockResolvedValueOnce('ok')
    )

    const run = vi.fn().mockResolvedValue('ok')
    await runWithStructuredOutput(binding, SCHEMA_FORMAT, run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0].api).toBe('json-object')
  })

  it('三档都试过还失败就把最后那句报错交出去', async () => {
    const last = new Error('余额不足')
    const run = vi
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockRejectedValueOnce(rejection)
      .mockRejectedValueOnce(last)

    await expect(runWithStructuredOutput(binding, SCHEMA_FORMAT, run)).rejects.toBe(last)
    // 第三档本来就不发这个字段，再挨骂也不可能是它的问题，到此为止
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[2][0].samplingParams).toBeUndefined()
  })

  it('无关的报错原样抛出，不白花一次 token', async () => {
    const run = vi.fn().mockRejectedValue(new Error('余额不足'))

    await expect(runWithStructuredOutput(binding, SCHEMA_FORMAT, run)).rejects.toThrow('余额不足')
    expect(run).toHaveBeenCalledTimes(1)
  })

  /** 流式：已经吐给用户的字收不回来，重试会让同一段话接两遍 */
  it('调用方说不能重来时就不重来', async () => {
    const run = vi.fn().mockRejectedValue(rejection)

    await expect(
      runWithStructuredOutput(binding, SCHEMA_FORMAT, run, { canRetry: () => false })
    ).rejects.toBe(rejection)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('没提结构化输出要求时不重试（本来就没发这个字段）', async () => {
    const run = vi.fn().mockRejectedValue(rejection)

    await expect(runWithStructuredOutput(binding, undefined, run)).rejects.toBe(rejection)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
