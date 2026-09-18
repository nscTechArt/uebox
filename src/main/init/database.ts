import { getDatabase } from '../sqliteDataBase'
import { getAssetFolderByKey, createAssetFolder } from '../sqliteDataBase/models/assetFolder'
import { ALL_FOLDER } from './constants'

/**
 * 初始化数据库基础数据
 */
export const initDatabaseDefaults = (): void => {
  try {
    const db = getDatabase()

    // 检查是否存在ALL根文件夹
    const allFolder = getAssetFolderByKey(db, ALL_FOLDER)

    if (!allFolder) {
      // 创建ALL根文件夹
      createAssetFolder(db, {
        folderKey: ALL_FOLDER,
        fatherKey: null,
        type: 'system',
        folderName: 'ALL',
        img: ''
      })

      console.log('已创建默认根文件夹: ALL')
    }
  } catch (error) {
    console.error('初始化数据库默认数据失败:', error)
  }
}
