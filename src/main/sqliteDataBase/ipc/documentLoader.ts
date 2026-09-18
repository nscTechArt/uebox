/**
 * 文档加载器 IPC 处理器
 *
 * 二进制文档（Word / PDF / Excel / PPT / OpenDocument / RTF / EPUB）统一交给
 * `@firecrawl/anydoc`：一个 Rust 实现的原生模块，所有格式先解析成同一套文档模型，
 * 再经同一个 Markdown 序列化器输出，所以标题、嵌套列表、合并单元格的写法不会
 * 因为源格式不同而漂移。它此前是 mammoth / word-extractor / pdf-parse / xlsx
 * 四个各写各的库，四套空内容判定、四套 Markdown 风格。
 *
 * 纯文本仍然直接读，不必绕解析器；DOCX 的图文导入仍走 mammoth（见
 * `loadDocxWithImages` 的注释）。
 */
import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'

/**
 * 文档加载结果接口
 */
interface DocumentLoadResult {
  success: boolean
  /** 文档的文本内容 */
  content?: string
  /** 文档元数据 */
  metadata?: {
    source: string
    title?: string
    pageCount?: number
    [key: string]: unknown
  }
  /** 错误信息 */
  error?: string
}

const ANYDOC_PARSE_TIMEOUT_MS = 180_000
const DOCX_IMAGE_PARSE_TIMEOUT_MS = 180_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeoutId)
        reject(error)
      }
    )
  })
}

/**
 * 获取文件扩展名（小写）
 */
function getExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase().slice(1)
}

/**
 * anydoc 失败时 `code` 字段的取值 → 给用户看的话。
 *
 * 这是换掉四个解析库最实在的一处收益：以前无论文件是加密的、是扫描件、还是
 * 根本不是它声称的格式，用户看到的都是「加载 PDF 文件失败」外加一句英文异常。
 * 现在每种失败都有确切的原因，而且能说清楚下一步该做什么。
 */
const ANYDOC_ERROR_MESSAGES: Record<string, string> = {
  unsupported: '无法识别的文件格式',
  needsOcr: '这是扫描件（图片型 PDF），没有可提取的文字，需要先做 OCR',
  malformed: '文件已损坏，无法解析出内容',
  encrypted: '文件被密码保护，请先去掉密码再上传',
  resourceLimit: '文件结构过于复杂，超出了安全解析上限',
  missingPart: '文件缺少必要的内容部分，可能没有保存完整',
  io: '文件无法读取（可能正被其他程序占用）',
  hosted: '在线 OCR 服务不可用'
}

/** anydoc 的 `needsOcr` 会带上具体是哪几页需要 OCR */
interface NeedsOcrShape {
  code: 'needsOcr'
  pages: number[]
  pageCount: number
}

function isNeedsOcr(error: unknown): error is NeedsOcrShape {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'needsOcr' &&
    Array.isArray((error as { pages?: unknown }).pages)
  )
}

/**
 * 把 anydoc 的失败翻译成一句用户看得懂的话。
 * 扫描件额外报出是哪几页，用户才知道该去补哪一部分。
 */
function describeAnydocError(error: unknown): string {
  if (isNeedsOcr(error)) {
    const preview = error.pages.slice(0, 5).join('、')
    const suffix = error.pages.length > 5 ? ` 等 ${error.pages.length} 页` : ''
    return `${ANYDOC_ERROR_MESSAGES.needsOcr}（第 ${preview}${suffix} / 共 ${error.pageCount} 页）`
  }
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && ANYDOC_ERROR_MESSAGES[code]) {
    return ANYDOC_ERROR_MESSAGES[code]
  }
  return error instanceof Error ? error.message : '文档解析失败'
}

/**
 * 用 anydoc 把二进制文档转成 Markdown。
 *
 * 格式是**从文件内容里认出来的**，扩展名只是签名缺失格式（CSV）的兜底 ——
 * 所以一个被人手动改名成 .docx 的 .doc 依然能正常解析，这是以前按扩展名
 * 分发到四个库时做不到的。
 *
 * 注意这里不传 `ocr` 选项：默认的 `'reject'` 意味着**任何文档都不出本机**。
 * 扫描件会明确失败而不是悄悄返回空白，见 ANYDOC_ERROR_MESSAGES.needsOcr。
 */
