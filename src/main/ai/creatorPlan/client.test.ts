/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import {
  CreatorPlanError,
  fetchManifest,
  fetchManifestIfChanged,
  pollForKey,
  revokeKey,
  startDeviceAuthorization
} from './client'

const ORIGIN = 'https://plan.example'
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const noWait = async (): Promise<void> => {}

/** 按顺序回放响应的假 fetch，顺便记下请求 */
function scripted(responses: Response[]): {
  fetchImpl: typeof fetch
  calls: { url: string; body: unknown }[]
} {
  const calls: { url: string; body: unknown }[] = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const next = responses.shift()
    if (!next) throw new Error('no more responses')
    return next
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const errorCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return error instanceof CreatorPlanError ? error.code : String(error)
  }
}

describe('startDeviceAuthorization', () => {
  it('发起授权：带上客户端与设备名，回码和确认页地址', async () => {
    const { fetchImpl, calls } = scripted([
      json({
        device_code: 'dc_1',
        user_code: 'BCDF-GHJK',
        verification_uri: `${ORIGIN}/connect`,
        verification_uri_complete: `${ORIGIN}/connect?code=BCDF-GHJK`,
        interval: 5,
        expires_in: 600
      })
    ])
    const start = await startDeviceAuthorization(
      ORIGIN,
      { deviceName: 'WORKSTATION', clientVersion: '1.0.3' },
      fetchImpl
    )
    expect(calls[0]).toEqual({
      url: `${ORIGIN}/v1/connect/device`,
      body: { client: 'uebox', client_version: '1.0.3', device_name: 'WORKSTATION' }
    })
    expect(start).toEqual({
      deviceCode: 'dc_1',
      prompt: { userCode: 'BCDF-GHJK', verificationUri: `${ORIGIN}/connect?code=BCDF-GHJK` },
      interval: 5,
      expiresIn: 600
    })
  })

  it('有设备标识就带上 device_id（同一台设备重新授权，服务端吊销旧 Key）', async () => {
    const { fetchImpl, calls } = scripted([json({ device_code: 'dc_1', user_code: 'BCDF-GHJK' })])
    await startDeviceAuthorization(
      ORIGIN,
      { deviceName: 'W', clientVersion: '1', deviceId: 'd6c1f0a2-0000-4000-8000-000000000001' },
      fetchImpl
    )
    expect(calls[0]!.body).toEqual({
      client: 'uebox',
      client_version: '1',
      device_name: 'W',
      device_id: 'd6c1f0a2-0000-4000-8000-000000000001'
    })
  })
})

describe('pollForKey', () => {
  const start = { deviceCode: 'dc_1', interval: 5, expiresIn: 600 }

  it('等待 → 太快 → 允许：拿到 Key；slow_down 后间隔加 5 秒', async () => {
    const waits: number[] = []
    const { fetchImpl } = scripted([
      json({ error: { code: 'authorization_pending' } }, 400),
      json({ error: { code: 'slow_down' } }, 400),
      json({ api_key: 'ubx-sk-abc', key_name: '虚幻盒子 · W', base_url: `${ORIGIN}/v1` })
    ])
    const issued = await pollForKey(
      ORIGIN,
      start,
      new AbortController().signal,
      fetchImpl,
      async (ms) => {
        waits.push(ms)
      }
    )
    expect(issued).toEqual({
      apiKey: 'ubx-sk-abc',
      keyName: '虚幻盒子 · W',
      baseUrl: `${ORIGIN}/v1`
    })
    expect(waits).toEqual([5000, 5000, 10000])
  })

  it.each([
    ['access_denied', 'denied'],
    ['expired_token', 'expired']
  ])('%s → %s', async (serverCode, code) => {
    const { fetchImpl } = scripted([json({ error: { code: serverCode } }, 400)])
    expect(
      await errorCode(pollForKey(ORIGIN, start, new AbortController().signal, fetchImpl, noWait))
    ).toBe(code)
  })

  it('取消：cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetchImpl } = scripted([])
    const wait = (_ms: number, signal: AbortSignal): Promise<void> =>
      signal.aborted ? Promise.reject(new CreatorPlanError('cancelled', 'x')) : Promise.resolve()
    expect(await errorCode(pollForKey(ORIGIN, start, controller.signal, fetchImpl, wait))).toBe(
      'cancelled'
    )
  })
})

