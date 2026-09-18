/** AIGC 生成结果入库服务，供主进程工具和 IPC 共用。 */

/**
 * AIGC 资产保存辅助工具
 * 负责将 AIGC 生成的 URL 下载到本地资产库
 * 走正式的资产库导入流程（创建文件夹记录 + 资产记录）
 *
 * 目录结构：
 * 资产库根目录/
 * ├── ALL/
 * ├── AIGC/
 * │   ├── 图片/
 * │   ├── 模型/
 * │   └── 视频/
 */

import {
  assertAIGCVaultLocalWritesAllowed,
  ensureAIGCDirectory,
  ensureFolderRecord,
  getAIGCSubdirName,
  withAIGCVaultDatabase
} from '../../services/aigcVaultService'
import { createAssetData } from '../../sqliteDataBase/models/assetData'
import { promises as fs } from 'fs'
import { join, extname, basename } from 'path'
import { existsSync, statSync } from 'fs'
import { createHash } from 'node:crypto'

/** Import completed local music without another download or duplicate receipt on retry. */
export async function saveLocalMusicAsset(
  sourcePath: string,
  prompt?: string
): Promise<{ filePath: string; assetKey: string }> {
  assertAIGCVaultLocalWritesAllowed()
  const bytes = await fs.readFile(sourcePath)
  if (!bytes.length) throw new Error('音乐文件为空，无法入库。')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const folderKey = await ensureAIGCFolderExists('music')
  const dir = await getAIGCAssetDir('music')
  const filePath = join(dir, `${hash}${extname(sourcePath).toLowerCase() || '.mp3'}`)
  if (!existsSync(filePath)) {
    const temp = `${filePath}.tmp`
    await fs.writeFile(temp, bytes)
    await fs.rename(temp, filePath)
  }
  const existing = await withAIGCVaultDatabase(
    (db) =>
      db
        .prepare('SELECT assetKey FROM assetData WHERE filePath = ? AND isDelete = 0 LIMIT 1')
        .get(filePath) as { assetKey: string } | undefined
  )
  const assetKey =
    existing?.assetKey ?? (await createAssetRecord(folderKey, filePath, 'music', prompt))
  return { filePath, assetKey }
}

/**
 * AIGC 资产类型
 */
export type AIGCAssetType = 'image' | 'model' | 'video' | 'music'

/**
 * AIGC 资产类型到子目录的映射
 */
const AIGC_SUBDIRS: Record<AIGCAssetType, string> = {
  image: '图片',
  model: '模型',
  video: '视频',
  music: '音乐'
}

/**
 * AIGC 文件夹 Key
 */
const AIGC_FOLDER_KEY = 'AIGC'

/**
 * 确保 AIGC 文件夹结构存在（创建数据库记录）
 * 返回目标文件夹的 folderKey
 */
async function ensureAIGCFolderExists(assetType: AIGCAssetType): Promise<string> {
  const subfolderKey = `${AIGC_FOLDER_KEY}_${assetType}`
  const subfolderName = AIGC_SUBDIRS[assetType]

  return withAIGCVaultDatabase((db) => {
    ensureFolderRecord(db, AIGC_FOLDER_KEY, null, 'system', 'AIGC')
    ensureFolderRecord(db, subfolderKey, AIGC_FOLDER_KEY, 'folder', subfolderName)
    return subfolderKey
  })
}

/**
 * 获取 AIGC 资产保存目录（物理路径）
 */
async function getAIGCAssetDir(assetType: AIGCAssetType): Promise<string> {
  return ensureAIGCDirectory('AIGC', getAIGCSubdirName(assetType))
}

/**
 * 从 URL 推断文件扩展名
 */
function inferExtensionFromUrl(url: string, defaultExt: string): string {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    const ext = extname(pathname)
    if (ext && ext.length <= 5) {
      return ext.toLowerCase()
    }
  } catch {
    // 忽略解析错误
  }
  return defaultExt
}

/**
 * 生成唯一的文件路径
 */
