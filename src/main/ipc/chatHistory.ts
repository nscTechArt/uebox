/**
 * AI 对话历史的落盘。
 *
 * 界面历史原本存在 localStorage 里，配额只有几 MB，写满之后 `setItem` 抛
 * QuotaExceededError —— 表现是聊天记录从某一刻起静默地再也存不上。现在放在
 * `<userData>/chat-history/` 下：
 *
 * - `chat-sessions.json` / `follow-up-queue.json`：对话列表和排队消息，整份读写，
 *   渲染层把 JSON 当字符串递过来（见 `renderer/utils/chatHistoryStorage.ts`）。
 * - `sessions/`：对话正文，一个对话一个文件（见 `chatSessionFiles.ts`）。
 *
 * Agent 内核自己的 transcript 是另一套（`agent-v3/core/transcriptStore.ts`），
 * 跟这里没有关系。
 */

import { ipcMain, app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { ChatSessionFiles, serialQueue, type SessionWrite } from './chatSessionFiles'

/** key 是白名单，不是渲染层随便传的 —— 路径穿越的问题从源头就不存在 */
const KEYS = ['chat-sessions', 'follow-up-queue'] as const
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
const queues = new Map<ChatHistoryKey, ReturnType<typeof serialQueue>>()

function enqueueWrite(key: ChatHistoryKey, value: string): Promise<void> {
  let queue = queues.get(key)
  if (!queue) queues.set(key, (queue = serialQueue()))
  return queue(async () => {
    await fs.mkdir(historyDir(), { recursive: true })
    const target = filePathFor(key)
    const tmp = `${target}.tmp`
    await fs.writeFile(tmp, value, 'utf8')
    await fs.rename(tmp, target)
  })
}

export function registerChatHistoryIPC(): void {
  const sessions = new ChatSessionFiles(
    join(historyDir(), 'sessions'),
    join(historyDir(), 'chat-messages.json')
  )

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
    await enqueueWrite(key as ChatHistoryKey, value)
  })

  // ── 对话正文 ─────────────────────────────────────────────────────────
  ipcMain.handle('chat-history:sessions-index', () => sessions.open())
  ipcMain.handle('chat-history:sessions-import-legacy', (_event, json: string) =>
    sessions.importLegacy(String(json))
  )
  ipcMain.on('chat-history:session-read-sync', (event, sid: string) => {
    event.returnValue = sessions.readSync(String(sid))
  })
  ipcMain.handle('chat-history:sessions-read', (_event, sids: string[]) =>
    sessions.readMany(Array.isArray(sids) ? sids.map(String) : [])
  )
  ipcMain.handle('chat-history:sessions-write', (_event, writes: SessionWrite[]) =>
    sessions.write(
      (Array.isArray(writes) ? writes : []).map((w) => ({
        sid: String(w.sid),
        json: typeof w.json === 'string' ? w.json : null,
        typing: Array.isArray(w.typing) ? w.typing.map(String) : undefined
      }))
    )
  )
}
