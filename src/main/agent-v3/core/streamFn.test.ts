/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 输入框里那个「思考程度」最终只落到一个地方：streamFn 传给 pi 的
 * `reasoning`。这条线断在任何一节，界面上的表现都一样 —— 选了没反应，
 * 而且没有任何提示。所以在这里钉住。
 */

const streamSimple = vi.fn()
const getSupportedThinkingLevels = vi.fn()
const PI_MODEL = { id: 'm1', provider: 'p', api: 'openai-codex-responses' }

vi.mock('@earendil-works/pi-ai', () => ({
  createModels: () => ({
    setProvider: vi.fn(),
    getModel: () => PI_MODEL,
    streamSimple
  }),
  getSupportedThinkingLevels: (model: unknown) => getSupportedThinkingLevels(model)
}))

vi.mock('./piModel', () => ({
  toPiProvider: () => ({ getModels: () => [PI_MODEL] })
}))

const readSettings = vi.fn()
// requestBudget 订阅 onSettingsChanged 来忘掉学到的上限，桩里也得有
vi.mock('../../ai/store', () => ({
  readSettings: () => readSettings(),
  onSettingsChanged: () => () => {}
}))

const { resolveAgentModel, listThinkingLevels, invalidateProviderCache } = await import(
  './streamFn'
)
const {
  DEFAULT_REQUEST_MAX_BYTES,
  budgetFor,
  __testing: __budgetTesting
} = await import('./requestBudget')

const SETTINGS = {
  version: 1 as const,
  providers: [
    {
      id: 'p',
      displayName: 'P',
      protocol: 'openai-codex-responses' as const,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: { kind: 'none' as const },
      models: [{ id: 'm1' }]
    }
  ],
  roles: { agent: { providerId: 'p', modelId: 'm1' } }
}

/** 跑一次 streamFn，把它实际传给 pi 的 options 还回来 */
async function optionsPassedToPi(
  thinkingLevel?: 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
): Promise<Record<string, unknown>> {
  const runtime = await resolveAgentModel({ role: 'agent' }, thinkingLevel)
  runtime.streamFn(PI_MODEL as never, { messages: [] }, undefined as never)
  return streamSimple.mock.calls.at(-1)?.[2] as Record<string, unknown>
}

beforeEach(() => {
  streamSimple.mockReset()
  getSupportedThinkingLevels.mockReset().mockReturnValue(['off', 'high', 'max'])
  readSettings.mockReset().mockResolvedValue(SETTINGS)
  // 模型集合按「配置内容」缓存，测试之间要清掉才不会互相串
  invalidateProviderCache()
})

/**
 * 界面上那个下拉列哪几档，取决于这里 —— 档位是模型自己声明的，
 * 我们只负责如实转达。写死一份清单会列出模型根本没有的档位。
 */
describe('listThinkingLevels', () => {
  it('如实报出内核给的档位，不自己加工', async () => {
    const options = await listThinkingLevels({ role: 'agent' })

    expect(options?.levels).toEqual(['off', 'high', 'max'])
    expect(options?.modelId).toBe('m1')
  })

  // 画个下拉而已，没配模型不该升级成一次报错弹窗
  it('模型没配好时回 null 而不是抛错', async () => {
    readSettings.mockResolvedValue({ ...SETTINGS, roles: {} })
    invalidateProviderCache()

    await expect(listThinkingLevels({ role: 'agent' })).resolves.toBeNull()
  })
})

