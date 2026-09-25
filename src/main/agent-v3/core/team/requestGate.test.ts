/** @vitest-environment node */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'

import {
  AdaptiveLimiter,
  DEFAULT_GATE_CONFIG,
  isOverloadError,
  pacedStreamFn,
  type GateConfig,
  type Outcome
} from './requestGate'

/**
 * 调度要回答的就一件事：几个队员同时请模型时，放几个出去、卡住了怎么办。
 * 起因是真机上三个请求被套餐网关挂了 5 分钟再一起掐断。
 */

const model = { id: 'm', api: 'openai-completions', provider: 'plan' } as unknown as Model<Api>

const message = (over: Partial<AssistantMessage> = {}): AssistantMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 0,
    ...over
  }) as AssistantMessage

/** 按脚本吐事件的假流：'hang' 表示从此不再吐 */
function scripted(steps: Array<AssistantMessageEvent | 'hang'>) {
  const stream = createAssistantMessageEventStream()
  void (async () => {
    for (const step of steps) {
      if (step === 'hang') return
      await Promise.resolve()
      stream.push(step)
    }
    stream.end()
  })()
  return stream
}

const ok: AssistantMessageEvent[] = [
  { type: 'start', partial: message() },
  { type: 'done', reason: 'stop', message: message() }
]
const overloaded: AssistantMessageEvent = {
  type: 'error',
  reason: 'error',
  error: message({ stopReason: 'error', errorMessage: '429 Too Many Requests' })
}

const fast: GateConfig = {
  ...DEFAULT_GATE_CONFIG,
  firstEventTimeoutMs: 40,
  firstEventTimeoutFloorMs: 40,
  firstEventTimeoutCeilMs: 40,
  idleTimeoutMs: 40,
  backoffBaseMs: 1,
  backoffCapMs: 2
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
  const types: string[] = []
  for await (const event of stream) {
    types.push(event.type === 'error' ? `error:${event.error.errorMessage}` : event.type)
  }
  return types
}

describe('AIMD 名额', () => {
  const release = async (limiter: AdaptiveLimiter, outcome: Outcome): Promise<void> => {
    const done = await limiter.acquire()
    done(outcome)
  }

  it('顺利就慢慢涨：每一轮全部成功约 +1', async () => {
    const limiter = new AdaptiveLimiter({ ...DEFAULT_GATE_CONFIG, initialLimit: 4 })
    for (let i = 0; i < 4; i++) await release(limiter, { kind: 'ok', firstEventMs: 1000 })
    expect(limiter.snapshot().limit).toBeGreaterThan(4.9)
    expect(limiter.snapshot().limit).toBeLessThan(5.1)
  })

  it('过载就砍半，不低于下限；并且进入冷却', async () => {
    let now = 0
    const limiter = new AdaptiveLimiter(
      { ...DEFAULT_GATE_CONFIG, initialLimit: 4 },
      () => now,
      () => 0
    )
    await release(limiter, { kind: 'overload' })
    expect(limiter.snapshot().limit).toBe(2)
    expect(limiter.snapshot().coolingDownMs).toBe(DEFAULT_GATE_CONFIG.backoffBaseMs / 2)
    for (let i = 0; i < 5; i++) {
      now += 60_000
      await release(limiter, { kind: 'overload' })
    }
    expect(limiter.snapshot().limit).toBe(DEFAULT_GATE_CONFIG.minLimit)
  })

  it('首包时间比基线慢三倍以上：还没报错也先收一点', async () => {
    const limiter = new AdaptiveLimiter({ ...DEFAULT_GATE_CONFIG, initialLimit: 8 })
    for (let i = 0; i < 5; i++) await release(limiter, { kind: 'ok', firstEventMs: 1000 })
    const before = limiter.snapshot().limit
    await release(limiter, { kind: 'ok', firstEventMs: 5000 })
    expect(limiter.snapshot().limit).toBeCloseTo(before * 0.9)
  })

  it('名额满了排队，放一个进一个；排队中被停下不占名额', async () => {
    const limiter = new AdaptiveLimiter({ ...DEFAULT_GATE_CONFIG, initialLimit: 1 })
    const first = await limiter.acquire()
    const controller = new AbortController()
    const cancelled = limiter.acquire(controller.signal)
    let secondIn = false
    const second = limiter.acquire().then((done) => {
      secondIn = true
      return done
    })
    controller.abort()
    await expect(cancelled).rejects.toBeTruthy()
    expect(secondIn).toBe(false)
    first({ kind: 'neutral' })
    ;(await second)({ kind: 'neutral' })
    expect(limiter.snapshot()).toMatchObject({ inFlight: 0, queued: 0 })
  })

  it('量出基线后，等首包的时间按基线放宽，夹在上下限之间', async () => {
    const limiter = new AdaptiveLimiter()
    expect(limiter.firstEventTimeout()).toBe(DEFAULT_GATE_CONFIG.firstEventTimeoutMs)
    await release(limiter, { kind: 'ok', firstEventMs: 20_000 })
    expect(limiter.firstEventTimeout()).toBe(120_000)
    await release(limiter, { kind: 'ok', firstEventMs: 1_000 })
    expect(limiter.firstEventTimeout()).toBe(DEFAULT_GATE_CONFIG.firstEventTimeoutFloorMs)
  })
})

