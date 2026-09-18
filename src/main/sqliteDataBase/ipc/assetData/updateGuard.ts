import type { AssetData } from '../../models/assetData'
import { isPlainFileName } from './thumbnailGuard'

/**
 * 通用更新通道 `db:assetData:update` 的字段闸。
 *
 * 这个通道原来对字段没有任何限制，渲染层可以随手改任意一列。两类后果：
 *
 *  · **状态列**（isDelete / folderKey）各自都有专门的通道
 *    （delete / restore / hardDelete / moveToFolder），那些通道带着权限校验、
 *    远端推送和文件清理。绕过它们直接改列，等于跳过全部这些步骤 → 整列禁止。
 *  · **路径列**是后台删文件时用来定位磁盘文件的依据。把某个资产的 imgLocalPath
 *    改成 `../../vault-data.db` 再删掉这个资产，删的就是保管库数据库本体。
 *    但缩略图那条链**确实要**从渲染层写回 imgLocalPath / customPoster
 *    （`asset:saveThumbnail` 返回一个文件名，渲染层再写库）——
 *    所以这两列不整列禁止，而是**校验值只能是一个纯文件名**。
 *    真正危险的是带 `../` 的值，不是这一列本身。
 *
 * 注意这道闸只挡渲染层这一个入口。主进程内部（导入、同步、拖动整理）仍然直接调
 * `updateAssetData`，它们本来就该能写这些列。
 */

/** 整列禁止：有专门通道，绕过去就跳过了权限校验和远端推送 */
const BLOCKED_COLUMNS = new Set([
  'isDelete',
  'folderKey',
  'filePath',
  'originPath',
  'assetConfigPath'
])

/** 允许写，但值必须是纯文件名（空串 = 重置为默认，也允许） */
const FILENAME_ONLY_COLUMNS = new Set(['imgLocalPath', 'customPoster'])

export interface AssetUpdateGuardResult {
  ok: boolean
  /** 被挡下的列名，用于错误信息 */
  rejected: string[]
}

export function checkRendererAssetUpdate(
  updates: Partial<AssetData> | null | undefined
): AssetUpdateGuardResult {
  if (!updates || typeof updates !== 'object') return { ok: true, rejected: [] }

  const rejected = Object.entries(updates)
    .filter(([key, value]) => {
      if (BLOCKED_COLUMNS.has(key)) return true
      if (!FILENAME_ONLY_COLUMNS.has(key)) return false
      // 清空是合法操作（重置为默认预览图）
      if (value === '' || value === null || value === undefined) return false
      return !isPlainFileName(value)
    })
    .map(([key]) => key)

  return { ok: rejected.length === 0, rejected }
}

/** 拒绝时给出的错误信息 —— 指向应该走的那个通道，别让调用方猜 */
export function assetUpdateRejectionMessage(rejected: readonly string[]): string {
  return (
    `不允许通过通用更新接口这样修改这些字段：${rejected.join(', ')}。` +
    `删除/恢复请用 delete / restore，移动请用 moveToFolder，` +
    `缩略图字段只能填文件名（不能带路径）。`
  )
}
