import { promises as fs } from 'fs'
import { isAbsolute, join, resolve } from 'path'

import { PathManager } from '../../utils/PathManager'
import { isInsideDirectory } from '../../utils/pathContainment'
import { thumbnailFilenameOf, toThumbVariant } from './vaultThumbnailRefs'

/**
 * 保管库内的物理文件清理。
 *
 * 从 ipc/assetData/crud.ts 的资产版「清空回收站」提取共用 —— 文件夹的清空 /
 * 彻底删除以前完全没做这一步，删掉数据库行之后备份文件和缩略图永久残留。
 */

export interface VaultFileRef {
  filePath?: string | null
  imgLocalPath?: string | null
  /**
   * 用户自定义封面 / 视频自动抽帧封面。
   *
   * 和 imgLocalPath 是**两个独立的文件**（前者 `custom-xxx.png` + `custom-xxx_thumb.jpg`，
   * 后者 `thumbnail-<assetKey>.jpg`），漏掉它就会在 thumbnails 目录里永久残留。
   */
  customPoster?: string | null
}

const CLEANUP_BATCH = 10

/**
 * 清理时用的保管库定位信息。
 *
 * 为什么要显式传而不是现查：清理跑在 setImmediate 之后、分批 await，中途用户
 * 完全可能切换保管库。现查 `getCurrentVaultPath()` 会把**旧库**的相对路径按
 * **新库**的根解析 —— 于是在错误的库里删掉同名文件。
 */
export interface VaultCleanupScope {
  vaultRoot: string
  assetDataRoot: string
  thumbnailsRoot: string
}

export function captureVaultCleanupScope(): VaultCleanupScope | null {
  try {
    const pm = PathManager.getInstance()
    return {
      vaultRoot: resolve(pm.getCurrentVaultPath()),
      assetDataRoot: resolve(pm.getAssetDataPath()),
      thumbnailsRoot: resolve(pm.getThumbnailsPath())
    }
  } catch {
    return null
  }
}

/**
 * 删除保管库自己的备份副本和缩略图。
 *
 * ⚠️ 只删保管库 assetData 目录下由我们复制出来的副本，**绝不碰用户的原始文件**。
 * 判断用 isInsideDirectory 而不是裸 startsWith：少了分隔符那一步，
 * 同级的 `assetDataXXX` 目录也会被判成「在里面」。
 */
export async function deleteVaultBackupAndThumbnail(
  ref: VaultFileRef,
  scope?: VaultCleanupScope | null
): Promise<void> {
  try {
    const resolved = scope ?? captureVaultCleanupScope()
    if (!resolved) return

    if (ref.filePath) {
      const raw = String(ref.filePath)
      const absolute = isAbsolute(raw) ? raw : join(resolved.vaultRoot, raw)
      if (isInsideDirectory(absolute, resolved.assetDataRoot)) {
        await fs.unlink(resolve(absolute)).catch(() => undefined)
      }
    }

    // 两个缩略图字段各指一个文件，都要删（见 VaultFileRef.customPoster）。
    // 「别人还用着的封面」在上游就被 retainSharedThumbnails 抹成 null 了 ——
    // 这里拿到什么就删什么，不再自己判断（见 services/vaultThumbnailRefs）。
    for (const candidate of [ref.imgLocalPath, ref.customPoster]) {
      const filename = thumbnailFilenameOf(candidate)
      if (filename) await deleteThumbnailInScope(filename, resolved)
    }
  } catch {
    // 清理失败不应该影响已经提交的数据库结果
  }
}

/** 缩略图同样按快照下来的目录删，不跟着「当前保管库」跑 */
async function deleteThumbnailInScope(filename: string, scope: VaultCleanupScope): Promise<void> {
  const names = filename.includes('_thumb') ? [filename] : [filename, toThumbVariant(filename)]

  for (const name of names) {
    const target = join(scope.thumbnailsRoot, name)
    if (!isInsideDirectory(target, scope.thumbnailsRoot)) continue
    await fs.unlink(target).catch(() => undefined)
  }
}

/**
 * 调度后台文件清理。
 *
 * ⚠️ 只能在事务**成功提交之后**调用。
 *
 * 传进来的清单是在事务里算出来的快照；事务抛错时这个函数压根不会被调到 ——
 * 数据库回滚了，磁盘也就没动过，两边不会脱节。反过来如果先删文件再提交事务，
 * 一旦提交失败就会留下「数据库里还有记录、磁盘上文件已没」的不一致。
 */
export function scheduleVaultFileCleanup(files: readonly VaultFileRef[], tag: string): void {
  if (files.length === 0) return

  const captured = [...files]
  // 目录也要现在就定下来 —— 清理跑起来之后用户可能已经切到别的保管库了
  const scope = captureVaultCleanupScope()
  if (!scope) return

  setImmediate(async () => {
    try {
      for (let i = 0; i < captured.length; i += CLEANUP_BATCH) {
        const batch = captured.slice(i, i + CLEANUP_BATCH)
        await Promise.allSettled(batch.map((row) => deleteVaultBackupAndThumbnail(row, scope)))
      }
      console.log(`[${tag}] 后台文件清理完成: ${captured.length} 个文件`)
    } catch (err) {
      console.warn(`[${tag}] 后台文件清理失败:`, err)
    }
  })
}
