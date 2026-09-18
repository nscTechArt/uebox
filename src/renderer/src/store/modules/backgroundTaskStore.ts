import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * 后台任务类型
 */
export type BackgroundTaskType = 'network_vault_scan' | 'import' | 'sync'

/**
 * 后台任务状态
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * 后台任务信息
 */
export interface BackgroundTask {
  id: string
  type: BackgroundTaskType
  title: string
  current: number
  total: number
  status: BackgroundTaskStatus
  detail?: string // 当前处理的内容（如文件名）
  networkPath?: string
  error?: string
  startedAt: number
  completedAt?: number
}

/**
 * 后台任务管理 Store
 * 用于管理长时间运行的后台任务，如局域网协作库扫描
 */
export const useBackgroundTaskStore = defineStore('backgroundTask', () => {
  // 任务列表
  const tasks = ref<BackgroundTask[]>([])

  // 计算属性
  const runningTasks = computed(() => tasks.value.filter((t) => t.status === 'running'))
  const hasRunningTasks = computed(() => runningTasks.value.length > 0)

  /**
   * 添加新任务
   */
  const addTask = (
    id: string,
    type: BackgroundTaskType,
    title: string,
    networkPath?: string
  ): BackgroundTask => {
    const task: BackgroundTask = {
      id,
      type,
      title,
      current: 0,
      total: 0,
      status: 'running',
      networkPath,
      startedAt: Date.now()
    }
    tasks.value.push(task)
    return task
  }

  /**
   * 更新任务进度
   */
  const updateProgress = (id: string, current: number, total: number, detail?: string): void => {
    const task = tasks.value.find((t) => t.id === id)
    if (task) {
      task.current = current
      task.total = total
      if (detail !== undefined) {
        task.detail = detail
      }
    }
  }

  /**
   * 完成任务
   */
  const completeTask = (
    id: string,
    status: 'completed' | 'failed' | 'cancelled',
    error?: string
  ): void => {
    const task = tasks.value.find((t) => t.id === id)
    if (task) {
      task.status = status
      task.completedAt = Date.now()
      if (error) {
        task.error = error
      }

      // 3秒后自动移除已完成的任务
      setTimeout(() => {
        removeTask(id)
      }, 3000)
    }
  }

  /**
   * 移除任务
   */
  const removeTask = (id: string): void => {
    const index = tasks.value.findIndex((t) => t.id === id)
    if (index !== -1) {
      tasks.value.splice(index, 1)
    }
  }

  /**
   * 获取任务
   */
  const getTask = (id: string): BackgroundTask | undefined => {
    return tasks.value.find((t) => t.id === id)
  }

  /**
   * 检查是否有针对特定路径的任务正在运行
   */
  const hasTaskForPath = (networkPath: string): boolean => {
    return tasks.value.some((t) => t.networkPath === networkPath && t.status === 'running')
  }

  /**
   * 清除所有已完成的任务
   */
  const clearCompletedTasks = (): void => {
    tasks.value = tasks.value.filter((t) => t.status === 'running')
  }

  return {
    // 状态
    tasks,

    // 计算属性
    runningTasks,
    hasRunningTasks,

    // 方法
    addTask,
    updateProgress,
    completeTask,
    removeTask,
    getTask,
    hasTaskForPath,
    clearCompletedTasks
  }
})
