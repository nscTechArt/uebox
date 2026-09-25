/**
 * 对一台服务端资产库发请求的最小 HTTP 客户端（主进程）。
 *
 * 为什么不用全局 fetch：全局 fetch 被 systemProxyFetch 换成了按系统代理分流的实现，
 * 而这里要做两件它做不到的事 ——
 *
 * 1. **只信这台主机的部署 CA**（`pinned-ca`）：Node 的 https 可以按请求给 `ca`，
 *    这张 CA 只进这个客户端的 Agent，不进系统信任库，也不影响别的连接。
 * 2. **区分"路由不存在"和"东西不存在"**：服务端还在分切片交付（预览、SSE、注释、
 *    闭包都在别的分支上做），缺的路由回的是空体 404/405；真正的"找不到"回的是
 *    `{"error": ...}`。界面据前者隐藏功能，据后者报错。
 *
 * 这里所有工作都与一页数据同量级：发请求、收一个 ≤200 行的 JSON。表规模的活
 * 一律在服务端做（ADR 0008），主线程不会因为库大而变慢。
 */
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import type { CatalogTrust } from '../../shared/catalogLibrary'

export type CatalogErrorCode =
  | 'route-missing'
  | 'not-found'
  | 'unauthorized'
  | 'forbidden'
  | 'bad-request'
  | 'conflict'
  | 'gone'
  | 'throttled'
  | 'unavailable'
  | 'server'
  | 'network'
  | 'tls'
  | 'timeout'
  | 'aborted'
  | 'insecure'

export class CatalogHttpError extends Error {
  readonly status: number
  readonly code: CatalogErrorCode
  readonly retryAfterMs: number | null
  /** 网络错误的系统错误码（ECONNREFUSED、ECONNRESET…） */
  readonly errno: string | null

  constructor(
    code: CatalogErrorCode,
    status: number,
    message: string,
    retryAfterMs: number | null = null,
    errno: string | null = null
  ) {
    super(message)
    this.name = 'CatalogHttpError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
    this.errno = errno
  }

  /** 断网、超时、服务端挂了：可以拿本机旧页兜底 */
  get offline(): boolean {
    return this.code === 'network' || this.code === 'timeout' || this.code === 'unavailable'
  }

  /**
   * 请求肯定没到服务端（连不上、域名解析失败）。
   * 刷新令牌只有在这种情况下才能拿同一个令牌再试：服务端收到过的话，旧令牌已经换掉了，
   * 再出示一次会吊销整族会话（client.md "Member sign-in" 第 6 条）。
   */
  get neverSent(): boolean {
    return (
      this.code === 'network' &&
      [
        'ECONNREFUSED',
        'ENOTFOUND',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EAI_AGAIN',
        'EADDRNOTAVAIL'
      ].includes(this.errno ?? '')
    )
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * 地址 + 信任方式是否说得通。明文 http 只在回环上允许 —— 与服务端自己的规则一致
 * （非回环地址不开 TLS 就拒绝启动），bearer 令牌不能在局域网上明文走。
 */
export function assertTransportAllowed(url: URL, trust: CatalogTrust): void {
  if (url.username || url.password) {
    throw new CatalogHttpError('insecure', 0, 'Server address must not embed credentials')
  }
  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) {
      throw new CatalogHttpError(
        'insecure',
        0,
        'Plain http is only allowed on this machine (loopback); use https for a server elsewhere'
      )
    }
    return
  }
  if (url.protocol !== 'https:') {
    throw new CatalogHttpError('insecure', 0, `Unsupported protocol ${url.protocol}`)
  }
  if (trust.kind === 'loopback-http') {
    throw new CatalogHttpError('insecure', 0, 'https address configured with loopback-http trust')
  }
}

export interface RequestOptions {
  method?: string
  query?: Record<string, string | number | boolean | null | undefined>
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /** 不带 Authorization（签名预览地址、well-known） */
  anonymous?: boolean
}

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export type TokenProvider = () => Promise<string | null>

const DEFAULT_TIMEOUT_MS = 15_000
/** 一页 JSON 不会超过这个量；超了说明对面不是我们以为的服务 */
const MAX_JSON_BYTES = 32 * 1024 * 1024

