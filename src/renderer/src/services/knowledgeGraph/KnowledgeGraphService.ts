/**
 * 知识图谱生成服务
 * 调用异步任务接口分析知识库内容，提取实体和关系，生成知识图谱结构
 */

import type {
  KnowledgeGraphData,
  KnowledgeGraphState,
  KGNode,
  KGEdge,
  EntityCategory,
  RelationType
} from './types'
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
  type KnowledgeGraphResult
} from '../notebook/NotebookTaskService'

/**
 * 验证实体类别是否有效
 */
function isValidCategory(category: string): category is EntityCategory {
  const validCategories: EntityCategory[] = [
    'class',
    'feature',
    'node',
    'asset',
    'workflow',
    'format',
    'setting',
    'tool',
    'platform',
    'plugin',
    'issue',
    'solution',
    'concept'
  ]
  return validCategories.includes(category as EntityCategory)
}

/**
 * 验证关系类型是否有效
 */
function isValidRelation(relation: string): relation is RelationType {
  const validRelations: RelationType[] = [
    'is_a',
    'contains',
    'part_of',
    'requires',
    'outputs',
    'uses',
    'solves',
    'conflicts_with',
    'prerequisite',
    'unlocks',
    'fixes',
    'exports'
  ]
  return validRelations.includes(relation as RelationType)
}

/**
 * 知识图谱服务类
 */
export class KnowledgeGraphService {
  public state: Ref<KnowledgeGraphState>

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
  private updateState(updates: Partial<KnowledgeGraphState>): void {
    this.state.value = { ...this.state.value, ...updates }
  }

  /**
   * 生成知识图谱 (异步任务模式)
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
  ): Promise<KnowledgeGraphData | null> {
    try {
      this.updateState({
        status: 'collecting',
        progress: 5,
        message: '正在准备生成知识图谱...'
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

      const result = await taskService.executeTask<KnowledgeGraphResult>(
        'knowledgeGraph',
        taskSources,
        taskMessages,
        { notebookTitle, language, notebookId },
        (progress) => {
          this.updateState({
            status: 'generating',
            progress: Math.max(10, progress),
            message: '正在提取实体和关系...'
          })
        }
      )

      // 查的是**有没有实体**，不是「有没有 nodes 这个字段」：模型返回 `{}` 或
      // `{"nodes":[]}` 时空数组照样是真值，那样会一路走到「生成完成」，
      // 用户打开却是一张空图
      if (!result?.nodes?.length) {
        throw new Error('模型没有抽取出任何实体，请换一个更强的模型再试')
      }

      // Parse and validate the result
      const graphData = this.parseGraphData(result)

      // 抽出来的实体一个都没通过校验（缺 id / 缺 label）时同样不算成功
      if (!graphData || graphData.nodes.length === 0) {
        this.updateState({
          status: 'failed',
          progress: 0,
          message: '解析失败',
          error: '无法解析知识图谱数据'
        })
        return null
      }

      this.updateState({
        status: 'completed',
        progress: 100,
        message: '知识图谱生成完成',
        data: graphData
      })

      return graphData
    } catch (error) {
      console.error('[KnowledgeGraphService] 异步生成失败:', error)

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
   * 解析并验证知识图谱数据
   */
  private parseGraphData(data: KnowledgeGraphResult): KnowledgeGraphData | null {
    try {
      if (!data.nodes || !Array.isArray(data.nodes)) return null
      if (!data.edges || !Array.isArray(data.edges)) return null

      const nodeIds = new Set<string>()
      const validNodes: KGNode[] = []

      for (const node of data.nodes) {
        if (!node.id || !node.label) continue
        const rawCategory = (node.type || 'concept').toLowerCase()
        const category = isValidCategory(rawCategory) ? rawCategory : 'concept'
        nodeIds.add(node.id)
        validNodes.push({
          id: String(node.id),
          label: String(node.label),
          category,
          description: undefined
        })
      }

      const validEdges: KGEdge[] = []
      for (const edge of data.edges) {
        if (!edge.source || !edge.target) continue
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
        const relation = isValidRelation(edge.label || 'uses')
          ? (edge.label as RelationType)
          : 'uses'
        validEdges.push({
          id: `edge_${validEdges.length}`,
          source: String(edge.source),
          target: String(edge.target),
          relation
        })
      }

      const limitedNodes = validNodes.slice(0, 100)
      const limitedNodeIds = new Set(limitedNodes.map((n) => n.id))
      const limitedEdges = validEdges
        .filter((e) => limitedNodeIds.has(e.source) && limitedNodeIds.has(e.target))
        .slice(0, 1000)

      return {
        title: undefined,
        nodes: limitedNodes,
        edges: limitedEdges
      }
    } catch (error) {
      console.error('[KnowledgeGraphService] 解析失败:', error)
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
export function createKnowledgeGraphService(): KnowledgeGraphService {
  return new KnowledgeGraphService()
}
