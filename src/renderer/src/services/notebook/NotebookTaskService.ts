/** 知识库产出通过主进程调用用户配置的模型，在本地管理进度、取消和文件保存。 */

import {
  NOTEBOOK_TASK_RUNNERS,
  type NotebookTaskType,
  type TaskRunner,
  type TaskSource,
  type TaskMessage
} from './notebookTaskRunners'
import { resolveNotebookCharBudget } from './contextBudget'

/**
 * 解析模型返回的 JSON。放在这里再导一手，是因为知识库里还有几处不走产出流程的
 * 模型调用（面试的追问评估、答案评分）也要解 JSON —— 它们各写一份「去掉代码块」
 * 的逻辑，宽容度总是差一截（模型在 JSON 前寒暄一句就解不出来）。
 */
export { parseJsonObject } from './notebookTaskRunners'

/**
 * 把知识库来源按各自的上下文档位换算成 `TaskSource`。
 *
 * 六个产出 Service 都从这里取，别再各写一份 —— 上一版就是各写各的，
 * 结果同一批来源在思维导图里被压过、在知识图谱里是全文。
 */
export { toTaskSources } from './notebookTaskRunners'

export type {
  NotebookTaskType,
  TaskSource,
  TaskMessage,
  MindmapResult,
  ReportResult,
  KnowledgeGraphResult,
  InterviewResult,
  WebpageResult,
  BrainstormResult
} from './notebookTaskRunners'

/**
 * 生成状态。
 *
 * 本地执行只有「在生成」和「生成完了」两种，没有排队 —— `pending` 那一档是
 * 官方任务队列的概念，队列没了它也就没了。各 Service 仍按 status 选提示文案，
 * 所以这个类型留着。
 */
export type TaskStatus = 'processing' | 'completed'

/** 用户中止了生成 */
export class TaskCancelledError extends Error {
  constructor() {
    super('Task was cancelled')
    this.name = 'TaskCancelledError'
  }
}

/**
 * Studio 产出的执行器。
 */
export class NotebookTaskService {
  /**
   * taskKey -> AbortController。
   *
   * taskKey 是 `知识库id:类型` 或只有类型（调用方没给知识库 id 时）。分开存是为了
   * 让不同知识库的同类产出各跑各的 —— 用一个全局控制器的话，在 A 知识库点生成
   * 会把 B 知识库正在跑的那次掐掉。
   */
  private abortControllers: Map<string, AbortController> = new Map()

  private buildTaskKey(taskType: NotebookTaskType, notebookId?: string): string {
    return notebookId ? `${notebookId}:${taskType}` : taskType
  }

  /**
   * 取消某次生成；不给 key 就全部取消。
   *
   * 中止会传到模型调用上，请求真的会断掉 —— 不是只让界面别等了，
   * 而是不再继续消耗用户的 token。
   */
  cancel(taskKey?: string): void {
    if (taskKey) {
      const controller = this.abortControllers.get(taskKey)
      if (controller) {
        controller.abort()
        this.abortControllers.delete(taskKey)
      }
      return
    }

    for (const controller of this.abortControllers.values()) {
      controller.abort()
    }
    this.abortControllers.clear()
  }

  /**
   * 生成一份产出，做完返回结果。
   *
   * @param type 产出类型
   * @param sources 知识库来源
   * @param messages 对话记录
   * @param options 附加参数，可含 notebookId（取消作用域）、notebookTitle、language
   * @param onProgress 进度回调
   */
  async executeTask<T = unknown>(
    type: NotebookTaskType,
    sources: TaskSource[],
    messages?: TaskMessage[],
    options?: Record<string, unknown>,
    onProgress?: (progress: number, status: TaskStatus) => void
  ): Promise<T> {
    if (sources.length === 0 && (!messages || messages.length === 0)) {
      throw new Error('至少需要提供一个来源或消息')
    }

    const notebookId = options?.notebookId as string | undefined
    const taskKey = this.buildTaskKey(type, notebookId)

    // 同一个产出重复点击：掐掉上一次再开始，否则两次生成会抢同一块界面状态
    this.cancel(taskKey)

    const controller = new AbortController()
    this.abortControllers.set(taskKey, controller)

    const runner = NOTEBOOK_TASK_RUNNERS[type] as TaskRunner<T> | undefined
    if (!runner) throw new Error(`不支持的产出类型：${type}`)

    // 这次能往模型里送多少字，按用户当前绑的模型的窗口算。
    // 界面上的计量条算的是同一个数 —— 各算各的就会「说好送 3 万字，产出却缺一块」
    const charBudget = await resolveNotebookCharBudget()

    try {
      const result = await runner(
        { sources, messages: messages || [], options: { charBudget, ...(options || {}) } },
        {
          signal: controller.signal,
          report: (progress) => onProgress?.(Math.round(progress), 'processing')
        }
      )

      // 中止后模型可能已经吐完了最后一段，结果照样会回来。这里再确认一次，
      // 免得用户点了取消、界面上却弹出一份产出
      if (controller.signal.aborted) throw new TaskCancelledError()

      onProgress?.(100, 'completed')
      return result
    } catch (error) {
      if (controller.signal.aborted) throw new TaskCancelledError()
      throw error
    } finally {
      // 已经被后一次调用换掉的话就不要删了，否则会误删别人的控制器
      if (this.abortControllers.get(taskKey) === controller) {
        this.abortControllers.delete(taskKey)
      }
    }
  }
}

let serviceInstance: NotebookTaskService | null = null

/** 取全局实例。取消作用域按 taskKey 分，所以一个实例就够 */
export function getNotebookTaskService(): NotebookTaskService {
  if (!serviceInstance) {
    serviceInstance = new NotebookTaskService()
  }
  return serviceInstance
}
