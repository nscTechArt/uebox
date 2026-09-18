import { ipcMain } from 'electron'
import { getPublicDatabase, getVaultDatabase } from '../index'
import {
  disableAssetSemanticSearch,
  enableAssetSemanticSearch,
  getAssetSemanticStatus,
  startAssetSemanticIndexing
} from '../services/assetSemanticService'

/**
 * 资产库语义搜索的开关和进度。
 *
 * 开关放在设置里、由用户自己按，是因为**建索引要花钱花时间**：
 * 每个资产都要调一次 embedding 模型。这个代价该不该付只有用户知道，
 * 所以这里只提供开 / 关 / 看进度 / 继续，不做任何自动开启。
 */
export function registerAssetSemanticIPC(): void {
  ipcMain.handle('db:assetSemantic:status', async () => {
    try {
      return { success: true, data: getAssetSemanticStatus(getVaultDatabase()) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetSemantic:enable', async () => {
    try {
      const result = await enableAssetSemanticSearch(getVaultDatabase(), getPublicDatabase())
      if (!result.ok) return { success: false, error: result.error }
      return { success: true, data: getAssetSemanticStatus(getVaultDatabase()) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:assetSemantic:disable', async () => {
    try {
      disableAssetSemanticSearch(getVaultDatabase())
      return { success: true, data: getAssetSemanticStatus(getVaultDatabase()) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 上一轮因为报错停下来了（没配模型、网断了、余额没了），修好之后接着算
  ipcMain.handle('db:assetSemantic:resume', async () => {
    try {
      const db = getVaultDatabase()
      startAssetSemanticIndexing(db, getPublicDatabase())
      return { success: true, data: getAssetSemanticStatus(db) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