async function loadWithAnydoc(filePath: string): Promise<DocumentLoadResult> {
  try {
    const { toMarkdown } = await import('@firecrawl/anydoc')

    const content = (await toMarkdown(filePath)).trim()

    if (!content) {
      return {
        success: false,
        error: '文档内容为空'
      }
    }

    return {
      success: true,
      content,
      metadata: {
        source: filePath,
        title: path.basename(filePath, path.extname(filePath))
      }
    }
  } catch (error) {
    console.error('[DocumentLoader] 文档解析失败:', filePath, error)
    return {
      success: false,
      error: describeAnydocError(error)
    }
  }
}

/** 图片提取配置 */
interface ImageExtractOptions {
  /** 图片保存目录 */
  imageDir: string
  /** 单张图片最大尺寸（字节），默认 5MB */
  maxImageSize?: number
  /** 最多提取图片数量，默认 20 */
  maxImageCount?: number
}

/**
 * 清理已提取的图片文件（用于回滚）
 * @param imagePaths 要删除的图片路径列表
 */
function cleanupImages(imagePaths: string[]): void {
  for (const imagePath of imagePaths) {
    try {
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath)
      }
    } catch (err) {
      console.warn(`[DocumentLoader] 清理图片失败: ${imagePath}`, err)
    }
  }
}

/**
 * 加载 DOCX 文档（增强版，支持图片提取）
 * 使用 mammoth 提取 HTML + 图片，turndown 转换为 Markdown
 *
 * **这是唯一没有换成 anydoc 的一条路，是有意的。** anydoc 的 Markdown 里图片
 * 只留 alt 文字，图片字节挂在 `toDocument()` 返回的 `document.assets` 上，两边
 * 靠 assetId 关联 —— 要把图片落盘再写回 Markdown 链接，就得自己实现一遍
 * anydoc 的 Markdown 序列化器。为了这一个功能重写它家的核心，代价远大于
 * 收益，而 mammoth 这条路今天就是好的。
 *
 * 所以分工是：**要图片走 mammoth，只要文字走 anydoc。**
 *
 * @param filePath DOCX 文件路径
 * @param options 图片提取配置
 */
