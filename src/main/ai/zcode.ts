import { randomBytes } from 'crypto'
import { setTimeout as delay } from 'timers/promises'
import type { ProviderStreams } from '@earendil-works/pi-ai'
import type { OAuthTokens } from './oauth'

/**
 * ZCode subscription transport. Protocol reference (not vendored code):
 * https://github.com/maskeb34/zcode/tree/1-2 (app/oauth.py, agent.py, routes/gateway.py).
 * Uses only the ZCode JWT route; never exchanges a paid API key or falls back to one.
 * The upstream has no documented refresh endpoint: expired tokens require signing in again.
 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'
export const ZCODE_BASE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic`
const MESSAGES_PATH = '/api/v1/zcode-plan/anthropic/v1/messages'

export function isZCodeEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return (
      url.origin === ZCODE_ORIGIN &&
      url.pathname.replace(/\/$/, '') === new URL(ZCODE_BASE_URL).pathname
    )
  } catch {
    return false
  }
}

/** Shape/expiry check, not signature verification; authentication remains the server's job. */
export function zcodeTokens(token: string): OAuthTokens {
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    throw new Error('ZCode requires a Coding Plan JWT. Sign in to ZCode again.')
  }
  let payload: { exp?: unknown }
  try {
    payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid ZCode token. Sign in to ZCode again.')
  }
  const expiresAt = typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    throw new Error('ZCode token expired. Sign in to ZCode again.')
  }
  return { accessToken: token, ...(expiresAt ? { expiresAt } : {}) }
}

export async function runZCodeLogin(options: {
  openUrl: (url: string) => Promise<void> | void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  timeoutMs?: number
}): Promise<OAuthTokens> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? 5 * 60_000)
  ])
  const pollKey = randomBytes(32).toString('hex')
  const headers = { Authorization: `Bearer ${pollKey}`, 'Content-Type': 'application/json' }
  const request = async (path: string, body?: object): Promise<Record<string, unknown>> => {
    signal.throwIfAborted()
    const response = await fetchImpl(`${ZCODE_ORIGIN}/api/v1/oauth/cli/${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      signal,
      redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    if (!response.ok) throw new Error(`ZCode sign-in failed (HTTP ${response.status}).`)
    const envelope = (await response.json()) as { data?: Record<string, unknown> }
    if (!envelope?.data || typeof envelope.data !== 'object') {
      throw new Error('ZCode sign-in returned an invalid response.')
    }
    return envelope.data
  }
  const init = await request('init', { provider: 'zai' })
  if (typeof init.flow_id !== 'string' || !init.flow_id || typeof init.authorize_url !== 'string') {
    throw new Error('ZCode sign-in did not return an authorization URL.')
  }
  const authorize = new URL(init.authorize_url)
  if (
    authorize.protocol !== 'https:' ||
    authorize.username ||
    authorize.password ||
    !(authorize.hostname === 'z.ai' || authorize.hostname.endsWith('.z.ai'))
  ) {
    throw new Error('ZCode returned an untrusted authorization URL.')
  }
  signal.throwIfAborted()
  await options.openUrl(authorize.toString())
  while (true) {
    await delay(options.pollIntervalMs ?? 1500, undefined, { signal })
    const result = await request(`poll/${encodeURIComponent(init.flow_id)}`)
    if (result.status === 'ready') {
      if (typeof result.token !== 'string') {
        throw new Error(
          'ZCode did not return a Coding Plan token. Authorize your account in ZCode first.'
        )
      }
      return zcodeTokens(result.token)
    }
    if (result.status !== 'pending')
      throw new Error('ZCode authorization failed or expired. Sign in again.')
  }
}

interface Verification {
  get: () => Promise<string | undefined>
  invalidate: () => Promise<void> | void
}

const verification: Verification = {
  get: async () => (await import('./zcodeCaptcha')).getZCodeVerification(),
  invalidate: async () => (await import('./zcodeCaptcha')).invalidateZCodeVerification()
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

const MODEL_IDS: Record<string, string> = {
  'glm-5.2': 'GLM-5.2',
  'glm-5-turbo': 'GLM-5-Turbo',
  'glm-turbo': 'GLM-5-Turbo',
  'glm-5.1': 'GLM-5.1',
  'glm-4.7': 'GLM-4.7'
}

/** Adapt just HTTP auth/headers. Anthropic serialization, SSE and tool results stay in pi. */
export function zcodeFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
  captcha: Verification = verification
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (
      url.origin !== ZCODE_ORIGIN ||
      url.pathname !== MESSAGES_PATH ||
      request.method !== 'POST'
    ) {
      throw new Error('ZCode subscription requests must use the ZCode Messages endpoint.')
    }
    request.signal.throwIfAborted()
    const headers = new Headers(request.headers)
    const token =
      headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    zcodeTokens(token)
    headers.delete('x-api-key')
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('User-Agent', 'ZCode/3.0.1')
    headers.set('X-ZCode-App-Version', '3.0.1')
    headers.set('X-ZCode-Agent', 'glm')
    headers.set('HTTP-Referer', `${ZCODE_ORIGIN}/`)
    headers.set('anthropic-version', '2023-06-01')
    headers.delete('content-length')
    const body = (await request.json()) as Record<string, unknown>
    if (typeof body.model === 'string')
      body.model = MODEL_IDS[body.model.toLowerCase()] ?? body.model
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map((message) =>
        typeof message.content === 'string'
          ? { ...message, content: [{ type: 'text', text: message.content }] }
          : message
      )
    }
    for (let attempt = 0; ; attempt++) {
      request.signal.throwIfAborted()
      const param = await abortable(captcha.get(), request.signal)
      request.signal.throwIfAborted()
      if (param) headers.set('X-Aliyun-Captcha-Verify-Param', param)
      else headers.delete('X-Aliyun-Captcha-Verify-Param')
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
        redirect: 'error'
      })
      if (response.status !== 403 || attempt > 0) return response
      const detail = await response.clone().text()
      if (!/captcha|verify token|verify failed/i.test(detail)) return response
      await response.body?.cancel()
      await captcha.invalidate()
    }
  }
}

/** Installed on the provider, so agent turns, one-shot completions and probes use one path. */
export function withZCodeTransport(streams: ProviderStreams): ProviderStreams {
  return {
    ...streams,
    stream: (model, context, options) =>
      streams.stream(model, context, {
        ...options,
        fetch: zcodeFetch(options?.fetch)
      }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, {
        ...options,
        fetch: zcodeFetch(options?.fetch)
      })
  }
}
