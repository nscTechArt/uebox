/**
 * 一台服务器上的登录会话：给每个请求、每次 lore.exe 调用一个新鲜的身份令牌。
 *
 * 按设计 3.8（team-service 成员面，端口 8084，与本分支并行开发中）：
 *
 * - `POST /v1/auth/login {member, password, sessionLabel}` /
 *   `POST /v1/auth/enroll {code, password, sessionLabel}` →
 *   `{identityToken, refreshToken, expires}`
 * - `POST /v1/auth/refresh {refreshToken}`：每用一次换一个新的刷新令牌；旧的再用一次
 *   整族吊销 —— 所以**先把新刷新令牌落盘，再用新身份令牌**，并且同一时刻只允许一次刷新。
 * - 身份令牌用到寿命的 80% 就换。
 *
 * 成员面还没上线之前，也支持直接粘贴身份令牌（实验环境打印的那种）：这时没有刷新，
 * 令牌过期就提示重新粘贴。
 */
import type { CatalogAuthMode } from '../../shared/catalogLibrary'
import { CatalogHttp, CatalogHttpError } from './http'
import type { SecretStore } from './secrets'

export interface TokenGrant {
  identityToken: string
  refreshToken: string | null
  /** 身份令牌过期时刻（毫秒）；不知道就 null */
  expiresMs: number | null
}

export interface WellKnownAuth {
  login?: string
  refresh?: string
  enroll?: string
  logout?: string
  me?: string
}

/** 服务端给的 `expires` 可能是秒也可能是毫秒 */
export function expiresToMs(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

/** 不验签，只读 JWT 里的 exp / sub，用来提前换令牌和显示是谁 */
export function decodeJwtClaims(token: string): {
  exp: number | null
  sub: string | null
  iat: number | null
} {
  const parts = token.split('.')
  if (parts.length < 2) return { exp: null, sub: null, iat: null }
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8'
    )
    const claims = JSON.parse(json) as { exp?: unknown; sub?: unknown; iat?: unknown }
    return {
      exp: typeof claims.exp === 'number' ? claims.exp * 1000 : null,
      sub: typeof claims.sub === 'string' ? claims.sub : null,
      iat: typeof claims.iat === 'number' ? claims.iat * 1000 : null
    }
  } catch {
    return { exp: null, sub: null, iat: null }
  }
}

export function parseGrant(body: Record<string, unknown>): TokenGrant {
  const identityToken =
    (typeof body.identityToken === 'string' && body.identityToken) ||
    (typeof body.token === 'string' && body.token) ||
    ''
  if (!identityToken)
    throw new CatalogHttpError('server', 200, 'Login answer carried no identity token')
  const refreshToken =
    typeof body.refreshToken === 'string' && body.refreshToken ? body.refreshToken : null
  const expiresMs = expiresToMs(body.expires) ?? decodeJwtClaims(identityToken).exp
  return { identityToken, refreshToken, expiresMs }
}

/** 到寿命的 80% 就该换了（不知道寿命时按 15 分钟算） */
export function shouldRefresh(
  grant: { expiresMs: number | null; issuedMs: number },
  now: number
): boolean {
  const lifetime = grant.expiresMs !== null ? grant.expiresMs - grant.issuedMs : 15 * 60 * 1000
  return now >= grant.issuedMs + lifetime * 0.8
}

export class SignedOutError extends Error {
  constructor(message = 'Not signed in to this server') {
    super(message)
    this.name = 'SignedOutError'
  }
}

export class CatalogSession {
  private current: { token: string; expiresMs: number | null; issuedMs: number } | null = null
  private refreshing: Promise<string> | null = null
  /** 上一次刷新结果不明（见 refresh()）：刷新令牌已丢弃，等身份令牌过期后要求重新登录 */
  ambiguousRefresh = false

  constructor(
    private readonly serverId: string,
    private readonly mode: CatalogAuthMode,
    private readonly memberHttp: CatalogHttp | null,
    private readonly auth: WellKnownAuth,
    private readonly secrets: SecretStore,
    private readonly sessionLabel: string,
    private readonly now: () => number = Date.now
  ) {}

  /** 成员面上某条路由的路径（well-known 给了就用它的，只取路径部分） */
  route(kind: keyof WellKnownAuth, fallback: string): string {
    const value = this.auth[kind]
    if (!value) return fallback
    // well-known 给的可能是完整地址；只取路径，主机必须是成员面自己
    try {
      const url = new URL(value)
      return `${url.pathname}${url.search}`
    } catch {
      return value
    }
  }

  async signedIn(): Promise<boolean> {
    const secret = await this.secrets.get(this.serverId)
    return this.mode === 'token' ? Boolean(secret?.identityToken) : Boolean(secret?.refreshToken)
  }

