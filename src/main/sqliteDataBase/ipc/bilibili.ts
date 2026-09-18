/**
 * Bilibili 视频分析 IPC 处理器
 * 用于在主进程中调用服务端 API 分析 Bilibili 视频内容
 * 供知识库添加 Bilibili 来源使用
 */
import { ipcMain } from 'electron'
import {
  extractRealVideoUrl,
  isValidBilibiliUrl,
  resolveBilibiliVideoUrl
} from '../../services/videoAnalysis/bilibiliVideoSource'
export { resolveBilibiliVideoUrl } from '../../services/videoAnalysis/bilibiliVideoSource'
import { VISION_KEY_HINT, analyzeUrl } from '../../services/dashscope/urlAnalyzer'

/**
 * 正在分析中的任务 Map（按 URL 去重）
 * key: 视频 URL, value: 分析任务的 Promise
 * 如果同一个 URL 正在分析中，新请求会复用已有的 Promise
 */
const pendingAnalysisTasks = new Map<string, Promise<BilibiliAnalyzeResult>>()

/**
 * Bilibili 分析请求参数接口
 */
interface BilibiliAnalyzeParams {
  /** Bilibili 视频 URL */
  url: string
  /** 自定义分析提示词（可选） */
  prompt?: string
  /** 认证 Token */
}

/**
 * Bilibili 分析结果接口
 */
interface BilibiliAnalyzeResult {
  success: boolean
  /** 分析结果（Markdown 格式） */
  content?: string
  /** 视频标题 */
  title?: string
  /** Bilibili 视频 ID (BV号) */
  videoId?: string
  /** 真实视频地址 */
  realUrl?: string
  /** 错误信息 */
  error?: string
}

/**
 * Bilibili 视频元信息接口（快速获取，无需分析）
 */
interface BilibiliVideoInfo {
  success: boolean
  /** 视频标题 */
  title?: string
  /** 封面图 URL */
  pic?: string
  /** 视频描述 */
  desc?: string
  /** UP主信息 */
  owner?: {
    name: string
    face: string
    mid: number
  }
  /** 视频时长（秒） */
  duration?: number
  /** 视频 BV 号 */
  bvid?: string
  /** 错误信息 */
  error?: string
}

/**
 * 通过 B站 API 快速获取视频元信息
 * API: https://api.bilibili.com/x/web-interface/view?bvid=BVxxx
 * @param bvid - 视频 BV 号
 */
