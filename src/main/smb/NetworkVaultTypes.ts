/**
 * NetworkVaultTypes - 局域网协作库类型定义
 * 定义 index.json 的数据结构和相关类型
 */

/**
 * index.json 主结构
 */
export interface NetworkVaultManifest {
  /** 格式版本 */
  version: number
  /** 资产库名称 */
  name: string
  /** 资产库描述 */
  description?: string
  /** 资产库图标 */
  icon?: string
  /** 创建时间 */
  createdAt: string
  /** 最后修改时间 */
  modifiedAt: string
  /** 最后修改者 */
  modifiedBy: string
  /** 文件夹列表 */
  folders: NetworkVaultFolder[]
  /** 资产列表 */
  assets: NetworkVaultAsset[]
}

/**
 * 局域网协作库文件夹
 */
export interface NetworkVaultFolder {
  /** 文件夹唯一键 */
  key: string
  /** 文件夹名称 */
  name: string
  /** 父文件夹键（根目录为 null 或 'ALL'） */
  parent: string | null
  /** 文件夹封面图（相对于 .thumbnails 目录） */
  img?: string
  /** 标签列表 */
  tags?: string[]
  /** 创建者 */
  createdBy?: string
  /** 创建时间 */
  createdAt?: string
}

/**
 * 网络资产库资产
 */
export interface NetworkVaultAsset {
  /** 资产唯一键 */
  key: string
  /** 所属文件夹键 */
  folder: string
  /** 资产名称 */
  name: string
  /** 相对于网络路径的文件路径 */
  path: string
  /** 资产类型 (如 SkeletalMesh, StaticMesh 等) */
  type?: string
  /** 资产类名 */
  className?: string
  /** 文件大小（字节） */
  size?: number
  /** 文件 MD5 哈希 */
  hash?: string
  /** 引擎版本 */
  engineVersion?: string
  /** 标签列表 */
  tags?: string[]
  /** 备注 */
  note?: string
  /** 缩略图相对路径 */
  thumbnail?: string
  /** 额外元数据 */
  metadata?: Record<string, unknown>
  /** 创建者 */
  createdBy?: string
  /** 创建时间 */
  createdAt?: string
  /** 最后修改者 */
  modifiedBy?: string
  /** 最后修改时间 */
  modifiedAt?: string
}

/**
 * 同步结果
 */
export interface SyncResult {
  success: boolean
  error?: string
  /** 新增资产数 */
  added?: number
  /** 更新资产数 */
  updated?: number
  /** 删除资产数 */
  removed?: number
  /** 是否有冲突 */
  hasConflict?: boolean
  /** 远程版本号 */
  remoteVersion?: number
  /** 本地版本号 */
  localVersion?: number
}

/**
 * 冲突信息
 */
export interface ConflictInfo {
  type?: 'version_mismatch'
  conflictType?: 'update_conflict' | 'delete_modified'
  assetKey?: string
  localVersion: unknown
  remoteVersion: unknown
  remoteModifiedBy?: string
  remoteModifiedAt?: string
}

/**
 * 扫描选项
 */
export interface ScanOptions {
  /** 是否包含子目录 */
  recursive?: boolean
  /** @deprecated 已废弃，扫描现在收录所有文件，不再按扩展名过滤 */
  extensions?: string[]
  /** 排除的目录名 */
  excludeDirs?: string[]
}

/**
 * 默认空 manifest
 */
export const createEmptyManifest = (name: string, createdBy: string): NetworkVaultManifest => ({
  version: 1,
  name,
  createdAt: new Date().toISOString(),
  modifiedAt: new Date().toISOString(),
  modifiedBy: createdBy,
  folders: [],
  assets: []
})

/**
 * Manifest 文件名常量
 */
export const MANIFEST_FILENAME = 'index.json'
export const THUMBNAILS_DIR = '.thumbnails'
export const JOURNAL_DIR = '_journal'
export const DEPENDENCY_DIR = '.dependency'
export const LOCK_FILENAME = 'index.lock'

/**
 * 扫描时统一排除的目录列表
 * 所有扫描函数（scanAssets、scanAssetsWithMetadata、scanFilePaths）必须使用此常量
 * 以确保扫描范围一致，避免因排除不一致导致资产被误删或重复添加
 */
export const SCAN_EXCLUDE_DIRS = [THUMBNAILS_DIR, JOURNAL_DIR, DEPENDENCY_DIR]

/**
 * 扫描时排除的根目录系统文件（不应被当作资产录入）
 */
export const SCAN_EXCLUDE_FILES = [MANIFEST_FILENAME, LOCK_FILENAME]

/**
 * Journal 操作类型
 */
export type JournalOperation =
  | 'add_asset'
  | 'update_asset'
  | 'delete_asset'
  | 'add_folder'
  | 'update_folder'
  | 'delete_folder'

/**
 * Journal 条目 - 记录单次变更
 * 命名规则: {timestamp}_{uuid}_{hostname}.json
 */
export interface JournalEntry {
  /** 操作类型 */
  op: JournalOperation
  /** 操作时间戳 */
  timestamp: number
  /** 操作者主机名 */
  hostname: string
  /** 基于的 manifest 版本 */
  baseVersion: number
  /** 目标 ID (资产或文件夹) */
  targetId: string
  /** 变更内容 (仅包含修改的字段) */
  changes: Record<string, unknown>
  /** 完整数据 (仅 add 操作使用) */
  data?: NetworkVaultAsset | NetworkVaultFolder
}

/**
 * 锁文件内容
 */
export interface LockFileInfo {
  owner: string
  ts: number
}

/**
 * 生成 Journal 文件名
 */
export const generateJournalFilename = (hostname: string): string => {
  const timestamp = Date.now()
  const uuid = Math.random().toString(36).substring(2, 10)
  return `${timestamp}_${uuid}_${hostname}.json`
}
