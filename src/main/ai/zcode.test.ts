/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { runZCodeLogin, zcodeFetch, zcodeTokens, ZCODE_BASE_URL, isZCodeEndpoint } from './zcode'

const jwt = (exp = Math.floor(Date.now() / 1000) + 3600): string =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`
const json = (data: unknown): Response => Response.json({ data })

describe('ZCode sign-in', () => {
  it('uses a private poll token and returns only the subscription JWT', async () => {
    const token = jwt()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ flow_id: 'flow/one', authorize_url: 'https://zcode.z.ai/authorize' })
      )
      .mockResolvedValueOnce(json({ status: 'pending' }))
      .mockResolvedValueOnce(
        json({ status: 'ready', token, zai: { access_token: 'not-the-subscription' } })
      )
    const openUrl = vi.fn()
    expect(await runZCodeLogin({ openUrl, fetchImpl, pollIntervalMs: 1 })).toEqual({
      accessToken: token,
      expiresAt: expect.any(Number)
    })
    expect(openUrl).toHaveBeenCalledWith('https://zcode.z.ai/authorize')
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(JSON.stringify({ provider: 'zai' }))
    expect(fetchImpl.mock.calls[1][0]).toContain('/poll/flow%2Fone')
    const headers = fetchImpl.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get('Authorization')
    )
    expect(new Set(headers).size).toBe(1)
    expect(headers[0]).toMatch(/^Bearer [a-f0-9]{64}$/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('never exchanges a standard API key when the subscription token is absent', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ flow_id: 'a', authorize_url: 'https://zcode.z.ai/auth' }))
      .mockResolvedValueOnce(json({ status: 'ready', zai: { access_token: 'private' } }))
    await expect(runZCodeLogin({ openUrl: vi.fn(), fetchImpl, pollIntervalMs: 1 })).rejects.toThrow(
      'did not return a Coding Plan token'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each(['http://zcode.z.ai/auth', 'https://zcode.z.ai.evil.test/auth', 'file:///secret'])(
    'rejects an untrusted authorization URL %s',
    async (authorize_url) => {
      const openUrl = vi.fn()
      await expect(
        runZCodeLogin({
          openUrl,
          fetchImpl: vi.fn().mockResolvedValue(
            json({
              flow_id: 'a',
              authorize_url
            })
          )
        })
      ).rejects.toThrow('untrusted')
      expect(openUrl).not.toHaveBeenCalled()
    }
  )

  it('cancels polling immediately and does not fetch again', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        flow_id: 'a',
        authorize_url: 'https://zcode.z.ai/auth'
      })
    )
    await expect(
      runZCodeLogin({ fetchImpl, signal: controller.signal, openUrl: () => controller.abort() })
    ).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('bounds sign-in time and surfaces upstream failure', async () => {
    await expect(
      runZCodeLogin({
        openUrl: vi.fn(),
        fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 503 }))
      })
    ).rejects.toThrow('HTTP 503')
    await expect(
      runZCodeLogin({
        openUrl: vi.fn(),
        timeoutMs: 5,
        fetchImpl: vi
          .fn()
          .mockResolvedValue(json({ flow_id: 'a', authorize_url: 'https://zcode.z.ai/auth' }))
      })
    ).rejects.toThrow()
  })

  it('rejects expired, malformed and non-subscription credentials without exposing them', () => {
    expect(() => zcodeTokens(jwt(1))).toThrow('expired')
    expect(() => zcodeTokens('private-api-key')).toThrow('Coding Plan JWT')
    expect(() => zcodeTokens('abc.invalid.xyz')).toThrow('Invalid ZCode token')
  })
})

const endpoint = `${ZCODE_BASE_URL}/v1/messages?beta=true`
function request(signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'x-api-key': jwt(), 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: 'glm-5.2',
      stream: true,
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'ping', input: {} }]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'pong' }] }
      ],
      tools: [{ name: 'ping', input_schema: { type: 'object' } }]
    })
  }
}

describe('ZCode Anthropic transport', () => {
  it('translates auth and model ID, preserves tools and returns SSE without buffering', async () => {
    const response = new Response('event: message_start\ndata: {}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' }
    })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    const captcha = { get: vi.fn().mockResolvedValue('verification'), invalidate: vi.fn() }
    expect(await zcodeFetch(fetchImpl, captcha)(endpoint, request())).toBe(response)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(endpoint)
    const headers = new Headers(init?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${jwt()}`)
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.get('X-Aliyun-Captcha-Verify-Param')).toBe('verification')
    expect(headers.get('X-ZCode-Agent')).toBe('glm')
    expect(init?.redirect).toBe('error')
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('GLM-5.2')
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'hello' }])
    expect(body.messages[2].content[0].tool_use_id).toBe('call-1')
    expect(body.tools[0].name).toBe('ping')
    expect(response.bodyUsed).toBe(false)
  })

  it('refreshes verification once on a captcha rejection', async () => {
    const captcha = {
      get: vi.fn().mockResolvedValueOnce('old').mockResolvedValue('new'),
      invalidate: vi.fn()
    }
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('captcha expired', { status: 403 }))
      .mockResolvedValueOnce(new Response('captcha still rejected', { status: 403 }))
    expect((await zcodeFetch(fetchImpl, captcha)(endpoint, request())).status).toBe(403)
    expect(captcha.invalidate).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).get('X-Aliyun-Captcha-Verify-Param')
    ).toBe('new')
  })

  it.each([401, 402, 403, 429])('does not retry or fall back on HTTP %s', async (status) => {
    const response = new Response('account not available', { status })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    const captcha = { get: vi.fn().mockResolvedValue(undefined), invalidate: vi.fn() }
    expect(await zcodeFetch(fetchImpl, captcha)(endpoint, request())).toBe(response)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(captcha.invalidate).not.toHaveBeenCalled()
  })

  it('stops while waiting for verification without sending the prompt', async () => {
    const controller = new AbortController()
    const get = vi.fn(
      () =>
        new Promise<string>(() => {
          setTimeout(() => controller.abort(), 1)
        })
    )
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      zcodeFetch(fetchImpl, { get, invalidate: vi.fn() })(endpoint, request(controller.signal))
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed on verification errors and untrusted destinations', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const captcha = {
      get: vi.fn().mockRejectedValue(new Error('verification unavailable')),
      invalidate: vi.fn()
    }
    await expect(zcodeFetch(fetchImpl, captcha)(endpoint, request())).rejects.toThrow(
      'verification unavailable'
    )
    await expect(
      zcodeFetch(fetchImpl, captcha)('https://evil.test/v1/messages', request())
    ).rejects.toThrow('endpoint')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(isZCodeEndpoint(ZCODE_BASE_URL + '/')).toBe(true)
    expect(isZCodeEndpoint('https://zcode.z.ai.evil.test/api/v1/zcode-plan/anthropic')).toBe(false)
    expect(isZCodeEndpoint(ZCODE_BASE_URL + '/other')).toBe(false)
  })
})
