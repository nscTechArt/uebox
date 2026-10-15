/**
 * 资产筛选 / 搜索 —— 主进程入口。
 *
 * SQL 的拼装和执行都在 ./assetSearchCore（纯模块，worker 线程里也能跑）。
 * 这里只做一件事：把主进程的公共库连接补进去 —— 关键词要顺带匹配标签名，
 * 而标签名在公共库里。
 */
import Database from 'better-sqlite3'
import type { AssetData } from './assetData'
import { getPublicDatabase } from '../index'
import {
  buildAssetQueryParts as buildAssetQueryPartsWithEnv,
  countAssetsByCriteria as countAssetsByCriteriaWithEnv,
  searchAssetsByCriteria as searchAssetsByCriteriaWithEnv,
  type AssetQueryEnv,
  type AssetQueryParts,
  type AssetSearchCriteria
} from './assetSearchCore'

export type { AssetQueryEnv, AssetQueryParts, AssetSearchCriteria }

/** 公共库还没初始化（启动早期、单测）时不带标签匹配，其余照常 */
function mainProcessEnv(): AssetQueryEnv {
  try {
    return { publicDb: getPublicDatabase() }
  } catch {
    return {}
  }
}

export function buildAssetQueryParts(
  db: Database.Database,
  criteria: AssetSearchCriteria
): AssetQueryParts {
  return buildAssetQueryPartsWithEnv(db, criteria, mainProcessEnv())
}

export function countAssetsByCriteria(
  db: Database.Database,
  criteria: AssetSearchCriteria
): number {
  return countAssetsByCriteriaWithEnv(db, criteria, mainProcessEnv())
}

export function searchAssetsByCriteria(
  db: Database.Database,
  criteria: AssetSearchCriteria
): AssetData[] {
  return searchAssetsByCriteriaWithEnv(db, criteria, mainProcessEnv())
}
