/**
 * 知识库内容采集的类型定义
 * 供信息图等需要「把来源和聊天记录揉成一份文本」的服务复用
 */

/**
 * 内容来源类型
 */
export type ContentSource = 'knowledge' | 'chat' | 'note'

/**
 * 内容项类型
 */
export type ContentType =
  | 'file'
  | 'link'
  | 'youtube'
  | 'bilibili'
  | 'text'
  | 'note'
  | 'message'
  | 'ue-project'
  | 'wechat'
  | 'mp'

/**
 * 统一的内容项结构
 */
export interface ContentItem {
  /** 内容唯一标识 */
  id: string
  /** 内容来源 */
  source: ContentSource
  /** 内容类型 */
  type: ContentType
  /** 文本内容 */
  content: string
  /** 标题（可选） */
  title?: string
  /** 时间戳（用于时效性评估） */
  timestamp?: number
  /** 角色（仅聊天消息） */
  role?: 'user' | 'assistant'
  /** 内容优先级：high > medium > low，影响压缩预算分配 */
  priority?: 'high' | 'medium' | 'low'
}
