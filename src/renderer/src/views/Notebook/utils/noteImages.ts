/**
 * 笔记正文里的图片：从「塞在 HTML 里的 base64」搬到「磁盘上的文件」。
 *
 * ## 为什么值得单独一个模块
 *
 * 这里的两件事都是**会丢用户东西**的操作，而它们都不抛异常，只会在真机上被撞见：
 *
 * - 迁移改写正文：正则动的是用户写的 HTML。多吃一个字符，他那段话就没了。
 * - 落盘失败的兜底：写盘失败时**必须**留住原来的 base64。为了「干净」把 src 换成
 *   一个还不存在的文件路径，等于把那张图删了。
 *
 * 所以判断逻辑放在纯函数里单独测，DOM 和 IPC 留在组件那一侧。
 */

/** 正文里一张待搬走的 base64 图片 */
export interface InlineImage {
  /** 原样的 `src` 值，替换时用它做键 */
  src: string
  /** 解出来的字节 */
  bytes: Uint8Array
  /** 文件扩展名，从 MIME 推的 */
  ext: string
}

const DATA_URL_RE = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is

/**
 * 能落盘的扩展名。
 *
 * **必须和主进程 `note:saveImage` 的白名单一致**（`src/main/sqliteDataBase/ipc/note.ts`）。
 * 那边对不认识的扩展名一律改写成 `png`，所以这边多报一个格式的后果是：
 * 文件以 `.png` 存下去、里面却是别的格式的字节 —— 本地资源的 Content-Type 是按
 * 扩展名给的，于是那张图再也渲染不出来，而正文里的 base64 已经被换成这个路径了，
 * 等于把用户的图删了。
 *
 * SVG 不在里面是故意的：SVG 里能写 `<script>`，作为本地资源加载等于给自己开一个
 * 脚本执行入口。这类格式不迁移，继续以 base64 留在正文里 —— 照样显示，也不会丢。
 */
const SAVABLE_EXTENSIONS = new Set(['png', 'jpg', 'gif', 'webp', 'bmp'])

/**
 * MIME 子类型 → 落盘用的扩展名。存不了的格式返回 null。
 *
 * 返回 null 的那些不会被搬走，原样留在正文里 —— 见 {@link SAVABLE_EXTENSIONS}。
 */
function extOf(subtype: string): string | null {
  const lower = subtype.toLowerCase()
  const normalized = lower === 'jpeg' ? 'jpg' : lower
  return SAVABLE_EXTENSIONS.has(normalized) ? normalized : null
}

/**
 * 这个文件能不能落盘，能的话用什么扩展名。存不了的返回 null。
 *
 * 贴图 / 拖图那条路也要问这一句，不能直接把 `file.name` 的后缀递给主进程 ——
 * 主进程对不认识的扩展名一律改写成 `png`，于是一张 svg 会以 `.png` 存下去、
 * 里面是 SVG 字节，再也渲染不出来。返回 null 时调用方应当退回 base64 内联：
 * 图片胖一点没关系，显示不出来才是真丢了。
 */
export function savableExtension(mimeType: string, fileName?: string): string | null {
  const type = mimeType.toLowerCase()
  const fromMime = type.startsWith('image/') ? extOf(type.slice('image/'.length)) : null
  if (fromMime) return fromMime
  // MIME 认不出来（有些系统拖拽给的是空 type）就退而问文件名
  const suffix = fileName?.split('.').pop()
  return suffix ? extOf(suffix) : null
}

/**
 * data URL → 字节。不是 data URL、或者 base64 坏了都返回 null。
 *
 * 坏掉的 base64 返回 null 而不是抛：一张坏图不该让整篇笔记的迁移失败，
 * 它继续以 base64 的样子留在正文里，至少还看得见。
 */
export function parseInlineImage(src: string): InlineImage | null {
  const match = DATA_URL_RE.exec(src)
  if (!match) return null
  // 主进程存不了的格式就别搬：搬了会以 .png 落盘、里面是别的字节，图就废了
  const ext = extOf(match[1])
  if (!ext) return null
  try {
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    if (bytes.length === 0) return null
    return { src, bytes, ext }
  } catch {
    return null
  }
}

/**
 * 从一段 HTML 里找出所有 base64 图片。
 *
 * 同一张图在正文里出现两次时只返回一条 —— 搬一次、替换两处就够了。
 */
export function collectInlineImages(html: string): InlineImage[] {
  const found = new Map<string, InlineImage>()
  const imgTag = /<img\b[^>]*?\ssrc\s*=\s*(["'])(data:image\/[^"']+)\1/gi
  let match: RegExpExecArray | null
  while ((match = imgTag.exec(html)) !== null) {
    const src = match[2]
    if (found.has(src)) continue
    const parsed = parseInlineImage(src)
    if (parsed) found.set(src, parsed)
  }
  return [...found.values()]
}

/**
 * 把正文里的 base64 src 换成新地址。
 *
 * 只替换**成功搬走的**那些（`replacements` 里有的）。没搬成的原样留着 ——
 * 换成一个还不存在的路径，用户那张图就等于被删了。
 */
export function replaceInlineImageSources(
  html: string,
  replacements: ReadonlyMap<string, string>
): string {
  if (replacements.size === 0) return html
  let next = html
  for (const [from, to] of replacements) {
    // src 里有 base64 的 `+ / =`，都不是正则元字符，但用 split/join 更省心也更快
    next = next.split(from).join(to)
  }
  return next
}

/** 这段 HTML 里还有没有 base64 图片 —— 用来决定要不要跑迁移 */
export function hasInlineImages(html: string): boolean {
  return /<img\b[^>]*?\ssrc\s*=\s*["']data:image\//i.test(html)
}
