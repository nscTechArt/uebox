/**
 * YouTube 视频分析 IPC 处理器
 * 用于在主进程中调用服务端 API 分析 YouTube 视频内容
 * 供知识库添加 YouTube 来源使用
 */
import { ipcMain } from 'electron'
import {
  YOUTUBE_KEY_HINT,
  analyzeYouTubeLocally
} from '../../services/videoAnalysis/localVideoAnalysis'

/**
 * YouTube 分析请求参数接口
 */
interface YouTubeAnalyzeParams {
  /** YouTube 视频 URL */
  url: string
  /** 自定义分析提示词（可选） */
  prompt?: string
  /** 认证 Token */
}

/**
 * YouTube 分析结果接口
 */
interface YouTubeAnalyzeResult {
  success: boolean
  /** 分析结果（Markdown 格式） */
  content?: string
  /** 视频标题 */
  title?: string
  /** YouTube 视频 ID */
  videoId?: string
  /** 规范化后的 YouTube URL */
  url?: string
  /** 错误信息 */
  error?: string
}

/**
 * 调用服务端 YouTube 分析 API
 */
async function analyzeYouTubeVideo(params: YouTubeAnalyzeParams): Promise<YouTubeAnalyzeResult> {
  const { url, prompt } = params

  if (!url || typeof url !== 'string') {
    return {
      success: false,
      error: '请提供有效的 YouTube 视频 URL'
    }
  }

  // 用户自己配了 Gemini 的 Key 就直连 —— 服务端那条路做的也是同一件事：
  // 把 YouTube 链接丢给 Gemini 的 fileData
  const local = await analyzeYouTubeLocally(url, prompt)
  if (local) {
    if (!local.success) return { success: false, error: local.error }
    return { success: true, content: local.content, title: local.title, url }
  }

  return { success: false, error: YOUTUBE_KEY_HINT }
}

/**
 * 验证 YouTube URL 格式
 */
function isValidYouTubeUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false

  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname.toLowerCase()

    // 支持的 YouTube 域名
    const validHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']

    if (hostname === 'youtu.be') {
      // 短链接格式：https://youtu.be/VIDEO_ID
      return urlObj.pathname.length > 1
    }

    if (validHosts.includes(hostname)) {
      // 标准格式：需要有 v 参数
      if (urlObj.pathname === '/watch') {
        return urlObj.searchParams.has('v')
      }
      // embed 格式
      if (urlObj.pathname.startsWith('/embed/')) {
        return urlObj.pathname.length > 7
      }
      // shorts 格式
      if (urlObj.pathname.startsWith('/shorts/')) {
        return urlObj.pathname.length > 8
      }
    }

    return false
  } catch {
    return false
  }
}

/**
 * 从 YouTube URL 中提取视频 ID
 */
function extractVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname.toLowerCase()

    if (hostname === 'youtu.be') {
      return urlObj.pathname.slice(1).split('?')[0]
    }

    if (urlObj.pathname === '/watch') {
      return urlObj.searchParams.get('v')
    }

    if (urlObj.pathname.startsWith('/embed/')) {
      return urlObj.pathname.slice(7).split('?')[0]
    }

    if (urlObj.pathname.startsWith('/shorts/')) {
      return urlObj.pathname.slice(8).split('?')[0]
    }

    return null
  } catch {
    return null
  }
}

/**
 * 注册 YouTube 分析 IPC 处理器
 */
export function registerYouTubeIPC(): void {
  console.log('[YouTubeIPC] 注册 YouTube 分析 IPC 处理器')

  /**
   * 分析 YouTube 视频
   * @param params - 分析参数（url, prompt?）
   */
  ipcMain.handle(
    'youtube:analyze',
    async (_event, params: YouTubeAnalyzeParams): Promise<YouTubeAnalyzeResult> => {
      console.log('[YouTubeIPC] 收到分析请求:', params?.url)

      if (!params || typeof params !== 'object') {
        return {
          success: false,
          error: '无效的请求参数'
        }
      }

      return await analyzeYouTubeVideo(params)
    }
  )

  /**
   * 验证 YouTube URL 格式
   * @param url - 待验证的 URL
   */
  ipcMain.handle('youtube:validate', async (_event, url: string): Promise<boolean> => {
    return isValidYouTubeUrl(url)
  })

  /**
   * 提取 YouTube 视频 ID
   * @param url - YouTube 视频 URL
   */
  ipcMain.handle('youtube:extractId', async (_event, url: string): Promise<string | null> => {
    return extractVideoId(url)
  })
}