describe('思考程度 → pi 的 reasoning', () => {
  /**
   * 八档全都要原样传下去，由内核按模型夹。
   *
   * `off` 特别容易漏：pi 的 `reasoning` 参数类型里没有它（类型比运行时契约窄），
   * 一不小心就会在转换时被当成「没选」丢掉 —— 表现是「不思考」这一档点了没反应。
   * `max` 同理，早期只列到 high 的实现会把它整个吞掉。
   */
  it.each([
    ['off', 'off'],
    ['minimal', 'minimal'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max']
  ])('选了 %s 就原样传下去', async (choice, expected) => {
    const options = await optionsPassedToPi(choice as 'low')
    expect(options.reasoning).toBe(expected)
  })

  /**
   * `auto` 是**不指定**，不是「最低」——请求里干脆不带这个字段。
   * 传成某个具体档位会悄悄改掉所有没动过这个开关的用户的行为。
   */
  it.each([['auto'], [undefined]])('%s 时完全不带 reasoning 字段', async (choice) => {
    const options = await optionsPassedToPi(choice as undefined)
    expect(options).not.toHaveProperty('reasoning')
  })

  // pi 的 Agent 每轮会带自己的 options（signal 之类），不能被覆盖掉
  it('保留 pi 自己传进来的 options', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' }, 'high')
    const signal = new AbortController().signal
    runtime.streamFn(PI_MODEL as never, { messages: [] }, { signal } as never)

    const options = streamSimple.mock.calls.at(-1)?.[2] as Record<string, unknown>
    expect(options.signal).toBe(signal)
    expect(options.reasoning).toBe('high')
  })
})

/**
 * 出口闸挂在这条 streamFn 上，理由和 reasoning 一样：**这是全应用唯一一条
 * 把请求交给厂商的路**。工具那边压没压是各管各的，这里是最后一道。
 */
describe('出口闸', () => {
  const bigImage = (kb: number): unknown => ({
    role: 'user',
    content: [{ type: 'image', data: 'A'.repeat(kb * 1024), mimeType: 'image/jpeg' }],
    timestamp: 0
  })

  /** 让 streamSimple 返回一个带 result() 的流，模拟厂商这一轮的结局 */
  function respondWith(final: { stopReason?: string; errorMessage?: string }): void {
    streamSimple.mockReturnValue({ result: () => Promise.resolve(final) })
  }

  beforeEach(() => __budgetTesting.resetObservedLimits())

  it('预算之内的请求原样发出去', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    const context = { messages: [bigImage(100)] }
    runtime.streamFn(PI_MODEL as never, context as never, undefined as never)

    expect(streamSimple.mock.calls.at(-1)?.[1]).toBe(context)
  })

  // 超预算的那一轮不该整个失败：丢最老的图，正在问的那张留着
  it('超预算时把最老的图换掉再发', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    const context = {
      messages: [bigImage(1600), bigImage(1600), bigImage(1600)]
    }
    runtime.streamFn(PI_MODEL as never, context as never, undefined as never)

    const sent = streamSimple.mock.calls.at(-1)?.[1] as { messages: unknown[] }
    expect(sent).not.toBe(context)
    expect(JSON.stringify(sent).length).toBeLessThan(JSON.stringify(context).length)
    // 原来那份一个字节都没动 —— 换个上限更宽的模型，那些图还要回来
    expect((context.messages[0] as { content: Array<{ type: string }> }).content[0].type).toBe(
      'image'
    )
  })

  /**
   * 各家网关的上限不公开，猜不准，所以从 413 里学。
   * 这一轮救不回来，但用户点「继续尝试」时已经按新预算投影了。
   */
  it('厂商退 413 就把这家的预算调低', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    respondWith({
      stopReason: 'error',
      errorMessage: '413 <html><head><title>413 Request Entity Too Large</title></head></html>'
    })

    runtime.streamFn(PI_MODEL as never, { messages: [bigImage(500)] } as never, undefined as never)
    await vi.waitFor(() => expect(budgetFor('p')).toBeLessThan(DEFAULT_REQUEST_MAX_BYTES))
  })

  // 别的错误和这件事无关，学错了会平白开始丢图
  it('别的错误不影响预算', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    respondWith({ stopReason: 'error', errorMessage: '401: {"error":{"message":"bad key"}}' })

    runtime.streamFn(PI_MODEL as never, { messages: [bigImage(500)] } as never, undefined as never)
    await Promise.resolve()

    expect(budgetFor('p')).toBe(DEFAULT_REQUEST_MAX_BYTES)
  })

  // 旁听是可选的：拿到一个没有 result() 的流也不能让这一轮发不出去
  it('流上没有 result() 时照常返回', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    streamSimple.mockReturnValue({ notAStream: true })

    expect(() =>
      runtime.streamFn(PI_MODEL as never, { messages: [] } as never, undefined as never)
    ).not.toThrow()
  })
})
