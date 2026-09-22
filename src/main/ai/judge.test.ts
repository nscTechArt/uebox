/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  confidentChoice,
  confidentScore,
  isYes,
  judge,
  judgeAvailable,
  payloadTooLarge,
  requestJudgement,
  systemOneUrl
} from './judge'
import { readSettings } from './store'
import type { ProviderConfig } from './types'

vi.mock('./credentials', () => ({ resolveApiKey: vi.fn(async () => 'test-judge-key') }))
vi.mock('./store', () => ({ readSettings: vi.fn() }))

const provider: ProviderConfig = {
  id: 'typesafe',
  displayName: 'TypeSafe',
  kind: 'judge',
  protocol: 'openai-completions',
  baseUrl: 'https://api.typesafe.ai/v1',
  apiKey: { kind: 'literal', id: 'k1' },
  models: [{ id: 'jev-latest' }]
}

/** 让 readSettings 回一份绑了判定角色的配置 */
function bindJudge(): void {
  vi.mocked(readSettings).mockResolvedValue({
    version: 2,
    providers: [provider],
    roles: { judge: { providerId: 'typesafe', modelId: 'jev-latest' } }
  })
}

const okBody = {
  model: 'jev-1.13.0',
  answers: { same_attempt: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 296, output_tokens: 20 }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('systemOneUrl', () => {
  it('末尾斜杠有没有都拼成同一个地址', () => {
    expect(systemOneUrl('https://api.typesafe.ai/v1')).toBe('https://api.typesafe.ai/v1/systemone')
    expect(systemOneUrl('https://api.typesafe.ai/v1///')).toBe(
      'https://api.typesafe.ai/v1/systemone'
    )
  })
})

describe('requestJudgement', () => {
  it('按厂商的线格式发 state + questions，带上 Bearer', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(okBody)))
    vi.stubGlobal('fetch', fetcher)

    const result = await requestJudgement(
      provider,
      'jev-latest',
      { tool: 'ue_delete_actor' },
      {
        same_attempt: { type: 'noul', instructions: 'Is this the same attempt?' }
      }
    )

    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(options.headers).toMatchObject({ Authorization: 'Bearer test-judge-key' })
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'jev-latest',
      state: { tool: 'ue_delete_actor' },
      questions: { same_attempt: { type: 'noul', instructions: 'Is this the same attempt?' } }
    })
    // model 用厂商回的那个，不是我们发的别名 —— 绑 jev-latest 时这两个不一样，
    // 而排查一次可疑判定时要知道到底是哪个版本答的
    expect(result.model).toBe('jev-1.13.0')
    expect(result.answers.same_attempt).toEqual({ type: 'noul', noul: 0.93 })
  })

  it('非 2xx 时抛出厂商原话，而不是一句 HTTP 4xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: 'score criteria must have 2+ levels' } }),
            {
              status: 422
            }
          )
      )
    )
    await expect(
      requestJudgement(provider, 'jev-latest', 'x', { q: { type: 'noul', instructions: 'y' } })
    ).rejects.toThrow('score criteria must have 2+ levels')
  })

  it('2xx 但没有 answers 也算失败 —— 半个响应比没有响应更危险', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ model: 'jev-1.13.0' })))
    )
    await expect(
      requestJudgement(provider, 'jev-latest', 'x', { q: { type: 'noul', instructions: 'y' } })
    ).rejects.toThrow(/HTTP/)
  })

  it('调用方取消时穿透到这次请求', async () => {
    const controller = new AbortController()
    // 和真 fetch 一样：signal 已经 abort 了就立刻拒绝，不是挂着等下一次事件
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) return reject(new Error('aborted'))
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    vi.stubGlobal('fetch', fetcher)

    const pending = requestJudgement(
      provider,
      'jev-latest',
      'x',
      { q: { type: 'noul', instructions: 'y' } },
      10_000,
      controller.signal
    )
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })
})

describe('judge —— 热路径契约：永远不抛', () => {
  it('没绑判定角色时回 null，且一个请求都不发', async () => {
    vi.mocked(readSettings).mockResolvedValue({ version: 2, providers: [provider], roles: {} })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)

    expect(await judge('x', { q: { type: 'noul', instructions: 'y' } })).toBeNull()
    expect(await judgeAvailable()).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('绑的 provider 已经被删掉时回 null，不是崩', async () => {
    vi.mocked(readSettings).mockResolvedValue({
      version: 2,
      providers: [],
      roles: { judge: { providerId: 'typesafe', modelId: 'jev-latest' } }
    })
    expect(await judge('x', { q: { type: 'noul', instructions: 'y' } })).toBeNull()
  })

  it('网络失败回 null 并把原因交给 onError，调用方据此走回落', async () => {
    bindJudge()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed')
      })
    )
    const onError = vi.fn()
    expect(await judge('x', { q: { type: 'noul', instructions: 'y' } }, { onError })).toBeNull()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('请求体超限时本地就回落，不发出去换一个 400', async () => {
    bindJudge()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)

    const huge = 'x'.repeat(60_000)
    expect(payloadTooLarge(huge, { q: { type: 'noul', instructions: 'y' } })).toBe(true)
    expect(await judge(huge, { q: { type: 'noul', instructions: 'y' } })).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('成功时原样透出 answers', async () => {
    bindJudge()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(okBody)))
    )
    const result = await judge('x', { same_attempt: { type: 'noul', instructions: 'y' } })
    expect(result?.answers.same_attempt).toEqual({ type: 'noul', noul: 0.93 })
    expect(await judgeAvailable()).toBe(true)
  })
})

describe('读答案的小工具', () => {
  it('isYes 按调用方给的阈值判，类型不对一律 false', () => {
    const answer = { type: 'noul', noul: 0.8 } as const
    expect(isYes(answer, 0.75)).toBe(true)
    expect(isYes(answer, 0.9)).toBe(false)
    expect(isYes(undefined, 0.1)).toBe(false)
    // 多选题的答案不能当是非题读 —— 没有 noul 这个字段，真读成了就是 undefined >= x
    expect(isYes({ type: 'choice', choice: 'a', probabilities: {}, confidence: 1 }, 0.1)).toBe(
      false
    )
  })

  it('confidentChoice 分布不够集中时回 null，而不是那个看起来像答案的 choice', () => {
    const unsure = {
      type: 'choice',
      choice: 'a',
      probabilities: { a: 0.34, b: 0.33, c: 0.33 },
      confidence: 0.01
    } as const
    const sure = {
      type: 'choice',
      choice: 'a',
      probabilities: { a: 0.95, b: 0.03, c: 0.02 },
      confidence: 0.93
    } as const
    expect(confidentChoice(unsure, 0.9)).toBeNull()
    expect(confidentChoice(sure, 0.9)).toBe('a')
  })

  it('confidentScore 同理，且 0 档不会被当成「没答案」', () => {
    const lowest = { type: 'score', score: 0, probabilities: {}, confidence: 0.99 } as const
    expect(confidentScore(lowest, 0.9)).toBe(0)
    expect(confidentScore(lowest, 0.999)).toBeNull()
  })
})
