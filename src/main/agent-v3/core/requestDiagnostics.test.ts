import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  normalizeContext
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'

import { diagnosedStreamFn, formatRequestRecord, type RequestRecord } from './requestDiagnostics'

const model = {
  id: 'mimo-v2.6-flash',
  provider: 'mimo',
  api: 'openai-completions',
  baseUrl: 'https://api.example.com/v1?key=secret'
} as unknown as Model<Api>

function message(extra: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
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
    ...extra
  }
}

/**
 * 假的一次请求：先回响应头，再按剧本一格一格吐事件，每格让时钟走 `step` 毫秒。
 */
function scripted(
  clock: { t: number },
  events: AssistantMessageEvent[],
  step = 100
): { fn: StreamFn; sent: unknown[] } {
  const sent: unknown[] = []
  const fn: StreamFn = async (m, _context, options) => {
    await options?.onPayload?.({ messages: ['很长的对话'], key: 'sk-secret' }, m)
    clock.t += 50
    await options?.onResponse?.(
      {
        status: 200,
        headers: { 'x-request-id': 'req-123', authorization: 'Bearer sk-secret', 'set-cookie': 'a' }
      },
      m
    )
    // 拉一格走一格：时钟只在下游真来取的时候前进，时间点才是确定的
    const out = {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          clock.t += step
          sent.push(event)
          yield event
        }
      }
    }
    return out as unknown as Awaited<ReturnType<StreamFn>>
  }
  return { fn, sent }
}

async function drain(stream: Awaited<ReturnType<StreamFn>>): Promise<AssistantMessageEvent[]> {
  const seen: AssistantMessageEvent[] = []
  for await (const event of stream) seen.push(event)
  return seen
}

const partial = message({})
const text = (delta: string): AssistantMessageEvent => ({
  type: 'text_delta',
  contentIndex: 0,
  delta,
  partial
})

describe('diagnosedStreamFn', () => {
  it('成功的一次：时间点、大小、请求标识都记下，事件原样转发', async () => {
    const clock = { t: 1_000 }
    const records: RequestRecord[] = []
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      text('你'),
      text('好'),
      { type: 'done', reason: 'stop', message: message({ responseId: 'resp-9' }) }
    ]
    const { fn } = scripted(clock, events)
    const wrapped = diagnosedStreamFn(fn, {
      sessionId: 's1',
      resumeAttempt: () => 0,
      sink: (r) => records.push(r),
      now: () => clock.t
    })

    const seen = await drain(await wrapped(model, normalizeContext({ messages: [] }), {}))
    await Promise.resolve()

    expect(seen).toEqual(events)
    expect(records).toHaveLength(1)
    const [r] = records
    expect(r).toMatchObject({
      sessionId: 's1',
      provider: 'mimo',
      model: 'mimo-v2.6-flash',
      host: 'api.example.com',
      attempt: 1,
      resume: 0,
      responseMs: 50,
      firstContentMs: 250,
      lastContentMs: 350,
      endMs: 450,
      contentEvents: 2,
      status: 200,
      outcome: 'ok',
      responseId: 'resp-9',
      requestIds: { 'x-request-id': 'req-123' }
    })
    expect(r.payloadBytes).toBeGreaterThan(0)
  })

  it('吐到一半断开：记下断在第几毫秒、错误原文、走哪条路；不带密钥和对话', async () => {
    const clock = { t: 0 }
    const records: RequestRecord[] = []
    const { fn } = scripted(clock, [
      { type: 'start', partial },
      text('树的贴图路径'),
      {
        type: 'error',
        reason: 'error',
        error: message({
          stopReason: 'error',
          errorMessage: 'net::ERR_CONNECTION_CLOSED',
          responseId: 'resp-x'
        })
      }
    ])
    const wrapped = diagnosedStreamFn(fn, {
      sink: (r) => records.push(r),
      resumeAttempt: () => 1,
      describeRoute: async () => 'proxy (PROXY 127.0.0.1:7890)',
      now: () => clock.t
    })

    await drain(await wrapped(model, normalizeContext({ messages: [] }), {}))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(records[0]).toMatchObject({
      outcome: 'error',
      error: 'net::ERR_CONNECTION_CLOSED',
      firstContentMs: 250,
      endMs: 350,
      resume: 1,
      responseId: 'resp-x',
      route: 'proxy (PROXY 127.0.0.1:7890)'
    })
    const line = formatRequestRecord(records[0])
    expect(line.startsWith('[模型请求] {')).toBe(true)
    expect(line).not.toContain('sk-secret')
    expect(line).not.toContain('很长的对话')
    expect(line).not.toContain('key=secret')
  })

  it('同一个 context 再发一次 = 卡死重发的第二次尝试', async () => {
    const clock = { t: 0 }
    const records: RequestRecord[] = []
    const events: AssistantMessageEvent[] = [{ type: 'done', reason: 'stop', message: message({}) }]
    const wrapped = diagnosedStreamFn(scripted(clock, events).fn, {
      sink: (r) => records.push(r),
      now: () => clock.t
    })
    const context = normalizeContext({ messages: [] })

    await drain(await wrapped(model, context, {}))
    await drain(await wrapped(model, context, {}))
    await drain(await wrapped(model, normalizeContext({ messages: [] }), {}))
    await Promise.resolve()

    expect(records.map((r) => r.attempt)).toEqual([1, 2, 1])
  })

  it('原来挂着的 onPayload / onResponse 照常被调用，改写的请求体照常生效', async () => {
    const clock = { t: 0 }
    const seenPayloads: unknown[] = []
    const inner: StreamFn = async (m, _context, options) => {
      seenPayloads.push(await options?.onPayload?.({ a: 1 }, m))
      await options?.onResponse?.({ status: 200, headers: {} }, m)
      const out = createAssistantMessageEventStream()
      out.push({ type: 'done', reason: 'stop', message: message({}) })
      out.end()
      return out
    }
    let responded = 0
    const wrapped = diagnosedStreamFn(inner, { sink: () => {}, now: () => clock.t })

    await drain(
      await wrapped(model, normalizeContext({ messages: [] }), {
        onPayload: async () => ({ rewritten: true }),
        onResponse: () => {
          responded++
        }
      })
    )

    expect(seenPayloads).toEqual([{ rewritten: true }])
    expect(responded).toBe(1)
  })

  it('卡死检测掐掉的一次记成失败，不记成用户停下', async () => {
    const clock = { t: 0 }
    const records: RequestRecord[] = []
    const controller = new AbortController()
    controller.abort(new Error('stalled'))
    const { fn } = scripted(clock, [
      {
        type: 'error',
        reason: 'aborted',
        error: message({ stopReason: 'aborted', errorMessage: 'Operation aborted' })
      }
    ])
    const wrapped = diagnosedStreamFn(fn, { sink: (r) => records.push(r), now: () => clock.t })

    await drain(
      await wrapped(model, normalizeContext({ messages: [] }), { signal: controller.signal })
    )
    await Promise.resolve()

    expect(records[0]).toMatchObject({
      outcome: 'error',
      error: expect.stringContaining('stalled')
    })
  })
})

