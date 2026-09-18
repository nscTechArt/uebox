import { ipcMain, app } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { PathManager } from '../utils/PathManager'
import { AssetImportManager } from '../utils/assetDependency'
import { getDatabaseManager } from '../sqliteDataBase'
import { VaultServiceManager } from '../networkV2/VaultServiceManager'
import { applyReadFileLimits } from './readFileLimits'
import { startNativeFileDrag } from './nativeFileDrag'
import { classifyDroppedPath, isAbsoluteNativePath } from '../../shared/droppedPath'

function getV2Context(): { networkV2Role: 'server' | 'client' | 'none'; networkV2VaultId: string } {
  try {
    const manager = getDatabaseManager()
    const currentVault = manager.getCurrentVault()
    if (currentVault && currentVault.vaultType === 'network') {
      const vsm = VaultServiceManager.getInstance()
      const role = vsm.getRole(currentVault.id)
      if (role !== 'none') {
        return { networkV2Role: role, networkV2VaultId: currentVault.id }
      }
    }
  } catch {
    // ignore
  }
  return { networkV2Role: 'none', networkV2VaultId: '' }
}

function resolveImportStorageConfig(
  currentVault: ReturnType<ReturnType<typeof getDatabaseManager>['getCurrentVault']>
) {
  if (!currentVault) {
    return {
      storageMode: 'none' as const,
      vaultPath: '',
      remoteVaultUrl: ''
    }
  }

  if (currentVault.vaultType === 'backup') {
    return {
      storageMode: 'local-copy' as const,
      vaultPath: currentVault.path,
      remoteVaultUrl: ''
    }
  }

  if (currentVault.vaultType === 'network') {
    if (
      currentVault.networkPath?.startsWith('http://') ||
      currentVault.networkPath?.startsWith('https://')
    ) {
      return {
        storageMode: 'remote-http' as const,
        vaultPath: '',
        remoteVaultUrl: currentVault.networkPath
      }
    }

    if (currentVault.networkPath) {
      return {
        storageMode: 'local-copy' as const,
        vaultPath: currentVault.networkPath,
        remoteVaultUrl: ''
      }
    }
  }

  return {
    storageMode: 'none' as const,
    vaultPath: '',
    remoteVaultUrl: ''
  }
}

async function ensureRemoteClientContext(
  currentVault: ReturnType<ReturnType<typeof getDatabaseManager>['getCurrentVault']>
) {
  let v2ctx = getV2Context()
  const storage = resolveImportStorageConfig(currentVault)

  if (currentVault && storage.storageMode === 'remote-http' && v2ctx.networkV2Role === 'none') {
    try {
      const manager = getDatabaseManager()
      const retryResult = await manager.getVaultManager().retryNetworkService(currentVault.id)
      if (!retryResult.success) {
        throw new Error(retryResult.error || '重连失败')
      }
      v2ctx = getV2Context()
    } catch (error) {
      console.warn('[dragDrop] 单文件导入前远程重连失败:', error)
    }
  }

  return { v2ctx, storage }
}

/**
 * 注册拖拽相关的IPC处理函数
 */
