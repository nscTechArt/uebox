/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  confidentBox,
  confidentChoice,
  confidentScore,
  isYes,
  judge,
  judgeAvailable,
  payloadTooLarge,
  requestJudgement,
  systemOneUrl
} from './judge'
import type { BoxAnswer, JudgeImageAsset, JudgeQuestion } from './judge'
import { findCatalogEntry } from './catalog'
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
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-judge-key')
    expect(new Headers(options.headers).has('TypeSafe-Danger-Zone-Images')).toBe(false)
    expect(new Headers(options.headers).has('TypeSafe-Danger-Zone-Long-Context')).toBe(false)
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

  // 「测试连接」按状态码分类；只带厂商原话的话密钥错、模型不存在全成了「未知错误」
  it('厂商原话和状态码一起带上', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 }))
    )
    await expect(
      requestJudgement(provider, 'jev-latest', 'x', { q: { type: 'noul', instructions: 'y' } })
    ).rejects.toThrow(/HTTP 401 Invalid token/)
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

describe('Jev 1.14 实验能力', () => {
  // 这里只验证传输；文件内容、像素尺寸是否合法由服务端解码检查。
  const assets: Record<string, JudgeImageAsset> = {
    'image-reference': { type: 'image', format: 'png', data_base64: 'aW1hZ2U=' }
  }
  const questions: Record<string, JudgeQuestion> = {
    visible: { type: 'noul', instructions: 'Is there a mug in `photo`?' },
    target: { type: 'box', instructions: 'The mug in `photo`.' }
  }
  const box: BoxAnswer = {
    type: 'box',
    box: { top: 0.2, bottom: 0.8, left: 0.1, right: 0.5 },
    confidence: 0.95
  }

  it('目录保留旧版本和稳定别名，提供 1.14 与预览入口', () => {
    expect(findCatalogEntry('typesafe')?.models.map((model) => model.id)).toEqual([
      'jev-latest',
      'jev-preview',
      'jev-1.14.0',
      'jev-1.13.0'
    ])
  })

  it('绑定入口发送图片和混合问题，保留结构化图像判据与实际模型版本', async () => {
    bindJudge()
    const mixed: Record<string, JudgeQuestion> = {
      ...questions,
      match: {
        type: 'choice',
        instructions: { ask: 'Match this: image-reference' },
        criteria: { same: { examples: ['image-reference'] }, other: null }
      },
      score: {
        type: 'score',
        instructions: 'Similarity?',
        criteria: ['Different', { example: 'image-reference' }]
      }
    }
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            model: 'jev-1.14.0',
            answers: { target: box, visible: { type: 'noul', noul: 0.99 } }
          })
        )
    )
    vi.stubGlobal('fetch', fetcher)
    const result = await judge({ photo: 'image-reference' }, mixed, { assets })
    const init = fetcher.mock.calls[0][1]
    expect(new Headers(init.headers).get('TypeSafe-Danger-Zone-Images')).toBe('true')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'jev-latest',
      state: { photo: 'image-reference' },
      questions: mixed,
      assets
    })
    expect(result?.model).toBe('jev-1.14.0')
    expect(confidentBox(result?.answers.target, 0.9, result?.answers.visible, 0.9)).toEqual(box.box)
  })

  it('1.13 也能传图，但拒绝 Box；缺图也不发 Box 请求', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(okBody)))
    vi.stubGlobal('fetch', fetcher)
    await requestJudgement(
      provider,
      'jev-1.13.0',
      'image-reference',
      { q: { type: 'noul', instructions: 'Is it visible?' } },
      undefined,
      undefined,
      { assets }
    )
    expect(fetcher).toHaveBeenCalledOnce()
    fetcher.mockClear()
    await expect(
      requestJudgement(provider, 'jev-1.13.0', 'image-reference', questions, undefined, undefined, {
        assets
      })
    ).rejects.toThrow('1.14')
    await expect(requestJudgement(provider, 'jev-1.14.0', 'x', questions)).rejects.toThrow('assets')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('长上下文只有显式开启才越过原字符预算，仍有本地上限', async () => {
    bindJudge()
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(okBody))
    )
    vi.stubGlobal('fetch', fetcher)
    const q = { q: { type: 'noul' as const, instructions: 'Is it true?' } }
    const onError = vi.fn()
    expect(await judge('x'.repeat(60_000), q, { onError })).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await judge('x'.repeat(60_000), q, { longContext: true })).not.toBeNull()
    expect(
      new Headers(fetcher.mock.calls[0][1].headers).get('TypeSafe-Danger-Zone-Long-Context')
    ).toBe('true')
    expect(await judge('x'.repeat(262_001), q, { longContext: true, onError })).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([{ assets }, { longContext: true }, { assets, longContext: true }])(
    '套餐判定不误发 TypeSafe 实验协议：%j',
    async (options) => {
      const fetcher = vi.fn()
      vi.stubGlobal('fetch', fetcher)
      await expect(
        requestJudgement(
          { ...provider, id: 'creator-plan-judge' },
          'uebox-judge',
          'x',
          { q: { type: 'noul', instructions: 'True?' } },
          undefined,
          undefined,
          options
        )
      ).rejects.toThrow('套餐判定接口不支持')
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it('图片参数错误、单图和总请求体超限都在本地失败', async () => {
    bindJudge()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const onError = vi.fn()
    for (const data_base64 of [
      'data:image/png;base64,aW1hZ2U=',
      '',
      'not base64',
      Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64')
    ]) {
      expect(
        await judge('image-reference', questions, {
          assets: { 'image-reference': { ...assets['image-reference'], data_base64 } },
          onError
        })
      ).toBeNull()
    }
    const large: JudgeImageAsset = {
      type: 'image',
      format: 'png',
      data_base64: Buffer.alloc(13 * 1024 * 1024).toString('base64')
    }
    expect(
      await judge(['first', 'second'], questions, {
        assets: { first: large, second: large },
        onError
      })
    ).toBeNull()
    expect(onError).toHaveBeenCalledTimes(5)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('厂商拒绝图片时仍回落，并保留失败原因', async () => {
    bindJudge()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Invalid image dimensions' }), { status: 400 })
      )
    )
    const onError = vi.fn()
    expect(await judge('image-reference', questions, { assets, onError })).toBeNull()
    expect(onError.mock.calls[0][0].message).toContain('Invalid image dimensions')
  })

  it('已有自定义请求头保留，图片开关不因大小写不同而重复', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(okBody))
    )
    vi.stubGlobal('fetch', fetcher)
    await requestJudgement(
      {
        ...provider,
        headers: {
          'X-Custom': 'keep',
          Authorization: 'Bearer custom-judge-key',
          'typesafe-danger-zone-images': 'false'
        }
      },
      'jev-1.14.0',
      'image-reference',
      questions,
      undefined,
      undefined,
      { assets }
    )
    const headers = new Headers(fetcher.mock.calls[0][1].headers)
    expect(headers.get('X-Custom')).toBe('keep')
    expect(headers.get('Authorization')).toBe('Bearer custom-judge-key')
    expect(headers.get('TypeSafe-Danger-Zone-Images')).toBe('true')
  })

  it('Box 必须同时满足存在性、置信度和坐标边界', () => {
    const present = { type: 'noul', noul: 0.99 } as const
    expect(confidentBox(box, 0.9, present, 0.9)).toEqual(box.box)
    expect(confidentBox(box, 0.9, { type: 'noul', noul: 0.01 }, 0.9)).toBeNull()
    expect(confidentBox(box, 0.9, undefined, 0.9)).toBeNull()
    expect(confidentBox(box, 0.99, present, 0.9)).toBeNull()
    expect(confidentBox(undefined, 0.9, present, 0.9)).toBeNull()
    for (const invalid of [
      { ...box, confidence: NaN },
      { ...box, confidence: 1.1 },
      { ...box, box: { ...box.box, left: -0.1 } },
      { ...box, box: { ...box.box, right: 1.1 } },
      { ...box, box: { ...box.box, top: NaN } },
      { ...box, box: { ...box.box, bottom: box.box.top } }
    ])
      expect(confidentBox(invalid, 0.9, present, 0.9)).toBeNull()
  })
})
