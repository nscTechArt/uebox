/**
 * `uebox-preview://` —— 服务端资产库的缩略图协议（设计 2.3 "桌面端"一条）。
 *
 * 渲染层拿到的地址形如：
 *
 *   uebox-preview://thumb/<内容哈希>/<变体>?l=<库键>&u=<服务端签名地址（相对路径+查询串）>
 *
 * 主进程按"哈希-变体"直接映射到磁盘路径，不查任何数据库；命中就把文件交给 Chromium。
 * 没命中才拿签名地址去服务端取，取回来写进磁盘 LRU（默认 2 GB）。同一张图的并发请求合并。
 * 图按内容寻址，同一个哈希下的字节永远不变，所以缓存永不失效；签名地址本身会 24 小时
 * 轮换，那只影响"没命中时怎么取"，不影响已经缓存的。
 *
 * 签名地址只允许指向该库所在服务器的 `/v1/previews/` 下 —— 渲染层不能借这个协议去
 * 别的主机，也拿不到令牌（签名地址本来就不需要令牌）。
 */
import { createHash } from 'node:crypto'
import type { DiskLru } from './diskLru'
import { CatalogHttpError, type CatalogHttp } from './http'

export const PREVIEW_SCHEME = 'uebox-preview'

const PREVIEW_PATH = /\/v1\/previews\/([0-9a-fA-F]{16,128})\/([A-Za-z0-9_-]{1,16})(?:$|[?#])/

export interface PreviewRef {
  hash: string
  variant: string
  libraryKey: string
  /** 相对签名地址：路径 + 查询串 */
  source: string
}

/** 把服务端签名地址（绝对或相对）拆成相对地址 + 哈希 + 变体；不是预览地址回 null */
export function parseSignedPreview(
  signed: string
): { source: string; hash: string; variant: string } | null {
  let source = signed
  try {
    const url = new URL(signed)
    source = `${url.pathname}${url.search}`
  } catch {
    // 本来就是相对地址
  }
  if (!source.startsWith('/v1/previews/')) return null
  const match = PREVIEW_PATH.exec(source)
  if (match) return { source, hash: match[1].toLowerCase(), variant: match[2].toLowerCase() }
  // 路径形状不认识：拿地址（不含会轮换的查询串）的哈希当键
  const path = source.split('?')[0]
  return { source, hash: createHash('sha256').update(path).digest('hex'), variant: 'x' }
}

export function previewProtocolUrl(
  libraryKey: string,
  signed: string | null | undefined
): string | null {
  if (!signed) return null
  const parsed = parseSignedPreview(signed)
  if (!parsed) return null
  return `${PREVIEW_SCHEME}://thumb/${parsed.hash}/${parsed.variant}?l=${encodeURIComponent(libraryKey)}&u=${encodeURIComponent(parsed.source)}`
}

export function parsePreviewProtocolUrl(raw: string): PreviewRef | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${PREVIEW_SCHEME}:`) return null
  const [hash, variant] = url.pathname.replace(/^\/+/, '').split('/')
  const libraryKey = url.searchParams.get('l') ?? ''
  const source = url.searchParams.get('u') ?? ''
  if (!/^[0-9a-f]{16,128}$/.test(hash ?? '') || !/^[a-z0-9_-]{1,16}$/.test(variant ?? ''))
    return null
  if (!libraryKey || !source.startsWith('/v1/previews/')) return null
  return { hash, variant, libraryKey, source }
}

function sniffContentType(data: Buffer): string {
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (data.length >= 8 && data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG')
    return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg'
  return 'application/octet-stream'
}

export interface PreviewSource {
  /** 库键 → 能去取图的客户端；库已被移除就 null */
  httpFor(libraryKey: string): CatalogHttp | null
  /** 服务端没有预览路由时回调（界面据此隐藏预览、只画类图标） */
  onRouteMissing?(libraryKey: string): void
}

export class PreviewService {
  private readonly inflight = new Map<string, Promise<Buffer | null>>()

  constructor(
    private readonly disk: DiskLru,
    private readonly source: PreviewSource
  ) {}

  private cacheKey(ref: Pick<PreviewRef, 'hash' | 'variant'>): string {
    return `${ref.hash}-${ref.variant}`
  }

  /** 协议处理器入口 */
  async handle(request: Request): Promise<Response> {
    const ref = parsePreviewProtocolUrl(request.url)
    if (!ref) return new Response('Bad preview address', { status: 400 })
    const data = await this.load(ref)
    if (!data) return new Response('No preview', { status: 404 })
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': sniffContentType(data),
        'Cache-Control': 'private, max-age=31536000, immutable'
      }
    })
  }

  async load(ref: PreviewRef): Promise<Buffer | null> {
    const key = this.cacheKey(ref)
    const cached = await this.disk.get(key)
    if (cached) return cached
    const running = this.inflight.get(key)
    if (running) return await running
    const task = this.fetch(ref, key).finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return await task
  }

  private async fetch(ref: PreviewRef, key: string): Promise<Buffer | null> {
    const http = this.source.httpFor(ref.libraryKey)
    if (!http) return null
    try {
      const response = await http.raw(ref.source, {
        anonymous: true,
        timeoutMs: 20_000,
        headers: { accept: 'image/*' }
      })
      if (response.status === 404 && response.body.length === 0) {
        this.source.onRouteMissing?.(ref.libraryKey)
        return null
      }
      if (response.status < 200 || response.status >= 300 || response.body.length === 0) return null
      await this.disk.put(key, response.body)
      return response.body
    } catch (error) {
      if (error instanceof CatalogHttpError) return null
      throw error
    }
  }
}
