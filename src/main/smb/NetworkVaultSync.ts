/**
 * NetworkVaultSync - 局域网协作库同步管理器
 * 负责：读写 index.json、同步资产索引、冲突检测
 */
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { join, basename, extname, relative } from 'path'
import { hostname } from 'os'
import {
  NetworkVaultManifest,
  NetworkVaultAsset,
  NetworkVaultFolder,
  SyncResult,
  ConflictInfo,
  ScanOptions,
  createEmptyManifest,
  MANIFEST_FILENAME,
  THUMBNAILS_DIR,
  JOURNAL_DIR,
  JournalEntry,
  JournalOperation,
  generateJournalFilename,
  SCAN_EXCLUDE_DIRS,
  SCAN_EXCLUDE_FILES
} from './NetworkVaultTypes'
import { UnrealAssetProcessor } from '../utils/fileProcessor/UnrealAssetProcessor'
import { PathManager } from '../utils/PathManager'

// 图片格式列表（用于缩略图生成）
const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.tga',
  '.dds',
  '.bmp',
  '.tif',
  '.tiff',
  '.exr',
  '.hdr',
  '.webp'
]
// sharp 支持的输入格式（部分格式如 .psd 不支持）
const SHARP_SUPPORTED_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.tga',
  '.bmp',
  '.tif',
  '.tiff',
  '.webp',
  '.gif'
]

/**
 * 扫描选项（带进度回调）
 */
export interface ScanOptionsWithProgress extends ScanOptions {
  /** 进度回调：(current, total, currentAssetName) */
  onProgress?: (current: number, total: number, assetName: string) => void
  /** 取消信号 */
  abortSignal?: { aborted: boolean }
  /** 是否解析元数据（默认 true） */
  parseMetadata?: boolean
}

/**
 * 局域网协作库同步管理器
 */
const PENDING_QUEUE_FILE = 'pending_queue.json'

export class NetworkVaultSync {
  private static instance: NetworkVaultSync | null = null
  private localManifestCache: Map<string, { manifest: NetworkVaultManifest; cachedAt: Date }> =
    new Map()
  // 本地待处理队列（离线操作）
  private pendingQueues: Map<string, JournalEntry[]> = new Map()

  // 单例：外部只能通过 getInstance() 获取
  private constructor() {
    // 无需初始化逻辑
  }

  /**
   * 获取单例实例
   */
  static getInstance(): NetworkVaultSync {
    if (!NetworkVaultSync.instance) {
      NetworkVaultSync.instance = new NetworkVaultSync()
    }
    return NetworkVaultSync.instance
  }

