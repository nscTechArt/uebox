import { ipcMain } from 'electron'
import { getPublicDatabase, getVaultDatabase } from '../index'
import type { AssetSearchCriteria } from '../models/assetSearch'
import { resolveKeywordCriteria } from '../models/assetSearchIndex'
import { searchAssetsOffMainThread } from '../services/assetQueryRunner'
import { ensureAssetSearchIndexWarm } from '../services/assetSearchIndexService'

function safePublicDb(): ReturnType<typeof getPublicDatabase> | null {
  try {
    return getPublicDatabase()
  } catch {
    return null
  }
}

export function registerAssetSearchIPC(): void {
  ipcMain.handle('db:assetSearch:search', async (_event, criteria: AssetSearchCriteria) => {
    try {
      const db = getVaultDatabase()
      const publicDb = safePublicDb()

      /**
       * 资产库的搜索框以前直接拿原文做五列 `LIKE '%词%'`，几十万行每次都是全表扫。
       * 全文索引早就有了（Spotlight、助手都在用），这里一直没接上。
       * 索引追平了就走索引；没追平（刚同步完、刚导入完）先退回 LIKE —— 结果是全的，
       * 只是慢 —— 同时推一把后台补齐，下一次就快了。
       */
      let resolved = criteria
      if (criteria?.keyword && !criteria.ftsMatch) {
        const keyword = resolveKeywordCriteria(db, criteria.keyword)
        if (!keyword.indexReady) ensureAssetSearchIndexWarm(db, { publicDb: publicDb ?? undefined })
        resolved = { ...criteria, keyword: keyword.keyword, ftsMatch: keyword.ftsMatch }
      }

      const data = await searchAssetsOffMainThread(db, resolved, publicDb)
      return { success: true, data }
    } catch (error) {
      console.error('统一资产搜索失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
