/**
 * 把用户嘴里的文件夹名换成 folderKey。
 *
 * 用户说的是「Trees」「/ALL/角色/武器」，而库里所有写操作认的是 folderKey ——
 * 一串 uuid，用户不知道，模型也猜不出来。以前这段解析逻辑只长在 create_folders
 * 里（找父文件夹用），于是后来要做「搬到 Trees 里去」「Trees 里有什么」时，
 * 要么各写一份，要么干脆不支持按名字指定。抽出来共用。
 *
 * **同名文件夹一律报错，不猜。** 素材库里同名文件夹很常见（两次导入的 UI、
 * 两个包各带一个 Textures）。猜错的后果是资产被搬进另一个文件夹 —— 用户找不到，
 * 而且不会有任何报错告诉他发生了什么。把候选列出来让人选，比替他赌一把强。
 */

import {
  getAllAssetFolders,
  getAssetFolderByKey,
  getAssetFolderByPath,
  type AssetFolder
} from '../../../../sqliteDataBase/models/assetFolder'
import type Database from 'better-sqlite3'

export interface FolderResolution {
  /** 解析成功时的文件夹；'ALL'（根）时为 undefined，但 folderKey 是 'ALL' */
  folder?: AssetFolder
  folderKey?: string
  /** 解析失败的原因，写给模型看，带下一步怎么办 */
  error?: string
}

const ROOT_KEY = 'ALL'

/**
 * @param input 用户/模型给的文件夹标识：folderKey、完整路径（/ALL/角色）或纯名字（角色）
 */
export function resolveFolder(db: Database.Database, input: string): FolderResolution {
  const raw = String(input ?? '').trim()
  if (!raw) return { error: '没有给出文件夹。给 folderKey、完整路径（/ALL/角色）或文件夹名。' }
  if (raw.toUpperCase() === ROOT_KEY) return { folderKey: ROOT_KEY }

  const byKey = getAssetFolderByKey(db, raw)
  if (byKey) return { folder: byKey, folderKey: byKey.folderKey }

  // 带斜杠 = 用户给的是完整路径，按路径精确匹配，命中就是它。
  //
  // 光秃秃一个名字则**先看重名**再当路径试：库里根下有个 Trees、角色下也有个
  // Trees 时，把「Trees」解释成 `/Trees` 等于替用户挑了根下那个 —— 挑错了
  // 没有任何提示。重名必须问，不能按路径深度赌一个。
  if (raw.startsWith('/')) {
    const byPath = getAssetFolderByPath(db, raw)
    if (byPath) return { folder: byPath, folderKey: byPath.folderKey }
    return {
      error: `找不到路径「${raw}」。用 search_assets 看看资产都在哪些文件夹里，或者先用 create_folders 建一个。`
    }
  }

  const matches = getAllAssetFolders(db).filter(
    (f) => f.folderName?.toLowerCase() === raw.toLowerCase()
  )
  if (matches.length === 1) return { folder: matches[0], folderKey: matches[0].folderKey }
  if (matches.length > 1) {
    const candidates = matches.map((f) => `${f.fullPath || f.folderName}（${f.folderKey}）`)
    return {
      error:
        `库里有 ${matches.length} 个叫「${raw}」的文件夹，不知道你要哪一个：${candidates.join('、')}。` +
        '把完整路径或 folderKey 给我，或者问用户要哪一个。'
    }
  }

  return {
    error: `找不到文件夹「${raw}」。用 search_assets 看看资产都在哪些文件夹里，或者先用 create_folders 建一个。`
  }
}
