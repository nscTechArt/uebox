// 这里**不起真实的 HTTP 服务器**。原来是真的 listen 再真的 fetch 自己，
// 结果两条 ChatGPT 用例挂在固定端口 1455 上 —— 本机只要有别的程序占着它
// （官方 CLI 的登录流程就占），测试必然十秒超时。端口是环境，不是被测逻辑。
//
// 现在 `http.createServer` 被换成一个假的：记住 listen 的端口、把 'request'
// 处理器交出来，测试直接调它来模拟浏览器回调。顺带没了 jsdom 那两行
// "Cross-Origin Request Blocked" 噪声。
//
// 不能把本文件的运行环境切成 node：全局的 tests/setup.ts 要往 window 上挂
// Electron 的桩，没有 DOM 会直接崩在加载阶段。
// （注意别在注释里写出那个环境指令的字面量，vitest 会把它当成真的指令解析。）
import { createHash } from 'crypto'
import { describe, expect, it, vi, afterEach } from 'vitest'

/** 捕获被打开的授权地址，并且不真的唤起浏览器 */
const openedUrls: string[] = []
vi.mock('electron', () => ({
  shell: {
    openExternal: async (url: string) => {
      openedUrls.push(url)
    }
  }
}))

type RequestHandler = (req: { url: string }, res: FakeResponse) => void

interface FakeResponse {
  writeHead: (...args: unknown[]) => FakeResponse
  end: (body?: string) => void
}

interface FakeServer {
  port: number
  handler: RequestHandler | null
  closed: boolean
}

/** 每次 createServer 记一台，测试用最后一台驱动回调 */
const servers: FakeServer[] = []

vi.mock('http', () => {
  const createServer = (): unknown => {
    const errorHandlers: Array<(error: Error) => void> = []
    const server: FakeServer & {
      on: (event: string, fn: RequestHandler | ((e: Error) => void)) => void
      listen: (port: number, host: string, cb: () => void) => void
      close: () => void
      address: () => { port: number }
    } = {
      // 端口 0 表示「系统分配」，假服务器给一个固定的假端口就够断言了
      port: 0,
      handler: null,
      closed: false,
      on(event, fn) {
        if (event === 'request') server.handler = fn as RequestHandler
        else if (event === 'error') errorHandlers.push(fn as (e: Error) => void)
      },
      listen(port, _host, cb) {
        server.port = port || 49876
        // 异步回调，跟真实 listen 的时序一致
        setTimeout(cb, 0)
      },
      close() {
        server.closed = true
      },
      address: () => ({ port: server.port })
    }
    servers.push(server)
    return server
  }
  // 有别处按默认导入用 http，只给具名导出会在加载阶段就炸
  return { createServer, default: { createServer } }
})

/**
 * 模拟浏览器把授权码送回来。
 *
 * 直接调 'request' 处理器，不走网络 —— 所以不占端口、不受本机环境影响。
 */
function hitCallback(pathWithQuery: string): void {
  const server = servers.at(-1)
  if (!server?.handler) throw new Error('回调服务器还没在监听')
  const res: FakeResponse = {
    writeHead: () => res,
    end: () => {}
  }
  server.handler({ url: pathWithQuery }, res)
}

const { runOAuthLogin, refreshOAuthTokens, isExpired, yieldsPermanentKey } = await import('./oauth')

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  openedUrls.length = 0
  servers.length = 0
})

/**
 * 整条 PKCE 走一遍，只把「换密钥」那一跳换成本地桩。
 *
 * 这段代码碰的是密钥，又跑了一个本机监听端口，值得端到端验一次而不是
 * 只测几个纯函数。
 */
