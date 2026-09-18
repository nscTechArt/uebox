// 图片大小限制（100MB - Gemini 3 Flash 支持）
const MAX_IMAGE_SIZE = 100 * 1024 * 1024

const UPLOAD_COMPRESS_THRESHOLD = 10 * 1024 * 1024
const UPLOAD_COMPRESS_TARGET_KB = 10 * 1024

/**
 * 图片上传结果
 */
export interface ImageUploadResult {
  success: boolean
  url?: string
  base64?: string
  error?: string
}

/**
 * 检查文件是否为图片
 * @param file 文件对象
 * @returns 是否为图片
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

/**
 * 检查文件大小是否在限制内
 * @param file 文件对象
 * @returns 是否在限制内
 */
export function isFileSizeValid(file: File): boolean {
  return file.size <= MAX_IMAGE_SIZE
}

/**
 * 将文件转换为 Base64
 * @param file 文件对象
 * @returns Base64 字符串
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result)
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

async function optimizeImageForUpload(file: File): Promise<File> {
  if (file.size <= UPLOAD_COMPRESS_THRESHOLD) {
    return file
  }

  try {
    const compressedFile = await compressImageToTarget(file, UPLOAD_COMPRESS_TARGET_KB)
    if (compressedFile.size > 0 && compressedFile.size < file.size) {
      console.log(
        `[imageUpload] 图片上传前压缩: ${(file.size / 1024 / 1024).toFixed(2)}MB -> ${(compressedFile.size / 1024 / 1024).toFixed(2)}MB`
      )
      return compressedFile
    }
  } catch (error) {
    console.warn('[imageUpload] 图片压缩失败，使用原图上传:', error)
  }

  return file
}

/**
 * 客户端图片压缩，压缩到指定大小以下（默认 100KB）
 * @param file 原始文件
 * @param targetSizeKB 目标大小 (KB)
 * @returns 压缩后的文件解析 (如果是动态图或无法压缩则返回原文件)
 */
export async function compressImageToTarget(file: File, targetSizeKB = 100): Promise<File> {
  const targetBytes = targetSizeKB * 1024
  if (file.size <= targetBytes) {
    return file // 已经足够小，无需压缩
  }

  // 放弃对 Gif 的压缩以免失去动画，如果强制压就会变成单帧
  // 但为了满足 API 强制可设为统一压
  if (file.type === 'image/gif') {
    // 暂时允许gif压缩为静态图，以防炸掉请求
  }

  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      const img = new Image()
      img.onload = () => {
        let width = img.width
        let height = img.height

        // 如果图片实在太大，先缩小尺寸
        const maxDim = 1200
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height)
          width = Math.floor(width * ratio)
          height = Math.floor(height * ratio)
        }

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(file)
          return
        }

        // 绘制白色背景（解决透明 PNG 变黑的问题）
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(img, 0, 0, width, height)

        let quality = 0.8
        const attempt = () => {
          canvas.toBlob(
            (blob) => {
              if (!blob) {
                resolve(file)
                return
              }
              // 如果还是大于目标，且质量还能降，继续压
              if (blob.size > targetBytes && quality > 0.1) {
                quality -= 0.15
                // 同时缩小一点尺寸
                width = Math.floor(width * 0.9)
                height = Math.floor(height * 0.9)
                canvas.width = width
                canvas.height = height
                ctx.fillStyle = '#fff'
                ctx.fillRect(0, 0, width, height)
                ctx.drawImage(img, 0, 0, width, height)
                attempt()
              } else {
                const newFile = new File([blob], file.name.replace(/\.[^/.]+$/, '') + '.jpg', {
                  type: 'image/jpeg',
                  lastModified: Date.now()
                })
                resolve(newFile)
              }
            },
            'image/jpeg',
            quality
          )
        }
        attempt()
      }
      img.onerror = () => resolve(file) // 无法解析时返回原文件
      img.src = dataUrl
    }
    reader.onerror = () => resolve(file)
    reader.readAsDataURL(file)
  })
}

/** 在本机压缩图片并转换为 data URL，供预览及模型请求使用。 */
async function keepImageLocal(file: File): Promise<ImageUploadResult> {
  const localFile = await optimizeImageForUpload(file)
  const dataUrl = await fileToBase64(localFile)
  return { success: true, url: dataUrl, base64: dataUrl }
}

/** 验证图片类型和大小，返回本机 data URL。 */
export async function prepareImage(file: File): Promise<ImageUploadResult> {
  try {
    // 检查文件类型
    if (!isImageFile(file)) {
      return { success: false, error: '只能上传图片文件' }
    }

    // 检查文件大小
    if (!isFileSizeValid(file)) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(2)
      return { success: false, error: `图片大小 (${sizeMB}MB) 超过限制 (100MB)` }
    }

    return await keepImageLocal(file)
  } catch (error) {
    console.error('准备图片失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '上传失败'
    }
  }
}

/**
 * 准备图片并返回内联数据
 * @param file 文件对象
 * @returns 上传结果
 */
export async function uploadImage(file: File): Promise<ImageUploadResult> {
  // 检查文件类型
  if (!isImageFile(file)) {
    return { success: false, error: '只能上传图片文件' }
  }

  // 检查文件大小
  if (!isFileSizeValid(file)) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(2)
    return { success: false, error: `图片大小 (${sizeMB}MB) 超过限制 (100MB)` }
  }

  return prepareImage(file)
}

/**
 * 批量上传图片
 * @param files 文件数组
 * @param onProgress 进度回调
 * @returns 上传结果数组
 */
export async function uploadImages(
  files: File[],
  onProgress?: (completed: number, total: number) => void
): Promise<ImageUploadResult[]> {
  const results: ImageUploadResult[] = []
  const total = files.length

  for (let i = 0; i < files.length; i++) {
    const result = await uploadImage(files[i])
    results.push(result)
    onProgress?.(i + 1, total)
  }

  return results
}

/**
 * 从粘贴事件中提取图片文件
 * @param event 粘贴事件
 * @returns 图片文件数组
 */
export function extractImagesFromPaste(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items
  if (!items) return []

  const images: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) {
        images.push(file)
      }
    }
  }

  return images
}

/**
 * 从拖放事件中提取图片文件
 * @param event 拖放事件
 * @returns 图片文件数组
 */
export function extractImagesFromDrop(event: DragEvent): File[] {
  const items = event.dataTransfer?.files
  if (!items) return []

  const images: File[] = []
  for (let i = 0; i < items.length; i++) {
    const file = items[i]
    if (file.type.startsWith('image/')) {
      images.push(file)
    }
  }

  return images
}

/**
 * 获取图片大小限制的友好描述
 */
export function getMaxImageSizeText(): string {
  return '100MB'
}
