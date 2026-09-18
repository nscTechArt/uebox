/**
 * 图片 URL 分析服务
 * 使用 qwen3-vl-flash 模型分析图片 URL 内容
 *
 * 支持直接分析 HTTP/HTTPS 图片 URL，无需先下载图片
 */

import https from 'https'
import http from 'http'
import { URL } from 'url'

/**
 * 图片分析结果接口
 */
export interface ImageAnalysisResult {
  success: boolean
  title?: string
  content?: string
  description?: string
  url?: string
  error?: string
}

/**
 * OpenAI 兼容格式消息内容类型
 */
interface MessageContent {
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
    url: string
  }
}

/**
 * OpenAI 兼容格式消息类型
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | MessageContent[]
}

/**
 * API 响应类型
 */
interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * 默认视觉模型
 */
const DEFAULT_VL_MODEL = 'qwen3-vl-flash'

/**
 * 默认图片分析提示词
 */
const DEFAULT_IMAGE_PROMPT = `你是一个图片内容分析助手。请分析这张图片并提供以下信息：

1. **图片主题**：用一句话概括图片的主要内容
2. **内容描述**：详细描述图片中展示的内容（100-300字）
3. **关键元素**：列出图片中的重要元素（人物、物体、场景等）
4. **关键词**：提取5-10个关键词用于检索

请使用 Markdown 格式输出，结构清晰易读。`

/**
 * 从 URL 提取标题
 * @param url - 图片 URL
 * @returns 提取的标题
 */
function extractTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    const filename = pathname.split('/').pop() || ''
    if (filename) {
      return decodeURIComponent(filename).replace(/\.[^.]+$/, '') || urlObj.hostname
    }
    return urlObj.hostname
  } catch {
    return 'Untitled Image'
  }
}

/**
 * 从 Markdown 内容中提取标题和描述
 * @param markdown - Markdown 格式的内容
 * @returns 标题和描述
 */
function extractTitleAndDescription(markdown: string): { title: string; description: string } {
  const topicMatch = markdown.match(/\*\*图片主题\*\*[：:]\s*(.+?)(?:\n|$)/i)
  const h1Match = markdown.match(/^#\s+(.+)$/m)

  let title = ''
  if (topicMatch) {
    title = topicMatch[1].trim()
  } else if (h1Match) {
    title = h1Match[1].trim()
  }

  const cleanContent = markdown
    .replace(/^#+\s+.+$/gm, '')
    .replace(/\*\*[^*]+\*\*/g, '')
    .trim()

  const description = cleanContent.slice(0, 200).trim()

  return { title, description }
}

/**
 * 分析图片 URL 内容
 *
 * @param imageUrl - 图片的 HTTP/HTTPS URL
 * @param options - 可选配置
 * @returns 分析结果
 */
export async function analyzeImageUrl(
  imageUrl: string,
  options?: {
    apiKey?: string
    modelName?: string
    prompt?: string
  }
): Promise<ImageAnalysisResult> {
  const apiKey = options?.apiKey || process.env.QWEN_API_KEY
  const modelName = options?.modelName || DEFAULT_VL_MODEL
  const prompt = options?.prompt || DEFAULT_IMAGE_PROMPT

  if (!apiKey) {
    return {
      success: false,
      error: '未配置 Qwen API Key，请在 .env 文件中设置 QWEN_API_KEY'
    }
  }

  // 验证 URL 格式。data: 也放行 —— 百炼兼容模式的 image_url 收 Base64 Data URL，
  // 本地文件与 PDF 页面就是这样送进来的（上限 10MB，见调用方注释）。
  try {
    const url = new URL(imageUrl)
    if (!['http:', 'https:', 'data:'].includes(url.protocol)) {
      return {
        success: false,
        error: '图片 URL 必须是 HTTP / HTTPS 或 Base64 Data URL'
      }
    }
  } catch {
    return {
      success: false,
      error: '无效的图片 URL 格式'
    }
  }

  console.log(`[ImageAnalyzer] 开始分析图片: ${imageUrl}`)
  console.log(`[ImageAnalyzer] 使用模型: ${modelName}`)

  // 构建请求消息
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: imageUrl }
        },
        {
          type: 'text',
          text: prompt
        }
      ]
    }
  ]

  // 调用 Qwen API
  return new Promise((resolve) => {
    const baseUrl = process.env.QWEN_BASE_URL
      ? `${process.env.QWEN_BASE_URL.replace(/\/$/, '')}/chat/completions`
      : 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    const parsedUrl = new URL(baseUrl)

    const requestBody = JSON.stringify({
      model: modelName,
      messages: messages
    })

    const requestOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: 120000 // 2 分钟超时
    }

    const httpModule = parsedUrl.protocol === 'https:' ? https : http
    let responseData = ''

    const request = httpModule.request(requestOptions, (response) => {
      response.on('data', (chunk: Buffer) => {
        responseData += chunk.toString()
      })

      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          try {
            const jsonResponse: ChatCompletionResponse = JSON.parse(responseData)
            const content = jsonResponse.choices?.[0]?.message?.content || ''

            if (!content) {
              resolve({
                success: false,
                error: '模型返回了空内容'
              })
              return
            }

            const { title, description } = extractTitleAndDescription(content)

            console.log(`[ImageAnalyzer] 分析成功，内容长度: ${content.length}`)

            resolve({
              success: true,
              title: title || extractTitleFromUrl(imageUrl),
              content: content,
              description: description,
              url: imageUrl
            })
          } catch (parseError) {
            console.error('[ImageAnalyzer] JSON 解析失败:', parseError)
            resolve({
              success: false,
              error: `响应解析失败: ${responseData.slice(0, 200)}`
            })
          }
        } else {
          console.error(
            `[ImageAnalyzer] API 返回错误: ${response.statusCode} - ${responseData.slice(0, 500)}`
          )
          resolve({
            success: false,
            error: `API 请求失败: HTTP ${response.statusCode} - ${response.statusMessage}`
          })
        }
      })

      response.on('error', (err: Error) => {
        console.error('[ImageAnalyzer] 响应错误:', err)
        resolve({
          success: false,
          error: `网络响应错误: ${err.message}`
        })
      })
    })

    request.on('error', (err: Error) => {
      console.error('[ImageAnalyzer] 请求错误:', err)
      resolve({
        success: false,
        error: `网络请求失败: ${err.message}`
      })
    })

    request.on('timeout', () => {
      request.destroy()
      console.error('[ImageAnalyzer] 请求超时')
      resolve({
        success: false,
        error: '图片分析请求超时（2分钟）'
      })
    })

    request.write(requestBody)
    request.end()
  })
}

