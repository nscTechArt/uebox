/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import {
  CODEBUDDY_ORIGIN,
  CodeBuddyError,
  codeBuddyRequestHeaders,
  refreshCodeBuddyTokens,
  runCodeBuddyLogin,
  userIdFromJwt
} from './codebuddy'

/** 造一个只有 payload 有意义的 JWT */
function jwt(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
}

function envelope(code: number, data?: unknown, msg = ''): Response {
  return new Response(JSON.stringify({ code, msg, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>

/** 按路径前缀分派的假 fetch，顺带记下每次请求 */
function fakeFetch(routes: Record<string, Route>): {
  fetchImpl: typeof fetch
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const path = url.slice(CODEBUDDY_ORIGIN.length)
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix))
    if (!key) throw new Error(`unexpected ${url}`)
    return routes[key](url, init)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function stateResponse(): Response {
  const response = envelope(0, { state: 's/1', authUrl: 'https://www.codebuddy.cn/login?x=1' })
  response.headers.append('Set-Cookie', 'sid=abc; Path=/; HttpOnly')
  return response
}

describe('runCodeBuddyLogin', () => {
  it('打开登录页、等到令牌、带回账号 id，轮询沿用发起时的 cookie', async () => {
    let polls = 0
    const { fetchImpl, calls } = fakeFetch({
      '/v2/plugin/auth/state': () => stateResponse(),
      '/v2/plugin/auth/token': () =>
        ++polls < 2
          ? envelope(11217, undefined, 'login ing...')
          : envelope(0, {
              accessToken: 'jwt-1',
              refreshToken: 'r-1',
              expiresIn: 3600,
              domain: 'www.codebuddy.cn'
            }),
      '/v2/plugin/login/account': () => envelope(0, { uid: 'u-1', enterpriseId: 'e-1' })
    })
    const openUrl = vi.fn()

    const tokens = await runCodeBuddyLogin({ openUrl, fetchImpl, pollIntervalMs: 1 })

    expect(openUrl).toHaveBeenCalledWith('https://www.codebuddy.cn/login?x=1')
    expect(tokens).toMatchObject({
      accessToken: 'jwt-1',
      refreshToken: 'r-1',
      accountId: 'u-1',
      enterpriseId: 'e-1',
      domain: 'www.codebuddy.cn'
    })
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())

    const poll = calls.find((call) => call.url.includes('/auth/token?'))
    expect(poll?.url).toContain('state=s%2F1')
    expect((poll?.init.headers as Record<string, string>).Cookie).toBe('sid=abc')
    const account = calls.find((call) => call.url.includes('/login/account'))
    expect((account?.init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1')
  })

  it('账号接口拿不到时，用 JWT 的 sub 当账号 id', async () => {
    const { fetchImpl } = fakeFetch({
      '/v2/plugin/auth/state': () => stateResponse(),
      '/v2/plugin/auth/token': () => envelope(0, { accessToken: jwt({ sub: 'from-jwt' }) }),
      '/v2/plugin/login/account': () => new Response('unauthorized', { status: 401 })
    })

    const tokens = await runCodeBuddyLogin({ openUrl: () => {}, fetchImpl, pollIntervalMs: 1 })

    expect(tokens.accountId).toBe('from-jwt')
  })

  it('「登录中」以外的业务错误立刻失败，不等到超时', async () => {
    const { fetchImpl } = fakeFetch({
      '/v2/plugin/auth/state': () => stateResponse(),
      '/v2/plugin/auth/token': () => envelope(11999, undefined, 'state expired')
    })

    await expect(
      runCodeBuddyLogin({ openUrl: () => {}, fetchImpl, pollIntervalMs: 1 })
    ).rejects.toThrow(/11999/)
  })

  it('发起登录拿不到登录地址时直接报错，不打开浏览器', async () => {
    const { fetchImpl } = fakeFetch({ '/v2/plugin/auth/state': () => envelope(0, {}) })
    const openUrl = vi.fn()

    await expect(runCodeBuddyLogin({ openUrl, fetchImpl })).rejects.toBeInstanceOf(CodeBuddyError)
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('用户取消后停止轮询', async () => {
    const controller = new AbortController()
    const { fetchImpl } = fakeFetch({
      '/v2/plugin/auth/state': () => stateResponse(),
      '/v2/plugin/auth/token': () => {
        controller.abort()
        return envelope(11217)
      }
    })

    await expect(
      runCodeBuddyLogin({
        openUrl: () => {},
        fetchImpl,
        signal: controller.signal,
        pollIntervalMs: 1
      })
    ).rejects.toBeDefined()
  })
})

describe('refreshCodeBuddyTokens', () => {
  it('带 refreshToken 续期；对方没回的字段沿用旧值', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/v2/plugin/auth/token/refresh': () => envelope(0, { accessToken: 'jwt-2', expiresIn: 60 })
    })

    const next = await refreshCodeBuddyTokens(
      {
        accessToken: 'jwt-1',
        refreshToken: 'r-1',
        accountId: 'u-1',
        domain: 'www.codebuddy.cn',
        enterpriseId: 'e-1'
      },
      fetchImpl
    )

    expect(next).toMatchObject({
      accessToken: 'jwt-2',
      refreshToken: 'r-1',
      accountId: 'u-1',
      domain: 'www.codebuddy.cn',
      enterpriseId: 'e-1'
    })
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['X-Refresh-Token']).toBe('r-1')
    expect(headers['X-Enterprise-Id']).toBe('e-1')
  })

  it('续期失败抛错并提示重新登录', async () => {
    const { fetchImpl } = fakeFetch({
      '/v2/plugin/auth/token/refresh': () => envelope(401, undefined, 'expired')
    })

    await expect(
      refreshCodeBuddyTokens({ accessToken: 'a', refreshToken: 'r' }, fetchImpl)
    ).rejects.toThrow(/重新登录/)
  })
})

describe('codeBuddyRequestHeaders', () => {
  it('带上账号身份与整组会话 / 链路 id', () => {
    const headers = codeBuddyRequestHeaders({
      accessToken: 'jwt',
      accountId: 'u-1',
      domain: 'www.codebuddy.cn'
    })

    expect(headers['X-User-Id']).toBe('u-1')
    expect(headers['X-Domain']).toBe('www.codebuddy.cn')
    expect(headers['X-Product']).toBe('SaaS')
    expect(headers['User-Agent']).toMatch(/^CLI\/[\d.]+ CodeBuddy\/[\d.]+$/)
    // 抓包：单独带其中一个不生效，要成组、且彼此对得上
    expect(headers['X-Request-ID']).toBe(headers['X-Conversation-Message-ID'])
    expect(headers['X-Root-Request-ID']).toBe(headers['X-Conversation-Request-ID'])
    expect(headers.traceparent).toMatch(new RegExp(`^00-${headers['X-Trace-ID']}-[0-9a-f]{16}-01$`))
    expect(headers['X-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
    // 密钥由 pi 拼进 Authorization，不在这里重复
    expect(headers.Authorization).toBeUndefined()
  })

  it('每次请求生成新的 id', () => {
    const a = codeBuddyRequestHeaders({ accessToken: 'jwt', accountId: 'u' })
    const b = codeBuddyRequestHeaders({ accessToken: 'jwt', accountId: 'u' })
    expect(a['X-Request-ID']).not.toBe(b['X-Request-ID'])
  })

  it('旧令牌没存账号 id 时从 JWT 里取', () => {
    expect(codeBuddyRequestHeaders({ accessToken: jwt({ sub: 's-9' }) })['X-User-Id']).toBe('s-9')
    expect(userIdFromJwt('not-a-jwt')).toBeUndefined()
  })
})
