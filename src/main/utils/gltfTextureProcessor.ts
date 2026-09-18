/**
 * GLB/GLTF 纹理处理模块
 *
 * 解决问题：AI 生成的模型中可能包含 blob: URL 引用的纹理，
 * 这些 URL 在页面刷新后会失效，导致纹理加载失败。
 *
 * 本模块会：
 * 1. 解析 GLB/GLTF 文件
 * 2. 检测使用 blob URL 的纹理
 * 3. 尝试下载并将纹理内嵌为 Base64 data URI
 * 4. 重新导出修复后的文件
 */

import type { NodeIO } from '@gltf-transform/core'
import { promises as fs } from 'fs'
import { extname } from 'path'

/**
 * 懒加载 @gltf-transform 并建好 IO。
 *
 * core + extensions 接近 1MB，只有用户真的处理 .glb/.gltf 时才用得上；
 * 顶层 import 会让它进入启动路径的静态依赖图。两个调用点本来就是 async，
 * 所以直接用 `await import`，顺带把重复的 IO 初始化收成一处。
 */
async function createGltfIO(verbosity: 'silent' | 'warn'): Promise<NodeIO> {
  const [{ NodeIO, Logger }, { ALL_EXTENSIONS }] = await Promise.all([
    import('@gltf-transform/core'),
    import('@gltf-transform/extensions')
  ])

  const io = new NodeIO()
  io.registerExtensions(ALL_EXTENSIONS)
  io.setLogger(new Logger(verbosity === 'silent' ? Logger.Verbosity.SILENT : Logger.Verbosity.WARN))
  return io
}

/**
 * 判断 URL 是否为 blob URL
 */
function isBlobUrl(url: string | null): boolean {
  if (!url) return false
  return url.startsWith('blob:')
}

/**
 * 尝试下载 blob URL 内容（需要在渲染进程执行）
 * 此函数仅用于 Main 进程模拟，实际 blob URL 无法在 Main 进程访问
 *
 * @param url blob URL
 * @returns Buffer 或 null
 */
async function tryFetchBlobUrl(url: string, timeout = 10000): Promise<Buffer | null> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeoutId)

    if (!response.ok) {
      console.warn(`[GLTFProcessor] Blob URL 请求失败: ${response.status}`)
      return null
    }

    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch {
    // blob URL 通常无法在 Main 进程访问，这是预期行为
    console.log(`[GLTFProcessor] 无法访问 blob URL (预期行为): ${url}`)
    return null
  }
}

/**
 * 检查 GLB 文件是否包含 blob URL 纹理
 *
 * @param filePath GLB 文件路径
 * @returns true 如果包含 blob URL 纹理
 */
export async function hasBloblUrlTextures(filePath: string): Promise<boolean> {
  const ext = extname(filePath).toLowerCase()
  if (ext !== '.glb' && ext !== '.gltf') {
    return false
  }

  try {
    const io = await createGltfIO('silent')

    const document = await io.read(filePath)
    const textures = document.getRoot().listTextures()

    for (const texture of textures) {
      const uri = texture.getURI()
      if (isBlobUrl(uri)) {
        return true
      }
    }

    return false
  } catch (error) {
    console.warn(`[GLTFProcessor] 解析文件失败: ${filePath}`, error)
    return false
  }
}

/**
 * 处理 GLB/GLTF 文件中的 blob URL 纹理
 *
 * 策略：
 * 1. 尝试下载 blob URL 内容（如果可访问）
 * 2. 如果下载失败，生成占位纹理（避免模型完全无纹理）
 * 3. 重新保存文件
 *
 * @param filePath GLB/GLTF 文件路径
 * @param options 处理选项
 * @returns 处理结果
 */