describe('fetchManifest', () => {
  it('带 Key 请求 /plan', async () => {
    const { fetchImpl } = scripted([json({ schema: 1, roles: {}, plan: { status: 'active' } })])
    await fetchManifest(`${ORIGIN}/v1`, 'ubx-sk-abc', fetchImpl)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe(`${ORIGIN}/v1/plan`)
    expect((init as RequestInit).headers).toEqual({ authorization: 'Bearer ubx-sk-abc' })
  })

  it('401 → unauthorized；形状不对 → bad_response', async () => {
    expect(await errorCode(fetchManifest(ORIGIN, 'k', scripted([json({}, 401)]).fetchImpl))).toBe(
      'unauthorized'
    )
    expect(
      await errorCode(fetchManifest(ORIGIN, 'k', scripted([json({ schema: 2 })]).fetchImpl))
    ).toBe('bad_response')
  })
})

describe('fetchManifestIfChanged', () => {
  const body = { schema: 1, etag: 'p-1', roles: {}, plan: { status: 'active' } }

  it('带 etag 发 If-None-Match；304 → not_modified', async () => {
    const { fetchImpl } = scripted([new Response(null, { status: 304 })])
    const result = await fetchManifestIfChanged(`${ORIGIN}/v1`, 'k', '"p-1"', fetchImpl)
    expect(result).toEqual({ status: 'not_modified' })
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect((init as RequestInit).headers).toEqual({
      authorization: 'Bearer k',
      'if-none-match': '"p-1"'
    })
  })

  it('200：回清单和响应头里的 ETag；没给头就用清单里的 etag 加引号', async () => {
    const withHeader = new Response(JSON.stringify(body), {
      status: 200,
      headers: { etag: '"p-2"' }
    })
    expect(
      await fetchManifestIfChanged(`${ORIGIN}/v1`, 'k', null, scripted([withHeader]).fetchImpl)
    ).toMatchObject({ status: 'ok', etag: '"p-2"', manifest: { etag: 'p-1' } })
    expect(
      await fetchManifestIfChanged(`${ORIGIN}/v1`, 'k', null, scripted([json(body)]).fetchImpl)
    ).toMatchObject({ status: 'ok', etag: '"p-1"' })
  })

  it('401 → unauthorized', async () => {
    expect(
      await errorCode(
        fetchManifestIfChanged(ORIGIN, 'k', '"p-1"', scripted([json({}, 401)]).fetchImpl)
      )
    ).toBe('unauthorized')
  })
})

describe('revokeKey', () => {
  it('用 Key 自己认证 POST /auth/revoke；204 → true', async () => {
    const { fetchImpl, calls } = scripted([new Response(null, { status: 204 })])
    expect(await revokeKey(`${ORIGIN}/v1`, 'ubx-sk-abc', fetchImpl)).toBe(true)
    expect(calls[0]!.url).toBe(`${ORIGIN}/v1/auth/revoke`)
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer ubx-sk-abc' } })
  })

  it('401 说明早就失效，算成功；5xx、断网 → false，不抛', async () => {
    expect(await revokeKey(ORIGIN, 'k', scripted([json({}, 401)]).fetchImpl)).toBe(true)
    expect(await revokeKey(ORIGIN, 'k', scripted([json({}, 503)]).fetchImpl)).toBe(false)
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await revokeKey(ORIGIN, 'k', offline)).toBe(false)
  })
})

describe('网络错误', () => {
  it('带上连的是哪个地址和底层原因', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' }
    })
    const fetchImpl = vi.fn(async () => {
      throw refused
    }) as unknown as typeof fetch
    try {
      await startDeviceAuthorization(ORIGIN, { deviceName: 'W', clientVersion: '1' }, fetchImpl)
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ code: 'network', message: `${ORIGIN}（ECONNREFUSED）` })
    }
  })
})
