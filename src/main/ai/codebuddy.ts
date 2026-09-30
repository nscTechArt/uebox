import { randomBytes, randomUUID } from 'crypto'
import type { OAuthTokens } from './oauth'

/**
 * CodeBuddy / WorkBuddy（腾讯）账号直连。
 *
 * ## 这是什么、有什么风险
 *
 * 腾讯**没有**给 CodeBuddy 会员开放 API。这里做的是：用官方 CLI 同一套登录接口
 * 换到会员令牌，再以官方 CLI 的身份头去打它的对话端点。协议事实全部取自
 * holtwood/wb2api（MIT）对官方 CLI v2.143.0 的抓包记录
 * （`notes/workbuddy-protocol-notes.md`、`specs/capture-2026-09-02.md`）与
 * lovingfish/workbuddy-cliproxy（MIT），没有复制代码。
 *
 * 这是非官方用法：腾讯改接口、升级客户端版本校验都可能让它失效，账号也可能
 * 因此受限。是否使用由用户自行判断，与 oauth.ts 顶部对订阅账号的说明同一立场。
 *
 * ## 和标准 OAuth 的区别
 *
 * 既不是 PKCE 也不是设备码：先跟服务端要一个 `state` 和登录页地址，用户在
 * 浏览器里登录（扫码或账号），我们拿同一个 `state` 轮询到令牌为止。没有
 * client_id、scope、回调端口。
 *
 * 版本号、身份头都集中在本文件顶部 —— 官方客户端升级后上游开始拒绝时，只改这里。
 */

export const CODEBUDDY_ORIGIN = 'https://copilot.tencent.com'
/** pi 的 openai-completions 会在后面拼 `/chat/completions` */
export const CODEBUDDY_BASE_URL = `${CODEBUDDY_ORIGIN}/v2`

/** 官方 CLI 版本（2026-09-02 抓包）。旧的 2.63.2 已经过时 */
const CLIENT_VERSION = '2.143.0'
const USER_AGENT = `CLI/${CLIENT_VERSION} CodeBuddy/${CLIENT_VERSION}`

/** 上游统一信封里的业务码 */
const CODE_OK = 0
/** 用户还没在浏览器里完成登录 */
const CODE_LOGIN_PENDING = 11217

const POLL_INTERVAL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

interface Envelope {
  code?: number
  msg?: string
  data?: unknown
}

interface TokenData {
  accessToken?: string
  refreshToken?: string
  /** 相对秒数 */
  expiresIn?: number
  domain?: string
}

interface AccountData {
  uid?: string
  enterpriseId?: string
}

export class CodeBuddyError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message)
    this.name = 'CodeBuddyError'
  }
}

/** 登录、续期这几个账号接口共用的头 */
function accountHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': USER_AGENT
  }
}

async function callEnvelope(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new CodeBuddyError(`CodeBuddy 接口 HTTP ${response.status}：${text.slice(0, 200)}`)
  }
  let envelope: Envelope
  try {
    envelope = JSON.parse(text) as Envelope
  } catch {
    throw new CodeBuddyError('CodeBuddy 接口返回的不是 JSON，可能是接口改版了')
  }
  if (envelope.code !== CODE_OK) {
    throw new CodeBuddyError(
      `CodeBuddy 接口报错（${envelope.code}）：${envelope.msg || '未知错误'}`,
      envelope.code
    )
  }
  return envelope.data
}

function toTokens(data: TokenData, previous?: OAuthTokens): OAuthTokens {
  const accessToken = String(data.accessToken || '')
  if (!accessToken) throw new CodeBuddyError('CodeBuddy 没有返回 accessToken')
  const expiresIn = Number(data.expiresIn)
  return {
    accessToken,
    // 续期时对方可能不回 refreshToken / domain，表示继续用旧的
    refreshToken: data.refreshToken || previous?.refreshToken,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    accountId: previous?.accountId || userIdFromJwt(accessToken),
    domain: data.domain || previous?.domain,
    enterpriseId: previous?.enterpriseId
  }
}

/**
 * 从 JWT 里取用户 id。
 *
 * 抓包确认 `sub` 与 `X-User-Id` 是同一个值。账号接口偶尔拿不到时拿它兜底，
 * 否则对话请求缺 `X-User-Id` 会被拒。只解码不验签 —— 令牌是对方刚发给我们的。
 */
export function userIdFromJwt(token: string): string | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      sub?: unknown
    }
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : undefined
  } catch {
    return undefined
  }
}