  /**
   * 检查网络路径是否有写入权限
   * @returns true 如果有写权限，false 如果只读
   */
  async checkWritePermission(networkPath: string): Promise<{ canWrite: boolean; error?: string }> {
    // HTTP 资产服务器由服务端控制权限（POST/PUT/DELETE 返回 403），
    // 客户端无需预检文件系统写权限，直接视为可写
    if (networkPath.startsWith('http://') || networkPath.startsWith('https://')) {
      console.log(`[NetworkVaultSync] 权限检查: ${networkPath} -> HTTP 模式，由服务端控制权限`)
      return { canWrite: true }
    }

    const testFile = join(networkPath, `.write_test_${Date.now()}.tmp`)
    try {
      // 尝试创建一个临时文件
      await fs.writeFile(testFile, 'test', { flag: 'wx' })
      // 创建成功，删除测试文件
      await fs.unlink(testFile).catch(() => {})
      console.log(`[NetworkVaultSync] 权限检查: ${networkPath} -> 可写`)
      return { canWrite: true }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      console.log(
        `[NetworkVaultSync] 权限检查: ${networkPath} -> 只读 (${err.code}: ${err.message})`
      )
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EROFS') {
        return { canWrite: false, error: '没有写入权限（只读模式）' }
      }
      // 其他错误也视为无法写入，但记录详细信息
      return { canWrite: false, error: err.message }
    }
  }

  /**
   * 读取远程 manifest
   */
  async readManifest(networkPath: string): Promise<NetworkVaultManifest | null> {
    try {
      const manifestPath = join(networkPath, MANIFEST_FILENAME)
      // console.log(`[NetworkVaultSync] readManifest: 尝试读取 ${manifestPath}`)

      if (!existsSync(manifestPath)) {
        console.log(`[NetworkVaultSync] readManifest: 文件不存在 ${manifestPath}`)
        return null
      }

      const content = await fs.readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(content) as NetworkVaultManifest
      // console.log(`[NetworkVaultSync] readManifest: 成功读取, assets=${manifest.assets?.length || 0}, folders=${manifest.folders?.length || 0}`)

      return manifest
    } catch (error) {
      console.error('[NetworkVaultSync] 读取 manifest 失败:', error)
      return null
    }
  }

  /**
   * 获取完整的 manifest（包含未 Compaction 的 Journal 条目）
   * 用于只读客户端：在内存中合并 Journal，不写入磁盘
   * 这确保只读用户也能看到主机添加的资产和删除操作
   * @param networkPath 网络路径
   */
  async getFullManifest(networkPath: string): Promise<NetworkVaultManifest | null> {
    try {
      // 1. 读取基础 manifest
      let manifest = await this.readManifest(networkPath)

      // 2. 读取所有未合并的 Journal 条目
      const { entries, error } = await this.readAllJournals(networkPath)

      // 边界情况：manifest 不存在
      if (!manifest) {
        // 如果有 journal 条目，创建临时空 manifest 并应用
        if (entries.length > 0) {
          console.log(
            '[NetworkVaultSync] getFullManifest: manifest 不存在但有 Journal，创建临时 manifest'
          )
          manifest = createEmptyManifest('临时库', hostname())
        } else {
          console.error('[NetworkVaultSync] getFullManifest: manifest 和 Journal 都不存在')
          return null
        }
      }

      if (error) {
        console.warn(
          '[NetworkVaultSync] getFullManifest: 读取 Journal 失败，返回基础 manifest',
          error
        )
        return manifest
      }

      if (entries.length === 0) {
        console.log('[NetworkVaultSync] getFullManifest: 无 Journal 条目，返回基础 manifest')
        return manifest
      }

      console.log(
        `[NetworkVaultSync] getFullManifest: 正在内存合并 ${entries.length} 个 Journal 条目`
      )
      console.log(
        `[NetworkVaultSync] getFullManifest: 合并前 assets=${manifest.assets.length}, folders=${manifest.folders.length}`
      )

      // 统计各种操作
      let addAssetCount = 0,
        addFolderCount = 0,
        deleteAssetCount = 0,
        deleteFolderCount = 0

      // 3. 在内存中应用 Journal 条目（与 compactJournals 逻辑相同）
      for (const entry of entries) {
        // 边界检查：跳过无效条目
        if (!entry || !entry.op) {
          console.warn('[NetworkVaultSync] getFullManifest: 跳过无效 Journal 条目')
          continue
        }

        switch (entry.op) {
          case 'add_asset': {
            if (entry.data && typeof entry.data === 'object' && 'path' in entry.data) {
              const asset = entry.data as NetworkVaultAsset
              // 边界检查：确保 asset 有必要字段
              if (!asset.key || !asset.path) {
                console.warn('[NetworkVaultSync] getFullManifest: 跳过缺少 key/path 的 add_asset')
                continue
              }
              const existingIndex = manifest.assets.findIndex((a) => a.key === asset.key)
              if (existingIndex === -1) {
                manifest.assets.push(asset)
                addAssetCount++
              }
            }
            break
          }

          case 'add_folder': {
            if (entry.data && typeof entry.data === 'object' && 'name' in entry.data) {
              const folder = entry.data as NetworkVaultFolder
              // 边界检查：确保 folder 有必要字段
              if (!folder.key || !folder.name) {
                console.warn('[NetworkVaultSync] getFullManifest: 跳过缺少 key/name 的 add_folder')
                continue
              }
              // 🔧 FIX: 同时检查 key 和 name+parent 组合，防止重复文件夹
              const existingByKey = manifest.folders.findIndex((f) => f.key === folder.key)
              // 🔧 FIX: 标准化 parent 值，将 null/undefined 视为 'ALL'
              const normalizeParent = (p: string | null | undefined): string => p || 'ALL'
              const folderParent = normalizeParent(folder.parent)
              const existingByNameParent = manifest.folders.findIndex(
                (f) => f.name === folder.name && normalizeParent(f.parent) === folderParent
              )
              if (existingByKey === -1 && existingByNameParent === -1) {
                manifest.folders.push(folder)
                addFolderCount++
              } else if (existingByKey === -1 && existingByNameParent !== -1) {
                // 同名+同父级的文件夹已存在，跳过（防止重复）
                console.log(
                  `[NetworkVaultSync] getFullManifest: 跳过重复文件夹 ${folder.name} (已存在同名+同父级)`
                )
              }
            }
            break
          }

          case 'update_asset': {
            const assetIndex = manifest.assets.findIndex((a) => a.key === entry.targetId)
            if (assetIndex !== -1) {
              if (entry.data && 'path' in entry.data) {
                manifest.assets[assetIndex] = entry.data as NetworkVaultAsset
              } else {
                manifest.assets[assetIndex] = {
                  ...manifest.assets[assetIndex],
                  ...entry.changes
                }
              }
            }
            break
          }

          case 'update_folder': {
            const folderIndex = manifest.folders.findIndex((f) => f.key === entry.targetId)
            if (folderIndex !== -1) {
              manifest.folders[folderIndex] = {
                ...manifest.folders[folderIndex],
                ...entry.changes
              }
            }
            break
          }

          case 'delete_asset': {
            // 🔧 修复：只读客户端也需要处理删除操作
            // 只读模式只是不写入磁盘，但仍需在内存中合并删除，以便本地 SQLite 同步
            const beforeCount = manifest.assets.length
            manifest.assets = manifest.assets.filter((a) => a.key !== entry.targetId)
            const deletedCount = beforeCount - manifest.assets.length
            if (deletedCount > 0) {
              console.log(
                `[NetworkVaultSync] Journal delete_asset: ${entry.targetId}, 删除了 ${deletedCount} 个资产`
              )
              deleteAssetCount += deletedCount
            }
            break
          }

          case 'delete_folder': {
            // 🔧 修复：递归删除子文件夹及其资产，防止孤儿节点残留
            const beforeFolderCount = manifest.folders.length
            const beforeAssetCount = manifest.assets.length

            // 递归收集所有需要删除的文件夹 key（目标文件夹 + 所有子孙文件夹）
            const folderKeysToDelete = new Set<string>()
            const collectDescendantFolders = (parentKey: string): void => {
              folderKeysToDelete.add(parentKey)
              for (const f of manifest.folders) {
                if (f.parent === parentKey && !folderKeysToDelete.has(f.key)) {
                  collectDescendantFolders(f.key)
                }
              }
            }
            collectDescendantFolders(entry.targetId)

            manifest.folders = manifest.folders.filter((f) => !folderKeysToDelete.has(f.key))
            manifest.assets = manifest.assets.filter((a) => !folderKeysToDelete.has(a.folder))

            const deletedFolders = beforeFolderCount - manifest.folders.length
            const deletedAssets = beforeAssetCount - manifest.assets.length
            if (deletedFolders > 0 || deletedAssets > 0) {
              console.log(
                `[NetworkVaultSync] Journal delete_folder: ${entry.targetId}, 递归删除了 ${deletedFolders} 个文件夹, ${deletedAssets} 个资产`
              )
              deleteFolderCount += deletedFolders
              deleteAssetCount += deletedAssets
            }
            break
          }
        }
      }

      console.log(
        `[NetworkVaultSync] getFullManifest: Journal 操作统计 - 添加资产:${addAssetCount}, 添加文件夹:${addFolderCount}, 删除资产:${deleteAssetCount}, 删除文件夹:${deleteFolderCount}`
      )
      console.log(
        `[NetworkVaultSync] getFullManifest: 合并完成，共 ${manifest.assets.length} 个资产, ${manifest.folders.length} 个文件夹}`
      )
      return manifest
    } catch (error) {
      console.error('[NetworkVaultSync] getFullManifest 失败:', error)
      return null
    }
  }

  /**
   * 更新资产库基础信息（名称、描述、图标）
   */
  async updateVaultBasicInfo(
    networkPath: string,
    info: { name?: string; description?: string; icon?: string },
    modifiedBy: string
  ): Promise<{ success: boolean; error?: string }> {
    const lockResult = await this.acquireLock(networkPath)
    if (!lockResult.acquired) {
      return { success: false, error: '无法获取文件锁，另一进程正在操作' }
    }

    try {
      // 1. 读取 Manifest
      const manifest = await this.readManifest(networkPath)
      if (!manifest) {
        return { success: false, error: 'Manifest 不存在' }
      }

      // 2. 应用更改
      let hasChanges = false
      if (info.name && info.name !== manifest.name) {
        manifest.name = info.name
        hasChanges = true
      }
      if (info.description !== undefined && info.description !== manifest.description) {
        manifest.description = info.description
        hasChanges = true
      }
      if (info.icon !== undefined && info.icon !== manifest.icon) {
        manifest.icon = info.icon
        hasChanges = true
      }

      if (!hasChanges) {
        return { success: true }
      }

      manifest.modifiedBy = modifiedBy

      // 3. 写入 Manifest (writeManifest 会自动更新 version 和 modifiedAt)
      const writeResult = await this.writeManifest(networkPath, manifest)
      if (!writeResult.success) {
        return { success: false, error: '写入 Manifest 失败' }
      }

      console.log(`[NetworkVaultSync] 资产库信息已更新: ${JSON.stringify(info)}`)
      return { success: true }
    } catch (error) {
      console.error('[NetworkVaultSync] 更新资产库信息失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      await this.releaseLock(networkPath)
    }
  }

  /**
   * 写入 manifest（带乐观锁检测）
   */
  async writeManifest(
    networkPath: string,
    manifest: NetworkVaultManifest,
    expectedVersion?: number
  ): Promise<{ success: boolean; conflict?: ConflictInfo }> {
    try {
      const manifestPath = join(networkPath, MANIFEST_FILENAME)
      const tempPath = join(networkPath, `.${MANIFEST_FILENAME}.tmp`)

      // 乐观锁检测
      if (expectedVersion !== undefined) {
        const currentManifest = await this.readManifest(networkPath)
        if (currentManifest && currentManifest.version !== expectedVersion) {
          return {
            success: false,
            conflict: {
              type: 'version_mismatch',
              localVersion: expectedVersion,
              remoteVersion: currentManifest.version,
              remoteModifiedBy: currentManifest.modifiedBy,
              remoteModifiedAt: currentManifest.modifiedAt
            }
          }
        }
      }

      // 增加版本号
      manifest.version = (manifest.version || 0) + 1
      manifest.modifiedAt = new Date().toISOString()

      // 先写临时文件，再 rename（原子操作）
      const content = JSON.stringify(manifest, null, 2)
      await fs.writeFile(tempPath, content, 'utf-8')
      await fs.rename(tempPath, manifestPath)

      console.log(`[NetworkVaultSync] manifest 已保存，版本: ${manifest.version}`)
      return { success: true }
    } catch (error) {
      console.error('[NetworkVaultSync] 写入 manifest 失败:', error)
      return { success: false }
    }
  }

  /**
   * 写入 Journal 文件（V2 增量写入）
   * 使用 timestamp_uuid_hostname 命名，避免版本号冲突
   */
  async writeJournal(
    networkPath: string,
    op: JournalOperation,
    targetId: string,
    changes: Record<string, unknown>,
    data?: NetworkVaultAsset | NetworkVaultFolder
  ): Promise<{ success: boolean; journalFile?: string; error?: string }> {
    try {
      const journalDir = join(networkPath, JOURNAL_DIR)

      // 确保 _journal 目录存在
      if (!existsSync(journalDir)) {
        await fs.mkdir(journalDir, { recursive: true })
      }

      // 读取当前 manifest 版本作为 baseVersion
      const manifest = await this.readManifest(networkPath)
      const baseVersion = manifest?.version || 0

      // 生成 Journal 条目
      const entry: JournalEntry = {
        op,
        timestamp: Date.now(),
        hostname: hostname(),
        baseVersion,
        targetId,
        changes,
        data
      }

      // 生成文件名并写入
      const filename = generateJournalFilename(hostname())
      const journalPath = join(journalDir, filename)

      // 🔧 修复：使用 BigInt-safe replacer
      const bigIntReplacer = (_key: string, value: unknown): unknown =>
        typeof value === 'bigint' ? Number(value) : value
      await fs.writeFile(journalPath, JSON.stringify(entry, bigIntReplacer, 2), 'utf-8')

      // console.log(`[NetworkVaultSync] Journal 已写入: ${filename}`)
      return { success: true, journalFile: filename }
    } catch (error) {
      console.error('[NetworkVaultSync] 写入 Journal 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 批量写入 Journal 文件（V3 优化：多条目合并为单文件）
   * 将多个资产/文件夹变更合并为一个 Journal 文件，大幅减少网络 I/O
   */
  async writeBatchJournal(
    networkPath: string,
    entries: Array<{
      op: JournalOperation
      targetId: string
      changes: Record<string, unknown>
      data?: NetworkVaultAsset | NetworkVaultFolder
    }>
  ): Promise<{ success: boolean; journalFile?: string; entriesCount: number; error?: string }> {
    if (entries.length === 0) {
      return { success: true, entriesCount: 0 }
    }

    try {
      const journalDir = join(networkPath, JOURNAL_DIR)
      if (!existsSync(journalDir)) {
        await fs.mkdir(journalDir, { recursive: true })
      }

      // 🚀 OOM修复: 只读取 version 字段，避免解析整个 256MB manifest
      // readManifest 会将 256MB JSON 展开为 ~1GB JS 对象，仅仅为了获取一个数字
      let baseVersion = 0
      try {
        const manifestPath = join(networkPath, 'index.json')
        if (existsSync(manifestPath)) {
          // 只读前 512 字节，version 字段在 JSON 开头附近
          const fd = await fs.open(manifestPath, 'r')
          const buf = Buffer.alloc(512)
          await fd.read(buf, 0, 512, 0)
          await fd.close()
          const head = buf.toString('utf-8')
          const m = head.match(/"version"\s*:\s*(\d+)/)
          if (m) baseVersion = parseInt(m[1], 10)
        }
      } catch {
        // 读取失败时 baseVersion 保持 0
      }
      const timestamp = Date.now()
      const host = hostname()

      // 生成批量条目数组，微秒级递增保证顺序
      const batchEntries: JournalEntry[] = entries.map((e, index) => ({
        op: e.op,
        timestamp: timestamp + index,
        hostname: host,
        baseVersion,
        targetId: e.targetId,
        changes: e.changes,
        data: e.data
      }))

      // 写入单个批量 Journal 文件（使用数组格式）
      const filename = `batch_${timestamp}_${host.replace(/[^a-zA-Z0-9]/g, '_')}_${Math.random().toString(36).substr(2, 6)}.json`
      const journalPath = join(journalDir, filename)

      // 🔧 修复：使用 BigInt-safe replacer，因为 fs.stat().size 在某些系统上返回 BigInt
      const bigIntReplacer = (_key: string, value: unknown): unknown =>
        typeof value === 'bigint' ? Number(value) : value
      await fs.writeFile(journalPath, JSON.stringify(batchEntries, bigIntReplacer, 2), 'utf-8')

      console.log(`[NetworkVaultSync] 批量 Journal 已写入: ${filename} (${entries.length} 条目)`)
      return { success: true, journalFile: filename, entriesCount: entries.length }
    } catch (error) {
      console.error('[NetworkVaultSync] 批量写入 Journal 失败:', error)
      return {
        success: false,
        entriesCount: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 读取所有 Journal 文件（按时间戳排序）
   */
  async readAllJournals(networkPath: string): Promise<{
    entries: JournalEntry[]
    files: string[]
    error?: string
  }> {
    try {
      const journalDir = join(networkPath, JOURNAL_DIR)

      // 检查目录是否存在
      if (!existsSync(journalDir)) {
        return { entries: [], files: [] }
      }

      // 读取所有 .json 文件
      const allFiles = await fs.readdir(journalDir)
      const journalFiles = allFiles.filter((f) => f.endsWith('.json'))

      // 解析每个文件
      const entries: JournalEntry[] = []
      const validFiles: string[] = []

      for (const file of journalFiles) {
        try {
          const content = await fs.readFile(join(journalDir, file), 'utf-8')
          const parsed = JSON.parse(content)

          // V3: 支持批量格式（数组）和单条目格式（对象）
          if (Array.isArray(parsed)) {
            // 批量 Journal 文件 - 包含多个条目的数组
            entries.push(...(parsed as JournalEntry[]))
          } else {
            // 单条目 Journal 文件（向后兼容）
            entries.push(parsed as JournalEntry)
          }
          validFiles.push(file)
        } catch (e) {
          console.warn(`[NetworkVaultSync] 跳过无效 Journal: ${file}`, e)
        }
      }

      // 按时间戳排序（从旧到新）
      entries.sort((a, b) => a.timestamp - b.timestamp)

      console.log(`[NetworkVaultSync] 读取 ${entries.length} 个 Journal 文件`)
      return { entries, files: validFiles }
    } catch (error) {
      console.error('[NetworkVaultSync] 读取 Journal 失败:', error)
      return {
        entries: [],
        files: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 合并 Journal 文件到 Manifest（Compaction）
   * 使用快照隔离：只删除合并开始时存在的文件
   */
  async compactJournals(networkPath: string): Promise<{
    success: boolean
    mergedCount: number
    error?: string
  }> {
    try {
      // 1. 快照：读取当前所有 Journal
      const { entries, files, error } = await this.readAllJournals(networkPath)
      if (error) {
        return { success: false, mergedCount: 0, error }
      }

      if (entries.length === 0) {
        console.log('[NetworkVaultSync] 无需合并：没有 Journal 文件')
        return { success: true, mergedCount: 0 }
      }

      // 2. 读取当前 Manifest
      const manifest = await this.readManifest(networkPath)
      if (!manifest) {
        console.error('[NetworkVaultSync] 合并失败：无法读取 Manifest')
        return { success: false, mergedCount: 0, error: '无法读取 Manifest' }
      }

      // 3. 按时间顺序应用每个 Journal 条目
      for (const entry of entries) {
        switch (entry.op) {
          case 'add_asset': {
            if (entry.data && 'path' in entry.data) {
              const asset = entry.data as NetworkVaultAsset
              const existingIndex = manifest.assets.findIndex((a) => a.key === asset.key)
              if (existingIndex === -1) {
                manifest.assets.push(asset)
              }
            }
            break
          }

          case 'add_folder': {
            if (entry.data && 'name' in entry.data) {
              const folder = entry.data as NetworkVaultFolder
              // 🔧 FIX: 同时检查 key 和 name+parent 组合，防止重复文件夹
              const existingByKey = manifest.folders.findIndex((f) => f.key === folder.key)
              // 🔧 FIX: 标准化 parent 值，将 null/undefined 视为 'ALL'
              const normalizeParent = (p: string | null | undefined): string => p || 'ALL'
              const folderParent = normalizeParent(folder.parent)
              const existingByNameParent = manifest.folders.findIndex(
                (f) => f.name === folder.name && normalizeParent(f.parent) === folderParent
              )
              if (existingByKey === -1 && existingByNameParent === -1) {
                manifest.folders.push(folder)
              }
            }
            break
          }

          case 'update_asset': {
            const assetIndex = manifest.assets.findIndex((a) => a.key === entry.targetId)
            if (assetIndex !== -1) {
              // 使用 entry.data（完整更新后的资产）而不是 entry.changes（仅包含元信息）
              if (entry.data && 'path' in entry.data) {
                const newAsset = entry.data as NetworkVaultAsset
                const oldAsset = manifest.assets[assetIndex]
                // 🔧 防御：保留旧 thumbnail，防止 update_asset journal 的 data 字段遗漏 thumbnail
                if (oldAsset.thumbnail && !newAsset.thumbnail) {
                  console.warn(
                    `[NetworkVaultSync] ⚠️ compactJournals: update_asset 会清除 thumbnail, assetKey=${entry.targetId}, 旧值=${oldAsset.thumbnail}, 保留旧值`
                  )
                  newAsset.thumbnail = oldAsset.thumbnail
                }
                manifest.assets[assetIndex] = newAsset
              } else {
                // 回退：使用 changes 合并（兼容旧版本 Journal）
                const oldThumbnail = manifest.assets[assetIndex].thumbnail
                manifest.assets[assetIndex] = {
                  ...manifest.assets[assetIndex],
                  ...entry.changes
                }
                // 🔧 防御：changes 不应该清除 thumbnail
                if (oldThumbnail && !manifest.assets[assetIndex].thumbnail) {
                  console.warn(
                    `[NetworkVaultSync] ⚠️ compactJournals: changes 会清除 thumbnail, assetKey=${entry.targetId}, 旧值=${oldThumbnail}, 保留旧值`
                  )
                  manifest.assets[assetIndex].thumbnail = oldThumbnail
                }
              }
            }
            break
          }

          case 'update_folder': {
            const folderIndex = manifest.folders.findIndex((f) => f.key === entry.targetId)
            if (folderIndex !== -1) {
              manifest.folders[folderIndex] = {
                ...manifest.folders[folderIndex],
                ...entry.changes
              }
            }
            break
          }

          case 'delete_asset': {
            // 🔧 修复：只删除资产，不删除文件夹（之前的代码有 bug）
            manifest.assets = manifest.assets.filter((a) => a.key !== entry.targetId)
            break
          }

          case 'delete_folder': {
            // 🔧 修复：递归删除子文件夹及其资产，防止孤儿节点残留
            const folderKeysToDelete = new Set<string>()
            const collectDescendants = (parentKey: string): void => {
              folderKeysToDelete.add(parentKey)
              for (const f of manifest.folders) {
                if (f.parent === parentKey && !folderKeysToDelete.has(f.key)) {
                  collectDescendants(f.key)
                }
              }
            }
            collectDescendants(entry.targetId)

            manifest.folders = manifest.folders.filter((f) => !folderKeysToDelete.has(f.key))
            manifest.assets = manifest.assets.filter((a) => !folderKeysToDelete.has(a.folder))
            break
          }
        }
      }

      // 4. 原子写入新 Manifest
      const writeResult = await this.writeManifest(networkPath, manifest)
      if (!writeResult.success) {
        return { success: false, mergedCount: 0, error: '写入 Manifest 失败' }
      }

      // 5. 快照隔离删除：只删除合并开始时的文件
      const journalDir = join(networkPath, JOURNAL_DIR)
      let deletedCount = 0
      for (const file of files) {
        try {
          await fs.unlink(join(journalDir, file))
          deletedCount++
        } catch (e) {
          console.warn(`[NetworkVaultSync] 删除 Journal 失败: ${file}`, e)
        }
      }

      console.log(
        `[NetworkVaultSync] 合并完成: ${entries.length} 条目, 删除 ${deletedCount} 个文件`
      )
      return { success: true, mergedCount: entries.length }
    } catch (error) {
      console.error('[NetworkVaultSync] Journal 合并失败:', error)
      return {
        success: false,
        mergedCount: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 三维触发条件检查 - 决定是否需要执行 compactJournals
   * 触发条件（满足任意一个即触发）：
   * 1. 文件数量 >= 10
   * 2. 最老 Journal 超过 5 分钟
   * 3. 所有 Journal 总大小 >= 100KB
   */
  async shouldCompact(networkPath: string): Promise<{
    shouldCompact: boolean
    reason?: string
    stats: { fileCount: number; oldestAgeMs: number; totalSizeBytes: number }
  }> {
    const THRESHOLD_FILE_COUNT = 10
    const THRESHOLD_AGE_MS = 5 * 60 * 1000 // 5 minutes
    const THRESHOLD_SIZE_BYTES = 100 * 1024 // 100KB

    try {
      const journalDir = join(networkPath, JOURNAL_DIR)

      if (!existsSync(journalDir)) {
        return {
          shouldCompact: false,
          stats: { fileCount: 0, oldestAgeMs: 0, totalSizeBytes: 0 }
        }
      }

      const allFiles = await fs.readdir(journalDir)
      const journalFiles = allFiles.filter((f) => f.endsWith('.json'))

      if (journalFiles.length === 0) {
        return {
          shouldCompact: false,
          stats: { fileCount: 0, oldestAgeMs: 0, totalSizeBytes: 0 }
        }
      }

      // 计算统计信息
      let totalSize = 0
      let oldestTimestamp = Date.now()

      for (const file of journalFiles) {
        const filePath = join(journalDir, file)
        const stat = await fs.stat(filePath)
        totalSize += stat.size

        // 🔧 修复：支持两种文件名格式的时间戳解析
        // 普通 journal: {timestamp}_{uuid}_{hostname}.json
        // batch journal: batch_{timestamp}_{hostname}_{random}.json
        let timestampStr: string
        if (file.startsWith('batch_')) {
          timestampStr = file.split('_')[1]
        } else {
          timestampStr = file.split('_')[0]
        }
        const timestamp = parseInt(timestampStr, 10)
        if (!isNaN(timestamp) && timestamp < oldestTimestamp) {
          oldestTimestamp = timestamp
        }
      }

      const oldestAgeMs = Date.now() - oldestTimestamp
      const stats = {
        fileCount: journalFiles.length,
        oldestAgeMs,
        totalSizeBytes: totalSize
      }

      // 检查触发条件
      if (journalFiles.length >= THRESHOLD_FILE_COUNT) {
        return {
          shouldCompact: true,
          reason: `文件数量 ${journalFiles.length} >= ${THRESHOLD_FILE_COUNT}`,
          stats
        }
      }

      if (oldestAgeMs >= THRESHOLD_AGE_MS) {
        return {
          shouldCompact: true,
          reason: `最老 Journal 已超过 ${Math.round(oldestAgeMs / 1000)}秒`,
          stats
        }
      }

      if (totalSize >= THRESHOLD_SIZE_BYTES) {
        return {
          shouldCompact: true,
          reason: `总大小 ${Math.round(totalSize / 1024)}KB >= 100KB`,
          stats
        }
      }

      return { shouldCompact: false, stats }
    } catch (error) {
      console.error('[NetworkVaultSync] shouldCompact 检查失败:', error)
      return {
        shouldCompact: false,
        stats: { fileCount: 0, oldestAgeMs: 0, totalSizeBytes: 0 }
      }
    }
  }

  /**
   * 文件锁 - 使用 index.lock 实现原子互斥
   * 利用 Node.js 的 'wx' 标志实现原子创建
   */
  async acquireLock(
    networkPath: string,
    timeoutMs: number = 5000
  ): Promise<{
    acquired: boolean
    lockFile?: string
    error?: string
  }> {
    const lockFile = join(networkPath, 'index.lock')
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      try {
        // 'wx' 标志：如果文件已存在则失败，保证原子性
        const lockContent = JSON.stringify({
          hostname: hostname(),
          pid: process.pid,
          timestamp: Date.now()
        })
        await fs.writeFile(lockFile, lockContent, { flag: 'wx' })
        console.log(`[NetworkVaultSync] 锁定成功: ${lockFile}`)
        return { acquired: true, lockFile }
      } catch (e: unknown) {
        const error = e as NodeJS.ErrnoException
        if (error.code === 'EEXIST') {
          // 锁文件已存在，检查是否过期（超过30秒视为死锁）
          try {
            const lockStat = await fs.stat(lockFile)
            const lockAge = Date.now() - lockStat.mtimeMs
            if (lockAge > 30000) {
              console.warn(`[NetworkVaultSync] 检测到死锁，强制释放: ${lockFile}`)
              await fs.unlink(lockFile)
              continue
            }
          } catch {
            // 锁文件可能刚被删除，继续尝试
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        } else {
          return { acquired: false, error: error.message }
        }
      }
    }

    return { acquired: false, error: '获取锁超时' }
  }

  async releaseLock(networkPath: string): Promise<boolean> {
    const lockFile = join(networkPath, 'index.lock')
    try {
      await fs.unlink(lockFile)
      console.log(`[NetworkVaultSync] 锁已释放: ${lockFile}`)
      return true
    } catch (e) {
      console.warn(`[NetworkVaultSync] 释放锁失败: ${lockFile}`, e)
      return false
    }
  }

  /**
   * 离线模式：将操作添加到本地待处理队列
   */
  async queuePendingOperation(localCachePath: string, entry: JournalEntry): Promise<boolean> {
    try {
      // 加载现有队列
      const queue = await this.loadPendingQueue(localCachePath)
      queue.push(entry)

      // 持久化到本地磁盘
      const queuePath = join(localCachePath, PENDING_QUEUE_FILE)
      await fs.writeFile(queuePath, JSON.stringify(queue, null, 2), 'utf-8')

      // 更新内存缓存
      this.pendingQueues.set(localCachePath, queue)

      console.log(`[NetworkVaultSync] 操作已加入离线队列: ${entry.op}`)
      return true
    } catch (error) {
      console.error('[NetworkVaultSync] 加入离线队列失败:', error)
      return false
    }
  }

  /**
   * 加载本地待处理队列
   */
  async loadPendingQueue(localCachePath: string): Promise<JournalEntry[]> {
    // 先检查内存缓存
    if (this.pendingQueues.has(localCachePath)) {
      return this.pendingQueues.get(localCachePath)!
    }

    const queuePath = join(localCachePath, PENDING_QUEUE_FILE)
    try {
      if (existsSync(queuePath)) {
        const content = await fs.readFile(queuePath, 'utf-8')
        const queue = JSON.parse(content) as JournalEntry[]
        this.pendingQueues.set(localCachePath, queue)
        return queue
      }
    } catch (error) {
      console.error('[NetworkVaultSync] 读取离线队列失败:', error)
    }

    return []
  }

  /**
   * 刷新待处理队列到网络（同步时）
   */
  async flushPendingQueue(
    localCachePath: string,
    networkPath: string
  ): Promise<{
    success: boolean
    flushedCount: number
    error?: string
  }> {
    try {
      const queue = await this.loadPendingQueue(localCachePath)
      if (queue.length === 0) {
        return { success: true, flushedCount: 0 }
      }

      // 逐条写入 Journal
      let flushedCount = 0
      for (const entry of queue) {
        const result = await this.writeJournal(
          networkPath,
          entry.op,
          entry.targetId,
          entry.changes,
          entry.data
        )
        if (result.success) {
          flushedCount++
        } else {
          console.warn(`[NetworkVaultSync] 刷新队列条目失败: ${entry.op}`)
        }
      }

      // 清空本地队列
      const queuePath = join(localCachePath, PENDING_QUEUE_FILE)
      await fs.unlink(queuePath).catch(() => {})
      this.pendingQueues.delete(localCachePath)

      console.log(`[NetworkVaultSync] 刷新完成: ${flushedCount}/${queue.length} 条`)
      return { success: true, flushedCount }
    } catch (error) {
      console.error('[NetworkVaultSync] 刷新队列失败:', error)
      return {
        success: false,
        flushedCount: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 检测 Rebase 冲突
   * 比对本地待处理队列与远端 Manifest 变更，识别冲突
   */
  async detectRebaseConflicts(
    localCachePath: string,
    networkPath: string
  ): Promise<{
    hasConflicts: boolean
    conflicts: ConflictInfo[]
    canAutoResolve: boolean
  }> {
    const conflicts: ConflictInfo[] = []

    try {
      // 加载本地待处理队列
      const pendingQueue = await this.loadPendingQueue(localCachePath)
      if (pendingQueue.length === 0) {
        return { hasConflicts: false, conflicts: [], canAutoResolve: true }
      }

      // 读取远端最新 Manifest
      const remoteManifest = await this.readManifest(networkPath)
      if (!remoteManifest) {
        // 远端无 Manifest，无冲突
        return { hasConflicts: false, conflicts: [], canAutoResolve: true }
      }

      // 检查每个待处理操作是否与远端冲突
      for (const entry of pendingQueue) {
        if (entry.op === 'update_asset' && entry.targetId) {
          // 检查远端资产是否被修改
          const remoteAsset = remoteManifest.assets.find((a) => a.key === entry.targetId)
          if (remoteAsset) {
            // 如果远端版本比本地操作更新，则冲突
            if (
              remoteAsset.modifiedAt &&
              new Date(remoteAsset.modifiedAt).getTime() > entry.timestamp
            ) {
              conflicts.push({
                assetKey: entry.targetId,
                localVersion: entry.changes || {},
                remoteVersion: remoteAsset,
                conflictType: 'update_conflict'
              })
            }
          }
        }

        if (entry.op === 'delete_asset' && entry.targetId) {
          // 检查远端是否也删除了
          const stillExists = remoteManifest.assets.some((a) => a.key === entry.targetId)
          if (!stillExists) {
            // 远端已删除，双删不冲突，跳过
            continue
          }
          // 如果远端还存在且被修改，可能需要用户确认
          const remoteAsset = remoteManifest.assets.find((a) => a.key === entry.targetId)
          if (
            remoteAsset &&
            remoteAsset.modifiedAt &&
            new Date(remoteAsset.modifiedAt).getTime() > entry.timestamp
          ) {
            conflicts.push({
              assetKey: entry.targetId,
              localVersion: { deleted: true },
              remoteVersion: remoteAsset,
              conflictType: 'delete_modified'
            })
          }
        }
      }

      const canAutoResolve = conflicts.every(
        (c) => c.conflictType === 'update_conflict' // 简单覆盖策略
      )

      console.log(`[NetworkVaultSync] 冲突检测完成: ${conflicts.length} 个冲突`)
      return {
        hasConflicts: conflicts.length > 0,
        conflicts,
        canAutoResolve
      }
    } catch (error) {
      console.error('[NetworkVaultSync] 冲突检测失败:', error)
      return { hasConflicts: false, conflicts: [], canAutoResolve: false }
    }
  }

  /**
   * 创建新的局域网协作库
   */
  async createNetworkVault(
    networkPath: string,
    name: string,
    createdBy: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 检查是否已存在
      const existingManifest = await this.readManifest(networkPath)
      if (existingManifest) {
        return { success: false, error: '该路径已存在资产库' }
      }

      // 创建缩略图目录
      const thumbnailsPath = join(networkPath, THUMBNAILS_DIR)
      if (!existsSync(thumbnailsPath)) {
        await fs.mkdir(thumbnailsPath, { recursive: true })
      }

      // 创建空 manifest
      const manifest = createEmptyManifest(name, createdBy)
      const result = await this.writeManifest(networkPath, manifest)

      if (!result.success) {
        return { success: false, error: '创建 manifest 失败' }
      }

      console.log(`[NetworkVaultSync] 局域网协作库已创建: ${name} at ${networkPath}`)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 检查远程是否有更新
   */
  async checkForUpdates(networkPath: string, lastKnownVersion: number): Promise<boolean> {
    try {
      const manifest = await this.readManifest(networkPath)
      if (!manifest) {
        return false
      }

      return manifest.version > lastKnownVersion
    } catch {
      return false
    }
  }

  /**
   * 从网络同步到本地缓存
   */
  async syncFromNetwork(networkPath: string, localCachePath: string): Promise<SyncResult> {
    try {
      const manifest = await this.readManifest(networkPath)
      if (!manifest) {
        return { success: false, error: 'manifest 不存在' }
      }

      // 保存到本地缓存
      const localManifestPath = join(localCachePath, 'manifest.json')
      await fs.mkdir(localCachePath, { recursive: true })
      await fs.writeFile(localManifestPath, JSON.stringify(manifest, null, 2))

      // 更新内存缓存
      this.localManifestCache.set(networkPath, {
        manifest,
        cachedAt: new Date()
      })

      console.log(`[NetworkVaultSync] 同步完成: ${manifest.assets.length} 个资产`)
      return {
        success: true,
        added: manifest.assets.length,
        updated: 0,
        removed: 0
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 扫描网络路径中的资产文件
   */
  async scanAssets(networkPath: string, options: ScanOptions = {}): Promise<NetworkVaultAsset[]> {
    const { recursive = true, excludeDirs = SCAN_EXCLUDE_DIRS } = options

    const assets: NetworkVaultAsset[] = []

    const scanDir = async (dir: string, folderKey: string): Promise<void> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })

        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          const relativePath = relative(networkPath, fullPath).replace(/\\/g, '/')

          if (entry.isDirectory()) {
            if (recursive && !excludeDirs.includes(entry.name)) {
              await scanDir(fullPath, entry.name)
            }
          } else if (entry.isFile()) {
            // 排除系统文件（index.json），其余全部纳入清单
            if (!SCAN_EXCLUDE_FILES.includes(entry.name)) {
              const ext = extname(entry.name).toLowerCase()
              const stats = await fs.stat(fullPath)
              assets.push({
                key: `asset_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                folder: folderKey || 'ALL',
                name: basename(entry.name, ext),
                path: relativePath,
                size: stats.size,
                createdAt: new Date().toISOString()
              })
            }
          }
        }
      } catch (error) {
        console.warn(`[NetworkVaultSync] 扫描目录失败: ${dir}`, error)
      }
    }

    await scanDir(networkPath, 'ALL')
    console.log(`[NetworkVaultSync] 扫描完成: 发现 ${assets.length} 个资产`)
    return assets
  }

  /**
   * 扫描网络路径中的资产文件（带元数据解析和进度回调）
   * 用于初始化时完整解析所有资产
   */
  async scanAssetsWithMetadata(
    networkPath: string,
    options: ScanOptionsWithProgress = {}
  ): Promise<NetworkVaultAsset[]> {
    const {
      recursive = true,
      excludeDirs = SCAN_EXCLUDE_DIRS,
      onProgress,
      abortSignal,
      parseMetadata = true
    } = options

    // 第一阶段：快速收集所有文件路径（不过滤扩展名，确保不遗漏任何文件）
    // folderPath: 相对路径（如 "Content/Textures"），用于建立层级关系
    const filePaths: { fullPath: string; relativePath: string; folderPath: string }[] = []
    // 收集发现的文件夹（相对路径 -> 父相对路径）
    const discoveredFolders = new Map<string, string>()

    const collectFiles = async (dir: string, folderPath: string): Promise<void> => {
      if (abortSignal?.aborted) return
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (abortSignal?.aborted) return
          const fullPath = join(dir, entry.name)
          const relativePath = relative(networkPath, fullPath).replace(/\\/g, '/')

          if (entry.isDirectory()) {
            if (recursive && !excludeDirs.includes(entry.name)) {
              // 记录文件夹：子目录相对路径 -> 父目录相对路径
              const childFolderPath = folderPath ? `${folderPath}/${entry.name}` : entry.name
              discoveredFolders.set(childFolderPath, folderPath || 'ALL')
              await collectFiles(fullPath, childFolderPath)
            }
          } else if (entry.isFile()) {
            // 排除系统文件（index.json），其余全部纳入清单
            if (!SCAN_EXCLUDE_FILES.includes(entry.name)) {
              filePaths.push({ fullPath, relativePath, folderPath: folderPath || 'ALL' })
            }
          }
        }
      } catch (error) {
        console.warn(`[NetworkVaultSync] 扫描目录失败: ${dir}`, error)
      }
    }

    await collectFiles(networkPath, '')
    console.log(`[NetworkVaultSync] 第一阶段完成: 发现 ${filePaths.length} 个文件`)

    if (abortSignal?.aborted) {
      console.log('[NetworkVaultSync] 扫描已取消')
      return []
    }

    // 第二阶段：逐个解析资产
    const assets: NetworkVaultAsset[] = []
    const processor = parseMetadata ? new UnrealAssetProcessor() : null
    const pathManager = PathManager.getInstance()
    const total = filePaths.length

    for (let i = 0; i < filePaths.length; i++) {
      if (abortSignal?.aborted) {
        console.log('[NetworkVaultSync] 扫描已取消')
        break
      }

      const { fullPath, relativePath, folderPath } = filePaths[i]
      const ext = extname(fullPath).toLowerCase()
      const assetName = basename(fullPath, ext)

      // 回报进度
      onProgress?.(i + 1, total, assetName)

      try {
        const stats = await fs.stat(fullPath)

        // 初始化资产对象
        // 使用 folderPath（相对路径如 "Content/Textures"）作为文件夹标识
        const asset: NetworkVaultAsset = {
          key: `asset_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          folder: folderPath,
          name: assetName,
          path: relativePath,
          size: stats.size,
          createdAt: new Date().toISOString()
        }

        // 解析元数据（仅 .uasset 和 .umap）
        if (processor && (ext === '.uasset' || ext === '.umap')) {
          try {
            const parsed = await processor.processFile(fullPath)
            asset.className = parsed.assetType || undefined
            asset.engineVersion = parsed.engineVersion || undefined

            // 保存缩略图到网络共享目录
            // 注意: imgLocalPath 只是文件名，UnrealAssetProcessor 将缩略图保存到公共缩略图目录
            // 所以需要使用 getPublicThumbnailFilePath 而非 getThumbnailFilePath（后者返回保管库特定路径）
            if (parsed.metadata?.imgLocalPath) {
              const thumbFileName = parsed.metadata.imgLocalPath as string
              // 🔧 修复：使用 getThumbnailFilePath（对于网络库返回 networkPath/.thumbnails）
              // 与 UnrealAssetProcessor.saveFirstThumbnailToElectronPath 保持一致
              const localThumbPath = pathManager.getThumbnailFilePath(thumbFileName)

              // 等待缩略图文件存在（最多等待 500ms）
              let retries = 5
              while (retries > 0 && !existsSync(localThumbPath)) {
                await new Promise((resolve) => setTimeout(resolve, 100))
                retries--
              }

              if (existsSync(localThumbPath)) {
                const thumbName = await this.saveThumbnailToNetwork(networkPath, localThumbPath)
                asset.thumbnail = thumbName
              }
            }

            // 存储额外元数据
            asset.metadata = {
              softPath: parsed.metadata?.softPath,
              imports: parsed.metadata?.imports
            }
            console.log(
              `[NetworkVaultSync] 解析资产: ${fullPath}, softPath: ${parsed.metadata?.softPath}`
            )
          } catch (parseError) {
            console.warn(`[NetworkVaultSync] 解析资产失败: ${fullPath}`, parseError)
            // 解析失败不影响资产添加，只是没有元数据
          }
        } else if (SHARP_SUPPORTED_EXTENSIONS.includes(ext)) {
          // 图片文件：生成压缩缩略图并同步到网络共享目录
          try {
            const sharp = (await import('sharp')).default
            const thumbnailDir = join(networkPath, THUMBNAILS_DIR)
            await fs.mkdir(thumbnailDir, { recursive: true })

            // 生成缩略图文件名
            const thumbFileName = `thumb_${asset.key}.jpg`
            const thumbPath = join(thumbnailDir, thumbFileName)

            // 使用 sharp 生成压缩缩略图
            const image = sharp(fullPath)
            const metadata = await image.metadata()

            // 限制最大尺寸为 512x512，保持比例
            if (
              (metadata.width && metadata.width > 512) ||
              (metadata.height && metadata.height > 512)
            ) {
              image.resize(512, 512, { fit: 'inside', withoutEnlargement: true })
            }

            // 统一输出为 JPEG 格式以减小体积
            await image.jpeg({ quality: 80, mozjpeg: true }).toFile(thumbPath)

            asset.thumbnail = thumbFileName
            asset.className = 'Texture2D' // 设置类型为纹理
            console.log(`[NetworkVaultSync] 图片缩略图已生成: ${thumbFileName}`)
          } catch (imgError) {
            console.warn(`[NetworkVaultSync] 图片缩略图生成失败: ${fullPath}`, imgError)
            // 缩略图生成失败不影响资产添加
          }
        } else if (IMAGE_EXTENSIONS.includes(ext)) {
          // 其他图片格式（sharp 不直接支持的如 .psd, .exr, .hdr）
          // 标记为纹理类型，但不生成缩略图
          asset.className = 'Texture2D'
        }

        assets.push(asset)
      } catch (error) {
        console.warn(`[NetworkVaultSync] 处理文件失败: ${fullPath}`, error)
      }
    }

    console.log(`[NetworkVaultSync] 扫描完成: 解析 ${assets.length} 个资产`)
    return assets
  }

  /**
   * 保存缩略图到网络共享目录
   */
  async saveThumbnailToNetwork(networkPath: string, localThumbnail: string): Promise<string> {
    try {
      const thumbnailDir = join(networkPath, THUMBNAILS_DIR)
      await fs.mkdir(thumbnailDir, { recursive: true })
      const destName = basename(localThumbnail)
      const destPath = join(thumbnailDir, destName)
      await fs.copyFile(localThumbnail, destPath)
      return destName
    } catch (error) {
      console.warn(`[NetworkVaultSync] 保存缩略图失败: ${localThumbnail}`, error)
      return ''
    }
  }

  /**
   * 统一同步操作 - 合并 Journal 合并和增量扫描为单一原子操作
   *
   * 流程：
   * 1. 获取锁
   * 2. 合并 Journals 到 Manifest（获取最新状态）
   * 3. 扫描物理文件差异
   * 4. 写入变更 Journals
   * 5. 释放锁
   *
   * 相比分离操作的优势：
   * - 单次锁定，减少网络锁争用
   * - 状态一致性更强，不存在中间状态
   * - 使用最新的合并后 manifest 进行差异检测
   */
  async unifiedSync(
    networkPath: string,
    options: {
      onProgress?: (current: number, total: number, phase: string) => void
      abortSignal?: { aborted: boolean }
    } = {}
  ): Promise<{
    success: boolean
    newAssets: NetworkVaultAsset[]
    newFolders: NetworkVaultFolder[]
    deletedAssets: NetworkVaultAsset[]
    deletedFolders: NetworkVaultFolder[]
    manifestVersion: number
    /** 🚀 OOM优化: 返回已合并的 manifest，避免调用方重复读取 256MB */
    manifest?: NetworkVaultManifest
    error?: string
  }> {
    const { onProgress, abortSignal } = options
    const emptyResult = {
      success: false,
      newAssets: [] as NetworkVaultAsset[],
      newFolders: [] as NetworkVaultFolder[],
      deletedAssets: [] as NetworkVaultAsset[],
      deletedFolders: [] as NetworkVaultFolder[],
      manifestVersion: 0
    }

    console.log(`[NetworkVaultSync] 开始统一同步: ${networkPath}`)

    try {
      // 1. 获取锁
      onProgress?.(0, 100, '获取锁')
      const lockResult = await this.acquireLock(networkPath)
      if (!lockResult.acquired) {
        console.warn('[NetworkVaultSync] 无法获取锁，稍后重试')
        return { ...emptyResult, error: '无法获取锁，请稍后重试' }
      }

      try {
        // 🔧 修复：在 compaction 前读取 Journal 中的删除操作
        // 这样即使 compaction 后 manifest 中没有这些资产，我们仍然知道要删除哪些
        const journalResult = await this.readAllJournals(networkPath)
        const journalDeletedAssetKeys = new Set<string>()
        const journalDeletedFolderKeys = new Set<string>()
        if (journalResult.entries) {
          for (const entry of journalResult.entries) {
            if (entry.op === 'delete_asset') {
              journalDeletedAssetKeys.add(entry.targetId)
            } else if (entry.op === 'delete_folder') {
              journalDeletedFolderKeys.add(entry.targetId)
            }
          }
        }
        console.log(
          `[NetworkVaultSync] Journal 删除记录: ${journalDeletedAssetKeys.size} 个资产, ${journalDeletedFolderKeys.size} 个文件夹`
        )

        // 🚀 OOM优化: 仅在有 journal 删除操作时才读取旧 manifest
        // 如果没有删除操作，跳过这次 256MB 读取（大幅减少内存）
        const journalDeletedAssets: NetworkVaultAsset[] = []
        const journalDeletedFolders: NetworkVaultFolder[] = []
        if (journalDeletedAssetKeys.size > 0 || journalDeletedFolderKeys.size > 0) {
          const oldManifest = await this.readManifest(networkPath)
          if (oldManifest && journalDeletedAssetKeys.size > 0) {
            for (const asset of oldManifest.assets) {
              if (journalDeletedAssetKeys.has(asset.key)) {
                journalDeletedAssets.push(asset)
              }
            }
          }
          if (oldManifest && journalDeletedFolderKeys.size > 0) {
            for (const folder of oldManifest.folders) {
              if (journalDeletedFolderKeys.has(folder.key)) {
                journalDeletedFolders.push(folder)
              }
            }
          }
          console.log(
            `[NetworkVaultSync] 从旧 manifest 找到 ${journalDeletedAssets.length} 个待删除资产, ${journalDeletedFolders.length} 个待删除文件夹`
          )
          // oldManifest 出作用域，可被 GC
        } else {
          console.log('[NetworkVaultSync] 无 Journal 删除操作，跳过旧 manifest 读取')
        }

        // 2. 合并 Journals（获取最新 manifest 状态）
        onProgress?.(5, 100, '合并索引')
        await this.compactJournals(networkPath)

        // 3. 读取合并后的最新 manifest
        onProgress?.(10, 100, '读取索引')
        let manifest = await this.readManifest(networkPath)
        if (!manifest) {
          console.log('[NetworkVaultSync] Manifest 不存在，创建新的空 manifest')
          manifest = {
            name: 'Network Vault',
            version: 1,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
            modifiedBy: hostname(),
            assets: [],
            folders: []
          }
          const writeResult = await this.writeManifest(networkPath, manifest)
          if (!writeResult.success) {
            return { ...emptyResult, error: '无法创建 manifest' }
          }
        }

        if (abortSignal?.aborted) {
          return { ...emptyResult, error: '操作已取消' }
        }

        // 4. 执行增量扫描（内部逻辑）
        const scanResult = await this.performIncrementalScanLogic(networkPath, manifest, {
          onProgress,
          abortSignal,
          journalEntries: journalResult.entries
        })

        if (!scanResult.success) {
          return { ...emptyResult, error: scanResult.error, manifestVersion: manifest.version }
        }

        onProgress?.(100, 100, '完成')

        // 🔧 修复：合并 Journal 中的删除记录到返回结果
        // 这确保即使 compaction 后 manifest 和物理文件都没有该资产，我们仍然知道要删除哪些
        const allDeletedAssets = [...scanResult.deletedAssets]
        const allDeletedFolders = [...scanResult.deletedFolders]
        const existingDeletedAssetKeys = new Set(scanResult.deletedAssets.map((a) => a.key))
        const existingDeletedFolderKeys = new Set(scanResult.deletedFolders.map((f) => f.key))
        for (const asset of journalDeletedAssets) {
          if (!existingDeletedAssetKeys.has(asset.key)) {
            allDeletedAssets.push(asset)
          }
        }
        for (const folder of journalDeletedFolders) {
          if (!existingDeletedFolderKeys.has(folder.key)) {
            allDeletedFolders.push(folder)
          }
        }
        console.log(
          `[NetworkVaultSync] 最终删除数量: ${allDeletedAssets.length} 个资产, ${allDeletedFolders.length} 个文件夹`
        )

        return {
          success: true,
          newAssets: scanResult.newAssets,
          newFolders: scanResult.newFolders,
          deletedAssets: allDeletedAssets,
          deletedFolders: allDeletedFolders,
          manifestVersion: manifest.version,
          manifest // 🚀 OOM优化: 返回已合并的 manifest，避免调用方再次读取 256MB
        }
      } finally {
        // 5. 释放锁（确保即使出错也能释放）
        await this.releaseLock(networkPath)
      }
    } catch (error) {
      console.error('[NetworkVaultSync] 统一同步失败:', error)
      return {
        ...emptyResult,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 增量扫描内部逻辑 - 供 unifiedSync 调用
   * 传入已合并的 manifest，执行物理扫描和差异检测
   */
  private async performIncrementalScanLogic(
    networkPath: string,
    manifest: NetworkVaultManifest,
    options: {
      onProgress?: (current: number, total: number, phase: string) => void
      abortSignal?: { aborted: boolean }
      /** 🚀 内存优化：从 unifiedSync 透传 journal 条目，避免重复读取网络磁盘 */
      journalEntries?: JournalEntry[]
    } = {}
  ): Promise<{
    success: boolean
    newAssets: NetworkVaultAsset[]
    newFolders: NetworkVaultFolder[]
    deletedAssets: NetworkVaultAsset[]
    deletedFolders: NetworkVaultFolder[]
    error?: string
  }> {
    const { onProgress, abortSignal, journalEntries: passedJournalEntries } = options

    // 构建已存在路径集合
    // 🔧 修复幽灵资产：对路径进行归一化（小写 + 正斜杠），避免 UNC 路径大小写不一致导致误判
    const normalizeAssetPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
    const existingAssetPaths = new Set(manifest.assets.map((a) => normalizeAssetPath(a.path)))

    // 🔧 诊断：检测 manifest 中是否有重复 path 的资产
    if (existingAssetPaths.size !== manifest.assets.length) {
      const duplicateCount = manifest.assets.length - existingAssetPaths.size
      console.warn(
        `[NetworkVaultSync] ⚠️ 诊断: manifest 中有 ${duplicateCount} 个重复路径的资产 (${manifest.assets.length} 总数, ${existingAssetPaths.size} 唯一路径)`
      )
      // 输出前 10 个重复路径
      const pathCounts = new Map<string, number>()
      for (const a of manifest.assets) {
        pathCounts.set(a.path, (pathCounts.get(a.path) || 0) + 1)
      }
      let shown = 0
      for (const [path, count] of pathCounts) {
        if (count > 1 && shown < 10) {
          console.warn(`[NetworkVaultSync]   重复: "${path}" x${count}`)
          shown++
        }
      }
    }

    // 快速扫描文件路径
    onProgress?.(15, 100, '扫描文件系统')
    const scanResult = await this.scanFilePaths(networkPath, abortSignal)
    const allFilePaths = scanResult.files

    if (abortSignal?.aborted) {
      return {
        success: false,
        newAssets: [],
        newFolders: [],
        deletedAssets: [],
        deletedFolders: [],
        error: '扫描已取消'
      }
    }

    console.log(
      `[NetworkVaultSync] 扫描到 ${allFilePaths.length} 个文件 (manifest: ${manifest.assets.length} 资产, ${existingAssetPaths.size} 唯一路径, 失败目录: ${scanResult.failedDirs})`
    )

    // 检测新增和删除
    const scannedPaths = new Set(allFilePaths.map((f) => normalizeAssetPath(f.relativePath)))
    const newFilePaths = allFilePaths.filter(
      (f) => !existingAssetPaths.has(normalizeAssetPath(f.relativePath))
    )
    console.log(`[NetworkVaultSync] 发现 ${newFilePaths.length} 个新文件`)

    // 🔧 安全检查：如果有目录读取失败，不做删除操作（避免网络抖动导致误删）
    let deletedAssets: NetworkVaultAsset[] = []
    if (scanResult.failedDirs > 0) {
      console.warn(
        `[NetworkVaultSync] ⚠️ 安全保护：${scanResult.failedDirs} 个目录读取失败，跳过删除检测（防止误删）`
      )
      console.warn(`[NetworkVaultSync] 失败目录:`, scanResult.failedDirPaths.slice(0, 20))
    } else {
      const candidateDeletedAssets = manifest.assets.filter(
        (asset) => !scannedPaths.has(normalizeAssetPath(asset.path))
      )
      // 🔧 安全阈值：如果删除比例超过 50% 且删除数量 > 10，视为异常，拒绝删除
      const deleteRatio =
        manifest.assets.length > 0 ? candidateDeletedAssets.length / manifest.assets.length : 0
      if (deleteRatio > 0.5 && candidateDeletedAssets.length > 10) {
        console.error(
          `[NetworkVaultSync] ⚠️ 安全阈值触发！要删除 ${candidateDeletedAssets.length}/${manifest.assets.length} 个资产 (${(deleteRatio * 100).toFixed(1)}%)，超过 50% 阈值，拒绝删除`
        )
        console.error(
          `[NetworkVaultSync] 这通常表示网络连接不稳定导致部分目录未能读取。请检查网络连接后重试。`
        )
      } else {
        deletedAssets = candidateDeletedAssets
      }
    }
    console.log(`[NetworkVaultSync] 发现 ${deletedAssets.length} 个已删除文件`)

    // 🔧 诊断：如果新文件和已删除都为 0 但数量不匹配，输出详细差异
    if (
      newFilePaths.length === 0 &&
      deletedAssets.length === 0 &&
      allFilePaths.length !== existingAssetPaths.size
    ) {
      console.warn(
        `[NetworkVaultSync] ⚠️ 诊断: 扫描 ${allFilePaths.length} 文件 vs manifest ${existingAssetPaths.size} 唯一路径，差异 ${allFilePaths.length - existingAssetPaths.size} 但无新增/删除`
      )
      // 检查扫描到的路径中是否有重复
      if (scannedPaths.size !== allFilePaths.length) {
        console.warn(
          `[NetworkVaultSync]   扫描路径也有重复: ${allFilePaths.length} 总数 vs ${scannedPaths.size} 唯一路径`
        )
      }
    }

    // 检测已删除的文件夹
    // 🔧 安全检查：如果有目录读取失败，也跳过文件夹删除检测
    const deletedFolders: NetworkVaultFolder[] = []
    const manifestFolderMap = new Map(manifest.folders.map((f) => [f.key, f]))
    const buildFolderPhysicalPath = (f: NetworkVaultFolder): string => {
      if (!f.parent || f.parent === 'ALL') return f.name
      const parent = manifestFolderMap.get(f.parent)
      return parent ? `${buildFolderPhysicalPath(parent)}/${f.name}` : f.name
    }

    if (scanResult.failedDirs > 0) {
      console.warn(`[NetworkVaultSync] ⚠️ 安全保护：有目录读取失败，跳过文件夹删除检测`)
    } else {
      for (const folder of manifest.folders) {
        const relativePath = buildFolderPhysicalPath(folder)
        const folderFullPath = join(networkPath, relativePath)
        if (!existsSync(folderFullPath)) {
          deletedFolders.push(folder)
        }
      }
    }

    // 🔧 修复：检测缺失的文件夹（从所有扫描到的文件路径推断，而不仅是新文件）
    // 构建已有文件夹的路径映射（同时包含 manifest 和 pending journals 中的文件夹）
    // 防止多台电脑同时扫描时产生重复文件夹
    const folderPathToKey = new Map<string, string>()
    const folderKeyToFolder = new Map(manifest.folders.map((f) => [f.key, f]))

    // 🚀 内存优化：优先使用 unifiedSync 透传的 journal 条目，避免重复读取网络磁盘
    let journalFoldersEntries: JournalEntry[]
    if (passedJournalEntries) {
      journalFoldersEntries = passedJournalEntries
    } else {
      const { entries } = await this.readAllJournals(networkPath)
      journalFoldersEntries = entries
    }
    const journalFolders: NetworkVaultFolder[] = []
    for (const entry of journalFoldersEntries) {
      if (entry.op === 'add_folder' && entry.data) {
        const folder = entry.data as NetworkVaultFolder
        if (folder.key && folder.name) {
          folderKeyToFolder.set(folder.key, folder)
          journalFolders.push(folder)
        }
      }
    }

    const buildFolderPath = (folder: NetworkVaultFolder): string => {
      if (!folder.parent || folder.parent === 'ALL') return folder.name
      const parentFolder = folderKeyToFolder.get(folder.parent)
      return parentFolder ? `${buildFolderPath(parentFolder)}/${folder.name}` : folder.name
    }

    // 先添加 manifest 中的文件夹
    for (const existingFolder of manifest.folders) {
      folderPathToKey.set(buildFolderPath(existingFolder), existingFolder.key)
    }

    // 再添加 pending journals 中的文件夹（如果路径不存在才添加，避免覆盖已 compact 的条目）
    for (const journalFolder of journalFolders) {
      const path = buildFolderPath(journalFolder)
      if (!folderPathToKey.has(path)) {
        folderPathToKey.set(path, journalFolder.key)
        console.log(`[NetworkVaultSync] 从 Journal 读取文件夹: ${path} -> ${journalFolder.key}`)
      }
    }

    // 从所有扫描到的文件路径中收集发现的文件夹
    const discoveredFolderPaths = new Set<string>()
    for (const file of allFilePaths) {
      const pathParts = file.relativePath.split(/[/\\]/)
      let currentPath = ''
      for (let i = 0; i < pathParts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${pathParts[i]}` : pathParts[i]
        if (!folderPathToKey.has(currentPath)) {
          discoveredFolderPaths.add(currentPath)
        }
      }
    }

    // 创建缺失的文件夹
    const missingFolders: NetworkVaultFolder[] = []
    if (discoveredFolderPaths.size > 0) {
      const sortedFolderPaths = Array.from(discoveredFolderPaths).sort((a, b) => {
        const depthA = a.split('/').length
        const depthB = b.split('/').length
        return depthA - depthB
      })

      for (const folderPath of sortedFolderPaths) {
        const pathParts = folderPath.split('/')
        const folderName = pathParts[pathParts.length - 1]
        const parentPath = pathParts.slice(0, -1).join('/')

        const folderKey = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
        folderPathToKey.set(folderPath, folderKey)

        let parentKey = 'ALL'
        if (parentPath) {
          const parentFolderKey = folderPathToKey.get(parentPath)
          if (parentFolderKey) {
            parentKey = parentFolderKey
          }
        }

        console.log(
          `[NetworkVaultSync] 发现缺失的文件夹: ${folderName}, 路径: ${folderPath}, 父: ${parentKey}`
        )

        missingFolders.push({
          key: folderKey,
          name: folderName,
          parent: parentKey,
          createdAt: new Date().toISOString()
        })
      }

      // 写入缺失文件夹的 Journal
      if (missingFolders.length > 0) {
        console.log(`[NetworkVaultSync] 补全 ${missingFolders.length} 个缺失的文件夹`)
        await this.addFolders(networkPath, missingFolders, hostname())
      }
    }

    // 如果没有变化（包括缺失的文件夹），直接返回
    if (
      newFilePaths.length === 0 &&
      deletedAssets.length === 0 &&
      deletedFolders.length === 0 &&
      missingFolders.length === 0
    ) {
      onProgress?.(100, 100, '完成')
      return { success: true, newAssets: [], newFolders: [], deletedAssets: [], deletedFolders: [] }
    }

    // 如果只有缺失的文件夹被补全，直接返回结果
    if (newFilePaths.length === 0 && deletedAssets.length === 0 && deletedFolders.length === 0) {
      onProgress?.(100, 100, '完成')
      return {
        success: true,
        newAssets: [],
        newFolders: missingFolders,
        deletedAssets: [],
        deletedFolders: []
      }
    }

    // 🔧 修复：先收集并创建所有新文件夹，确保 folderPathToKey 映射完整
    // 这样在创建资产时可以直接使用正确的 folderKey
    const discoveredFolders = new Set<string>()
    for (const file of newFilePaths) {
      // 使用 relativePath 解析文件夹路径，与 folderPath 保持一致
      const pathParts = file.relativePath.split(/[/\\]/)
      let currentPath = ''
      for (let i = 0; i < pathParts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${pathParts[i]}` : pathParts[i]
        if (!folderPathToKey.has(currentPath)) {
          discoveredFolders.add(currentPath)
        }
      }
    }

    // 创建新文件夹（按深度排序，确保父文件夹先创建）
    const newFolders: NetworkVaultFolder[] = []
    const sortedFolderPaths = Array.from(discoveredFolders).sort((a, b) => {
      return a.split('/').length - b.split('/').length
    })

    for (const folderPath of sortedFolderPaths) {
      const pathParts = folderPath.split('/')
      const folderName = pathParts[pathParts.length - 1]
      const parentPath = pathParts.slice(0, -1).join('/')
      const folderKey = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`

      // 将新文件夹加入映射，供后续资产使用
      folderPathToKey.set(folderPath, folderKey)

      let parentKey = 'ALL'
      if (parentPath) {
        const parentFolderKey = folderPathToKey.get(parentPath)
        if (parentFolderKey) parentKey = parentFolderKey
      }

      newFolders.push({
        key: folderKey,
        name: folderName,
        parent: parentKey,
        createdAt: new Date().toISOString(),
        createdBy: hostname()
      })

      console.log(
        `[NetworkVaultSync] 创建新文件夹: ${folderName} (path: ${folderPath}, key: ${folderKey})`
      )
    }

    // 先写入新文件夹的 Journals（确保文件夹在资产之前存在）
    if (newFolders.length > 0) {
      await this.addFolders(networkPath, newFolders, hostname())
      console.log(`[NetworkVaultSync] 已写入 ${newFolders.length} 个新文件夹到 Journal`)
    }

    // 现在 folderPathToKey 映射已完整，开始解析新资产元数据
    onProgress?.(25, 100, `解析 ${newFilePaths.length} 个新文件`)
    const newAssets: NetworkVaultAsset[] = []
    const processor = new UnrealAssetProcessor()
    const pathManager = PathManager.getInstance()

    for (let i = 0; i < newFilePaths.length; i++) {
      if (abortSignal?.aborted) {
        return {
          success: false,
          newAssets: [],
          newFolders: [],
          deletedAssets: [],
          deletedFolders: [],
          error: '扫描已取消'
        }
      }

      const { fullPath, relativePath, folderPath } = newFilePaths[i]
      const ext = extname(fullPath).toLowerCase()
      const assetName = basename(fullPath, ext)

      const progress = 25 + Math.floor((i / newFilePaths.length) * 50)
      onProgress?.(progress, 100, `解析: ${assetName}`)

      try {
        const assetKey = `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        let className = 'Unknown'
        let thumbnail: string | undefined
        let metadata: Record<string, unknown> = {}

        // 解析 Unreal 资产和生成缩略图
        if (ext === '.uasset' || ext === '.umap') {
          const parsed = await processor.processFile(fullPath)
          className = parsed.assetType || (ext === '.umap' ? 'World' : 'Unknown')
          metadata = parsed.metadata || {}

          // 保存缩略图到网络共享目录
          if (parsed.metadata?.imgLocalPath) {
            const thumbFileName = parsed.metadata.imgLocalPath as string
            // 🔧 修复：使用 getThumbnailFilePath（对于网络库返回 networkPath/.thumbnails）
            const localThumbPath = pathManager.getThumbnailFilePath(thumbFileName)

            // 等待缩略图文件存在
            let retries = 5
            while (retries > 0 && !existsSync(localThumbPath)) {
              await new Promise((resolve) => setTimeout(resolve, 100))
              retries--
            }

            if (existsSync(localThumbPath)) {
              const thumbName = await this.saveThumbnailToNetwork(networkPath, localThumbPath)
              thumbnail = thumbName
            }
          }
        }

        // 🔧 修复：直接使用 folderPathToKey 获取正确的 folderKey
        // 此时映射已包含所有新创建的文件夹
        let assetFolderKey = 'ALL'
        if (folderPath && folderPath !== 'ALL') {
          const key = folderPathToKey.get(folderPath)
          if (key) {
            assetFolderKey = key
          } else {
            console.warn(`[NetworkVaultSync] 未找到文件夹映射: ${folderPath}，使用 ALL`)
          }
        }

        const stats = await fs.stat(fullPath)
        newAssets.push({
          key: assetKey,
          name: assetName,
          path: relativePath,
          folder: assetFolderKey, // 直接使用 folderKey
          className,
          createdAt: new Date().toISOString(),
          createdBy: hostname(),
          size: Number(stats.size),
          thumbnail,
          metadata
        })

        console.log(`[NetworkVaultSync] 解析新资产: ${relativePath}, folderKey: ${assetFolderKey}`)
      } catch (error) {
        console.warn(`[NetworkVaultSync] 处理文件失败: ${fullPath}`, error)
      }
    }

    console.log(
      `[NetworkVaultSync] 统一同步发现: ${newAssets.length} 个新资产, ${newFolders.length} 个新文件夹, ${missingFolders.length} 个补全文件夹, ${deletedAssets.length} 个已删除`
    )

    // 写入资产 Journals（文件夹已在早期阶段写入，无需重复写入）
    onProgress?.(80, 100, '写入索引')

    // 写入资产
    if (newAssets.length > 0) {
      await this.addAssets(networkPath, newAssets, hostname())
    }

    // 记录删除
    if (deletedAssets.length > 0) {
      console.log(`[NetworkVaultSync] 检测到 ${deletedAssets.length} 个已删除的资产`)
      for (const asset of deletedAssets) {
        await this.writeJournal(networkPath, 'delete_asset', asset.key, {})
      }
    }

    if (deletedFolders.length > 0) {
      console.log(`[NetworkVaultSync] 检测到 ${deletedFolders.length} 个已删除的文件夹`)
      for (const folder of deletedFolders) {
        await this.writeJournal(networkPath, 'delete_folder', folder.key, {})
      }
    }

    // 如果有任何变更，立即执行 Compaction 以确保 manifest 实时更新
    // 🔧 修复：此方法由 unifiedSync 调用，外层已持有锁，直接执行 compaction 无需再获取锁
    if (
      newAssets.length > 0 ||
      newFolders.length > 0 ||
      deletedAssets.length > 0 ||
      deletedFolders.length > 0
    ) {
      console.log('[NetworkVaultSync] 同步完成，立即执行 Compaction（复用外层锁）')
      await this.compactJournals(networkPath)
    }

    // 🔧 修复：将 missingFolders 合并到 newFolders 中，确保补全的文件夹能被同步到本地 SQLite
    const allNewFolders = [...missingFolders, ...newFolders]

    return { success: true, newAssets, newFolders: allNewFolders, deletedAssets, deletedFolders }
  }

  /**
   * 增量扫描 - 检测网络路径中新增的文件
   * 对比物理文件与 manifest 记录，只处理新增的文件
   * 用于检测通过 Windows 资源管理器等外部方式添加的文件
   *
   * 注意：此方法现在内部调用 unifiedSync，保留是为了向后兼容
   */
  async incrementalScan(
    networkPath: string,
    options: {
      onProgress?: (current: number, total: number, phase: string) => void
      abortSignal?: { aborted: boolean }
    } = {}
  ): Promise<{
    success: boolean
    newAssets: NetworkVaultAsset[]
    newFolders: NetworkVaultFolder[]
    deletedAssets: NetworkVaultAsset[]
    deletedFolders: NetworkVaultFolder[]
    error?: string
  }> {
    const { onProgress, abortSignal } = options

    console.log(`[NetworkVaultSync] 开始增量扫描: ${networkPath}`)

    try {
      // 1. 读取当前 manifest（含 Journal，确保只读客户端也能看到删除操作）
      onProgress?.(0, 100, '读取索引文件')
      let manifest = await this.getFullManifest(networkPath)
      if (!manifest) {
        console.log('[NetworkVaultSync] Manifest 不存在，创建新的空 manifest')
        // 创建新的空 manifest
        const newManifest: NetworkVaultManifest = {
          name: 'Network Vault',
          version: 1,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          modifiedBy: hostname(),
          assets: [],
          folders: []
        }
        const writeResult = await this.writeManifest(networkPath, newManifest)
        if (!writeResult.success) {
          return {
            success: false,
            newAssets: [],
            newFolders: [],
            deletedAssets: [],
            deletedFolders: [],
            error: '无法创建 manifest'
          }
        }
        manifest = newManifest
      }

      // 2. 构建已存在路径集合（用于快速查找）
      // 🔧 修复幽灵资产：对路径进行归一化（小写 + 正斜杠），避免 UNC 路径大小写不一致导致误判
      const normalizeAssetPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
      const existingAssetPaths = new Set(manifest.assets.map((a) => normalizeAssetPath(a.path)))

      // 3. 快速扫描文件路径（不解析元数据）
      onProgress?.(5, 100, '扫描文件系统')
      const scanResult = await this.scanFilePaths(networkPath, abortSignal)
      const allFilePaths = scanResult.files

      if (abortSignal?.aborted) {
        return {
          success: false,
          newAssets: [],
          newFolders: [],
          deletedAssets: [],
          deletedFolders: [],
          error: '扫描已取消'
        }
      }

      console.log(
        `[NetworkVaultSync] 扫描到 ${allFilePaths.length} 个文件 (失败目录: ${scanResult.failedDirs})`
      )

      // 4. 检测新增和删除的资产
      const scannedPaths = new Set(allFilePaths.map((f) => normalizeAssetPath(f.relativePath)))

      // 4.1 新增的文件（物理存在但 manifest 没有）
      const newFilePaths = allFilePaths.filter(
        (f) => !existingAssetPaths.has(normalizeAssetPath(f.relativePath))
      )
      console.log(`[NetworkVaultSync] 发现 ${newFilePaths.length} 个新文件`)

      // 4.2 删除的资产（manifest 有但物理不存在）
      // 🔧 安全检查：如果有目录读取失败，不做删除操作（避免网络抖动导致误删）
      let deletedAssets: NetworkVaultAsset[] = []
      if (scanResult.failedDirs > 0) {
        console.warn(
          `[NetworkVaultSync] ⚠️ 安全保护（增量扫描）：${scanResult.failedDirs} 个目录读取失败，跳过删除检测`
        )
        console.warn(`[NetworkVaultSync] 失败目录:`, scanResult.failedDirPaths.slice(0, 20))
      } else {
        deletedAssets = manifest.assets.filter(
          (asset) => !scannedPaths.has(normalizeAssetPath(asset.path))
        )
      }
      console.log(`[NetworkVaultSync] 发现 ${deletedAssets.length} 个已删除文件`)

      // 4.3 删除的文件夹（manifest 有但物理路径不存在）
      const deletedFolders: NetworkVaultFolder[] = []
      // 构建 key 到 folder 的映射（循环外创建一次）
      const manifestFolderMap = new Map(manifest.folders.map((f) => [f.key, f]))
      const buildFolderPhysicalPath = (f: NetworkVaultFolder): string => {
        if (!f.parent || f.parent === 'ALL') return f.name
        const parent = manifestFolderMap.get(f.parent)
        return parent ? `${buildFolderPhysicalPath(parent)}/${f.name}` : f.name
      }

      if (scanResult.failedDirs > 0) {
        console.warn(
          `[NetworkVaultSync] ⚠️ 安全保护（增量扫描）：有目录读取失败，跳过文件夹删除检测`
        )
      } else {
        for (const folder of manifest.folders) {
          const relativePath = buildFolderPhysicalPath(folder)
          const folderFullPath = join(networkPath, relativePath)
          const exists = existsSync(folderFullPath)
          console.log(
            `[NetworkVaultSync] 检查文件夹: ${folder.name} (${relativePath}) -> ${folderFullPath}, 存在: ${exists}`
          )
          if (!exists) {
            deletedFolders.push(folder)
            console.log(`[NetworkVaultSync] 标记删除文件夹: ${folder.name}`)
          }
        }
      }
      console.log(`[NetworkVaultSync] 发现 ${deletedFolders.length} 个已删除文件夹`)

      // 如果没有变化，直接返回
      if (newFilePaths.length === 0 && deletedAssets.length === 0 && deletedFolders.length === 0) {
        onProgress?.(100, 100, '完成')
        return {
          success: true,
          newAssets: [],
          newFolders: [],
          deletedAssets: [],
          deletedFolders: []
        }
      }

      // 5. 只对新文件解析元数据
      onProgress?.(20, 100, `解析 ${newFilePaths.length} 个新文件`)
      const newAssets: NetworkVaultAsset[] = []
      const processor = new UnrealAssetProcessor()
      const pathManager = PathManager.getInstance()

      for (let i = 0; i < newFilePaths.length; i++) {
        if (abortSignal?.aborted) {
          return {
            success: false,
            newAssets: [],
            newFolders: [],
            deletedAssets: [],
            deletedFolders: [],
            error: '扫描已取消'
          }
        }

        const { fullPath, relativePath, folderPath } = newFilePaths[i]
        const ext = extname(fullPath).toLowerCase()
        const assetName = basename(fullPath, ext)

        const progress = 20 + Math.floor((i / newFilePaths.length) * 60)
        onProgress?.(progress, 100, `解析: ${assetName}`)

        try {
          const stats = await fs.stat(fullPath)

          const asset: NetworkVaultAsset = {
            key: `asset_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            folder: folderPath,
            name: assetName,
            path: relativePath,
            size: stats.size,
            createdAt: new Date().toISOString()
          }

          // 解析元数据（仅 .uasset 和 .umap）
          if (ext === '.uasset' || ext === '.umap') {
            try {
              console.log(`[NetworkVaultSync] 解析新资产: ${relativePath}`)
              const parsed = await processor.processFile(fullPath)
              asset.className = parsed.assetType || undefined
              asset.engineVersion = parsed.engineVersion || undefined

              // 处理缩略图
              if (parsed.metadata?.imgLocalPath) {
                const thumbFileName = parsed.metadata.imgLocalPath as string
                const localThumbPath = pathManager.getPublicThumbnailFilePath(thumbFileName)

                // 检查缩略图文件是否存在
                try {
                  await fs.access(localThumbPath)
                  const networkThumbDir = join(networkPath, THUMBNAILS_DIR)
                  await fs.mkdir(networkThumbDir, { recursive: true })
                  const networkThumbPath = join(networkThumbDir, thumbFileName)
                  await fs.copyFile(localThumbPath, networkThumbPath)
                  asset.thumbnail = thumbFileName
                } catch {
                  // 缩略图文件不存在，跳过
                }
              }
            } catch (parseError) {
              console.warn(`[NetworkVaultSync] 解析失败: ${relativePath}`, parseError)
            }
          }
          // 注：图片缩略图在首次同步时生成，增量扫描暂不处理

          newAssets.push(asset)
        } catch (error) {
          console.warn(`[NetworkVaultSync] 处理文件失败: ${fullPath}`, error)
        }
      }

      // 6. 首先构建已有文件夹的路径到key映射（用于检查文件夹是否已存在）
      // 🔧 FIX: 同时读取 pending journals 中的文件夹，防止多客户端并发扫描时产生重复文件夹
      const folderPathToKey = new Map<string, string>()
      const folderKeyToFolder = new Map(manifest.folders.map((f) => [f.key, f]))

      // 读取 pending journals 中的 add_folder 条目
      const { entries: journalEntries } = await this.readAllJournals(networkPath)
      const journalFolders: NetworkVaultFolder[] = []
      for (const entry of journalEntries) {
        if (entry.op === 'add_folder' && entry.data) {
          const folder = entry.data as NetworkVaultFolder
          if (folder.key && folder.name) {
            folderKeyToFolder.set(folder.key, folder)
            journalFolders.push(folder)
          }
        }
      }

      const buildFolderPath = (folder: NetworkVaultFolder): string => {
        if (!folder.parent || folder.parent === 'ALL') {
          return folder.name
        }
        const parentFolder = folderKeyToFolder.get(folder.parent)
        if (parentFolder) {
          return `${buildFolderPath(parentFolder)}/${folder.name}`
        }
        return folder.name
      }

      // 先添加 manifest 中的文件夹
      for (const existingFolder of manifest.folders) {
        const fullPath = buildFolderPath(existingFolder)
        folderPathToKey.set(fullPath, existingFolder.key)
        console.log(`[NetworkVaultSync] 已有文件夹映射: ${fullPath} -> ${existingFolder.key}`)
      }

      // 再添加 pending journals 中的文件夹
      for (const journalFolder of journalFolders) {
        const path = buildFolderPath(journalFolder)
        if (!folderPathToKey.has(path)) {
          folderPathToKey.set(path, journalFolder.key)
          console.log(`[NetworkVaultSync] 从 Journal 读取文件夹: ${path} -> ${journalFolder.key}`)
        }
      }

      // 7. 收集新增的文件夹（使用 folderPathToKey 来检查是否已存在）
      const discoveredFolders = new Set<string>()
      for (const asset of newAssets) {
        const pathParts = asset.path.split(/[/\\]/)
        let currentPath = ''
        for (let i = 0; i < pathParts.length - 1; i++) {
          currentPath = currentPath ? `${currentPath}/${pathParts[i]}` : pathParts[i]
          // 使用路径映射来检查文件夹是否已存在，而不是检查 key 模式
          if (!folderPathToKey.has(currentPath)) {
            discoveredFolders.add(currentPath)
          }
        }
      }

      // 8. 创建新文件夹对象
      const newFolders: NetworkVaultFolder[] = []
      const sortedFolderPaths = Array.from(discoveredFolders).sort((a, b) => {
        const depthA = a.split('/').length
        const depthB = b.split('/').length
        return depthA - depthB
      })

      for (const folderPath of sortedFolderPaths) {
        const pathParts = folderPath.split('/')
        const folderName = pathParts[pathParts.length - 1]
        const parentPath = pathParts.slice(0, -1).join('/')

        // 生成新文件夹的 key
        const folderKey = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`

        console.log(
          `[NetworkVaultSync] 创建新文件夹: ${folderName}, 完整路径: ${folderPath}, 父路径: ${parentPath || '(根目录)'}`
        )

        // 记录路径到key的映射
        folderPathToKey.set(folderPath, folderKey)
        console.log(`[NetworkVaultSync] 新建映射: ${folderPath} -> ${folderKey}`)

        // 找到父文件夹的key
        let parentKey = 'ALL'
        if (parentPath) {
          const parentFolderKey = folderPathToKey.get(parentPath)
          console.log(
            `[NetworkVaultSync] 查找父文件夹: ${parentPath} -> ${parentFolderKey || '未找到'}`
          )
          if (parentFolderKey) {
            parentKey = parentFolderKey
          } else {
            console.warn(
              `[NetworkVaultSync] ⚠️ 找不到父文件夹 key: ${parentPath}, 当前映射表:`,
              Array.from(folderPathToKey.keys())
            )
          }
        }

        console.log(`[NetworkVaultSync] 最终父文件夹: ${parentKey}`)

        newFolders.push({
          key: folderKey,
          name: folderName,
          parent: parentKey,
          createdAt: new Date().toISOString()
        })
      }

      // 8. 更新资产的 folder 字段为正确的 folder key
      for (const asset of newAssets) {
        if (asset.folder && asset.folder !== 'ALL') {
          const folderKey = folderPathToKey.get(asset.folder)
          if (folderKey) {
            asset.folder = folderKey
          } else {
            // 如果找不到对应的文件夹key，放到 ALL
            console.warn(`[NetworkVaultSync] 找不到文件夹key: ${asset.folder}，资产放入 ALL`)
            asset.folder = 'ALL'
          }
        }
      }

      console.log(
        `[NetworkVaultSync] 增量扫描发现: ${newAssets.length} 个新资产, ${newFolders.length} 个新文件夹, ${deletedAssets.length} 个已删除`
      )

      // 如果只有删除的资产/文件夹，也需要处理
      if (
        newAssets.length === 0 &&
        newFolders.length === 0 &&
        deletedAssets.length === 0 &&
        deletedFolders.length === 0
      ) {
        return {
          success: true,
          newAssets: [],
          newFolders: [],
          deletedAssets: [],
          deletedFolders: []
        }
      }

      // 8. 写入 Journal
      onProgress?.(85, 100, '写入索引')

      if (newFolders.length > 0) {
        const folderResult = await this.addFolders(networkPath, newFolders, hostname())
        if (!folderResult.success) {
          console.warn(`[NetworkVaultSync] 写入文件夹失败:`, folderResult.error)
        }
      }

      if (newAssets.length > 0) {
        const assetResult = await this.addAssets(networkPath, newAssets, hostname())
        if (!assetResult.success) {
          console.warn(`[NetworkVaultSync] 写入资产失败:`, assetResult.error)
        }
      }

      // 9. 记录删除的资产（暂时只记录日志，不从 manifest 删除）
      // TODO: 考虑是否需要从 manifest 中移除这些资产
      if (deletedAssets.length > 0) {
        console.log(`[NetworkVaultSync] 检测到 ${deletedAssets.length} 个已删除的资产:`)
        for (const asset of deletedAssets) {
          console.log(`  - ${asset.name} (${asset.path})`)
        }
      }

      onProgress?.(100, 100, '完成')

      return {
        success: true,
        newAssets,
        newFolders,
        deletedAssets,
        deletedFolders
      }
    } catch (error) {
      console.error(`[NetworkVaultSync] 增量扫描失败:`, error)
      return {
        success: false,
        newAssets: [],
        newFolders: [],
        deletedAssets: [],
        deletedFolders: [],
        error: (error as Error).message
      }
    }
  }

  /**
   * 快速扫描文件路径（不解析元数据）
   * 返回文件列表和失败目录数（用于安全检查）
   */
  private async scanFilePaths(
    networkPath: string,
    abortSignal?: { aborted: boolean }
  ): Promise<{
    files: { fullPath: string; relativePath: string; folderPath: string }[]
    failedDirs: number
    failedDirPaths: string[]
  }> {
    const excludeDirs = SCAN_EXCLUDE_DIRS

    const filePaths: { fullPath: string; relativePath: string; folderPath: string }[] = []
    let skippedDirs = 0
    let failedDirs = 0
    const failedDirPaths: string[] = []

    const collectFiles = async (dir: string, folderPath: string): Promise<void> => {
      if (abortSignal?.aborted) return
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (abortSignal?.aborted) return
          const fullPath = join(dir, entry.name)
          const relativePath = relative(networkPath, fullPath).replace(/\\/g, '/')

          if (entry.isDirectory()) {
            if (!excludeDirs.includes(entry.name)) {
              const childFolderPath = folderPath ? `${folderPath}/${entry.name}` : entry.name
              await collectFiles(fullPath, childFolderPath)
            } else {
              skippedDirs++
            }
          } else if (entry.isFile()) {
            // 排除系统文件（index.json），其余全部纳入清单
            if (!SCAN_EXCLUDE_FILES.includes(entry.name)) {
              filePaths.push({ fullPath, relativePath, folderPath: folderPath || 'ALL' })
            }
          }
        }
      } catch (error) {
        failedDirs++
        failedDirPaths.push(dir)
        console.warn(`[NetworkVaultSync] 扫描目录失败: ${dir}`, error)
      }
    }

    await collectFiles(networkPath, '')
    console.log(
      `[NetworkVaultSync] scanFilePaths 统计: ${filePaths.length} 文件, ${skippedDirs} 跳过(排除目录), ${failedDirs} 失败目录`
    )
    if (failedDirs > 0) {
      console.warn(
        `[NetworkVaultSync] ⚠️ ${failedDirs} 个目录读取失败:`,
        failedDirPaths.slice(0, 10)
      )
    }
    return { files: filePaths, failedDirs, failedDirPaths }
  }

  /**
   * 将资产添加到 manifest (V2: 使用 Journal 增量写入)
   * 增加基于路径的去重，防止重复扫描时产生重复资产
   */
  async addAssets(
    networkPath: string,
    assets: NetworkVaultAsset[],
    modifiedBy: string,
    _expectedVersion?: number,
    /** 🚀 OOM优化: 调用方可传入预构建的去重集合，避免内部重新解析 256MB manifest */
    existingDedupData?: { keys: Set<string>; paths: Set<string> }
  ): Promise<SyncResult> {
    try {
      // 过滤已存在的资产（按 key 和 path 双重去重）
      let existingKeys: Set<string>
      let existingPaths: Set<string>

      if (existingDedupData) {
        // 🚀 使用调用方提供的去重集合（已包含 manifest 数据），跳过 readManifest
        existingKeys = new Set(existingDedupData.keys)
        existingPaths = new Set(existingDedupData.paths)
      } else {
        // 回退: 读取 manifest（兼容其他调用方）
        const manifest = await this.readManifest(networkPath)
        existingKeys = manifest ? new Set(manifest.assets.map((a) => a.key)) : new Set<string>()
        existingPaths = manifest ? new Set(manifest.assets.map((a) => a.path)) : new Set<string>()
      }

      // 还需要检查 journals 中的资产（可能尚未压缩到 manifest）
      const { entries } = await this.readAllJournals(networkPath)
      for (const entry of entries) {
        if (entry.op === 'add_asset' && entry.data) {
          existingKeys.add(entry.targetId)
          const assetData = entry.data as NetworkVaultAsset
          if (assetData.path) {
            existingPaths.add(assetData.path)
          }
        }
      }

      const newAssets = assets.filter((a) => {
        // 如果 key 或 path 已存在，则跳过
        if (existingKeys.has(a.key)) return false
        if (existingPaths.has(a.path)) return false
        return true
      })

      if (newAssets.length === 0) {
        console.log('[NetworkVaultSync] 所有资产已存在，无需添加')
        return { success: true, added: 0 }
      }

      // V3 优化: 批量写入 Journal（1次网络I/O而非N次）
      const batchEntries = newAssets.map((asset) => ({
        op: 'add_asset' as JournalOperation,
        targetId: asset.key,
        changes: { modifiedBy },
        data: asset
      }))

      const journalResult = await this.writeBatchJournal(networkPath, batchEntries)
      if (!journalResult.success) {
        console.warn('[NetworkVaultSync] 批量写入 Journal 失败:', journalResult.error)
        return { success: false, error: journalResult.error }
      }

      // V3 优化: 移除立即 Compaction，由调用方在导入完成后统一执行
      console.log(`[NetworkVaultSync] 批量添加 ${newAssets.length} 个资产完成（延迟 Compaction）`)

      return {
        success: true,
        added: newAssets.length
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 添加文件夹到 manifest (V2: 使用 Journal 增量写入)
   * 用于初始化时保存文件夹结构
   */
  async addFolders(
    networkPath: string,
    folders: NetworkVaultFolder[],
    modifiedBy: string,
    /** 🚀 OOM优化: 调用方可传入预构建的去重集合，避免内部重新解析 256MB manifest */
    existingDedupData?: { keys: Set<string>; nameParentPairs: Set<string> }
  ): Promise<SyncResult> {
    try {
      // 过滤已存在的文件夹（按 key 去重）
      let existingKeys: Set<string>
      let existingNameParentPairs: Set<string>

      if (existingDedupData) {
        // 🚀 使用调用方提供的去重集合（已包含 manifest 数据），跳过 readManifest
        existingKeys = new Set(existingDedupData.keys)
        existingNameParentPairs = new Set(existingDedupData.nameParentPairs)
      } else {
        // 回退: 读取 manifest（兼容其他调用方）
        const manifest = await this.readManifest(networkPath)
        existingKeys = manifest ? new Set(manifest.folders.map((f) => f.key)) : new Set<string>()
        existingNameParentPairs = manifest
          ? new Set(manifest.folders.map((f) => `${f.name}::${f.parent}`))
          : new Set<string>()
      }

      // 🔧 FIX: 同时检查 Journal 中未压缩的 add_folder 条目，防止多台电脑同时同步时产生重复文件夹
      const { entries } = await this.readAllJournals(networkPath)
      for (const entry of entries) {
        if (entry.op === 'add_folder' && entry.data) {
          existingKeys.add(entry.targetId)
          const folderData = entry.data as NetworkVaultFolder
          if (folderData.name) {
            const parentKey = folderData.parent || 'ALL'
            existingNameParentPairs.add(`${folderData.name}::${parentKey}`)
          }
        }
      }

      const newFolders = folders.filter((f) => {
        if (existingKeys.has(f.key)) return false
        // 🔧 FIX: 改为 name+parent 组合去重，允许不同父级下同名文件夹
        const nameParentKey = `${f.name}::${f.parent}`
        if (existingNameParentPairs.has(nameParentKey)) return false
        return true
      })

      if (newFolders.length === 0) {
        console.log('[NetworkVaultSync] 所有文件夹已存在，无需添加')
        return { success: true, added: 0 }
      }

      // V3 优化: 批量写入 Journal（1次网络I/O而非N次）
      const batchEntries = newFolders.map((folder) => ({
        op: 'add_folder' as JournalOperation,
        targetId: folder.key,
        changes: { modifiedBy },
        data: folder
      }))

      const journalResult = await this.writeBatchJournal(networkPath, batchEntries)
      if (!journalResult.success) {
        console.warn('[NetworkVaultSync] 批量写入文件夹 Journal 失败:', journalResult.error)
        return { success: false, error: journalResult.error }
      }

      console.log(`[NetworkVaultSync] 批量添加 ${newFolders.length} 个文件夹完成`)
      return { success: true, added: newFolders.length }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 更新资产元数据
   * V2: 使用 Journal 增量写入
   */
  async updateAsset(
    networkPath: string,
    assetKey: string,
    updates: Partial<NetworkVaultAsset>,
    modifiedBy: string,
    // 保留形参以维持调用方签名，乐观锁版本校验尚未启用
    _expectedVersion?: number
  ): Promise<SyncResult> {
    void _expectedVersion
    try {
      // 验证资产存在
      // 🔧 修复：使用 getFullManifest 代替 readManifest，确保能找到通过 Journal 添加但未 compact 的资产
      // 否则 updateAsset 会静默返回 '资产不存在'，导致缩略图等元数据更新丢失
      const manifest = await this.getFullManifest(networkPath)
      if (!manifest) {
        return { success: false, error: 'manifest 不存在' }
      }

      const existingAsset = manifest.assets.find((a) => a.key === assetKey)
      if (!existingAsset) {
        return { success: false, error: '资产不存在' }
      }

      // V2: 写入 Journal 条目而不是直接修改 Manifest
      const updatedAsset: NetworkVaultAsset = {
        ...existingAsset,
        ...updates,
        modifiedBy,
        modifiedAt: new Date().toISOString()
      }

      const journalResult = await this.writeJournal(
        networkPath,
        'update_asset',
        assetKey,
        { modifiedBy },
        updatedAsset
      )

      if (!journalResult.success) {
        return { success: false, error: journalResult.error || '写入 Journal 失败' }
      }

      // 立即执行 Compaction 以确保 manifest 实时更新
      console.log('[NetworkVaultSync] 资产更新完成，立即执行 Compaction')
      const lockResult = await this.acquireLock(networkPath)
      if (lockResult.acquired) {
        try {
          await this.compactJournals(networkPath)
        } finally {
          await this.releaseLock(networkPath)
        }
      }

      return { success: true, updated: 1 }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 通过 assetKey 或 path 更新资产元数据
   * 🔧 修复：支持 key 和 path 双重匹配，解决本地 assetKey 与网络 manifest key 格式不一致的问题
   */
  async updateAssetByPath(
    networkPath: string,
    assetKey: string,
    assetPath: string,
    updates: Partial<NetworkVaultAsset>,
    modifiedBy: string,
    // 保留形参以维持调用方签名，乐观锁版本校验尚未启用
    _expectedVersion?: number
  ): Promise<SyncResult> {
    void _expectedVersion
    try {
      // 验证 manifest 存在
      const manifest = await this.readManifest(networkPath)
      if (!manifest) {
        return { success: false, error: 'manifest 不存在' }
      }

      // 🔧 先尝试通过 key 匹配
      let existingAsset = manifest.assets.find((a) => a.key === assetKey)

      // 🔧 如果 key 匹配失败，尝试通过 path 匹配
      if (!existingAsset && assetPath) {
        // 规范化路径分隔符用于对比
        const normalizedAssetPath = assetPath.replace(/\\/g, '/')
        existingAsset = manifest.assets.find((a) => {
          const normalizedManifestPath = a.path?.replace(/\\/g, '/')
          return normalizedManifestPath === normalizedAssetPath
        })

        if (existingAsset) {
          console.log(
            `[NetworkVaultSync] 通过 path 匹配到资产: ${assetPath} -> ${existingAsset.key}`
          )
        }
      }

      if (!existingAsset) {
        console.warn(`[NetworkVaultSync] 无法找到资产: key=${assetKey}, path=${assetPath}`)
        return { success: false, error: '资产不存在（key 和 path 均未匹配）' }
      }

      // 使用匹配到的实际 key 进行更新
      const actualKey = existingAsset.key

      // 写入 Journal 条目
      const updatedAsset: NetworkVaultAsset = {
        ...existingAsset,
        ...updates,
        modifiedBy,
        modifiedAt: new Date().toISOString()
      }

      const journalResult = await this.writeJournal(
        networkPath,
        'update_asset',
        actualKey,
        { modifiedBy },
        updatedAsset
      )

      if (!journalResult.success) {
        return { success: false, error: journalResult.error || '写入 Journal 失败' }
      }

      // 立即执行 Compaction 以确保 manifest 实时更新
      console.log('[NetworkVaultSync] 资产更新完成（通过 path 匹配），立即执行 Compaction')
      const lockResult = await this.acquireLock(networkPath)
      if (lockResult.acquired) {
        try {
          await this.compactJournals(networkPath)
        } finally {
          await this.releaseLock(networkPath)
        }
      }

      return { success: true, updated: 1 }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 添加文件夹
   * 🔧 修复：委托给 addFolders 走 Journal 系统，避免直接修改 manifest 导致多设备同步冲突
   */
  async addFolder(
    networkPath: string,
    folder: NetworkVaultFolder,
    modifiedBy: string,
    // 保留形参以维持调用方签名，乐观锁版本校验尚未启用
    _expectedVersion?: number
  ): Promise<SyncResult> {
    void _expectedVersion
    return this.addFolders(networkPath, [folder], modifiedBy)
  }

  /**
   * 获取缓存的 manifest
   */
  getCachedManifest(networkPath: string): NetworkVaultManifest | null {
    const cached = this.localManifestCache.get(networkPath)
    return cached?.manifest || null
  }
}

// 导出单例获取函数
export const getNetworkVaultSync = (): NetworkVaultSync => {
  return NetworkVaultSync.getInstance()
}
