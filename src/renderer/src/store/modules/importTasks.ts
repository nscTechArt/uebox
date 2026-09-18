import type { ImportResultView } from '@renderer/views/AssetManagement/utils/importResultView'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ImportFailureReport } from '@core/shared/projectImport'

export type ImportTaskType = 'vault-import' | 'project-import'

export type ImportTask = {
  vaultResult?: ImportResultView
  id: string
  type: 'file' | 'folder'
  name: string
  progress: number
  total?: number
  done?: number
  stageText: string
  stage?: string
  /**
   * `error` 是后加的。
   *
   * 挂件里本来就有一套 `is-error` 的样式，但这个类型里根本没有 `error` 这个值 ——
   * 于是失败的导入只能显示成绿色的「已完成」，3 秒后自己消失，用户什么都没看见。
   */
  status?: 'running' | 'paused' | 'completed' | 'error'
  /** 下载任务所属的目标文件夹 key，用于按目录过滤显示 */
  folderKey?: string
  /** 目标文件夹的显示名。加任务时就算好 —— 挂件挂在全局，那边拿不到资产库的文件夹树 */
  folderName?: string
  /** 任务所属的保管库 ID，用于隔离不同保管库的进度显示 */
  vaultId?: string
  /** 任务类型：导入到资产库 或 导入到工程 */
  taskType?: ImportTaskType
  /** 目标工程名称（仅 project-import 类型使用） */
  projectName?: string
  /** 源文件夹 keys（工程导入时记录来源文件夹，用于在对应文件夹上显示进度覆盖层） */
  sourceFolderKeys?: string[]
  /** 远程导入模式: v2-session / v1-batch */
  importMode?: 'v2-session' | 'v1-batch' | 'detecting'
  /** V2 Import Session ID */
  sessionId?: string
  /** 当前阶段内进度 (e.g. files uploaded) */
  stageProgress?: number
  /** 当前阶段内总数 (e.g. total files) */
  stageTotal?: number
  /** 导入创建的根文件夹 key（在 folderInit 完成后由 main 进程回传） */
  rootFolderKey?: string
  /** 这个任务能不能中途叫停 */
  cancellable?: boolean
  /**
   * 出了什么问题、影响了谁。只有 `status === 'error'` 时才有。
   *
   * 这份东西原来在渲染层被直接丢掉：后台模式只弹一句「导入完成，7 条警告」，
   * 主进程辛苦拼出来的「缺 T_Wood，32 个资产用到它」根本到不了用户眼前。
   */
  report?: ImportFailureReport
  /** 用户点了「重试导入」时要用的：这批导的是哪个工程、哪些资产 */
  retry?: ImportTaskRetry
  /**
   * `retry` 是不是覆盖了这批全部的失败。
   *
   * 外部文件（FBX/PNG）得过引擎的导入 API，没法跟 .uasset 一起重试。
   * 这批里混了外部文件时它是 false —— 重试成功也不能把整条任务收掉，
   * 否则还没解决的那几个连同证据一起被抹掉。
   */
  retryCoversAll?: boolean
}

/** 重试一次导入需要的全部信息。存下来是因为失败弹窗可能在几分钟后才被点开 */
export type ImportTaskRetry = {
  project: {
    projectKey: string
    projectName: string | null
    projectPath: string | null
    originPath: string | null
    EngineAssociation: string | null
  }
  sources: Array<{ assetKey?: string; assetName?: string; skipDependencyResolution?: boolean }>
}

/**
 * 正在跑的导入任务。
 *
 * ## 为什么必须是 store 而不是资产库页面里的 ref
 *
 * 它原来是 `AssetManagement/index.vue` 里的一个 `ref`，进度挂件也挂在那个页面的
 * 模板里。资产库路由虽然有 `meta.keepAlive`（组件实例还在，IPC 监听照常收），
 * 但 keep-alive 缓存的组件在失活时**整棵 DOM 都会被卸载** —— 于是用户点了导入、
 * 切去助手页等，进度条就整个消失了，回来才又出现。三十个 G 的导入正在跑，界面上
 * 一点痕迹都没有。
 *
 * 现在状态放这儿、挂件挂在 `MainLayout` 上，跟 `AssetLockIndicator` 同一层：
 * **该看到这件事的是人，而人此刻很可能正在别的页面上。**
 *
 * ## 只存值，不放推进逻辑
 *
 * 各类导入的 IPC 监听仍在各自的页面里（它们还要顺带刷新文件列表、弹恢复对话框，
 * 那些是页面的事）。这里只负责把任务**存活着**，以及提供一个跨页面的读口。
 */
export const useImportTasksStore = defineStore('import-tasks', () => {
  /** 不做持久化：正在跑的导入属于这次运行，应用重开后那一轮早就断了 */
  const tasks = ref<Map<string, ImportTask>>(new Map())

  const allTasks = computed<ImportTask[]>(() => Array.from(tasks.value.values()))

  /**
   * 挂件上该显示的任务：还在跑的，**外加失败的**。
   *
   * 失败的必须留着 —— 原来这里只按「跑完了就不显示」过滤，于是导入失败的那一刻
   * 任务从挂件上消失，用户唯一能看到的是一句一闪而过的 toast。
   * 失败的任务由用户自己关掉（挂件上的 ×）。
   */
  const runningTasks = (vaultId?: number | string | null): ImportTask[] =>
    allTasks.value.filter((task) => {
      const finishedClean =
        task.status !== 'error' && (task.status === 'completed' || task.progress >= 100)
      if (finishedClean) return false
      if (task.vaultId != null && vaultId != null && String(task.vaultId) !== String(vaultId)) {
        return false
      }
      return true
    })

  const addTask = (task: ImportTask): void => {
    tasks.value.set(task.id, task)
  }

  const updateTask = (id: string, updates: Partial<ImportTask>): void => {
    const task = tasks.value.get(id)
    if (task) Object.assign(task, updates)
  }

  const removeTask = (id: string): void => {
    tasks.value.delete(id)
  }

  const hasTask = (id: string): boolean => tasks.value.has(id)

  return { tasks, allTasks, runningTasks, addTask, updateTask, removeTask, hasTask }
})
