/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CompletionRequest } from './piCompletion'
import type { ProviderConfig } from './types'

/**
 * 对话探测被拒时「换着发几次看哪种能通」。
 *
 * 这里不造任何一家厂商的报错原文 —— 端点只回一句不带原因的 400。
 * 结论必须来自「哪种形状通了」，而不是读报错猜：措辞各家不一样，背一家的台词换一家就失灵。
 */

/** 假端点：给定协议下收不收这个形状 */
type Accepts = (protocol: string, request: CompletionRequest) => boolean

let accepts: Accepts
const calls: { protocol: string; tools: boolean; thinking: boolean }[] = []

vi.mock('./piCompletion', () => ({
  userMessage: (text: string) => ({ role: 'user', content: text, timestamp: 0 }),
  completeText: vi.fn(),
  resolveModel: () => ({ model: { reasoning: true } }),
  complete: vi.fn(
    async (provider: ProviderConfig, _modelId: string, request: CompletionRequest) => {
      calls.push({
        protocol: provider.protocol,
        tools: Boolean(request.tools),
        thinking: Boolean(request.reasoning)
      })
      if (!accepts(provider.protocol, request)) throw new Error('400 Bad Request')
      return { content: [], stopReason: 'stop' }
    }
  )
}))

const { testProvider } = await import('./probe')

const provider: ProviderConfig = {
  id: 'relay',
  displayName: '某中转',
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: 'https://relay.example/v1',
  apiKey: { kind: 'none' },
  models: [{ id: 'thinker', supportsTools: true }]
}

beforeEach(() => {
  calls.length = 0
})

describe('对话探测被拒时换着试', () => {
  it('一次就通的不多发', async () => {
    accepts = () => true
    expect(await testProvider(provider, 'thinker')).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ tools: true, thinking: true })
  })

  it('换协议就通 → 让用户改协议，什么能力都不丢', async () => {
    accepts = (protocol) => protocol === 'openai-responses'
    const result = await testProvider(provider, 'thinker')
    expect(result).toEqual({
      ok: false,
      error: { code: 'protocolMismatch', suggestedProtocol: 'openai-responses' }
    })
  })

  it('两个协议都不收「工具 + 思考」、去掉思考就通 → 算能用，只提示开思考会被拒', async () => {
    accepts = (_protocol, request) => !(request.tools && request.reasoning)
    expect(await testProvider(provider, 'thinker')).toEqual({
      ok: true,
      caveat: 'thinkingRejected'
    })
  })

  it('只有什么都不带才通 → 接不了工具', async () => {
    accepts = (_protocol, request) => !request.tools
    const result = await testProvider(provider, 'thinker')
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('toolsRejected')
  })

  it('怎么换都不通 → 原样报第一次的错', async () => {
    accepts = () => false
    const result = await testProvider(provider, 'thinker')
    expect(result.error?.code).toBe('badRequest')
  })

  it('不是 400（密钥错、超时）不换着试，多发只是白等', async () => {
    const { complete } = await import('./piCompletion')
    vi.mocked(complete).mockRejectedValueOnce(new Error('401 Unauthorized'))
    const result = await testProvider(provider, 'thinker')
    expect(result.error?.code).toBe('unauthorized')
    // 第一次被 mockRejectedValueOnce 接走；之后再发就会记进 calls
    expect(calls).toHaveLength(0)
  })

  it('不在可互换名单里的协议不乱换', async () => {
    accepts = (_protocol, request) => !request.reasoning
    await testProvider({ ...provider, protocol: 'anthropic-messages' }, 'thinker')
    expect(calls.every((call) => call.protocol === 'anthropic-messages')).toBe(true)
  })
})
