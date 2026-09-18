/**
 * 把一个 zip 素材包解进 UE 工程的 Content 目录。
 *
 * 为什么不是「解到一个固定的子目录里就完事」：市场/Fab 上的素材包绝大多数就是照
 * **直接解到 Content 下**设计的 —— 包里第一层就是 `MyPack/`，里面的资产引用路径写死成
 * `/Game/MyPack/...`。塞进多余的一层，UE 打开就是一片红色的丢失引用。
 *
 * 所以这里按包自己的结构决定落点，规则只有两条（见 `pickExtractDirName`），
 * 结果和用户自己右键解压再拖进 Content 是一样的。
 *
 * 解压本身走 `extractZipSafely`：条目名是压缩包作者写的字符串，不做校验就是一条
 * 别人可控的写文件路径。
 */
import { promises as fs } from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import { extractZipSafely, UnsafeZipEntryError } from './safeExtract'

export interface ArchiveExtractResult {
  success: boolean
  /** 实际解到的目录，失败时为空 */
  destDir?: string
  /** 解出来的文件数（不含目录条目） */
  fileCount?: number
  error?: string
}

/**
 * 压缩包名直接拿来当目录名是不行的：`KAWAII ANIMATIONS 100 v5.0+ (Update).zip`
 * 里的空格、加号、括号在 UE 的包路径里都会惹麻烦。只留字母数字、下划线、短横和汉字。
 */
const UNSAFE_FOLDER_CHARS = /[^\w一-龥-]+/g

function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(UNSAFE_FOLDER_CHARS, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
  return cleaned || 'ImportedArchive'
}

/**
 * 决定解到 Content 下的哪个目录。
 *
 * - 包里**只有一个顶层目录**（内容全在 `MyPack/` 下面）→ 返回 null，直接解到
 *   `Content/`，让包自带的那层目录成为 `/Game/MyPack`。这是素材包的标准形态。
 * - 其他情况（散装文件、多个顶层目录）→ 用压缩包名开一个目录兜住，
 *   免得几十个散文件糊在 Content 根目录上。
 */
export function pickExtractDirName(zipFileName: string, entryNames: string[]): string | null {
  const topLevel = new Set<string>()
  let hasRootFile = false

  for (const raw of entryNames) {
    const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!normalized) continue
    const slash = normalized.indexOf('/')
    if (slash <= 0) {
      // 顶层直接躺着一个文件
      if (!normalized.endsWith('/')) hasRootFile = true
      continue
    }
    topLevel.add(normalized.slice(0, slash))
  }

  if (!hasRootFile && topLevel.size === 1) return null

  return sanitizeFolderName(zipFileName.replace(/\.[^.]+$/, ''))
}

/**
 * 解压 zip 到工程的 Content 目录。
 *
 * 只做解压，不碰 UE 插件 —— 包里是 `.uasset` 时这就是全部要做的事；包里是 FBX 之类
 * 还需要在编辑器里再导一次，调用方要把这句话讲给用户听。
 */
export async function extractArchiveToProjectContent(params: {
  zipPath: string
  projectPath: string
}): Promise<ArchiveExtractResult> {
  const { zipPath, projectPath } = params

  if (!zipPath || !projectPath) {
    return { success: false, error: '缺少压缩包路径或工程路径' }
  }

  const ext = path.extname(zipPath).toLowerCase()
  if (ext !== '.zip') {
    return { success: false, error: `盒子只能解 zip，这个是 ${ext || '未知格式'}` }
  }

  try {
    await fs.access(zipPath)
  } catch {
    return { success: false, error: `压缩包不存在：${zipPath}` }
  }

  try {
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries()
    if (entries.length === 0) {
      return { success: false, error: '这个压缩包是空的' }
    }

    const contentDir = path.join(projectPath, 'Content')
    const dirName = pickExtractDirName(
      path.basename(zipPath),
      entries.map((entry) => entry.entryName)
    )
    const destDir = dirName ? path.join(contentDir, dirName) : contentDir

    await extractZipSafely(zip, destDir)

    return {
      success: true,
      destDir,
      fileCount: entries.filter((entry) => !entry.isDirectory).length
    }
  } catch (error) {
    if (error instanceof UnsafeZipEntryError) {
      return { success: false, error: `这个压缩包不安全，里面有越界路径：${error.entryName}` }
    }
    return { success: false, error: String(error instanceof Error ? error.message : error) }
  }
}
