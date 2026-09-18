import { beginImportVaultSwitch, finishImportVaultSwitch } from '../services/asset/importControl'
import { join, resolve, dirname, sep, basename } from 'path'
import { getAppWindows } from '../appWindows'
import { promises as fs } from 'fs'
import { existsSync, mkdirSync } from 'fs'
import * as fsExtra from 'fs-extra'
import { app, safeStorage } from 'electron'
import { generateAccessKey } from '../networkV2/ServerAuth'
import { probeRemoteVault } from '../networkV2/remoteVaultProbe'
import { DbHandleRegistry } from './dbHandleRegistry'
import Database from 'better-sqlite3'
import { VaultServiceManager } from '../networkV2/VaultServiceManager'
import { authStatusOf } from '../networkV2/SyncClient'
import { initAssetSearchIndexModel } from './models/assetSearchIndex'
import { initAssetNoteModel } from './models/assetNote'
import { ensureSqliteVecLoaded } from './sqliteVec'

/**
 * 保管库信息接口
 */
/**
 * 保管库类型枚举
 */
export enum VaultType {
  REFERENCE = 'reference', // 引用类型
  BACKUP = 'backup', // 备份类型
  NETWORK = 'network' // 网络协作库
}

export type NetworkMigrationState = 'ready' | 'legacy_pending'
export const SYSTEM_VAULT_KEYS = {
  DEFAULT: 'default',
  AIGC: 'aigc'
} as const
export type SystemVaultKey = (typeof SYSTEM_VAULT_KEYS)[keyof typeof SYSTEM_VAULT_KEYS]
export const DEFAULT_VAULT_NAME = '默认保管库'
export const AIGC_VAULT_NAME = 'AIGC 资产库'

export interface VaultInfo {
  id: string
  name: string
  description?: string
  path: string
  isSystem: boolean
  systemKey?: SystemVaultKey
  isCustomLocation: boolean
  isActive: boolean
  vaultType: VaultType
  icon: string
  sortOrder: number
  assetCount: number
  totalSize: number
  diskInfo?: {
    totalSpace: number
    freeSpace: number
    usedSpace: number
  }
  createdAt: string
  updatedAt: string
  networkMigrationState?: NetworkMigrationState
  // 网络库专用字段
  networkPath?: string // 网络路径 (如 \\server\share)
  browsePath?: string // 用于跳转到服务器目录的共享路径
  requiresAuth?: boolean // 是否需要认证
  syncStatus?: 'synced' | 'syncing' | 'conflict' | 'offline' | 'error'
  lastSyncAt?: string // 上次同步时间
}

/**
 * 数据库保管库行记录接口
 */
interface VaultRow {
  id: string
  name: string
  description?: string
  path: string
  is_system?: number
  system_key?: string
  is_custom_location: number
  is_active: number
  vault_type: string
  icon: string
  sort_order: number
  asset_count: number
  total_size: number
  disk_info?: string
  created_at: string
  updated_at: string
  // 网络库专用字段
  network_path?: string
  browse_path?: string
  requires_auth?: number
  sync_status?: string
  last_sync_at?: string
}

/**
 * 资产统计查询结果接口
 */
interface AssetStatsRow {
  count?: number
  totalSize?: number
}

/**
 * 保管库创建配置
 */
export interface CreateVaultConfig {
  name: string
  description?: string
  customPath?: string
  isSystem?: boolean
  systemKey?: SystemVaultKey
  vaultType?: VaultType
  icon?: string
  sortOrder?: number
  // 网络库专用
  networkPath?: string
  browsePath?: string
}

/**
 * 路径验证结果
 */
export interface PathValidationResult {
  valid: boolean
  error?: string
  warnings?: string[]
}

/**
 * 保管库管理器
 * 负责多保管库的创建、切换、删除和管理
 */
export class VaultManager {
  private static instance: VaultManager | null = null
  private readonly vaultsRootPath: string
  private readonly publicDatabase: Database.Database
  private currentVaultDb: Database.Database | null = null
  /**
   * 后台网络库（不是当前库）的数据库连接。
   *
   * 这些连接要一直开着给 AssetServer / SyncClient 用，所以必须自己记账。
   * 原来 startAllNetworkServers 每次切库都 `new Database(...)` 一遍，
   * 而 AssetServer.registerVault 只是把 map 里的旧条目覆盖掉、从不 close ——
   * 于是**每切一次库，就为每个后台网络库泄漏一个 SQLite 句柄**。
   * 切几十次之后 WAL 一直长，Windows 上还会压住库文件导致删库/移库 EBUSY。
   */
  private backgroundVaultDbs = new DbHandleRegistry<Database.Database>((vaultId, error) => {
    console.warn(`[VaultManager] 关闭后台网络库连接失败 (${vaultId}):`, error)
  })
  private currentVaultInfo: VaultInfo | null = null

  private constructor(publicDb: Database.Database) {
    this.publicDatabase = publicDb
    const userDataPath = app.getPath('userData')
    this.vaultsRootPath = resolve(userDataPath, 'database', 'vaults')
    this.initializeVaultsTable()
    this.initializeLegacyNetworkV2Flags()
    this.ensureVaultsDirectory()
  }

  /**
   * 获取单例实例
   */
  static getInstance(publicDb?: Database.Database): VaultManager {
    if (!VaultManager.instance) {
      if (!publicDb) {
        throw new Error('首次创建VaultManager实例时必须提供公共数据库连接')
      }
      VaultManager.instance = new VaultManager(publicDb)
    }
    return VaultManager.instance
  }

  /**
   * 初始化保管库表结构
   */
  private initializeVaultsTable(): void {
    const createVaultsTable = `
      CREATE TABLE IF NOT EXISTS vaults (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        path TEXT NOT NULL,
        is_system BOOLEAN DEFAULT FALSE,
        system_key TEXT,
        is_custom_location BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT FALSE,
        vault_type TEXT NOT NULL DEFAULT 'backup',
        icon TEXT DEFAULT 'database',
        sort_order INTEGER DEFAULT 0,
        asset_count INTEGER DEFAULT 0,
        total_size INTEGER DEFAULT 0,
        disk_info TEXT,
        network_path TEXT,
        browse_path TEXT,
        requires_auth BOOLEAN DEFAULT FALSE,
        sync_status TEXT DEFAULT 'synced',
        last_sync_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      )
    `

    const createAppSettingsTable = `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        type TEXT DEFAULT 'string',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      )
    `

    const createIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_vaults_name ON vaults(name)',
      'CREATE INDEX IF NOT EXISTS idx_vaults_active ON vaults(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_vaults_created ON vaults(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_vaults_vault_type ON vaults(vault_type)',
      'CREATE INDEX IF NOT EXISTS idx_vaults_is_system ON vaults(is_system)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_system_key_unique ON vaults(system_key) WHERE system_key IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_app_settings_key ON app_settings(key)'
    ]

    this.publicDatabase.exec(createVaultsTable)
    this.publicDatabase.exec(createAppSettingsTable)
    this.migrateAppSettingsTable()
    this.migrateVaultsTableForNetwork()
    createIndexes.forEach((sql) => {
      try {
        this.publicDatabase.exec(sql)
      } catch (error) {
        console.warn('[VaultManager] 创建索引失败:', sql, error)
      }
    })

