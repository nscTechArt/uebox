/**
 * AI 对话历史的存储适配器（pinia-plugin-persistedstate 的 `storage` 插座）。
 *
 * 后端是磁盘文件，不是 localStorage —— 后者配额只有几 MB，对话记录写满之后
 * 会静默地再也存不上，用户下次开应用才发现历史没了。落盘在主进程
 * （`main/ipc/chatHistory.ts`），这边只负责搬字符串。
 *
 * pinia 的 storage 接口是**同步**的，磁盘读是异步的，所以分两步：
 * 启动时 `preload()` 把对话列表和排队消息读进内存，之后 `getItem` 走内存，
 * `setItem` 改内存 + 节流往磁盘刷。
 *
 * 对话正文不走这里：一个对话一个文件，用到才读（`chatMessagesPersistence.ts`）。
 * 这里只在启动时取回那份很小的索引，顺带把 localStorage 时代的老正文交给主进程拆分。
 */

import { isChatWindow } from '@renderer/api/chatWindow'

/** 走这套存储的 key。跟主进程的白名单一一对应。 */
const CHAT_KEYS = ['chat-sessions', 'follow-up-queue'] as const

/** localStorage 时代的对话正文 key。只为迁移读一次 */
const LEGACY_MESSAGES_KEY = 'chat-messages'

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
   *
   * 从标签栏拖出来的独立对话窗口同理：它的改动经同步补丁交给主窗口，由主窗口存
   * （见 `chatWindowSync.ts`）。
   */
  private readOnly = false

  /**
   * 独立对话窗口不接排队的跟进消息。
   *
   * 队列是按窗口投递的：两个窗口都从盘上读到同一批排队的话，同一句话会被两边
   * 各发一次。主窗口排的归主窗口发，独立窗口只管它自己这次打开之后排的。
   */
  private skipFollowUpQueue = false

  /** 盘上有哪些对话、哪些还有没收尾的回复。正文用到才读 */
  sessionIndex: Record<string, { typing?: string[] }> = {}

  get isReadOnly(): boolean {
    return this.readOnly
  }

  constructor(private readonly throttleMs = 2000) {}

  get length(): number {
    return this.cache.size
  }

  key(index: number): string | null {
    return [...this.cache.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    if (this.skipFollowUpQueue && key === 'follow-up-queue') return null
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
    const chatWindow = isChatWindow()
    this.readOnly = window.location.hash.startsWith('#/mini-chat') || chatWindow
    this.skipFollowUpQueue = chatWindow

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

    await this.loadSessionIndex()

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

  private async loadSessionIndex(): Promise<void> {
    const api = window.api?.chatHistory
    if (!api?.sessionsIndex) return
    try {
      this.sessionIndex = await api.sessionsIndex()
      const legacy = localStorage.getItem(LEGACY_MESSAGES_KEY)
      if (legacy === null || this.readOnly) return
      // 盘上已经有的对话以盘上为准，主进程只补盘上没有的
      this.sessionIndex = await api.importLegacySessions(legacy)
      localStorage.removeItem(LEGACY_MESSAGES_KEY)
      console.log('[ChatHistory] 已把 localStorage 里的对话正文迁到磁盘')
    } catch (error) {
      console.error('[ChatHistory] 读取对话索引失败，本次历史对话打不开:', error)
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
      void window.api?.chatHistory?.write(key, value)?.catch((error: unknown) => {
        console.error(`[ChatHistory] 写入 ${key} 失败（${value.length} 字符）:`, error)
      })
    }
  }
}

/** 全局单例：chat-sessions、follow-up-queue 共用一份，对话正文的索引也挂在这里 */
export const chatHistoryStorage = new ChatHistoryStorage(2000)
