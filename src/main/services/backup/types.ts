/**
 * 数据库备份服务 - 类型定义
 * 用于本地 SQLite 数据库的自动备份与恢复
 */

/**
 * 备份配置接口
 */
export interface BackupConfig {
  /** 备份空间上限(MB)，默认 3072 (3GB) */
  maxBackupSizeMB: number
  /** 最小保留版本数，默认 2 */
  minBackupCount: number
  /** 最大保留版本数，默认 10 */
  maxBackupCount: number
  /** 自动备份间隔(小时)，默认 24 */
  backupIntervalHours: number
  /** 自定义备份路径（可选） */
  customBackupPath?: string
}

/**
 * 备份记录接口
 */
export interface BackupRecord {
  /** 备份唯一标识 */
  id: string
  /** 数据库名称 */
  dbName: string
  /** 备份文件完整路径 */
  filePath: string
  /** 备份文件大小(字节) */
  fileSize: number
  /** 创建时间 ISO 格式 */
  createdAt: string
  /** 完整性状态 */
  integrityStatus: 'valid' | 'corrupted' | 'unknown'
}

/**
 * 备份结果接口
 */
export interface BackupResult {
  success: boolean
  message: string
  record?: BackupRecord
}

/**
 * 恢复结果接口
 */
export interface RestoreResult {
  success: boolean
  message: string
  /** 恢复前的保护备份路径 */
  preRestoreBackupPath?: string
}

/**
 * 备份统计信息
 */
export interface BackupStats {
  /** 备份总数 */
  totalCount: number
  /** 备份总大小(字节) */
  totalSizeBytes: number
  /** 最近备份时间 */
  lastBackupAt?: string
  /** 备份目录路径 */
  backupDir: string
}

/**
 * 默认备份配置
 */
export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  maxBackupSizeMB: 3072, // 3GB
  minBackupCount: 2,
  maxBackupCount: 10,
  backupIntervalHours: 24,
  customBackupPath: undefined
}
