import Database from 'better-sqlite3'
import { VaultManager } from './VaultManager'

/**
 * 数据库连接管理器
 * 负责管理公共数据库和保管库数据库的连接
 */
export class DatabaseManager {
  private static instance: DatabaseManager | null = null
  private publicDatabase: Database.Database
  private vaultManager: VaultManager

  private constructor(publicDb: Database.Database) {
    this.publicDatabase = publicDb
    this.vaultManager = VaultManager.getInstance(publicDb)
  }

  /**
   * 获取单例实例
   */
  static getInstance(publicDb?: Database.Database): DatabaseManager {
    if (!DatabaseManager.instance) {
      if (!publicDb) {
        throw new Error('首次创建DatabaseManager实例时必须提供公共数据库连接')
      }
      DatabaseManager.instance = new DatabaseManager(publicDb)
    }
    return DatabaseManager.instance
  }

  /**
   * 获取公共数据库连接
   * 用于访问用户信息、AI任务、保管库注册表等公共数据
   */
  getPublicDatabase(): Database.Database {
    return this.publicDatabase
  }

  /**
   * 获取当前保管库数据库连接
   * 用于访问资产数据、文件夹结构等保管库专属数据
   */
  getVaultDatabase(): Database.Database {
    const vaultDb = this.vaultManager.getCurrentVaultDatabase()
    if (!vaultDb) {
      throw new Error('未选择保管库或保管库数据库未连接')
    }
    return vaultDb
  }

  /**
   * 检查保管库数据库是否已连接
   */
  isVaultDatabaseConnected(): boolean {
    return this.vaultManager.getCurrentVaultDatabase() !== null
  }

  /**
   * 获取当前保管库信息
   */
  getCurrentVault() {
    return this.vaultManager.getCurrentVault()
  }

  /**
   * 切换保管库数据库
   */
  async switchVaultDatabase(vaultId: string): Promise<boolean> {
    const result = await this.vaultManager.switchToVault(vaultId)
    return result.success
  }

  /**
   * 关闭保管库数据库连接
   */
  closeVaultDatabase(): void {
    // VaultManager 内部会处理数据库连接的关闭
    // 这里主要用于外部调用时的接口统一
  }

  /**
   * 关闭所有数据库连接
   */
  closeAllConnections(): void {
    this.vaultManager.dispose()
    // 注意：公共数据库连接由外部管理，这里不关闭
  }

  /**
   * 获取保管库管理器实例
   */
  getVaultManager(): VaultManager {
    return this.vaultManager
  }

  /**
   * 执行需要保管库数据库的操作
   * 提供统一的错误处理和连接检查
   */
  async executeVaultOperation<T>(operation: (vaultDb: Database.Database) => T): Promise<T> {
    const vaultDb = this.getVaultDatabase()

    try {
      return operation(vaultDb)
    } catch (error) {
      console.error('[DatabaseManager] 保管库数据库操作失败:', error)
      throw error
    }
  }

  /**
   * 执行公共数据库操作
   */
  async executePublicOperation<T>(operation: (publicDb: Database.Database) => T): Promise<T> {
    try {
      return operation(this.publicDatabase)
    } catch (error) {
      console.error('[DatabaseManager] 公共数据库操作失败:', error)
      throw error
    }
  }

  /**
   * 执行跨数据库事务操作
   * 注意：SQLite不支持跨数据库事务，这里提供逻辑上的事务处理
   */
  async executeTransactionOperation<T>(
    publicOperation?: (publicDb: Database.Database) => T,
    vaultOperation?: (vaultDb: Database.Database) => T
  ): Promise<{ publicResult?: T; vaultResult?: T }> {
    const results: { publicResult?: T; vaultResult?: T } = {}

    try {
      // 执行公共数据库操作
      if (publicOperation) {
        results.publicResult = await this.executePublicOperation(publicOperation)
      }

      // 执行保管库数据库操作
      if (vaultOperation) {
        results.vaultResult = await this.executeVaultOperation(vaultOperation)
      }

      return results
    } catch (error) {
      console.error('[DatabaseManager] 跨数据库事务操作失败:', error)
      throw error
    }
  }
}
