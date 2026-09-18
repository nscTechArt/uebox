import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import { StorageUtils } from '../../common/utils/storage'

/**
 * WebDAV 连接配置接口
 */
export interface WebdavConnectionConfig {
  serverUrl: string
  username: string
  password: string
  connectedAt: number
}

/**
 * 文件夹上传任务接口
 */
export interface WebdavFolderUploadTask {
  folderId: string
  folderName: string
  progress: number
  totalFiles: number
  uploadedFiles: number
  status: 'uploading' | 'success' | 'error'
}

/**
 * WebDAV Store
 * 管理 WebDAV 连接状态和认证信息
 */
export const useWebdavStore = defineStore(
  'webdav',
  () => {
    // WebDAV 连接配置
    const connection = ref<WebdavConnectionConfig | null>(null)
    // 当前目录路径
    const currentDir = ref<string>('/')
    // 历史记录
    const history = ref<WebdavConnectionConfig[]>([])

    // 文件夹上传任务状态（全局，切换页面不会丢失）
    const folderUploadTasks = reactive<Map<string, WebdavFolderUploadTask>>(new Map())
    // 用于强制触发响应式更新的计数器
    const uploadTasksVersion = ref(0)

    // 计算属性：是否已连接
    const isConnected = computed(() => !!connection.value?.serverUrl)

    /**
     * 添加历史记录
     * @param conn WebDAV 连接配置
     */
    const addHistory = (conn: Omit<WebdavConnectionConfig, 'connectedAt'>): void => {
      // 移除已存在的相同记录（根据 serverUrl 和 username 判断）
      const index = history.value.findIndex(
        (h) => h.serverUrl === conn.serverUrl && h.username === conn.username
      )
      if (index > -1) {
        history.value.splice(index, 1)
      }
      // 添加到头部
      history.value.unshift({
        ...conn,
        connectedAt: Date.now()
      })
      // 限制历史记录数量，例如保留最近 10 条
      if (history.value.length > 10) {
        history.value.pop()
      }
    }

    /**
     * 设置连接配置
     * @param config WebDAV 连接配置
     */
    const setConnection = (config: Omit<WebdavConnectionConfig, 'connectedAt'>): void => {
      connection.value = {
        ...config,
        connectedAt: Date.now()
      }
      addHistory(config)
    }

    /**
     * 清除连接配置
     */
    const clearConnection = (): void => {
      connection.value = null
      currentDir.value = '/'
    }

    /**
     * 设置当前目录
     * @param path 目录路径
     */
    const setCurrentDir = (path: string): void => {
      currentDir.value = path
    }

    /**
     * 从历史记录中移除连接
     * @param conn WebDAV 连接配置
     */
    const removeHistory = (conn: WebdavConnectionConfig): void => {
      const index = history.value.findIndex(
        (h) => h.serverUrl === conn.serverUrl && h.username === conn.username
      )
      if (index > -1) {
        history.value.splice(index, 1)
      }
    }

    /**
     * 清空历史记录
     */
    const clearHistory = (): void => {
      history.value = []
    }

    // ==================== 上传任务管理 ====================

    /**
     * 设置上传任务
     */
    const setUploadTask = (task: WebdavFolderUploadTask): void => {
      folderUploadTasks.set(task.folderId, task)
      uploadTasksVersion.value++
    }

    /**
     * 更新上传任务
     */
    const updateUploadTask = (
      folderId: string,
      updates: Partial<Omit<WebdavFolderUploadTask, 'folderId'>>
    ): void => {
      const task = folderUploadTasks.get(folderId)
      if (task) {
        Object.assign(task, updates)
        uploadTasksVersion.value++
      }
    }

    /**
     * 删除上传任务
     */
    const removeUploadTask = (folderId: string): void => {
      folderUploadTasks.delete(folderId)
      uploadTasksVersion.value++
    }

    /**
     * 获取上传任务（响应式）
     */
    const getUploadTask = (folderId: string): WebdavFolderUploadTask | undefined => {
      // 建立依赖

      uploadTasksVersion.value
      return folderUploadTasks.get(folderId)
    }

    /**
     * 检查是否有正在上传的任务
     */
    const hasUploadingTask = (folderId: string): boolean => {
      // 建立依赖

      uploadTasksVersion.value
      return folderUploadTasks.has(folderId)
    }

    return {
      connection,
      currentDir,
      history,
      isConnected,
      setConnection,
      clearConnection,
      setCurrentDir,
      addHistory,
      removeHistory,
      clearHistory,
      // 上传任务相关
      folderUploadTasks,
      uploadTasksVersion,
      setUploadTask,
      updateUploadTask,
      removeUploadTask,
      getUploadTask,
      hasUploadingTask
    }
  },
  {
    persist: usePersistOptions<{
      connection: WebdavConnectionConfig | null
      history: WebdavConnectionConfig[]
    }>({
      key: 'webdav-store',
      paths: ['connection', 'history'],
      storage: 'localStorage',
      serializer: StorageUtils.createCustomSerializer()
    })
  }
)
