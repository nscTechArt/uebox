import type { PiniaPluginContext, StoreGeneric } from 'pinia'
import type { ChatSessionSource } from '../store/modules/chatMessages'
import { chatHistoryStorage } from './chatHistoryStorage'

export const CHAT_MESSAGES_STORE_ID = 'chat-messages'
export const CHAT_MESSAGES_CHECKPOINT_MS = 2000

export interface ChatMessagesPersistedState {
  messagesBySid: Record<string, unknown[]>
  historySummaryBySid: Record<string, string>
  compressedUserCountBySid: Record<string, number>
}

export interface ChatSessionWrite {
  sid: string
  /** null = 这个对话删掉了 */
  json: string | null
  typing?: string[]
}

/** 对话正文的盘。默认接主进程（`main/ipc/chatSessionFiles.ts`），测试里换成内存 */
export interface ChatSessionsBackend {
  source(): ChatSessionSource
  write(writes: ChatSessionWrite[]): void
  /** 独立窗口、MiniChat 不写盘，改动交给主窗口存 */
  readOnly(): boolean
}

interface ChatMessagesPersistenceStore extends StoreGeneric {
  attachSessionSource: (source: ChatSessionSource) => void
  exportSession: (sid: string) => { json: string; typing: string[] } | null | undefined
  loadedSessionIds: () => string[]
}

interface ChatMessagesPersistenceOptions {
  backend?: ChatSessionsBackend
  checkpointMs?: number
}

// `ensureContainer` 不在里面：它只建一个空容器，真有内容时后面的动作会记上
const MUTATING_ACTIONS = new Set([
  'pushUser',
  'insertUserBefore',
  'pushAssistantTyping',
  'pushAssistant',
  'replaceTyping',
  'appendToTyping',
  'stopTyping',
  'clearSessionMessages',
  'dropSession',
  'dropSessions',
  'replaceSessionMessages',
  'setSuggestions',
  'setSuggestionsLoading',
  'deleteMessagesFromIndex',
  'clearActionButtons',
  'updateUserMessage',
  'setCompressedUserCount',
  'setHistorySummary',
  'clearHistorySummary',
  'copySessionMessages',
  'markTypingInterrupted',
  // 独立对话窗口发来的改动：只有主窗口会落盘（独立窗口的存储是只读的）
  'applySyncMessages'
])

/** 这次改动碰了哪几个对话。约定是第一个参数；两个例外单列 */
function touchedSids(name: string, args: unknown[]): string[] {
  const raw =
    name === 'dropSessions'
      ? Array.isArray(args[0])
        ? args[0]
        : []
      : name === 'copySessionMessages'
        ? [args[1]]
        : [args[0]]
  return raw.map((sid) => String(sid || '').trim()).filter(Boolean)
}

export const defaultChatSessionsBackend: ChatSessionsBackend = {
  source: () => {
    const index = chatHistoryStorage.sessionIndex
    return {
      typing: new Map(
        Object.entries(index)
          .filter(([, entry]) => entry.typing?.length)
          .map(([sid, entry]) => [sid, entry.typing!])
      ),
      read: (sid) => window.api?.chatHistory?.readSessionSync?.(sid) ?? null
    }
  },
  write: (writes) => {
    void window.api?.chatHistory?.writeSessions?.(writes)?.catch((error: unknown) => {
      console.error(`[ChatMessagesPersistence] 写入 ${writes.length} 个对话失败:`, error)
    })
  },
  readOnly: () => chatHistoryStorage.isReadOnly
}

/**
 * 对话消息专用的持久化插件。
 *
 * 一个对话一个文件，**只写改过的那几个**：监听 Store action，记下碰过哪些对话，
 * 检查点到了逐个序列化。原来是每次把全部对话拼成一份整体重写，历史到了
 * 一百多 MB 时每 2 秒卡一下，最后还撑爆了 IPC。
 */
export function createChatMessagesPersistencePlugin(
  options: ChatMessagesPersistenceOptions = {}
): (context: PiniaPluginContext) => void {
  const backend = options.backend ?? defaultChatSessionsBackend
  const checkpointMs = options.checkpointMs ?? CHAT_MESSAGES_CHECKPOINT_MS

  return ({ store }: PiniaPluginContext): void => {
    if (store.$id !== CHAT_MESSAGES_STORE_ID) return

    const chatStore = store as ChatMessagesPersistenceStore
    const dirty = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearCheckpointTimer = (): void => {
      if (!timer) return
      clearTimeout(timer)
      timer = null
    }

    const persistNow = (all = false): void => {
      clearCheckpointTimer()
      const sids = all ? new Set([...dirty, ...chatStore.loadedSessionIds()]) : new Set(dirty)
      dirty.clear()
      if (sids.size === 0 || backend.readOnly()) return

      const writes: ChatSessionWrite[] = []
      for (const sid of sids) {
        try {
          const exported = chatStore.exportSession(sid)
          // 盘上那份读不出来：不拿内存里这份去盖它
          if (exported === undefined) continue
          writes.push(
            exported ? { sid, json: exported.json, typing: exported.typing } : { sid, json: null }
          )
        } catch (error) {
          // 留着 dirty，下一次改动会重新安排检查点，临时失败不会让后续历史停更
          dirty.add(sid)
          console.error(`[ChatMessagesPersistence] 序列化对话 ${sid} 失败:`, error)
        }
      }
      if (writes.length > 0) backend.write(writes)
    }

    const scheduleCheckpoint = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        persistNow()
      }, checkpointMs)
    }

    Object.defineProperty(chatStore, '$persist', {
      configurable: true,
      value: () => persistNow(true)
    })

    chatStore.attachSessionSource(backend.source())

    const unsubscribeActions = chatStore.$onAction(({ name, args, after }) => {
      if (!MUTATING_ACTIONS.has(name)) return

      after(() => {
        for (const sid of touchedSids(name, args)) dirty.add(sid)
        // 完成态是用户真正需要保住的终稿，不等下一次恢复检查点。
        const isFinalReplace = name === 'replaceTyping' && args[3] === true
        if (isFinalReplace) {
          persistNow()
          return
        }
        scheduleCheckpoint()
      })
    })

    const originalDispose = chatStore.$dispose.bind(chatStore)
    chatStore.$dispose = (): void => {
      clearCheckpointTimer()
      unsubscribeActions()
      originalDispose()
    }
  }
}

export const chatMessagesPersistencePlugin = createChatMessagesPersistencePlugin()
