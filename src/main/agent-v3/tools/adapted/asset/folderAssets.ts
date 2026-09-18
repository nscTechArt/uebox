/**
 * 把一个文件夹展开成 assetKey 列表。
 *
 * ## 为什么需要它
 *
 * 素材库这边的写操作（导入进工程、搬文件夹）认的都是 assetKey —— 一条一条的
 * uuid。可用户说的是**文件夹**：「把 SoStylized 导进去」。两者之间原来没有桥，
 * 于是模型只能先把那个文件夹下的资产一页一页翻出来（一次 100 个，776 个就是
 * 8 轮），拼成一个几百项的 key 数组再喂回去 —— 真机上就这么发生过。
 *
 * 这不是模型笨，是**工具没给它这条路**：`folder` 这个词在写操作的 schema 里
 * 根本不存在。搜索那头早就支持按文件夹筛了（`search_assets` 的 folder 参数），
 * 缺的只是让写操作也认同一套说法。
 *
 * ## 分批是明说的，不是偷偷截断
 *
 * 文件夹可以很大，而导入是一个一个跟引擎打交道的慢操作。所以这里按 limit /
 * offset 分批，并且把 total / hasMore / nextOffset 原样回给调用方 —— 和
 * `search_assets` 的翻页是同一套话术。**绝不能默默只处理前 N 个然后报成功**，
 * 那样用户会以为整个文件夹都进去了。
 */

import type Database from 'better-sqlite3'

import {
  searchAssetsByCriteria,
  type AssetSearchCriteria
} from '../../../../sqliteDataBase/models/assetSearch'
import { resolveFolder } from './folderLookup'

export interface FolderAssetSelection {
  /** 解析出来的文件夹 key；根是 'ALL' */
  folderKey?: string
  /** 给人看的文件夹名（完整路径优先） */
  folderLabel?: string
  /** 这一批的 assetKey */
  assetKeys?: string[]
  /** 文件夹（含子文件夹）里一共有多少个资产 —— 不是这一批的数量 */
  total?: number
  offset?: number
  hasMore?: boolean
  nextOffset?: number
  /** 解析失败的原因，写给模型看 */
  error?: string
}

export interface FolderAssetOptions {
  /** 连子文件夹一起算，默认 true */
  includeSubfolders?: boolean
  /** 这一批最多取几个。不给就全取 */
  limit?: number
  /** 跳过前几个。翻页时填上一次返回的 nextOffset */
  offset?: number
}

/**
 * 排序必须是**全序且稳定**的：分批取的时候，两次调用的顺序不一致就会有资产
 * 被跳过或重复处理。同名资产在素材库里很常见（两次导入的同一个包），所以
 * 名字相同时再用 assetKey 兜底。
 */
function compareAssets(
  a: { assetName?: string; assetKey?: string },
  b: { assetName?: string; assetKey?: string }
): number {
  const nameOrder = String(a.assetName ?? '').localeCompare(String(b.assetName ?? ''))
  if (nameOrder !== 0) return nameOrder
  return String(a.assetKey ?? '').localeCompare(String(b.assetKey ?? ''))
}

/**
 * @param folder 用户/模型给的文件夹标识：folderKey、完整路径（/ALL/角色）或纯名字（角色）
 */
export function selectFolderAssetKeys(
  db: Database.Database,
  folder: string,
  options?: FolderAssetOptions
): FolderAssetSelection {
  const resolved = resolveFolder(db, folder)
  if (resolved.error || !resolved.folderKey) {
    return { error: resolved.error ?? '文件夹解析失败' }
  }

  const folderKey = resolved.folderKey
  const folderLabel = resolved.folder?.fullPath || resolved.folder?.folderName || folderKey

  // 'ALL' 是界面上的虚拟根，assetFolder 表里没有这一条 —— 不加文件夹约束就是整个库
  const criteria: AssetSearchCriteria =
    folderKey === 'ALL'
      ? {}
      : { folderKey, includeSubfolders: options?.includeSubfolders !== false }

  const assets = searchAssetsByCriteria(db, criteria)
  const sorted = [...assets].sort(compareAssets)
  const allKeys = sorted.map((asset) => String(asset.assetKey ?? '').trim()).filter(Boolean)

  const total = allKeys.length
  const offset = Math.max(0, Math.floor(options?.offset ?? 0))
  const limit =
    options?.limit !== undefined ? Math.max(1, Math.floor(options.limit)) : Number.POSITIVE_INFINITY
  const assetKeys = allKeys.slice(offset, offset + limit)
  const nextOffset = offset + assetKeys.length
  const hasMore = nextOffset < total

  return {
    folderKey,
    folderLabel,
    assetKeys,
    total,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset } : {})
  }
}
