import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * 应用更新状态，全局一份。
 *
 * ## 为什么要有这个 Store
 *
 * 主进程启动时就会静默查一次更新、之后每 4 小时再查一次
 * （src/main/services/updater/autoUpdater.ts）。但 `updater:update-available`
 * 以前全仓只有「设置 → 关于」那个面板在监听 —— 面板没挂载就没人收，
 * 于是自动检查查到了新版本也悄无声息，用户还是得自己去关于页点一下。
 *
 * 状态收在这里之后：监听只注册一次，谁都能读同一份状态，标题栏的角标和
 * 关于页的按钮不会各说各话。
 *
 * ## 为什么要在订阅之后再拉一次 getStatus()
 *
 * 启动检查可能跑在渲染进程加载完之前。主进程是 `webContents.send`，
 * 没人听就是丢了。主进程那边的 status 会留着结果，所以订阅完必须再问一次快照，
 * 否则启动时查到的新版本在这个会话里永远显示不出来。
 */

/** 更新流程所处的阶段。互斥，界面按它一个值决定显示什么 */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded'

export interface UpdateErrorPayload {
  message?: string
  code?: string
}

export interface UpdateInitHooks {
  onAvailable?: (version: string) => void
  onError?: (error: UpdateErrorPayload) => void
}

/** 版本号统一带上 v 前缀显示 —— 主进程给的是裸版本号 */
export function formatUpdateVersion(version: string): string {
  if (!version) return ''
  return /^v/i.test(version) ? version : `v${version}`
}

