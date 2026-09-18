import { extname } from 'path'

import { isInsideAnyDirectory } from '../../../utils/pathContainment'

/**
 * 缩略图与资产媒体读写的两道闸。
 *
 * 背景：`asset:overwriteThumb` 把渲染层给的 posterFilename 直接 join 进缩略图
 * 目录再写文件，`asset:readFileAsBase64` 把任意绝对路径原样读回 base64。
 * 两个都是 preload 暴露给渲染层的通道，组合起来可以把一张 JPEG 写到
 * `vault-data.db` 上，或者把本机任意文件读走。
 *
 * 本文件只做纯判断，不碰 electron，可以直接单测。
 */

/**
 * 允许读的媒体扩展名 —— 两个调用方读的都是资产缩略图 / 参考图。
 *
 * 必须覆盖 `constants/assetCategories.ts` 里「图片」分类的全部格式，
 * 少一个就是把用户某种格式的参考图读不出来。
 */
const READABLE_MEDIA_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.jfif',
  '.png',
  '.apng',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
  '.tga',
  '.dds',
  '.psd',
  '.exr',
  '.hdr',
  '.tif',
  '.tiff',
  '.avif',
  '.heic',
  '.heif',
  '.ico',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v'
])

/**
 * 文件名必须只是文件名。
 *
 * 挡掉 `../`、绝对路径、盘符、UNC，以及 NUL 截断。
 */
export function isPlainFileName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return false
  if (trimmed.includes('\0')) return false
  if (trimmed.includes('/') || trimmed.includes('\\')) return false
  // Windows 的 `C:name` 形式仍然是相对于该盘当前目录的路径，不是纯文件名
  if (/^[a-zA-Z]:/.test(trimmed)) return false
  return true
}

export function isReadableMediaPath(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string' || !filePath.trim()) return false
  if (filePath.includes('\0')) return false
  return READABLE_MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export interface MediaReadScope {
  /** 当前保管库目录、网络共享根等「本来就属于这个库」的位置 */
  roots: readonly (string | undefined)[]
  /** 路径不在上述目录里时的兜底：库里是否真有一条资产指向它（引用型保管库） */
  isKnownAssetPath: (filePath: string) => boolean
}

/**
 * @returns 拒绝原因；允许读时返回 null
 */
export function denyMediaRead(filePath: unknown, scope: MediaReadScope): string | null {
  if (!isReadableMediaPath(filePath)) return '只允许读取资产库中的图片或视频文件'
  if (isInsideAnyDirectory(filePath, scope.roots)) return null
  if (scope.isKnownAssetPath(filePath)) return null
  return '该文件不属于当前资产库'
}
