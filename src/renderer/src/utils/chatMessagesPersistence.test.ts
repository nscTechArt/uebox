import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { takeHydratedTypingMessages, useChatMessagesStore } from '../store/modules/chatMessages'
import {
  createChatMessagesPersistencePlugin,
  type ChatSessionWrite,
  type ChatSessionsBackend
} from './chatMessagesPersistence'

/** 内存里的「盘」：sid → 那个对话的 JSON */
function memoryBackend(
  files: Record<string, string> = {},
  typing: Record<string, string[]> = {},
  readOnly = false
): ChatSessionsBackend & {
  write: Mock<(writes: ChatSessionWrite[]) => void>
  read: Mock<(sid: string) => string | null>
} {
  const read = vi.fn((sid: string) => files[sid] ?? null)
  return {
    read,
    source: () => ({
      typing: new Map(Object.entries(typing)),
      read
    }),
    write: vi.fn((writes: ChatSessionWrite[]) => {
      for (const w of writes) {
        if (w.json === null) delete files[w.sid]
        else files[w.sid] = w.json
      }
    }),
    readOnly: () => readOnly
  }
}

function session(sid: string, messages: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ sid, messages, ...extra })
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

  function setup(backend: ChatSessionsBackend): ReturnType<typeof useChatMessagesStore> {
    const pinia = createPinia()
    pinia.use(createChatMessagesPersistencePlugin({ backend, checkpointMs: 2000 }))
    createApp({}).use(pinia)
    setActivePinia(pinia)
    const store = useChatMessagesStore()
    disposeStore = () => store.$dispose()
    return store
  }

  it('把连续流式更新合并成一次写盘，只写改过的那个对话', () => {
    const backend = memoryBackend({ 'chat-b': session('chat-b', []) })
    const store = setup(backend)
    const typingId = store.pushAssistantTyping('chat-a')

    for (let index = 0; index < 100; index++) {
      store.replaceTyping('chat-a', typingId, `正文-${index}`, false)
      vi.advanceTimersByTime(10)
    }

    expect(backend.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)

    expect(backend.write).toHaveBeenCalledTimes(1)
    const writes = backend.write.mock.calls[0][0]
    expect(writes.map((w) => w.sid)).toEqual(['chat-a'])
    expect(JSON.parse(writes[0].json!).messages[0].content).toBe('正文-99')
    expect(writes[0].typing).toEqual([typingId])
  })

  it('完成态立即保存终稿，并取消尚未触发的检查点', () => {
    const backend = memoryBackend()
    const store = setup(backend)
    const typingId = store.pushAssistantTyping('chat-a')
    store.replaceTyping('chat-a', typingId, '半截', false)

    store.replaceTyping('chat-a', typingId, '终稿', true)

    expect(backend.write).toHaveBeenCalledTimes(1)
    expect(backend.write.mock.calls[0][0][0].typing).toEqual([])
    vi.advanceTimersByTime(2000)
    expect(backend.write).toHaveBeenCalledTimes(1)
  })

  it('对话用到才读，并清掉无法恢复的建议请求', () => {
    const backend = memoryBackend(
      {
        'chat-a': session(
          'chat-a',
          [
            {
              id: 'typing-1',
              role: 'assistant',
              content: '已经写了一半',
              status: 'typing',
              suggestionsLoading: true
            }
          ],
          { historySummary: '摘要', compressedUserCount: 4 }
        )
      },
      { 'chat-a': ['typing-1'] }
    )
    const store = setup(backend)

    // 还没碰过：不读盘，但 typing 清单已经从索引交给重连流程
    expect(backend.read).not.toHaveBeenCalled()
    expect(takeHydratedTypingMessages()).toEqual([{ sid: 'chat-a', messageId: 'typing-1' }])

    expect(store.getMessages('chat-a')[0]).toMatchObject({
      status: 'typing',
      suggestionsLoading: false
    })
    expect(store.getHistorySummary('chat-a')).toBe('摘要')
    expect(store.getCompressedUserCount('chat-a')).toBe(4)
    store.getMessages('chat-a')
    expect(backend.read).toHaveBeenCalledTimes(1)
    expect(backend.write).not.toHaveBeenCalled()
  })

  it('往没读过的对话里追加，先读盘再追加，不会把旧消息盖掉', () => {
    const backend = memoryBackend({
      'chat-a': session('chat-a', [{ id: 'old', role: 'user', content: '旧的', status: 'done' }])
    })
    const store = setup(backend)

    store.pushUser('chat-a', '新的')
    vi.advanceTimersByTime(2000)

    const written = JSON.parse(backend.write.mock.calls[0][0][0].json!)
    expect(written.messages.map((m: { content: string }) => m.content)).toEqual(['旧的', '新的'])
  })

  it('删掉的对话写一个 null，盘上那份跟着删', () => {
    const backend = memoryBackend({
      'chat-a': session('chat-a', []),
      'chat-b': session('chat-b', [])
    })
    const store = setup(backend)

    store.dropSessions(['chat-a', 'chat-b'])
    vi.advanceTimersByTime(2000)

    expect(backend.write.mock.calls[0][0]).toEqual([
      { sid: 'chat-a', json: null },
      { sid: 'chat-b', json: null }
    ])
  })

  it('删掉的对话在落盘前被碰到，也不会从盘上读回来', () => {
    const backend = memoryBackend({
      'chat-a': session('chat-a', [{ id: 'm', role: 'user', content: '旧', status: 'done' }])
    })
    const store = setup(backend)

    store.dropSession('chat-a')
    expect(store.getMessages('chat-a')).toEqual([])
    vi.advanceTimersByTime(2000)

    expect(backend.read).not.toHaveBeenCalled()
    expect(backend.write.mock.calls[0][0]).toEqual([{ sid: 'chat-a', json: null }])
  })

  it('读不出来的对话按空显示，但不写回、不删除', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const backend = memoryBackend({ 'chat-a': '{坏的' })
    const store = setup(backend)

    expect(store.getMessages('chat-a')).toEqual([])
    store.pushUser('chat-a', '新的')
    vi.advanceTimersByTime(2000)
    ;(store as unknown as { $persist: () => void }).$persist()

    expect(backend.write).not.toHaveBeenCalled()
  })

  it('分支只写新对话，源对话不动', () => {
    const backend = memoryBackend({
      'chat-a': session('chat-a', [{ id: 'm', role: 'user', content: '源', status: 'done' }])
    })
    const store = setup(backend)

    store.copySessionMessages('chat-a', 'chat-b')
    vi.advanceTimersByTime(2000)

    expect(backend.write.mock.calls[0][0].map((w) => w.sid)).toEqual(['chat-b'])
  })

  it('只读窗口不写盘', () => {
    const backend = memoryBackend({}, {}, true)
    const store = setup(backend)

    store.pushUser('chat-a', '一条')
    vi.advanceTimersByTime(2000)

    expect(backend.write).not.toHaveBeenCalled()
  })

  it('$persist 把读进来的对话都写一遍', () => {
    const backend = memoryBackend({
      'chat-a': session('chat-a', []),
      'chat-b': session('chat-b', [])
    })
    const store = setup(backend)
    store.getMessages('chat-a')
    ;(store as unknown as { $persist: () => void }).$persist()

    expect(backend.write.mock.calls[0][0].map((w) => w.sid)).toEqual(['chat-a'])
  })
})