export function buildUrl(base: string, path: string, query?: RequestOptions['query']): URL {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

function looksLikeJsonError(body: Buffer): string | null {
  if (body.length === 0 || body.length > 64 * 1024) return null
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { error?: unknown; message?: unknown }
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.error === 'string') return parsed.error
      if (typeof parsed.message === 'string') return parsed.message
      return ''
    }
  } catch {
    // 不是 JSON
  }
  return null
}

/** 把状态码和响应体翻成错误码；导出给测试用 */
export function classifyFailure(
  status: number,
  headers: http.IncomingHttpHeaders,
  body: Buffer
): CatalogHttpError {
  const jsonMessage = looksLikeJsonError(body)
  const text = jsonMessage ?? body.toString('utf8').slice(0, 300)
  const message = text || `HTTP ${status}`
  switch (status) {
    case 400:
      return new CatalogHttpError('bad-request', status, message)
    case 401:
      return new CatalogHttpError('unauthorized', status, message)
    case 403:
      return new CatalogHttpError('forbidden', status, message)
    case 404:
      // 空体（或非 JSON）的 404 = 这台服务端还没有这条路由
      return new CatalogHttpError(
        jsonMessage === null ? 'route-missing' : 'not-found',
        status,
        message
      )
    case 405:
    case 501:
      return new CatalogHttpError('route-missing', status, message)
    case 409:
      return new CatalogHttpError('conflict', status, message)
    case 410:
      return new CatalogHttpError('gone', status, message)
    case 429: {
      const retry = Number(headers['retry-after'])
      return new CatalogHttpError(
        'throttled',
        status,
        message,
        Number.isFinite(retry) ? retry * 1000 : 1000
      )
    }
    case 502:
    case 503:
    case 504:
      return new CatalogHttpError('unavailable', status, message)
    default:
      return new CatalogHttpError(status >= 500 ? 'server' : 'bad-request', status, message)
  }
}

function tlsErrorCode(error: NodeJS.ErrnoException): boolean {
  const code = String(error.code ?? '')
  return (
    code.startsWith('ERR_TLS') ||
    code.includes('CERT') ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
  )
}

export class CatalogHttp {
  readonly base: string
  private readonly tokenProvider: TokenProvider | null
  private readonly agent: http.Agent | https.Agent

  constructor(base: string, trust: CatalogTrust, tokenProvider: TokenProvider | null = null) {
    const url = new URL(base)
    assertTransportAllowed(url, trust)
    this.base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
    this.tokenProvider = tokenProvider
    this.agent =
      url.protocol === 'https:'
        ? new https.Agent({
            keepAlive: true,
            maxSockets: 8,
            ...(trust.kind === 'pinned-ca' ? { ca: [trust.caPem] } : {})
          })
        : new http.Agent({ keepAlive: true, maxSockets: 8 })
  }

  destroy(): void {
    this.agent.destroy()
  }