describe('过载判断', () => {
  it.each([
    '429 Too Many Requests',
    '503 Service Unavailable',
    'net::ERR_CONNECTION_CLOSED',
    'read ECONNRESET',
    'socket hang up',
    '请求过于频繁，已触发限流'
  ])('算过载：%s', (text) => expect(isOverloadError(text)).toBe(true))

  it.each(['401 Unauthorized', '400 context length exceeded', 'Invalid API key'])(
    '不算过载：%s',
    (text) => expect(isOverloadError(text)).toBe(false)
  )
})

describe('调度包装', () => {
  const wrap = (inner: StreamFn, retries: number[] = []): StreamFn => {
    const limiter = new AdaptiveLimiter(fast)
    return pacedStreamFn(inner, {
      limiterFor: () => limiter,
      onRetry: ({ attempt }) => retries.push(attempt)
    })
  }

  it('第一下就被限流：退避后重发，调用方只看到成功那一次', async () => {
    const plans = [[overloaded], ok]
    const retries: number[] = []
    const paced = wrap(() => scripted(plans.shift()!), retries)
    expect(await collect(await paced(model, { messages: [] }))).toEqual(['start', 'done'])
    expect(retries).toEqual([1])
  })

  it('一直没有首包：到点放弃、重发', async () => {
    const plans: Array<Array<AssistantMessageEvent | 'hang'>> = [['hang'], ok]
    const paced = wrap(() => scripted(plans.shift()!))
    expect(await collect(await paced(model, { messages: [] }))).toEqual(['start', 'done'])
  })

  it('已经推过内容再断流：不重发（会重复开头），报一次失败', async () => {
    let calls = 0
    const paced = wrap(() => {
      calls++
      return scripted([{ type: 'start', partial: message() }, 'hang'])
    })
    const types = await collect(await paced(model, { messages: [] }))
    expect(calls).toBe(1)
    expect(types[0]).toBe('start')
    expect(types[1]).toMatch(/^error:.*没收完/)
  })

  it('和负载无关的失败原样交出去，不重发', async () => {
    let calls = 0
    const paced = wrap(() => {
      calls++
      return scripted([
        {
          type: 'error',
          reason: 'error',
          error: message({ stopReason: 'error', errorMessage: '401 Unauthorized' })
        }
      ])
    })
    expect(await collect(await paced(model, { messages: [] }))).toEqual(['error:401 Unauthorized'])
    expect(calls).toBe(1)
  })

  it('重发次数用完：报一句说得清原因的失败', async () => {
    const paced = wrap(() => scripted([overloaded]))
    const types = await collect(await paced(model, { messages: [] }))
    expect(types).toHaveLength(1)
    expect(types[0]).toMatch(/连续 5 次扛不住.*429/)
  })

  it('用户停下：不重发', async () => {
    const controller = new AbortController()
    let calls = 0
    const paced = wrap(() => {
      calls++
      controller.abort()
      return scripted([overloaded])
    })
    const types = await collect(await paced(model, { messages: [] }, { signal: controller.signal }))
    expect(calls).toBe(1)
    expect(types).toHaveLength(1)
    expect(types[0]).toMatch(/^error:/)
  })
})
