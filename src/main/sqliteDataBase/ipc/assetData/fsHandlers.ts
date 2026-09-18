import { beginAssetImport, finishAssetImport } from '../../../services/asset/importControl'
import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

import { FileProcessorManager } from '../../../utils/fileProcessor/FileProcessorManager'
import { parsePackageDirName } from '../../../utils/libraryPackage'
import type { LibraryKind } from '../../../../shared/libraryPackage'

/**
 * 扫描时一个条目算什么。
 *
 * 多出来的 `package` 是蓝图包 / 材质包（`xxx.ueblueprint` / `xxx.uematerial`）——
 * 它在磁盘上是目录，但**是一条内容，不是一层结构**：里面的 `cover.png`、
 * `textures/` 属于这个包，被当成独立资产索引就等于把一个条目拆成一堆碎片。
 *
 * 现有消费方（`AssetImportService`）严格按 `folder` / `file` 过滤，
 * 因此 `package` 会被安全忽略 —— 把它变成资产库里的一行是后面那步的事。
 */
export type ScanEntryType = 'folder' | 'file' | 'package'

export function classifyScanEntry(
  name: string,
  isDirectory: boolean
): { type: ScanEntryType; library?: LibraryKind } {
  if (!isDirectory) return { type: 'file' }

  const parsed = parsePackageDirName(name)
  if (parsed) return { type: 'package', library: parsed.library }

  return { type: 'folder' }
}

