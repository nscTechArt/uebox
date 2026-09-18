import Database from 'better-sqlite3'

import type { VaultFileRef } from './vaultFileCleanup'

/**
 * 缩略图文件的「还有没有别人在用」判断。
 *
 * 素材文件（filePath）早就有这道闸（models/assetData 的 getRetainedFilePaths），
 * 缩略图一直没有 —— 于是彻底删除一个资产会把**别人的封面图**一起 unlink 掉。
 *
 * 这不是理论问题，触发路径很短：批量封面上传（BatchThumbnailUploadModal）
 * 把**同一个文件名**同时写进一个文件夹的 img 和它下面 N 个资产的 customPoster；
 * 网络库同步下来的封面（ipc/networkVault）也是同一批文件名。删掉其中一个资产，
 * 剩下 N-1 个还活着的资产和那个文件夹的封面当场全变成裂图，而且找不回来。
 *
 * 判断按**文件名**而不是字段原值：同一个文件在不同字段里可能存成
 * `custom-1.png`、`file:///.../thumbnails/custom-1.png` 两种形态，比原值会漏。
 *
 * 软删除的记录**也算占用者** —— 它们还在回收站里等着被恢复，恢复出来的东西
 * 不该是一个裂图。只有「这一次真的要删掉的那些行」才不算。
 */

/**
 * 字段值 → thumbnails 目录里的文件名。
 *
 * customPoster 允许存外链（用户直接填了一个网图地址），那种情况下保管库里
 * 压根没有对应文件 —— 返回 null，既不用保护也不用删。
 */
export function thumbnailFilenameOf(value?: string | null): string | null {
  if (!value) return null
  const raw = String(value)
  if (/^https?:\/\//i.test(raw)) return null

  let pathname = raw
  if (/^file:\/\//i.test(raw)) {
    try {
      pathname = decodeURI(new URL(raw).pathname || '')
    } catch {
      pathname = raw.replace(/^file:\/\//i, '')
    }
  }

  const parts = pathname.split(/[/\\]/).filter(Boolean)
  const filename = parts.length ? parts[parts.length - 1] : ''
  return filename || null
}

/**
 * 原图文件名 → 压缩缩略图文件名（`a.png` → `a_thumb.jpg`）。
 *
 * 和 ThumbnailManager.toThumbFilename 同一套约定，这里重写一遍是为了让本模块
 * 保持纯字符串逻辑：它被 IPC 层直接引用，不该顺带把 electron 拖进测试进程。
 */
export function toThumbVariant(filename: string): string {
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx <= 0) return `${filename}_thumb.jpg`
  return `${filename.substring(0, dotIdx)}_thumb.jpg`
}

export interface ThumbnailRetentionScope {
  /** 这一次要彻底删掉的资产（它们不算占用者） */
  excludeAssetKeys?: readonly string[]
  /** 这一次要彻底删掉的文件夹（它们的封面也不算占用者） */
  excludeFolderKeys?: readonly string[]
}

/**
 * 删完这一批之后，仍然被别人指着的缩略图文件名。
 *
 * 一次扫完整库而不是逐条查：调用方是「彻底删除 / 清空回收站」这种批量动作，
 * 逐条查等于几千次全表扫描，全压在同步事务里主进程会卡死。所以 IPC 层提供了
 * 批量接口（hardDeleteMany），一次用户动作只扫一遍。
 *
 * 返回集合里同时放了原图名和它的 `_thumb` 变体：清理时两个文件是一起删的，
 * 只保护其中一个等于没保护。
 */
export function getRetainedThumbnailFilenames(
  db: Database.Database,
  scope: ThumbnailRetentionScope = {}
): Set<string> {
  const excludedAssets = new Set(scope.excludeAssetKeys ?? [])
  const excludedFolders = new Set(scope.excludeFolderKeys ?? [])
  const retained = new Set<string>()

  const keep = (value?: string | null): void => {
    const filename = thumbnailFilenameOf(value)
    if (!filename) return
    retained.add(filename)
    retained.add(toThumbVariant(filename))
  }

  const assetRows = db
    .prepare(
      `SELECT assetKey, imgLocalPath, customPoster FROM assetData
        WHERE (imgLocalPath IS NOT NULL AND imgLocalPath != '')
           OR (customPoster IS NOT NULL AND customPoster != '')`
    )
    .all() as Array<{ assetKey: string; imgLocalPath: string | null; customPoster: string | null }>

  for (const row of assetRows) {
    if (excludedAssets.has(row.assetKey)) continue
    keep(row.imgLocalPath)
    keep(row.customPoster)
  }

  const folderRows = db
    .prepare(`SELECT folderKey, img FROM assetFolder WHERE img IS NOT NULL AND img != ''`)
    .all() as Array<{ folderKey: string; img: string | null }>

  for (const row of folderRows) {
    if (excludedFolders.has(row.folderKey)) continue
    keep(row.img)
  }

  return retained
}

/** 这个缩略图还被别人用着吗 */
function isRetained(value: string | null | undefined, retained: Set<string>): boolean {
  const filename = thumbnailFilenameOf(value)
  if (!filename) return false
  return retained.has(filename) || retained.has(toThumbVariant(filename))
}

/**
 * 把清理清单里「别人还用着」的缩略图字段抹掉。
 *
 * 和 filePath 那边同一个套路：**数据库行照删，文件留给幸存者**。等最后一个
 * 用它的人也走了，那一次自然会把它删干净，不会永久残留。
 */
export function retainSharedThumbnails(ref: VaultFileRef, retained: Set<string>): VaultFileRef {
  return {
    filePath: ref.filePath,
    imgLocalPath: isRetained(ref.imgLocalPath, retained) ? null : ref.imgLocalPath,
    customPoster: isRetained(ref.customPoster, retained) ? null : ref.customPoster
  }
}