/**
 * 检查 URL 是否为图片链接
 * @param url - 要检查的 URL
 * @returns 是否为图片 URL
 */
export function isImageUrl(url: string): boolean {
  const imageExtensions = [
    '.jpg',
    '.jpeg',
    '.jpe',
    '.png',
    '.gif',
    '.bmp',
    '.webp',
    '.ico',
    '.jp2',
    '.tif',
    '.tiff',
    '.heic',
    '.heif',
    '.svg'
  ]

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.toLowerCase()
    return imageExtensions.some((ext) => pathname.endsWith(ext))
  } catch {
    return false
  }
}

/**
 * 使用视觉模型为3D模型生成名称
 *
 * @param imageBase64OrUrl - 模型缩略图的 Base64 或 URL
 * @param options - 可选配置
 * @returns 生成的名称
 */
export async function generate3DModelName(
  imageBase64OrUrl: string,
  options?: {
    apiKey?: string
    modelName?: string
  }
): Promise<{ success: boolean; name?: string; error?: string }> {
  const apiKey = options?.apiKey || process.env.QWEN_API_KEY
  // 使用更轻量的 flash 模型加快速度（qwen3-vl-flash 为第三代视觉模型）
  const modelName = options?.modelName || 'qwen3-vl-flash'

  if (!apiKey) {
    return {
      success: false,
      error: '未配置 Qwen API Key'
    }
  }

  // 构建图片 URL（兼容 Base64 和 URL）
  let imageUrl: string
  if (imageBase64OrUrl.startsWith('data:')) {
    // 已经是 data URL
    imageUrl = imageBase64OrUrl
  } else if (imageBase64OrUrl.startsWith('http')) {
    // HTTP URL
    imageUrl = imageBase64OrUrl
  } else {
    // 纯 Base64，添加前缀
    imageUrl = `data:image/png;base64,${imageBase64OrUrl}`
  }

  console.log(`[ImageAnalyzer] 使用视觉模型为3D模型取名，模型: ${modelName}`)

  // 构建请求
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        {
          type: 'text',
          text: '为这个3D模型取一个具有辨识度的名字，3-8个字，直接输出名字不要任何其他内容'
        }
      ]
    }
  ]

  return new Promise((resolve) => {
    const baseUrl = process.env.QWEN_BASE_URL
      ? `${process.env.QWEN_BASE_URL.replace(/\/$/, '')}/chat/completions`
      : 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    const parsedUrl = new URL(baseUrl)

    const requestBody = JSON.stringify({
      model: modelName,
      messages: messages
    })

    const requestOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: 30000 // 30秒超时
    }

    let responseData = ''

    const request = https.request(requestOptions, (response) => {
      response.on('data', (chunk: Buffer) => {
        responseData += chunk.toString()
      })

      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          try {
            const jsonResponse: ChatCompletionResponse = JSON.parse(responseData)
            let name = jsonResponse.choices?.[0]?.message?.content || ''

            // 清理名称：去除引号、换行、多余空格
            name = name
              .replace(/["""'']/g, '')
              .replace(/\n/g, '')
              .trim()

            // 截取前20字符，清理非法文件名字符
            if (name.length > 20) {
              name = name.substring(0, 20)
            }
            name = name.replace(/[\\/:*?"<>|]/g, '_')

            if (!name) {
              resolve({ success: false, error: '模型返回空名称' })
              return
            }

            console.log(`[ImageAnalyzer] 3D模型命名成功: ${name}`)
            resolve({ success: true, name })
          } catch (parseError) {
            console.error('[ImageAnalyzer] JSON 解析失败:', parseError)
            resolve({ success: false, error: '响应解析失败' })
          }
        } else {
          console.error(
            `[ImageAnalyzer] API 错误: ${response.statusCode} - ${responseData.slice(0, 200)}`
          )
          resolve({ success: false, error: `API 请求失败: HTTP ${response.statusCode}` })
        }
      })

      response.on('error', (err: Error) => {
        resolve({ success: false, error: `网络错误: ${err.message}` })
      })
    })

    request.on('error', (err: Error) => {
      resolve({ success: false, error: `请求失败: ${err.message}` })
    })

    request.on('timeout', () => {
      request.destroy()
      resolve({ success: false, error: '请求超时' })
    })

    request.write(requestBody)
    request.end()
  })
}

/**
 * 使用LLM从Prompt生成语义化名称（用于文生模型）
 *
 * @param prompt - 用户输入的生成Prompt
 * @param options - 可选配置
 * @returns 生成的名称（3-8字）
 */
export async function generateNameFromPrompt(
  prompt: string,
  options?: {
    apiKey?: string
    modelName?: string
  }
): Promise<{ success: boolean; name?: string; error?: string }> {
  const apiKey = options?.apiKey || process.env.QWEN_API_KEY
  // 使用轻量快速的 qwen-flash 模型
  const modelName = options?.modelName || 'qwen-flash'

  if (!apiKey) {
    return {
      success: false,
      error: '未配置 Qwen API Key'
    }
  }

  if (!prompt || prompt.trim().length === 0) {
    return {
      success: false,
      error: 'Prompt不能为空'
    }
  }

  console.log(`[ImageAnalyzer] 使用LLM从Prompt生成名称，模型: ${modelName}`)

  // 构建请求
  const messages = [
    {
      role: 'user',
      content: `请从以下3D模型生成描述中提取一个简洁的名称，3-8个中文字，直接输出名称不要任何其他内容：

${prompt}`
    }
  ]

  return new Promise((resolve) => {
    const baseUrl = process.env.QWEN_BASE_URL
      ? `${process.env.QWEN_BASE_URL.replace(/\/$/, '')}/chat/completions`
      : 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    const parsedUrl = new URL(baseUrl)

    const requestBody = JSON.stringify({
      model: modelName,
      messages: messages
    })

    const requestOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: 15000 // 15秒超时（文本处理较快）
    }

    let responseData = ''

    const request = https.request(requestOptions, (response) => {
      response.on('data', (chunk: Buffer) => {
        responseData += chunk.toString()
      })

      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          try {
            const jsonResponse: ChatCompletionResponse = JSON.parse(responseData)
            let name = jsonResponse.choices?.[0]?.message?.content || ''

            // 清理名称：去除引号、换行、多余空格
            name = name.replace(/["']/g, '').replace(/\n/g, '').trim()

            // 截取前20字符，清理非法文件名字符
            if (name.length > 20) {
              name = name.substring(0, 20)
            }
            name = name.replace(/[\\/:*?"<>|]/g, '_')

            if (!name) {
              resolve({ success: false, error: '模型返回空名称' })
              return
            }

            console.log(`[ImageAnalyzer] Prompt命名成功: ${name}`)
            resolve({ success: true, name })
          } catch (parseError) {
            console.error('[ImageAnalyzer] JSON 解析失败:', parseError)
            resolve({ success: false, error: '响应解析失败' })
          }
        } else {
          console.error(
            `[ImageAnalyzer] API 错误: ${response.statusCode} - ${responseData.slice(0, 200)}`
          )
          resolve({ success: false, error: `API 请求失败: HTTP ${response.statusCode}` })
        }
      })

      response.on('error', (err: Error) => {
        resolve({ success: false, error: `网络错误: ${err.message}` })
      })
    })

    request.on('error', (err: Error) => {
      resolve({ success: false, error: `请求失败: ${err.message}` })
    })

    request.on('timeout', () => {
      request.destroy()
      resolve({ success: false, error: '请求超时' })
    })

    request.write(requestBody)
    request.end()
  })
}

export default {
  analyzeImageUrl,
  isImageUrl,
  generate3DModelName,
  generateNameFromPrompt
}
