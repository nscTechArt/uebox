/**
 * 更新器 IPC 的渲染层封装。
 *
 * ## 为什么要有这一层
 *
 * AGENTS.md §5 规则 5：渲染进程不直接碰 `ipcRenderer`，走 `window.api.*`，
 * **并且在 `src/renderer/src/api/*` 里包一层**，让错误以同一种形状冒出来。
 * 原来 Store 里散着四处对 updater 桥的直接调用，其中只有 `init()` 判了
 * 桥在不在 —— 少一个桥（改名、preload 没装上、独立窗口）时，`check()` 会抛
 * 「Cannot read properties of undefined」，而那句话会被关于页原样 `message.error`
 * 弹给用户看。
 *
 * ## 为什么这里不像别的 api 模块那样用 unwrapResult
 *
 * `unwrapResult` 失败时**抛异常**，那适合「查不到就没法往下走」的读取类调用。
 * 更新这几个是用户点一下的动作，调用方要的是 `{ success, error }` 自己决定报不报
 * （标题栏角标和关于页的报法本来就不同），抛出去反而逼每个调用点再包一次 try。
 * 所以这一层统一的是**桥的存在性和返回值形状**，不是抛不抛。
 */

/** 主进程更新器的状态快照 */
export interface UpdaterStatus {
  checking: boolean
  updateAvailable: boolean
  updateDownloaded: boolean
  currentVersion: string
  latestVersion?: string
  downloadProgress?: { percent: number; transferred: number; total: number }
}

export interface UpdaterActionResult {
  success: boolean
  /** 主进程给的原文。只有主进程自己返回的才往这里放 */
  error?: string
  /**
   * 这一层自己造出来的失败，给 i18n key 而不是成品文案。
   *
   * 这里造的字符串会被关于页原样 `message.error` 弹出去，写死中文的话
   * 英文用户就会看到一句中文（AGENTS.md §5 规则 3：面向用户的文案必须双语）。
   * 而且只要 `error` 非空，调用方 `result.error || t('...')` 的兜底翻译就永远轮不到。
   * 所以：能翻的给 key，翻不了的（主进程原文）才给 error。
   */
  errorKey?: string
}

/** 主进程推过来的六个更新事件 */
export interface UpdaterEventHandlers {
  onChecking: () => void
  onAvailable: (data: { version: string }) => void
  onNotAvailable: () => void
  onProgress: (data: { percent: number; transferred: number; total: number }) => void
  onDownloaded: (data: { version: string }) => void
  onError: (data?: { message?: string; code?: string }) => void
}

function bridge(): NonNullable<typeof window.api.updater> | null {
  return window.api?.updater ?? null
}

/** 桥不在就回一个正常的失败，不要让 TypeError 冒到界面上 */
async function invoke(
  run: (api: NonNullable<typeof window.api.updater>) => Promise<UpdaterActionResult | undefined>,
  what: string
): Promise<UpdaterActionResult> {
  const api = bridge()
  if (!api) return { success: false, errorKey: 'update.unavailable' }
  try {
    // 没返回结果时两个字段都不给：调用方的 `result.error || t(...)` 兜底才能生效
    return (await run(api)) ?? { success: false }
  } catch (error) {
    // 细节留在控制台，界面上给可翻译的那句
    console.error(`[updater] ${what}失败:`, error)
    return { success: false, errorKey: 'update.unavailable' }
  }
}

export const updaterAPI = {
  checkForUpdates: (): Promise<UpdaterActionResult> =>
    invoke((api) => api.checkForUpdates(), '检查更新'),

  downloadUpdate: (): Promise<UpdaterActionResult> =>
    invoke((api) => api.downloadUpdate(), '下载更新'),

  quitAndInstall: (): Promise<UpdaterActionResult> =>
    invoke((api) => api.quitAndInstall(), '安装更新'),

  /**
   * 挂上主进程推过来的六个事件，返回一个摘干净的函数。
   *
   * 订阅也得从这里走，否则这一层只包住了四个 invoke，Store 里仍旧留着
   * 第二处 `window.api?.updater` 判断 —— 桥没了的时候两边表现还不一样：
   * 动作调用规规矩矩回 `{success:false}`，而订阅那边默默 return，
   * 于是「按钮报错、角标永远不动、日志里什么都没有」。
   *
   * 桥不在时返回 null，调用方据此知道订阅没挂上。
   */
  subscribe(handlers: UpdaterEventHandlers): (() => void) | null {
    const api = bridge()
    if (!api) return null
    const cleanups = [
      api.onUpdateChecking(handlers.onChecking),
      api.onUpdateAvailable(handlers.onAvailable),
      api.onUpdateNotAvailable(handlers.onNotAvailable),
      api.onDownloadProgress(handlers.onProgress),
      api.onUpdateDownloaded(handlers.onDownloaded),
      api.onUpdateError(handlers.onError)
    ]
    return () => cleanups.forEach((off) => off())
  },

  /** 读不到就回 null —— 调用方据此跳过这次同步，不覆盖已有状态 */
  async getStatus(): Promise<UpdaterStatus | null> {
    const api = bridge()
    if (!api) return null
    try {
      const res = await api.getStatus()
      return res?.success ? (res.data ?? null) : null
    } catch (error) {
      console.warn('[updater] 读取更新状态失败:', error)
      return null
    }
  }
}