export async function processGltfTextures(
  filePath: string,
  options: {
    /** 是否替换原文件（默认 true） */
    overwrite?: boolean
    /** 输出路径（仅 overwrite=false 时使用） */
    outputPath?: string
    /** 是否使用占位纹理替代无法下载的 blob URL */
    usePlaceholder?: boolean
  } = {}
): Promise<{
  success: boolean
  processed: boolean
  blobTexturesFound: number
  blobTexturesFixed: number
  error?: string
}> {
  const { overwrite = true, outputPath, usePlaceholder = true } = options
  const ext = extname(filePath).toLowerCase()

  // 仅处理 GLB/GLTF
  if (ext !== '.glb' && ext !== '.gltf') {
    return { success: true, processed: false, blobTexturesFound: 0, blobTexturesFixed: 0 }
  }

  // 验证文件存在性
  try {
    await fs.access(filePath)
  } catch {
    console.warn(`[GLTFProcessor] 文件不存在或无法访问: ${filePath}`)
    return {
      success: false,
      processed: false,
      blobTexturesFound: 0,
      blobTexturesFixed: 0,
      error: '文件不存在或无法访问'
    }
  }

  try {
    console.log(`[GLTFProcessor] 开始处理文件: ${filePath}`)

    // 初始化 IO
    const io = await createGltfIO('warn')

    // 读取文档
    const document = await io.read(filePath)
    const textures = document.getRoot().listTextures()

    let blobTexturesFound = 0
    let blobTexturesFixed = 0

    for (const texture of textures) {
      const uri = texture.getURI()

      if (!isBlobUrl(uri)) {
        continue
      }

      blobTexturesFound++
      console.log(`[GLTFProcessor] 发现 blob URL 纹理: ${uri?.substring(0, 50)}...`)

      // 如果纹理已经有嵌入的图像数据，跳过
      const existingImage = texture.getImage()
      if (existingImage && existingImage.byteLength > 0) {
        console.log(`[GLTFProcessor] 纹理已有内嵌数据，跳过`)
        blobTexturesFixed++
        // 清除无效的 URI
        texture.setURI(null as unknown as string)
        continue
      }

      // 尝试下载 blob URL（在 Main 进程通常会失败）
      const imageData = await tryFetchBlobUrl(uri || '', 5000)

      if (imageData) {
        // 下载成功，嵌入纹理
        texture.setImage(new Uint8Array(imageData))
        texture.setURI(null as unknown as string)
        blobTexturesFixed++
        console.log(`[GLTFProcessor] 成功嵌入纹理数据: ${imageData.length} bytes`)
      } else if (usePlaceholder) {
        // 创建 1x1 占位纹理（中灰色）
        // PNG 格式的 1x1 灰色像素
        const placeholderPng = Buffer.from([
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a, // PNG 签名
          0x00,
          0x00,
          0x00,
          0x0d,
          0x49,
          0x48,
          0x44,
          0x52, // IHDR 块
          0x00,
          0x00,
          0x00,
          0x01,
          0x00,
          0x00,
          0x00,
          0x01,
          0x08,
          0x02,
          0x00,
          0x00,
          0x00,
          0x90,
          0x77,
          0x53,
          0xde, // 1x1 RGB
          0x00,
          0x00,
          0x00,
          0x0c,
          0x49,
          0x44,
          0x41,
          0x54, // IDAT 块
          0x08,
          0xd7,
          0x63,
          0xb0,
          0xb0,
          0xb0,
          0x00,
          0x00,
          0x02,
          0x41,
          0x01,
          0x20, // 灰色像素数据
          0xbb,
          0x4d,
          0xcc,
          0x8b,
          0x00,
          0x00,
          0x00,
          0x00,
          0x49,
          0x45,
          0x4e,
          0x44, // IEND 块
          0xae,
          0x42,
          0x60,
          0x82
        ])

        texture.setImage(new Uint8Array(placeholderPng))
        texture.setMimeType('image/png')
        texture.setURI(null as unknown as string)
        blobTexturesFixed++
        console.log(`[GLTFProcessor] 使用占位纹理替代无法下载的 blob URL`)
      } else {
        // 仅清除无效 URI
        texture.setURI(null as unknown as string)
        console.log(`[GLTFProcessor] 清除无效 blob URI`)
      }
    }

    // 如果有修改，保存文件
    if (blobTexturesFound > 0) {
      const savePath = overwrite ? filePath : outputPath || filePath
      await io.write(savePath, document)
      console.log(
        `[GLTFProcessor] 文件已保存: ${savePath} (修复 ${blobTexturesFixed}/${blobTexturesFound} 个纹理)`
      )
    } else {
      console.log(`[GLTFProcessor] 文件无需处理: ${filePath}`)
    }

    return {
      success: true,
      processed: blobTexturesFound > 0,
      blobTexturesFound,
      blobTexturesFixed
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[GLTFProcessor] 处理失败: ${errorMsg}`)
    return {
      success: false,
      processed: false,
      blobTexturesFound: 0,
      blobTexturesFixed: 0,
      error: errorMsg
    }
  }
}

/**
 * 批量处理文件夹中的所有 GLB/GLTF 文件
 */
export async function processGltfFilesInFolder(folderPath: string): Promise<{
  processed: number
  errors: number
}> {
  let processed = 0
  let errors = 0

  try {
    const files = await fs.readdir(folderPath)

    for (const file of files) {
      const ext = extname(file).toLowerCase()
      if (ext !== '.glb' && ext !== '.gltf') {
        continue
      }

      const filePath = `${folderPath}/${file}`
      const result = await processGltfTextures(filePath)

      if (result.success && result.processed) {
        processed++
      } else if (!result.success) {
        errors++
      }
    }
  } catch (error) {
    console.error(`[GLTFProcessor] 处理文件夹失败: ${error}`)
    errors++
  }

  return { processed, errors }
}