/** 登录页的 state 会话靠 cookie 关联，轮询时要原样带回去 */
function cookiesFrom(response: Response): string {
  const list =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  return list
    .map((item) => item.split(';')[0])
    .filter(Boolean)
    .join('; ')
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface CodeBuddyLoginOptions {
  /** 拿到登录页地址后打开它。主进程里是 shell.openExternal */
  openUrl: (url: string) => Promise<void> | void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** 测试用 */
  pollIntervalMs?: number
  timeoutMs?: number
}

/**
 * 跑一次浏览器登录，返回令牌。
 *
 * 用系统浏览器打开腾讯自己的登录页：用户能看见真实地址栏，
 * 账号密码 / 扫码都发生在腾讯的页面上，不经过我们。
 */
export async function runCodeBuddyLogin(options: CodeBuddyLoginOptions): Promise<OAuthTokens> {
  const fetchImpl = options.fetchImpl ?? fetch
  const { signal } = options

  const stateResponse = await fetchImpl(`${CODEBUDDY_ORIGIN}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: accountHeaders(),
    body: '{}',
    signal
  })
  const cookie = cookiesFrom(stateResponse)
  const stateText = await stateResponse.text()
  if (!stateResponse.ok) {
    throw new CodeBuddyError(`发起 CodeBuddy 登录失败：HTTP ${stateResponse.status}`)
  }
  const stateEnvelope = JSON.parse(stateText) as Envelope
  const stateData = (stateEnvelope.data || {}) as { state?: string; authUrl?: string }
  if (stateEnvelope.code !== CODE_OK || !stateData.state || !stateData.authUrl) {
    throw new CodeBuddyError(
      `发起 CodeBuddy 登录失败：${stateEnvelope.msg || '没有拿到登录地址'}`,
      stateEnvelope.code
    )
  }

  await options.openUrl(stateData.authUrl)

  const state = encodeURIComponent(stateData.state)
  const pollHeaders = { ...accountHeaders(), ...(cookie ? { Cookie: cookie } : {}) }
  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS)

  while (Date.now() < deadline) {
    await wait(options.pollIntervalMs ?? POLL_INTERVAL_MS, signal)

    let tokenData: TokenData
    try {
      tokenData = (await callEnvelope(
        `${CODEBUDDY_ORIGIN}/v2/plugin/auth/token?state=${state}`,
        { method: 'GET', headers: pollHeaders, signal },
        fetchImpl
      )) as TokenData
    } catch (error) {
      if (signal?.aborted) throw error
      // 「登录中」是正常的等待；网络抖一下也别让整次登录失败，继续等到超时
      if (error instanceof CodeBuddyError && error.code !== undefined) {
        if (error.code === CODE_LOGIN_PENDING) continue
        throw error
      }
      continue
    }
    if (!tokenData?.accessToken) continue

    const tokens = toTokens(tokenData)
    // 账号接口在网关后面，拿到 Bearer 之前一律 401，所以放在令牌之后
    try {
      const account = (await callEnvelope(
        `${CODEBUDDY_ORIGIN}/v2/plugin/login/account?state=${state}`,
        {
          method: 'GET',
          headers: { ...pollHeaders, Authorization: `Bearer ${tokens.accessToken}` },
          signal
        },
        fetchImpl
      )) as AccountData
      if (account?.uid) tokens.accountId = account.uid
      if (account?.enterpriseId) tokens.enterpriseId = account.enterpriseId
    } catch {
      // 拿不到账号信息时用 JWT 里的 sub 兜底（toTokens 已经填过）
    }
    return tokens
  }

  throw new CodeBuddyError('CodeBuddy 登录超时，请重试')
}

/** 用 refreshToken 换新令牌。失败抛错，让上层提示重新登录 */
export async function refreshCodeBuddyTokens(
  tokens: OAuthTokens,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthTokens> {
  if (!tokens.refreshToken) throw new CodeBuddyError('没有 refreshToken，需要重新登录')
  const headers: Record<string, string> = {
    ...accountHeaders(),
    'X-Refresh-Token': tokens.refreshToken,
    // 取值照参考实现；抓包只确认了端点与空 body
    'X-Auth-Refresh-Source': 'workbuddy'
  }
  if (tokens.enterpriseId) headers['X-Enterprise-Id'] = tokens.enterpriseId

  try {
    const data = (await callEnvelope(
      `${CODEBUDDY_ORIGIN}/v2/plugin/auth/token/refresh`,
      { method: 'POST', headers, body: '{}' },
      fetchImpl
    )) as TokenData
    return toTokens(data, tokens)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CodeBuddyError(`CodeBuddy 续期失败，请重新登录（${detail}）`)
  }
}

const hex32 = (): string => randomBytes(16).toString('hex')
const hex16 = (): string => randomBytes(8).toString('hex')

/**
 * 对话请求要带的身份头。
 *
 * `Authorization` 不在这里 —— pi 用 apiKey 自己拼。每次调用都生成新的
 * 会话 / 链路 id：抓包证实上游只在这组头**在场**时才开共享前缀缓存，
 * 单独带其中一个不生效；会话级稳定 id 带来的额外命中很有限（上游不缓存
 * 用户独有内容，对官方客户端也一样），不值得为它把会话 id 穿进凭据层。
 */
export function codeBuddyRequestHeaders(tokens: OAuthTokens): Record<string, string> {
  const root = hex32()
  const message = hex32()
  const span = hex16()
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Product': 'SaaS',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': CLIENT_VERSION,
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-Private-Data': 'false',
    'x-codebuddy-request': '1',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': root,
    'X-Conversation-Message-ID': message,
    'X-Request-ID': message,
    'X-Root-Request-ID': root,
    'X-Trace-ID': root,
    traceparent: `00-${root}-${span}-01`,
    b3: `${root}-${span}-1`,
    'X-B3-TraceId': root,
    'X-B3-SpanId': span,
    'X-B3-ParentSpanId': span,
    'X-B3-Sampled': '1'
  }
  const userId = tokens.accountId || userIdFromJwt(tokens.accessToken)
  if (userId) headers['X-User-Id'] = userId
  if (tokens.domain) headers['X-Domain'] = tokens.domain
  if (tokens.enterpriseId) headers['X-Enterprise-Id'] = tokens.enterpriseId
  return headers
}