  /** 发请求，拿原始字节（预览图、SSE 之外的一切都走这里） */
  async raw(path: string, options: RequestOptions = {}): Promise<RawResponse> {
    const url = buildUrl(this.base, path, options.query)
    // 相对路径拼出来的地址必须仍在这台服务端上：签名预览地址是服务端给的，
    // 但别让一个绝对地址把令牌带去别处。
    if (`${url.protocol}//${url.host}` !== new URL(this.base).origin) {
      throw new CatalogHttpError('insecure', 0, 'Refusing to send a request to another host')
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      'accept-encoding': 'identity',
      ...options.headers
    }
    if (!options.anonymous && this.tokenProvider) {
      const token = await this.tokenProvider()
      if (token) headers.authorization = `Bearer ${token}`
    }
    let payload: Buffer | null = null
    if (options.body !== undefined) {
      payload = Buffer.from(JSON.stringify(options.body), 'utf8')
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const lib = url.protocol === 'https:' ? https : http
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return await new Promise<RawResponse>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new CatalogHttpError('aborted', 0, 'aborted'))
        return
      }
      const request = lib.request(
        url,
        { method: options.method ?? 'GET', headers, agent: this.agent },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (
              size > MAX_JSON_BYTES &&
              !String(response.headers['content-type'] ?? '').startsWith('image/')
            ) {
              request.destroy(
                new CatalogHttpError('server', response.statusCode ?? 0, 'Response too large')
              )
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks)
            })
          })
          response.on('error', (error) => reject(error))
        }
      )
      const onAbort = (): void => {
        request.destroy(new CatalogHttpError('aborted', 0, 'aborted'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      request.setTimeout(timeoutMs, () => {
        request.destroy(new CatalogHttpError('timeout', 0, `No answer within ${timeoutMs} ms`))
      })
      request.on('error', (error: NodeJS.ErrnoException) => {
        options.signal?.removeEventListener('abort', onAbort)
        if (error instanceof CatalogHttpError) {
          reject(error)
        } else if (tlsErrorCode(error)) {
          reject(new CatalogHttpError('tls', 0, `TLS verification failed: ${error.message}`))
        } else {
          reject(new CatalogHttpError('network', 0, error.message, null, error.code ?? null))
        }
      })
      request.on('close', () => options.signal?.removeEventListener('abort', onAbort))
      if (payload) request.write(payload)
      request.end()
    })
  }

  /** JSON 请求：2xx 回解析后的对象，其余抛 CatalogHttpError */
  async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    let attempt = 0
    for (;;) {
      const response = await this.raw(path, options)
      if (response.status >= 200 && response.status < 300) {
        if (response.body.length === 0) return {} as T
        try {
          return JSON.parse(response.body.toString('utf8')) as T
        } catch {
          throw new CatalogHttpError('server', response.status, 'Server answered with invalid JSON')
        }
      }
      const failure = classifyFailure(response.status, response.headers, response.body)
      // 429 按服务端说的等一等再试一次（失败认证限流时正确的凭据也会被拒，应当重试）
      if (failure.code === 'throttled' && attempt < 2 && !options.signal?.aborted) {
        attempt += 1
        await new Promise((done) =>
          setTimeout(done, Math.min(failure.retryAfterMs ?? 1000, 10_000))
        )
        continue
      }
      throw failure
    }
  }

  /**
   * 长连接流（SSE）。回调收每一块原始文本；返回一个关掉它的函数。
   * 出错或对面关连接时调 onEnd，重连由调用方决定。
   */
  stream(
    path: string,
    options: RequestOptions & {
      onOpen: (status: number) => void
      onChunk: (text: string) => void
      onEnd: (error: CatalogHttpError | null) => void
    }
  ): () => void {
    let closed = false
    let request: http.ClientRequest | null = null
    const finish = (error: CatalogHttpError | null): void => {
      if (closed) return
      closed = true
      options.onEnd(error)
    }
    void (async () => {
      const url = buildUrl(this.base, path, options.query)
      const headers: Record<string, string> = { accept: 'text/event-stream', ...options.headers }
      if (!options.anonymous && this.tokenProvider) {
        const token = await this.tokenProvider().catch(() => null)
        if (token) headers.authorization = `Bearer ${token}`
      }
      if (closed) return
      const lib = url.protocol === 'https:' ? https : http
      request = lib.request(url, { method: 'GET', headers, agent: this.agent }, (response) => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            finish(classifyFailure(status, response.headers, Buffer.concat(chunks)))
          )
          return
        }
        options.onOpen(status)
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          if (!closed) options.onChunk(chunk)
        })
        response.on('end', () => finish(null))
        response.on('error', (error) => finish(new CatalogHttpError('network', 0, error.message)))
      })
      // SSE 每 15 秒一次心跳；45 秒没动静就当断了
      request.setTimeout(options.timeoutMs ?? 45_000, () => {
        request?.destroy(new CatalogHttpError('timeout', 0, 'event stream idle'))
      })
      request.on('error', (error: NodeJS.ErrnoException) => {
        finish(
          error instanceof CatalogHttpError
            ? error
            : new CatalogHttpError('network', 0, error.message)
        )
      })
      request.end()
    })().catch((error: unknown) => {
      finish(
        new CatalogHttpError('network', 0, error instanceof Error ? error.message : String(error))
      )
    })
    return () => {
      if (closed) return
      closed = true
      request?.destroy()
    }
  }
}
