/**
 * 系统托盘菜单和界面之间共用的定义。
 *
 * 共用一个常量而不是两边各写一遍字符串：写错的那一半**不会报错**。
 * preload 白名单少一个字母是会当场抛 `[preload] Blocked api.on channel` 的
 * （见 `assertChannelAllowed`），真正没人管的是主进程发 A、界面听 B 而两个
 * 都在白名单里 —— 那时点托盘菜单只弹出窗口，跟没接这条线一模一样。
 */

/** 界面 → 主进程：最近活跃的三条对话变了，托盘菜单要跟着换 */
export const TRAY_SET_RECENT_SESSIONS_CHANNEL = 'tray:set-recent-sessions'

/** 主进程 → 界面：有一条托盘动作等着取。不带负载 —— 本体走 `tray:take-pending` 拿 */
export const TRAY_ACTION_CHANNEL = 'tray:action'

/**
 * 界面 → 主进程：取走存着的那条托盘动作（取走即清、超时不认）。
 *
 * 这是唯一的送达路径：`tray:action` 只是一句「有东西，来拿」，本身
 * 不带负载。界面收到提醒取一次、挂上来再取一次 —— 取走即清，两次
 * 取不会拿到同一条。和 agent 通知的 `pending` 同一个道理
 * （见 `services/agentNotifications/index.ts`）。
 */
export const TRAY_TAKE_PENDING_CHANNEL = 'tray:take-pending'

/** 界面 → 主进程：用户在应用内的确认框里选了「仍然退出」（主进程接着走发起退出的那条路） */
export const TRAY_CONFIRM_QUIT_CHANNEL = 'tray:confirm-quit'

/** 存着的托盘动作最多留这么久。超过就不认了 —— 一分钟后突然跳走比不跳更莫名其妙 */
export const TRAY_PENDING_TTL_MS = 60 * 1000

/** 「最近对话」「最近项目」各最多列几条 —— 主进程和界面用同一个上限 */
export const TRAY_RECENT_LIMIT = 3

/** 界面报给主进程的一条最近对话（托盘菜单只显示这么多信息） */
export interface TrayRecentSession {
  /** 界面上的对话 id（`?sid=` 那个），不是内核 session id */
  id: string
  title: string
}

/**
 * 托盘菜单点出来的动作。
 *
 * `plugin-failure` 复用首页那条「插件没装上」的对话框（`usePluginInstallNotice`），
 * 所以带的字段和导入接口回包里的同名：原因码原样透传，AI 认得。
 */
export type TrayAction =
  | { type: 'open-session'; sessionId: string }
  | { type: 'new-session' }
  | {
      type: 'plugin-failure'
      pluginFailure: string
      /** `.uproject` 的绝对路径 —— 用户选「让 AI 看看」时它要去读这个文件 */
      originPath: string
      projectName: string
    }
  /**
   * 退出时还有操作没收摊（按内核 session 算）：界面弹应用内的确认框，确认了回 `tray:confirm-quit`。
   * 托盘、`app-quit`、安装更新都走这一条；`reason: 'update'` 时框的标题和按钮换成
   * 「重启安装」那套，其余不带
   */
  | { type: 'confirm-quit'; count: number; reason?: 'update' }
  /** 系统通知用不了时，打开工程的失败原因改由界面弹出来 */
  | { type: 'open-failed'; title: string; body: string }
