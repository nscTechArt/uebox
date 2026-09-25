/**
 * 资产库页面在看哪个库：本地库（含旧网络库，走 vaultStore 的切换）或某个服务器库。
 *
 * 服务器库不经主进程的"切换保管库"：主进程的当前保管库保持不变，笔记、agent、收藏
 * 这些按本地库工作的功能不受影响；只有资产库页面的数据源换成服务器库。
 *
 * 选中哪个服务器库记在主进程的 catalog-libraries.json（界面偏好，不进 localStorage）。
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type {
  CatalogJobProgress,
  CatalogLibraryEvent,
  CatalogLibraryStatus,
  CatalogLibraryView
} from '@core/shared/catalogLibrary'
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import i18n from '@renderer/i18n'
import { useImportTasksStore } from './importTasks'
import type {
  AssetLibrarySource,
  LibraryCapabilities
} from '@renderer/views/AssetManagement/data/AssetLibrarySource'
import { LOCAL_CAPABILITIES } from '@renderer/views/AssetManagement/data/LocalLibrarySource'
import {
  ServerLibrarySource,
  serverCapabilities
} from '@renderer/views/AssetManagement/data/ServerLibrarySource'
import {
  activeLibrarySource,
  setActiveLibrarySource
} from '@renderer/views/AssetManagement/data/activeLibrarySource'

export type LibraryInvalidation = Extract<CatalogLibraryEvent, { kind: 'invalidate' }>

export const useAssetLibraryStore = defineStore('assetLibrary', () => {
  const serverLibraries = ref<CatalogLibraryView[]>([])
  const activeServerKey = ref<string | null>(null)
  const statuses = ref<Record<string, CatalogLibraryStatus>>({})
  const loaded = ref(false)
  /** 当前服务器库的内容变了（SSE / 轮询 / 自己刚写过）：页面据此重取可见的页 */
  const lastInvalidation = shallowRef<LibraryInvalidation | null>(null)
  const invalidationCount = ref(0)
  /** 导入 / 下载作业的进度（主进程推来的） */
  const jobs = ref<Record<string, CatalogJobProgress & { key: string }>>({})
  const signInRequest = ref<string | null>(null)

  let unsubscribe: (() => void) | null = null
  let initializing: Promise<void> | null = null

  const activeServer = computed(
    () => serverLibraries.value.find((library) => library.key === activeServerKey.value) ?? null
  )
  const activeStatus = computed(() =>
    activeServerKey.value ? (statuses.value[activeServerKey.value] ?? null) : null
  )
  const isServer = computed(() => activeServerKey.value !== null)
  const capabilities = computed<LibraryCapabilities>(() => {
    if (!activeServerKey.value) return LOCAL_CAPABILITIES
    const status = activeStatus.value
    return serverCapabilities({
      annotations: status?.capabilities.annotations ?? null,
      lore: status?.capabilities.lore ?? false,
      online: status?.online !== false
    })
  })
  const source = computed<AssetLibrarySource>(() => activeLibrarySource.value)
  const signedOut = computed(
    () =>
      Boolean(activeServer.value && !activeServer.value.server.signedIn) ||
      activeStatus.value?.signedOut === true
  )

  /**
   * 导入 / 下载的进度放进现有的导入任务条（全局挂件），和本地导入同一个地方。
   * 这类作业不能中途叫停（lore 提交推送是一次性的），所以不给取消。
   */
  function reportJob(job: CatalogJobProgress): void {
    const tasks = useImportTasksStore()
    const t = i18n.global.t
    const name = t(
      job.type === 'import' ? 'catalogLibrary.jobs.import' : 'catalogLibrary.jobs.download'
    )
    const stageText =
      job.phase === 'failed'
        ? t('catalogLibrary.jobs.failedDetail', { reason: job.error ?? '' })
        : t(`catalogLibrary.jobs.phase.${job.phase}`)
    const progress =
      job.phase === 'done' ? 100 : job.total > 0 ? Math.round((job.done / job.total) * 100) : 0
    const status = job.phase === 'failed' ? 'error' : job.phase === 'done' ? 'completed' : 'running'
    if (!tasks.tasks.get(job.jobId)) {
      tasks.addTask({
        id: job.jobId,
        type: 'file',
        name,
        progress,
        stageText,
        status,
        total: job.total,
        done: job.done,
        taskType: job.type === 'import' ? 'vault-import' : 'project-import',
        cancellable: false
      })
    } else {
      tasks.updateTask(job.jobId, { progress, stageText, status, total: job.total, done: job.done })
    }
    // 成功的几秒后自己消失；失败的留着，等用户看见原因
    if (job.phase === 'done') setTimeout(() => tasks.removeTask(job.jobId), 4000)
  }

  function onEvent(event: CatalogLibraryEvent): void {
    if (event.kind === 'status') {
      statuses.value = { ...statuses.value, [event.key]: event.status }
      return
    }
    if (event.kind === 'job') {
      jobs.value = { ...jobs.value, [event.job.jobId]: { ...event.job, key: event.key } }
      reportJob(event.job)
      return
    }
    if (event.key !== activeServerKey.value) return
    const current = activeLibrarySource.value
    if (event.scope === 'all' && current instanceof ServerLibrarySource) current.forget()
    lastInvalidation.value = event
    invalidationCount.value += 1
  }

  async function loadServerLibraries(): Promise<void> {
    try {
      serverLibraries.value = await catalogLibraryAPI.list()
    } catch {
      serverLibraries.value = []
    }
    loaded.value = true
  }

  /** 页面第一次打开时调；恢复上次选中的服务器库 */
  function init(): Promise<void> {
    if (!initializing) {
      initializing = (async () => {
        if (!unsubscribe) unsubscribe = catalogLibraryAPI.onEvent(onEvent)
        await loadServerLibraries()
        const saved = await catalogLibraryAPI.getActive().catch(() => null)
        if (saved && serverLibraries.value.some((library) => library.key === saved)) {
          await activateServer(saved, { remember: false })
        }
      })()
    }
    return initializing
  }

  async function activateServer(key: string, options: { remember?: boolean } = {}): Promise<void> {
    const previous = activeServerKey.value
    if (previous && previous !== key)
      void catalogLibraryAPI.unwatch(previous).catch(() => undefined)
    activeServerKey.value = key
    const serverSource = new ServerLibrarySource(key, () => capabilities.value)
    setActiveLibrarySource(serverSource)
    if (options.remember !== false) void catalogLibraryAPI.setActive(key)
    try {
      const status = await catalogLibraryAPI.watch(key)
      statuses.value = { ...statuses.value, [key]: status }
      // 注释能力（路由 + 角色）只探一次；结果经 status 事件回来
      void catalogLibraryAPI.probeAnnotations(key).then(
        async () => {
          const fresh = await catalogLibraryAPI.status(key).catch(() => null)
          if (fresh) statuses.value = { ...statuses.value, [key]: fresh }
        },
        () => undefined
      )
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? 'unknown'
      const signedOut = code === 'signed-out' || code === 'unauthorized'
      statuses.value = {
        ...statuses.value,
        [key]: {
          key,
          // 登录失效时服务器是连得上的；其他失败按离线处理
          online: signedOut,
          signedOut,
          generation: null,
          epoch: null,
          state: null,
          lastError: error instanceof Error ? error.message : String(error),
          capabilities: {
            previews: null,
            annotations: null,
            events: null,
            changes: null,
            closure: null,
            lore: false
          }
        }
      }
    }
  }

  function activateLocal(options: { remember?: boolean } = {}): void {
    const previous = activeServerKey.value
    if (previous) void catalogLibraryAPI.unwatch(previous).catch(() => undefined)
    activeServerKey.value = null
    setActiveLibrarySource(null)
    if (options.remember !== false && previous) void catalogLibraryAPI.setActive(null)
  }

  async function removeServerLibrary(key: string): Promise<boolean> {
    const result = await catalogLibraryAPI.remove(key)
    if (!result.success) return false
    if (activeServerKey.value === key) activateLocal()
    await loadServerLibraries()
    return true
  }

  async function refreshStatus(): Promise<void> {
    const key = activeServerKey.value
    if (!key) return
    const status = await catalogLibraryAPI.status(key).catch(() => null)
    if (status) statuses.value = { ...statuses.value, [key]: status }
  }

  function dismissJob(jobId: string): void {
    const next = { ...jobs.value }
    delete next[jobId]
    jobs.value = next
  }

  return {
    serverLibraries,
    activeServerKey,
    activeServer,
    activeStatus,
    statuses,
    isServer,
    capabilities,
    source,
    signedOut,
    loaded,
    lastInvalidation,
    invalidationCount,
    jobs,
    signInRequest,
    init,
    loadServerLibraries,
    activateServer,
    activateLocal,
    removeServerLibrary,
    refreshStatus,
    dismissJob
  }
})
