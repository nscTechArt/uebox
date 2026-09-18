import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { ChatHistoryStorage } from './chatHistoryStorage'

/** 装一个假的 window.api.chatHistory，返回它的调用记录 */
function stubDisk(initial: Record<string, string> = {}): {
  disk: Record<string, string>
  write: ReturnType<typeof vi.fn>
} {
  const disk = { ...initial }
  const write = vi.fn(async (key: string, value: string) => {
    disk[key] = value
  })
  ;(window as unknown as { api: unknown }).api = {
    chatHistory: {
      read: vi.fn(async () => ({ ...disk })),
      write
    }
  }
  return { disk, write }
}

function setHash(hash: string): void {
  window.location.hash = hash
}

describe('ChatHistoryStorage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    setHash('#/')
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  it('磁盘上有数据时直接用，不碰 localStorage', async () => {
    stubDisk({ 'chat-messages': '{"disk":1}' })
    localStorage.setItem('chat-messages', '{"legacy":1}')

    const storage = new ChatHistoryStorage(2000)
    await storage.preload()

    expect(storage.getItem('chat-messages')).toBe('{"disk":1}')
    // 磁盘是权威，旧 key 不该被当种子，也不该被顺手删掉
    expect(localStorage.getItem('chat-messages')).toBe('{"legacy":1}')
  })

  it('磁盘为空时把 localStorage 的旧历史迁过去，落盘成功后才删旧 key', async () => {
    const { disk } = stubDisk()
    localStorage.setItem('chat-messages', '{"legacy":1}')
    localStorage.setItem('chat-sessions', '[]')

    const storage = new ChatHistoryStorage(2000)
    await storage.preload()

    expect(disk['chat-messages']).toBe('{"legacy":1}')
    expect(disk['chat-sessions']).toBe('[]')
    expect(localStorage.getItem('chat-messages')).toBeNull()
    expect(localStorage.getItem('chat-sessions')).toBeNull()
    expect(storage.getItem('chat-messages')).toBe('{"legacy":1}')
  })

  it('迁移写盘失败时旧数据必须留在 localStorage', async () => {
    stubDisk()
    ;(window as unknown as { api: { chatHistory: { write: unknown } } }).api.chatHistory.write =
      vi.fn(async () => {
        throw new Error('磁盘满了')
      })
    localStorage.setItem('chat-messages', '{"legacy":1}')

    const storage = new ChatHistoryStorage(2000)
    await storage.preload()

    expect(localStorage.getItem('chat-messages')).toBe('{"legacy":1}')
  })

  it('setItem 节流合并，2 秒内只写一次盘', async () => {
    const { write } = stubDisk()
    const storage = new ChatHistoryStorage(2000)
    await storage.preload()

    storage.setItem('chat-messages', 'a')
    storage.setItem('chat-messages', 'b')
    storage.setItem('chat-messages', 'c')
    expect(write).not.toHaveBeenCalled()
    // 还没落盘也要读得到最新值，否则 pinia 下一次 hydrate 会读到旧内容
    expect(storage.getItem('chat-messages')).toBe('c')

    vi.advanceTimersByTime(2000)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('chat-messages', 'c')
  })

  it('写盘失败不影响后续写入', async () => {
    const { write } = stubDisk()
    write.mockRejectedValueOnce(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const storage = new ChatHistoryStorage(2000)
    await storage.preload()

    storage.setItem('chat-messages', 'a')
    storage.flush()
    storage.setItem('chat-messages', 'b')
    storage.flush()

    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith('chat-messages', 'b')
  })

  it('MiniChat 窗口只读：改内存但不写盘，免得覆盖主窗口', async () => {
    setHash('#/mini-chat')
    const { write } = stubDisk({ 'chat-messages': '{"disk":1}' })

    const storage = new ChatHistoryStorage(2000)
    await storage.preload()
    storage.setItem('chat-messages', '{"mini":1}')
    storage.flush()

    expect(write).not.toHaveBeenCalled()
    expect(storage.getItem('chat-messages')).toBe('{"mini":1}')
  })

  it('磁盘读不出来时降级成纯内存，不炸', async () => {
    ;(window as unknown as { api: unknown }).api = {
      chatHistory: {
        read: vi.fn(async () => {
          throw new Error('IPC 挂了')
        }),
        write: vi.fn()
      }
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const storage = new ChatHistoryStorage(2000)
    await expect(storage.preload()).resolves.toBeUndefined()
    expect(storage.getItem('chat-messages')).toBeNull()
  })
})