async function loadDocxWithImages(
  filePath: string,
  options: ImageExtractOptions
): Promise<DocumentLoadResult> {
  const { imageDir, maxImageSize = 5 * 1024 * 1024, maxImageCount = 20 } = options

  // 边界检查：验证文件路径
  if (!filePath || typeof filePath !== 'string') {
    return { success: false, error: '无效的文件路径' }
  }

  // 边界检查：文件是否存在
  if (!fs.existsSync(filePath)) {
    return { success: false, error: '文件不存在' }
  }

  // 边界检查：文件是否可读
  try {
    fs.accessSync(filePath, fs.constants.R_OK)
  } catch {
    return { success: false, error: '文件无法读取（权限不足或被占用）' }
  }

  // 边界检查：文件大小（限制 100MB）
  try {
    const stats = fs.statSync(filePath)
    if (stats.size > 100 * 1024 * 1024) {
      return { success: false, error: 'DOCX 文件过大（超过 100MB 限制）' }
    }
    if (stats.size === 0) {
      return { success: false, error: '文件内容为空' }
    }
  } catch {
    return { success: false, error: '无法获取文件信息' }
  }

  // 允许的图片格式
  const allowedImageTypes = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff', 'svg']

  try {
    // 动态导入
    const mammoth = await import('mammoth')
    const TurndownService = (await import('turndown')).default

    // 确保图片目录存在
    try {
      if (!fs.existsSync(imageDir)) {
        fs.mkdirSync(imageDir, { recursive: true })
      }
      // 验证目录可写
      fs.accessSync(imageDir, fs.constants.W_OK)
    } catch (dirErr) {
      console.error('[DocumentLoader] 无法创建/访问图片目录:', dirErr)
      // 目录创建失败时，降级为不提取图片的模式
      console.log('[DocumentLoader] 降级为纯文本模式')
      const result = await mammoth.convertToHtml({ path: filePath })
      const TurndownFallback = (await import('turndown')).default
      const turndown = new TurndownFallback({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      return {
        success: true,
        content: turndown.turndown(result.value || ''),
        metadata: {
          source: filePath,
          title: path.basename(filePath, path.extname(filePath)),
          images: [],
          imageCount: 0,
          fallbackMode: true
        }
      }
    }

    const extractedImages: string[] = []
    let imageIndex = 0
    let skippedCount = 0

    // mammoth 配置：将内嵌图片保存为文件
    const mammothOptions = {
      convertImage: mammoth.images.imgElement(async (image) => {
        // 检查是否超过最大图片数量
        if (imageIndex >= maxImageCount) {
          if (skippedCount === 0) {
            console.log(`[DocumentLoader] 跳过图片：已达到最大数量 ${maxImageCount}`)
          }
          skippedCount++
          return { src: '' }
        }

        try {
          const buffer = await image.read()

          // 边界检查：空图片
          if (!buffer || buffer.length === 0) {
            console.log('[DocumentLoader] 跳过空图片')
            return { src: '' }
          }

          // 检查图片大小
          if (buffer.length > maxImageSize) {
            console.log(
              `[DocumentLoader] 跳过大图片：${(buffer.length / 1024 / 1024).toFixed(2)}MB > ${maxImageSize / 1024 / 1024}MB`
            )
            return { src: '' }
          }

          // 确定文件扩展名
          const contentType = image.contentType || 'image/png'
          const ext = contentType.split('/')[1]?.toLowerCase() || 'png'

          // 边界检查：过滤不支持的图片格式
          if (!allowedImageTypes.includes(ext)) {
            console.log(`[DocumentLoader] 跳过不支持的图片格式: ${ext}`)
            return { src: '' }
          }

          const filename = `${uuidv4()}.${ext}`
          const imagePath = path.join(imageDir, filename)

          // 写入文件
          try {
            fs.writeFileSync(imagePath, buffer)
          } catch (writeErr) {
            console.error(`[DocumentLoader] 图片写入失败 (${filename}):`, writeErr)
            return { src: '' }
          }

          extractedImages.push(imagePath)
          imageIndex++

          console.log(`[DocumentLoader] 提取图片 ${imageIndex}: ${filename}`)
          return { src: imagePath }
        } catch (err) {
          console.error('[DocumentLoader] 图片提取失败:', err)
          return { src: '' }
        }
      })
    }

    // 转换为 HTML
    const result = await mammoth.convertToHtml({ path: filePath }, mammothOptions)

    // 边界检查：mammoth 转换失败
    if (!result) {
      // 清理已提取的图片
      cleanupImages(extractedImages)
      return { success: false, error: 'DOCX 解析失败' }
    }

    if (!result.value || result.value.trim().length === 0) {
      // 清理已提取的图片
      cleanupImages(extractedImages)
      return {
        success: false,
        error: '文档内容为空'
      }
    }

    // HTML → Markdown
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced'
    })

    // 保留图片标签
    turndown.addRule('images', {
      filter: 'img',
      replacement: (_content, node) => {
        const img = node as HTMLElement
        const src = img.getAttribute('src') || ''
        const alt = img.getAttribute('alt') || '图片'
        if (!src) return ''
        return `![${alt}](${src})\n`
      }
    })

    const markdown = turndown.turndown(result.value)

    // 输出转换警告（如果有）
    if (result.messages && result.messages.length > 0) {
      console.log('[DocumentLoader] mammoth 转换警告:', result.messages)
    }

    // 记录跳过的图片数量
    if (skippedCount > 0) {
      console.log(`[DocumentLoader] 共跳过 ${skippedCount} 张图片（超出限制）`)
    }

    console.log(
      `[DocumentLoader] DOCX 增强加载完成: ${markdown.length} 字符, ${extractedImages.length} 张图片`
    )

    return {
      success: true,
      content: markdown,
      metadata: {
        source: filePath,
        title: path.basename(filePath, path.extname(filePath)),
        images: extractedImages,
        imageCount: extractedImages.length
      }
    }
  } catch (error) {
    console.error('[DocumentLoader] DOCX 增强加载失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '加载 DOCX 文件失败'
    }
  }
}

/**
 * 加载纯文本文件（TXT, MD, JSON, CSV 等）
 */
async function loadText(filePath: string): Promise<DocumentLoadResult> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')

    return {
      success: true,
      content,
      metadata: {
        source: filePath,
        title: path.basename(filePath, path.extname(filePath))
      }
    }
  } catch (error) {
    console.error('[DocumentLoader] 文本文件加载失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '加载文本文件失败'
    }
  }
}

/**
 * 常见的文本/配置文件名（无扩展名或特殊扩展名）
 * 这些文件通常是纯文本格式
 */
const KNOWN_TEXT_FILENAMES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.gitignore',
  '.dockerignore',
  '.eslintignore',
  '.prettierignore',
  '.npmignore',
  'Dockerfile',
  'Makefile',
  'README',
  'LICENSE',
  'CHANGELOG',
  'AUTHORS',
  'CONTRIBUTING'
]

/**
 * 检测文件是否为文本文件
 * 通过读取文件头部内容，检测是否包含二进制字符
 * @param filePath 文件路径
 * @param maxBytes 最多读取的字节数（默认 8KB）
 * @returns 是否为文本文件
 */
