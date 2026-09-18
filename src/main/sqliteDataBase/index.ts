import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { initPublicModels } from './models'
import { DatabaseManager } from './DatabaseManager'
import {
  AIGC_VAULT_NAME,
  DEFAULT_VAULT_NAME,
  SYSTEM_VAULT_KEYS,
  VaultManager,
  VaultType
} from './VaultManager'
import {
  ensureAIGCDirectory,
  ensureFolderRecord,
  withAIGCVaultDatabase
} from '../services/aigcVaultService'
import { PathManager } from '../utils/PathManager'
import { loadSqliteVec } from './sqliteVec'
import { mt } from '../i18n'
import {
  AIGC_IMAGE_REFERENCE_LIMIT,
  AIGC_REFERENCE_LIBRARY_FOLDER_KEY,
  AIGC_REFERENCE_LIBRARY_FOLDER_NAME,
  AIGC_ROOT_FOLDER_KEY
} from '../../shared/aigcReferenceLibrary'

// 数据库连接实例
let publicDb: Database.Database | null = null
let databaseManager: DatabaseManager | null = null

// 获取公共数据库文件路径
const getPublicDatabasePath = (): string => {
  // 在用户数据目录的database文件夹中存储公共数据库文件
  const userDataPath = app.getPath('userData')
  const databaseDir = join(userDataPath, 'database')

  // 确保database目录存在
  if (!existsSync(databaseDir)) {
    mkdirSync(databaseDir, { recursive: true })
  }

  return join(databaseDir, 'app-data.db')
}

/**
 * 初始化数据库连接
 * 应在应用启动时调用
 */
export const initDatabase = async (): Promise<void> => {
  try {
    const dbPath = getPublicDatabasePath()
    console.log(`初始化公共数据库: ${dbPath}`)

    // 创建公共数据库连接
    // 注意：verbose 模式会导致每条 SQL 都输出到控制台，影响开发体验
    publicDb = new Database(dbPath)

    // 启用外键约束与并发优化
    publicDb.pragma('foreign_keys = ON')
    try {
      publicDb.pragma('journal_mode = WAL')
      publicDb.pragma('busy_timeout = 5000')
    } catch (e) {
      console.warn('设置公共数据库 WAL/busy_timeout 失败:', e)
    }

    const vecLoaded = loadSqliteVec(publicDb)
    if (!vecLoaded) {
      console.warn('[sqlite-vec] sqlite-vec extension not available; RAG vector search disabled.')
    }

    // 初始化数据库模型（创建表等）
    initPublicModels(publicDb)

    try {
      const { resumeNotebookIndexJobs } = await import('./services/notebookIndexJobService')
      resumeNotebookIndexJobs(publicDb)
    } catch (indexJobError) {
      console.warn('[NotebookRAG] 恢复后台索引任务失败:', indexJobError)
    }

    // 初始化数据库管理器
    databaseManager = DatabaseManager.getInstance(publicDb)

    // 初始化路径管理器
    const pathManager = PathManager.getInstance()
    const vaultManager = VaultManager.getInstance(publicDb)
    pathManager.initialize(vaultManager)

    // 初始化系统保管库
    await initializeSystemVaults()

    // 初始化备份服务并检查是否需要自动备份
    try {
      const { DatabaseBackupService } = await import('../services/backup')
      const backupService = DatabaseBackupService.getInstance()
      await backupService.checkAndRunScheduledBackup()
    } catch (backupError) {
      console.warn('[BackupService] 自动备份检查失败:', backupError)
    }

    console.log('数据库系统初始化成功')
  } catch (error) {
    console.error('数据库初始化失败:', error)
    throw error
  }
}

/**
 * 初始化默认保管库
 */