export function registerAssetFsIPC(): void {
  ipcMain.handle('fs:readFolderContents', async (_, folderPath: string) => {
    void _
    try {
      const items = await fs.readdir(folderPath, { withFileTypes: true })
      const contents = await Promise.all(
        items.map(async (item) => {
          const fullPath = join(folderPath, item.name)
          const stats = await fs.stat(fullPath)
          const classified = classifyScanEntry(item.name, item.isDirectory())
          return {
            name: item.name,
            path: fullPath,
            type: classified.type,
            library: classified.library,
            size: item.isFile() ? stats.size : null,
            modifiedTime: stats.mtime.toISOString()
          }
        })
      )
      return { success: true, data: contents }
    } catch (error) {
      console.error('读取文件夹内容失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'fs:readFolderContentsRecursive',
    async (event, folderPath: string, options?: { taskId?: string }) => {
      const taskId = options?.taskId || folderPath
      let controller: AbortController | undefined
      try {
        controller = beginAssetImport(taskId)
        const allItems: Record<string, unknown>[] = []
        let fallbackBatch: Record<string, unknown>[] | null = null
        let totalItemsEmitted = 0
        const queue: Array<{ path: string; depth: number }> = [{ path: folderPath, depth: 0 }]

        const batchSize = 300
        let pendingBatch: Record<string, unknown>[] = []
        let batchIndex = 0

        let totalFilesScanned = 0
        let totalFoldersScanned = 0
        let totalPackagesScanned = 0
        let skippedFilesCount = 0
        let skippedFoldersCount = 0
        let scannedTotalBytes = 0
        const skippedItems: Array<{ path: string; reason: string; estimatedSize?: number }> = []

        console.log(`📨 [FolderScan] 开始扫描文件夹: ${folderPath}`)

        let lastProgressTime = 0
        const progressInterval = 200

        while (queue.length > 0) {
          controller.signal.throwIfAborted()
          const { path: currentPath, depth: currentDepth } = queue.shift()!

          try {
            const items = await fs.readdir(currentPath, { withFileTypes: true })
            const itemsWithStats = await Promise.all(
              items.map(async (item) => {
                const fullPath = join(currentPath, item.name)
                try {
                  const stats = await fs.stat(fullPath)
                  return { item, fullPath, stats, isAccessible: true, error: null }
                } catch (error) {
                  return {
                    item,
                    fullPath,
                    stats: null,
                    isAccessible: false,
                    error: error as NodeJS.ErrnoException
                  }
                }
              })
            )

            const folders: Record<string, unknown>[] = []
            const files: Record<string, unknown>[] = []
            // 新增的这一路不跟着上面两个 Record<string, unknown>[] 走 —— lint 棘轮只准变小
            const packages: Array<Record<string, unknown>> = []

            for (const { item, fullPath, stats, isAccessible, error } of itemsWithStats) {
              if (!isAccessible) {
                const errorCode = error?.code || 'UNKNOWN'
                const errorMsg = error?.message || '未知错误'
                const reason = `${errorCode}: ${errorMsg}`

                if (item.isDirectory()) {
                  skippedFoldersCount++
                  skippedItems.push({ path: fullPath, reason: `[目录] ${reason}` })
                  console.warn(`⚠️ [FolderScan] 跳过目录 (无法访问): ${fullPath} - ${reason}`)
                } else {
                  skippedFilesCount++
                  skippedItems.push({ path: fullPath, reason: `[文件] ${reason}` })
                  console.warn(`⚠️ [FolderScan] 跳过文件 (无法访问): ${fullPath} - ${reason}`)
                }
                continue
              }

              const classified = classifyScanEntry(item.name, item.isDirectory())

              const fileInfo = {
                name: item.name,
                path: fullPath,
                type: classified.type,
                library: classified.library,
                size: item.isFile() ? stats!.size : null,
                modifiedTime: stats!.mtime.toISOString(),
                depth: currentDepth,
                relativePath: fullPath.replace(folderPath, '').replace(/^[\\/]/, '')
              }

              if (classified.type === 'package') {
                // 是一条内容，不是一层结构：**不往里递归**。
                // 包里的 cover.png / textures/ 属于这个包，不是独立资产。
                packages.push(fileInfo)
                totalPackagesScanned++
              } else if (item.isDirectory()) {
                folders.push(fileInfo)
                totalFoldersScanned++
                queue.push({ path: fullPath, depth: currentDepth + 1 })
              } else {
                files.push(fileInfo)
                totalFilesScanned++
                scannedTotalBytes += stats!.size
              }
            }

            allItems.push(...folders, ...files, ...packages)
            pendingBatch.push(...folders, ...files, ...packages)

            if (pendingBatch.length >= batchSize) {
              batchIndex++
              try {
                event.sender.send('fs:scanBatch', {
                  taskId,
                  batchIndex,
                  items: pendingBatch,
                  isComplete: false
                })
                totalItemsEmitted += pendingBatch.length
              } catch {
                fallbackBatch = [...pendingBatch]
              }
              pendingBatch = []
            }

            const now = Date.now()
            if (now - lastProgressTime > progressInterval) {
              lastProgressTime = now
              try {
                event.sender.send('fs:scanProgress', {
                  taskId,
                  scannedCount: totalFilesScanned + totalFoldersScanned,
                  stage: 'scanning'
                })
              } catch {
                // ignore progress send failures
              }
            }
          } catch (dirError) {
            const err = dirError as NodeJS.ErrnoException
            const errorCode = err?.code || 'UNKNOWN'
            const errorMsg = err?.message || '未知错误'
            skippedFoldersCount++
            skippedItems.push({
              path: currentPath,
              reason: `[目录读取失败] ${errorCode}: ${errorMsg}`
            })
            console.warn(`❌ [FolderScan] 无法访问目录 ${currentPath}: ${errorCode} - ${errorMsg}`)
          }
        }

        controller.signal.throwIfAborted()
        const scannedGB = (scannedTotalBytes / (1024 * 1024 * 1024)).toFixed(2)
        console.log(`📳 [FolderScan] ========== 扫描完成 ==========`)
        console.log(`📳 [FolderScan] 源文件夹: ${folderPath}`)
        console.log(`📳 [FolderScan] 成功扫描文件: ${totalFilesScanned} 个`)
        console.log(`📳 [FolderScan] 成功扫描文件夹: ${totalFoldersScanned} 个`)
        console.log(`📳 [FolderScan] 蓝图包 / 材质包: ${totalPackagesScanned} 个（未展开）`)
        console.log(`📳 [FolderScan] 成功扫描总大小: ${scannedGB} GB`)
        console.log(`📳 [FolderScan] 跳过的文件: ${skippedFilesCount} 个`)
        console.log(`📳 [FolderScan] 跳过的目录: ${skippedFoldersCount} 个`)

        if (skippedItems.length > 0) {
          console.log(`⚠️ [FolderScan] ========== 跳过项目详情 (前 20 个) ==========`)
          skippedItems.slice(0, 20).forEach((item, index) => {
            console.log(`  ${index + 1}. ${item.path}`)
            console.log(`     原因: ${item.reason}`)
          })
          if (skippedItems.length > 20) {
            console.log(`  ... 还有 ${skippedItems.length - 20} 个被跳过的项目`)
          }
        }

        console.log(`📳 [FolderScan] ================================`)

        if (pendingBatch.length > 0) {
          batchIndex++
          try {
            event.sender.send('fs:scanBatch', {
              taskId,
              batchIndex,
              items: pendingBatch,
              isComplete: true
            })
            totalItemsEmitted += pendingBatch.length
          } catch {
            fallbackBatch = [...pendingBatch]
          }
          if (!fallbackBatch) {
            fallbackBatch = [...pendingBatch]
          }
          pendingBatch = []
        } else {
          try {
            event.sender.send('fs:scanBatch', {
              taskId,
              batchIndex,
              items: [],
              isComplete: true
            })
          } catch {
            // ignore completion send failures
          }
        }

        return {
          success: true,
          data: allItems,
          streamMode: batchIndex > 0,
          totalBatches: batchIndex,
          totalItemsEmitted,
          diagnostics: {
            totalFilesScanned,
            totalFoldersScanned,
            totalPackagesScanned,
            scannedTotalBytes,
            skippedFilesCount,
            skippedFoldersCount,
            skippedItems
          }
        }
      } catch (error) {
        console.error('❌ [FolderScan] 迭代读取文件夹内容失败:', error)
        return {
          success: false,
          cancelled: controller?.signal.aborted,
          error: (error as Error).message
        }
      } finally {
        if (controller) finishAssetImport(taskId, controller)
      }
    }
  )

  ipcMain.handle('fs:processFileMetadata', async (_, filePath: string) => {
    void _
    try {
      const fileProcessor = new FileProcessorManager()
      const metadata = await fileProcessor.processFile(filePath)

      if (!metadata) {
        return { success: false, error: '不支持的文件类型' }
      }

      return { success: true, data: metadata }
    } catch (error) {
      console.error('处理文件元数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('fs:processBatchFileMetadata', async (_, filePaths: string[]) => {
    void _
    try {
      const fileProcessor = new FileProcessorManager()
      const results = await fileProcessor.processFiles(filePaths)
      return { success: true, data: results }
    } catch (error) {
      console.error('批量处理文件元数据失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
