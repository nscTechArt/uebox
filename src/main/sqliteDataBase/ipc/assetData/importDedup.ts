import type Database from 'better-sqlite3'
import { isAbsolute, resolve } from 'path'

import { getAssetDataByKey, getAssetDataByOriginPath, type AssetData } from '../../models/assetData'
import { calculateFullFileHash } from './fileUtils'

/** 保留旧抽样指纹作为索引，只有完整内容一致的候选才能复用路径或资产记录。 */
export async function findIdenticalLocalAssets(
  db: Database.Database,
  sourcePath: string,
  fileMd5: string,
  vaultRoot: string
): Promise<AssetData[]> {
  const candidates = db
    .prepare('SELECT * FROM assetData WHERE fileMd5 = ? AND isDelete = 0')
    .all(fileMd5) as AssetData[]
  if (candidates.length === 0) return []

  const sourceHash = await calculateFullFileHash(sourcePath)
  const pathHashes = new Map<string, string | null>()
  const verified: AssetData[] = []
  for (const candidate of candidates) {
    if (!candidate.filePath) continue
    // HTTP 远端相对路径不能按本机路径确认内容。
    if (!isAbsolute(candidate.filePath) && !vaultRoot) continue
    const filePath = resolve(vaultRoot, candidate.filePath)
    if (!pathHashes.has(filePath)) {
      try {
        pathHashes.set(filePath, await calculateFullFileHash(filePath))
      } catch {
        // 缺失或不可读的副本不允许充当查重依据。
        pathHashes.set(filePath, null)
      }
    }
    if (pathHashes.get(filePath) === sourceHash) verified.push(candidate)
  }
  return verified
}

/**
 * 导入一个文件时，先看看库里是不是已经有它了。
 *
 * 为什么必须统一走这里：以前只有「解析成功的 uasset/umap」那条分支查了 originPath，
 * 非 UE 文件（贴图/fbx/zip）和解析失败的 uasset 一律无条件新建。于是同一个文件夹
 * 第二次拖进网络库时，复制阶段判定内容相同、自动算成功，写库阶段却给每个文件都发
 * 一个全新的随机 assetKey —— **库里静默多出一整套指向同一个网络路径的重复记录**，
 * 而且没有任何提示（修复前那个场景至少还会被覆盖确认弹窗拦一下）。
 */
export interface ExistingAssetLookup {
  /** HTTP NAS 模式按远端相对路径查到的行；有就直接用，允许有权限的成员覆盖旧文件 */
  existingRemoteAsset?: AssetData
  /** 网络库模式按 originPath 去重 */
  isNetworkMode: boolean
  /** 这个文件在库里记录的 originPath（网络库模式下是复制后的网络路径） */
  originPath?: string
  /** 本地库：来源路径、内容和落点共同确定重复导入。 */
  fileMd5?: string
  folderKey?: string
  /** 在写事务外完成完整内容核验的候选，不能只凭 fileMd5 合并。 */
  verifiedLocalAssets?: readonly AssetData[]
}

/**
 * 本地库的重复导入。
 *
 * 本地库原来只用 MD5 复用**文件路径**（省一次复制），assetKey 照旧发新的 ——
 * 于是导入 5 万文件中途崩掉、重来一遍，库里就是**第二套完整记录**，
 * 全都指着同一批物理文件。这正是工作室规模用户最先撞上的那个坑。
 *
 * 来源路径、完整内容核验和 folderKey 必须同时一致。同字节的两个源文件仍然是
 * 两条独立资产；不能把物理内容复用当成资产身份。
 */
export function findExistingAssetRow(
  db: Database.Database,
  lookup: ExistingAssetLookup
): AssetData | undefined {
  if (lookup.existingRemoteAsset) return lookup.existingRemoteAsset

  if (lookup.isNetworkMode) {
    return lookup.originPath ? getAssetDataByOriginPath(db, lookup.originPath) : undefined
  }

  if (lookup.fileMd5 && lookup.folderKey && lookup.originPath) {
    for (const verified of lookup.verifiedLocalAssets || []) {
      const current = getAssetDataByKey(db, verified.assetKey)
      if (
        current?.folderKey === lookup.folderKey &&
        normalizeSourcePath(current.originPath || current.filePath || '') ===
          normalizeSourcePath(lookup.originPath) &&
        current.fileMd5 === lookup.fileMd5 &&
        current.filePath === verified.filePath
      ) {
        return current
      }
    }
  }
  return undefined
}

export const normalizeSourcePath = (path: string): string => {
  if (!path) return ''
  const normalized = resolve(path).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
