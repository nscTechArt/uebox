/**
 * 这条会话是哪个窗口发起的。
 *
 * ## 为什么不能用 `activeAgents`
 *
 * `ipc/agentV3.ts` 的 `reserveRun` 确实记了 `senderId`，但那条记录跑完就被
 * `activeAgents.release()` 摘掉了 —— 而通知恰恰是**跑完之后**才弹的，用户点
 * 它的时候那份归属已经没了。
 *
 * ## 谁需要它
 *
 * 系统通知。MiniChat 是独立窗口，跑的是完整的 agent-v3 会话，但它的会话数据
 * 只活在它自己的渲染进程里（`chat-sessions:refresh` 同步过去的只有标题和气泡，
 * 没有 `agentSessionId`）。不看归属就一律拉主窗口的话，用户点 MiniChat 那条
 * 会话的审批通知，弹出来的是主窗口，而要点的按钮在小窗口里 —— 比不跳还糟。
 */

/** 会话 id → `webContents.id`。按插入序留最近这些，见 `LIMIT` */
const owners = new Map<string, number>()

/**
 * 最多记这么多条。
 *
 * 会话是用户创建的、没有上限，而这张表只服务「刚跑完的那几条」——
 * 不封顶的话它会跟着应用的运行时长一直长。Map 保插入序，超了就丢最旧的。
 */
const LIMIT = 200

export function rememberRunOwner(sessionId: string, webContentsId: number): void {
  if (!sessionId) return
  // 先删再插：已经在表里的要挪到队尾，否则一条常用会话会因为「最早插入」被淘汰
  owners.delete(sessionId)
  owners.set(sessionId, webContentsId)
  if (owners.size > LIMIT) {
    const oldest = owners.keys().next()
    if (!oldest.done) owners.delete(oldest.value)
  }
}

export function runOwnerWebContentsId(sessionId: string): number | undefined {
  return owners.get(sessionId)
}

/** 测试用：清空 */
export function resetRunOwnersForTest(): void {
  owners.clear()
}
