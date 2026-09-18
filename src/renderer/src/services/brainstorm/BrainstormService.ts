/**
 * 头脑风暴生成服务
 * 基于知识库内容进行创意发散与想法生成
 */

import type { BrainstormState, BrainstormSession, BrainstormIdea, IdeaCategory } from './types'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import { ref, type Ref } from 'vue'
import {
  getNotebookTaskService,
  toTaskSources,
  TaskCancelledError,
  type TaskSource,
  type TaskMessage,
  type BrainstormResult
} from '../notebook/NotebookTaskService'

/**
 * 验证分类是否有效
 */
function isValidCategory(category: string): category is IdeaCategory {
  const validCategories: IdeaCategory[] = [
    'innovation',
    'improvement',
    'exploration',
    'risk',
    'opportunity',
    'question'
  ]
  return validCategories.includes(category as IdeaCategory)
}

/**
 * 头脑风暴服务类
 */
export class BrainstormService {
  public state: Ref<BrainstormState>

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
  private updateState(updates: Partial<BrainstormState>): void {
    this.state.value = { ...this.state.value, ...updates }
  }

  /**
   * 生成头脑风暴 (异步任务模式)
   */
  async generateAsync(
    sources: SourceItem[],
    messages: ChatMessage[],
    notebookId: string
  ): Promise<BrainstormSession | null> {
    try {
      this.updateState({
        status: 'collecting',
        progress: 5,
        message: '正在准备头脑风暴...'
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

      const result = await taskService.executeTask<BrainstormResult>(
        'brainstorm',
        taskSources,
        taskMessages,
        { notebookId },
        (progress) => {
          this.updateState({
            status: 'generating',
            progress: Math.max(10, progress),
            message: '正在进行头脑风暴...'
          })
        }
      )

      if (!result?.ideas || result.ideas.length === 0) {
        throw new Error('生成的内容为空')
      }

      // Parse result
      const session = this.parseResult(result, notebookId)

      if (!session) {
        this.updateState({
          status: 'failed',
          progress: 0,
          message: '解析失败',
          error: '无法解析头脑风暴数据'
        })
        return null
      }

      this.updateState({
        status: 'completed',
        progress: 100,
        message: '头脑风暴完成',
        data: session
      })

      return session
    } catch (error) {
      console.error('[BrainstormService] 异步生成失败:', error)

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
   * 解析任务结果
   */
  private parseResult(result: BrainstormResult, notebookId: string): BrainstormSession | null {
    try {
      if (!result.ideas || !Array.isArray(result.ideas)) return null

      const ideas: BrainstormIdea[] = []
      for (const idea of result.ideas) {
        if (!idea.title || !idea.description) continue

        const category = isValidCategory(idea.category || '')
          ? (idea.category as IdeaCategory)
          : 'exploration'

        ideas.push({
          id: String(idea.id || `idea_${ideas.length + 1}`),
          title: String(idea.title),
          description: String(idea.description),
          category,
          reasoning: idea.reasoning ? String(idea.reasoning) : undefined
        })
      }

      if (ideas.length === 0) return null

      return {
        id: `brainstorm_${Date.now()}`,
        topicSummary: result.topicSummary || '头脑风暴',
        ideas,
        createdAt: new Date().toISOString(),
        notebookId
      }
    } catch (error) {
      console.error('[BrainstormService] 解析失败:', error)
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
 * 创建服务实例
 */
export function createBrainstormService(): BrainstormService {
  return new BrainstormService()
}
