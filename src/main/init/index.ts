import { initDatabaseDefaults } from './database'

/**
 * 应用初始化入口
 * 在应用启动时执行所有必要的初始化逻辑
 */
export const initializeApp = (): void => {
  console.log('开始应用初始化...')

  try {
    // 初始化数据库默认数据
    initDatabaseDefaults()

    console.log('应用初始化完成')
  } catch (error) {
    console.error('应用初始化失败:', error)
  }
}

// 导出所有初始化模块
export { initDatabaseDefaults } from './database'
export { ALL_FOLDER, INIT_CONSTANTS } from './constants'
