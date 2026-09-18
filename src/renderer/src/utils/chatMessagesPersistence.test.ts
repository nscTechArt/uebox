import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { takeHydratedTypingMessages, useChatMessagesStore } from '../store/modules/chatMessages'
import {
  CHAT_MESSAGES_STORAGE_KEY,
  createChatMessagesPersistencePlugin,
  type ChatMessagesCheckpointStorage,
  type ChatMessagesPersistedState
} from './chatMessagesPersistence'

function memoryStorage(initial?: string): ChatMessagesCheckpointStorage & {
  setItem: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
} {
  const values = new Map<string, string>()
  if (initial) values.set(CHAT_MESSAGES_STORAGE_KEY, initial)

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    flush: vi.fn()
  }
}

describe('chatMessagesPersistence', () => {
  let disposeStore: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    takeHydratedTypingMessages()
  })

  afterEach(() => {
    disposeStore?.()
    disposeStore = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function setup(
    storage: ChatMessagesCheckpointStorage,
    serialize = vi.fn((snapshot: ChatMessagesPersistedState) => JSON.stringify(snapshot))
  ): {
    store: ReturnType<typeof useChatMessagesStore>
    serialize: typeof serialize
  } {
    const pinia = createPinia()
    pinia.use(createChatMessagesPersistencePlugin({ storage, checkpointMs: 2000, serialize }))
    createApp({}).use(pinia)
    setActivePinia(pinia)
    const store = useChatMessagesStore()
    disposeStore = () => store.$dispose()
    return { store, serialize }
  }

  it('把连续流式更新合并到序列化之前，2 秒内只生成一个最新快照', () => {
    const storage = memoryStorage()
    const { store, serialize } = setup(storage)
    const typingId = store.pushAssistantTyping('chat-a')

    for (let index = 0; index < 100; index++) {
      store.replaceTyping('chat-a', typingId, `正文-${index}`, false)
      vi.advanceTimersByTime(10)
    }

    expect(serialize).not.toHaveBeenCalled()
    vi.advanceTimersByTime(999)
    expect(serialize).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(serialize).toHaveBeenCalledTimes(1)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(storage.flush).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.setItem.mock.calls[0][1]).messagesBySid['chat-a'][0].content).toBe(
      '正文-99'
    )
  })

  it('完成态立即保存终稿，并取消尚未触发的检查点', () => {
    const storage = memoryStorage()
    const { store, serialize } = setup(storage)
    const typingId = store.pushAssistantTyping('chat-a')
    store.replaceTyping('chat-a', typingId, '半截', false)

    store.replaceTyping('chat-a', typingId, '终稿', true)

    expect(serialize).toHaveBeenCalledTimes(1)
    expect(storage.flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(serialize).toHaveBeenCalledTimes(1)
  })

  it('恢复历史时保留 typing 供重连裁决，并清掉无法恢复的建议请求', () => {
    const storage = memoryStorage(
      JSON.stringify({
        messagesBySid: {
          'chat-a': [
            {
              id: 'typing-1',
              role: 'assistant',
              content: '已经写了一半',
              status: 'typing',
              suggestionsLoading: true
            }
          ]
        },
        historySummaryBySid: { 'chat-a': '摘要' },
        compressedUserCountBySid: { 'chat-a': 4 }
      })
    )
    const { store, serialize } = setup(storage)

    expect(store.getMessages('chat-a')[0]).toMatchObject({
      status: 'typing',
      suggestionsLoading: false
    })
    expect(store.getHistorySummary('chat-a')).toBe('摘要')
    expect(store.getCompressedUserCount('chat-a')).toBe(4)
    expect(takeHydratedTypingMessages()).toEqual([{ sid: 'chat-a', messageId: 'typing-1' }])
    expect(serialize).not.toHaveBeenCalled()
  })

  it('一次序列化失败后保留 dirty，后续检查点会重试最新状态', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const storage = memoryStorage()
    const serialize = vi
      .fn<(snapshot: ChatMessagesPersistedState) => string>()
      .mockImplementationOnce(() => {
        throw new Error('temporary failure')
      })
      .mockImplementation((snapshot) => JSON.stringify(snapshot))
    const { store } = setup(storage, serialize)

    store.pushUser('chat-a', '第一条')
    vi.advanceTimersByTime(2000)
    expect(storage.setItem).not.toHaveBeenCalled()

    store.pushUser('chat-a', '第二条')
    vi.advanceTimersByTime(2000)

    expect(serialize).toHaveBeenCalledTimes(2)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.setItem.mock.calls[0][1]).messagesBySid['chat-a']).toHaveLength(2)
  })
})
