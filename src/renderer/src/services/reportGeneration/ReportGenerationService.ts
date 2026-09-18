/**
 * 报告生成服务
 * 调用 AI 接口将知识库内容转换为结构化报告
 */

import type { ReportState } from './types'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import { ref, type Ref } from 'vue'
import { getLocale } from '@renderer/i18n'
import {
  getNotebookTaskService,
  toTaskSources,
  TaskCancelledError,
  type TaskSource,
  type TaskMessage,
  type ReportResult
} from '../notebook/NotebookTaskService'

/**
 * 报告生成服务类
 */
export class ReportGenerationService {
  public state: Ref<ReportState>

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
  private updateState(updates: Partial<ReportState>): void {
    this.state.value = { ...this.state.value, ...updates }
  }

  /**
   * 生成报告 (异步任务模式)
   * @param sources 知识库来源
   * @param messages 聊天消息
   * @param notebookTitle 知识库标题
   * @param notebookId 知识库ID，用于任务取消作用域
   */
  async generateAsync(
    sources: SourceItem[],
    messages: ChatMessage[],
    notebookTitle: string,
    notebookId?: string
  ): Promise<string | null> {
    try {
      this.updateState({
        status: 'collecting',
        progress: 5,
        message: '正在准备生成报告...'
      })

      if (!sources || sources.length === 0) {
        this.updateState({
          status: 'failed',
          progress: 0,
          message: '没有可用的内容',
          error: '知识库为空，请先添加一些来源'
        })
        return null
      }

      const taskSources: TaskSource[] = toTaskSources(sources)

      const taskMessages: TaskMessage[] = messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      }))

      const taskService = getNotebookTaskService()

      // Get locale for bilingual content generation
      const locale = getLocale()
      const language = locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'

      // Execute async task with progress callback
      const result = await taskService.executeTask<ReportResult>(
        'report',
        taskSources,
        taskMessages,
        { notebookTitle, language, notebookId },
        (progress) => {
          this.updateState({
            status: 'generating',
            progress: Math.max(10, progress),
            message: '正在撰写报告...'
          })
        }
      )

      if (!result?.content) {
        throw new Error('生成的内容为空')
      }

      const content = result.content.trim()

      this.updateState({
        status: 'completed',
        progress: 100,
        message: '报告生成完成',
        reportContent: content
      })

      return content
    } catch (error) {
      console.error('[ReportService] 异步生成失败:', error)

      let errorMessage = '生成失败'
      if (error instanceof TaskCancelledError) {
        errorMessage = '生成已取消'
      } else if (error instanceof Error) {
        errorMessage = error.message
      }

      this.updateState({
        status: 'failed',
        progress: 0,
        message: errorMessage,
        error: errorMessage
      })
      return null
    }
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.state.value = {
      status: 'idle',
      progress: 0,
      message: ''
    }
  }
}

/**
 * 创建报告生成服务实例
 */
export function createReportGenerationService(): ReportGenerationService {
  return new ReportGenerationService()
}

/**
 * 创建服务实例
 */
export function createReportService(): ReportGenerationService {
  return new ReportGenerationService()
}
