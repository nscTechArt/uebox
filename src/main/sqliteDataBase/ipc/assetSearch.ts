import { ipcMain } from 'electron'
import { getPublicDatabase, getVaultDatabase } from '../index'
import type { AssetSearchCriteria } from '../models/assetSearch'
import {
  QueryCancelledError,
  engineFacetOffMainThread,
  searchAssetsOffMainThread
} from '../services/assetQueryRunner'

function safePublicDb(): ReturnType<typeof getPublicDatabase> | null {
  try {
    return getPublicDatabase()
  } catch {
    return null
  }
}

/**
 * 资产库列表 / 筛选 / 搜索。查询在 worker 线程里跑（见 services/assetQueryRunner）。
 *
 * 关键词照旧是 LIKE 子串匹配，**不改走全文索引**：全文索引按词前缀匹配、不拆驼峰，
 * 「Character」搜不到 BP_PlayerCharacter，「SM_Chair_01」会拆成 sm / chair / 01 三个词
 * 把所有 SM_ 开头的都搜出来；全文索引里也没有回收站的行，回收站里按名字搜永远是空的。
 * 慢的问题交给 worker —— 再慢也只是这一页晚一点出来，不会卡住整个软件。
 *
 * criteria.queryGroup：同一组（资产库列表是 'asset-list'）来了新查询，旧的还没开始就作废。
 * 作废 / 库正在切换导致的取消回 cancelled: true，界面别当成「搜索失败」弹提示。
 */
export function registerAssetSearchIPC(): void {
  ipcMain.handle(
    'db:assetSearch:search',
    async (_event, input: AssetSearchCriteria & { queryGroup?: string }) => {
      try {
        const { queryGroup, ...criteria } = input ?? {}
        const data = await searchAssetsOffMainThread(
          getVaultDatabase(),
          criteria,
          safePublicDb(),
          queryGroup
        )
        return { success: true, data }
      } catch (error) {
        if (error instanceof QueryCancelledError) {
          return { success: false, cancelled: true, error: error.message }
        }
        console.error('统一资产搜索失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 筛选栏的引擎版本下拉：各版本有几个（同一组筛选条件，见 countAssetsByEngineVersion）
  ipcMain.handle('db:assetSearch:engineFacet', async (_event, criteria: AssetSearchCriteria) => {
    try {
      const data = await engineFacetOffMainThread(
        getVaultDatabase(),
        criteria ?? {},
        safePublicDb()
      )
      return { success: true, data }
    } catch (error) {
      if (error instanceof QueryCancelledError) {
        return { success: false, cancelled: true, error: error.message }
      }
      console.error('引擎版本分面失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
