import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, extname, basename, dirname } from 'path'
import { existsSync } from 'fs'
import AdmZip from 'adm-zip'
import { createAssetFolder, getAssetFolderByKey } from '../sqliteDataBase/models/assetFolder'
import { createAssetData, getAssetDataByFolderKey } from '../sqliteDataBase/models/assetData'
import {
  assertAIGCVaultLocalWritesAllowed,
  ensureAIGCDirectory,
  ensureFolderRecord,
  openAIGCVaultDatabase,
  withAIGCVaultDatabase
} from '../services/aigcVaultService'
import { processGltfTextures } from '../utils/gltfTextureProcessor'
import {
  AIGC_REFERENCE_LIBRARY_FOLDER_KEY,
  AIGC_REFERENCE_LIBRARY_FOLDER_NAME,
  AIGC_ROOT_FOLDER_KEY
} from '../../shared/aigcReferenceLibrary'

/**
 * AIGC 相关 IPC
 * - 将生成结果（URL）下载并保存到本地资产库 AIGC/ 目录
 */

/**
 * 下载并保存3D模型（供Main进程直接调用）
 * @param urls 下载URL列表
 * @param taskId 任务ID
 */
export async function downloadAndSave3DModel(
  urls: string[],
  taskId: string
): Promise<{ success: boolean; modelFilePath?: string; error?: string }> {
  try {
    assertAIGCVaultLocalWritesAllowed()

    if (!urls || urls.length === 0) {
      return { success: false, error: 'urls不能为空' }
    }

    console.log(`[AIGC] 开始下载3D模型: ${taskId}, 文件数: ${urls.length}`)

    const saveDir = await ensureAIGCDirectory('AIGC', '模型', taskId)
    const TASK_FOLDER_KEY = `AIGC_model_${taskId}`
    const downloadedFiles: string[] = []

    await withAIGCVaultDatabase(async (db) => {
      ensureFolderRecord(db, 'AIGC', null, 'system', 'AIGC')
      ensureFolderRecord(db, 'AIGC_model', 'AIGC', 'folder', '模型')
      ensureFolderRecord(db, TASK_FOLDER_KEY, 'AIGC_model', 'folder', taskId)

      for (const url of urls) {
        const urlObj = new URL(url)
        const pathParts = urlObj.pathname.split('/')
        const match = url.match(/filename%3D%22([^%]+)%22/)
        const fileName = match
          ? decodeURIComponent(match[1])
          : pathParts[pathParts.length - 1] || `file_${Date.now()}.bin`
        const filePath = join(saveDir, fileName)

        if (existsSync(filePath)) {
          downloadedFiles.push(filePath)
          continue
        }

        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const arrayBuffer = await response.arrayBuffer()
        await fs.writeFile(filePath, Buffer.from(arrayBuffer))
        downloadedFiles.push(filePath)
        console.log(`[AIGC] 下载完成: ${fileName}`)

        const ext = extname(fileName).slice(1).toLowerCase()
        createAssetData(db, {
          assetKey: `aigc_model_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          folderKey: TASK_FOLDER_KEY,
          assetName: fileName,
          filePath,
          originPath: filePath,
          fileSize: arrayBuffer.byteLength,
          fileExtension: ext,
          modifiedTime: new Date().toISOString(),
          processorType: 'AIGC',
          assetType: 'AIGC',
          classNameCn: 'AI 模型',
          classColor: '#3498DB'
        })
      }
    })

    // 查找主模型文件
    const modelExtensions = ['.fbx', '.glb', '.gltf', '.obj']
    let modelFilePath: string | undefined
    for (const ext of modelExtensions) {
      const found = downloadedFiles.find((f) => f.toLowerCase().endsWith(ext))
      if (found) {
        modelFilePath = found
        break
      }
    }

    return { success: downloadedFiles.length > 0, modelFilePath }
  } catch (error) {
    console.error('[AIGC] 下载失败:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerAIGCIPC(): void {
  ipcMain.handle('aigc:getReferenceLibraryAssets', async () => {
    try {
      assertAIGCVaultLocalWritesAllowed()

      await ensureAIGCDirectory('AIGC', AIGC_REFERENCE_LIBRARY_FOLDER_NAME)

      return await withAIGCVaultDatabase((db, vaultInfo) => {
        ensureFolderRecord(db, AIGC_ROOT_FOLDER_KEY, null, 'system', 'AIGC')
        ensureFolderRecord(
          db,
          AIGC_REFERENCE_LIBRARY_FOLDER_KEY,
          AIGC_ROOT_FOLDER_KEY,
          'folder',
          AIGC_REFERENCE_LIBRARY_FOLDER_NAME
        )

        const assets = getAssetDataByFolderKey(
          db,
          AIGC_REFERENCE_LIBRARY_FOLDER_KEY,
          'modifiedTime',
          'desc'
        ).filter((asset) => {
          const ext = String(asset.fileExtension || '')
            .trim()
            .toLowerCase()
            .replace(/^\./, '')
          return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'tga'].includes(ext)
        })

        return {
          success: true,
          data: {
            vaultPath: vaultInfo.path,
            folderKey: AIGC_REFERENCE_LIBRARY_FOLDER_KEY,
            folderName: AIGC_REFERENCE_LIBRARY_FOLDER_NAME,
            assets
          }
        }
      })
    } catch (error) {
      console.error('[AIGC IPC] 获取参考素材列表失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  /**
   * 保存 3D 模型到资产库 AIGC/模型/{taskId}
   * 批量下载多个 URL 并保存到以 taskId 命名的子文件夹中
   * @param args.urls 下载 URL 数组
   * @param args.taskId 任务 ID，用于创建子文件夹
   * @param args.timeout 下载超时时间（毫秒），默认 120000
   */
  ipcMain.handle(
    'aigc:save3DModelFromUrls',
    async (
      _event,
      args: {
        urls: string[]
        taskId: string
        timeout?: number
        expectedFormat?: string // 期望的格式（如 'FBX', 'GLB'），用于格式转换时确保扩展名正确
        folderName?: string // 自定义文件夹名（prompt/任务名）
        toolType?: 'generate' | 'convert' | 'compress' | 'uv' | 'texture' | 'reduceFace' | 'part' // 工具类型，用于分组
      }
    ) => {
      let vaultDbHandle: ReturnType<typeof openAIGCVaultDatabase> | null = null
      try {
        assertAIGCVaultLocalWritesAllowed()

        const urls = args?.urls || []
        const taskId = String(args?.taskId || '').trim()
        const timeout = typeof args?.timeout === 'number' ? args.timeout : 120000
        const expectedFormat = args?.expectedFormat?.toUpperCase() // 标准化为大写
        const folderName = args?.folderName?.trim() || ''
        const toolType = args?.toolType || 'generate'

        if (urls.length === 0) {
          return { success: false, error: 'urls 不能为空' }
        }
        if (!taskId) {
          return { success: false, error: 'taskId 不能为空' }
        }

        console.log(
          `[AIGC IPC] 开始下载 3D 模型，任务ID: ${taskId}，文件数: ${urls.length}${expectedFormat ? `，期望格式: ${expectedFormat}` : ''}`
        )

        // 1. 确保文件夹结构存在
        vaultDbHandle = openAIGCVaultDatabase()
        const db = vaultDbHandle.db
        const AIGC_FOLDER_KEY = 'AIGC'
        const MODEL_FOLDER_KEY = 'AIGC_model'

        // 工具类型映射到中文名称
        const toolTypeNames: Record<string, string> = {
          generate: '生成',
          convert: '格式转换',
          compress: '压缩',
          uv: 'UV展开',
          texture: '纹理',
          reduceFace: '拓扑优化',
          part: '组件拆分'
        }
        const toolTypeName = toolTypeNames[toolType] || '生成'
        const TYPE_FOLDER_KEY = `AIGC_model_${toolType}`

        // 智能命名：使用传入的名称或生成默认名称
        const now = new Date()
        const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
        let smartFolderName: string
        if (folderName && folderName.length > 0) {
          // 截取前20个字符 + 日期后缀
          const truncatedName = folderName.length > 20 ? folderName.substring(0, 20) : folderName
          // 清理非法字符
          const cleanName = truncatedName.replace(/[\\/:*?"<>|]/g, '_')
          smartFolderName = `${cleanName}_${dateStr}`
        } else {
          smartFolderName = `模型_${dateStr}_${taskId.slice(-6)}`
        }
        const TASK_FOLDER_KEY = `AIGC_model_${toolType}_${taskId}`

        // 确保 AIGC 根文件夹存在
        if (!getAssetFolderByKey(db, AIGC_FOLDER_KEY)) {
          createAssetFolder(db, {
            folderKey: AIGC_FOLDER_KEY,
            fatherKey: null,
            type: 'system',
            folderName: 'AIGC',
            img: ''
          })
          console.log('[AIGC IPC] 创建 AIGC 根文件夹')
        }

        // 确保模型子文件夹存在
        if (!getAssetFolderByKey(db, MODEL_FOLDER_KEY)) {
          createAssetFolder(db, {
            folderKey: MODEL_FOLDER_KEY,
            fatherKey: AIGC_FOLDER_KEY,
            type: 'folder',
            folderName: '模型',
            img: ''
          })
          console.log('[AIGC IPC] 创建 AIGC/模型 子文件夹')
        }

        // 确保类型子文件夹存在（如 AIGC/模型/生成）
        if (!getAssetFolderByKey(db, TYPE_FOLDER_KEY)) {
          createAssetFolder(db, {
            folderKey: TYPE_FOLDER_KEY,
            fatherKey: MODEL_FOLDER_KEY,
            type: 'folder',
            folderName: toolTypeName,
            img: ''
          })
          console.log(`[AIGC IPC] 创建 AIGC/模型/${toolTypeName} 子文件夹`)
        }

        // 确保任务子文件夹存在（使用智能命名）
        if (!getAssetFolderByKey(db, TASK_FOLDER_KEY)) {
          createAssetFolder(db, {
            folderKey: TASK_FOLDER_KEY,
            fatherKey: TYPE_FOLDER_KEY,
            type: 'folder',
            folderName: smartFolderName,
            img: ''
          })
          console.log(`[AIGC IPC] 创建 AIGC/模型/${toolTypeName}/${smartFolderName} 子文件夹`)
        }

        // 2. 获取物理保存目录
        const saveDir = await ensureAIGCDirectory('AIGC', '模型', toolTypeName, smartFolderName)

        // 3. 下载所有文件
        const downloadedFiles: string[] = []
        const errors: string[] = []
        let modelFilePath: string | undefined = undefined
        let modelAssetKey: string | undefined = undefined // 用于缩略图生成

        for (const url of urls) {
          try {
            // 从 URL 提取文件名
            const match = url.match(/filename%3D%22([^%]+)%22/)
            let fileName: string
            if (match) {
              fileName = decodeURIComponent(match[1])
            } else {
              // 备用：从路径提取
              const urlObj = new URL(url)
              const pathParts = urlObj.pathname.split('/')
              fileName = pathParts[pathParts.length - 1] || `file_${Date.now()}.bin`
            }

            // 如果指定了期望格式，确保文件扩展名正确
            if (expectedFormat) {
              const currentExt = extname(fileName).toLowerCase()
              const expectedExt = `.${expectedFormat.toLowerCase()}`
              if (currentExt !== expectedExt) {
                // 替换或添加正确的扩展名
                const baseName = currentExt ? basename(fileName, currentExt) : fileName
                fileName = `${baseName}${expectedExt}`
                console.log(`[AIGC IPC] 修正文件扩展名: ${fileName}`)
              }
            }

            const filePath = join(saveDir, fileName)

            // 检查文件是否已存在
            if (existsSync(filePath)) {
              console.log(`[AIGC IPC] 文件已存在，跳过: ${filePath}`)
              downloadedFiles.push(filePath)
              continue
            }

            console.log(`[AIGC IPC] 下载文件: ${fileName}`)

            // 下载文件
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), timeout)

            try {
              const response = await fetch(url, { signal: controller.signal })
              clearTimeout(timeoutId)

              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`)
              }

              const arrayBuffer = await response.arrayBuffer()
              const buffer = Buffer.from(arrayBuffer)
              await fs.writeFile(filePath, buffer)

              console.log(`[AIGC IPC] 下载完成: ${filePath} (${buffer.length} bytes)`)

              // 检查是否为 ZIP 文件，如果是则解压
              const fileExtension = extname(filePath).toLowerCase()
              if (fileExtension === '.zip') {
                console.log(`[AIGC IPC] 检测到 ZIP 文件，开始解压: ${filePath}`)
                try {
                  const zip = new AdmZip(filePath)
                  const zipEntries = zip.getEntries()

                  for (const entry of zipEntries) {
                    if (!entry.isDirectory) {
                      const entryName = entry.entryName
                      // 处理嵌套路径，只取文件名
                      const extractFileName = basename(entryName)
                      const extractPath = join(saveDir, extractFileName)

                      // 提取文件
                      const entryData = entry.getData()
                      await fs.writeFile(extractPath, entryData)
                      console.log(
                        `[AIGC IPC] 解压文件: ${extractFileName} (${entryData.length} bytes)`
                      )

                      downloadedFiles.push(extractPath)

                      // 为解压出的文件创建资产记录
                      const extractedExt = extname(extractFileName).slice(1).toLowerCase()
                      const extractAssetKey = `aigc_model_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                      createAssetData(db, {
                        assetKey: extractAssetKey,
                        folderKey: TASK_FOLDER_KEY,
                        assetName: extractFileName,
                        filePath: extractPath,
                        originPath: extractPath,
                        fileSize: entryData.length,
                        fileExtension: extractedExt,
                        modifiedTime: new Date().toISOString(),
                        processorType: 'AIGC',
                        assetType: 'AIGC',
                        classNameCn: 'AI 模型',
                        classColor: '#3498DB'
                      })
                    }
                  }

                  // 删除原 ZIP 文件
                  await fs.unlink(filePath)
                  console.log(`[AIGC IPC] 已删除 ZIP 文件: ${filePath}`)
                } catch (unzipError) {
                  console.error(`[AIGC IPC] 解压失败: ${filePath}`, unzipError)
                  // 解压失败时保留 ZIP 文件
                  downloadedFiles.push(filePath)
                }
              } else {
                downloadedFiles.push(filePath)

                // 创建资产记录
                const assetExt = fileExtension.slice(1).toLowerCase()
                const assetKey = `aigc_model_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                createAssetData(db, {
                  assetKey,
                  folderKey: TASK_FOLDER_KEY,
                  assetName: fileName,
                  filePath,
                  originPath: filePath,
                  fileSize: buffer.length,
                  fileExtension: assetExt,
                  modifiedTime: new Date().toISOString(),
                  processorType: 'AIGC',
                  assetType: 'AIGC',
                  classNameCn: 'AI 模型',
                  classColor: '#3498DB'
                })

                // 记录主模型文件的 assetKey（用于缩略图生成）
                const modelExtensions = ['.fbx', '.glb', '.gltf', '.obj']
                if (modelExtensions.includes(fileExtension.toLowerCase())) {
                  modelAssetKey = assetKey
                }
              }
            } catch (downloadError) {
              clearTimeout(timeoutId)
              if (downloadError instanceof Error && downloadError.name === 'AbortError') {
                throw new Error(`下载超时: ${fileName}`)
              }
              throw downloadError
            }
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error)
            console.error(`[AIGC IPC] 下载文件失败: ${url}`, error)
            errors.push(errMsg)
          }
        }

        // 4. 查找主要模型文件（优先顺序：fbx > glb > gltf > obj）
        const modelExtensions = ['.fbx', '.glb', '.gltf', '.obj']
        for (const ext of modelExtensions) {
          const found = downloadedFiles.find((file) => file.toLowerCase().endsWith(ext))
          if (found) {
            modelFilePath = found
            console.log(`[AIGC IPC] 找到模型文件: ${modelFilePath}`)
            break
          }
        }

        // 5. 处理目录中所有 GLB/GLTF 的 blob URL 纹理（修复纹理加载失败问题）
        // 注意：需要处理整个目录，因为 ZIP 解压后可能有多个 GLB 文件
        if (downloadedFiles.length > 0) {
          console.log(`[AIGC IPC] 开始批量处理目录中的模型纹理: ${saveDir}`)
          try {
            // 遍历所有下载的文件，处理其中的 GLB/GLTF
            let texturesProcessed = 0
            let texturesFixed = 0

            for (const file of downloadedFiles) {
              const fileExt = extname(file).toLowerCase()
              if (fileExt !== '.glb' && fileExt !== '.gltf') {
                continue
              }

              // 验证文件存在
              if (!existsSync(file)) {
                console.warn(`[AIGC IPC] 跳过不存在的文件: ${file}`)
                continue
              }

              try {
                const textureResult = await processGltfTextures(file, {
                  overwrite: true,
                  usePlaceholder: true
                })
                if (textureResult.processed) {
                  texturesProcessed++
                  texturesFixed += textureResult.blobTexturesFixed
                  console.log(
                    `[AIGC IPC] 处理完成: ${file} (修复 ${textureResult.blobTexturesFixed}/${textureResult.blobTexturesFound} 个 blob URL 纹理)`
                  )
                }
              } catch (singleFileError) {
                // 单文件失败不影响其他文件
                console.warn(`[AIGC IPC] 单文件纹理处理失败: ${file}`, singleFileError)
              }
            }

            if (texturesProcessed > 0) {
              console.log(
                `[AIGC IPC] 纹理批量处理完成: ${texturesProcessed} 个文件, 共修复 ${texturesFixed} 个 blob URL 纹理`
              )
            }
          } catch (textureError) {
            // 纹理处理失败不影响主流程，仅记录警告
            console.warn('[AIGC IPC] 纹理批量处理失败（模型仍可用）:', textureError)
          }
        }

        vaultDbHandle?.close()
        return {
          success: downloadedFiles.length > 0,
          localFolderPath: saveDir,
          downloadedFiles,
          modelFilePath,
          modelAssetKey, // 用于前端触发缩略图生成
          modelFolderKey: TASK_FOLDER_KEY, // 用于AI命名后更新文件夹
          errors
        }
      } catch (error) {
        try {
          vaultDbHandle?.close()
        } catch {}
        console.error('[AIGC IPC] 3D 模型下载失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  /**
   * 根据 taskId 查找已下载的模型文件路径
   * 用于刷新后恢复历史记录的 localPath
   * @param args.taskId 任务 ID
   * @returns 找到的模型文件路径或 null
   */
  ipcMain.handle(
    'aigc:findModelByTaskId',
    async (
      _event,
      args: {
        taskId: string
      }
    ) => {
      try {
        const taskId = String(args?.taskId || '').trim()
        if (!taskId) {
          return { success: false, error: 'taskId 不能为空' }
        }

        return await withAIGCVaultDatabase(async (db) => {
          const { getAssetDataByFolderKey } = await import('../sqliteDataBase/models/assetData')
          const folderKeys = [
            `AIGC_model_generate_${taskId}`,
            `AIGC_model_${taskId}`,
            `AIGC_model_convert_${taskId}`,
            `AIGC_model_compress_${taskId}`,
            `AIGC_model_other_${taskId}`
          ]
          const modelExtensions = ['.fbx', '.glb', '.gltf', '.obj']

          for (const folderKey of folderKeys) {
            const assets = getAssetDataByFolderKey(db, folderKey)
            for (const ext of modelExtensions) {
              const matchedAsset = assets.find((asset) => {
                const filePath = String(asset.filePath || '')
                return filePath.toLowerCase().endsWith(ext) && existsSync(filePath)
              })
              if (matchedAsset?.filePath) {
                console.log('[AIGC IPC] 找到模型文件:', matchedAsset.filePath)
                return { success: true, modelFilePath: matchedAsset.filePath }
              }
            }
          }

          return { success: true, modelFilePath: null }
        })
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  /**
   * 导入本地模型到资产库
   * 用于模型压缩、格式转换等本地处理后的模型导入
   * @param args.localPath 模型本地路径
   * @param args.toolType 工具类型（compress/convert）
   * @param args.folderName 自定义文件夹名（可选）
   */
  ipcMain.handle(
    'aigc:importLocalModel',
    async (
      _event,
      args: {
        localPath: string
        toolType: 'compress' | 'convert' | 'other'
        folderName?: string
      }
    ) => {
      let vaultDbHandle: ReturnType<typeof openAIGCVaultDatabase> | null = null
      try {
        assertAIGCVaultLocalWritesAllowed()

        const { localPath, toolType, folderName } = args

        if (!localPath || !existsSync(localPath)) {
          return { success: false, error: '文件不存在' }
        }

        console.log(`[AIGC IPC] 导入本地模型到资产库: ${localPath}, 类型: ${toolType}`)

        // 获取文件信息
        const stats = await fs.stat(localPath)
        const fileName = basename(localPath)
        const fileExtension = extname(localPath).slice(1).toLowerCase()

        // 工具类型映射到中文名称
        const toolTypeNames: Record<string, string> = {
          compress: '压缩',
          convert: '格式转换',
          other: '处理'
        }
        const toolTypeName = toolTypeNames[toolType] || '处理'

        // 确保数据库文件夹结构存在
        vaultDbHandle = openAIGCVaultDatabase()
        const db = vaultDbHandle.db
        const AIGC_FOLDER_KEY = 'AIGC'
        const MODEL_FOLDER_KEY = 'AIGC_model'
        const TYPE_FOLDER_KEY = `AIGC_model_${toolType}`

        // 确保 AIGC 根文件夹存在
        if (!getAssetFolderByKey(db, AIGC_FOLDER_KEY)) {
          createAssetFolder(db, {
            folderKey: AIGC_FOLDER_KEY,
            fatherKey: null,
            type: 'system',
            folderName: 'AIGC',
            img: ''
          })
        }

        // 确保模型子文件夹存在
        if (!getAssetFolderByKey(db, MODEL_FOLDER_KEY)) {
          createAssetFolder(db, {
            folderKey: MODEL_FOLDER_KEY,
            fatherKey: AIGC_FOLDER_KEY,
            type: 'folder',
            folderName: '模型',
            img: ''
          })
        }

        // 确保类型子文件夹存在
        if (!getAssetFolderByKey(db, TYPE_FOLDER_KEY)) {
          createAssetFolder(db, {
            folderKey: TYPE_FOLDER_KEY,
            fatherKey: MODEL_FOLDER_KEY,
            type: 'folder',
            folderName: toolTypeName,
            img: ''
          })
        }

        // 智能命名：使用传入的名称或从文件名生成
        const now = new Date()
        const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
        const taskId = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
        let smartFolderName: string
        if (folderName && folderName.length > 0) {
          const truncatedName = folderName.length > 20 ? folderName.substring(0, 20) : folderName
          const cleanName = truncatedName.replace(/[\\/:*?"<>|]/g, '_')
          smartFolderName = `${cleanName}_${dateStr}`
        } else {
          // 从文件名提取（去除后缀如 _compressed）
          const baseName = fileName.replace(/\.[^.]+$/, '').replace(/_compressed|_converted/g, '')
          smartFolderName = `${baseName}_${dateStr}`
        }
        const TASK_FOLDER_KEY = `AIGC_model_${toolType}_${taskId}`

        // 确保任务子文件夹存在
        if (!getAssetFolderByKey(db, TASK_FOLDER_KEY)) {
          createAssetFolder(db, {
            folderKey: TASK_FOLDER_KEY,
            fatherKey: TYPE_FOLDER_KEY,
            type: 'folder',
            folderName: smartFolderName,
            img: ''
          })
        }

        // 创建资产记录（不复制文件，直接引用原路径）
        const saveDir = await ensureAIGCDirectory('AIGC', '模型', toolTypeName, smartFolderName)
        const savedFilePath = join(saveDir, fileName)
        if (!existsSync(savedFilePath)) {
          await fs.copyFile(localPath, savedFilePath)
        }

        const assetKey = `aigc_model_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        createAssetData(db, {
          assetKey,
          folderKey: TASK_FOLDER_KEY,
          assetName: fileName,
          filePath: savedFilePath,
          originPath: savedFilePath,
          fileSize: stats.size,
          fileExtension,
          modifiedTime: new Date().toISOString(),
          processorType: 'AIGC',
          assetType: 'AIGC',
          classNameCn: 'AI 模型',
          classColor: '#3498DB'
        })

        console.log(`[AIGC IPC] 本地模型已导入资产库: ${assetKey}`)
        vaultDbHandle?.close()

        return {
          success: true,
          assetKey,
          folderKey: TASK_FOLDER_KEY
        }
      } catch (error) {
        try {
          vaultDbHandle?.close()
        } catch {}
        console.error('[AIGC IPC] 导入本地模型失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  /**
   * 更新3D模型文件夹名称
   * 用于在AI命名完成后更新资产库中的文件夹名称
   * 同时更新文件夹内所有文件的资产名称和物理文件名
   * @param args.taskId 任务ID（用于查找文件夹）
   * @param args.newName 新的文件夹名称
   */
  ipcMain.handle(
    'aigc:update3DModelFolderName',
    async (
      _event,
      args: {
        taskId: string
        newName: string
      }
    ) => {
      let vaultDbHandle: ReturnType<typeof openAIGCVaultDatabase> | null = null
      try {
        assertAIGCVaultLocalWritesAllowed()

        const { taskId, newName } = args

        if (!taskId || !newName) {
          return { success: false, error: 'taskId 和 newName 不能为空' }
        }

        console.log(`[AIGC IPC] 更新3D模型文件夹名称: ${taskId} -> ${newName}`)

        // 查找对应的文件夹
        vaultDbHandle = openAIGCVaultDatabase()
        const db = vaultDbHandle.db
        const { updateAssetFolder, getAssetFolderByKey } = await import(
          '../sqliteDataBase/models/assetFolder'
        )
        const { getAssetDataByFolderKey, updateAssetData } = await import(
          '../sqliteDataBase/models/assetData'
        )

        // 确定要使用的文件夹key
        let activeFolderKey = `AIGC_model_generate_${taskId}`
        let folder = getAssetFolderByKey(db, activeFolderKey)

        if (!folder) {
          // 尝试旧格式的文件夹key
          activeFolderKey = `AIGC_model_${taskId}`
          folder = getAssetFolderByKey(db, activeFolderKey)
          if (!folder) {
            console.warn(
              `[AIGC IPC] 未找到文件夹: AIGC_model_generate_${taskId} 或 ${activeFolderKey}`
            )
            vaultDbHandle?.close()
            return { success: false, error: '未找到对应的文件夹' }
          }
        }

        // 更新文件夹名称
        const folderSuccess = updateAssetFolder(db, activeFolderKey, { folderName: newName })
        console.log(`[AIGC IPC] 更新文件夹名称${folderSuccess ? '成功' : '失败'}: ${newName}`)

        // 获取该文件夹下的所有资产文件并更新名称
        const assets = getAssetDataByFolderKey(db, activeFolderKey)
        let fileRenameCount = 0

        // 清理语义名称（去除日期后缀以获取纯名称部分）
        // 格式通常为 "暗夜皮衣女郎_0105"，提取 "暗夜皮衣女郎"
        const semanticName = newName.replace(/_\d{4}$/, '')

        for (const asset of assets) {
          const oldAssetName = asset.assetName
          const fileExt = asset.fileExtension || extname(oldAssetName).slice(1)

          // 生成新文件名：语义名称 + 原扩展名
          // 如果有多个同类型文件，添加序号后缀
          const sameExtAssets = assets.filter(
            (a) =>
              (a.fileExtension || extname(a.assetName).slice(1)).toLowerCase() ===
              fileExt.toLowerCase()
          )
          const assetIndex = sameExtAssets.indexOf(asset)
          const suffix = sameExtAssets.length > 1 ? `_${assetIndex + 1}` : ''
          const newAssetName = `${semanticName}${suffix}.${fileExt}`

          if (oldAssetName === newAssetName) {
            console.log(`[AIGC IPC] 跳过已更新的文件: ${oldAssetName}`)
            continue
          }

          // 更新数据库中的资产名称
          const assetUpdated = updateAssetData(db, asset.assetKey, { assetName: newAssetName })

          // 尝试重命名物理文件
          if (asset.filePath && existsSync(asset.filePath)) {
            const oldFilePath = asset.filePath
            // 使用 path.dirname 正确获取目录路径（跨平台兼容）
            const dirPath = dirname(oldFilePath)
            const newFilePath = join(dirPath, newAssetName)

            // 避免重命名到相同路径
            if (oldFilePath !== newFilePath && !existsSync(newFilePath)) {
              try {
                await fs.rename(oldFilePath, newFilePath)
                // 更新数据库中的文件路径
                updateAssetData(db, asset.assetKey, {
                  filePath: newFilePath,
                  originPath: newFilePath
                })
                console.log(`[AIGC IPC] 重命名文件: ${oldAssetName} -> ${newAssetName}`)
                fileRenameCount++
              } catch (renameError) {
                console.warn(`[AIGC IPC] 重命名文件失败: ${oldFilePath}`, renameError)
              }
            }
          } else if (assetUpdated) {
            console.log(`[AIGC IPC] 更新资产名称(无物理文件): ${oldAssetName} -> ${newAssetName}`)
            fileRenameCount++
          }
        }

        console.log(`[AIGC IPC] 文件重命名完成，共更新 ${fileRenameCount} 个文件`)
        vaultDbHandle?.close()

        return { success: folderSuccess, filesRenamed: fileRenameCount }
      } catch (error) {
        try {
          vaultDbHandle?.close()
        } catch {}
        console.error('[AIGC IPC] 更新文件夹名称失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
}
