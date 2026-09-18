import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import { StorageUtils } from '../../common/utils/storage'

export interface BaiduOAuthTokenResponse {
  expires_in: number
  refresh_token: string
  access_token: string
  session_secret: string
  session_key: string
  scope: string
}

export interface BaiduTokenState {
  expiresIn: number
  refreshToken: string
  accessToken: string
  sessionSecret: string
  sessionKey: string
  scope: string
  obtainedAt: number
}

/**
 * 百度开放平台应用凭据。
 *
 * 社区版不内置官方应用凭据：客户端里的 client_secret 会随安装包分发给每个用户，
 * 等同于公开。改由用户在百度开放平台自建应用后填入，凭据只留在本机。
 */
export interface BaiduAppConfig {
  clientId: string
  clientSecret: string
}

/**
 * 文件夹上传任务接口
 */
export interface FolderUploadTask {
  folderId: string
  folderName: string
  progress: number
  totalFiles: number
  uploadedFiles: number
  status: 'uploading' | 'success' | 'error'
}

export const useBaiduyunStore = defineStore(
  'baiduyun',
  () => {
    const token = ref<BaiduTokenState | null>(null)
    const currentDir = ref<string>('/')
    const appConfig = ref<BaiduAppConfig>({ clientId: '', clientSecret: '' })

    // 文件夹上传任务状态（全局，切换页面不会丢失）
    const folderUploadTasks = reactive<Map<string, FolderUploadTask>>(new Map())
    // 用于强制触发响应式更新的计数器
    const uploadTasksVersion = ref(0)

    const isAuthenticated = computed(() => !!token.value?.accessToken)
    const expiresAt = computed(() =>
      token.value ? token.value.obtainedAt + token.value.expiresIn * 1000 : 0
    )
    const isExpired = computed(() =>
      token.value ? Date.now() > token.value.obtainedAt + token.value.expiresIn * 1000 : true
    )

    const setToken = (payload: BaiduOAuthTokenResponse): void => {
      token.value = {
        expiresIn: payload.expires_in,
        refreshToken: payload.refresh_token,
        accessToken: payload.access_token,
        sessionSecret: payload.session_secret || '',
        sessionKey: payload.session_key || '',
        scope: payload.scope || '',
        obtainedAt: Date.now()
      }
    }

    const clearToken = (): void => {
      token.value = null
    }

    const hasAppConfig = computed(
      () => !!appConfig.value.clientId && !!appConfig.value.clientSecret
    )

    const setAppConfig = (payload: BaiduAppConfig): void => {
      appConfig.value = {
        clientId: (payload.clientId || '').trim(),
        clientSecret: (payload.clientSecret || '').trim()
      }
    }

    const clearAppConfig = (): void => {
      appConfig.value = { clientId: '', clientSecret: '' }
    }

    /**
     * 设置上传任务
     */
    const setUploadTask = (task: FolderUploadTask): void => {
      folderUploadTasks.set(task.folderId, task)
      uploadTasksVersion.value++
    }

    /**
     * 更新上传任务
     */
    const updateUploadTask = (
      folderId: string,
      updates: Partial<Omit<FolderUploadTask, 'folderId'>>
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
    const getUploadTask = (folderId: string): FolderUploadTask | undefined => {
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
      token,
      isAuthenticated,
      expiresAt,
      isExpired,
      currentDir,
      setToken,
      clearToken,
      // 百度开放平台应用凭据（用户自建应用）
      appConfig,
      hasAppConfig,
      setAppConfig,
      clearAppConfig,
      resetAccount: () => {
        token.value = null
        currentDir.value = '/'
      },
      setCurrentDir: (dir: string) => {
        currentDir.value = (dir || '/').trim() || '/'
      },
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
    persist: usePersistOptions<{ token: BaiduTokenState | null; appConfig: BaiduAppConfig }>({
      key: 'baiduyun-store',
      paths: ['token', 'appConfig'],
      storage: 'localStorage',
      serializer: StorageUtils.createCustomSerializer()
    })
  }
)
