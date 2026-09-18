import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { QuestionEvaluation } from '@renderer/services/mockInterview/types'

/**
 * 单题回答记录
 */
export interface AnswerRecord {
  questionIndex: number
  question: string
  userAnswer: string
  evaluation: QuestionEvaluation | null
  skipped: boolean
}

/**
 * 面试历史记录
 */
export interface InterviewHistory {
  /** 唯一ID */
  id: string
  /** 关联的知识库ID */
  notebookId: string
  /** 面试主题 */
  topic: string
  /** 面试时间 */
  createdAt: string
  /** 总分 */
  totalScore: number
  /** 题目总数 */
  totalQuestions: number
  /** 答题数（不含跳过） */
  answeredCount: number
  /** 跳过数 */
  skippedCount: number
  /** 答题记录 */
  answersRecord: AnswerRecord[]
  /** 知识点列表（简化存储） */
  knowledgePoints: Array<{ id: string; title: string }>
  /** 问题列表（包含选项和解释用于错题复习） */
  questions: Array<{
    id: string
    question: string
    options?: Array<{ id: string; text: string }>
    correctAnswer?: string
    explanation?: string
  }>
}

/**
 * 错题记录
 */
export interface MistakeRecord {
  /** 唯一ID */
  id: string
  /** 来源面试ID */
  interviewId: string
  /** 关联的知识库ID */
  notebookId: string
  /** 题目 */
  question: string
  /** 用户错误回答 */
  userAnswer: string
  /** 参考答案 */
  referenceAnswer: string
  /** 得分 */
  score: number
  /** AI点评 */
  comment: string
  /** 创建时间 */
  createdAt: string
  /** 是否已复习 */
  reviewed: boolean
  /** 选择题选项（用于问AI时提供上下文） */
  options?: Array<{ id: string; text: string }>
  /** 答案解释 */
  explanation?: string
}

/**
 * 面试历史管理 Store
 */
export const useMockInterviewStore = defineStore(
  'mockInterviewHistory',
  () => {
    // 面试历史记录
    const histories = ref<InterviewHistory[]>([])
    // 错题本
    const mistakes = ref<MistakeRecord[]>([])

    /**
     * 获取指定知识库的面试历史
     */
    function getHistoriesByNotebook(notebookId: string): InterviewHistory[] {
      return histories.value.filter((h) => h.notebookId === notebookId)
    }

    /**
     * 获取指定知识库的错题
     */
    function getMistakesByNotebook(notebookId: string): MistakeRecord[] {
      return mistakes.value.filter((m) => m.notebookId === notebookId)
    }

    /**
     * 添加面试历史记录
     */
    function addHistory(history: InterviewHistory): void {
      histories.value.unshift(history)
      // 自动提取错题到错题本
      extractMistakes(history)
    }

    /**
     * 从面试记录中提取错题
     */
    function extractMistakes(history: InterviewHistory): void {
      history.answersRecord.forEach((record) => {
        // 跳过的题目和得分>=80的不算错题
        if (record.skipped || !record.evaluation || record.evaluation.score >= 80) {
          return
        }

        // 从 questions 中查找对应的题目以获取选项和解释
        const questionData = history.questions?.find((q) => q.question === record.question)

        const mistake: MistakeRecord = {
          id: `mistake-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          interviewId: history.id,
          notebookId: history.notebookId,
          question: record.question,
          userAnswer: record.userAnswer,
          referenceAnswer: record.evaluation.referenceAnswer || '',
          score: record.evaluation.score,
          comment: record.evaluation.comment,
          createdAt: new Date().toISOString(),
          reviewed: false,
          // 新增：存储选项和解释用于问AI
          options: questionData?.options,
          explanation: questionData?.explanation
        }
        mistakes.value.unshift(mistake)
      })
    }

    /**
     * 标记错题为已复习
     */
    function markMistakeReviewed(mistakeId: string): void {
      const mistake = mistakes.value.find((m) => m.id === mistakeId)
      if (mistake) {
        mistake.reviewed = true
      }
    }

    /**
     * 删除面试历史
     */
    function removeHistory(historyId: string): void {
      const index = histories.value.findIndex((h) => h.id === historyId)
      if (index >= 0) {
        histories.value.splice(index, 1)
      }
    }

    /**
     * 删除错题
     */
    function removeMistake(mistakeId: string): void {
      const index = mistakes.value.findIndex((m) => m.id === mistakeId)
      if (index >= 0) {
        mistakes.value.splice(index, 1)
      }
    }

    /**
     * 获取未复习错题数
     */
    const unreviewedMistakesCount = computed(() => {
      return mistakes.value.filter((m) => !m.reviewed).length
    })

    return {
      histories,
      mistakes,
      getHistoriesByNotebook,
      getMistakesByNotebook,
      addHistory,
      markMistakeReviewed,
      removeHistory,
      removeMistake,
      unreviewedMistakesCount
    }
  },
  {
    persist: {
      key: 'mock-interview-history',
      pick: ['histories', 'mistakes']
    }
  }
)
