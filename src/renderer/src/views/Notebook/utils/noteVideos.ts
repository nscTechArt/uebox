/**
 * 笔记里内嵌视频的格式判定。
 *
 * 和图片那套（{@link ./noteImages}）是一个思路，但结论相反：图片存不了还能
 * 退回 base64 内联，视频不行 —— 几十上百兆的 base64 会把笔记正文撑爆，而
 * 正文是要整条读进数据库的。所以视频存不了就明说，不做兜底。
 */

/**
 * 能落盘的视频扩展名。
 *
 * 这份名单要同时满足两个条件，缺一不可：
 * 1. Chromium 真能播 —— 存下一个播不出来的几十兆文件，比不让存更糟
 * 2. 和主进程 `note:saveVideo` 的白名单一致 —— 那边拒绝的这边也得拒绝，
 *    否则用户会先等一次上传再收到失败
 *
 * `mov` 不在里面：QuickTime 容器在 Chromium 里不保证能解。
 */
export const SAVABLE_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv'])

/**
 * 这个视频能不能落盘，能的话用什么扩展名。存不了返回 null。
 *
 * 先认 MIME，认不出来（有些系统拖拽给的 type 是空的）再退而问文件名。
 */
export function savableVideoExtension(mimeType: string, fileName?: string): string | null {
  const normalize = (raw: string): string | null => {
    const lower = raw.toLowerCase().trim()
    // video/quicktime 的后缀是 mov，照样不收 —— 归一化不等于放行
    const mapped = lower === 'ogg' ? 'ogv' : lower
    return SAVABLE_VIDEO_EXTENSIONS.has(mapped) ? mapped : null
  }

  const type = (mimeType || '').toLowerCase()
  if (type.startsWith('video/')) {
    const fromMime = normalize(type.slice('video/'.length))
    if (fromMime) return fromMime
  }

  const suffix = fileName?.split('.').pop()
  return suffix ? normalize(suffix) : null
}
