import { ipcMain } from 'electron'

import { getVaultDatabase } from '../../index'
import { updateAssetData, type AssetData } from '../../models/assetData'
import { FileProcessorManager } from '../../../utils/fileProcessor/FileProcessorManager'

export function registerAssetMetadataIPC(): void {
  ipcMain.handle('db:processAssetMetadata', async (_, assetKey: string, filePath: string) => {
    void _
    try {
      const db = getVaultDatabase()
      const fileProcessor = new FileProcessorManager()

      if (!fileProcessor.isFileSupported(filePath)) {
        return { success: false, error: '不支持的文件类型' }
      }

      const fileMetadata = await fileProcessor.processFile(filePath)
      if (!fileMetadata || !fileMetadata.metadata) {
        return { success: false, error: '无法处理文件' }
      }

      const updateData: Partial<AssetData> = {
        processorType: fileMetadata.processorType,
        assetType: fileMetadata.assetType,
        engineVersion: fileMetadata.engineVersion,
        classKey: fileMetadata.metadata?.classKey,
        name: fileMetadata.metadata?.name,
        originPath: fileMetadata.metadata?.originPath,
        ext: fileMetadata.metadata?.ext,
        folderName: fileMetadata.metadata?.folderName,
        softPath: fileMetadata.metadata?.softPath,
        assetClass: fileMetadata.metadata?.assetClass,
        className: fileMetadata.metadata?.className,
        imports: fileMetadata.metadata?.imports
          ? JSON.stringify(fileMetadata.metadata.imports)
          : undefined,
        imgLocalPath: fileMetadata.metadata?.imgLocalPath,
        size: fileMetadata.metadata?.size,
        assetConfig: fileMetadata.metadata?.assetConfig,
        assetConfigPath: fileMetadata.metadata?.assetConfigPath
      }

      const success = updateAssetData(db, assetKey, updateData)
      return { success, data: { processed: success } }
    } catch (error) {
      console.error('处理资产元数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
