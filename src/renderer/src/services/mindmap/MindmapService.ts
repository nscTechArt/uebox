/**
 * 思维导图生成服务
 * 调用AI接口将知识库内容转换为思维导图结构
 */

import type { MindmapNode, MindmapState } from './types'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import { ref, type Ref } from 'vue'
import {
  getNotebookTaskService,
  toTaskSources,
  TaskCancelledError,
  type TaskSource,
  type TaskMessage,
  type MindmapResult
} from '../notebook/NotebookTaskService'

/**
 * 思维导图服务类
 */
export class MindmapService {
  public state: Ref<MindmapState>

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
  private updateState(updates: Partial<MindmapState>): void {
    this.state.value = { ...this.state.value, ...updates }
  }

  /**
   * 生成思维导图 (异步任务模式)
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
  ): Promise<MindmapNode | null> {
    try {
      this.updateState({
        status: 'collecting',
        progress: 5,
        message: '正在准备生成思维导图...'
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

      // Execute async task with progress callback
      const result = await taskService.executeTask<MindmapResult>(
        'mindmap',
        taskSources,
        taskMessages,
        { notebookTitle, notebookId },
        (progress) => {
          this.updateState({
            status: 'generating',
            progress: Math.max(10, progress),
            message: '正在生成思维导图...'
          })
        }
      )

      if (!result?.markdown) {
        throw new Error('生成的内容为空')
      }

      // Parse markdown to mindmap structure
      const mindmapData = this.parseMarkdownToMindmap(result.markdown)

      this.updateState({
        status: 'completed',
        progress: 100,
        message: '思维导图生成完成',
        data: mindmapData
      })

      return mindmapData
    } catch (error) {
      console.error('[MindmapService] 异步生成失败:', error)

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
   * 解析 Markdown 列表为思维导图结构
   * @param markdown Markdown 列表文本
   */
  private parseMarkdownToMindmap(markdown: string): MindmapNode {
    const lines = markdown.split('\n').filter((line) => line.trim())

    interface TreeNode {
      data: { text: string; id: string }
      children?: TreeNode[]
      level: number
    }

    const root: TreeNode = {
      data: { text: '思维导图', id: 'root' },
      children: [],
      level: -1
    }

    const stack: TreeNode[] = [root]
    let nodeCounter = 0

    for (const line of lines) {
      // 计算缩进层级(每2个空格为一级)
      const match = line.match(/^(\s*)[-*]\s+(.+)$/)
      if (!match) continue

      const indent = match[1].length
      const text = match[2].trim()
      const level = Math.floor(indent / 2)

      const node: TreeNode = {
        data: {
          text,
          id: `node-${++nodeCounter}`
        },
        children: [],
        level
      }

      // 找到正确的父节点
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop()
      }

      const parent = stack[stack.length - 1]
      if (parent) {
        if (!parent.children) {
          parent.children = []
        }
        parent.children.push(node)
      }

      stack.push(node)
    }

    // 如果根节点只有一个子节点,将该子节点作为新的根节点
    if (root.children && root.children.length === 1) {
      const newRoot = root.children[0]
      const cleanNode = (node: TreeNode, isFirstLevel = false): MindmapNode => {
        const result: MindmapNode = {
          data: {
            ...node.data,
            ...(isFirstLevel && { expand: true })
          }
        }
        if (node.children && node.children.length > 0) {
          result.children = node.children.map((child) => cleanNode(child, false))
        }
        return result
      }
      return {
        data: newRoot.data,
        children: newRoot.children?.map((child) => cleanNode(child, true))
      }
    }

    const cleanNode = (node: TreeNode, isFirstLevel = false): MindmapNode => {
      const result: MindmapNode = {
        data: {
          ...node.data,
          ...(isFirstLevel && { expand: true })
        }
      }
      if (node.children && node.children.length > 0) {
        result.children = node.children.map((child) => cleanNode(child, false))
      }
      return result
    }

    const result = cleanNode(root, false)
    if (result.children) {
      result.children = result.children.map((child) => ({
        ...child,
        data: { ...child.data, expand: true }
      }))
    }
    return result
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
export function createMindmapService(): MindmapService {
  return new MindmapService()
}