const initializeSystemVaults = async (): Promise<void> => {
  try {
    const vaultManager = VaultManager.getInstance()
    await vaultManager.ensureSystemVault({
      systemKey: SYSTEM_VAULT_KEYS.DEFAULT,
      name: DEFAULT_VAULT_NAME,
      description: mt('vault.defaultDesc'),
      vaultType: VaultType.BACKUP,
      icon: 'database',
      sortOrder: 0
    })

    await vaultManager.ensureSystemVault({
      systemKey: SYSTEM_VAULT_KEYS.AIGC,
      name: AIGC_VAULT_NAME,
      description: mt('vault.aigcDesc'),
      vaultType: VaultType.BACKUP,
      icon: 'project',
      sortOrder: 1
    })

    await Promise.all([
      ensureAIGCDirectory('AIGC', '图片'),
      ensureAIGCDirectory('AIGC', '视频'),
      ensureAIGCDirectory('AIGC', '音乐'),
      ensureAIGCDirectory('AIGC', '模型'),
      ensureAIGCDirectory('AIGC', AIGC_REFERENCE_LIBRARY_FOLDER_NAME)
    ])

    await withAIGCVaultDatabase((db) => {
      ensureFolderRecord(db, AIGC_ROOT_FOLDER_KEY, null, 'system', 'AIGC')
      ensureFolderRecord(db, 'AIGC_image', AIGC_ROOT_FOLDER_KEY, 'folder', '图片')
      ensureFolderRecord(db, 'AIGC_video', AIGC_ROOT_FOLDER_KEY, 'folder', '视频')
      ensureFolderRecord(db, 'AIGC_music', AIGC_ROOT_FOLDER_KEY, 'folder', '音乐')
      ensureFolderRecord(db, 'AIGC_model', AIGC_ROOT_FOLDER_KEY, 'folder', '模型')
      ensureFolderRecord(
        db,
        AIGC_REFERENCE_LIBRARY_FOLDER_KEY,
        AIGC_ROOT_FOLDER_KEY,
        'folder',
        AIGC_REFERENCE_LIBRARY_FOLDER_NAME
      )
    })

    console.log(
      `[AIGC Vault] 已确保参考素材目录存在: ${AIGC_REFERENCE_LIBRARY_FOLDER_NAME}，参考图上限 ${AIGC_IMAGE_REFERENCE_LIMIT} 张`
    )

    const existingVaults = vaultManager.getAllVaults()
    const defaultVault = vaultManager.getVaultBySystemKey(SYSTEM_VAULT_KEYS.DEFAULT)
    const activeVault =
      existingVaults.find((v) => v.isActive && existsSync(v.path)) ||
      defaultVault ||
      existingVaults[0]

    if (activeVault) {
      await vaultManager.switchToVault(activeVault.id)
      console.log(`已切换到保管库: ${activeVault.name}`)
    }
  } catch (error) {
    console.error('初始化系统保管库失败:', error)
  }
}

/**
 * 获取公共数据库实例
 * 用于访问用户信息、AI任务等公共数据
 */
export const getPublicDatabase = (): Database.Database => {
  if (!publicDb) {
    throw new Error('公共数据库未初始化，请先调用 initDatabase()')
  }
  return publicDb
}

/**
 * 获取数据库管理器实例
 */
export const getDatabaseManager = (): DatabaseManager => {
  if (!databaseManager) {
    throw new Error('数据库管理器未初始化，请先调用 initDatabase()')
  }
  return databaseManager
}

/**
 * 获取数据库实例（向后兼容）
 * 根据调用上下文返回公共数据库或保管库数据库
 */
export const getDatabase = (): Database.Database => {
  if (!databaseManager) {
    // 如果数据库管理器未初始化，返回公共数据库（向后兼容）
    return getPublicDatabase()
  }

  // 尝试返回保管库数据库，如果未连接则返回公共数据库
  try {
    return databaseManager.getVaultDatabase()
  } catch {
    return databaseManager.getPublicDatabase()
  }
}

/**
 * 获取保管库数据库实例
 * 用于访问资产数据、文件夹结构等保管库专属数据
 */
export const getVaultDatabase = (): Database.Database => {
  if (!databaseManager) {
    throw new Error('数据库管理器未初始化，请先调用 initDatabase()')
  }
  return databaseManager.getVaultDatabase()
}

/**
 * 关闭数据库连接
 * 应在应用退出前调用
 */
export const closeDatabase = (): void => {
  try {
    if (databaseManager) {
      databaseManager.closeAllConnections()
      databaseManager = null
    }

    if (publicDb) {
      publicDb.close()
      publicDb = null
      console.log('数据库连接已关闭')
    }
  } catch (error) {
    console.error('关闭数据库连接失败:', error)
  }
}
