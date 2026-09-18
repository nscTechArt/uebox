/**
 * 数据库备份服务 - 工具函数
 * 提供文件操作、完整性校验等辅助功能
 */

import {
  existsSync,
  statSync,
  statfsSync,
  readdirSync,
  unlinkSync,
  accessSync,
  constants
} from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'
import Database from 'better-sqlite3'
import type { BackupRecord } from './types'

/**
 * 获取路径所在磁盘的可用空间（字节）
 * Windows 保留 wmic，Mac/Linux 读取目标文件系统；失败时返回 -1。
 */
export function getAvailableDiskSpace(targetPath: string): number {
  try {
    if (process.platform !== 'win32') {
      const stats = statfsSync(targetPath, { bigint: true })
      // bavail excludes blocks reserved for privileged users.
      const available = stats.bsize * stats.bavail
      if (available < 0n) return -1
      return Number(
        available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available
      )
    }
    const drive = targetPath.charAt(0).toUpperCase()
    const output = execSync(
      `wmic logicaldisk where "DeviceID='${drive}:'" get FreeSpace /format:value`,
      {
        encoding: 'utf8',
        windowsHide: true
      }
    )
    const match = output.match(/FreeSpace=(\d+)/)
    if (match) {
      return parseInt(match[1], 10)
    }
    return -1
  } catch {
    return -1 // 无法获取
  }
}

/**
 * 检查路径是否可写
 */
export function isPathWritable(targetPath: string): boolean {
  try {
    const dir =
      existsSync(targetPath) && statSync(targetPath).isDirectory()
        ? targetPath
        : dirname(targetPath)
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析备份文件名获取时间戳
 * 格式: {dbName}.{timestamp}.bak
 */
export function parseBackupFilename(
  filename: string
): { dbName: string; timestamp: number } | null {
  const match = filename.match(/^(.+)\.(\d+)\.bak$/)
  if (!match) return null
  return {
    dbName: match[1],
    timestamp: parseInt(match[2], 10)
  }
}

/**
 * 生成备份文件名
 */
export function generateBackupFilename(dbName: string): string {
  const timestamp = Date.now()
  return `${dbName}.${timestamp}.bak`
}

/**
 * 获取目录下所有备份文件列表
 */
export function listBackupFiles(backupDir: string): BackupRecord[] {
  if (!existsSync(backupDir)) {
    return []
  }

  const files = readdirSync(backupDir)
  const records: BackupRecord[] = []

  for (const file of files) {
    if (!file.endsWith('.bak')) continue

    const parsed = parseBackupFilename(file)
    if (!parsed) continue

    const filePath = join(backupDir, file)
    try {
      const stat = statSync(filePath)
      records.push({
        id: `backup_${parsed.timestamp}`,
        dbName: parsed.dbName,
        filePath,
        fileSize: stat.size,
        createdAt: new Date(parsed.timestamp).toISOString(),
        integrityStatus: 'unknown'
      })
    } catch {
      // 跳过无法读取的文件
    }
  }

  // 按时间降序排序（最新的在前）
  return records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

/**
 * 计算备份文件总大小
 */
export function calculateTotalBackupSize(records: BackupRecord[]): number {
  return records.reduce((sum, r) => sum + r.fileSize, 0)
}

/**
 * 校验 SQLite 数据库完整性
 */
export function checkDatabaseIntegrity(dbPath: string): 'valid' | 'corrupted' {
  if (!existsSync(dbPath)) {
    return 'corrupted'
  }

  try {
    const db = new Database(dbPath, { readonly: true })
    const result = db.pragma('quick_check') as Array<{ quick_check: string }>
    db.close()

    if (result.length === 1 && result[0].quick_check === 'ok') {
      return 'valid'
    }
    return 'corrupted'
  } catch {
    return 'corrupted'
  }
}

/**
 * 删除指定备份文件
 */
export function deleteBackupFile(filePath: string): boolean {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 格式化文件大小为可读字符串
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
