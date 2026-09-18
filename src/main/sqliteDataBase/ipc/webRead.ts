/**
 * 「把一个网址读成正文」的 IPC。
 *
 * 知识库添加来源时用它：给一个网址，回一段能进库的正文。
 *
 * ## 这里原来叫 jina.ts
 *
 * 它曾经有三条通向 Jina 的路：Reader（`r.jina.ai`）、Search（`s.jina.ai`）、
 * 还有一个查 Key 配没配的 `jina:check`。三条都删了：
 *
 *   - **Search** 随知识库那两个搜索页签一起下线 —— 查资料现在是 Agent 的活
 *     （`services/webSearch.ts` + `agent-v3/tools/builtin/web.ts`）。Jina 在那边
 *     仍然是一个可选的检索 Provider，用户想用自己的 Key 换速度就绑上；
 *   - **Reader** 下线是因为本地那条已经够了（`services/webReader.ts`：cheerio 剥噪声、
 *     turndown 转 Markdown），而且它对用户是**零配置**的。留着 Reader 等于同一件事
 *     两套实现，其中一套还要求用户先去申请一个 Key。
 *
 * 差距要如实说：Jina Reader 能跑 JS、能处理 PDF、有反爬绕过，本地这条只处理静态
 * HTML。纯前端渲染的页面会读不到正文并给出明确提示 —— 那种页面交给 Agent 浏览器
 * （`browser_open`，真 Chromium）。用一条零配置、说得清边界的路，换掉一条要 Key
 * 又只多覆盖一小撮页面的路，这笔账划算。
 *
 * 图片、视频这类文件 URL 仍然走视觉分析（`dashscope/urlAnalyzer`，用户自己的百炼 Key）。
 */
import { ipcMain } from 'electron'

import { analyzeUrl, isFileUrl } from '../../services/dashscope/urlAnalyzer'
import { readWebPageLocally } from '../../services/webReader'

interface WebReadResult {
  success: boolean
  title?: string
  content?: string
  description?: string
  url?: string
  error?: string
}

export function registerWebReadIPC(): void {
  /**
   * 读取网页内容（图片/视频这类文件 URL 交给视觉分析）
   * @param params.url - 目标 URL（必需）
   */
  ipcMain.handle(
    'web:read',
    async (_event, params: string | { url: string }): Promise<WebReadResult> => {
      // 两种调用形状都认：渲染层历史上直接传字符串
      const targetUrl = typeof params === 'string' ? params : params?.url

      if (!targetUrl || typeof targetUrl !== 'string') {
        return { success: false, error: '请提供有效的 URL' }
      }

      if (isFileUrl(targetUrl)) {
        const result = await analyzeUrl(targetUrl)

        // `__USE_JINA__` 是 urlAnalyzer 的老约定：它判出来这其实是个网页，
        // 让调用方走网页那条路。名字留着不改 —— 改它要动 urlAnalyzer，
        // 而那个文件还有别的调用方
        if (result.error !== '__USE_JINA__') return result
      }

      const result = await readWebPageLocally(targetUrl)
      if (!result.success) {
        console.warn(`[WebRead] 读取失败 ${targetUrl}：${result.error}`)
      }
      /*
       * `agentHint` 明确不往渲染层送。
       *
       * 那个字段是写给模型的下一步（「改用 browser_open 打开它」），而这条路的
       * 终点是知识库来源条下那行红字 —— 用户读到一句让他去调用一个他根本看不见的
       * 工具的话，只会更困惑。类型上不带它已经够了，这里显式剥掉是因为它
       * 运行时仍在对象上：将来有人把返回值换成 `any` 就漏出去了。
       */
      return {
        success: result.success,
        ...(result.title !== undefined ? { title: result.title } : {}),
        ...(result.content !== undefined ? { content: result.content } : {}),
        ...(result.description !== undefined ? { description: result.description } : {}),
        ...(result.url !== undefined ? { url: result.url } : {}),
        ...(result.error !== undefined ? { error: result.error } : {})
      }
    }
  )

  console.log('[WebRead IPC] 处理器已注册')
}
