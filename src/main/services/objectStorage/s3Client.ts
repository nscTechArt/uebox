/**
 * 最小的 S3 兼容客户端：签名、上传、列举、删除、预签名下载链接。
 *
 * 不引 `@aws-sdk/client-s3`：它是几十个包的依赖树，而这里只用得上五个动作。
 * SigV4 本身就是几次 HMAC —— 阿里云 OSS、腾讯云 COS、Cloudflare R2、MinIO
 * 的 S3 兼容接口都认同一套签名，写一份就都能用。
 *
 * 这个文件只做协议，不碰配置文件和密钥存储 —— 那是 `objectStorageService.ts` 的事。
 */

import { createHash, createHmac } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

export interface S3Target {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

export interface S3ListedObject {
  key: string
  size: number
  lastModified: string
}

/** 有些厂商（OSS、COS）的 S3 接口也认这个，省得上传前把整个文件读一遍算哈希 */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const REQUEST_TIMEOUT_MS = 30_000
/** 上传不设短超时：几百 MB 的视频走家用上行要好几分钟 */
const UPLOAD_TIMEOUT_MS = 30 * 60_000
/** 预签名链接的最长有效期，SigV4 上限就是 7 天 */
export const MAX_PRESIGN_SECONDS = 7 * 24 * 3600

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/** RFC 3986 编码。`encodeURIComponent` 放过了 `!'()*`，SigV4 不放过 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/** 对象键逐段编码，保留 `/` */
function encodeKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/')
}