async function generateUniqueFilePath(dir: string, baseName: string, ext: string): Promise<string> {
  // 清理文件名中的非法字符
  const safeName = baseName.replace(/[<>:"/\\|?*]/g, '_').substring(0, 50)

  let filePath = join(dir, `${safeName}${ext}`)
  let counter = 1

  while (existsSync(filePath)) {
    filePath = join(dir, `${safeName}_${counter}${ext}`)
    counter++
  }

  return filePath
}

/**
 * 创建资产记录
 * @param folderKey 所属文件夹的 Key
 * @param filePath 文件的完整物理路径
 * @param assetType AIGC 资产类型
 * @returns 创建的资产 Key
 */
async function createAssetRecord(
  folderKey: string,
  filePath: string,
  assetType: AIGCAssetType,
  prompt?: string
): Promise<string> {
  const fileName = basename(filePath)
  const fileExtension = extname(filePath).slice(1).toLowerCase()

  // 获取文件大小
  let fileSize = 0
  try {
    const stats = statSync(filePath)
    fileSize = stats.size
  } catch {
    // 忽略
  }

  const assetKey = `aigc_${assetType}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

  // 根据资产类型设置中文名和颜色
  const typeInfo: Record<AIGCAssetType, { classNameCn: string; classColor: string }> = {
    image: { classNameCn: 'AI 图片', classColor: '#E74C3C' },
    model: { classNameCn: 'AI 模型', classColor: '#3498DB' },
    video: { classNameCn: 'AI 视频', classColor: '#9B59B6' },
    music: { classNameCn: 'AI 音乐', classColor: '#1ABC9C' }
  }

  const { classNameCn, classColor } = typeInfo[assetType]
  const note = String(prompt || '').trim()

  // assetName 使用完整的文件名（含扩展名），以便前端正确识别文件类型
  // originPath 设置为文件的物理路径，用于加载图片缩略图等场景
  await withAIGCVaultDatabase((db) => {
    createAssetData(db, {
      assetKey,
      folderKey,
      assetName: fileName,
      filePath,
      originPath: filePath,
      fileSize,
      fileExtension,
      modifiedTime: new Date().toISOString(),
      processorType: 'AIGC',
      assetType: 'AIGC',
      classNameCn,
      classColor,
      note
    })
  })

  console.log(`[AIGCSaver] 创建资产记录: ${assetKey} -> ${filePath}`)
  return assetKey
}

/**
 * 下载 URL 并保存到本地资产库（完整导入流程）
 */
export async function downloadAndSaveAIGCAsset(
  url: string,
  assetType: AIGCAssetType,
  options: {
    /** 建议的文件名（不含扩展名） */
    suggestedName?: string
    /** 默认扩展名（如果无法从 URL 推断） */
    defaultExt?: string
    /** 超时时间（毫秒） */
    timeout?: number
    /** 生成提示词，保存到资产备注 */
    prompt?: string
  } = {}
): Promise<{ success: boolean; localPath?: string; assetKey?: string; error?: string }> {
  const { suggestedName, defaultExt = '.png', timeout = 60000, prompt } = options

  try {
    assertAIGCVaultLocalWritesAllowed()

    // 1. 确保 AIGC 文件夹结构存在（数据库记录）
    const folderKey = await ensureAIGCFolderExists(assetType)

    // 2. 获取物理保存目录
    const saveDir = await getAIGCAssetDir(assetType)

    // 3. 推断扩展名
    const ext = inferExtensionFromUrl(url, defaultExt)

    // 4. 生成文件名
    const baseName = suggestedName || `aigc_${Date.now()}`
    const filePath = await generateUniqueFilePath(saveDir, baseName, ext)

    console.log(`[AIGCSaver] 开始下载: ${url.substring(0, 80)}...`)
    console.log(`[AIGCSaver] 保存到: ${filePath}`)

    // 5. 下载文件
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(url, {
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      // 6. 保存到本地
      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      await fs.writeFile(filePath, buffer)

      console.log(`[AIGCSaver] 下载完成: ${filePath} (${buffer.length} bytes)`)

      // 7. 创建资产记录
      const assetKey = await createAssetRecord(folderKey, filePath, assetType, prompt)

      return {
        success: true,
        localPath: filePath,
        assetKey
      }
    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('下载超时')
      }
      throw error
    }
  } catch (error) {
    console.error('[AIGCSaver] 下载失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 保存 Buffer 数据到本地资产库（完整导入流程）
 */
export async function saveAIGCAssetFromBuffer(
  buffer: Buffer,
  assetType: AIGCAssetType,
  options: {
    suggestedName?: string
    extension: string
    prompt?: string
  }
): Promise<{ success: boolean; filePath: string; assetKey: string; error?: string }> {
  try {
    assertAIGCVaultLocalWritesAllowed()

    const { suggestedName, extension, prompt } = options
    const folderKey = await ensureAIGCFolderExists(assetType)
    const saveDir = await getAIGCAssetDir(assetType)

    // 生成文件名
    const baseName = suggestedName || `generated_${Date.now()}`
    const ext = extension.startsWith('.') ? extension : `.${extension}`
    const filePath = await generateUniqueFilePath(saveDir, baseName, ext)

    // 写入文件
    await fs.writeFile(filePath, buffer)
    console.log(`[AIGCSaver] 文件写入成功: ${filePath}`)

    // 创建资产记录
    const assetKey = await createAssetRecord(folderKey, filePath, assetType, prompt)

    return { success: true, filePath, assetKey }
  } catch (error) {
    console.error('[AIGCSaver] 保存 Buffer 失败:', error)
    return { success: false, filePath: '', assetKey: '', error: String(error) }
  }
}

/**
 * 批量下载 AIGC 资产
 */
export async function downloadMultipleAIGCAssets(
  urls: string[],
  assetType: AIGCAssetType,
  options: {
    suggestedBaseName?: string
    defaultExt?: string
    prompt?: string
  } = {}
): Promise<{
  success: boolean
  localPaths: string[]
  assetKeys: string[]
  errors: string[]
}> {
  const localPaths: string[] = []
  const assetKeys: string[] = []
  const errors: string[] = []

  for (let i = 0; i < urls.length; i++) {
    const suggestedName = options.suggestedBaseName
      ? `${options.suggestedBaseName}_${i + 1}`
      : undefined

    const result = await downloadAndSaveAIGCAsset(urls[i], assetType, {
      suggestedName,
      defaultExt: options.defaultExt,
      prompt: options.prompt
    })

    if (result.success && result.localPath) {
      localPaths.push(result.localPath)
      if (result.assetKey) {
        assetKeys.push(result.assetKey)
      }
    } else {
      errors.push(result.error || '下载失败')
    }
  }

  return {
    success: localPaths.length > 0,
    localPaths,
    assetKeys,
    errors
  }
}
