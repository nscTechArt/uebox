import {
  TRAY_ACTION_CHANNEL,
  type TrayAction,
  type TrayRecentSession
} from '@core/shared/trayActions'

/**
 * 系统托盘菜单的界面侧接口。
 *
 * 不走 `unwrapResult()`：这几条都是「顺手报一下 / 取一下」，失败不该抛给用户，
 * 调用方（`trayBridge.ts`）各自咽掉记一行。
 *
 * 用户在托盘菜单点了「新对话 / 最近那条对话 / 插件失败通知」之后，主进程把
 * 窗口拉到前台、存下那条动作，再发一句 `tray:action` 提醒（不带负载）。
 * 动作本体只有 `takePending` 一条送达路径 —— 取走即清
 * （处理逻辑在 `layout/composables/trayBridge.ts`）。界面上报的只有「最近对话」前三条。
 */
export const trayAPI = {
  /**
   * 订阅「有一条托盘动作等着取」的提醒（提醒本身不带负载）。返回退订函数。
   *
   * 退订必须拿 `on()` **返回的那个** handler 去 `off`：preload 会把传进去的
   * listener 包一层再注册（`const handler = (_, ...args) => listener(...args)`），
   * 真正挂在 ipcRenderer 上的是包出来的那个。传原始 listener 的话
   * `removeListener` 一个都匹配不上，而且它不报错 —— 退订等于没写。
   */
  onActionPending(handler: () => void): () => void {
    const attached = window.api.on(TRAY_ACTION_CHANNEL, () => handler())
    return () => window.api.off(TRAY_ACTION_CHANNEL, attached)
  },

  /**
   * 上报最近活跃的三条对话，主进程据此重建托盘菜单。
   * 纯锦上添花：失败只意味着托盘菜单旧了一点，不该打扰用户。
   */
  setRecentSessions(sessions: TrayRecentSession[]): Promise<{ success: boolean }> {
    return window.api.tray.setRecentSessions(sessions)
  },

  /**
   * 取走主进程存着的那条托盘动作（取走即清）—— 唯一的送达路径。
   * 收到 `tray:action` 提醒取一次，界面挂上来再取一次；没有就是 null。
   */
  takePending(): Promise<TrayAction | null> {
    return window.api.tray.takePending()
  },

  /** 托盘「退出」的确认框里选了「仍然退出」，让主进程退出 */
  confirmQuit(): Promise<{ success: boolean }> {
    return window.api.tray.confirmQuit()
  }
}