/** `20260923T041500Z` 与 `20260923` */
function amzDates(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

/** 对象在这个桶里的完整地址（未签名） */
export function objectUrl(target: S3Target, key = ''): URL {
  const endpoint = new URL(target.endpoint.trim().replace(/\/+$/, ''))
  const encodedKey = key ? `/${encodeKey(key)}` : '/'
  // IP 地址没法加桶名当子域名：`bucket.10.0.0.5` 不是合法主机名，URL 会**静默**不改，
  // 桶名就这么丢了 —— 请求打到服务根上，报一句「桶不存在」却查不出为什么。IP 一律走路径式
  const ipHost = isIP(endpoint.hostname.replace(/^\[|\]$/g, '')) !== 0
  if (target.forcePathStyle || ipHost) {
    const base = endpoint.pathname.replace(/\/+$/, '')
    endpoint.pathname = `${base}/${encodeRfc3986(target.bucket)}${encodedKey === '/' ? '/' : encodedKey}`
  } else {
    endpoint.hostname = `${target.bucket}.${endpoint.hostname}`
    endpoint.pathname = encodedKey
  }
  return endpoint
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function signingKey(target: S3Target, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${target.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, target.region)
  const kService = hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

/**
 * 给一次请求签名，返回要带上的请求头。
 * @param headers 要参与签名的额外请求头（小写键）
 */
export function signRequest(
  target: S3Target,
  method: string,
  url: URL,
  payloadHash: string,
  headers: Record<string, string> = {},
  now = new Date()
): Record<string, string> {
  const { amzDate, dateStamp } = amzDates(now)
  const allHeaders: Record<string, string> = {
    ...headers,
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  }
  const names = Object.keys(allHeaders)
    .map((name) => name.toLowerCase())
    .sort()
  const lower = Object.fromEntries(
    Object.entries(allHeaders).map(([k, v]) => [k.toLowerCase(), String(v).trim()])
  )
  const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')
  const scope = `${dateStamp}/${target.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(target, dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex')

  // host 由 HTTP 层按 URL 自己带，重复给反而可能和它打架
  const sendHeaders = { ...lower }
  delete sendHeaders.host
  return {
    ...sendHeaders,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}

/**
 * 预签名的 GET 链接。
 *
 * `signedAt` 由调用方给定，**同一个时刻签出来的链接逐字相同** —— 这件事很要紧：
 * 链接留在对话里，每轮原样重发，字节一变厂商的前缀缓存就断了。
 */
export function presignGetUrl(
  target: S3Target,
  key: string,
  signedAt: Date,
  expiresSeconds = MAX_PRESIGN_SECONDS
): string {
  const url = objectUrl(target, key)
  const { amzDate, dateStamp } = amzDates(signedAt)
  const scope = `${dateStamp}/${target.region}/s3/aws4_request`
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set('X-Amz-Credential', `${target.accessKeyId}/${scope}`)
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', String(Math.min(expiresSeconds, MAX_PRESIGN_SECONDS)))
  url.searchParams.set('X-Amz-SignedHeaders', 'host')
  const canonicalRequest = [
    'GET',
    url.pathname,
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(target, dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex')
  // 查询串按规范顺序重排一遍再拼签名：厂商按收到的顺序重算，顺序不能漂
  return `${url.origin}${url.pathname}?${canonicalQuery(url.searchParams)}&X-Amz-Signature=${signature}`
}

/** 把厂商回的 XML 错误翻成一句人话 */
async function describeFailure(response: Response, action: string): Promise<Error> {
  const body = await response.text().catch(() => '')
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1]
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1]
  const hint =
    code === 'SignatureDoesNotMatch'
      ? '（签名不对：多半是 Secret 填错，或 region 与桶所在地域不一致）'
      : code === 'NoSuchBucket'
        ? '（桶不存在：检查桶名和 endpoint 的地域）'
        : code === 'AccessDenied'
          ? '（没有权限：这对密钥需要对该桶的读、写、列举、删除权限）'
          : ''
  return new Error(
    `${action}失败：HTTP ${response.status}${code ? ` ${code}` : ''}${message ? ` ${message}` : ''}${hint}`
  )
}

/**
 * 流式上传一个本地文件。
 *
 * 不用 fetch：S3 的 PUT 必须带 `Content-Length`（不收分块传输，回 411），
 * 而 fetch 发流式请求体时这个头不由我们说了算。`http(s).request` 可以明确给定。
 */
export async function putObjectFromFile(
  target: S3Target,
  key: string,
  filePath: string,
  size: number,
  contentType: string,
  onBytes?: (sent: number, total: number) => void
): Promise<void> {
  const url = objectUrl(target, key)
  const headers = signRequest(target, 'PUT', url, UNSIGNED_PAYLOAD, {
    'content-type': contentType,
    'content-length': String(size)
  })
  const send = url.protocol === 'http:' ? httpRequest : httpsRequest

  await new Promise<void>((resolve, reject) => {
    const request = send(
      url,
      { method: 'PUT', headers, timeout: UPLOAD_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) return resolve()
          const body = Buffer.concat(chunks).toString('utf-8')
          void describeFailure(new Response(body, { status }), '上传').then(reject)
        })
        response.on('error', reject)
      }
    )
    request.on('timeout', () => request.destroy(new Error('上传超时')))
    request.on('error', reject)

    // 边读边数：几百 MB 的视频要传好一阵，界面得有个百分比
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

export async function putObjectBytes(
  target: S3Target,
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const url = objectUrl(target, key)
  const payloadHash = createHash('sha256').update(body).digest('hex')
  const headers = signRequest(target, 'PUT', url, payloadHash, { 'content-type': contentType })
  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw await describeFailure(response, '上传')
}

/** 对象在不在。上传前先问一句：同一个文件传过就不再传 */
export async function headObject(target: S3Target, key: string): Promise<boolean> {
  const url = objectUrl(target, key)
  const headers = signRequest(target, 'HEAD', url, EMPTY_SHA256)
  const response = await fetch(url, {
    method: 'HEAD',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  // 没有 ListBucket 权限的密钥查一个不存在的对象，S3 回的是 403 不是 404（不让你借此探测
  // 桶里有什么）。只给了读写权限的最小化密钥很常见 —— 当成「没有」照传，
  // 真没权限的话上传那一步会把原因说出来
  if (response.status === 404 || response.status === 403) return false
  if (!response.ok) throw await describeFailure(response, '查询对象')
  return true
}

export async function deleteObject(target: S3Target, key: string): Promise<void> {
  const url = objectUrl(target, key)
  const headers = signRequest(target, 'DELETE', url, EMPTY_SHA256)
  const response = await fetch(url, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  // 删一个本来就不在的对象不算失败
  if (!response.ok && response.status !== 404) throw await describeFailure(response, '删除')
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 解析 ListObjectsV2 的响应。结构固定且扁平，正则就够，不为它引 XML 解析器 */
export function parseListObjects(xml: string): {
  objects: S3ListedObject[]
  nextToken?: string
} {
  const objects: S3ListedObject[] = []
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1]
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1]
    if (!key) continue
    objects.push({
      key: decodeXml(key),
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
      lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1] ?? ''
    })
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
  const token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
  return { objects, ...(truncated && token ? { nextToken: decodeXml(token) } : {}) }
}

/** 列出前缀下的全部对象（自动翻页，最多 10000 个，够一个人用很久了） */
export async function listObjects(target: S3Target, prefix: string): Promise<S3ListedObject[]> {
  const all: S3ListedObject[] = []
  let token: string | undefined
  do {
    const url = objectUrl(target)
    url.searchParams.set('list-type', '2')
    url.searchParams.set('max-keys', '1000')
    if (prefix) url.searchParams.set('prefix', prefix)
    if (token) url.searchParams.set('continuation-token', token)
    const headers = signRequest(target, 'GET', url, EMPTY_SHA256)
    const response = await fetch(
      `${url.origin}${url.pathname}?${canonicalQuery(url.searchParams)}`,
      {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }
    )
    if (!response.ok) throw await describeFailure(response, '列举')
    const page = parseListObjects(await response.text())
    all.push(...page.objects)
    token = page.nextToken
  } while (token && all.length < 10_000)
  return all
}
