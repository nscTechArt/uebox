import type Database from 'better-sqlite3'

import { findOrCreateAssetFolder, getAssetFolderByKey } from '../../models/assetFolder'
import type { FolderTypeInfo } from './importAssetMedia'

/**
 * 把一次导入要用到的文件夹行，压成「重建这一行需要的字段」。
 *
 * 写资产的循环跑在事务外，中途文件夹行可能被别的操作删掉；蓝图是它照原样补回来的依据。
 */
export interface ImportFolderBlueprint {
  folderKey: string
  fatherKey: string | null
  type: string
  folderName: string
  img: string
}

export interface ImportFolderTreeInput {
  /** 被导入的磁盘根目录。等于 `ALL_FOLDER` 时表示「散文件直接进目标文件夹」，不建根节点 */
  rootFolderPath: string
  /** 根节点挂在谁下面：已解析好的 `targetFolderKey`，没有就是 `ALL` */
  rootParentKey: string
  /** 散文件模式：不建根节点，`rootFolderKey` 就是 `rootParentKey` */
  isFileImportToAll: boolean
  /** 待建的子文件夹，顺序不限（内部按路径深度排序，保证父先于子） */
  folders: ReadonlyArray<{ path: string; name: string }>
  /** 事务外预取好的文件夹类型与图标，键是未归一化的原始 path */
  folderTypes: ReadonlyMap<string, FolderTypeInfo>
  /** 复用到的和新建的文件夹都会写进来，由调用方持有 */
  folderBlueprints: Map<string, ImportFolderBlueprint>
}

export interface ImportFolderTreeResult {
  rootFolderKey: string
  /** 归一化后的磁盘路径 → folderKey，写资产时按文件的父目录查 */
  pathToKeyMap: Map<string, string>
  /** 这次**真正新建**出来的 folderKey，按创建顺序。远端同步和回滚只认这些 */
  createdFolderKeys: string[]
}

/** 反斜杠一律换成正斜杠，并把重复的斜杠压平 */
export const normalizeImportFolderPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/\/+/g, '/')

/**
 * 建出（或认领）一次导入所需要的整棵文件夹树。
 *
 * **同一个磁盘目录导入两次，必须落到库里同一个文件夹上。** 文件夹的身份就是
 * 「父节点 + 名字」—— 同名兄弟指的本来就是同一个磁盘目录，库里再建一条只会让
 * 树里多出一个同名空壳，资产还是那一份。所以这里一律走
 * `findOrCreateAssetFolder`，先按名字认领，认领不到才新建。
 *
 * 这条规矩以前挂在一个 `reuseExistingFolders` 开关上，而那个开关默认**只在重试
 * 链路打开**：用户自己在界面上点第二次导入，走的是默认关，于是每导一次就新建一棵
 * `folder_${Date.now()}_xxx` 根节点的同名树（真机上同一个文件夹重复出了四份）。
 * 复用没有「不想要」的场景，开关已经删掉。
 */
export const buildImportFolderTree = (
  db: Database.Database,
  input: ImportFolderTreeInput
): ImportFolderTreeResult => {
  const { rootFolderPath, rootParentKey, isFileImportToAll, folderTypes, folderBlueprints } = input
  const pathToKeyMap = new Map<string, string>()
  const createdFolderKeys: string[] = []

  /** 认领或新建一个文件夹，并把它最终落库的样子记进蓝图 */
  const resolveFolder = (fatherKey: string, folderName: string, sourcePath: string): string => {
    const { type, iconPath } = folderTypes.get(sourcePath) ?? { type: 'normal' }
    const { folderKey, created } = findOrCreateAssetFolder(db, {
      folderKey: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      fatherKey,
      type,
      folderName,
      img: iconPath || ''
    })
    if (created) createdFolderKeys.push(folderKey)

    // 蓝图必须回读：新建时 createAssetFolder 会自己算 fullPath/depth，
    // 复用时该用库里那一行的 type/img，而不是这次传进来的。
    const row = getAssetFolderByKey(db, folderKey)
    if (row) {
      folderBlueprints.set(folderKey, {
        folderKey,
        fatherKey: row.fatherKey ?? null,
        type: row.type,
        folderName: row.folderName,
        img: row.img || ''
      })
    }
    return folderKey
  }

  let rootFolderKey = rootParentKey
  if (!isFileImportToAll) {
    const rootFolderName = rootFolderPath.split(/[\\/]/).pop() || 'Unknown'
    rootFolderKey = resolveFolder(rootParentKey, rootFolderName, rootFolderPath)
    pathToKeyMap.set(normalizeImportFolderPath(rootFolderPath), rootFolderKey)
  }

  // 显式按路径深度排序，保证父文件夹先于子文件夹处理 —— 否则子文件夹查 pathToKeyMap
  // 落空，会整层塌到根节点下面。
  const folders = [...input.folders].sort(
    (a, b) =>
      normalizeImportFolderPath(a.path).split('/').length -
      normalizeImportFolderPath(b.path).split('/').length
  )
  for (const folder of folders) {
    const normalizedFolderPath = normalizeImportFolderPath(folder.path)
    const parentPath = normalizedFolderPath.substring(0, normalizedFolderPath.lastIndexOf('/'))
    const parentFolderKey = pathToKeyMap.get(parentPath) || rootFolderKey
    pathToKeyMap.set(normalizedFolderPath, resolveFolder(parentFolderKey, folder.name, folder.path))
  }

  return { rootFolderKey, pathToKeyMap, createdFolderKeys }
}