export const useUpdateStore = defineStore('update', () => {
  const phase = ref<UpdatePhase>('idle')
  const latestVersion = ref('')
  const downloadPercent = ref(0)
  const lastError = ref<UpdateErrorPayload | null>(null)

  /**
   * 这个版本的「发现新版本」提示弹过了没有。
   *
   * 只活在内存里，不持久化：重启一次再提醒一遍是对的 —— 下载没做完，
   * 提醒本来就该继续。持久化反而会让用户错过一次就再也看不到。
   */
  const announcedVersion = ref('')

  /** 有没有值得在标题栏上占个位置的事。idle / checking 都不算 */
  const hasUpdateNews = computed(
    () =>
      phase.value === 'available' || phase.value === 'downloading' || phase.value === 'downloaded'
  )

  const isChecking = computed(() => phase.value === 'checking')

  let cleanups: Array<() => void> = []
  let initialized = false

  /** 新发现的版本要不要弹一次全局提示；弹过就不再弹 */
  function shouldAnnounce(version: string): boolean {
    if (!version || announcedVersion.value === version) return false
    announcedVersion.value = version
    return true
  }

  /**
   * 注册主进程事件监听，全应用只做一次。
   *
   * 提示由调用方给回调，Store 自己不碰 UI —— 它在单元测试里要能脱离 i18n 跑。
   *
   * @param hooks.onAvailable 发现新版本时的一次性提示。同一个版本只会叫一次。
   * @param hooks.onError 更新出错。主进程只在非静默（用户主动触发）时才推这个事件，
   *   所以收到就该让用户看见，不必再判断来源。
   */
  function init(hooks: UpdateInitHooks = {}): void {
    if (initialized) return
    initialized = true

    const api = window.api?.updater
    if (!api) return

    cleanups = [
      api.onUpdateChecking(() => {
        // 已经下载好了就别退回「检查中」—— 那个角标是用户唯一的安装入口
        if (phase.value === 'downloaded' || phase.value === 'downloading') return
        lastError.value = null
        phase.value = 'checking'
      }),
      api.onUpdateAvailable((data) => {
        latestVersion.value = data.version
        lastError.value = null
        // 下载中/已下载的状态比「有新版本」更靠后，不要被一次例行检查打回去
        if (phase.value === 'downloading' || phase.value === 'downloaded') return
        phase.value = 'available'
        if (shouldAnnounce(data.version)) hooks.onAvailable?.(data.version)
      }),
      api.onUpdateNotAvailable(() => {
        if (phase.value === 'downloading' || phase.value === 'downloaded') return
        phase.value = 'idle'
      }),
      api.onDownloadProgress((data) => {
        phase.value = 'downloading'
        downloadPercent.value = Math.max(0, Math.min(100, Math.round(data.percent)))
      }),
      api.onUpdateDownloaded((data) => {
        latestVersion.value = data.version
        downloadPercent.value = 100
        phase.value = 'downloaded'
      }),
      api.onUpdateError((data) => {
        lastError.value = data ?? null
        hooks.onError?.(data)
        // 下载失败要退回「可更新」，让用户能再点一次；已装好的不受影响
        phase.value = phase.value === 'downloaded' ? 'downloaded' : 'idle'
        downloadPercent.value = 0
      })
    ]

    // 订阅之后补一次快照：启动检查很可能早于渲染进程加载完
    void syncFromMain()
  }

  /** 问主进程要一次当前状态。推送已经把阶段推到更靠后时不覆盖 */
  async function syncFromMain(): Promise<void> {
    try {
      const result = await window.api?.updater?.getStatus()
      const data = result?.success ? result.data : undefined
      if (!data) return

      if (data.latestVersion) latestVersion.value = data.latestVersion

      if (data.updateDownloaded) {
        phase.value = 'downloaded'
        downloadPercent.value = 100
        return
      }
      if (phase.value === 'downloading' || phase.value === 'downloaded') return
      if (data.updateAvailable) {
        phase.value = 'available'
        return
      }
      if (data.checking) phase.value = 'checking'
    } catch (error) {
      console.warn('[update] 读取更新状态失败:', error)
    }
  }

  /** 手动检查。结果走事件回来，这里只负责发起 */
  async function check(): Promise<{ success: boolean; error?: string }> {
    lastError.value = null
    phase.value = 'checking'
    try {
      const result = await window.api.updater.checkForUpdates()
      if (!result?.success) phase.value = 'idle'
      return result ?? { success: false }
    } catch (error) {
      phase.value = 'idle'
      console.error('[update] 检查更新失败:', error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * 开始下载。
   *
   * 主进程的 `downloadUpdate()` 要等整个下载结束才 resolve（几百 MB），
   * 所以调用方不要 await 着它画 loading —— 进度看 `downloadPercent`。
   */
  async function download(): Promise<{ success: boolean; error?: string }> {
    if (phase.value === 'downloading' || phase.value === 'downloaded') {
      return { success: true }
    }
    phase.value = 'downloading'
    downloadPercent.value = 0

    // 下载失败退回「可更新」，让用户能再点一次。但这中间可能已经下载完了
    // （事件比 invoke 的返回早到），那时不能把状态从 downloaded 拽回去。
    // 读成局部变量是为了绕开 TS 的收窄：它不知道 await 期间事件改过 phase
    const revertToAvailable = (): void => {
      const current: UpdatePhase = phase.value
      if (current !== 'downloaded') phase.value = 'available'
    }

    try {
      const result = await window.api.updater.downloadUpdate()
      if (!result?.success) revertToAvailable()
      return result ?? { success: false }
    } catch (error) {
      revertToAvailable()
      console.error('[update] 下载更新失败:', error)
      return { success: false, error: String(error) }
    }
  }

  /** 退出并安装。成功的话这个进程随即就没了 */
  async function install(): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await window.api.updater.quitAndInstall()
      return result ?? { success: false }
    } catch (error) {
      console.error('[update] 安装更新失败:', error)
      return { success: false, error: String(error) }
    }
  }

  /** 窗口卸载时摘掉订阅。正常情况下不会走到 —— 主窗口活到进程结束 */
  function dispose(): void {
    cleanups.forEach((fn) => fn())
    cleanups = []
    initialized = false
  }

  return {
    phase,
    latestVersion,
    downloadPercent,
    lastError,
    hasUpdateNews,
    isChecking,
    init,
    syncFromMain,
    check,
    download,
    install,
    dispose
  }
})