function isTextFile(filePath: string, maxBytes: number = 8192): boolean {
  try {
    // 检查文件名是否在已知文本文件列表中
    const fileName = path.basename(filePath)
    if (
      KNOWN_TEXT_FILENAMES.some(
        (name) => fileName === name || fileName.toLowerCase() === name.toLowerCase()
      )
    ) {
      return true
    }

    // 读取文件头部
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(Math.min(maxBytes, fs.statSync(filePath).size))
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
    fs.closeSync(fd)

    if (bytesRead === 0) {
      // 空文件视为文本
      return true
    }

    // 检测二进制字符
    // 文本文件通常不包含 NULL 字符（\x00）和其他控制字符
    for (let i = 0; i < bytesRead; i++) {
      const byte = buffer[i]
      // NULL 字符是二进制文件的强烈指示
      if (byte === 0) {
        return false
      }
      // 其他不可打印的控制字符（排除常见的 \t, \n, \r）
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
        return false
      }
    }

    return true
  } catch (error) {
    console.error('[DocumentLoader] 检测文本文件失败:', error)
    return false
  }
}

/**
 * 交给 anydoc 的二进制文档格式。
 *
 * 这份名单是从 `anydoc.formatFromExtension` 逐个问出来的，不是照文档抄的
 * （见同目录下的 documentLoader.test.ts，那条测试会拿真的 anydoc 校验它）。
 * 之所以在这里硬写一份而不是运行时调 anydoc：`document:isSupported` 每拖一个
 * 文件就会被问一次，为一个布尔值把 8MB 的原生模块加载进来不值得。
 */
export const ANYDOC_EXTENSIONS = new Set([
  // Word
  'doc',
  'docx',
  'docm',
  // PowerPoint
  'ppt',
  'pps',
  'pot',
  'pptx',
  'pptm',
  'ppsx',
  'ppsm',
  // Excel
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  // OpenDocument
  'odt',
  'ods',
  'odp',
  // 其他
  'rtf',
  'epub',
  'pdf'
])

/**
 * 直接按 UTF-8 读出来就行的格式。
 *
 * 注意 `rtf` **不在这里** —— 它以前在，于是知识库里存进去的是一堆
 * `\rtf1\ansi\deff0...` 控制字，用户看到的是乱码。现在它归 anydoc。
 */
export const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'xml',
  'yaml',
  'yml',
  'env',
  'ini',
  'conf',
  'cfg',
  'properties',
  'toml',
  'js',
  'ts',
  'jsx',
  'tsx',
  'vue',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'scala',
  'sh',
  'bash',
  'zsh',
  'bat',
  'ps1',
  'sql',
  'r',
  'lua',
  'pl',
  'pm',
  'css',
  'scss',
  'sass',
  'less',
  'styl',
  'html',
  'htm',
  'svg',
  'log',
  'diff',
  'patch'
])

/**
 * 根据文件类型自动选择加载器并加载文档
 */
export async function loadDocument(filePath: string): Promise<DocumentLoadResult> {
  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    return {
      success: false,
      error: '文件不存在'
    }
  }

  const ext = getExtension(filePath)

  // 音频文件格式检测 - 需要使用音频分析 API
  const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'aiff', 'ape']
  if (AUDIO_EXTENSIONS.includes(ext)) {
    // 检查文件大小（限制 100MB）
    try {
      const stats = fs.statSync(filePath)
      if (stats.size > 100 * 1024 * 1024) {
        return {
          success: false,
          error: '音频文件过大（超过 100MB 限制）',
          metadata: { isAudio: true, source: filePath }
        }
      }
    } catch {
      // 忽略统计错误
    }

    return {
      success: false,
      error: '音频文件需要使用 AI 分析',
      metadata: {
        source: filePath,
        title: path.basename(filePath, path.extname(filePath)),
        isAudio: true,
        audioFormat: ext
      }
    }
  }

  // 纯文本优先：这些格式本来就是文字，没必要绕一趟文档解析器。
  // CSV 也留在这里 —— anydoc 能把它转成 Markdown 表格，但原样的 CSV 同样好用
  // 且更省体积，没有理由为此改变已有行为。
  if (TEXT_EXTENSIONS.has(ext)) {
    return loadText(filePath)
  }

  // 二进制文档统一走 anydoc
  if (ANYDOC_EXTENSIONS.has(ext)) {
    return withTimeout(
      loadWithAnydoc(filePath),
      ANYDOC_PARSE_TIMEOUT_MS,
      `${ext.toUpperCase()} 解析超时，请重试`
    )
  }

  // 兜底：没见过的扩展名，嗅一下是不是纯文本
  if (isTextFile(filePath)) {
    console.log(`[DocumentLoader] 自动检测到文本文件: ${filePath}`)
    return loadText(filePath)
  }

  return {
    success: false,
    error: `暂不支持的文件类型: .${ext || '(无扩展名)'}`
  }
}