describe('runOAuthLogin', () => {
  it('OpenRouter 拿回的是永久 Key，ChatGPT / Kimi 不是', () => {
    // 这个判断直接决定令牌存成哪种形态、要不要续期
    expect(yieldsPermanentKey('openrouter')).toBe(true)
    expect(yieldsPermanentKey('chatgpt')).toBe(false)
    expect(yieldsPermanentKey('kimi-code')).toBe(false)
  })

  it('走完 PKCE 并拿回密钥', async () => {
    let exchangeBody: Record<string, string> | null = null

    // 只拦「换密钥」那一跳。全量替换 fetch 会把下面模拟浏览器回调的那次请求
    // 也吃掉，回调服务器永远收不到，测试就只能等超时。
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (!String(url).startsWith('https://openrouter.ai')) {
        return originalFetch(url, init)
      }
      exchangeBody = JSON.parse(String(init.body))
      return { ok: true, json: async () => ({ key: 'sk-or-v1-fromtest' }) }
    }) as unknown as typeof fetch

    const pending = runOAuthLogin('openrouter')

    // 等授权地址被打开 —— 那时本机回调服务器已经在监听了
    while (openedUrls.length === 0) await new Promise((r) => setTimeout(r, 10))
    const authUrl = new URL(openedUrls[0])
    const callbackUrl = authUrl.searchParams.get('callback_url') as string
    const challenge = authUrl.searchParams.get('code_challenge') as string

    expect(authUrl.origin + authUrl.pathname).toBe('https://openrouter.ai/auth')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    // 回调必须落在本机，且路径是随机的（别的程序猜不到往哪儿发伪造授权码）
    expect(callbackUrl.startsWith('http://localhost:')).toBe(true)
    expect(new URL(callbackUrl).pathname).toMatch(/^\/[0-9a-f]{32}$/)

    // 模拟浏览器带着授权码回调
    hitCallback(`${new URL(callbackUrl).pathname}?code=test-auth-code`)

    expect((await pending).accessToken).toBe('sk-or-v1-fromtest')

    // verifier 必须真的是 challenge 的原像，否则 PKCE 形同虚设
    const body = exchangeBody as unknown as { code: string; code_verifier: string }
    expect(body.code).toBe('test-auth-code')
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge)
  })

  it('用户拒绝授权时报「已取消」而不是超时', async () => {
    // 必须在触发回调**之前**接住这个 promise：拒绝发生在下面那次 fetch 期间，
    // 那时若还没有 handler，Node 会当成未处理的 rejection 把测试打挂
    const settled = runOAuthLogin('openrouter').catch((error: Error) => error)

    while (openedUrls.length === 0) await new Promise((r) => setTimeout(r, 10))
    const callbackUrl = new URL(openedUrls[0]).searchParams.get('callback_url') as string

    hitCallback(`${new URL(callbackUrl).pathname}?error=access_denied`)

    const outcome = await settled
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('授权已取消')
  })

  it('不认识的 provider 直接报错', async () => {
    await expect(runOAuthLogin('anthropic')).rejects.toThrow('不支持 OAuth 登录')
  })

  it('ChatGPT 用固定端口与固定回调路径', async () => {
    // 1455 与 /auth/callback 是 Codex 注册死的，改了对方会拒绝回调
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (!String(url).startsWith('https://auth.openai.com')) return originalFetch(url, init)
      return { ok: false, status: 400, text: async () => '' }
    }) as never
    const settled = runOAuthLogin('chatgpt').catch((e: Error) => e)
    while (openedUrls.length === 0) await new Promise((r) => setTimeout(r, 10))

    const authUrl = new URL(openedUrls[0])
    expect(authUrl.origin + authUrl.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(authUrl.searchParams.get('client_id')).toBeTruthy()
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    // state 必须发出去，否则下面那条防伪造回调的校验形同虚设
    expect(authUrl.searchParams.get('state')).toBeTruthy()
    // OpenRouter 用 callback_url，标准 OAuth 用 redirect_uri，别两个都发
    expect(authUrl.searchParams.get('callback_url')).toBeNull()

    hitCallback('/auth/callback?error=access_denied')
    await settled
  })

  it('state 对不上的回调会被丢弃', async () => {
    const settled = runOAuthLogin('chatgpt').catch((e: Error) => e)
    while (openedUrls.length === 0) await new Promise((r) => setTimeout(r, 10))

    // 伪造一个 code，但 state 是错的
    hitCallback('/auth/callback?code=forged&state=wrong')

    const outcome = await settled
    expect((outcome as Error).message).toContain('state 校验失败')
  })
})

describe('设备码流程（Kimi）', () => {
  it('轮询到令牌，并把用户码回调出来', async () => {
    let polls = 0
    const prompts: Array<{ userCode: string }> = []

    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('device_authorization')) {
        return {
          ok: true,
          json: async () => ({
            device_code: 'dev-1',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://auth.kimi.com/device',
            // 不能写 0：生产代码里 `Number(interval) || 5` 会把 0 当成缺省值
            // 回落到 5 秒，两轮轮询就超过测试超时了
            interval: 0.01,
            expires_in: 600
          })
        }
      }
      polls += 1
      // 头一次故意回 authorization_pending，验证它被当成「还没轮到」而不是失败
      if (polls === 1) return { ok: false, json: async () => ({ error: 'authorization_pending' }) }
      return {
        ok: true,
        json: async () => ({ access_token: 'kimi-token', refresh_token: 'r1', expires_in: 3600 })
      }
    }) as never

    const tokens = await runOAuthLogin('kimi-code', (p) => prompts.push(p))

    expect(tokens.accessToken).toBe('kimi-token')
    expect(tokens.refreshToken).toBe('r1')
    expect(polls).toBe(2)
    expect(prompts[0].userCode).toBe('ABCD-EFGH')
  })

  it('用户拒绝时报「已取消」', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('device_authorization')) {
        return {
          ok: true,
          json: async () => ({
            device_code: 'd',
            user_code: 'X',
            verification_uri: 'u',
            interval: 0.01
          })
        }
      }
      return { ok: false, json: async () => ({ error: 'access_denied' }) }
    }) as never

    await expect(runOAuthLogin('kimi-code')).rejects.toThrow('授权已取消')
  })
})

describe('令牌续期', () => {
  it('过期判定留了提前量', () => {
    expect(isExpired({ accessToken: 'a' })).toBe(false)
    expect(isExpired({ accessToken: 'a', expiresAt: Date.now() + 3600_000 })).toBe(false)
    // 还剩 30 秒也算过期：避免刚好在请求发出的瞬间失效
    expect(isExpired({ accessToken: 'a', expiresAt: Date.now() + 30_000 })).toBe(true)
  })

  it('续期不回 refresh_token 时沿用旧的', async () => {
    // 少了这条，第二次续期就会因为没有 refreshToken 而要求用户重新登录
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 3600 })
    })) as never

    const next = await refreshOAuthTokens('chatgpt', {
      accessToken: 'old',
      refreshToken: 'keep-me',
      expiresAt: 0
    })

    expect(next.accessToken).toBe('new-access')
    expect(next.refreshToken).toBe('keep-me')
  })

  it('续期失败时抛错而不是退回旧令牌', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 401 })) as never
    await expect(
      refreshOAuthTokens('chatgpt', { accessToken: 'old', refreshToken: 'r', expiresAt: 0 })
    ).rejects.toThrow('请重新登录')
  })
})