    // 迁移：为已存在的 app_settings 表补齐 type/created_at/updated_at 列
    this.migrateAppSettingsTable()
    // 迁移：为已存在的表添加网络库相关列
    this.migrateVaultsTableForNetwork()
  }

  /**
   * 迁移：添加网络库相关列到已存在的 vaults 表
   */
  private migrateVaultsTableForNetwork(): void {
    const migrations = [
      { name: 'is_system', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'system_key', type: 'TEXT' },
      { name: 'network_path', type: 'TEXT' },
      { name: 'browse_path', type: 'TEXT' },
      { name: 'requires_auth', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'sync_status', type: "TEXT DEFAULT 'synced'" },
      { name: 'last_sync_at', type: 'TEXT' }
    ]

    try {
      type ColumnInfo = { name: string }
      const columns = this.publicDatabase.prepare('PRAGMA table_info(vaults)').all() as ColumnInfo[]
      const existingColumns = columns.map((col) => col.name)

      for (const col of migrations) {
        if (!existingColumns.includes(col.name)) {
          try {
            this.publicDatabase.exec(`ALTER TABLE vaults ADD COLUMN ${col.name} ${col.type}`)
            console.log(`[VaultManager] 迁移: 添加列 ${col.name} 到 vaults 表`)
          } catch (e) {
            console.warn(`[VaultManager] 添加列 ${col.name} 失败:`, e)
          }
        }
      }
    } catch (e) {
      console.warn('[VaultManager] vaults 表网络库字段迁移检查失败:', e)
    }
  }

  getVaultBySystemKey(systemKey: SystemVaultKey): VaultInfo | null {
    const row = this.publicDatabase
      .prepare('SELECT * FROM vaults WHERE system_key = ? LIMIT 1')
      .get(systemKey) as VaultRow | undefined

    if (!row) return null

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      path: row.path,
      isSystem: Boolean(row.is_system),
      systemKey: row.system_key as SystemVaultKey | undefined,
      isCustomLocation: Boolean(row.is_custom_location),
      isActive: Boolean(row.is_active),
      vaultType: row.vault_type as VaultType,
      icon: row.icon || 'database',
      sortOrder: row.sort_order || 0,
      assetCount: row.asset_count,
      totalSize: row.total_size,
      diskInfo: row.disk_info ? JSON.parse(row.disk_info) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      networkPath: row.network_path,
      browsePath: row.browse_path,
      requiresAuth: Boolean(row.requires_auth),
      syncStatus: row.sync_status as VaultInfo['syncStatus'],
      lastSyncAt: row.last_sync_at,
      networkMigrationState: this.getNetworkMigrationState(row.id, row.vault_type as VaultType)
    }
  }

  async ensureSystemVault(
    config: CreateVaultConfig & { systemKey: SystemVaultKey }
  ): Promise<VaultInfo> {
    const existingSystemVault = this.getVaultBySystemKey(config.systemKey)
    if (existingSystemVault) {
      return existingSystemVault
    }

    const existingNameVault = this.getVaultByName(config.name)
    if (existingNameVault && existingNameVault.vaultType !== VaultType.NETWORK) {
      this.promoteVaultToSystem(existingNameVault.id, config)
      const promotedVault = this.getVaultById(existingNameVault.id)
      if (promotedVault) {
        return promotedVault
      }
    }

    return this.createVault({
      ...config,
      isSystem: true
    })
  }

  isProtectedVault(vaultOrId: string | VaultInfo): boolean {
    const vaultInfo = typeof vaultOrId === 'string' ? this.getVaultById(vaultOrId) : vaultOrId
    return Boolean(vaultInfo?.isSystem)
  }

  /**
   * 迁移：为旧 schema 的 app_settings 表补齐 type/created_at/updated_at 列
   * 兼容 settings.ts 先创建的只有 key/value 两列的情况
   */
  private migrateAppSettingsTable(): void {
    const migrations = [
      { name: 'type', type: "TEXT DEFAULT 'string'" },
      // ALTER TABLE ADD COLUMN 只允许常量默认值，不能用 datetime() 函数
      // 实际时间戳由 INSERT 语句（setNetworkV2Enabled/setAppSetting）提供
      { name: 'created_at', type: "TEXT DEFAULT ''" },
      { name: 'updated_at', type: "TEXT DEFAULT ''" }
    ]

    try {
      type ColumnInfo = { name: string }
      const columns = this.publicDatabase
        .prepare('PRAGMA table_info(app_settings)')
        .all() as ColumnInfo[]
      const existingColumns = columns.map((col) => col.name)

      for (const col of migrations) {
        if (!existingColumns.includes(col.name)) {
          try {
            this.publicDatabase.exec(`ALTER TABLE app_settings ADD COLUMN ${col.name} ${col.type}`)
            console.log(`[VaultManager] 迁移: 添加列 ${col.name} 到 app_settings 表`)
          } catch (e) {
            console.warn(`[VaultManager] 添加列 ${col.name} 到 app_settings 失败:`, e)
          }
        }
      }
    } catch (e) {
      console.warn('[VaultManager] app_settings 表迁移检查失败:', e)
    }
  }

  private getNetworkV2SettingKey(vaultId: string): string {
    return `network_v2_enabled:${vaultId}`
  }

  private getNetworkApiKeySettingKey(vaultId: string): string {
    return `network_api_key:${vaultId}`
  }

  private initializeLegacyNetworkV2Flags(): void {
    try {
      const rows = this.publicDatabase
        .prepare(`SELECT id, vault_type FROM vaults WHERE vault_type = ?`)
        .all(VaultType.NETWORK) as Array<{ id: string; vault_type: string }>

      const getStmt = this.publicDatabase.prepare('SELECT value FROM app_settings WHERE key = ?')
      const insertStmt = this.publicDatabase.prepare(`
        INSERT INTO app_settings (key, value, type, created_at, updated_at)
        VALUES (?, ?, 'string', datetime('now', 'localtime'), datetime('now', 'localtime'))
      `)

      for (const row of rows) {
        const key = this.getNetworkV2SettingKey(row.id)
        const existing = getStmt.get(key) as { value?: string } | undefined
        if (existing) continue
        insertStmt.run(key, 'false')
      }
    } catch (error) {
      console.warn('[VaultManager] 初始化网络库 V2 标记失败:', error)
    }
  }

  private isNetworkV2Enabled(vaultId: string): boolean {
    try {
      const row = this.publicDatabase
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(this.getNetworkV2SettingKey(vaultId)) as { value?: string } | undefined
      return row?.value === 'true'
    } catch {
      return false
    }
  }

  private setNetworkV2Enabled(vaultId: string, enabled: boolean): void {
    this.publicDatabase
      .prepare(
        `
        INSERT INTO app_settings (key, value, type, created_at, updated_at)
        VALUES (?, ?, 'string', datetime('now', 'localtime'), datetime('now', 'localtime'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now', 'localtime')
      `
      )
      .run(this.getNetworkV2SettingKey(vaultId), enabled ? 'true' : 'false')
  }

  private getNetworkMigrationState(
    vaultId: string,
    vaultType: VaultType
  ): NetworkMigrationState | undefined {
    if (vaultType !== VaultType.NETWORK) return undefined
    return this.isNetworkV2Enabled(vaultId) ? 'ready' : 'legacy_pending'
  }

  private getNetworkUpgradeSnapshotKey(vaultId: string): string {
    return `network_v2_snapshot:${vaultId}`
  }

  private getNetworkUpgradeAuditKey(vaultId: string): string {
    return `network_v2_audit:${vaultId}`
  }

  private setAppSetting(key: string, value: string): void {
    this.publicDatabase
      .prepare(
        `
        INSERT INTO app_settings (key, value, type, created_at, updated_at)
        VALUES (?, ?, 'string', datetime('now', 'localtime'), datetime('now', 'localtime'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now', 'localtime')
      `
      )
      .run(key, value)
  }

  // ─────────────── 本机作为 Server 时的访问码 ───────────────

  private getServerAccessKeySettingKey(vaultId: string, role: 'read' | 'write'): string {
    return `network_v2_server_key:${role}:${vaultId}`
  }

  private getShareWritePublishSettingKey(vaultId: string): string {
    return `network_v2_share_write:${vaultId}`
  }

  /**
   * 读取（必要时生成）本机作为 Server 时该 Vault 的一对访问码。
   *
   * 存储沿用 app_settings —— 客户端侧的 network_api_key:* 本来就在这儿，
   * 不新增文件格式、不新增迁移。值经 safeStorage 加密后再存，前缀标明是否加密。
   *
   * 为什么不学 NetworkAuthManager 的「加密不可用就拒绝保存」：那保护的是 SMB
   * 账号密码，存不下只是不能自动重连，功能不塌；而这里的码是服务器**唯一**的
   * 准入凭据，存不下 = 服务器起不来 = 功能整个废掉，用户只会去找办法把鉴权
   * 关掉，那更糟。明文的实际暴露面也很小 —— 能读到这个 SQLite 的攻击者本来就
   * 能直接读同一台机器上的全部资产；访问码防的是**远端**攻击者。
   */
  getOrCreateNetworkVaultServerKeys(vaultId: string): { readKey: string; writeKey: string } {
    const readKey =
      this.readServerAccessKey(vaultId, 'read') ??
      this.writeServerAccessKey(vaultId, 'read', generateAccessKey())
    const writeKey =
      this.readServerAccessKey(vaultId, 'write') ??
      this.writeServerAccessKey(vaultId, 'write', generateAccessKey())
    return { readKey, writeKey }
  }

  /** 轮换访问码 —— 即「踢掉某台机器」的实现方式 */
  rotateNetworkVaultServerKeys(
    vaultId: string,
    which: 'read' | 'write' | 'both'
  ): { readKey: string; writeKey: string } {
    if (which === 'read' || which === 'both') {
      this.writeServerAccessKey(vaultId, 'read', generateAccessKey())
    }
    if (which === 'write' || which === 'both') {
      this.writeServerAccessKey(vaultId, 'write', generateAccessKey())
    }
    return this.getOrCreateNetworkVaultServerKeys(vaultId)
  }

  isNetworkVaultShareWriteEnabled(vaultId: string): boolean {
    try {
      const row = this.publicDatabase
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(this.getShareWritePublishSettingKey(vaultId)) as { value?: string } | undefined
      return row?.value === 'true'
    } catch {
      return false
    }
  }

  setNetworkVaultShareWriteEnabled(vaultId: string, enabled: boolean): void {
    this.setAppSetting(this.getShareWritePublishSettingKey(vaultId), enabled ? 'true' : 'false')
  }

  private readServerAccessKey(vaultId: string, role: 'read' | 'write'): string | undefined {
    try {
      const row = this.publicDatabase
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(this.getServerAccessKeySettingKey(vaultId, role)) as { value?: string } | undefined
      const stored = row?.value?.trim()
      if (!stored) return undefined
      if (stored.startsWith('enc:')) {
        if (!safeStorage.isEncryptionAvailable()) {
          console.warn('[VaultManager] safeStorage 不可用，无法解密已存访问码，将重新生成')
          return undefined
        }
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')) || undefined
      }
      return stored.startsWith('raw:') ? stored.slice(4) : stored
    } catch (error) {
      console.warn('[VaultManager] 读取资产库访问码失败:', error)
      return undefined
    }
  }

  private writeServerAccessKey(vaultId: string, role: 'read' | 'write', key: string): string {
    let stored = `raw:${key}`
    try {
      if (safeStorage.isEncryptionAvailable()) {
        stored = `enc:${safeStorage.encryptString(key).toString('base64')}`
      } else {
        console.warn('[VaultManager] safeStorage 不可用，资产库访问码以明文存储于 app_settings')
      }
    } catch (error) {
      console.warn('[VaultManager] 访问码加密失败，回退明文:', error)
    }
    this.setAppSetting(this.getServerAccessKeySettingKey(vaultId, role), stored)
    return key
  }

  getNetworkVaultApiKey(vaultId: string): string | undefined {
    try {
      const row = this.publicDatabase
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(this.getNetworkApiKeySettingKey(vaultId)) as { value?: string } | undefined
      const value = row?.value?.trim()
      return value || undefined
    } catch (error) {
      console.warn('[VaultManager] 读取网络库 API Key 失败:', error)
      return undefined
    }
  }

  setNetworkVaultApiKey(vaultId: string, apiKey?: string): void {
    const value = apiKey?.trim()
    if (!value) {
      this.publicDatabase
        .prepare('DELETE FROM app_settings WHERE key = ?')
        .run(this.getNetworkApiKeySettingKey(vaultId))
      return
    }
    this.setAppSetting(this.getNetworkApiKeySettingKey(vaultId), value)
  }

  private readVaultContentCounts(db: Database.Database): {
    assetCount: number
    folderCount: number
  } {
    const assetRow = db
      .prepare('SELECT COUNT(*) as count FROM assetData WHERE COALESCE(isDelete, 0) = 0')
      .get() as { count?: number } | undefined
    const folderRow = db
      .prepare(
        "SELECT COUNT(*) as count FROM assetFolder WHERE COALESCE(isDelete, 0) = 0 AND folderKey != 'ALL'"
      )
      .get() as { count?: number } | undefined

    return {
      assetCount: assetRow?.count || 0,
      folderCount: folderRow?.count || 0
    }
  }

  private async createNetworkUpgradeSnapshot(
    vaultInfo: VaultInfo,
    db: Database.Database
  ): Promise<{ backupPath: string; assetCount: number; folderCount: number; createdAt: string }> {
    const backupDir = join(vaultInfo.path, '.migration-backups')
    await fs.mkdir(backupDir, { recursive: true })

    const createdAt = new Date().toISOString()
    const backupPath = join(backupDir, `vault-data.pre-v2.${Date.now()}.db`)
    await db.backup(backupPath)

    const counts = this.readVaultContentCounts(db)
    const snapshot = {
      createdAt,
      backupPath,
      assetCount: counts.assetCount,
      folderCount: counts.folderCount
    }
    this.setAppSetting(this.getNetworkUpgradeSnapshotKey(vaultInfo.id), JSON.stringify(snapshot))
    return snapshot
  }

  private recordNetworkUpgradeAudit(
    vaultId: string,
    audit: {
      backupPath: string
      beforeAssetCount: number
      afterAssetCount: number
      beforeFolderCount: number
      afterFolderCount: number
      hasDrift: boolean
      createdAt: string
    }
  ): void {
    this.setAppSetting(this.getNetworkUpgradeAuditKey(vaultId), JSON.stringify(audit))
  }

  /**
   * 确保保管库根目录存在
   */
  private ensureVaultsDirectory(): void {
    if (!existsSync(this.vaultsRootPath)) {
      mkdirSync(this.vaultsRootPath, { recursive: true })
    }
  }

  /**
   * 创建新保管库
   */
  async createVault(config: CreateVaultConfig): Promise<VaultInfo> {
    if (config.systemKey) {
      const existingSystemVault = this.getVaultBySystemKey(config.systemKey)
      if (existingSystemVault) {
        throw new Error(`系统保管库已存在: ${config.systemKey}`)
      }
    }

    const vaultId = config.systemKey
      ? `system_vault_${config.systemKey}`
      : `vault_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    // 确定保管库路径
    let vaultPath: string
    let isCustomLocation = false

    if (config.customPath) {
      vaultPath = await this.prepareCustomVaultPath(config.customPath, config.name)
      isCustomLocation = true
    } else {
      vaultPath = join(this.vaultsRootPath, vaultId)
    }

    // 验证路径
    const validation = await this.validateVaultPath(vaultPath)
    if (!validation.valid) {
      throw new Error(validation.error || '路径验证失败')
    }

    // 检查路径冲突
    if (await this.isPathInUse(vaultPath)) {
      throw new Error('选择的路径已被其他保管库使用')
    }

    // vaultDb 提升到 try 外层，确保成功/失败都能正确关闭句柄
    let vaultDb: Database.Database | null = null

    try {
      // 创建保管库目录结构
      await this.createVaultDirectories(vaultPath)

      // 创建保管库数据库
      const vaultDbPath = join(vaultPath, 'vault-data.db')
      vaultDb = new Database(vaultDbPath)
      try {
        vaultDb.pragma('journal_mode = WAL')
        vaultDb.pragma('busy_timeout = 5000')
      } catch (e) {
        console.warn('[VaultManager] 设置 WAL/busy_timeout 失败:', e)
      }
      this.initializeVaultDatabase(vaultDb)

      // 创建保管库信息文件
      await this.createVaultInfoFile(vaultPath, vaultId, config.name)

      const vaultInfo: VaultInfo = {
        id: vaultId,
        name: config.name,
        description: config.description,
        path: vaultPath,
        isSystem: Boolean(config.isSystem || config.systemKey),
        systemKey: config.systemKey,
        isCustomLocation,
        isActive: false,
        vaultType: config.vaultType || VaultType.BACKUP,
        icon: config.icon || 'database',
        sortOrder: config.sortOrder || 0,
        assetCount: 0,
        totalSize: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // 网络库专用字段
        networkPath: config.networkPath,
        browsePath: config.browsePath?.trim() || undefined,
        requiresAuth: false,
        syncStatus: 'synced',
        networkMigrationState:
          (config.vaultType || VaultType.BACKUP) === VaultType.NETWORK ? 'ready' : undefined
      }

      // 事务：insertVaultRecord + setNetworkV2Enabled 要么都成功，要么都回滚
      const createTransaction = this.publicDatabase.transaction(() => {
        this.insertVaultRecord(vaultInfo)
        if (vaultInfo.vaultType === VaultType.NETWORK) {
          this.setNetworkV2Enabled(vaultId, true)
        }
      })
      createTransaction()

      // 成功：关闭 vaultDb 句柄
      vaultDb.close()
      vaultDb = null

      console.log(
        `[VaultManager] 保管库创建成功: ${config.name} (${vaultId}), vaultType=${vaultInfo.vaultType}, requestedType=${config.vaultType}`
      )
      return vaultInfo
    } catch (error) {
      console.error(`[VaultManager] 创建保管库失败:`, error)
      // 先关闭 vaultDb 句柄，释放文件锁，再清理文件系统
      if (vaultDb) {
        try {
          vaultDb.close()
        } catch (closeErr) {
          console.warn('[VaultManager] 关闭 vaultDb 失败:', closeErr)
        }
        vaultDb = null
      }
      // 清理失败的创建：删除残留的 vaults 记录 + 文件系统目录
      try {
        this.publicDatabase.prepare('DELETE FROM vaults WHERE id = ?').run(vaultId)
      } catch (dbCleanupError) {
        console.warn(`[VaultManager] 清理失败的 vaults 记录失败:`, dbCleanupError)
      }
      try {
        if (existsSync(vaultPath)) {
          await fs.rm(vaultPath, { recursive: true, force: true })
        }
      } catch (cleanupError) {
        console.warn(`[VaultManager] 清理失败的保管库目录失败:`, cleanupError)
      }
      throw new Error(`创建保管库失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 移动保管库到新位置
   * @param vaultId 保管库ID
   * @param newParentPath 新的父目录路径
   * @returns 成功则返回新路径，失败抛出错误
   */
  async moveVault(vaultId: string, newParentPath: string): Promise<string> {
    const vaultInfo = this.getVaultById(vaultId)
    if (!vaultInfo) {
      throw new Error(`保管库不存在: ${vaultId}`)
    }

    if (vaultInfo.systemKey === SYSTEM_VAULT_KEYS.AIGC && this.isNetworkStylePath(newParentPath)) {
      throw new Error('AIGC 资产库仅支持迁移到本地目录')
    }

    // 验证新父目录
    if (!existsSync(newParentPath)) {
      throw new Error(`目标目录不存在: ${newParentPath}`)
    }

    // 计算新路径
    const folderName = basename(vaultInfo.path)
    const newVaultPath = join(newParentPath, folderName)

    // 检查目标路径是否已存在
    if (existsSync(newVaultPath)) {
      // 如果只是路径大小写不同（Windows），可能不算存在，但在 fs-extra.move 中会处理
      // 这里如果完全相同，则无需移动
      if (resolve(vaultInfo.path) === resolve(newVaultPath)) {
        return vaultInfo.path
      }
      throw new Error(`目标路径已存在: ${newVaultPath}`)
    }

    // 检查是否有其他保管库使用了该路径
    if (await this.isPathInUse(newVaultPath)) {
      throw new Error(`该路径已被其他保管库使用`)
    }

    // 如果是当前活跃的保管库，需要先断开连接。
    // 顺序很关键：必须先停网络服务再关连接 —— AssetServer / SyncClient 手里
    // 攥着的就是这个句柄，先关了它们再用就是 use-after-close，
    // 移动过程中任何一个服务端请求打进来都会抛错。
    const isCurrent = this.currentVaultInfo?.id === vaultId
    if (isCurrent) {
      await this.stopV2NetworkService(vaultId)
      if (this.currentVaultDb) {
        try {
          this.currentVaultDb.close()
        } catch (e) {
          console.warn('关闭数据库失败', e)
        }
        this.currentVaultDb = null
      }
    }

    try {
      // 移动文件夹 (使用 fs-extra 处理跨分区移动)
      await fsExtra.move(vaultInfo.path, newVaultPath)
    } catch (error) {
      // 如果移动失败，尝试恢复数据库连接（如果是活跃的）
      if (isCurrent) {
        // 尝试重新连接原路径
        try {
          await this.switchToVault(vaultId)
        } catch (e) {
          console.error('恢复数据库连接失败', e)
        }
      }
      throw new Error(`移动文件失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 更新数据库记录
    try {
      const updateStmt = this.publicDatabase.prepare(
        "UPDATE vaults SET path = ?, is_custom_location = 1, updated_at = datetime('now', 'localtime') WHERE id = ?"
      )
      updateStmt.run(newVaultPath, vaultId)
    } catch (error) {
      // 严重错误：文件已移动但数据库更新失败
      console.error('数据库更新失败，但文件已移动', error)
      throw new Error(`数据库更新失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 如果是活跃的，重新连接
    if (isCurrent) {
      await this.switchToVault(vaultId)
    }

    console.log(`[VaultManager] 保管库已移动: ${vaultInfo.name} -> ${newVaultPath}`)
    return newVaultPath
  }

  /**
   * 切换到指定保管库
   * @param vaultId 保管库ID
   * @returns 包含成功状态和错误信息的对象
   */
  async switchToVault(
    vaultId: string
  ): Promise<{ success: boolean; error?: string; networkError?: string }> {
    let acquired = false
    try {
      beginImportVaultSwitch()
      acquired = true
      const vaultInfo = this.getVaultById(vaultId)
      if (!vaultInfo) {
        return { success: false, error: `保管库不存在: ${vaultId}` }
      }

      // 验证保管库路径是否仍然有效
      if (!existsSync(vaultInfo.path)) {
        return { success: false, error: `保管库路径不存在: ${vaultInfo.path}` }
      }

      // V2: 停止上一个保管库的网络服务
      if (this.currentVaultInfo) {
        await this.stopV2NetworkService(this.currentVaultInfo.id)
      }

      // 关闭当前保管库数据库连接
      if (this.currentVaultDb) {
        try {
          this.currentVaultDb.close()
        } catch (closeError) {
          console.warn('[VaultManager] 关闭当前数据库连接失败:', closeError)
        }
        this.currentVaultDb = null
      }

      // 连接到新保管库数据库
      const vaultDbPath = join(vaultInfo.path, 'vault-data.db')
      if (!existsSync(vaultDbPath)) {
        return { success: false, error: `保管库数据库文件不存在: ${vaultDbPath}` }
      }

      try {
        this.currentVaultDb = new Database(vaultDbPath)
        this.currentVaultDb.pragma('journal_mode = WAL')
        this.currentVaultDb.pragma('busy_timeout = 5000')
      } catch (dbError) {
        const errMsg = dbError instanceof Error ? dbError.message : String(dbError)
        console.error('[VaultManager] 连接保管库数据库失败:', dbError)
        return { success: false, error: `连接保管库数据库失败: ${errMsg}` }
      }

      this.currentVaultInfo = vaultInfo

      // 确保保管库数据库表结构完整
      this.initializeVaultDatabase(this.currentVaultDb)

      // 后台把全文索引补齐。切库之后欠的账是这个库自己的，所以每次切都要推一把。
      // 分片进行，期间搜索照常可用（退回 LIKE）。
      void import('./services/assetSearchIndexService')
        .then(({ ensureAssetSearchIndexWarm }) => {
          if (this.currentVaultDb) {
            ensureAssetSearchIndexWarm(this.currentVaultDb, { publicDb: this.publicDatabase })
          }
        })
        .catch((e) => console.warn('[VaultManager] 全文索引后台补齐没能启动:', e))

      // 更新活跃状态
      this.updateActiveVault(vaultId)

      // V2: 如果是网络库，自动启动网络服务
      let networkError: string | undefined
      if (vaultInfo.vaultType === VaultType.NETWORK && vaultInfo.networkPath) {
        if (this.isNetworkV2Enabled(vaultInfo.id)) {
          const netResult = await this.startV2NetworkService(vaultInfo, this.currentVaultDb)
          if (!netResult.success) {
            networkError = netResult.error
          }
        } else {
          this.updateSyncStatus(vaultInfo.id, 'offline')
          console.warn(
            `[VaultManager] Skip automatic V2 startup for legacy network vault until explicitly enabled: ${vaultInfo.name} (${vaultInfo.id})`
          )
        }
      }

      // V2: 启动所有其他网络库的 Server 服务（异步，不阻塞切换）
      this.startAllNetworkServers().catch((err) =>
        console.warn('[VaultManager] 启动其他网络库服务失败:', err)
      )

      // 告诉界面「活跃库换了」。
      //
      // 以前不广播是因为切库**只可能**由渲染层发起（vault:switch），它自己
      // 改完 store 就完事了。但主进程里也有几处会切（网络库迁移、以后 agent
      // 的 switch_vault），那几条路上界面会停在旧库上 —— 用户看着 A 库，
      // 应用实际在 B 库上读写，这种不一致比切不过去糟糕得多。
      for (const win of getAppWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('vault:switched', { vaultId, name: vaultInfo.name })
        }
      }

      console.log(`[VaultManager] 切换到保管库: ${vaultInfo.name} (${vaultId})`)
      return { success: true, networkError }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      console.error(`[VaultManager] 切换保管库失败:`, error)
      return { success: false, error: errMsg }
    } finally {
      if (acquired) finishImportVaultSwitch()
    }
  }

  /**
   * 获取当前活跃保管库
   */
  getCurrentVault(): VaultInfo | null {
    return this.currentVaultInfo
  }

  /**
   * 获取当前保管库数据库连接
   */
  getCurrentVaultDatabase(): Database.Database | null {
    return this.currentVaultDb
  }

  async withVaultDatabase<T>(
    vaultId: string,
    operation: (vaultDb: Database.Database, vaultInfo: VaultInfo) => Promise<T> | T
  ): Promise<T> {
    const vaultInfo = this.getVaultById(vaultId)
    if (!vaultInfo) {
      throw new Error(`保管库不存在: ${vaultId}`)
    }

    if (this.currentVaultInfo?.id === vaultId && this.currentVaultDb) {
      return await operation(this.currentVaultDb, vaultInfo)
    }

    const vaultDbPath = join(vaultInfo.path, 'vault-data.db')
    if (!existsSync(vaultDbPath)) {
      throw new Error(`保管库数据库文件不存在: ${vaultDbPath}`)
    }

    const vaultDb = new Database(vaultDbPath)
    try {
      vaultDb.pragma('journal_mode = WAL')
      vaultDb.pragma('busy_timeout = 5000')
      this.initializeVaultDatabase(vaultDb)
      return await operation(vaultDb, vaultInfo)
    } finally {
      vaultDb.close()
    }
  }

  /**
   * 获取所有保管库列表
   */
  getAllVaults(): VaultInfo[] {
    const query = `
      SELECT id, name, description, path, is_system, system_key, is_custom_location, is_active,
             vault_type, icon, sort_order, asset_count, total_size, disk_info,
             network_path, browse_path, requires_auth, sync_status, last_sync_at,
             created_at, updated_at
      FROM vaults
      ORDER BY sort_order ASC, created_at DESC
    `

    const rows = this.publicDatabase.prepare(query).all() as VaultRow[]
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      path: row.path,
      isSystem: Boolean(row.is_system),
      systemKey: row.system_key as SystemVaultKey | undefined,
      isCustomLocation: Boolean(row.is_custom_location),
      isActive: Boolean(row.is_active),
      vaultType: row.vault_type as VaultType,
      icon: row.icon || 'database',
      sortOrder: row.sort_order || 0,
      assetCount: row.asset_count,
      totalSize: row.total_size,
      diskInfo: row.disk_info ? JSON.parse(row.disk_info) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // 网络库字段
      networkPath: row.network_path,
      browsePath: row.browse_path,
      requiresAuth: Boolean(row.requires_auth),
      syncStatus: row.sync_status as VaultInfo['syncStatus'],
      lastSyncAt: row.last_sync_at,
      networkMigrationState: this.getNetworkMigrationState(row.id, row.vault_type as VaultType)
    }))
  }

  /**
   * 根据ID获取保管库信息
   */
  getVaultById(vaultId: string): VaultInfo | null {
    const query = 'SELECT * FROM vaults WHERE id = ?'
    const row = this.publicDatabase.prepare(query).get(vaultId) as VaultRow | undefined

    if (!row) return null

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      path: row.path,
      isSystem: Boolean(row.is_system),
      systemKey: row.system_key as SystemVaultKey | undefined,
      isCustomLocation: Boolean(row.is_custom_location),
      isActive: Boolean(row.is_active),
      vaultType: row.vault_type as VaultType,
      icon: row.icon || 'database',
      sortOrder: row.sort_order || 0,
      assetCount: row.asset_count,
      totalSize: row.total_size,
      diskInfo: row.disk_info ? JSON.parse(row.disk_info) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // 网络库字段
      networkPath: row.network_path,
      browsePath: row.browse_path,
      requiresAuth: Boolean(row.requires_auth),
      syncStatus: row.sync_status as VaultInfo['syncStatus'],
      lastSyncAt: row.last_sync_at,
      networkMigrationState: this.getNetworkMigrationState(row.id, row.vault_type as VaultType)
    }
  }

  /**
   * 删除保管库
   */
  async deleteVault(vaultId: string): Promise<boolean> {
    try {
      const vaultInfo = this.getVaultById(vaultId)
      if (!vaultInfo) {
        throw new Error(`保管库不存在: ${vaultId}`)
      }

      if (this.isProtectedVault(vaultInfo)) {
        throw new Error('系统保管库不可删除')
      }

      const isNetworkVault = vaultInfo.vaultType === VaultType.NETWORK
      const localCachePath = vaultInfo.path

      // 如果是活跃保管库，尝试切换到其他保管库
      if (vaultInfo.isActive) {
        const allVaults = this.getAllVaults()
        const otherVault = allVaults.find((v) => v.id !== vaultId)

        if (otherVault) {
          console.log(`[VaultManager] 删除活跃保管库，自动切换到: ${otherVault.name}`)
          await this.switchToVault(otherVault.id)
        } else {
          console.log(`[VaultManager] 删除最后一个活跃保管库，断开连接`)
          this.dispose()
          // 更新数据库中的活跃状态
          this.publicDatabase.prepare('UPDATE vaults SET is_active = 0').run()
        }
      }

      // 删的可能是一个正在后台跑着 Server/Client 的**非活跃**网络库。
      // 上面那段只在「删的是活跃库」时经 switchToVault 停过服务 —— 非活跃库
      // 走到这里服务还开着：公共库记录已删、界面上也没了，AssetServer 却仍然
      // 注册着它继续对外提供数据，句柄也不还，共享目录里的 .vault 发现文件还在。
      await this.stopV2NetworkService(vaultId)

      // 🔧 先从公共数据库中删除记录（确保 UI 立即更新）
      const deleteStmt = this.publicDatabase.prepare('DELETE FROM vaults WHERE id = ?')
      deleteStmt.run(vaultId)
      console.log(`[VaultManager] 保管库记录已删除: ${vaultInfo.name} (${vaultId})`)

      // 注意：网络库删除时不删除网络源文件，只移除本地记录
      // 网络源文件只在"删除单个资产/文件夹"时才会被删除

      // 异步删除本地缓存目录（不阻塞主流程）
      // 对于网络库，本地缓存通常很小，失败也不影响使用
      if (existsSync(localCachePath)) {
        const deleteLocalCache = async (): Promise<void> => {
          // 网络库使用更短的等待时间
          const maxAttempts = isNetworkVault ? 3 : 5
          const baseDelay = isNetworkVault ? 200 : 500

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              // 等待 SQLite 连接完全释放
              await new Promise((resolve) => setTimeout(resolve, baseDelay * attempt))
              await fs.rm(localCachePath, { recursive: true, force: true })
              console.log(`[VaultManager] 本地缓存已删除: ${localCachePath}`)
              return
            } catch (err: unknown) {
              const error = err as NodeJS.ErrnoException
              if ((error.code === 'EBUSY' || error.code === 'EPERM') && attempt < maxAttempts) {
                console.warn(
                  `[VaultManager] 删除本地缓存重试 ${attempt}/${maxAttempts}: 文件被锁定`
                )
              } else {
                // 网络库：本地缓存删除失败不抛出错误
                if (isNetworkVault) {
                  console.warn(
                    `[VaultManager] 网络库本地缓存删除失败，可稍后手动删除: ${localCachePath}`
                  )
                  return
                }
                throw err
              }
            }
          }
          console.warn(`[VaultManager] 无法删除目录，可能需要重启后手动删除: ${localCachePath}`)
        }

        // 对于网络库，异步执行不等待；对于普通库，同步等待
        if (isNetworkVault) {
          deleteLocalCache().catch((e) => console.warn('[VaultManager] 网络库缓存清理失败:', e))
        } else {
          await deleteLocalCache()
        }
      }

      console.log(`[VaultManager] 保管库删除成功: ${vaultInfo.name} (${vaultId})`)
      return true
    } catch (error) {
      console.error(`[VaultManager] 删除保管库失败:`, error)
      throw error
    }
  }

  /**
   * 重命名保管库
   */
  async renameVault(vaultId: string, newName: string): Promise<boolean> {
    try {
      if (!newName || !newName.trim()) {
        throw new Error('新名称不能为空')
      }

      const vaultInfo = this.getVaultById(vaultId)
      if (!vaultInfo) {
        throw new Error(`保管库不存在: ${vaultId}`)
      }

      // 更新公共数据库
      const updateStmt = this.publicDatabase.prepare(
        "UPDATE vaults SET name = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
      )
      updateStmt.run(newName, vaultId)

      // 更新 .vault-info 文件（如果存在）
      const infoFilePath = join(vaultInfo.path, '.vault-info')
      if (existsSync(infoFilePath)) {
        try {
          const content = await fs.readFile(infoFilePath, 'utf-8')
          const info = JSON.parse(content)
          info.name = newName
          await fs.writeFile(infoFilePath, JSON.stringify(info, null, 2))
        } catch (e) {
          console.warn(`[VaultManager] 更新 .vault-info 失败:`, e)
        }
      }

      console.log(`[VaultManager] 保管库重命名成功: ${vaultInfo.name} -> ${newName}`)
      return true
    } catch (error) {
      console.error(`[VaultManager] 重命名保管库失败:`, error)
      return false
    }
  }

  /**
   * 更新保管库图标
   */
  async updateVaultIcon(vaultId: string, iconPath: string): Promise<boolean> {
    try {
      const vaultInfo = this.getVaultById(vaultId)
      if (!vaultInfo) {
        throw new Error(`保管库不存在: ${vaultId}`)
      }

      // 更新公共数据库
      const updateStmt = this.publicDatabase.prepare(
        "UPDATE vaults SET icon = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
      )
      updateStmt.run(iconPath, vaultId)

      // 更新 .vault-info 文件（如果存在）
      const infoFilePath = join(vaultInfo.path, '.vault-info')
      if (existsSync(infoFilePath)) {
        try {
          const content = await fs.readFile(infoFilePath, 'utf-8')
          const info = JSON.parse(content)
          info.icon = iconPath
          await fs.writeFile(infoFilePath, JSON.stringify(info, null, 2))
        } catch (e) {
          console.warn(`[VaultManager] 更新 .vault-info 失败:`, e)
        }
      }

      console.log(`[VaultManager] 保管库图标更新成功: ${vaultInfo.name} -> ${iconPath}`)
      return true
    } catch (error) {
      console.error(`[VaultManager] 更新保管库图标失败:`, error)
      return false
    }
  }

  /**
   * 更新网络保管库的共享浏览路径
   */
  async updateVaultBrowsePath(vaultId: string, browsePath?: string): Promise<boolean> {
    try {
      const vaultInfo = this.getVaultById(vaultId)
      if (!vaultInfo) {
        throw new Error(`保管库不存在: ${vaultId}`)
      }
      if (vaultInfo.vaultType !== VaultType.NETWORK) {
        throw new Error('仅网络保管库支持设置共享浏览路径')
      }

      const normalizedBrowsePath = browsePath?.trim() || null

      const updateStmt = this.publicDatabase.prepare(
        "UPDATE vaults SET browse_path = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
      )
      updateStmt.run(normalizedBrowsePath, vaultId)

      console.log(
        `[VaultManager] 共享浏览路径更新成功: ${vaultInfo.name} -> ${normalizedBrowsePath || '(empty)'}`
      )
      return true
    } catch (error) {
      console.error('[VaultManager] 更新共享浏览路径失败:', error)
      return false
    }
  }

  /**
   * 更新网络保管库的连接地址
   */
  async updateVaultNetworkPath(
    vaultId: string,
    networkPath: string
  ): Promise<{ networkError?: string }> {
    const normalizedNetworkPath = networkPath.trim()
    if (!normalizedNetworkPath) {
      throw new Error('网络地址不能为空')
    }
    if (!this.isNetworkStylePath(normalizedNetworkPath)) {
      throw new Error('网络地址必须是 UNC 路径或 HTTP 地址')
    }

    const vaultInfo = this.getVaultById(vaultId)
    if (!vaultInfo) {
      throw new Error(`保管库不存在: ${vaultId}`)
    }
    if (vaultInfo.vaultType !== VaultType.NETWORK) {
      throw new Error('仅网络保管库支持修改连接地址')
    }

    const updateStmt = this.publicDatabase.prepare(
      "UPDATE vaults SET network_path = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
    )
    updateStmt.run(normalizedNetworkPath, vaultId)

    let networkError: string | undefined
    if (this.currentVaultInfo?.id === vaultId) {
      const switchResult = await this.switchToVault(vaultId)
      if (!switchResult.success) {
        throw new Error(switchResult.error || '重新连接保管库失败')
      }
      networkError = switchResult.networkError
    }

    console.log(
      `[VaultManager] 网络保管库地址更新成功: ${vaultInfo.name} -> ${normalizedNetworkPath}`
    )
    return { networkError }
  }

  /**
   * 验证自定义路径
   */
  async validateCustomPath(customPath: string): Promise<PathValidationResult> {
    try {
      const resolvedPath = resolve(customPath)

      // 检查路径是否存在
      if (!existsSync(resolvedPath)) {
        return {
          valid: false,
          error: '指定的路径不存在'
        }
      }

      // 检查是否为目录
      const stats = await fs.stat(resolvedPath)
      if (!stats.isDirectory()) {
        return {
          valid: false,
          error: '指定的路径不是一个目录'
        }
      }

      // 检查写入权限
      try {
        await fs.access(resolvedPath, fs.constants.W_OK)
      } catch {
        return {
          valid: false,
          error: '没有写入权限'
        }
      }

      // 检查是否已被其他保管库使用
      if (await this.isPathInUse(resolvedPath)) {
        return {
          valid: false,
          error: '该路径已被其他保管库使用'
        }
      }

      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 准备自定义保管库路径
   */
  private async prepareCustomVaultPath(customPath: string, vaultName: string): Promise<string> {
    const resolvedPath = resolve(customPath)

    // 创建以保管库名称命名的子目录
    const sanitizedName = vaultName.replace(/[<>:"/\\|?*]/g, '_')
    const vaultPath = join(resolvedPath, sanitizedName)

    // 如果目录已存在，添加时间戳后缀
    if (existsSync(vaultPath)) {
      const timestamp = Date.now()
      return join(resolvedPath, `${sanitizedName}_${timestamp}`)
    }

    return vaultPath
  }

  /**
   * 验证保管库路径
   */
  private async validateVaultPath(vaultPath: string): Promise<PathValidationResult> {
    try {
      const parentDir = dirname(vaultPath)

      // 检查父目录是否存在
      if (!existsSync(parentDir)) {
        return {
          valid: false,
          error: `父目录不存在: ${parentDir}`
        }
      }

      // 检查写入权限
      try {
        await fs.access(parentDir, fs.constants.W_OK)
      } catch {
        return {
          valid: false,
          error: `没有写入权限: ${parentDir}`
        }
      }

      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 检查路径是否已被使用
   */
  private async isPathInUse(targetPath: string): Promise<boolean> {
    const allVaults = this.getAllVaults()
    const resolvedTargetPath = resolve(targetPath)

    return allVaults.some((vault) => {
      const vaultPath = resolve(vault.path)
      return (
        vaultPath === resolvedTargetPath ||
        resolvedTargetPath.startsWith(vaultPath + sep) ||
        vaultPath.startsWith(resolvedTargetPath + sep)
      )
    })
  }

  /**
   * 创建保管库目录结构
   */
  private async createVaultDirectories(vaultPath: string): Promise<void> {
    const directories = [vaultPath, join(vaultPath, 'thumbnails'), join(vaultPath, 'assetData')]

    for (const dir of directories) {
      await fs.mkdir(dir, { recursive: true })
    }
  }

  /**
   * 初始化保管库数据库
   */
  private initializeVaultDatabase(vaultDb: Database.Database): void {
    // 创建保管库元数据表
    const createVaultMetadataTable = `
      CREATE TABLE IF NOT EXISTS vault_metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        type TEXT DEFAULT 'string',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      )
    `

    // 创建资产文件夹表
    const createAssetFolderTable = `
      CREATE TABLE IF NOT EXISTS assetFolder (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folderKey TEXT NOT NULL UNIQUE,
        fatherKey TEXT,
        img TEXT,
        type TEXT NOT NULL,
        folderName TEXT NOT NULL,
        fullPath TEXT,
        pathArray TEXT,
        depth INTEGER DEFAULT 0,
        ancestorKeys TEXT,
        isDelete INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (fatherKey) REFERENCES assetFolder(folderKey) ON DELETE CASCADE
      )
    `

    // 创建资产数据表
    const createAssetDataTable = `
      CREATE TABLE IF NOT EXISTS assetData (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assetKey TEXT NOT NULL UNIQUE,
        folderKey TEXT NOT NULL,
        assetName TEXT NOT NULL,
        filePath TEXT,
        fileSize INTEGER,
        fileExtension TEXT,
        modifiedTime TEXT,
        processorType TEXT,
        assetType TEXT,
        engineVersion TEXT,
        isDelete INTEGER NOT NULL DEFAULT 0,
        isDependency INTEGER NOT NULL DEFAULT 0,
        classKey TEXT,
        name TEXT,
        originPath TEXT,
        ext TEXT,
        folderName TEXT,
        softPath TEXT,
        assetClass TEXT,
        className TEXT,
        classNameCn TEXT,
        classColor TEXT,
        imports TEXT,
        imgLocalPath TEXT,
        customPoster TEXT,
        baiduyunPath TEXT,
        webdavPath TEXT,
        size INTEGER,
        assetConfig TEXT,
        assetConfigPath TEXT,
        fileMd5 TEXT,
        pluginInfo TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (folderKey) REFERENCES assetFolder(folderKey) ON DELETE CASCADE
      )
    `

    // 创建资产收藏表
    const createAssetFavoriteTable = `
      CREATE TABLE IF NOT EXISTS asset_favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assetKey TEXT NOT NULL,
        itemType TEXT DEFAULT 'asset',
        userId INTEGER,
        vaultId TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(assetKey, itemType, userId, vaultId)
      )
    `

    // 创建资产-标签关联表
    const createAssetTagTable = `
      CREATE TABLE IF NOT EXISTS asset_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assetKey TEXT NOT NULL,
        tagId INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(assetKey, tagId)
      )
    `

    // 创建文件夹-标签关联表
    const createFolderTagTable = `
      CREATE TABLE IF NOT EXISTS folder_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folderKey TEXT NOT NULL,
        tagId INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(folderKey, tagId)
      )
    `

    // 执行表创建
    vaultDb.exec(createVaultMetadataTable)
    vaultDb.exec(createAssetFolderTable)
    vaultDb.exec(createAssetDataTable)
    vaultDb.exec(createAssetFavoriteTable)
    vaultDb.exec(createAssetTagTable)
    vaultDb.exec(createFolderTagTable)

    // 创建索引
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_assetFolder_fatherKey ON assetFolder(fatherKey)',
      'CREATE INDEX IF NOT EXISTS idx_assetFolder_depth ON assetFolder(depth)',
      'CREATE INDEX IF NOT EXISTS idx_assetFolder_fullPath ON assetFolder(fullPath)',
      'CREATE INDEX IF NOT EXISTS idx_assetFolder_isDelete ON assetFolder(isDelete)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_folderKey ON assetData(folderKey)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_folderKey_isDelete_assetName ON assetData(folderKey, isDelete, assetName COLLATE NOCASE)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_softPath ON assetData(softPath)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_assetType ON assetData(assetType)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_className ON assetData(className)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_classNameCn ON assetData(classNameCn)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_fileExtension ON assetData(fileExtension)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_processorType ON assetData(processorType)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_assetClass ON assetData(assetClass)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_filePath ON assetData(filePath)',
      'CREATE INDEX IF NOT EXISTS idx_assetData_isDelete ON assetData(isDelete)',
      // 🚀 性能优化：添加 assetName 索引（常用于排序和搜索）
      'CREATE INDEX IF NOT EXISTS idx_assetData_assetName ON assetData(assetName COLLATE NOCASE)',
      'CREATE INDEX IF NOT EXISTS idx_asset_favorites_assetKey ON asset_favorites(assetKey)',
      'CREATE INDEX IF NOT EXISTS idx_asset_favorites_itemType ON asset_favorites(itemType)',
      'CREATE INDEX IF NOT EXISTS idx_asset_favorites_userId ON asset_favorites(userId)',
      'CREATE INDEX IF NOT EXISTS idx_asset_favorites_vaultId ON asset_favorites(vaultId)',
      'CREATE INDEX IF NOT EXISTS idx_asset_tags_assetKey ON asset_tags(assetKey)',
      'CREATE INDEX IF NOT EXISTS idx_asset_tags_tagId ON asset_tags(tagId)',
      'CREATE INDEX IF NOT EXISTS idx_folder_tags_folderKey ON folder_tags(folderKey)',
      'CREATE INDEX IF NOT EXISTS idx_folder_tags_tagId ON folder_tags(tagId)'
    ]

    indexes.forEach((sql) => vaultDb.exec(sql))

    // 迁移：为 assetData 表添加缺失的新列
    const assetDataMigrations = [
      { name: 'note', type: 'TEXT' },
      // 关联的详细说明（保管库的 assetNote 表）
      { name: 'noteId', type: 'INTEGER' },
      { name: 'isDependency', type: 'INTEGER DEFAULT 0' },
      { name: 'fileMd5', type: 'TEXT' },
      { name: 'pluginInfo', type: 'TEXT' },
      { name: 'tags', type: 'TEXT' },
      { name: 'color', type: 'TEXT' },
      // 进回收站的时刻。**必须在这儿** —— models/assetData.ts 里那份同名清单
      // 是那个没人调用的 initVaultModels 的，加在那边等于没加，见下面的说明。
      { name: 'deletedAt', type: 'TEXT' }
    ]

    // 迁移：为 assetFolder 表添加缺失的新列
    const assetFolderMigrations = [
      { name: 'color', type: 'TEXT' },
      // 文件夹也能写备注和详细说明
      { name: 'note', type: 'TEXT' },
      { name: 'noteId', type: 'INTEGER' },
      /**
       * 进回收站的时刻。
       *
       * 少了这一列，整个网络库会**全部离线**：SyncClient 的 prepareStatements()
       * 无条件 prepare 了一句带 `deletedAt` 的 UPDATE，better-sqlite3 在 prepare
       * 当场就编译，抛 `no such column: deletedAt`；这一抛正好落在
       * startV2NetworkService 的 try 里，于是每个网络库都变成
       * 「资产服务器连接失败：no such column: deletedAt」。
       *
       * 加列的人把它写进了 models/assetFolder.ts 的清单 —— 那份清单挂在
       * initVaultModels 上，而那个函数从来没人调用（vaultSchema.test.ts 开头
       * 就是在讲这件事）。老保管库的表早就建好了，CREATE TABLE IF NOT EXISTS
       * 对它们不生效，只有这儿的 ALTER 补得上。
       */
      { name: 'deletedAt', type: 'TEXT' }
    ]

    /**
     * 给一张已存在的表补列。
     *
     * 上面那段建表 SQL 用的是 `CREATE TABLE IF NOT EXISTS` —— 老保管库的表早就
     * 建好了，改建表语句对它们一点作用都没有，只有走 ALTER 这条路才补得上。
     */
    const migrateColumns = (table: string, migrations: { name: string; type: string }[]): void => {
      try {
        type ColumnInfo = { name: string }
        const columns = vaultDb.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]
        const existingColumns = new Set(columns.map((col) => col.name))

        for (const col of migrations) {
          if (existingColumns.has(col.name)) continue
          try {
            vaultDb.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`)
            console.log(`[VaultManager] 迁移: 添加列 ${col.name} 到 ${table}`)
          } catch (e) {
            console.warn(`[VaultManager] 添加列 ${col.name} 失败:`, e)
          }
        }
      } catch (e) {
        console.warn(`[VaultManager] ${table} 列迁移检查失败:`, e)
      }
    }

    migrateColumns('assetData', assetDataMigrations)
    migrateColumns('assetFolder', assetFolderMigrations)

    // 资产/文件夹的详细说明。跟着保管库走，所以建在这儿而不是公共库
    try {
      initAssetNoteModel(vaultDb)
    } catch (e) {
      console.warn('[VaultManager] assetNote 表初始化失败:', e)
    }

    // 创建默认的ALL文件夹
    const createAllFolderStmt = vaultDb.prepare(`
      INSERT OR IGNORE INTO assetFolder (folderKey, fatherKey, type, folderName, fullPath, pathArray, depth, ancestorKeys)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    createAllFolderStmt.run('ALL', null, 'system', 'ALL', '/ALL', '["ALL"]', 0, '["ALL"]')

    // sqlite-vec 是**按连接**加载的，公共库加载过不代表保管库也加载了 ——
    // 语义搜索的向量表建在保管库里，这里不加载的话它一辈子都是「不可用」。
    ensureSqliteVecLoaded(vaultDb)

    // 全文检索索引。必须排在 assetData / asset_tags 建好之后 —— 它的触发器挂在那两张表上。
    //
    // 索引建不起来不该挡住保管库打开：搜索会退回 LIKE，慢但结果是全的。
    try {
      initAssetSearchIndexModel(vaultDb)
    } catch (e) {
      console.warn('[VaultManager] 全文检索索引初始化失败，搜索将退回 LIKE:', e)
    }
  }

  /**
   * 创建保管库信息文件
   */
  private async createVaultInfoFile(
    vaultPath: string,
    vaultId: string,
    vaultName: string
  ): Promise<void> {
    const vaultInfo = {
      id: vaultId,
      name: vaultName,
      version: '1.0.0',
      createdAt: new Date().toISOString()
    }

    const infoFilePath = join(vaultPath, '.vault-info')
    await fs.writeFile(infoFilePath, JSON.stringify(vaultInfo, null, 2))
  }

  /**
   * 在公共数据库中插入保管库记录
   */
  private insertVaultRecord(vaultInfo: VaultInfo): void {
    const insertStmt = this.publicDatabase.prepare(`
      INSERT INTO vaults (
        id, name, description, path, is_system, system_key, is_custom_location, is_active, vault_type,
        icon, sort_order, asset_count, total_size, created_at, updated_at,
        network_path, browse_path, requires_auth, sync_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    insertStmt.run(
      vaultInfo.id,
      vaultInfo.name,
      vaultInfo.description || null,
      vaultInfo.path,
      vaultInfo.isSystem ? 1 : 0,
      vaultInfo.systemKey || null,
      vaultInfo.isCustomLocation ? 1 : 0,
      vaultInfo.isActive ? 1 : 0,
      vaultInfo.vaultType,
      vaultInfo.icon,
      vaultInfo.sortOrder,
      vaultInfo.assetCount,
      vaultInfo.totalSize,
      vaultInfo.createdAt,
      vaultInfo.updatedAt,
      // 网络库专用字段
      vaultInfo.networkPath || null,
      vaultInfo.browsePath || null,
      vaultInfo.requiresAuth ? 1 : 0,
      vaultInfo.syncStatus || 'synced'
    )
  }

  private getVaultByName(name: string): VaultInfo | null {
    const row = this.publicDatabase
      .prepare('SELECT * FROM vaults WHERE name = ? LIMIT 1')
      .get(name) as VaultRow | undefined

    if (!row) return null

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      path: row.path,
      isSystem: Boolean(row.is_system),
      systemKey: row.system_key as SystemVaultKey | undefined,
      isCustomLocation: Boolean(row.is_custom_location),
      isActive: Boolean(row.is_active),
      vaultType: row.vault_type as VaultType,
      icon: row.icon || 'database',
      sortOrder: row.sort_order || 0,
      assetCount: row.asset_count,
      totalSize: row.total_size,
      diskInfo: row.disk_info ? JSON.parse(row.disk_info) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      networkPath: row.network_path,
      browsePath: row.browse_path,
      requiresAuth: Boolean(row.requires_auth),
      syncStatus: row.sync_status as VaultInfo['syncStatus'],
      lastSyncAt: row.last_sync_at,
      networkMigrationState: this.getNetworkMigrationState(row.id, row.vault_type as VaultType)
    }
  }

  private promoteVaultToSystem(
    vaultId: string,
    config: Pick<CreateVaultConfig, 'name' | 'description' | 'icon' | 'vaultType'> & {
      systemKey: SystemVaultKey
    }
  ): void {
    this.publicDatabase
      .prepare(
        `
          UPDATE vaults
          SET name = ?,
              description = ?,
              icon = ?,
              vault_type = ?,
              is_system = 1,
              system_key = ?,
              updated_at = datetime('now', 'localtime')
          WHERE id = ?
        `
      )
      .run(
        config.name,
        config.description || null,
        config.icon || 'database',
        config.vaultType || VaultType.BACKUP,
        config.systemKey,
        vaultId
      )
  }

  private isNetworkStylePath(targetPath: string): boolean {
    return (
      targetPath.startsWith('\\\\') ||
      targetPath.startsWith('//') ||
      /^https?:\/\//i.test(targetPath)
    )
  }

  /**
   * 更新活跃保管库状态
   */
  private updateActiveVault(vaultId: string): void {
    const transaction = this.publicDatabase.transaction(() => {
      // 清除所有保管库的活跃状态
      this.publicDatabase.prepare('UPDATE vaults SET is_active = 0').run()

      // 设置指定保管库为活跃
      this.publicDatabase
        .prepare(
          "UPDATE vaults SET is_active = 1, updated_at = datetime('now', 'localtime') WHERE id = ?"
        )
        .run(vaultId)
    })

    transaction()
  }

  /**
   * 更新保管库统计信息
   */
  async updateVaultStats(vaultId: string): Promise<void> {
    try {
      const stats = await this.getVaultStats(vaultId)
      if (stats) {
        const updateStmt = this.publicDatabase.prepare(`
          UPDATE vaults
          SET asset_count = ?, total_size = ?, updated_at = datetime('now', 'localtime')
          WHERE id = ?
        `)
        updateStmt.run(stats.assetCount, stats.totalSize, vaultId)
      }
    } catch (error) {
      console.error(`[VaultManager] 更新保管库统计失败:`, error)
    }
  }

  /**
   * 获取保管库统计信息
   */
  private async getVaultStats(
    vaultId: string
  ): Promise<{ assetCount: number; totalSize: number } | null> {
    try {
      const vaultInfo = this.getVaultById(vaultId)
      if (!vaultInfo) return null

      const vaultDbPath = join(vaultInfo.path, 'vault-data.db')
      if (!existsSync(vaultDbPath)) return null

      const vaultDb = new Database(vaultDbPath)

      try {
        const countQuery = 'SELECT COUNT(*) as count FROM assetData'
        const sizeQuery =
          'SELECT SUM(fileSize) as totalSize FROM assetData WHERE fileSize IS NOT NULL'

        const countResult = vaultDb.prepare(countQuery).get() as AssetStatsRow | undefined
        const sizeResult = vaultDb.prepare(sizeQuery).get() as AssetStatsRow | undefined

        return {
          assetCount: countResult?.count || 0,
          totalSize: sizeResult?.totalSize || 0
        }
      } finally {
        vaultDb.close()
      }
    } catch (error) {
      console.error(`[VaultManager] 获取保管库统计失败:`, error)
      return null
    }
  }

  /**
   * 更新保管库排序
   */
  updateVaultOrder(vaultIds: string[]): void {
    try {
      const transaction = this.publicDatabase.transaction(() => {
        const updateStmt = this.publicDatabase.prepare(`
          UPDATE vaults
          SET sort_order = ?, updated_at = datetime('now', 'localtime')
          WHERE id = ?
        `)

        vaultIds.forEach((vaultId, index) => {
          updateStmt.run(index, vaultId)
        })
      })

      transaction()
      console.log(`[VaultManager] 保管库排序已更新`)
    } catch (error) {
      console.error(`[VaultManager] 更新保管库排序失败:`, error)
      throw error
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    // V2: 关闭所有网络服务
    VaultServiceManager.getInstance()
      .shutdown()
      .catch((e) => {
        console.warn('[VaultManager] V2 网络服务关闭失败:', e)
      })

    if (this.currentVaultDb) {
      this.currentVaultDb.close()
      this.currentVaultDb = null
    }
    this.backgroundVaultDbs.releaseAll()
    this.currentVaultInfo = null
  }

  // ─────────────────────────── V2 网络服务 ───────────────────────────

  /**
   * 启动 V2 网络服务（Server 或 Client）
   * 1. 先检查网络路径可达性（带超时，避免离线主机阻塞主线程）
   * 2. 检查 .vault 发现文件 — 存在则以 Client 连接
   * 3. 不存在则以 Server 启动并写入 .vault
   */
  private async startV2NetworkService(
    vaultInfo: VaultInfo,
    db: Database.Database
  ): Promise<{ success: boolean; error?: string }> {
    if (!vaultInfo.networkPath) return { success: false, error: '网络路径未配置' }

    // 远程资产服务器模式：networkPath 格式为 "http://host:port/remoteVaultId"
    // 不管是 NAS、Mac 还是其他设备，统一通过 HTTP API 连接
    if (
      vaultInfo.networkPath.startsWith('http://') ||
      vaultInfo.networkPath.startsWith('https://')
    ) {
      try {
        const fullUrl = new URL(vaultInfo.networkPath)
        const serverUrl = `${fullUrl.protocol}//${fullUrl.host}`
        const remoteVaultId = fullUrl.pathname.replace(/^\//, '')

        if (!remoteVaultId) {
          const errMsg = `服务器路径缺少 vaultId: ${vaultInfo.networkPath}`
          console.warn(`[VaultManager] ${errMsg}`)
          this.updateSyncStatus(vaultInfo.id, 'offline')
          return { success: false, error: errMsg }
        }

        // 先做快速健康检查（3秒超时），避免服务器不可达时启动 SyncClient。
        // 访问码必须一起发：服务端 v3 起连列举资产库的接口都要凭据，不带就是 401，
        // 于是重启后直连库永久离线 —— 填对配对码也救不回来。
        const apiKey = this.getNetworkVaultApiKey(vaultInfo.id)
        const probe = await probeRemoteVault({
          probeUrl: `${serverUrl}/api/vaults`,
          displayUrl: serverUrl,
          apiKey
        })
        if (!probe.ok) {
          console.warn(`[VaultManager] ${probe.error}: ${vaultInfo.networkPath}`)
          this.updateSyncStatus(vaultInfo.id, 'offline')
          return { success: false, error: probe.error }
        }

        console.log(
          `[VaultManager] 资产服务器重连: ${vaultInfo.name} → ${serverUrl}` +
            ` (remote: ${remoteVaultId})`
        )
        const vsm = VaultServiceManager.getInstance()
        await vsm.startClientDirect(serverUrl, remoteVaultId, vaultInfo.name, db, vaultInfo.id, {
          apiKey
        })
        this.registerClientEventForwarding(vsm, vaultInfo.id)
        this.updateSyncStatus(vaultInfo.id, 'synced')
        return { success: true }
      } catch (err) {
        const errMsg = `资产服务器连接失败 (${vaultInfo.networkPath}): ${err instanceof Error ? err.message : String(err)}`
        console.warn(`[VaultManager] ${errMsg}`)
        this.updateSyncStatus(vaultInfo.id, 'offline')
        return { success: false, error: errMsg }
      }
    }

    // SMB 共享路径模式：快速检查网络路径可达性（3秒超时），避免离线主机阻塞主线程
    try {
      await Promise.race([
        fs.access(vaultInfo.networkPath),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('网络路径访问超时(3s)')), 3000)
        )
      ])
    } catch (err) {
      const errMsg = `网络路径不可达: ${vaultInfo.networkPath} (${err instanceof Error ? err.message : String(err)})`
      console.warn(`[VaultManager] ${errMsg}`)
      this.updateSyncStatus(vaultInfo.id, 'offline')
      return { success: false, error: errMsg }
    }

    const vsm = VaultServiceManager.getInstance()

    try {
      // 检查网络路径上是否已有 .vault（说明另一台机器已是 Server）
      const pathMod = await import('path')
      const discoveryPath = pathMod.join(vaultInfo.networkPath, '.vault')

      let discoveryExists = false
      try {
        await fs.access(discoveryPath)
        discoveryExists = true
      } catch {
        // 文件不存在，将以 Server 模式启动
      }

      if (discoveryExists) {
        let discovery: { server: string; [key: string]: unknown } | null = null
        try {
          const raw = await fs.readFile(discoveryPath, 'utf-8')
          discovery = JSON.parse(raw)
        } catch {
          // .vault 读取/解析失败，继续尝试 Server 模式
        }

        if (discovery) {
          const os = await import('os')
          const myIPs = this.getLocalIPList(os)
          if (!myIPs.includes(discovery.server)) {
            // 远端 Server 存在，以 Client 模式连接
            console.log(
              `[VaultManager] 检测到远端 Server (${discovery.server})，以 Client 模式连接`
            )
            try {
              await vsm.startClient(vaultInfo.networkPath, db, vaultInfo.id)
              this.registerClientEventForwarding(vsm, vaultInfo.id)
              this.updateSyncStatus(vaultInfo.id, 'synced')
              return { success: true }
            } catch (clientErr) {
              const errMsg = `Client 连接失败: ${clientErr instanceof Error ? clientErr.message : String(clientErr)}`
              console.warn(`[VaultManager] ${errMsg}`)
              return { success: false, error: errMsg }
            }
          }
        }
      }

      // 以 Server 模式启动
      console.log(`[VaultManager] 以 Server 模式启动网络保管库: ${vaultInfo.name}`)
      const keys = this.getOrCreateNetworkVaultServerKeys(vaultInfo.id)
      await vsm.startServer(vaultInfo.id, vaultInfo.name, vaultInfo.networkPath, db, {
        keys,
        publishWriteKeyToShare: this.isNetworkVaultShareWriteEnabled(vaultInfo.id)
      })
      this.updateSyncStatus(vaultInfo.id, 'synced')
      return { success: true }
    } catch (err) {
      const errMsg = `V2 网络服务启动失败: ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[VaultManager] ${errMsg}`)
      return { success: false, error: errMsg }
    }
  }

  /**
   * 为 SyncClient 注册事件转发监听器
   * 将 sync-progress / full-sync-done / incremental-sync-done / status
   * 事件转发到渲染进程，确保 UI 能正确显示和清除同步进度通知
   */
  private registerClientEventForwarding(vsm: VaultServiceManager, vaultId: string): void {
    const client = vsm.getClient(vaultId)
    if (!client) return

    const broadcast = (channel: string, payload: unknown): void => {
      for (const win of getAppWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload)
        }
      }
    }

    client.on('change', (entry) => {
      broadcast('asset:changed', {
        source: 'networkV2',
        vaultId,
        ...entry
      })
    })
    client.on('sync-progress', (stats) => {
      broadcast('networkVaultV2:syncProgress', {
        vaultId,
        ...stats
      })
    })
    client.on('full-sync-done', (stats) => {
      broadcast('networkVaultV2:syncComplete', {
        vaultId,
        type: 'full',
        ...stats
      })
    })
    client.on('incremental-sync-done', (stats) => {
      broadcast('networkVaultV2:syncComplete', {
        vaultId,
        type: 'incremental',
        ...stats
      })
    })
    client.on('status', (status) => {
      broadcast('networkVaultV2:statusChange', {
        vaultId,
        status
      })
    })
    // 没有这一条，401 就只会变成界面上一句含糊的「同步失败」，
    // 用户不知道自己该去填码
    client.on('auth-required', (info) => {
      broadcast('networkVaultV2:statusChange', {
        vaultId,
        status: authStatusOf(info)
      })
    })
  }

  /**
   * 重试网络服务连接（公开方法，供 IPC 调用）
   * 用于主机恢复在线后重新建立网络连接
   */
  async retryNetworkService(vaultId: string): Promise<{
    success: boolean
    error?: string
    audit?: {
      backupPath: string
      beforeAssetCount: number
      afterAssetCount: number
      beforeFolderCount: number
      afterFolderCount: number
      hasDrift: boolean
    }
  }> {
    const vaultInfo = this.getVaultById(vaultId)
    if (!vaultInfo) {
      return { success: false, error: '保管库不存在' }
    }
    if (vaultInfo.vaultType !== VaultType.NETWORK || !vaultInfo.networkPath) {
      return { success: false, error: '非网络保管库' }
    }

    // 使用当前活跃的数据库连接
    const db = this.currentVaultDb
    if (!db || this.currentVaultInfo?.id !== vaultId) {
      return { success: false, error: '该保管库未处于活跃状态' }
    }

    const wasLegacyPending = !this.isNetworkV2Enabled(vaultId)
    let snapshot:
      | { backupPath: string; assetCount: number; folderCount: number; createdAt: string }
      | undefined

    try {
      if (wasLegacyPending) {
        snapshot = await this.createNetworkUpgradeSnapshot(vaultInfo, db)
      }

      this.setNetworkV2Enabled(vaultId, true)
      const netResult = await this.startV2NetworkService(vaultInfo, db)
      const success = netResult.success

      if (!success && wasLegacyPending) {
        this.setNetworkV2Enabled(vaultId, false)
      }

      let audit:
        | {
            backupPath: string
            beforeAssetCount: number
            afterAssetCount: number
            beforeFolderCount: number
            afterFolderCount: number
            hasDrift: boolean
          }
        | undefined

      if (success && snapshot) {
        const afterCounts = this.readVaultContentCounts(db)
        audit = {
          backupPath: snapshot.backupPath,
          beforeAssetCount: snapshot.assetCount,
          afterAssetCount: afterCounts.assetCount,
          beforeFolderCount: snapshot.folderCount,
          afterFolderCount: afterCounts.folderCount,
          hasDrift:
            snapshot.assetCount !== afterCounts.assetCount ||
            snapshot.folderCount !== afterCounts.folderCount
        }
        this.recordNetworkUpgradeAudit(vaultId, {
          ...audit,
          createdAt: new Date().toISOString()
        })
      }
      return {
        success,
        audit,
        error: !success ? netResult.error || '网络路径仍不可达' : undefined
      }
    } catch (err) {
      console.warn('[VaultManager] 重试网络服务失败:', err)
      if (wasLegacyPending) {
        this.setNetworkV2Enabled(vaultId, false)
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /**
   * 启动所有非当前活跃的网络库的 Server/Client 服务
   * 确保主机上的所有网络库都能被客户端机发现和连接
   */
  async checkNetworkUpgradeReadiness(
    vaultId: string
  ): Promise<{ ready: boolean; error?: string; assetCount: number; folderCount: number }> {
    const vaultInfo = this.getVaultById(vaultId)
    if (!vaultInfo) {
      return { ready: false, error: '保管库不存在', assetCount: 0, folderCount: 0 }
    }
    if (vaultInfo.vaultType !== VaultType.NETWORK || !vaultInfo.networkPath) {
      return { ready: false, error: '非网络保管库', assetCount: 0, folderCount: 0 }
    }

    if (
      !vaultInfo.networkPath.startsWith('http://') &&
      !vaultInfo.networkPath.startsWith('https://')
    ) {
      try {
        await Promise.race([
          fs.access(vaultInfo.networkPath),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('网络路径访问超时(3s)')), 3000)
          )
        ])
      } catch (error) {
        return {
          ready: false,
          error: error instanceof Error ? error.message : String(error),
          assetCount: 0,
          folderCount: 0
        }
      }
    }

    let db = this.currentVaultInfo?.id === vaultId ? this.currentVaultDb : null
    let shouldCloseDb = false

    try {
      if (!db) {
        const vaultDbPath = join(vaultInfo.path, 'vault-data.db')
        if (!existsSync(vaultDbPath)) {
          return { ready: false, error: '本地元数据不存在', assetCount: 0, folderCount: 0 }
        }
        db = new Database(vaultDbPath)
        shouldCloseDb = true
      }

      const counts = this.readVaultContentCounts(db)

      return {
        ready: true,
        assetCount: counts.assetCount,
        folderCount: counts.folderCount
      }
    } catch (error) {
      return {
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        assetCount: 0,
        folderCount: 0
      }
    } finally {
      if (shouldCloseDb && db) {
        try {
          db.close()
        } catch {
          // ignore
        }
      }
    }
  }

  async startAllNetworkServers(): Promise<void> {
    const allVaults = this.getAllVaults()
    const currentId = this.currentVaultInfo?.id
    const networkVaults = allVaults.filter(
      (v) =>
        v.vaultType === VaultType.NETWORK &&
        v.networkPath &&
        this.isNetworkV2Enabled(v.id) &&
        v.id !== currentId &&
        // 远程资产服务器（http:// 路径）仅作为客户端连接，不需要在后台启动
        // 只有 SMB 共享路径的网络库才需要在后台启动 Server/Client 服务
        !v.networkPath.startsWith('http')
    )

    if (networkVaults.length === 0) return

    console.log(`[VaultManager] 启动 ${networkVaults.length} 个额外网络库的服务...`)

    for (const vault of networkVaults) {
      try {
        // 打开该 vault 的本地数据库
        const vaultDbPath = join(vault.path, 'vault-data.db')
        if (!existsSync(vaultDbPath)) {
          console.warn(`[VaultManager] 跳过网络库 ${vault.name}：数据库文件不存在`)
          continue
        }

        // 已经为这个库开过连接就复用 —— 每次切库都新开一个、旧的没人关，就是泄漏
        const db = this.backgroundVaultDbs.acquire(vault.id, () => {
          const opened = new Database(vaultDbPath)
          try {
            opened.pragma('journal_mode = WAL')
            opened.pragma('busy_timeout = 5000')
          } catch (e) {
            console.warn(`[VaultManager] 设置 WAL 失败 (${vault.name}):`, e)
          }
          // 确保表结构完整
          this.initializeVaultDatabase(opened)
          return opened
        })

        await this.startV2NetworkService(vault, db)
        console.log(`[VaultManager] 额外网络库服务已启动: ${vault.name}`)

        // 注意：db 连接保持打开，供 AssetServer/SyncClient 使用；
        //       由 closeBackgroundVaultDb / dispose 负责回收
      } catch (err) {
        console.warn(`[VaultManager] 启动网络库 ${vault.name} 的服务失败（不影响其他库）:`, err)
      }
    }
  }

  /**
   * 停止指定 Vault 的 V2 网络服务
   */
  private async stopV2NetworkService(vaultId: string): Promise<void> {
    const vsm = VaultServiceManager.getInstance()
    const role = vsm.getRole(vaultId)
    if (role === 'server') {
      await vsm.stopServer(vaultId)
    } else if (role === 'client') {
      vsm.stopClient(vaultId)
    }
    // 服务停了，为它开的后台连接也该还回去
    this.backgroundVaultDbs.release(vaultId)
  }

  /**
   * 更新保管库的同步状态
   */
  private updateSyncStatus(
    vaultId: string,
    status: 'synced' | 'syncing' | 'conflict' | 'offline' | 'error'
  ): void {
    try {
      this.publicDatabase
        .prepare(
          "UPDATE vaults SET sync_status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
        )
        .run(status, vaultId)
      console.log(`[VaultManager] 同步状态已更新: ${vaultId} -> ${status}`)
    } catch (e) {
      console.warn('[VaultManager] 更新同步状态失败:', e)
    }
  }

  /**
   * 获取本机所有 IPv4 地址
   */
  private getLocalIPList(os: typeof import('os')): string[] {
    const ips: string[] = []
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push(iface.address)
        }
      }
    }
    return ips
  }
}
