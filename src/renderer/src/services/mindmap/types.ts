/**
 * 思维导图节点接口
 * 符合 simple-mind-map 数据格式
 */
export interface MindmapNode {
  data: {
    text: string
    id: string
    /** 节点是否展开，默认为 true (展开) */
    expand?: boolean
    /** 扩展数据，用于存储原始内容等 */
    extra?: Record<string, unknown>
  }
  children?: MindmapNode[]
}

/**
 * 思维导图服务状态
 */
export interface MindmapState {
  status: 'idle' | 'collecting' | 'generating' | 'completed' | 'failed'
  progress: number
  message: string
  error?: string
  data?: MindmapNode
}
