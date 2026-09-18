/**
 * 图片 → Blob，以及在此之上的「复制到剪贴板 / 下载到本地」。
 *
 * 渲染进程的 CSP（见 src/renderer/index.html）里 `connect-src` 不含 `data:`，
 * 所以 `fetch('data:image/png;base64,...')` 会被浏览器直接拦掉：
 *   Refused to connect because it violates the document's Content Security Policy
 * 而 AI 生成的图片经常就是 data URL，一走 fetch 复制和下载就全废。
 * data URL 自己解码即可拿到字节，不需要网络栈——CSP 保持原样收窄。
 *
 * 其余协议（http/https/local-resource/uebox-asset）都在 `connect-src` 白名单里，继续走 fetch。
 */

/** MIME → 下载文件扩展名 */
const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp'
}

/**
 * data URL 直接解码成 Blob，不经过 fetch。
 * 支持 base64 与百分号编码两种载荷（后者常见于 image/svg+xml）。
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || commaIndex === -1) {
    throw new Error('不是合法的 data URL')
  }

  const params = dataUrl.slice('data:'.length, commaIndex).split(';')
  const mime = params[0].trim() || 'text/plain'
  const isBase64 = params.some((param) => param.trim().toLowerCase() === 'base64')
  const payload = dataUrl.slice(commaIndex + 1)

  if (!isBase64) {
    return new Blob([decodeURIComponent(payload)], { type: mime })
  }

  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime })
}

/**
 * 取图片字节。
 * @param src 图片地址（data: 本地解码，其余走 fetch）
 */
export async function loadImageBlob(src: string): Promise<Blob> {
  if (src.startsWith('data:')) {
    return dataUrlToBlob(src)
  }

  const response = await fetch(src)
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.statusText}`)
  }
  return await response.blob()
}

/**
 * Blob → data URL。
 *
 * 要把一张图交给外部服务（比如当参考图发给生图模型）时，base64 是唯一到哪儿都认的形式：
 * `local-resource://` 只有这个应用自己认得，模型给的远端链接则会过期。
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

/** 转成 PNG（剪贴板只认 image/png） */
export async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)

    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('无法创建 canvas context'))
        return
      }

      ctx.drawImage(img, 0, 0)
      canvas.toBlob(
        (pngBlob) => {
          URL.revokeObjectURL(url)
          if (pngBlob) {
            resolve(pngBlob)
          } else {
            reject(new Error('转换为 PNG 失败'))
          }
        },
        'image/png',
        1.0
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片加载失败'))
    }

    img.src = url
  })
}

/**
 * 复制图片到剪贴板（统一转 PNG，兼容性最好）
 * @param src 图片地址（http/https/data/local-resource/uebox-asset）
 */
export async function copyImageToClipboard(src: string): Promise<void> {
  const blob = await loadImageBlob(src)
  const pngBlob = await convertImageBlobToPng(blob)

  await navigator.clipboard.write([
    new ClipboardItem({
      'image/png': pngBlob
    })
  ])
}

/** 根据 MIME 类型和 URL 推断扩展名，两边都认不出就当 png */
export function getImageExtension(mimeType: string, src: string): string {
  if (MIME_EXTENSION[mimeType]) {
    return MIME_EXTENSION[mimeType]
  }

  const urlMatch = src.match(/\.([a-zA-Z0-9]+)(?:\?|#|$)/)
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1].toLowerCase()
  }

  return 'png'
}

/**
 * 下载图片到本地
 * @param src 图片地址
 * @param filename 文件名（不传则按时间戳生成）
 */
export async function downloadImage(src: string, filename?: string): Promise<void> {
  const blob = await loadImageBlob(src)

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = filename || `image_${timestamp}.${getImageExtension(blob.type, src)}`

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