export function registerDragDropIPC(): void {
  ipcMain.handle('fs:startNativeFileDrag', startNativeFileDrag)
  // 注意：webUtils.getPathForFile 应该在渲染进程中调用，不是在主进程
  // 这里我们移除这个处理器，因为路径获取应该在 preload 脚本中完成

  // 获取文件统计信息
  ipcMain.handle('fs:getFileStats', async (event, filePath: string) => {
    void event
    try {
      // 相对路径一律拒收。fs.stat 会拿它去拼**进程的当前工作目录**，拼出来的东西
      // 调用方从来没打算访问：开发期指向仓库目录、打包后指向安装目录。
      // 从压缩包里往外拖文件就会走到这里 —— 那时报出来的 ENOENT 指着一条
      // 用户完全看不懂的路径，比说清楚「这不是一条真路径」糟得多。
      if (!isAbsoluteNativePath(filePath)) {
        throw new Error(`不是一条完整的文件路径（可能来自压缩包内部）：${filePath}`)
      }

      const stats = await fs.stat(filePath)
      return {
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        size: stats.size,
        mtime: stats.mtime,
        ctime: stats.ctime
      }
    } catch (error) {
      console.error('获取文件统计信息失败:', error)
      throw error
    }
  })

  /**
   * 拖拽入口的路径体检：一次判完整批，让界面能给出一条人话提示，
   * 而不是让每条坏路径各自在底层炸一次。
   *
   * 判定逻辑放在 shared 里（`classifyDroppedPath`），但「系统临时目录在哪」只有
   * 主进程知道，所以这道调用必须走 IPC，不能在渲染层自己拍脑袋。
   */
  ipcMain.handle('fs:classifyDroppedPaths', async (event, filePaths: unknown) => {
    void event
    const tempDir = app.getPath('temp')
    const list = Array.isArray(filePaths) ? filePaths : []
    return list.map((item) => {
      const filePath = typeof item === 'string' ? item : ''
      return { path: filePath, verdict: classifyDroppedPath(filePath, tempDir) }
    })
  })

  // 导入单个文件
  ipcMain.handle(
    'asset:importSingleFile',
    async (event, filePath: string, targetFolderKey: string) => {
      void event
      try {
        console.log('开始导入单个文件:', filePath, '到文件夹:', targetFolderKey)

        // 获取文件信息
        const stats = await fs.stat(filePath)
        const fileName = path.basename(filePath)
        const fileExtension = path.extname(filePath)

        // 生成唯一的资产键
        const assetKey = `${targetFolderKey}_${fileName}_${Date.now()}`

        // 这里可以调用现有的资产导入逻辑
        // 暂时返回成功状态，实际实现需要根据具体的导入逻辑来完成
        const result = {
          success: true,
          assetKey,
          fileName,
          fileExtension,
          fileSize: stats.size,
          filePath,
          targetFolderKey
        }

        console.log('单个文件导入完成:', result)
        return result
      } catch (error) {
        console.error('导入单个文件失败:', error)
        throw error
      }
    }
  )

  // 读取文件内容（用于文本预览）
  ipcMain.removeHandler('asset:importSingleFile')
  ipcMain.handle(
    'asset:importSingleFile',
    async (event, filePath: string, targetFolderKey: string) => {
      void event
      try {
        console.log('开始导入单个文件:', filePath, '到文件夹:', targetFolderKey)

        const manager = getDatabaseManager()
        const currentVault = manager.getCurrentVault()
        const { v2ctx, storage } = await ensureRemoteClientContext(currentVault)
        if (storage.storageMode === 'remote-http' && v2ctx.networkV2Role === 'none') {
          throw new Error('远程资产服务器未连接，无法导入到服务器资产库，请先重连当前网络库')
        }

        const importer = new AssetImportManager({
          enableDependencyResolution: false,
          storageMode: storage.storageMode,
          vaultPath: storage.vaultPath,
          remoteVaultUrl: storage.remoteVaultUrl,
          ...v2ctx
        })

        const result = await importer.importAssets([filePath], targetFolderKey || 'ALL')
        importer.dispose()
        console.log('单个文件导入完成:', result)
        return result
      } catch (error) {
        console.error('导入单个文件失败:', error)
        throw error
      }
    }
  )

  ipcMain.handle(
    'fs:readFile',
    async (
      event,
      filePath: string,
      options?: { encoding?: BufferEncoding; maxLines?: number; maxBytes?: number }
    ) => {
      void event
      try {
        const encoding = options?.encoding || 'utf8'

        // 读取文件内容
        const content = await fs.readFile(filePath, encoding)
        return {
          success: true,
          ...applyReadFileLimits(content, options)
        }
      } catch (error) {
        console.error('读取文件失败:', error)
        return {
          success: false,
          error: (error as Error).message
        }
      }
    }
  )

  // 读取文件的二进制内容（用于上传到云端）
  ipcMain.handle('fs:readFileBuffer', async (event, filePath: string) => {
    void event
    try {
      const buffer = await fs.readFile(filePath)
      // 返回 ArrayBuffer
      return {
        success: true,
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      }
    } catch (error) {
      console.error('读取文件二进制内容失败:', error)
      return {
        success: false,
        error: (error as Error).message
      }
    }
  })

  // 写入文件
  ipcMain.handle('fs:writeFile', async (event, filePath: string, data: number[]) => {
    void event
    try {
      // 确保父目录存在
      const dir = path.dirname(filePath)
      await fs.mkdir(dir, { recursive: true })

      // 将number数组转换为Buffer
      const buffer = Buffer.from(data)

      // 写入文件
      await fs.writeFile(filePath, buffer)

      return { success: true, filePath }
    } catch (error) {
      console.error('写入文件失败:', error)
      throw error
    }
  })

  // 确保目录存在
  ipcMain.handle('fs:ensureDir', async (event, dirPath: string) => {
    void event
    try {
      await fs.mkdir(dirPath, { recursive: true })
      return { success: true, dirPath }
    } catch (error) {
      console.error('创建目录失败:', error)
      throw error
    }
  })

  // 判断文件/目录是否存在
  ipcMain.handle('fs:exists', async (event, targetPath: string) => {
    void event
    try {
      await fs.access(targetPath)
      return { success: true, exists: true }
    } catch {
      return { success: true, exists: false }
    }
  })

  // 删除本地文件（仅限临时目录，安全限制）
  ipcMain.handle('fs:deleteFile', async (event, filePath: string) => {
    void event
    try {
      // 安全检查：路径规范化，防止 .. 遍历攻击
      const normalizedPath = path.normalize(filePath)
      const tempDir = path.normalize(app.getPath('temp'))

      // 严格检查：只允许删除临时目录中的文件
      if (!normalizedPath.toLowerCase().startsWith(tempDir.toLowerCase())) {
        console.warn('[fs:deleteFile] 安全拒绝：路径不在临时目录中:', normalizedPath)
        return { success: false, error: '安全限制：只能删除临时目录中的文件' }
      }

      await fs.unlink(normalizedPath)
      console.log('[fs:deleteFile] 文件已删除:', normalizedPath)
      return { success: true }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      // 文件不存在视为成功（目标已达成）
      if (err.code === 'ENOENT') {
        console.log('[fs:deleteFile] 文件已不存在，无需删除:', filePath)
        return { success: true }
      }
      console.error('[fs:deleteFile] 删除文件失败:', error)
      return { success: false, error: err.message }
    }
  })

  // 复制文件
  ipcMain.handle('fs:copyFile', async (event, src: string, dest: string) => {
    void event
    try {
      // 确保目标目录存在
      const dir = path.dirname(dest)
      await fs.mkdir(dir, { recursive: true })

      await fs.copyFile(src, dest)
      return { success: true }
    } catch (error) {
      console.error('复制文件失败:', error)
      throw error
    }
  })

  // 复制目录（递归）
  ipcMain.handle(
    'fs:copyDir',
    async (event, src: string, dest: string, options?: { overwrite?: boolean }) => {
      void event
      try {
        const overwrite = options?.overwrite ?? false

        /**
         * 递归复制目录
         */
        const copyDir = async (srcDir: string, destDir: string): Promise<void> => {
          await fs.mkdir(destDir, { recursive: true })
          const entries = await fs.readdir(srcDir, { withFileTypes: true })

          for (const entry of entries) {
            const srcPath = path.join(srcDir, entry.name)
            const destPath = path.join(destDir, entry.name)

            if (entry.isDirectory()) {
              await copyDir(srcPath, destPath)
            } else {
              // 检查目标文件是否存在
              try {
                await fs.access(destPath)
                if (!overwrite) {
                  console.log(`跳过已存在的文件: ${destPath}`)
                  continue
                }
              } catch {
                // 文件不存在，可以复制
              }
              await fs.copyFile(srcPath, destPath)
            }
          }
        }

        // 确保目标父目录存在
        const parentDir = path.dirname(dest)
        await fs.mkdir(parentDir, { recursive: true })

        await copyDir(src, dest)
        return { success: true }
      } catch (error) {
        console.error('复制目录失败:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 获取指定路径所在磁盘的剩余空间
   * 用于导入前检查硬盘空间是否足够
   */
  ipcMain.handle('fs:getDiskSpace', async (event, targetPath: string) => {
    void event
    try {
      // 使用 Node.js 的 statfs（Node 18.15+）或 child_process 调用系统命令
      // Windows: wmic logicaldisk get freespace,size
      // 这里使用跨平台方案
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)

      // 规范化路径，获取驱动器盘符（Windows）或根路径（Unix）
      const normalizedPath = path.resolve(targetPath)
      const drive = normalizedPath.split(path.sep)[0] + path.sep // 如 "D:\"

      if (process.platform === 'win32') {
        // Windows: 使用 wmic 命令
        const driveLetter = drive.replace('\\', '').replace(':', '')
        const { stdout } = await execAsync(
          `wmic logicaldisk where "DeviceID='${driveLetter}:'" get FreeSpace,Size /format:csv`
        )
        // 解析 CSV 输出：Node,FreeSpace,Size
        const lines = stdout
          .trim()
          .split('\n')
          .filter((line) => line.trim())
        if (lines.length >= 2) {
          const values = lines[1].split(',')
          if (values.length >= 3) {
            const free = parseInt(values[1], 10)
            const total = parseInt(values[2], 10)
            if (!isNaN(free) && !isNaN(total)) {
              return { success: true, free, total }
            }
          }
        }
        return { success: false, error: '无法解析磁盘空间信息' }
      } else {
        // Unix/Mac: 使用 df 命令
        const { stdout } = await execAsync(`df -k "${normalizedPath}"`)
        const lines = stdout.trim().split('\n')
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/)
          if (parts.length >= 4) {
            const total = parseInt(parts[1], 10) * 1024 // KB 转 Bytes
            const free = parseInt(parts[3], 10) * 1024
            return { success: true, free, total }
          }
        }
        return { success: false, error: '无法解析磁盘空间信息' }
      }
    } catch (error) {
      console.error('获取磁盘空间失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取当前vault路径
  ipcMain.handle('vault:getCurrentPath', async (event) => {
    void event
    try {
      const pathManager = PathManager.getInstance()
      const vaultPath = pathManager.getCurrentVaultPath()
      return { success: true, path: vaultPath }
    } catch (error) {
      console.error('获取vault路径失败:', error)
      throw error
    }
  })

  console.log('拖拽功能 IPC 处理器注册完成')
}
