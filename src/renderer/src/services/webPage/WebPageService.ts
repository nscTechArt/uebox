/**
 * 网页生成服务
 *
 * 把知识库内容做成一个单页网页。生成在本地跑（见 `notebookTaskRunners`），
 * 模型是用户自己在 设置 → AI 里配的那个。
 *
 * **没有分享。** 分享是把 HTML 传到官方服务端换一个公开链接，社区版没有那台
 * 服务器；曾经这里还有 `shareWebPage` / `getShareInfo` / `revokeWebPage` 三个
 * 方法，打的是官方的 notebooks/outputs/webpage 接口，界面上的分享按钮点下去
 * 必然报错。网页本身不受影响：生成、预览、下载、复制都是本地能力。
 */

import type { WebPageState } from './types'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import { getLocale } from '@renderer/i18n'
import { ref, type Ref } from 'vue'
import {
  getNotebookTaskService,
  toTaskSources,
  TaskCancelledError,
  type WebpageResult,
  type TaskSource
} from '../notebook/NotebookTaskService'

export class WebPageService {
  /** 响应式状态 */
  public state: Ref<WebPageState>

  constructor() {
    this.state = ref({
      status: 'idle',
      progress: 0,
      message: ''
    })
  }

  /**
   * 更新状态
   */
  private updateState(updates: Partial<WebPageState>): void {
    this.state.value = { ...this.state.value, ...updates }
  }

  /**
   * 用 DOMParser 修一遍 HTML 结构。
   *
   * 模型生成的页面时常有未闭合标签、嵌套错位，浏览器解析一遍再序列化回来就正了。
   */
  private sanitizeHtml(html: string): string {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      if (doc.querySelector('parsererror')) {
        console.warn('[WebPageService] HTML 解析有警告，但继续处理')
      }
      return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
    } catch (error) {
      console.error('[WebPageService] HTML 修复失败，返回原始内容:', error)
      return html
    }
  }

  /**
   * 生成网页
   * @param sources 知识库来源
   * @param messages 聊天消息
   * @param notebookId 知识库ID，用于取消作用域
   */
  async generateAsync(
    sources: SourceItem[],
    messages: ChatMessage[],
    notebookId?: string
  ): Promise<string | null> {
    try {
      this.updateState({
        status: 'analyzing',
        progress: 5,
        message: '正在分析知识要点...'
      })

      const taskSources: TaskSource[] = toTaskSources(sources)

      const taskMessages = messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : ''
      }))

      const locale = getLocale()
      const language = locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'

      const result = await getNotebookTaskService().executeTask<WebpageResult>(
        'webpage',
        taskSources,
        taskMessages,
        { language, notebookId },
        (progress) => {
          // 前 40% 是读材料出 Brief，之后才是排版
          this.updateState({
            status: progress < 40 ? 'analyzing' : 'generating',
            progress: Math.max(10, progress),
            message: progress < 40 ? '正在分析知识要点...' : '正在生成网页...'
          })
        }
      )

      if (!result?.htmlContent) {
        throw new Error('生成的内容为空')
      }

      const html = this.sanitizeHtml(result.htmlContent)

      this.updateState({
        status: 'completed',
        progress: 100,
        message: '网页生成完成',
        htmlContent: html
      })

      return html
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        console.log('[WebPageService] 生成已取消')
        this.updateState({ status: 'idle', progress: 0, message: '' })
        return null
      }

      console.error('[WebPageService] 生成失败:', error)
      this.updateState({
        status: 'failed',
        error: error instanceof Error ? error.message : '未知错误'
      })
      return null
    }
  }

  /**
   * 只重置这个服务自己的状态。
   *
   * **不取消任何任务。** 这里曾经调 `cancelNotebookTask()` —— 那是个全局取消，
   * 会 abort 掉所有知识库的所有产出。而面板每次生成网页前都会先 `reset()`，
   * 于是「思维导图跑到一半时点网页」会把思维导图一起掐掉。
   *
   * 重复点同一个产出不需要在这里防：`executeTask` 进来第一件事就是按
   * `知识库id:类型` 掐掉上一次。
   */
  reset(): void {
    this.state.value = { status: 'idle', progress: 0, message: '' }
  }
}

/**
 * 创建服务实例
 */
export function createWebPageService(): WebPageService {
  return new WebPageService()
}
