/**
 * 「用户点了 agent 的系统通知」这条消息，主进程和界面共用的定义。
 *
 * 共用一个常量而不是两边各写一遍字符串：写错的那一半**不会报错**。
 * preload 白名单少一个字母是会当场抛 `[preload] Blocked api.on channel` 的
 * （见 `assertChannelAllowed`），真正没人管的是主进程发 A、界面听 B 而两个
 * 都在白名单里 —— 那时点通知只弹出窗口，跟没接这条线一模一样。
 */

/** 主进程 → 目标窗口。见 `services/agentNotifications/index.ts` */
export const NOTIFICATION_ACTIVATE_CHANNEL = 'agent-notification:activate'

/**
 * 界面主动来取「有没有一条还没送到的激活」。
 *
 * 推送是投出去就不管的：`MainLayout` 没挂载的时候（`/404`、首启语言门、
 * 渲染进程正在重载）那条消息直接蒸发，而通知已经被点掉了。所以主进程还会
 * 把它存一份，界面挂上来时自己来拿。取走即清。
 */
export const NOTIFICATION_TAKE_PENDING_CHANNEL = 'agent-notification:take-pending'

/**
 * 界面回话：这条激活到底认没认出来。
 *
 * 主进程只知道「窗口拉起来了」，不知道界面认不认得这条会话 —— MiniChat 建的
 * 会话主窗口就不认得（`chat-sessions:refresh` 只同步标题和气泡）。认不出来的话
 * 通知得重新弹一条，否则用户手上再没有任何入口，而审批五分钟后按拒绝算。
 */
export const NOTIFICATION_ACTIVATION_RESULT_CHANNEL = 'agent-notification:activation-result'

export interface NotificationActivationResult {
  /** 原样带回来的 `notificationKey`，主进程按它找回是哪条通知 */
  notificationKey: string
  /** 界面反查到了这条会话并跳过去了 */
  handled: boolean
}

/** 存着的激活最多留这么久。超过就不认了 —— 半小时后突然跳走比不跳更莫名其妙 */
export const NOTIFICATION_PENDING_TTL_MS = 5 * 60 * 1000

export interface NotificationActivatePayload {
  /**
   * 是哪一条通知。对界面来说是个不透明的串，原样回传就行。
   *
   * 不能拿 `sessionId` 代替：**一条会话可以同时挂着两条通知**（上一轮的
   * 「任务失败」还留在通知中心，这一轮又卡在审批上）。按会话认的话，后点的
   * 那条会把先点的顶掉，先点的既收不掉也重弹不出来。
   */
  notificationKey: string
  /** **内核**会话 id（`agent-v3:*` 用的那个），不是界面上的会话 id */
  sessionId: string
  /**
   * 这条通知说的那次**审批**。
   *
   * 只跳到会话是不够的：确认框读的是待审批队列的**队首**，两条会话同时卡着
   * 审批时，用户点 B 的通知、跳到 B，眼前那张卡片却是 A 的。带上号才能把
   * 他要答的那条挑出来。
   *
   * 只有审批有这个字段。反问的卡片长在时间线上、跟着会话走，跳到会话就已经
   * 到位了，没有「队首是别人的」这回事 —— 把反问的号也塞进来只会让读代码的人
   * 以为界面拿它做了什么，而 `pendingApprovals` 里根本不会有这个号。
   */
  toolCallId?: string
}
