/**
 * 主窗口 ⇄ 独立对话窗口的对话同步（接线部分；计算在 `chatWindowSyncCore.ts`）。
 *
 * ## 分工
 *
 * - 一轮由哪个窗口发起，事件就只到哪个窗口（主进程原有的规矩，没改）。它照常处理
 *   事件、照常收尾，然后把自己 store 里变了的部分作为补丁发出去。
 * - 另一个窗口只接补丁：正在打字的那条气泡每秒重画约 8 次，补丁跟着走，看到的就是实时的。
 * - 落盘只由主窗口写。独立窗口的对话存储是只读的，它的改动靠补丁交给主窗口去存。
 *
 * 所以两边都能显示、都能发消息（谁发谁就成了那一轮的发起者），也都能停止和审批
 * （停止按内核 session 找，审批按工具调用 id 找，主进程都不认窗口）。
 *
 * ## 同步哪些对话
 *
 * 只有开在独立窗口里的那几条。主窗口其余的对话照旧只活在主窗口里，一个字节都不多发。
 *
 * 再加上它们派生出来的语音任务对话：通话开在小窗里时，派出去的活落在
 * `voice-tasks-<sid>::<灶>` 上（见 `shared/voiceTaskSession.ts`），这些对话在小窗里建、
 * 在小窗里跑，也得同步回主窗口存盘、显示在侧边栏里。
 */

import { watch } from 'vue'

import type { ChatSyncPatch } from '@core/shared/chatWindowSync'
import { chatWindowAPI, chatWindowSid, isChatWindow } from '@renderer/api/chatWindow'
import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

import { belongsToChat, voiceTaskOwnerSid } from '@core/shared/voiceTaskSession'

import { setDetachedChats } from './detachedChats'
import {
  buildPatch,
  emptyKnownState,
  rememberPatch,
  type KnownState,
  type LocalState
} from './chatWindowSyncCore'

/** 攒多久发一次。和气泡重画的节奏（120ms）差不多，多攒也看不出区别 */
export const CHAT_SYNC_FLUSH_MS = 100

/** 只动一条消息的 action：第二个参数是那条消息的 id，只比它就够 */
const SINGLE_MESSAGE_ACTIONS = new Set([
  'replaceTyping',
  'appendToTyping',
  'stopTyping',
  'setSuggestions',
  'setSuggestionsLoading',
  'clearActionButtons',
  'markTypingInterrupted'
])

/** 只读的 action，不会改 store */
const READ_ONLY_ACTIONS = /^(get|is|has|extract|sessionBy|sessionsOf|export)/

interface SidState {
  known: KnownState
  /** 被动过的消息；'all' = 不知道动了哪条，每条都比 */
  dirty: Set<string> | 'all'
  timer: ReturnType<typeof setTimeout> | null
}

export type ChatWindowSyncRole = 'main' | 'chat-window'

/** 同步要用到的那几条桥（`api/chatWindow.ts` 的子集），测试里换成假的 */
export interface ChatWindowSyncBridge {
  push: (patch: ChatSyncPatch) => void
  onApply: (callback: (patch: ChatSyncPatch) => void) => () => void
  list: () => Promise<string[]>
  onChanged: (callback: (chatSids: string[]) => void) => () => void
  requestSnapshot: (chatSid: string) => void
  onSnapshotRequest: (callback: (args: { sid: string }) => void) => () => void
  bindAgentSession: (chatSid: string, agentSessionId: string) => void
  resendApprovals: (sessionIds: string[]) => Promise<number>
  runsElsewhere: () => Promise<string[]>
  onRunsElsewhere: (callback: (sessionIds: string[]) => void) => void
}

export interface ChatWindowSyncOptions {
  role: ChatWindowSyncRole
  /** 独立窗口开的是哪条对话（主窗口不用填） */
  ownSid?: string
  bridge: ChatWindowSyncBridge
  /** 独立窗口这条对话在主窗口里被删了 */
  closeWindow: () => void
}

/**
 * 这个窗口要不要参与同步、以什么身份。
 *
 * MiniChat、Spotlight、Agent 浏览器窗口不参与：它们有自己的一套，混进来只会多一份
 * 互相覆盖的副本。
 */
