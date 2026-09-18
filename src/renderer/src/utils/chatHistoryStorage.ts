/**
 * AI 对话历史的存储适配器（pinia-plugin-persistedstate 的 `storage` 插座）。
 *
 * 后端是磁盘文件，不是 localStorage —— 后者配额只有几 MB，聊天记录写满之后
 * 会静默地再也存不上，用户下次开应用才发现历史没了。落盘在主进程
 * （`main/ipc/chatHistory.ts`），这边只负责搬字符串。
 *
 * pinia 的 storage 接口是**同步**的，磁盘读是异步的，所以分两步：
 * 启动时 `preload()` 把两份 JSON 一次性读进内存，之后 `getItem` 走内存，
 * `setItem` 改内存 + 节流往磁盘刷。
 *
 * 注意：Storage 接到的已经是序列化后的字符串，这一层只能合并磁盘 IPC，不能
 * 节流 JSON.stringify。高频的 chat-messages 由 `chatMessagesPersistence.ts`
 * 在序列化之前做检查点合并；chat-sessions 等低频数据继续走这里的写盘节流。
 */

/** 走这套存储的 key。跟主进程的白名单一一对应。 */
const CHAT_KEYS = ['chat-messages', 'chat-sessions', 'follow-up-queue'] as const

export class ChatHistoryStorage implements Storage {
  /** 磁盘内容的内存镜像；getItem 只读它 */
  private cache = new Map<string, string>()
  /** 改过但还没刷盘的 key */
  private dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  /**
   * 只读模式：改内存但不写盘。
   *
   * MiniChat 是独立窗口，跟主窗口写的是同一份文件；两边都写就是后写覆盖先写。
   * 它本来就靠 IPC 把整段消息交给主窗口（见 `layout/components/SideMenu.vue`
   * 里的 `chat-sessions:refresh`），不需要自己存盘。
   */
  private readOnly = false

  constructor(private readonly throttleMs = 2000) {}

  get length(): number {
    return this.cache.size
  }

  key(index: number): string | null {
    return [...this.cache.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.cache.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.cache.set(key, value)
    this.dirty.add(key)
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.throttleMs)
    }
  }

  removeItem(key: string): void {
    this.cache.delete(key)
    // flush 会写一个空串；`preload()` 把空串当成「没有」，不必再加一个删除接口
    this.dirty.add(key)
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.throttleMs)
    }
  }

  clear(): void {
    for (const key of [...this.cache.keys()]) this.removeItem(key)
  }

  /**
   * 把磁盘上的历史读进内存，必须在任何 store 被访问之前 await 完。
   *
   * 磁盘上没有 = 还没迁移过，这时把 localStorage 里的旧历史当种子写下去 ——
   * 迁移逻辑就这么多，不需要状态机也不需要标记文件：磁盘上有没有文件
   * 本身就是「迁没迁过」的答案，中断了下次启动自然接着做。
   */
  async preload(): Promise<void> {
    this.readOnly = window.location.hash.startsWith('#/mini-chat')

    let onDisk: Record<string, string | undefined> = {}
    try {
      onDisk = (await window.api?.chatHistory?.read()) ?? {}
    } catch (error) {
      console.error('[ChatHistory] 读取磁盘历史失败，本次只在内存里跑:', error)
      return
    }

    const toMigrate: string[] = []
    for (const key of CHAT_KEYS) {
      const fromDisk = onDisk[key]
      if (typeof fromDisk === 'string' && fromDisk !== '') {
        this.cache.set(key, fromDisk)
        continue
      }
      const legacy = localStorage.getItem(key)
      if (legacy !== null) {
        this.cache.set(key, legacy)
        toMigrate.push(key)
      }
    }

    if (toMigrate.length === 0 || this.readOnly) return

    // 先确认落盘，再删旧 key。顺序反过来就是一次性丢光全部历史。
    try {
      for (const key of toMigrate) {
        await window.api.chatHistory.write(key, this.cache.get(key) as string)
      }
      toMigrate.forEach((key) => localStorage.removeItem(key))
      console.log(`[ChatHistory] 已把 ${toMigrate.join('、')} 从 localStorage 迁到磁盘`)
    } catch (error) {
      console.error('[ChatHistory] 迁移写盘失败，旧数据留在 localStorage，下次启动再试:', error)
    }
  }

  /**
   * 立即把待写入的内容送去落盘。流式结束、组件卸载时调用。
   *
   * 写盘是异步的，这里不等它 —— 失败只影响这一次，下一次 `setItem` 会带着
   * 最新的整份内容重试，不需要退避队列。真丢了这 2 秒，Agent 内核的
   * transcript（`agent-v3-sessions/*.jsonl`）还在，对话本身接得回来。
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.dirty.size === 0) return

    const keys = [...this.dirty]
    this.dirty.clear()
    if (this.readOnly) return

    for (const key of keys) {
      const value = this.cache.get(key) ?? ''
      // ponytail: 每次都写整份 JSON。一万条消息约 20MB，stringify 会有 ~150ms 卡顿
      // （这也是换盘之前的行为）。真有人到这个量级，再按会话拆成一个会话一个文件。
      void window.api?.chatHistory?.write(key, value)?.catch((error: unknown) => {
        console.error(`[ChatHistory] 写入 ${key} 失败（${value.length} 字符）:`, error)
      })
    }
  }
}

/** 全局单例：chat-messages 和 chat-sessions 共用一份 */
export const chatHistoryStorage = new ChatHistoryStorage(2000)
