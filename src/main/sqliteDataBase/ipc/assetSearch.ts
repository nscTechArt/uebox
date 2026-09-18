import { ipcMain } from 'electron'
import { getVaultDatabase } from '../index'
import { searchAssetsByCriteria, type AssetSearchCriteria } from '../models/assetSearch'

export function registerAssetSearchIPC(): void {
  ipcMain.handle('db:assetSearch:search', async (_event, criteria: AssetSearchCriteria) => {
    try {
      const db = getVaultDatabase()
      const data = searchAssetsByCriteria(db, criteria)
      return { success: true, data }
    } catch (error) {
      console.error('统一资产搜索失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
