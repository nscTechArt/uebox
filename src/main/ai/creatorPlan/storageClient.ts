/**
 * Box Plan 对象存储的 HTTP 客户端（协议见 Box Plan 仓库 docs/protocol/10-storage.md）。
 *
 *   申请   POST   {BASE}/storage/uploads              已传过直接回 url；没传过回一次性上传地址
 *   上传   PUT    upload.url                          原样带 upload.headers，发文件字节
 *   确认   POST   {BASE}/storage/uploads/{key}/complete
 *   管理   GET    {BASE}/storage/objects[/{key}]、DELETE {BASE}/storage/objects/{key}、GET {BASE}/storage/usage
 *
 * 客户端拿不到存储密钥，只拿一次性的上传地址。`{BASE}` 一律从参数进来（清单的 base_url），
 * 这里不写任何域名；fetch 和上传可注入，方便测试。
 *
 * 错误在这里翻成一句用户看得懂、知道下一步做什么的话（主进程文案和现有对象存储服务一样用中文，
 * 会原样出现在上传进度和发给模型的说明里）。
 */

import { createReadStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

type Fetch = typeof fetch

export interface PlanStorageConnection {
  /** 清单里的 `api.base_url`，形如 `https://…/v1` */
  baseUrl: string
  apiKey: string
}

export type PlanStorageErrorCode =
  | 'unauthorized'
  | 'subscription_inactive'
  | 'storage_quota_exceeded'
  | 'payload_too_large'
  | 'invalid_request'
  | 'not_found'
  | 'network'
  | 'bad_response'
  | 'unknown'

export class PlanStorageError extends Error {
  constructor(
    readonly code: PlanStorageErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'PlanStorageError'
  }
}

export interface PlanUploadTicket {
  exists: boolean
  key: string
  url: string
  expiresAt: string | null
  upload?: {
    method: string
    url: string
    headers: Record<string, string>
  }
}

export interface PlanStoredObject {
  key: string
  url: string
  size: number
  fileName: string | null
  createdAt: string | null
  expiresAt: string | null
}

export interface PlanStorageUsage {
  quotaBytes: number
  usedBytes: number
  objectCount: number
}

const REQUEST_TIMEOUT_MS = 30_000
/** 预签名地址 1 小时有效；再大的文件也该在这之内传完 */
const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)}MB`

/**
 * 服务端的错误翻成人话。402 / 413 / 401 是用户能自己处理的，说清去哪处理；
 * 其余带上状态码和服务端原话，方便排查。
 */
export function describePlanStorageError(
  status: number,
  code: string | undefined,
  serverMessage: string | undefined,
  context: { maxObjectBytes?: number } = {}
): PlanStorageError {
  if (status === 401) {
    return new PlanStorageError(
      'unauthorized',
      'Box Plan 的 Key 失效了，到「设置 → 模型」重新连接',
      status
    )
  }
  if (status === 402 && code === 'storage_quota_exceeded') {
    return new PlanStorageError(
      'storage_quota_exceeded',
      '套餐的对象存储空间用满了：到「设置 → 对象存储」删掉不用的文件，或升级套餐',
      status
    )
  }
  if (status === 402) {
    return new PlanStorageError(
      'subscription_inactive',
      'Box Plan 没有生效的订阅，对象存储暂停上传：续订后再发',
      status
    )
  }
  if (status === 413) {
    const limit = context.maxObjectBytes ? `（${mb(context.maxObjectBytes)}）` : ''
    return new PlanStorageError(
      'payload_too_large',
      `文件超过套餐对象存储的单个文件上限${limit}`,
      status
    )
  }
  if (status === 404) {
    return new PlanStorageError('not_found', serverMessage || '对象不存在', status)
  }
  const detail = [code, serverMessage].filter(Boolean).join(': ')
  return new PlanStorageError(
    status === 400 ? 'invalid_request' : 'unknown',
    `Box Plan 对象存储请求失败（HTTP ${status}${detail ? `，${detail}` : ''}）`,
    status
  )
}

async function failure(
  res: Response,
  context: { maxObjectBytes?: number } = {}
): Promise<PlanStorageError> {
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown }
  } | null
  const code = typeof json?.error?.code === 'string' ? json.error.code : undefined
  const message = typeof json?.error?.message === 'string' ? json.error.message : undefined
  return describePlanStorageError(res.status, code, message, context)
}

function networkError(url: string, error: unknown): PlanStorageError {
  const cause = (error as { cause?: { code?: string } } | null)?.cause?.code
  const reason = cause ?? (error instanceof Error ? error.message : String(error))
  let origin = url
  try {
    origin = new URL(url).origin
  } catch {
    // 地址本身就不对，原样带上
  }
  return new PlanStorageError('network', `连不上 Box Plan（${origin}，${reason}）`)
}

async function call(
  conn: PlanStorageConnection,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  fetchImpl: Fetch = fetch
): Promise<Response> {
  const url = `${conn.baseUrl.replace(/\/+$/, '')}${path}`
  try {
    return await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${conn.apiKey}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw networkError(url, error)
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

function toStoredObject(raw: Record<string, unknown> | null): PlanStoredObject | null {
  const key = str(raw?.key)
  const url = str(raw?.url)
  if (!raw || !key || !url) return null
  return {
    key,
    url,
    size: Number(raw.size) || 0,
    fileName: str(raw.file_name),
    createdAt: str(raw.created_at),
    expiresAt: str(raw.expires_at)
  }
}

/** 第 1 步：申请。同一个文件反复申请拿到的 key、url 都一样 */
export async function requestUpload(
  conn: PlanStorageConnection,
  file: { sha256: string; size: number; contentType: string; fileName?: string },
  context: { maxObjectBytes?: number } = {},
  fetchImpl: Fetch = fetch
): Promise<PlanUploadTicket> {
  const res = await call(
    conn,
    '/storage/uploads',
    {
      method: 'POST',
      headers: { 'idempotency-key': file.sha256 },
      body: {
        sha256: file.sha256,
        size: file.size,
        content_type: file.contentType,
        ...(file.fileName ? { file_name: file.fileName } : {})
      }
    },
    fetchImpl
  )
  if (!res.ok) throw await failure(res, context)
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const key = str(json?.key)
  const url = str(json?.url)
  if (!json || !key || !url) {
    throw new PlanStorageError('bad_response', 'Box Plan 回了无法识别的上传申请结果')
  }
  const expiresAt = str(json.expires_at)
  if (json.exists === true) return { exists: true, key, url, expiresAt }

  const upload = json.upload as Record<string, unknown> | undefined
  const uploadUrl = str(upload?.url)
  if (!uploadUrl) {
    throw new PlanStorageError('bad_response', 'Box Plan 没给上传地址')
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries((upload?.headers as object) ?? {})) {
    if (typeof value === 'string') headers[name] = value
  }
  return {
    exists: false,
    key,
    url,
    expiresAt,
    upload: { method: str(upload?.method) ?? 'PUT', url: uploadUrl, headers }
  }
}

/** 第 3 步：确认。服务端核对大小和哈希，重复确认原样返回同一个结果 */
export async function completeUpload(
  conn: PlanStorageConnection,
  key: string,
  fetchImpl: Fetch = fetch
): Promise<PlanStoredObject> {
  const res = await call(
    conn,
    `/storage/uploads/${encodeURIComponent(key)}/complete`,
    { method: 'POST' },
    fetchImpl
  )
  if (!res.ok) throw await failure(res)
  const object = toStoredObject((await res.json().catch(() => null)) as Record<string, unknown>)
  if (!object) {
    throw new PlanStorageError('bad_response', 'Box Plan 回了无法识别的确认结果')
  }
  return object
}

/** 查单个对象。已删除 / 已到期回 null */
export async function getObject(
  conn: PlanStorageConnection,
  key: string,
  fetchImpl: Fetch = fetch
): Promise<PlanStoredObject | null> {
  const res = await call(conn, `/storage/objects/${encodeURIComponent(key)}`, {}, fetchImpl)
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res)
  return toStoredObject((await res.json().catch(() => null)) as Record<string, unknown>)
}

export async function listObjectsPage(
  conn: PlanStorageConnection,
  cursor: string | null,
  limit = 100,
  fetchImpl: Fetch = fetch
): Promise<{ data: PlanStoredObject[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: String(limit) })
  // 游标是不透明的串，原样放回去
  if (cursor) query.set('cursor', cursor)
  const res = await call(conn, `/storage/objects?${query.toString()}`, {}, fetchImpl)
  if (!res.ok) throw await failure(res)
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!json || !Array.isArray(json.data)) {
    throw new PlanStorageError('bad_response', 'Box Plan 回了无法识别的对象列表')
  }
  const data = json.data
    .map((item) => toStoredObject(item as Record<string, unknown>))
    .filter((item): item is PlanStoredObject => item !== null)
  return { data, nextCursor: json.has_more === true ? str(json.next_cursor) : null }
}

/** 删除。回 false 表示本来就不在了（404），对调用方来说同样算删掉 */
export async function deleteObject(
  conn: PlanStorageConnection,
  key: string,
  fetchImpl: Fetch = fetch
): Promise<boolean> {
  const res = await call(
    conn,
    `/storage/objects/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
    fetchImpl
  )
  if (res.status === 404) return false
  if (!res.ok) throw await failure(res)
  return true
}

