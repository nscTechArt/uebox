/**
 * 模拟面试生成服务
 * 基于知识库内容生成面试配置和问题（RAG模式）
 */

import type {
  MockInterviewState,
  KnowledgePoint,
  InterviewQuestion,
  QuestionEvaluation
} from './types'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import type { InterviewConfig } from '@renderer/store/modules/studioOutputStore'
import { aiAPI } from '@renderer/api/ai'
import { ref, type Ref } from 'vue'
import {
  getNotebookTaskService,
  toTaskSources,
  parseJsonObject,
  TaskCancelledError,
  type TaskSource,
  type TaskMessage,
  type InterviewResult
} from '../notebook/NotebookTaskService'

/**
 * 模拟面试服务类
 */
export class MockInterviewService {
  public state: Ref<MockInterviewState>

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
  private updateState(updates: Partial<MockInterviewState>): void {
    this.state.value = { ...this.state.value, ...updates }
  }

  /**
   * 生成面试配置 (异步任务模式)
   * @param sources 知识库来源
   * @param messages 聊天消息
   * @param notebookTitle 知识库标题
   * @param notebookId 知识库ID，用于任务取消作用域
   */
  async generateConfigAsync(
    sources: SourceItem[],
    messages: ChatMessage[],
    notebookTitle: string,
    notebookId?: string
  ): Promise<InterviewConfig | null> {
    try {
      this.updateState({
        status: 'generating',
        progress: 5,
        message: '正在准备生成面试题...'
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

      const result = await taskService.executeTask<InterviewResult>(
        'interview',
        taskSources,
        taskMessages,
        { notebookTitle, notebookId },
        (progress) => {
          this.updateState({
            status: 'generating',
            progress: Math.max(10, progress),
            message: '正在生成面试题...'
          })
        }
      )

      if (!result?.questions || result.questions.length === 0) {
        throw new Error('生成的题目为空')
      }

      // Convert to InterviewConfig format
      const config: InterviewConfig = {
        topic: notebookTitle,
        knowledgePoints:
          result.knowledgePoints?.map((kp) => ({
            id: kp.id,
            title: kp.title,
            content: kp.content,
            type: (kp.type || 'Concept') as
              | 'Concept'
              | 'Method'
              | 'Tool'
              | 'Item'
              | 'Project'
              | 'Agent'
              | 'Event'
          })) || [],
        questions: result.questions.map((q) => ({
          id: q.id,
          question: q.question,
          sourceId: q.sourceId || '',
          sourceTitle: q.sourceTitle || '',
          questionType: (q.questionType === 'open' ? 'open' : 'choice') as 'choice' | 'open',
          options: q.options || [],
          correctAnswer: q.correctAnswer || '',
          hint: q.hint || '',
          explanation: q.explanation || ''
        })),
        status: 'ready'
      }

      this.updateState({
        status: 'ready',
        progress: 100,
        message: '面试配置生成完成'
      })

      return config
    } catch (error) {
      console.error('[MockInterviewService] 异步生成失败:', error)

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
   * 生成追问问题
   * @param question 原始问题
   * @param userAnswer 用户选择的答案
   * @param isCorrect 用户是否回答正确
   */
  async generateFollowUpQuestion(
    question: InterviewQuestion,
    userAnswer: string,
    isCorrect: boolean
  ): Promise<string | null> {
    const prompt = `你是一位资深的技术面试官，正在对候选人进行深入追问。

## 背景
**原始问题**：${question.question}

**选项**：
${question.options?.map((o) => `${o.id}. ${o.text}`).join('\n')}

**正确答案**：${question.correctAnswer}
**候选人选择**：${userAnswer}
**是否正确**：${isCorrect ? '正确' : '错误'}

## 追问要求
${
  isCorrect
    ? `候选人答对了这道题，请从以下角度进行追问：
- 延伸应用：这个知识点在实际项目中如何应用？
- 边界情况：有没有什么特殊情况或例外？
- 对比分析：与类似技术/方案相比有什么优劣？
- 原理深挖：能解释一下底层原理或工作机制吗？`
    : `候选人答错了，请从以下角度进行引导式追问：
- 澄清理解：询问候选人选择这个答案的原因
- 对比分析：让候选人思考正确答案和错误答案的区别
- 概念澄清：引导候选人重新理解核心概念`
}

## 输出要求
只输出一个追问问题，要像真实面试官一样自然地提问，不要引用"题目"、"选项"、"答案"等词汇。
直接输出问题内容，不要有任何前缀或解释。`

    try {
      this.updateState({
        status: 'generating',
        message: '正在生成追问...'
      })

      const response = await aiAPI.chat({
        messages: [{ role: 'user', content: prompt }],
        callType: 'notebook-mock-interview'
      })

      return response.content.trim() || null
    } catch (error) {
      console.error('[MockInterviewService] 生成追问失败:', error)
      return null
    }
  }

  /**
   * 评估追问回答
   * @param followUpQuestion 追问问题
   * @param userAnswer 用户的回答
   * @param originalQuestion 原始问题（用于上下文）
   */
  async evaluateFollowUpAnswer(
    followUpQuestion: string,
    userAnswer: string,
    originalQuestion: InterviewQuestion
  ): Promise<QuestionEvaluation | null> {
    const evaluatePrompt = `你是一位资深的技术面试官，请评估候选人对追问的回答。

## 背景
**原始问题**：${originalQuestion.question}
**追问问题**：${followUpQuestion}
**候选人回答**：${userAnswer}

## 评估要求
请根据候选人的回答进行评估，重点考察：
1. 理解深度：是否真正理解了知识点
2. 表达能力：是否能清晰地解释概念
3. 实践认知：是否了解实际应用场景
4. 逻辑思维：回答是否有条理和逻辑性

## 输出 JSON 格式
{
  "score": 0-100的分数,
  "referenceAnswer": "参考答案或要点",
  "comment": "简短的点评和建议",
  "dimensions": {
    "conceptUnderstanding": 0-100,
    "methodMastery": 0-100,
    "toolUsage": 0-100,
    "logicClarity": 0-100,
    "practicalExperience": 0-100
  }
}`

    try {
      this.updateState({
        status: 'evaluating',
        message: '正在评估追问回答...'
      })

      const response = await aiAPI.chat({
        messages: [{ role: 'user', content: evaluatePrompt }],
        responseFormat: { type: 'json_object' },
        callType: 'notebook-mock-interview'
      })

      return parseJsonObject<QuestionEvaluation>(response.content)
    } catch (error) {
      console.error('[MockInterviewService] 评估追问回答失败:', error)
      return null
    }
  }

  /**
   * 评估用户回答
   * @param question 问题
   * @param knowledgePoint 对应的知识点
   * @param userAnswer 用户回答
   */
  async evaluateAnswer(
    question: InterviewQuestion,
    knowledgePoint: KnowledgePoint,
    userAnswer: string
  ): Promise<QuestionEvaluation | null> {
    const evaluatePrompt = `你是基于【用户知识库】的考官，请评估用户的回答。

参考笔记（标准答案来源）：
标题：${knowledgePoint.title}
内容：${knowledgePoint.content}

问题：${question.question}
用户回答：${userAnswer}

请评估用户回答，输出 JSON 格式：
{
  "score": 0-100的分数,
  "referenceAnswer": "基于笔记内容的参考答案",
  "comment": "AI点评，指出亮点和不足",
  "dimensions": {
    "conceptUnderstanding": 0-100,
    "methodMastery": 0-100,
    "toolUsage": 0-100,
    "logicClarity": 0-100,
    "practicalExperience": 0-100
  }
}`

    try {
      this.updateState({
        status: 'evaluating',
        message: '正在评估回答...'
      })

      const response = await aiAPI.chat({
        messages: [{ role: 'user', content: evaluatePrompt }],
        responseFormat: { type: 'json_object' },
        callType: 'notebook-mock-interview'
      })

      return parseJsonObject<QuestionEvaluation>(response.content)
    } catch (error) {
      console.error('[MockInterviewService] 评估失败:', error)
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
export function createMockInterviewService(): MockInterviewService {
  return new MockInterviewService()
}
