/**
 * 图片存盘时的扩展名判定。
 *
 * 单独成一个模块是为了**能被测到**：唯一的调用方 imagePollingService 挂着
 * electron、SQLite、资产库一整串依赖，为了验一张 JPEG 会不会被存成 .png
 * 把它们全 mock 一遍得不偿失。
 *
 * 为什么需要它：AI 创作原先只接官方那两个模型，返回的一律是 PNG，于是存盘那边
 * 把扩展名和资产表里的 fileExtension 都写死成 png。接上用户自己配的生图模型之后
 * 这个前提没了 —— 各家可能回 JPEG、WebP，存出来就是一个装着 JPEG 的 .png 文件，
 * 外加一条与磁盘不符的资产记录。
 */

/** 认得出的图片类型 → 扩展名。jpeg 统一写成 jpg，与用户手里的其它素材一致 */
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/tiff': 'tif'
})

/**
 * 认不出来时用它。
 *
 * 选 png 而不是 bin：认不出的东西绝大多数仍然是张图，给个图片扩展名至少
 * 双击能打开、缩略图能出；给 .bin 则是把「不确定」变成「肯定用不了」。
 */
export const DEFAULT_IMAGE_EXTENSION = 'png'

const DATA_URI_PATTERN = /^data:([^;,]*)(;[^,]*)?,/i

export interface DecodedImageDataUri {
  /** 形如 `image/webp`。data URI 里没写类型时为 null */
  mediaType: string | null
  /** 去掉前缀之后的 base64 数据 */
  base64: string
}

/**
 * 拆开一个 data URI。
 *
 * 类型和数据**一次取出**，不是分两处各匹配一遍 —— 老代码就是用
 * `replace(/^data:image\/\w+;base64,/, '')` 把类型匹配到了又原地扔掉，
 * 于是扩展名只能靠猜。
 */
export function decodeImageDataUri(url: string): DecodedImageDataUri {
  const raw = String(url || '')
  const match = raw.match(DATA_URI_PATTERN)
  if (!match) return { mediaType: null, base64: raw }

  const mediaType = match[1].trim().toLowerCase()
  return {
    mediaType: mediaType || null,
    base64: raw.slice(match[0].length)
  }
}

/** `image/webp; charset=binary` → `image/webp`。取不到就 null */
export function mediaTypeFromContentType(header?: string | null): string | null {
  const value = String(header || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return value || null
}

function extensionFromMediaType(mediaType?: string | null): string | null {
  const key = String(mediaType || '')
    .trim()
    .toLowerCase()
  return EXTENSION_BY_MEDIA_TYPE[key] ?? null
}

/**
 * 从 URL 路径里认扩展名，如 `https://cdn/x/y.webp?sig=...`。
 *
 * 只作为声明类型缺失时的备选：查询串里也可能出现 `.png` 这种字样，
 * 所以先把 ? 和 # 之后的部分切掉再看。
 */
function extensionFromUrlPath(url?: string | null): string | null {
  const path = String(url || '').split(/[?#]/)[0]
  const suffix = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  // 没有点，或者最后一个点在路径分隔符之前（`cdn.example.com/download`）—— 都不算扩展名
  if (!suffix || suffix.includes('/')) return null
  if (Object.values(EXTENSION_BY_MEDIA_TYPE).includes(suffix)) return suffix
  return suffix === 'jpeg' ? 'jpg' : null
}

/**
 * 按文件头认类型。
 *
 * 排在声明类型后面、兜底之前：厂商回一个 `application/octet-stream` 是常有的事，
 * 那时候与其盲写 png，不如直接看这几个字节 —— 它们不会说谎。
 */
function hasBytesAt(buffer: Uint8Array, offset: number, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[offset + index] === byte)
}

function hasAsciiAt(buffer: Uint8Array, offset: number, ascii: string): boolean {
  return hasBytesAt(
    buffer,
    offset,
    [...ascii].map((char) => char.charCodeAt(0))
  )
}

function extensionFromMagicBytes(buffer: Uint8Array): string | null {
  if (hasBytesAt(buffer, 0, [0x89, 0x50, 0x4e, 0x47])) return 'png'
  if (hasBytesAt(buffer, 0, [0xff, 0xd8, 0xff])) return 'jpg'
  if (hasAsciiAt(buffer, 0, 'GIF8')) return 'gif'
  if (hasAsciiAt(buffer, 0, 'BM')) return 'bmp'
  // RIFF....WEBP：中间四个字节是长度，跳过
  if (hasAsciiAt(buffer, 0, 'RIFF') && hasAsciiAt(buffer, 8, 'WEBP')) return 'webp'
  // ....ftypavif：前四个字节是 box 长度
  if (hasAsciiAt(buffer, 4, 'ftypavif')) return 'avif'

  return null
}

/**
 * 定下这张图该用什么扩展名。
 *
 * 优先级：厂商声明的类型 → URL 路径 → 文件头 → png。
 * 声明的类型排最前是因为它最常见也最直接；文件头排在兜底之前，是为了让
 * 「厂商没说清楚」落到一个正确答案上，而不是落到一个好看的默认值上。
 */
export function resolveImageExtension(input: {
  mediaType?: string | null
  url?: string | null
  bytes?: Uint8Array | null
}): string {
  return (
    extensionFromMediaType(input.mediaType) ??
    extensionFromUrlPath(input.url) ??
    (input.bytes ? extensionFromMagicBytes(input.bytes) : null) ??
    DEFAULT_IMAGE_EXTENSION
  )
}
