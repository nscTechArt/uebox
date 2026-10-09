/**
 * 主窗口和独立对话窗口之间同步一条对话用的补丁。
 *
 * 两个窗口各有一份对话 store，谁改了就发一份补丁，主进程转给另一边
 * （见 `main/chatWindowManager.ts`）。补丁只带**变了的部分**：正在打字的那条气泡
 * 一秒变好几次，每次都整条对话发一遍的话，长对话的过程日志能有好几 MB。
 *
 * 字段都是可选的 —— 缺省表示「这部分没变」，不是「清空」。
 */

export interface ChatSyncSessionPatch {
  /** false = 这条对话记录不存在（还没发过消息，或者被删了） */
  exists: boolean
  /** 变了的字段，整个值带过来 */
  fields?: Record<string, unknown>
  /** 被拿掉的字段（`delete session.x` 或改成 undefined） */
  removed?: string[]
}

export interface ChatSyncPatch {
  /** 界面这边的对话 id */
  sid: string
  /**
   * 全量：接收方把这条对话整份换成补丁里的样子。
   *
   * 独立窗口刚打开时要一次 —— 它从盘上读到的那份最多落后主窗口两秒，
   * 正在打字的那条气泡在盘上是半截的。
   */
  full?: boolean
  /** 这条对话被删了。独立窗口收到就关掉自己 */
  deleted?: boolean
  session?: ChatSyncSessionPatch
  /** 这条对话的权限档位；null = 跟随默认 */
  permissionMode?: string | null
  /** 输入框里没发出去的草稿 */
  draft?: string | null
  /** 消息顺序（id 列表）。只有增删、重排时才带 */
  order?: string[]
  /** 变了的消息，每条整条带 */
  messages?: Array<{ id: string } & Record<string, unknown>>
  historySummary?: string | null
  compressedUserCount?: number | null
}
