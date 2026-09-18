import {
  NOTIFICATION_ACTIVATE_CHANNEL,
  type NotificationActivatePayload
} from '@core/shared/agentNotificationActivation'

/**
 * agent 系统通知的界面侧接口。
 *
 * 用户点了通知，主进程把窗口拉到前台之后，界面还要跳到发那条通知的会话去
 * （处理逻辑在 `layout/composables/notificationActivation.ts`）。
 */
export const agentNotificationsAPI = {
  /**
   * 订阅「用户点了通知」。返回退订函数。
   *
   * 退订必须拿 `on()` **返回的那个** handler 去 `off`：preload 会把传进去的
   * listener 包一层再注册（`const handler = (_, ...args) => listener(...args)`），
   * 真正挂在 ipcRenderer 上的是包出来的那个。传原始 listener 的话
   * `removeListener` 一个都匹配不上，而且它不报错 —— 退订等于没写。
   */
  onActivated(handler: (payload: NotificationActivatePayload) => void): () => void {
    const listener = (...args: unknown[]): void => {
      // preload 的 on() 把 IpcRendererEvent 剥掉了，第一个参数就是 payload
      const payload = args[0] as NotificationActivatePayload | undefined
      if (!payload?.sessionId) return
      handler(payload)
    }
    const attached = window.api.on(NOTIFICATION_ACTIVATE_CHANNEL, listener)
    return () => window.api.off(NOTIFICATION_ACTIVATE_CHANNEL, attached)
  },

  /**
   * 取走主进程存着的那条激活（取走即清）。
   *
   * 推送可能落空 —— 用户点通知那会儿 `MainLayout` 不一定挂着。界面挂上来时
   * 问一次，落空的那条才补得回来。
   */
  async takePending(): Promise<NotificationActivatePayload | null> {
    const result = await window.api.agentNotifications.takePending()
    return result?.sessionId ? result : null
  },

  /**
   * 回话：这条激活认没认出来。
   *
   * 主进程只能确认「窗口拉起来了」。认不出来的话它得把通知重新弹一条 ——
   * 系统在用户点下去那一刻就把 toast 摘走了，不重弹用户手上就没有入口了。
   */
  reportActivation(notificationKey: string, handled: boolean): Promise<void> {
    return window.api.agentNotifications.reportActivation({ notificationKey, handled })
  }
}
