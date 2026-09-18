/**
 * 头脑风暴类型定义
 * 基于知识库内容的创意发散与想法生成
 */

/**
 * 创意分类
 * - innovation: 创新点子
 * - improvement: 改进建议
 * - exploration: 探索方向
 * - risk: 潜在风险
 * - opportunity: 机会识别
 * - question: 待解答问题
 */
import i18n from '@renderer/i18n'

export type IdeaCategory =
  | 'innovation'
  | 'improvement'
  | 'exploration'
  | 'risk'
  | 'opportunity'
  | 'question'

/**
 * 分类配置（颜色、图标）。
 *
 * **标签不在这里。** 原来每条带 `label`（中文）和 `labelEn`（英文）两个字段 ——
 * 一份手搓的双语表，绕开了语言包：`labelEn` 全仓没人读过，界面永远显示 `label`，
 * 所以英文用户看到的头脑风暴分类全是中文。
 *
 * 文案挪到 `notebookBrainstormViewer.categories.*`，分类名本身就是 key。
 */
export const CATEGORY_CONFIG: Record<IdeaCategory, { icon: string; color: string }> = {
  innovation: { icon: '💡', color: '#9C27B0' },
  improvement: { icon: '🔧', color: '#4CAF50' },
  exploration: { icon: '🧭', color: '#2196F3' },
  risk: { icon: '⚠️', color: '#FF5722' },
  opportunity: { icon: '🎯', color: '#FF9800' },
  question: { icon: '❓', color: '#607D8B' }
}

/** 分类在界面上叫什么。认不出的分类原样显示——数据是模型生成的 */
export function categoryLabel(category: IdeaCategory | string): string {
  const key = `notebookBrainstormViewer.categories.${category}`
  const copy = i18n.global.t(key)
  return copy === key ? String(category) : copy
}

/**
 * 单个创意条目
 */
export interface BrainstormIdea {
  /** 唯一标识 */
  id: string
  /** 简短标题 */
  title: string
  /** 详细描述 */
  description: string
  /** 分类 */
  category: IdeaCategory
  /** AI 推理依据 */
  reasoning?: string
  /** 关联的知识来源标题 */
  sourceRefs?: string[]
  /** 是否为用户手动添加 */
  isUserAdded?: boolean
  /** 用户是否已标记收藏 */
  isStarred?: boolean
  /** 展开详情（深入分析结果） */
  expandedDetail?: string
}

/**
 * 头脑风暴会话
 */
export interface BrainstormSession {
  /** 会话 ID */
  id: string
  /** 自动生成的主题摘要 */
  topicSummary: string
  /** 创意列表 */
  ideas: BrainstormIdea[]
  /** 创建时间 */
  createdAt: string
  /** 所属知识库 ID */
  notebookId: string
}

/**
 * 头脑风暴服务状态
 */
export interface BrainstormState {
  status: 'idle' | 'collecting' | 'generating' | 'expanding' | 'completed' | 'failed'
  progress: number
  message: string
  error?: string
  data?: BrainstormSession
}
