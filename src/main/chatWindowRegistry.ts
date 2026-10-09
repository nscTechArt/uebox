/**
 * 独立对话窗口的登记表：哪条对话开在哪个窗口里。
 *
 * 只管「谁和谁」，不碰 Electron —— 窗口的建、关、藏在 `chatWindowManager.ts`。
 * 拆开是为了把「同步消息该转给谁、审批该多给谁看一份」这几条规则放在能单测的地方，
 * 这几条错了的后果都是静默的：消息没同步过去、确认框弹在用户没看的那个窗口。
 *
 * ## 一条对话只开一个独立窗口
 *
 * 再拖一次同一条对话，是把已经开着的那个窗口提到前面，不是再开一个。
 * 两个独立窗口显示同一条对话没有任何用处，却会让「同步转给谁」从一对一变成一对多。
 *
 * ## 小窗里开的语音通话，派生的任务对话也归它
 *
 * 语音派出去的活落在从说话那条对话派生出来的任务对话上（`voice-tasks-<sid>::<灶>`，
 * 见 `shared/voiceTaskSession.ts`）。通话开在小窗里，这些对话就在小窗里建、在小窗里跑，
 * 它们也得同步回主窗口存盘 —— 所以「这个窗口管哪些对话」按派生关系算，不只是它开着的那一条。
 */

import { voiceTaskOwnerSid } from '../shared/voiceTaskSession'

export interface ChatWindowEntry {
  /** 界面这边的对话 id（标签页、消息、草稿都用它） */
  chatSid: string
  webContentsId: number
  /**
   * 这条对话在内核那边的会话 id。
   *
   * 主进程只认它（审批、运行登记都按它记），而它要等第一条消息发出去才有，
   * 之后也可能变（清空对话会换一个）。所以由窗口自己报上来，不在打开时定死。
   */
  agentSessionId?: string
}

export class ChatWindowRegistry {
  private readonly entries = new Map<string, ChatWindowEntry>()

  register(chatSid: string, webContentsId: number): void {
    if (!chatSid) return
    this.entries.set(chatSid, { chatSid, webContentsId })
  }

  /** 窗口没了。返回它开着的那条对话，没登记过就是 undefined */
  removeByWebContents(webContentsId: number): string | undefined {
    for (const [chatSid, entry] of this.entries) {
      if (entry.webContentsId !== webContentsId) continue
      this.entries.delete(chatSid)
      return chatSid
    }
    return undefined
  }

  /** 管这条对话的独立窗口：开着它的，或者开着它派生自的那条的 */
  webContentsOf(chatSid: string): number | undefined {
    const direct = this.entries.get(chatSid)
    if (direct) return direct.webContentsId
    const owner = voiceTaskOwnerSid(chatSid)
    return owner ? this.entries.get(owner)?.webContentsId : undefined
  }

  chatSidOf(webContentsId: number): string | undefined {
    for (const entry of this.entries.values()) {
      if (entry.webContentsId === webContentsId) return entry.chatSid
    }
    return undefined
  }

  isChatWindow(webContentsId: number): boolean {
    return this.chatSidOf(webContentsId) !== undefined
  }

  /** 窗口报上来它那条对话现在的内核 session id。只认它自己那条，报别人的不算 */
  bindAgentSession(webContentsId: number, chatSid: string, agentSessionId: string): void {
    const entry = this.entries.get(chatSid)
    if (!entry || entry.webContentsId !== webContentsId) return
    entry.agentSessionId = agentSessionId || undefined
  }

  /** 这个窗口那条对话现在的内核 session id */
  agentSessionOf(webContentsId: number): string | undefined {
    for (const entry of this.entries.values()) {
      if (entry.webContentsId === webContentsId) return entry.agentSessionId
    }
    return undefined
  }

  webContentsOfAgentSession(agentSessionId: string): number | undefined {
    if (!agentSessionId) return undefined
    for (const entry of this.entries.values()) {
      if (entry.agentSessionId === agentSessionId) return entry.webContentsId
    }
    return undefined
  }

  chatSids(): string[] {
    return [...this.entries.keys()]
  }

  /**
   * 一份同步补丁该转给谁。
   *
   * 落盘只有主窗口一个人写（独立窗口的对话存储是只读的），所以：
   *   - 独立窗口改了自己那条 → 转给主窗口，由它存盘；
   *   - 主窗口改了某条 → 只转给开着这条的独立窗口，没开就谁也不转。
   * 别的窗口（MiniChat、Spotlight）不参与：它们有自己的一套，混进来只会多一份
   * 互相覆盖的副本。
   */
  relayTargets(senderId: number, chatSid: string, mainId: number | undefined): number[] {
    if (senderId === mainId) {
      const target = this.webContentsOf(chatSid)
      return target === undefined ? [] : [target]
    }
    // 独立窗口的补丁一律交给主窗口：除了它管的那几条，它也可能在跑别的对话
    // （小窗里打的电话把活派给了侧边栏里的某一条），那一轮的结果也得由主窗口存
    if (!this.isChatWindow(senderId)) return []
    return mainId === undefined ? [] : [mainId]
  }

  /**
   * 审批除了发起窗口，还要给谁看一份。
   *
   *   - 发起的是独立窗口 → 主窗口也弹：主窗口是总台，用户可能正对着它；
   *   - 这条对话开在某个独立窗口里、却是别的窗口发起的 → 那个独立窗口也弹：
   *     用户正看着它，确认框却弹在被挡住的主窗口上。
   * 两边都不沾（主窗口自己的对话、MiniChat 的对话）就不镜像，和原来一样。
   */
  approvalMirrors(sessionId: string, ownerId: number, mainId: number | undefined): number[] {
    const targets = new Set<number>()
    if (this.isChatWindow(ownerId) && mainId !== undefined) targets.add(mainId)
    const viewer = this.webContentsOfAgentSession(sessionId)
    if (viewer !== undefined) targets.add(viewer)
    targets.delete(ownerId)
    return [...targets]
  }
}
