/**
 * AI 对话历史的落盘。
 *
 * 界面历史（会话列表 + 消息正文）原本存在 localStorage 里，配额只有几 MB，
 * 写满之后 `setItem` 抛 QuotaExceededError —— 表现是聊天记录从某一刻起
 * 静默地再也存不上。这里把它挪到 `<userData>/chat-history/` 下的两个文件。
 *
 * 只是换了个后端：渲染层仍然把整份 JSON 当字符串递过来（见
 * `renderer/utils/chatHistoryStorage.ts`），这里不解析、不理解内容。
 *
 * Agent 内核自己的 transcript 是另一套（`agent-v3/core/transcriptStore.ts`），
 * 跟这里没有关系。
 */

import { ipcMain, app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

/** key 是白名单，不是渲染层随便传的 —— 路径穿越的问题从源头就不存在 */
const KEYS = ['chat-messages', 'chat-sessions', 'follow-up-queue'] as const
type ChatHistoryKey = (typeof KEYS)[number]

const DIR = 'chat-history'

function historyDir(): string {
  return join(app.getPath('userData'), DIR)
}

function filePathFor(key: ChatHistoryKey): string {
  return join(historyDir(), `${key}.json`)
}

/**
 * 每个 key 一条写入链。
 *
 * MiniChat 是独立窗口，跟主窗口写的是同一个文件；不串行的话两次
 * `writeFile` 会交错出半份 JSON。临时文件 + rename 保证读到的永远是完整的一份。
 */
const queues = new Map<ChatHistoryKey, Promise<unknown>>()

export function registerChatHistoryIPC(): void {
  ipcMain.handle('chat-history:read', async () => {
    const result: Partial<Record<ChatHistoryKey, string>> = {}
    for (const key of KEYS) {
      try {
        result[key] = await fs.readFile(filePathFor(key), 'utf8')
      } catch {
        // 文件不存在就是「还没存过」，交给渲染层去 localStorage 里找旧数据
      }
    }
    return result
  })

  ipcMain.handle('chat-history:write', async (_event, key: string, value: string) => {
    if (!KEYS.includes(key as ChatHistoryKey)) {
      throw new Error(`未知的对话历史 key: ${key}`)
    }
    const safeKey = key as ChatHistoryKey

    const next = (queues.get(safeKey) ?? Promise.resolve()).then(async () => {
      await fs.mkdir(historyDir(), { recursive: true })
      const target = filePathFor(safeKey)
      const tmp = `${target}.tmp`
      await fs.writeFile(tmp, value, 'utf8')
      await fs.rename(tmp, target)
    })

    // 队列本身不能带着 rejected 状态传下去，否则一次写失败会把后续每一次都拖挂
    queues.set(
      safeKey,
      next.catch(() => undefined)
    )
    await next
  })
}
