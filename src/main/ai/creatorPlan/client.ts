/**
 * 与 Creator Plan 服务端对话：设备授权、拉清单。
 *
 * 地址一律从参数进来（见 endpoint.ts 的说明），fetch 可注入，方便测试。
 * 协议见 Creator Plan 仓库的 docs/protocol/11-connect.md 与 01-plan.md。
 */

import type {
  CreatorPlanDevicePrompt,
  CreatorPlanErrorCode,
  CreatorPlanManifest
} from '../../../shared/creatorPlan'

export class CreatorPlanError extends Error {
  constructor(
    readonly code: CreatorPlanErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CreatorPlanError'
  }
}

type Fetch = typeof fetch

/**
 * 网络错误带上「连的是哪」和「为什么」：只说「连不上」时，用户分不清是服务挂了、
 * 地址配错了，还是开发时忘了设 UEBOX_CREATOR_PLAN_URL。
 */
function networkError(url: string, error: unknown): CreatorPlanError {
  const cause = (error as { cause?: { code?: string } } | null)?.cause?.code
  const reason = cause ?? (error instanceof Error ? error.message : String(error))
  return new CreatorPlanError('network', `${new URL(url).origin}（${reason}）`)
}

interface DeviceStart {
  deviceCode: string
  prompt: CreatorPlanDevicePrompt
  interval: number
  expiresIn: number
}

async function postJson(
  fetchImpl: Fetch,
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  } catch (error) {
    if (signal?.aborted) throw new CreatorPlanError('cancelled', 'Cancelled')
    throw networkError(url, error)
  }
}

export async function startDeviceAuthorization(
  origin: string,
  client: { deviceName: string; clientVersion: string; deviceId?: string },
  fetchImpl: Fetch = fetch
): Promise<DeviceStart> {
  const res = await postJson(fetchImpl, `${origin}/v1/connect/device`, {
    client: 'uebox',
    client_version: client.clientVersion.slice(0, 32),
    device_name: client.deviceName.slice(0, 64),
    // 同一台设备重新授权时服务端吊销它的旧 Key（见 deviceId.ts）
    ...(client.deviceId ? { device_id: client.deviceId } : {})
  })
  if (!res.ok) throw new CreatorPlanError('network', `${origin}（HTTP ${res.status}）`)
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const deviceCode = json?.device_code
  const userCode = json?.user_code
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string') {
    throw new CreatorPlanError('bad_response', 'Malformed device authorization response')
  }
  return {
    deviceCode,
    prompt: {
      userCode,
      verificationUri: String(json?.verification_uri_complete ?? json?.verification_uri ?? '')
    },
    interval: Number(json?.interval) > 0 ? Number(json?.interval) : 5,
    expiresIn: Number(json?.expires_in) > 0 ? Number(json?.expires_in) : 600
  }
}

export interface IssuedKey {
  apiKey: string
  keyName: string
  baseUrl: string
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new CreatorPlanError('cancelled', 'Cancelled'))
      },
      { once: true }
    )
  })

/** 轮询到用户在网页上点了允许（或拒绝 / 过期 / 取消）为止 */
export async function pollForKey(
  origin: string,
  start: Pick<DeviceStart, 'deviceCode' | 'interval' | 'expiresIn'>,
  signal: AbortSignal,
  fetchImpl: Fetch = fetch,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = sleep
): Promise<IssuedKey> {
  let interval = start.interval
  const deadline = Date.now() + start.expiresIn * 1000

  while (Date.now() < deadline) {
    await wait(interval * 1000, signal)
    const res = await postJson(
      fetchImpl,
      `${origin}/v1/connect/token`,
      { device_code: start.deviceCode },
      signal
    )
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null

    if (res.ok) {
      if (typeof json?.api_key !== 'string' || typeof json.base_url !== 'string') {
        throw new CreatorPlanError('bad_response', 'Malformed token response')
      }
      return {
        apiKey: json.api_key,
        keyName: String(json.key_name ?? ''),
        baseUrl: json.base_url
      }
    }

    const code = (json?.error as Record<string, unknown> | undefined)?.code
    if (code === 'authorization_pending') continue
    if (code === 'slow_down') {
      interval += 5
      continue
    }
    if (code === 'access_denied') throw new CreatorPlanError('denied', 'Denied in the browser')
    if (code === 'expired_token') throw new CreatorPlanError('expired', 'The code expired')
    throw new CreatorPlanError('network', `HTTP ${res.status}`)
  }
  throw new CreatorPlanError('expired', 'The code expired')
}

export type ManifestFetch =
  | { status: 'ok'; manifest: CreatorPlanManifest; etag: string | null }
  | { status: 'not_modified' }

/**
 * 拉清单。`baseUrl` 是 `…/v1`。
 *
 * 带了 `etag` 就发 `If-None-Match`，内容没变服务端回 304，这里回 `not_modified`，
 * 由调用方用缓存的那份。拿不带 etag 的时候（连接、预览）永远是 `ok`。
 */
export async function fetchManifestIfChanged(
  baseUrl: string,
  apiKey: string,
  etag: string | null,
  fetchImpl: Fetch = fetch
): Promise<ManifestFetch> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/plan`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(etag ? { 'if-none-match': etag } : {})
      },
      signal: AbortSignal.timeout(15_000)
    })
  } catch (error) {
    throw networkError(`${baseUrl}/plan`, error)
  }
  if (res.status === 304 && etag) return { status: 'not_modified' }
  if (res.status === 401) throw new CreatorPlanError('unauthorized', 'The key was revoked')
  if (!res.ok) throw new CreatorPlanError('network', `HTTP ${res.status}`)

  const json = (await res.json().catch(() => null)) as CreatorPlanManifest | null
  if (!json || json.schema !== 1 || typeof json.roles !== 'object' || !json.plan) {
    throw new CreatorPlanError('bad_response', 'Malformed plan manifest')
  }
  // 响应头的 ETag 带引号（"p-7f3a"），原样回发；没给头就用清单里的
  const header = res.headers?.get('etag')
  return {
    status: 'ok',
    manifest: json,
    etag: header || (json.etag ? `"${json.etag}"` : null)
  }
}

/** 拉清单，不走缓存 */
export async function fetchManifest(
  baseUrl: string,
  apiKey: string,
  fetchImpl: Fetch = fetch
): Promise<CreatorPlanManifest> {
  const result = await fetchManifestIfChanged(baseUrl, apiKey, null, fetchImpl)
  if (result.status !== 'ok') throw new CreatorPlanError('bad_response', 'Unexpected 304')
  return result.manifest
}

/**
 * 用这把 Key 在服务端吊销它自己（11-connect.md「断开」）。
 *
 * 不抛：断网、服务不可用、回了别的状态码都只回 false —— 断开照常进行，
 * 界面提示用户去网页端手动吊销。401 说明它早就失效了，算吊销成功。
 */
export async function revokeKey(
  baseUrl: string,
  apiKey: string,
  fetchImpl: Fetch = fetch
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/auth/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    })
    return res.ok || res.status === 401
  } catch {
    return false
  }
}
