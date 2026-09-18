/**
 * 「侧边问一句」的契约 —— 主窗口把上下文交给 MiniChat 窗口时带的那点东西。
 *
 * ## 为什么只传一个 sessionId
 *
 * 上下文本体是主进程里的一份 transcript，复制在主进程完成（见
 * `agent-v3:fork-for-side-chat`）。窗口之间只需要交换「用哪一份」这个标识 ——
 * 把几百条消息塞进 IPC 再在小窗口里反序列化一遍，除了慢没有任何好处。
 */
export interface SideChatContext {
  /** 复制出来的内核 sessionId。MiniChat 拿它当自己的 agent 会话 */
  agentSessionId: string
  /** 带过来多少条消息。界面拿它说明「承接了多少上下文」 */
  messageCount: number
  /** 主对话的标题，显示在小窗口的横幅上 */
  sourceTitle?: string
  /**
   * 主对话此刻是不是还在跑。
   *
   * 是的话这份上下文是**快照**：主对话之后又做了什么，侧边这边看不见。
   * 不说清楚的话，用户会以为小窗口在实时跟着看。
   */
  live?: boolean
}
