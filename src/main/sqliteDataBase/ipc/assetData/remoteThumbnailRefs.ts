/**
 * 推往资产服务器的元数据里，缩略图引用必须和这次真正上传的那批一致。
 *
 * 为什么单独成模块：推之前收集上传清单时，本地文件不在就默默跳过，可那条资产的
 * `imgLocalPath` 照样跟着元数据发出去了。服务端 commit 前会逐条核对元数据里引用的
 * 每个缩略图有没有实体文件，对不上就驳回**整单**（MISSING_REFERENCED_THUMBNAIL）。
 * 更糟的是「继续完成」救不回来 —— 续传要补的清单就是这份上传清单，缺的那几条从来
 * 不在里面，按多少次都是同一个错，用户自己出不来。
 *
 * ## 两条规矩
 *
 * **一、字段值先归一化成纯文件名再判断。** 同一张图在库里存过好几种形态：
 * `custom-1.png`、`thumbnails/custom-1.png`、`.thumbnails/custom-1.png`、
 * `file:///.../thumbnails/custom-1.png`、`assetData\x.png`。直接拿原值去
 * `join(<库>/thumbnails, 原值)` 探测，前缀形态永远探不到，会把**明明在硬盘上的**
 * 缩略图判成丢失；而 `file://` 形态在旧写法里连判都不判，直接带着悬空引用发出去，
 * 该挡的那个死循环照样发生。所以这里复用 `thumbnailFilenameOf()`，它本来就是为
 * 「同一个文件在不同字段里存成不同形态」写的。发出去的值也一并归一化成那个文件名，
 * 否则服务端拿 `thumbnails/custom-1.png` 去比对我们上传的 `custom-1.png`，还是对不上。
 *
 * **二、本地没有 ≠ 引用悬空。** 网络库的缩略图本来就只在服务器上，本机那份
 * `thumbnails/` 目录可能一张都没有（换台机器打开同一个库就是这样）。只凭本地
 * `existsSync` 就把字段抹掉再整条 upsert 上去，会把**所有人**的封面一起洗掉。
 * 所以本地找不到的只进 `pending`，由调用方去问一次服务器，两边都没有才算真悬空。
 * 这条规矩在 `ipc/assetData/thumbnails.ts` 的修复流程里早就有了，这里跟它对齐。
 */

import { isPlainFileName } from './thumbnailGuard'
import { thumbnailFilenameOf } from '../../services/vaultThumbnailRefs'

/** 元数据里会指向 `.thumbnails/` 的两个字段 */
const THUMBNAIL_REF_FIELDS = ['imgLocalPath', 'customPoster'] as const

export type ThumbnailRefField = (typeof THUMBNAIL_REF_FIELDS)[number]

export interface PendingThumbnailRef {
  /** 哪个字段指着它 */
  field: ThumbnailRefField
  /** 归一化后的纯文件名 */
  fileName: string
}

export interface AssetThumbnailRefs {
  /**
   * 真正发往服务端的那份记录。
   *
   * 引用被归一化成纯文件名时会先浅拷贝一份 —— 本地库里那行不动，它指着什么是
   * 本地自己的事（真要修本地，走 thumbnails.ts 的 repairAssetRow，那条路会先试
   * 重新生成，抹字段只是它的最后一招）。
   */
  asset: Record<string, unknown>
  /** 本地有文件、这次要上传的缩略图文件名（已去重） */
  queued: string[]
  /** 本地没有文件的引用 —— 还没定性，调用方得先问服务器上有没有 */
  pending: PendingThumbnailRef[]
}

/**
 * 字段值 → 保管库缩略图目录里的纯文件名；不归这个目录管就返回 null。
 *
 * `null` 的两种情况都不该碰：外链封面（用户自己填的网图地址，库里压根没有对应
 * 文件），以及带 `../`、盘符、NUL 这类不是纯文件名的值 —— 后者交给
 * `isPlainFileName` 挡，免得 `..` 被 `join` 带出缩略图目录，再被当成缩略图上传。
 */
export function resolveVaultThumbnailName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const fileName = thumbnailFilenameOf(value)
  if (!fileName || !isPlainFileName(fileName)) return null
  return fileName
}

/**
 * 核对一条资产记录的缩略图引用。
 *
 * @param asset           将要推往服务端的资产记录
 * @param thumbnailExists 这个**纯文件名**在本地缩略图目录里存在吗
 */
export function resolveAssetThumbnailRefs(
  asset: Record<string, unknown>,
  thumbnailExists: (fileName: string) => boolean
): AssetThumbnailRefs {
  const queued: string[] = []
  const pending: PendingThumbnailRef[] = []
  let resolved = asset

  const normalize = (field: ThumbnailRefField, fileName: string): void => {
    if (asset[field] === fileName) return
    // 只在真的要改的时候才复制，别动调用方手上那份记录
    if (resolved === asset) resolved = { ...asset }
    resolved[field] = fileName
  }

  for (const field of THUMBNAIL_REF_FIELDS) {
    const fileName = resolveVaultThumbnailName(asset[field])
    if (!fileName) continue

    // 发出去的引用必须就是我们上传的那个名字，前缀形态要在这里拉平
    normalize(field, fileName)

    if (thumbnailExists(fileName)) {
      if (!queued.includes(fileName)) queued.push(fileName)
      continue
    }

    pending.push({ field, fileName })
  }

  return { asset: resolved, queued, pending }
}

/** 确认服务器上也没有之后，把这条悬空引用摘掉 */
export function dropThumbnailRef(asset: Record<string, unknown>, field: ThumbnailRefField): void {
  asset[field] = ''
}
