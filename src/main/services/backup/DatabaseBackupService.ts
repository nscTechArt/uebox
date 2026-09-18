/**
 * 数据库备份服务
 * 负责本地 SQLite 数据库的自动备份、恢复和版本管理
 */

import { join } from 'path'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { app } from 'electron'
import Database from 'better-sqlite3'
import {
  BackupConfig,
  BackupRecord,
  BackupResult,
  RestoreResult,
  BackupStats,
  DEFAULT_BACKUP_CONFIG
} from './types'
import {
  generateBackupFilename,
  listBackupFiles,
  calculateTotalBackupSize,
  checkDatabaseIntegrity,
  deleteBackupFile,
  getAvailableDiskSpace,
  isPathWritable
} from './utils'

/**
 * 数据库备份服务单例类
 */
export class DatabaseBackupService {
  private static instance: DatabaseBackupService | null = null
  private config: BackupConfig
  private backupDir: string
  private lastBackupTime: number = 0
  /** 并发锁：防止同时多次备份 */
  private isBackupInProgress: boolean = false
  /** 最小安全空间：100MB */
  private static readonly MIN_SAFE_SPACE_BYTES = 100 * 1024 * 1024

  private constructor() {
    this.config = { ...DEFAULT_BACKUP_CONFIG }
    this.backupDir = this.getDefaultBackupDir()
    this.ensureBackupDirectory()
    this.loadLastBackupTime()
  }

  /**
   * 获取单例实例
   */
  static getInstance(): DatabaseBackupService {
    if (!DatabaseBackupService.instance) {
      DatabaseBackupService.instance = new DatabaseBackupService()
    }
    return DatabaseBackupService.instance
  }

  /**
   * 获取默认备份目录
   */
  private getDefaultBackupDir(): string {
    const userDataPath = app.getPath('userData')
    return join(userDataPath, 'database', 'backups')
  }