async function fetchVideoInfo(bvid: string): Promise<BilibiliVideoInfo> {
  if (!bvid || typeof bvid !== 'string') {
    return { success: false, error: '无效的 BV 号' }
  }

  // 确保 bvid 格式正确
  const cleanBvid = bvid.startsWith('BV') ? bvid : `BV${bvid}`

  try {
    console.log('[BilibiliIPC] 正在获取视频元信息:', cleanBvid)

    const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${cleanBvid}`
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: 'https://www.bilibili.com'
    }

    const res = await fetch(apiUrl, { headers })
    const json = await res.json()

    if (json.code !== 0) {
      console.log('[BilibiliIPC] B站 API 返回错误:', json.message)
      return { success: false, error: json.message || '获取视频信息失败' }
    }

    const data = json.data
    console.log('[BilibiliIPC] 成功获取视频信息:', data.title)

    return {
      success: true,
      title: data.title,
      pic: data.pic,
      desc: data.desc,
      owner: data.owner
        ? {
            name: data.owner.name,
            face: data.owner.face,
            mid: data.owner.mid
          }
        : undefined,
      duration: data.duration,
      bvid: data.bvid
    }
  } catch (error) {
    console.error('[BilibiliIPC] 获取视频信息失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络请求失败'
    }
  }
}

/**
 * 从 URL 提取 BV 号
 */
function extractBvid(url: string): string | null {
  const match = url.match(/BV[a-zA-Z0-9]+/)
  return match ? match[0] : null
}

/**
 * 调用服务端 Bilibili 分析 API
 */
async function analyzeBilibiliVideo(params: BilibiliAnalyzeParams): Promise<BilibiliAnalyzeResult> {
  const { url, prompt } = params

  if (!url || typeof url !== 'string') {
    return {
      success: false,
      error: '请提供有效的 Bilibili 视频 URL'
    }
  }

  // 检查是否已有相同 URL 正在分析中，如果有则复用已有的 Promise
  const existingTask = pendingAnalysisTasks.get(url)
  if (existingTask) {
    console.log('[BilibiliIPC] 复用已有分析任务:', url)
    return existingTask
  }

  // 创建新的分析任务
  const analysisTask = doAnalyzeBilibiliVideo(url, prompt)

  // 加入 pending map
  pendingAnalysisTasks.set(url, analysisTask)

  // 任务完成后从 map 中移除
  analysisTask.finally(() => {
    pendingAnalysisTasks.delete(url)
  })

  return analysisTask
}

/**
 * 实际执行 Bilibili 视频分析
 */
async function doAnalyzeBilibiliVideo(
  url: string,
  prompt?: string
): Promise<BilibiliAnalyzeResult> {
  console.log('[BilibiliIPC] 开始分析视频:', url)

  // 1. 先在客户端获取真实视频地址
  console.log('[BilibiliIPC] 正在获取视频真实地址...')
  const realUrl = await extractRealVideoUrl(url)

  if (!realUrl) {
    return {
      success: false,
      error: '无法获取视频真实地址，可能视频不存在或受限'
    }
  }

  console.log('[BilibiliIPC] 成功获取真实地址，开始分析...')

  const bvid = extractBvid(url)

  // 2. 拿到直链之后，剩下的就是普通的视频 URL 理解 —— 交给统一入口，
  //    B 站在这一步没有任何特殊之处。换用别家视觉模型也只需要改那一处。
  const local = await analyzeUrl(realUrl, prompt)
  if (local.error !== VISION_KEY_HINT) {
    if (!local.success) return { success: false, error: local.error }
    return {
      success: true,
      title: local.title,
      videoId: bvid || undefined,
      realUrl,
      content: local.content
    }
  }

  return { success: false, error: VISION_KEY_HINT }
}

/**
 * 从 Bilibili URL 中提取视频 ID
 */
function extractVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url)

    // 匹配 BV 号
    const bvMatch = urlObj.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/)
    if (bvMatch && bvMatch[1]) {
      return bvMatch[1]
    }

    // 匹配 av 号
    const avMatch = urlObj.pathname.match(/\/video\/(av\d+)/)
    if (avMatch && avMatch[1]) {
      return avMatch[1]
    }

    return null
  } catch {
    return null
  }
}

/**
 * 注册 Bilibili 分析 IPC 处理器
 */
export function registerBilibiliIPC(): void {
  console.log('[BilibiliIPC] 注册 Bilibili 分析 IPC 处理器')

  /**
   * 分析 Bilibili 视频
   * @param params - 分析参数（url, prompt?）
   */
  ipcMain.handle(
    'bilibili:analyze',
    async (_event, params: BilibiliAnalyzeParams): Promise<BilibiliAnalyzeResult> => {
      console.log('[BilibiliIPC] 收到分析请求:', params?.url)

      if (!params || typeof params !== 'object') {
        return {
          success: false,
          error: '无效的请求参数'
        }
      }

      return await analyzeBilibiliVideo(params)
    }
  )

  /**
   * 验证 Bilibili URL 格式
   * @param url - 待验证的 URL
   */
  ipcMain.handle('bilibili:validate', async (_event, url: string): Promise<boolean> => {
    return isValidBilibiliUrl(url)
  })

  /**
   * 提取 Bilibili 视频 ID
   * @param url - Bilibili 视频 URL
   */
  ipcMain.handle('bilibili:extractId', async (_event, url: string): Promise<string | null> => {
    return extractVideoId(url)
  })

  /** 只获取用于播放/展示的临时视频直链，不执行内容分析 */
  ipcMain.handle('bilibili:resolveVideoUrl', async (_event, url: string) => {
    return await resolveBilibiliVideoUrl(url)
  })

  /**
   * 快速获取视频元信息（标题、封面、描述等）
   * @param bvid - 视频 BV 号
   */
  ipcMain.handle('bilibili:fetchInfo', async (_event, bvid: string): Promise<BilibiliVideoInfo> => {
    console.log('[BilibiliIPC] 收到获取视频信息请求:', bvid)
    return await fetchVideoInfo(bvid)
  })
}