  /** 登录或邀请码注册，成功后落盘刷新令牌 */
  async signIn(input: {
    member?: string | null
    password: string
    inviteCode?: string | null
  }): Promise<string | null> {
    if (!this.memberHttp) throw new SignedOutError('This server has no member sign-in surface')
    const body = input.inviteCode
      ? await this.memberHttp.json<Record<string, unknown>>(
          this.route('enroll', '/v1/auth/enroll'),
          {
            method: 'POST',
            anonymous: true,
            body: {
              code: input.inviteCode,
              password: input.password,
              sessionLabel: this.sessionLabel
            }
          }
        )
      : await this.memberHttp.json<Record<string, unknown>>(this.route('login', '/v1/auth/login'), {
          method: 'POST',
          anonymous: true,
          body: { member: input.member, password: input.password, sessionLabel: this.sessionLabel }
        })
    const grant = parseGrant(body)
    if (!grant.refreshToken)
      throw new CatalogHttpError('server', 200, 'Login answer carried no refresh token')
    await this.secrets.set(this.serverId, { refreshToken: grant.refreshToken })
    this.current = { token: grant.identityToken, expiresMs: grant.expiresMs, issuedMs: this.now() }
    const member = typeof body.member === 'string' ? body.member : null
    return member ?? decodeJwtClaims(grant.identityToken).sub ?? input.member ?? null
  }

  /** 保存粘贴的身份令牌 */
  async useIdentityToken(token: string): Promise<string | null> {
    const trimmed = token.trim().replace(/^Bearer\s+/i, '')
    if (!trimmed) throw new SignedOutError('Empty token')
    await this.secrets.set(this.serverId, { identityToken: trimmed })
    const claims = decodeJwtClaims(trimmed)
    this.current = { token: trimmed, expiresMs: claims.exp, issuedMs: claims.iat ?? this.now() }
    return claims.sub
  }

  async signOut(): Promise<void> {
    const secret = await this.secrets.get(this.serverId)
    if (this.mode === 'password' && secret?.refreshToken && this.memberHttp) {
      await this.memberHttp
        .json(this.route('logout', '/v1/auth/logout'), {
          method: 'POST',
          anonymous: true,
          body: { refreshToken: secret.refreshToken },
          timeoutMs: 5000
        })
        .catch(() => undefined)
    }
    this.current = null
    await this.secrets.set(this.serverId, null)
  }

  /** 当前可用的身份令牌；需要时换新。没登录抛 SignedOutError */
  async identityToken(): Promise<string> {
    const now = this.now()
    if (this.mode === 'token') {
      if (!this.current) {
        const secret = await this.secrets.get(this.serverId)
        if (!secret?.identityToken) throw new SignedOutError()
        const claims = decodeJwtClaims(secret.identityToken)
        this.current = {
          token: secret.identityToken,
          expiresMs: claims.exp,
          issuedMs: claims.iat ?? now
        }
      }
      if (this.current.expiresMs !== null && now >= this.current.expiresMs) {
        throw new SignedOutError('The pasted identity token has expired; paste a new one')
      }
      return this.current.token
    }
    if (this.current && !shouldRefresh(this.current, now)) return this.current.token
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null
      })
    }
    return await this.refreshing
  }

  private async refresh(): Promise<string> {
    if (!this.memberHttp) throw new SignedOutError()
    const secret = await this.secrets.get(this.serverId)
    if (!secret?.refreshToken) {
      // 刷新令牌因为上次结果不明被丢弃了：手上的身份令牌用到过期为止
      if (this.current && this.current.expiresMs !== null && this.now() < this.current.expiresMs) {
        return this.current.token
      }
      throw new SignedOutError()
    }
    let body: Record<string, unknown>
    try {
      body = await this.memberHttp.json<Record<string, unknown>>(
        this.route('refresh', '/v1/auth/refresh'),
        {
          method: 'POST',
          anonymous: true,
          body: { refreshToken: secret.refreshToken }
        }
      )
    } catch (error) {
      if (
        error instanceof CatalogHttpError &&
        (error.code === 'unauthorized' || error.code === 'forbidden')
      ) {
        // 刷新令牌被吊销或过期：清掉，界面提示重新登录
        this.current = null
        await this.secrets.set(this.serverId, null)
        throw new SignedOutError('Session expired; sign in again')
      }
      const stillValid =
        this.current !== null &&
        (this.current.expiresMs === null || this.now() < this.current.expiresMs)
      if (error instanceof CatalogHttpError && !error.neverSent && error.code !== 'throttled') {
        // 请求可能已经到了服务端（超时、连接被重置、5xx）：旧刷新令牌也许已经换掉了，
        // 再出示一次会吊销整族会话。宁可让用户重新登录一次，也不拿它再试。
        // 手上的身份令牌还没过期就先用到过期为止。
        this.ambiguousRefresh = true
        await this.secrets.set(this.serverId, null)
        if (stillValid && this.current) return this.current.token
        this.current = null
        throw new SignedOutError('Session refresh was interrupted; sign in again')
      }
      // 请求肯定没发出去（连不上）：刷新令牌还是好的，手上的身份令牌没过期就先用着
      if (stillValid && this.current) return this.current.token
      throw error
    }
    const grant = parseGrant(body)
    // 先落盘新刷新令牌：旧的已经作废，丢了新的就只能重新登录
    if (grant.refreshToken)
      await this.secrets.set(this.serverId, { refreshToken: grant.refreshToken })
    this.current = { token: grant.identityToken, expiresMs: grant.expiresMs, issuedMs: this.now() }
    return grant.identityToken
  }

  /** 服务端回 401 时调：丢掉内存里的身份令牌，下次强制换新 */
  invalidate(): void {
    if (this.mode === 'password') this.current = null
  }
}
