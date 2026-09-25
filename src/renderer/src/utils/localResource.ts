/**
 * 本地文件路径 → 渲染进程真正能加载的 URL。
 *
 * dev 模式下渲染进程跑在 http://localhost 上，Chromium 会直接拒绝 file:/// 子资源
 * （控制台报 "Not allowed to load local resource"），跟 CSP 无关也绕不过去。
 * 所以本地图片/视频/模型一律走主进程注册的 `local-resource` 特权协议
 * （见 src/main/index.ts 与 src/main/utils/localResourceServer.ts），
 * 打包后（file: 源）同样能用，两边行为一致。
 */

/** 已经能直接加载的协议，原样返回 */
const PASSTHROUGH_SCHEME = /^(local-resource|uebox-asset|uebox-preview|https?|data|blob):/i

/**
 * 把路径转换为正确编码的 file:// URL。
 *
 * 注意：UNC 路径 (\\server\share) 需要特殊处理
 * - 本地路径: file:///C:/path/to/file
 * - UNC 路径: file://server/share/path/to/file (只有两个斜杠)
 */
export function pathToFileUrl(fullPath: string): string {
  const normalized = String(fullPath).replace(/\\/g, '/')

  if (normalized.startsWith('//')) {
    const encoded = encodeSegments(normalized.slice(2))
    return `file://${encoded}`
  }

  return `file:///${encodeSegments(normalized)}`
}

/** file:// URL → 本地路径（还原百分号转义） */
function fileUrlToPath(url: string): string {
  const withoutScheme = url.replace(/^file:\/{2,}/i, '')
  try {
    return decodeURIComponent(withoutScheme)
  } catch {
    return withoutScheme
  }
}

function encodeSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * 把本地绝对路径或 file:// URL 转成 `local-resource://` URL。
 *
 * - http(s) / data / blob / local-resource / uebox-asset：原样返回
 * - 空值：返回 undefined，交给调用方决定占位图
 * - UNC 路径（`\\server\share`）：local-resource 协议还原不了主机名，
 *   退回 file:// 形式（打包后的 file: 源里仍然可用）
 */
export function toLocalResourceUrl(input?: string | null): string | undefined {
  const raw = String(input ?? '').trim()
  if (!raw) return undefined
  if (PASSTHROUGH_SCHEME.test(raw)) return raw

  const path = /^file:/i.test(raw) ? fileUrlToPath(raw) : raw
  const normalized = path.replace(/\\/g, '/')
  if (!normalized) return undefined

  if (normalized.startsWith('//')) return pathToFileUrl(normalized)

  const segments = normalized.replace(/^\/+/, '').split('/').filter(Boolean)
  if (segments.length === 0) return undefined

  // Windows 盘符段（C:）不能编码，否则 `C%3A` 会把 URL 的 authority 解析坏
  const encoded = segments
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/')

  return `local-resource://${encoded}`
}
