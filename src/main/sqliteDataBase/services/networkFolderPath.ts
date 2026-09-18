import type Database from 'better-sqlite3'
import { join } from 'path'

import { ALL_FOLDER } from '../../init/constants'
import { isInsideDirectory } from '../../utils/pathContainment'

/**
 * 网络库里某个文件夹对应的物理目录。
 *
 * 这个路径会被拿去 `rm -rf` 和 `rename`，所以算错一次就是删错目录。
 *
 * 原来三处各有一份拷贝，都用 `getAssetFolderByKey` 往上递归 —— 而那个函数带
 * `AND isDelete = 0`。**只要某一级父文件夹是软删状态，递归就返回空串，
 * 路径塌缩成只剩当前文件夹名**，于是 `join(networkPath, "Mesh")` 指向网络根目录
 * 下的同名目录，后台任务对它 `rm -rf`。
 *
 * 「父软删、子活跃」在网络库里完全可能：SyncClient 处理远端删除时只置被点名的
 * 那个 folderKey，不递归子孙。
 *
 * 现在的规则：
 *  1. 往上走时**不过滤 isDelete** —— 软删的父文件夹在磁盘上还在，它是路径的一节；
 *  2. 任何一节查不到、或者链上有环，一律返回 null（**宁可不删，也不删错**）；
 *  3. 拼出来的绝对路径必须落在网络库根目录里面，否则同样返回 null。
 */

interface FolderPathRow {
  folderKey: string
  folderName?: string | null
  fatherKey?: string | null
}

const MAX_DEPTH = 512

/**
 * 一节路径必须是干净的一节。
 *
 * 文件夹名里带分隔符或 `..` 都是坏数据（同步过来的、手改库的都可能），
 * 拼进路径就是往上爬。UNC 根目录会把多余的 `..` 吃掉，看起来「没爬出去」，
 * 但落点已经不是原来那个目录了 —— 所以在拼之前就拦掉，而不是拼完再判。
 */
function isSafeSegment(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  return true
}

/** 沿 fatherKey 往上拼相对路径；算不出来就返回 null，绝不返回半截 */
export function buildNetworkFolderRelPath(db: Database.Database, folderKey: string): string | null {
  if (!folderKey || folderKey === ALL_FOLDER) return null

  const stmt = db.prepare(
    `SELECT folderKey, folderName, fatherKey FROM assetFolder WHERE folderKey = ?`
  )

  const segments: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = folderKey

  for (let depth = 0; cursor && cursor !== ALL_FOLDER; depth++) {
    if (depth >= MAX_DEPTH || seen.has(cursor)) return null
    seen.add(cursor)

    const row = stmt.get(cursor) as FolderPathRow | undefined
    // 链断了就认输：算出来的会是一条比真实位置浅的路径，删下去就是灾难
    if (!row) return null

    const name = String(row.folderName || '').trim()
    if (!isSafeSegment(name)) return null

    segments.unshift(name)
    cursor = row.fatherKey ? String(row.fatherKey) : null
  }

  return segments.length > 0 ? segments.join('/') : null
}

/**
 * 父链的相对路径。
 * @returns 根级返回空串；算不出来返回 null（与「根级」严格区分）
 */
export function buildParentRelPath(
  db: Database.Database,
  fatherKey: string | null | undefined
): string | null {
  if (!fatherKey || fatherKey === ALL_FOLDER) return ''
  return buildNetworkFolderRelPath(db, fatherKey)
}

/** 把相对路径拼成绝对路径，并确认它没爬出网络库根目录 */
function toSafeAbsolute(relPath: string, vaultNetworkPath: string): string | null {
  const absolute = join(vaultNetworkPath, relPath)
  // 纵深防御：文件夹名里带 .. 或分隔符时不能爬出网络库根目录
  return isInsideDirectory(absolute, vaultNetworkPath) ? absolute : null
}

/**
 * 拼出可以安全交给 rm / rename 的绝对路径。
 * @returns null 表示「算不出来或越界」，调用方必须据此跳过文件系统操作
 */
export function resolveNetworkFolderPath(
  db: Database.Database,
  folderKey: string,
  vaultNetworkPath: string | null | undefined
): string | null {
  if (!vaultNetworkPath) return null
  const relPath = buildNetworkFolderRelPath(db, folderKey)
  if (!relPath) return null
  return toSafeAbsolute(relPath, vaultNetworkPath)
}

/**
 * 用「父 key + 指定的文件夹名」拼绝对路径。
 *
 * 重命名要用它：数据库里已经是新名字了，而磁盘上还是旧名字。
 */
export function resolveNetworkFolderPathByName(
  db: Database.Database,
  fatherKey: string | null | undefined,
  folderName: string,
  vaultNetworkPath: string | null | undefined
): string | null {
  if (!vaultNetworkPath) return null
  const name = String(folderName || '').trim()
  if (!isSafeSegment(name)) return null

  const parentRel = buildParentRelPath(db, fatherKey)
  if (parentRel === null) return null

  return toSafeAbsolute(parentRel ? `${parentRel}/${name}` : name, vaultNetworkPath)
}
