/**
 * 模拟面试服务类型定义
 */

/**
 * 认知容器类型
 */
export type KnowledgeType = 'Concept' | 'Method' | 'Tool' | 'Item' | 'Project' | 'Agent' | 'Event'

/**
 * 知识点
 */
export interface KnowledgePoint {
  id: string
  title: string
  content: string
  type: KnowledgeType
}

/**
 * 问题类型
 */
export type QuestionType = 'open' | 'choice'

/**
 * 选择题选项
 */
export interface ChoiceOption {
  id: string // A, B, C, D
  text: string
}

/**
 * 预设问题
 */
export interface InterviewQuestion {
  id: string
  question: string
  sourceId: string
  sourceTitle: string
  type: KnowledgeType
  /** 问题类型：开放题或选择题 */
  questionType: QuestionType
  /** 选择题选项（仅选择题有） */
  options?: ChoiceOption[]
  /** 正确答案ID（仅选择题有） */
  correctAnswer?: string
  /** AI生成的提示 */
  hint?: string
  /** 答案解释 */
  explanation?: string
  /** 用户回答 */
  userAnswer?: string
  /** AI评估 */
  evaluation?: QuestionEvaluation
}

/**
 * 问题评估结果
 */
export interface QuestionEvaluation {
  score: number
  /** 参考答案 */
  referenceAnswer: string
  /** AI点评 */
  comment: string
  /** 维度得分 */
  dimensions: {
    conceptUnderstanding: number
    methodMastery: number
    toolUsage: number
    logicClarity: number
    practicalExperience: number
  }
}

/**
 * 面试服务状态
 */
export interface MockInterviewState {
  status: 'idle' | 'generating' | 'ready' | 'interviewing' | 'evaluating' | 'completed' | 'failed'
  progress: number
  message: string
  error?: string
  /** 当前问题索引 */
  currentQuestionIndex?: number
}