export function chatWindowSyncRole(hash = window.location.hash): ChatWindowSyncRole | null {
  if (isChatWindow()) return 'chat-window'
  if (/^#\/(mini-chat|spotlight|agent-browser|screen-selection|screen-recorder)/.test(hash)) {
    return null
  }
  return 'main'
}

let installed = false

/** 应用启动时装一次（`main.ts`，对话历史读进来之后） */
export function installChatWindowSync(): void {
  if (installed) return
  const role = chatWindowSyncRole()
  if (!role) return
  installed = true

  const sync = createChatWindowSync({
    role,
    ownSid: chatWindowSid(),
    closeWindow: () => window.close(),
    bridge: {
      ...chatWindowAPI,
      onRunsElsewhere: (callback) => {
        window.api?.on?.('agent-v3:runs-elsewhere', (...args: unknown[]) => {
          callback(Array.isArray(args[0]) ? (args[0] as string[]) : [])
        })
      }
    }
  })

  // 关窗、刷新之前把攒着的补丁发掉，最后那 100 毫秒的字别丢
  window.addEventListener('beforeunload', () => sync.flushAll())
}

/**
 * 装上同步，用的是**当前激活的 pinia** 里的那几个 store。
 *
 * 和 `installChatWindowSync` 分开是为了测试：两个 pinia 各装一份，中间接一根假的
 * 主进程，就是两个窗口。
 */
