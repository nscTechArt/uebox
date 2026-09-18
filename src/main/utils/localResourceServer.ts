import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname } from 'path'
import { Readable } from 'stream'

/**
 * `local-resource://` 协议的路径解析与文件响应。
 *
 * 渲染进程在 dev 模式下跑在 http://localhost 上，Chromium 会直接拒绝
 * `file:///` 子资源（"Not allowed to load local resource"），所以本地图片/视频
 * 一律走这个特权协议。协议注册见 src/main/index.ts。
 */

/**
 * 把 `local-resource://` 请求 URL 还原成本地绝对路径。
 *
 * request.url 可能长成这些样子：
 * - `local-resource://C:/Users/...`（未编码）
 * - `local-resource://c/Users/...`（Chromium 把盘符当 host + 空端口，冒号被吃掉）
 * - `local-resource:///C:/Users/...`（多余斜杠）
 * - `local-resource://H:/%E8%B5%84%E4%BA%A7/...`（中文按段编码）
 */
export function resolveLocalResourcePath(
  requestUrl: string,
  platform: NodeJS.Platform = process.platform
): string {
  let urlPath = String(requestUrl).replace(/^local-resource:\/\/+/i, '')

  // 去掉 query / hash，避免它们被当成文件名的一部分
  urlPath = urlPath.replace(/[?#].*$/, '')

  try {
    urlPath = decodeURIComponent(urlPath)
  } catch {
    // 整体解码失败（路径里有裸 % 之类）就按段解码，解不动的段保持原样
    urlPath = urlPath
      .split('/')
      .map((segment) => {
        try {
          return decodeURIComponent(segment)
        } catch {
          return segment
        }
      })
      .join('/')
  }

  if (platform === 'win32') {
    // 盘符丢了冒号（c/Users/... -> c:/Users/...）
    if (/^[a-zA-Z]\//.test(urlPath)) {
      urlPath = `${urlPath[0]}:${urlPath.slice(1)}`
    }

    const driveLetterMatch = urlPath.match(/^\/+\/?([A-Za-z]:\/.*)$/)
    if (driveLetterMatch) {
      urlPath = driveLetterMatch[1]
    } else if (!urlPath.match(/^[A-Za-z]:/)) {
      urlPath = urlPath.replace(/^\/+/, '')
    }
    return urlPath
  }

  // Unix/macOS：本地资源一定是绝对路径。剥协议头时前导斜杠被吃光了，这里补回来，
  // 否则 pathToFileURL 会把它当相对路径拼到进程 cwd 上。
  return `/${urlPath.replace(/^\/+/, '')}`
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8'
}

/** 按扩展名给出 Content-Type，认不出来就交给 Chromium 自己嗅探 */
export function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  return CONTENT_TYPES[ext] || 'application/octet-stream'
}

export interface ParsedRange {
  start: number
  end: number
}

/**
 * 解析 `Range: bytes=...`，只支持单区间（浏览器播放媒体就用这一种）。
 * - `bytes=100-199` → { start: 100, end: 199 }
 * - `bytes=100-`    → 到文件末尾
 * - `bytes=-500`    → 最后 500 字节
 * 返回 null 表示没有 Range；返回 'unsatisfiable' 表示区间越界，应答 416。
 */
export function parseRangeHeader(
  rangeHeader: string | null | undefined,
  size: number
): ParsedRange | null | 'unsatisfiable' {
  const raw = String(rangeHeader || '').trim()
  if (!raw) return null

  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw)
  if (!match || (!match[1] && !match[2])) return null

  let start: number
  let end: number

  if (!match[1]) {
    // 后缀区间：最后 N 字节
    const suffix = Number(match[2])
    if (suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }

  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 读本地文件并返回 Response，支持 Range。
 *
 * 必须自己处理 Range —— Electron 的 `net.fetch(file://)` 收到 Range 头时会
 * 只回该区间的字节，但状态码仍是 200 且不带 Content-Range，
 * Chromium 的媒体管线会据此认为「整个文件只有这么大」，视频直接播不动。
 */
export async function serveLocalFile(
  filePath: string,
  rangeHeader?: string | null
): Promise<Response> {
  let size: number
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return new Response('Not a file', { status: 404 })
    }
    size = info.size
  } catch {
    return new Response('Not found', { status: 404 })
  }

  const contentType = contentTypeFor(filePath)
  const range = parseRangeHeader(rangeHeader, size)

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` }
    })
  }

  if (range) {
    const stream = createReadStream(filePath, { start: range.start, end: range.end })
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`
      }
    })
  }

  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Content-Length': String(size)
    }
  })
}
