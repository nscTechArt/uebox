/**
 * 微信公众号文章采集 IPC 处理器
 * 参考 wechatmp2markdown 实现，使用纯 HTTP + cheerio 解析微信文章
 * 将文章转换为 Markdown 格式供知识库使用
 */
import { ipcMain } from 'electron'
import * as cheerio from 'cheerio'

/**
 * 微信文章读取结果接口
 */
interface WechatReadResult {
  success: boolean
  /** 文章标题 */
  title?: string
  /** Markdown 格式的文章内容 */
  content?: string
  /** 公众号名称 */
  author?: string
  /** 发布时间 */
  publishTime?: string
  /** 错误信息 */
  error?: string
}

/**
 * 验证是否为有效的微信公众号文章 URL
 * @param url 待验证的 URL
 */
function isValidWechatUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false

  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname.toLowerCase()
    // 支持的微信域名
    return hostname === 'mp.weixin.qq.com'
  } catch {
    return false
  }
}

/**
 * 从微信文章 HTML 中提取发布时间
 * 微信将发布时间存储在 script 标签中的 var ct = "xxx"
 * @param html 完整的 HTML 内容
 */
function extractPublishTime(html: string): string | null {
  const match = html.match(/var\s+ct\s*=\s*"(\d+)"/)
  if (match && match[1]) {
    const timestamp = parseInt(match[1], 10)
    const date = new Date(timestamp * 1000)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }
  return null
}

/**
 * 读取微信公众号文章内容
 * @param url 微信文章 URL
 */
async function readWechatArticle(url: string): Promise<WechatReadResult> {
  if (!isValidWechatUrl(url)) {
    return {
      success: false,
      error: '无效的微信公众号文章链接，请确保链接以 mp.weixin.qq.com 开头'
    }
  }

  try {
    console.log('[WechatIPC] 开始获取文章:', url)

    // 1. HTTP GET 请求文章页面
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache'
      }
    })

    if (!response.ok) {
      return {
        success: false,
        error: `请求失败: HTTP ${response.status}`
      }
    }

    const html = await response.text()

    // 检查是否触发了验证页面
    if (html.includes('环境异常') || html.includes('完成验证')) {
      return {
        success: false,
        error: '微信检测到异常访问，请稍后重试或使用其他方式添加'
      }
    }

    // 2. 使用 cheerio 解析 HTML
    const $ = cheerio.load(html)

    // 3. 提取文章标题
    const title = $('#activity-name').text().trim()
    if (!title) {
      return {
        success: false,
        error: '无法解析文章标题，可能不是有效的微信公众号文章'
      }
    }

    // 4. 提取公众号名称
    const author =
      $('#js_name').text().trim() || $('meta[property="og:article:author"]').attr('content') || ''

    // 5. 提取发布时间
    const publishTime = extractPublishTime(html)

    // 6. 提取正文 HTML
    const contentElement = $('#js_content')
    if (!contentElement.length) {
      return {
        success: false,
        error: '无法解析文章正文'
      }
    }

    // 7. 处理图片：将 data-src 替换为 src，保留原文图片地址
    const images = contentElement.find('img')
    console.log(`[WechatIPC] 发现 ${images.length} 张图片`)

    for (let i = 0; i < images.length; i++) {
      const img = images.eq(i)
      const dataSrc = img.attr('data-src')
      if (dataSrc) {
        img.attr('src', dataSrc.startsWith('//') ? 'https:' + dataSrc : dataSrc)
        img.removeAttr('data-src')
      }
    }

    // 8. 使用 Turndown 将 HTML 转换为 Markdown
    //    懒加载：采集公众号文章是低频动作，没必要为它在每次启动时加载 turndown
    const TurndownService = (await import('turndown')).default
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-'
    })

    // 自定义规则：保留图片的 alt 和 title
    turndownService.addRule('images', {
      filter: 'img',
      replacement: (_content, node) => {
        const element = node as Element
        const src = element.getAttribute('src') || ''
        const alt = element.getAttribute('alt') || ''
        const title = element.getAttribute('title') || ''
        if (title) {
          return `![${alt}](${src} "${title}")`
        }
        return `![${alt}](${src})`
      }
    })

    const contentHtml = contentElement.html() || ''
    const markdown = turndownService.turndown(contentHtml)

    // 9. 构建完整的 Markdown 内容
    const metaInfo: string[] = []
    if (author) metaInfo.push(`**作者**: ${author}`)
    if (publishTime) metaInfo.push(`**发布时间**: ${publishTime}`)

    const fullContent = [
      `# ${title}`,
      '',
      metaInfo.length > 0 ? metaInfo.join(' | ') : '',
      metaInfo.length > 0 ? '' : '',
      '---',
      '',
      markdown
    ]
      .filter((line) => line !== undefined)
      .join('\n')

    console.log(`[WechatIPC] 文章解析成功: ${title} (${fullContent.length} 字符)`)

    return {
      success: true,
      title,
      content: fullContent,
      author,
      publishTime: publishTime || undefined
    }
  } catch (error) {
    console.error('[WechatIPC] 文章解析异常:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '未知错误'
    }
  }
}

/**
 * 注册微信公众号文章采集 IPC 处理器
 */
export function registerWechatIPC(): void {
  console.log('[WechatIPC] 注册微信公众号文章采集 IPC 处理器')

  /**
   * 读取微信公众号文章
   * @param url 文章链接
   */
  ipcMain.handle('wechat:read', async (_event, url: string): Promise<WechatReadResult> => {
    console.log('[WechatIPC] 收到读取请求:', url)

    if (!url || typeof url !== 'string') {
      return {
        success: false,
        error: '请提供有效的微信公众号文章链接'
      }
    }

    return await readWechatArticle(url)
  })

  /**
   * 验证微信公众号文章 URL
   * @param url 待验证的 URL
   */
  ipcMain.handle('wechat:validate', async (_event, url: string): Promise<boolean> => {
    return isValidWechatUrl(url)
  })
}