export function createChatWindowSync(options: ChatWindowSyncOptions): { flushAll: () => void } {
  const { role, bridge } = options
  const chatMsgStore = useChatMessagesStore()
  const chatStore = useChatSessionsStore()
  const streamStore = useAgentStreamStore()

  const tracked = new Map<string, SidState>()
  /** 正在打补丁：这期间 store 的变化是别人的，不能再当成自己的发回去 */
  let applying = false

  const ownSid = role === 'chat-window' ? (options.ownSid ?? '') : ''
  /**
   * 独立窗口拿到主窗口那份全量之前**一个补丁都不发**。
   *
   * 它此刻手里的是盘上读来的，最多落后主窗口两秒；页面挂载时随手改一下对话
   * （开关模式、建消息容器），就会把这份旧的当成改动发过去，盖掉主窗口里正在打字的
   * 那条。全量一到，这边被整份换掉，之前攒的改动也就不算数了。
   */
  let ready = role === 'main'

  function track(sid: string): SidState {
    let state = tracked.get(sid)
    if (!state) {
      state = { known: emptyKnownState(), dirty: 'all', timer: null }
      tracked.set(sid, state)
    }
    return state
  }

  /** 独立窗口管的对话：它开着的那条，加上那通电话派生的任务对话 */
  function owns(sid: string): boolean {
    return role === 'chat-window' && belongsToChat(sid, ownSid)
  }

  /**
   * 这条对话该不该同步。独立窗口里新建出来的任务对话第一次被动到时登记上。
   *
   * 还有这个窗口**正在跑**的别的对话：小窗里打的电话可以把活派给侧边栏里任何一条对话
   * （`voiceAssistant` 的 `listVoiceSessions`），那一轮的事件只到这里，不同步的话
   * 气泡和提问卡片只活在小窗里，主窗口看不到，也没人存盘。
   */
  function syncable(sid: unknown): sid is string {
    if (typeof sid !== 'string' || !sid) return false
    if (tracked.has(sid)) return true
    if (!owns(sid) && !(role === 'chat-window' && streamStore.getStream(sid))) return false
    track(sid)
    return true
  }

  function untrack(sid: string): void {
    const state = tracked.get(sid)
    if (state?.timer) clearTimeout(state.timer)
    tracked.delete(sid)
  }

  function localState(sid: string): LocalState {
    const session = chatStore.sessionById(sid)
    const permissionMode = chatStore.getPermissionMode(sid)
    const draft = chatStore.getDraft(sid)
    const summary = chatMsgStore.getHistorySummary(sid)
    const count = chatMsgStore.getCompressedUserCount(sid)
    return {
      messages: chatMsgStore.getMessages(sid) as unknown as LocalState['messages'],
      session: session ? (session as unknown as Record<string, unknown>) : null,
      permissionMode: permissionMode ?? null,
      draft: draft || null,
      historySummary: summary || null,
      compressedUserCount: count || null
    }
  }

  function flush(sid: string, full = false): void {
    const state = tracked.get(sid)
    if (!state) return
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    // 还没拿到全量：改动先攒着（dirty 不清），下一次改动会重新排上
    if (!ready) return
    const dirty = state.dirty
    state.dirty = new Set()
    const patch = buildPatch(sid, localState(sid), state.known, dirty, full)
    if (patch) bridge.push(patch)
  }

  function schedule(state: SidState, sid: string, immediate: boolean): void {
    if (immediate) {
      flush(sid)
      return
    }
    if (!state.timer) state.timer = setTimeout(() => flush(sid), CHAT_SYNC_FLUSH_MS)
  }

  /** 消息变了。不给 id = 不知道是哪条（增删、截断、整份替换） */
  function markMessagesDirty(sid: string, messageId?: string, immediate = false): void {
    const state = tracked.get(sid)
    if (!state) return
    if (messageId === undefined) state.dirty = 'all'
    else if (state.dirty !== 'all') state.dirty.add(messageId)
    schedule(state, sid, immediate)
  }

  /**
   * 只有对话记录、档位、草稿这些变了：消息一条都不用比。
   *
   * 草稿每敲一个字变一次，这时候把一条长对话的每条消息都序列化一遍纯属浪费。
   */
  function markSessionDirty(sid: string): void {
    const state = tracked.get(sid)
    if (!state) return
    schedule(state, sid, false)
  }

  chatMsgStore.$onAction(({ name, args, after }) => {
    if (applying || READ_ONLY_ACTIONS.test(name) || name === 'applySyncMessages') return
    after(() => {
      // 复制消息：动的是目标那条（第二个参数）
      const sid = name === 'copySessionMessages' ? args[1] : args[0]
      const sids = Array.isArray(sid) ? sid : [sid]
      const single = SINGLE_MESSAGE_ACTIONS.has(name) && typeof args[1] === 'string'
      // 一条回复写完了：终稿立刻发，别让对面停在最后一帧半截上
      const final = name === 'replaceTyping' && args[3] === true
      for (const target of sids) {
        if (!syncable(target)) continue
        markMessagesDirty(target, single ? (args[1] as string) : undefined, final)
      }
    })
  })

  chatStore.$onAction(({ name, args, after }) => {
    if (applying || READ_ONLY_ACTIONS.test(name) || name === 'applySyncSession') return
    after(() => {
      for (const sid of sessionActionTargets(args)) {
        // 主窗口把开在独立窗口里的那条删了：告诉那边，它会关掉自己
        if (
          role === 'main' &&
          (name === 'removeSession' || name === 'removeSessions') &&
          !chatStore.sessionById(sid)
        ) {
          bridge.push({ sid, deleted: true })
          untrack(sid)
          continue
        }
        markSessionDirty(sid)
      }
    })
  })

  /**
   * 对话这边的 action 动到了哪几条被同步的对话。
   *
   * 大多数第一个参数就是对话 id；也有按别的东西批量改的（`renameProject` 按工程名），
   * 认不出来就每条都比一遍 —— 没变的不会发，比一遍也只比对话记录那几个字段。
   */
  function sessionActionTargets(args: unknown[]): string[] {
    const first = args[0]
    if (Array.isArray(first)) return first.filter(syncable)
    if (typeof first === 'string') {
      if (syncable(first)) return [first]
      // 别的、没被同步的对话
      if (chatStore.sessionById(first)) return []
    }
    return [...tracked.keys()]
  }

  bridge.onApply((patch: ChatSyncPatch) => {
    const sid = patch.sid
    if (!sid) return
    if (patch.deleted) {
      if (role === 'chat-window' && sid === ownSid) options.closeWindow()
      return
    }
    if (role === 'chat-window' && !owns(sid) && !tracked.has(sid)) return
    const state = track(sid)

    // 这边正在流式写的那条气泡归这边管，见 `applyMessagesPatch`
    const stream = streamStore.getStream(sid)
    const protectedId = stream?.isStreaming ? stream.currentTypingId : null

    applying = true
    let skipped = new Set<string>()
    try {
      skipped = chatMsgStore.applySyncMessages(sid, patch, protectedId)
      chatStore.applySyncSession(sid, patch)
    } finally {
      applying = false
    }
    rememberPatch(state.known, patch, localState(sid), skipped)
    if (patch.full && !ready) {
      ready = true
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
      state.dirty = new Set()
    }
    // 挡掉的那条要把这边的版本发回去，对方那份才会跟上
    for (const id of skipped) markMessagesDirty(sid, id)
  })

  if (role === 'main') {
    const syncTracked = (sids: string[]): void => {
      setDetachedChats(sids)
      const next = new Set(sids)
      // 派生的任务对话跟着它那条走：那条还开着就留着
      for (const sid of [...tracked.keys()]) {
        if (!next.has(sid) && !next.has(voiceTaskOwnerSid(sid))) untrack(sid)
      }
      for (const sid of next) track(sid)
    }
    // 启动时问一次；但问的路上要是已经来过一次变更通知，以通知为准 ——
    // 回来晚的那份是旧的，照它来会把刚拖出去的那条又摘掉
    let notified = false
    bridge.onChanged((sids) => {
      notified = true
      syncTracked(sids)
    })
    void bridge.list().then((sids) => {
      if (!notified) syncTracked(sids)
    })

    // 独立窗口刚起来要一份全量：盘上那份最多落后两秒，正在打字的那条是半截的
    // 派生的任务对话一起给：之前在主窗口打的电话派过的活，小窗里接着用同一个灶
    bridge.onSnapshotRequest(({ sid }) => {
      if (!sid) return
      const derived = chatStore.sessions
        .map((session) => session.id)
        .filter((id) => id !== sid && belongsToChat(id, sid))
      for (const target of [sid, ...derived]) {
        const state = track(target)
        state.known = emptyKnownState()
        flush(target, true)
      }
    })
  } else if (ownSid) {
    track(ownSid)
    // 主窗口可能正在刷新、还没装上这一层，要不到就隔一会儿再要
    let attempts = 0
    const requestSnapshot = (): void => {
      if (ready || attempts >= 10) return
      attempts += 1
      bridge.requestSnapshot(ownSid)
      setTimeout(requestSnapshot, 2000)
    }
    requestSnapshot()
    bindAgentSession(ownSid)
  }

  installBusyElsewhere()

  /**
   * 独立窗口把自己那条对话的内核 session id 报给主进程。
   *
   * 主进程只认内核 session id：审批该多弹给谁，要靠它找到这个窗口。这个 id 第一条消息
   * 发出去才有、清空对话会换，所以盯着它变。第一次拿到时顺带要一遍待审批 ——
   * 拖出来那一刻主窗口那边可能正弹着确认框。
   */
  function bindAgentSession(sid: string): void {
    watch(
      () => chatStore.getAgentSessionId(sid),
      (agentSessionId, previous) => {
        bridge.bindAgentSession(sid, agentSessionId || '')
        if (agentSessionId && agentSessionId !== previous) {
          void bridge.resendApprovals([agentSessionId])
        }
      },
      { immediate: true }
    )
  }

  /**
   * 「这条对话在别的窗口里跑着」。
   *
   * 主进程报的是内核 session id，判忙按的是对话 id，所以在这里对一下。对话记录里的
   * 内核 id 也会变（同步过来的、刚发出第一条的），一起盯着。
   */
  function installBusyElsewhere(): void {
    let runningElsewhere: string[] = []
    const recompute = (): void => {
      const chatSids = runningElsewhere
        .map((agentSessionId) => chatStore.sessionByAgentSessionId(agentSessionId)?.id)
        .filter((sid): sid is string => Boolean(sid))
      streamStore.setBusyElsewhere(chatSids)
    }
    bridge.onRunsElsewhere((ids) => {
      runningElsewhere = ids
      recompute()
    })
    void bridge.runsElsewhere().then((ids) => {
      runningElsewhere = ids
      recompute()
    })
    watch(() => chatStore.sessions.map((session) => session.agentSessionId), recompute)
  }

  return {
    flushAll: () => {
      for (const sid of tracked.keys()) flush(sid)
    }
  }
}