/**
 * 报给界面的「支持的扩展名」。
 *
 * 只列**常见到值得出现在文件选择器里**的那些：全部二进制文档，加上一批
 * 日常会往知识库里拖的文本格式。TEXT_EXTENSIONS 里那些源码后缀不在此列，
 * 但它们依然能加载 —— isSupported 会走到嗅探那一步。
 */
const SUPPORTED_EXTENSIONS = [
  ...ANYDOC_EXTENSIONS,
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'xml',
  'yaml',
  'yml'
]

/**
 * 检查文件类型是否支持
 * 首先检查扩展名是否在已知列表中，如果不在则尝试自动检测是否为文本文件
 */
function isSupported(filePath: string): boolean {
  const ext = getExtension(filePath)
  if (ANYDOC_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext)) {
    return true
  }
  // 尝试自动检测是否为文本文件
  return isTextFile(filePath)
}

/**
 * 注册文档加载器 IPC 处理器
 */
export function registerDocumentLoaderIPC(): void {
  console.log('[DocumentLoader] 注册文档加载器 IPC 处理器')

  /**
   * 加载文档
   * @param filePath - 文件的绝对路径
   */
  ipcMain.handle('document:load', async (_event, filePath: string): Promise<DocumentLoadResult> => {
    console.log('[DocumentLoader] 收到加载文档请求:', filePath)

    if (!filePath || typeof filePath !== 'string') {
      return {
        success: false,
        error: '请提供有效的文件路径'
      }
    }

    const result = await loadDocument(filePath)
    console.log(
      '[DocumentLoader] 加载结果:',
      result.success ? `成功 (${result.content?.length} 字符)` : result.error
    )
    return result
  })

  /**
   * 检查文件类型是否支持
   * @param filePath - 文件路径
   */
  ipcMain.handle('document:isSupported', async (_event, filePath: string): Promise<boolean> => {
    return isSupported(filePath)
  })

  /**
   * 获取支持的文件扩展名列表
   */
  ipcMain.handle('document:getSupportedExtensions', async (): Promise<string[]> => {
    return SUPPORTED_EXTENSIONS
  })

  /**
   * 加载文档（增强版，支持图片提取）
   * @param filePath - 文件的绝对路径
   * @param options - 配置选项
   * @param options.notebookId - 知识库 ID，用于生成图片存储路径
   * @param options.extractImages - 是否提取图片，默认 true
   */
  ipcMain.handle(
    'document:loadWithImages',
    async (
      _event,
      filePath: string,
      options: { notebookId: string; extractImages?: boolean }
    ): Promise<DocumentLoadResult> => {
      console.log('[DocumentLoader] 收到增强加载请求:', filePath, options)

      if (!filePath || typeof filePath !== 'string') {
        return {
          success: false,
          error: '请提供有效的文件路径'
        }
      }

      if (!options?.notebookId) {
        return {
          success: false,
          error: '请提供 notebookId'
        }
      }

      // 检查文件是否存在
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          error: '文件不存在'
        }
      }

      const ext = getExtension(filePath)

      // 目前只有 DOCX 支持图片提取
      if (ext === 'docx' && options.extractImages !== false) {
        // 生成图片存储目录
        const imageDir = path.join(
          app.getPath('userData'),
          'uploads',
          'notebook',
          options.notebookId,
          'images'
        )

        console.log('[DocumentLoader] 图片存储目录:', imageDir)

        const result = await withTimeout(
          loadDocxWithImages(filePath, { imageDir }),
          DOCX_IMAGE_PARSE_TIMEOUT_MS,
          'DOCX 图文解析超时，请重试'
        )
        console.log(
          '[DocumentLoader] 增强加载结果:',
          result.success
            ? `成功 (${result.content?.length} 字符, ${result.metadata?.imageCount || 0} 图片)`
            : result.error
        )
        return result
      }

      // 其他格式使用普通加载
      const result = await loadDocument(filePath)
      console.log(
        '[DocumentLoader] 普通加载结果:',
        result.success ? `成功 (${result.content?.length} 字符)` : result.error
      )
      return result
    }
  )
}