describe('失败响应的头', () => {
  it('pi 只给一句「400 (no body)」：响应头和响应体从 fetch 那层记下来，带密钥的头不记', async () => {
    const records: RequestRecord[] = []
    const upstream = (async () =>
      new Response('', {
        status: 400,
        headers: { 'x-request-id': 'req-400', 'x-error-code': 'E123', 'set-cookie': 'sid=1' }
      })) as typeof fetch
    const fn: StreamFn = async (_m, _context, options) => {
      await options?.onPayload?.({ messages: ['原样'] }, _m)
      await options!.fetch!('https://copilot.tencent.com/v2/chat/completions')
      const stream = createAssistantMessageEventStream()
      stream.push({
        type: 'error',
        reason: 'error',
        error: message({ stopReason: 'error', errorMessage: '400 status code (no body)' })
      })
      stream.end()
      return stream
    }
    const dumped: unknown[] = []
    const wrapped = diagnosedStreamFn(fn, {
      sink: (r) => records.push(r),
      dumpRejected: (_r, payload) => dumped.push(payload)
    })

    await drain(await wrapped(model, normalizeContext({ messages: [] }), { fetch: upstream }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const { headers, body } = records[0].errorResponse!
    expect(headers).toMatchObject({ 'x-request-id': 'req-400', 'x-error-code': 'E123' })
    expect(headers).not.toHaveProperty('set-cookie')
    expect(body).toBeUndefined()
    // 400 不说是哪个参数：原样请求体留给事后逐段定位
    expect(dumped).toEqual([{ messages: ['原样'] }])
  })

  it('Google 协议的模型不塞自己的 fetch：pi 的 Google 适配器见到自定义 fetch 直接抛错', async () => {
    let seen: unknown = 'unset'
    const fn: StreamFn = async (_m, _context, options) => {
      seen = options?.fetch
      const stream = createAssistantMessageEventStream()
      stream.end()
      return stream
    }
    const wrapped = diagnosedStreamFn(fn, { sink: () => undefined })
    await drain(
      await wrapped(
        { ...model, api: 'google-generative-ai' } as typeof model,
        normalizeContext({ messages: [] })
      )
    )
    expect(seen).toBeUndefined()
  })
})
