/**
 * 更新器 IPC 的渲染层封装。
 *
 * ## 为什么要有这一层
 *
 * AGENTS.md §5 规则 5：渲染进程不直接碰 `ipcRenderer`，走 `window.api.*`，
 * **并且在 `src/renderer/src/api/*` 里包一层**，让错误以同一种形状冒出来。
 * 原来 Store 里散着四处 `window.api.updater.xxx()`，其中只有 `init()` 判了
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
  error?: string
}

const BRIDGE_MISSING = '更新功能不可用（渲染进程没拿到 updater 通道）'

function bridge(): NonNullable<typeof window.api.updater> | null {
  return window.api?.updater ?? null
}

/** 桥不在就回一个正常的失败，不要让 TypeError 冒到界面上 */
async function invoke(
  run: (api: NonNullable<typeof window.api.updater>) => Promise<UpdaterActionResult | undefined>,
  what: string
): Promise<UpdaterActionResult> {
  const api = bridge()
  if (!api) return { success: false, error: BRIDGE_MISSING }
  try {
    return (await run(api)) ?? { success: false, error: `${what}没有返回结果` }
  } catch (error) {
    console.error(`[updater] ${what}失败:`, error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const updaterAPI = {
  checkForUpdates: (): Promise<UpdaterActionResult> =>
    invoke((api) => api.checkForUpdates(), '检查更新'),

  downloadUpdate: (): Promise<UpdaterActionResult> =>
    invoke((api) => api.downloadUpdate(), '下载更新'),

  quitAndInstall: (): Promise<UpdaterActionResult> =>
    invoke((api) => api.quitAndInstall(), '安装更新'),

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