  /**
   * 确保备份目录存在
   */
  private ensureBackupDirectory(): void {
    const dir = this.config.customBackupPath || this.backupDir
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  /**
   * 加载上次备份时间
   */
  private loadLastBackupTime(): void {
    const records = this.listBackups()
    if (records.length > 0) {
      this.lastBackupTime = new Date(records[0].createdAt).getTime()
    }
  }

  /**
   * 获取当前备份配置
   */
  getConfig(): BackupConfig {
    return { ...this.config }
  }

  /**
   * 更新备份配置
   */
  setConfig(newConfig: Partial<BackupConfig>): void {
    this.config = { ...this.config, ...newConfig }
    if (newConfig.customBackupPath) {
      this.ensureBackupDirectory()
    }
  }

  /**
   * 获取有效的备份目录
   */
  private getEffectiveBackupDir(): string {
    return this.config.customBackupPath || this.backupDir
  }

  /**
   * 列出所有备份
   */
  listBackups(): BackupRecord[] {
    return listBackupFiles(this.getEffectiveBackupDir())
  }

  /**
   * 获取备份统计信息
   */
  getStats(): BackupStats {
    const records = this.listBackups()
    return {
      totalCount: records.length,
      totalSizeBytes: calculateTotalBackupSize(records),
      lastBackupAt: records.length > 0 ? records[0].createdAt : undefined,
      backupDir: this.getEffectiveBackupDir()
    }
  }

  /**
   * 检查是否需要自动备份
   */
  shouldRunScheduledBackup(): boolean {
    if (this.config.backupIntervalHours <= 0) {
      return false // 禁用自动备份
    }
    const intervalMs = this.config.backupIntervalHours * 60 * 60 * 1000
    return Date.now() - this.lastBackupTime > intervalMs
  }

  /**
   * 检查并执行定时备份
   */
  async checkAndRunScheduledBackup(): Promise<BackupResult | null> {
    if (!this.shouldRunScheduledBackup()) {
      console.log('[BackupService] 未到备份时间，跳过')
      return null
    }
    console.log('[BackupService] 执行定时备份')
    return this.createFullBackup()
  }

  /**
   * 创建单个数据库备份
   * 包含完整的边界处理：并发锁、磁盘空间、路径可写性、WAL checkpoint
   */
  async createBackup(dbPath: string, dbName: string): Promise<BackupResult> {
    const backupDir = this.getEffectiveBackupDir()

    // 边界检查 1: 并发锁 - 防止同时多次备份
    if (this.isBackupInProgress) {
      return { success: false, message: '备份进行中，请稍后再试' }
    }
    this.isBackupInProgress = true

    try {
      // 边界检查 2: 源数据库是否存在
      if (!existsSync(dbPath)) {
        return { success: false, message: `数据库文件不存在: ${dbPath}` }
      }

      // 边界检查 3: 备份目录是否可写
      if (!isPathWritable(backupDir)) {
        return { success: false, message: `备份目录不可写: ${backupDir}` }
      }

      // 边界检查 4: 磁盘空间检查 (需预留至少 100MB)
      const availableSpace = getAvailableDiskSpace(backupDir)
      if (availableSpace !== -1 && availableSpace < DatabaseBackupService.MIN_SAFE_SPACE_BYTES) {
        return {
          success: false,
          message: `磁盘空间不足，可用: ${Math.round(availableSpace / 1024 / 1024)}MB，需要至少 100MB`
        }
      }

      // 边界检查 5: 数据库完整性校验
      const integrity = checkDatabaseIntegrity(dbPath)
      if (integrity === 'corrupted') {
        return { success: false, message: `数据库已损坏，无法备份: ${dbPath}` }
      }

      const backupFilename = generateBackupFilename(dbName)
      const backupPath = join(backupDir, backupFilename)

      // 边界处理 6: 尝试 WAL checkpoint 确保数据一致性（最多重试3次）
      let retryCount = 0
      const maxRetries = 3
      while (retryCount < maxRetries) {
        try {
          const db = new Database(dbPath, { readonly: true })
          try {
            // 尝试 checkpoint 刷新 WAL 到主数据库
            db.pragma('wal_checkpoint(PASSIVE)')
          } catch {
            // 忽略 checkpoint 失败，继续备份
          }
          db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
          db.close()
          break // 成功，退出重试循环
        } catch (error) {
          retryCount++
          const errMsg = error instanceof Error ? error.message : String(error)
          if (errMsg.includes('database is locked') && retryCount < maxRetries) {
            console.warn(`[BackupService] 数据库被锁定，重试 ${retryCount}/${maxRetries}`)
            await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount))
            continue
          }
          throw error // 非锁定错误或重试耗尽
        }
      }

      // 边界检查 7: 验证备份文件已创建
      if (!existsSync(backupPath)) {
        return { success: false, message: '备份文件创建失败' }
      }

      // 获取备份文件信息
      const { statSync } = await import('fs')
      const stat = statSync(backupPath)

      const record: BackupRecord = {
        id: `backup_${Date.now()}`,
        dbName,
        filePath: backupPath,
        fileSize: stat.size,
        createdAt: new Date().toISOString(),
        integrityStatus: 'valid'
      }

      this.lastBackupTime = Date.now()

      // 清理过期备份
      await this.cleanupOldBackups()

      console.log(`[BackupService] 备份成功: ${backupPath}`)
      return { success: true, message: '备份成功', record }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[BackupService] 备份失败:', error)
      return { success: false, message: `备份失败: ${msg}` }
    } finally {
      // 释放并发锁
      this.isBackupInProgress = false
    }
  }

  /**
   * 创建完整备份（公共库 + 当前保管库）
   */
  async createFullBackup(): Promise<BackupResult> {
    const userDataPath = app.getPath('userData')
    const publicDbPath = join(userDataPath, 'database', 'app-data.db')

    // 备份公共数据库
    const result = await this.createBackup(publicDbPath, 'app-data')
    return result
  }

  /**
   * 清理过期备份（基于空间上限策略）
   */
  async cleanupOldBackups(): Promise<number> {
    const records = this.listBackups()
    const maxSizeBytes = this.config.maxBackupSizeMB * 1024 * 1024
    let deletedCount = 0

    // 确保至少保留 minBackupCount 个备份
    while (records.length > this.config.minBackupCount) {
      const totalSize = calculateTotalBackupSize(records)

      // 如果在空间限制内且未超过最大数量，停止清理
      if (totalSize <= maxSizeBytes && records.length <= this.config.maxBackupCount) {
        break
      }

      // 删除最旧的备份
      const oldest = records.pop()
      if (oldest && deleteBackupFile(oldest.filePath)) {
        deletedCount++
        console.log(`[BackupService] 清理旧备份: ${oldest.filePath}`)
      }
    }

    return deletedCount
  }

  /**
   * 恢复指定备份
   * 包含边界处理：文件存在性、完整性校验、恢复前保护、恢复后验证、失败回滚
   */
  async restoreBackup(backupId: string): Promise<RestoreResult> {
    const records = this.listBackups()
    const record = records.find((r) => r.id === backupId)

    // 边界检查 1: 备份记录是否存在
    if (!record) {
      return { success: false, message: `未找到备份: ${backupId}` }
    }

    // 边界检查 2: 备份文件是否仍然存在（可能被外部删除）
    if (!existsSync(record.filePath)) {
      return { success: false, message: `备份文件已不存在: ${record.filePath}` }
    }

    // 边界检查 3: 校验备份完整性
    const integrity = checkDatabaseIntegrity(record.filePath)
    if (integrity === 'corrupted') {
      return { success: false, message: '备份文件已损坏，无法恢复' }
    }

    const userDataPath = app.getPath('userData')
    const targetDbPath = join(userDataPath, 'database', `${record.dbName}.db`)
    const preRestorePath = `${targetDbPath}.pre-restore.bak`

    try {
      // 边界处理 4: 创建恢复前保护备份
      if (existsSync(targetDbPath)) {
        copyFileSync(targetDbPath, preRestorePath)
        console.log(`[BackupService] 已创建恢复前保护备份: ${preRestorePath}`)
      }

      // 执行恢复
      copyFileSync(record.filePath, targetDbPath)

      // 边界检查 5: 恢复后验证完整性
      const restoredIntegrity = checkDatabaseIntegrity(targetDbPath)
      if (restoredIntegrity === 'corrupted') {
        // 恢复失败，尝试回滚
        console.error('[BackupService] 恢复后数据库损坏，尝试回滚')
        if (existsSync(preRestorePath)) {
          copyFileSync(preRestorePath, targetDbPath)
          return { success: false, message: '恢复后验证失败，已回滚到原状态' }
        }
        return { success: false, message: '恢复后验证失败，无法回滚' }
      }

      console.log(`[BackupService] 恢复成功: ${record.filePath} -> ${targetDbPath}`)
      return {
        success: true,
        message: '恢复成功，需重启应用生效',
        preRestoreBackupPath: preRestorePath
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[BackupService] 恢复失败:', error)

      // 边界处理 6: 恢复失败时尝试回滚
      if (existsSync(preRestorePath)) {
        try {
          copyFileSync(preRestorePath, targetDbPath)
          console.log('[BackupService] 已回滚到恢复前状态')
        } catch {
          console.error('[BackupService] 回滚失败')
        }
      }

      return { success: false, message: `恢复失败: ${msg}` }
    }
  }

  /**
   * 删除指定备份
   */
  deleteBackup(backupId: string): boolean {
    const records = this.listBackups()
    const record = records.find((r) => r.id === backupId)

    if (!record) {
      return false
    }

    // 确保不会删到最小保留数以下
    if (records.length <= this.config.minBackupCount) {
      console.warn('[BackupService] 无法删除，已达最小保留数量')
      return false
    }

    return deleteBackupFile(record.filePath)
  }
}