export async function getUsage(
  conn: PlanStorageConnection,
  fetchImpl: Fetch = fetch
): Promise<PlanStorageUsage> {
  const res = await call(conn, '/storage/usage', {}, fetchImpl)
  if (!res.ok) throw await failure(res)
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!json || typeof json.used_bytes !== 'number') {
    throw new PlanStorageError('bad_response', 'Box Plan 回了无法识别的用量')
  }
  return {
    quotaBytes: Number(json.quota_bytes) || 0,
    usedBytes: Number(json.used_bytes) || 0,
    objectCount: Number(json.object_count) || 0
  }
}

export type PutFile = (
  upload: NonNullable<PlanUploadTicket['upload']>,
  filePath: string,
  size: number,
  onBytes?: (sent: number, total: number) => void
) => Promise<void>

/**
 * 第 2 步：按申请回来的方法、地址、请求头原样发文件字节。
 *
 * 不用 fetch：流式请求体在 fetch 里只能分块传输，预签名 PUT 要的是明确的 Content-Length；
 * 而几百 MB 的视频也不该整个读进内存。和 s3Client 的上传同一个做法，边读边数给进度。
 */
export const putFile: PutFile = (upload, filePath, size, onBytes) => {
  const url = new URL(upload.url)
  const send = url.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise<void>((resolve, reject) => {
    const request = send(
      url,
      {
        method: upload.method,
        headers: { ...upload.headers, 'content-length': String(size) },
        timeout: UPLOAD_TIMEOUT_MS
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) return resolve()
          const body = Buffer.concat(chunks).toString('utf-8').slice(0, 300)
          reject(
            new PlanStorageError(
              status === 413 ? 'payload_too_large' : 'unknown',
              `上传到 Box Plan 失败（HTTP ${status}${body ? `，${body}` : ''}）`,
              status
            )
          )
        })
        response.on('error', reject)
      }
    )
    request.on('timeout', () => request.destroy(new Error('上传超时')))
    request.on('error', (error) => reject(networkError(upload.url, error)))

    let sent = 0
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => {
      sent += (chunk as Buffer).length
      onBytes?.(sent, size)
    })
    stream.on('error', (error) => request.destroy(error))
    stream.pipe(request)
  })
}
