import type { PiniaPluginContext, StoreGeneric } from 'pinia'
import { chatHistoryStorage } from './chatHistoryStorage'

export const CHAT_MESSAGES_STORE_ID = 'chat-messages'
export const CHAT_MESSAGES_STORAGE_KEY = 'chat-messages'
export const CHAT_MESSAGES_CHECKPOINT_MS = 2000

export interface ChatMessagesPersistedState {
  messagesBySid: Record<string, unknown[]>
  historySummaryBySid: Record<string, string>
  compressedUserCountBySid: Record<string, number>
}

interface ChatMessagesPersistenceStore extends StoreGeneric {
  exportChatMessagesPersistence: () => ChatMessagesPersistedState
  hydrateChatMessagesPersistence: (snapshot: unknown) => void
}

export interface ChatMessagesCheckpointStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  flush(): void
}

interface ChatMessagesPersistenceOptions {
  storage?: ChatMessagesCheckpointStorage
  checkpointMs?: number
  serialize?: (snapshot: ChatMessagesPersistedState) => string
  deserialize?: (value: string) => unknown
}

const MUTATING_ACTIONS = new Set([
  'ensureContainer',
  'pushUser',
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
  'markTypingInterrupted'
])

/**
 * 聊天消息专用的持久化插件。
 *
 * `pinia-plugin-persistedstate` 会在每次深层 mutation 后先序列化整棵 Store，之后才
 * 调 storage.setItem。把节流写在 Storage 里只能合并磁盘 IPC，拦不住最贵的
 * JSON.stringify。这里改成监听 Store action，只记一个 dirty 标记；等检查点到了
 * 才从 Store 取最新快照并序列化一次。
 */
export function createChatMessagesPersistencePlugin(
  options: ChatMessagesPersistenceOptions = {}
): (context: PiniaPluginContext) => void {
  const storage = options.storage ?? chatHistoryStorage
  const checkpointMs = options.checkpointMs ?? CHAT_MESSAGES_CHECKPOINT_MS
  const serialize = options.serialize ?? JSON.stringify
  const deserialize = options.deserialize ?? JSON.parse

  return ({ store }: PiniaPluginContext): void => {
    if (store.$id !== CHAT_MESSAGES_STORE_ID) return

    const chatStore = store as ChatMessagesPersistenceStore
    let dirty = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearCheckpointTimer = (): void => {
      if (!timer) return
      clearTimeout(timer)
      timer = null
    }

    const persistNow = (force = false): void => {
      clearCheckpointTimer()
      if (!dirty && !force) return

      try {
        const value = serialize(chatStore.exportChatMessagesPersistence())
        storage.setItem(CHAT_MESSAGES_STORAGE_KEY, value)
        // 序列化已经在检查点层完成，立即交给主进程落盘，避免再叠一层 2 秒延迟。
        storage.flush()
        dirty = false
      } catch (error) {
        // 保留 dirty；下一次 mutation 会重新安排检查点，临时失败不会让后续历史停更。
        console.error('[ChatMessagesPersistence] 保存聊天历史失败:', error)
      }
    }

    const scheduleCheckpoint = (): void => {
      dirty = true
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        persistNow()
      }, checkpointMs)
    }

    const hydrate = (): void => {
      const raw = storage.getItem(CHAT_MESSAGES_STORAGE_KEY)
      if (!raw) return

      try {
        chatStore.hydrateChatMessagesPersistence(deserialize(raw))
      } catch (error) {
        console.error('[ChatMessagesPersistence] 读取聊天历史失败，本次使用空历史:', error)
      }
    }

    Object.defineProperty(chatStore, '$persist', {
      configurable: true,
      value: () => {
        dirty = true
        persistNow()
      }
    })
    Object.defineProperty(chatStore, '$hydrate', {
      configurable: true,
      value: hydrate
    })

    hydrate()

    const unsubscribeActions = chatStore.$onAction(({ name, args, after }) => {
      if (!MUTATING_ACTIONS.has(name)) return

      after(() => {
        // 完成态是用户真正需要保住的终稿，不等下一次恢复检查点。
        const isFinalReplace = name === 'replaceTyping' && args[3] === true
        if (isFinalReplace) {
          dirty = true
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
