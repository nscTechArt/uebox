/**
 * 对话正文的落盘：一个对话一个文件，外加一份很小的索引。
 *
 * 原来所有对话挤在一个 `chat-messages.json` 里，每 2 秒整份重写一遍，启动时整份
 * 经 IPC 递给每个窗口。历史一多就卡，涨过 Chromium 单条 IPC 上限（256 MB）时主进程
 * 当场崩掉，盒子连窗口都起不来。做法照 Claude Code / Codex：一个会话一个文件，
 * 只写改过的那几个，打开哪个读哪个。
 *
 * 索引只记「有哪些对话、哪些还有没收尾的回复」—— 后者是启动时重连流程要的，
 * 有了它就不必为了找几条 typing 消息把每个文件都打开一遍。
 *
 * 文件内容由渲染层序列化，这里只搬字符串；只有迁移旧文件和重建索引时才解析。
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { promises as fs } from 'fs'
import { join } from 'path'
import { compactProgress } from '../../shared/agentProgress'

export interface SessionIndexEntry {
  file: string
  /** 还挂在 typing 上的助手消息 id */
  typing?: string[]
  updatedAt: number
}

export interface SessionWrite {
  sid: string
  /** 整份对话的 JSON；null 表示这个对话删掉了 */
  json: string | null
  typing?: string[]
}

interface IndexFile {
  version: 1
  sessions: Record<string, SessionIndexEntry>
}

interface PersistedSession {
  sid?: unknown
  messages?: unknown
  historySummary?: unknown
  compressedUserCount?: unknown
}

const INDEX_NAME = 'index.json'

/** 串行队列：一个接一个跑，前一个失败不拖垮后面的 */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return (task) => {
    const next = tail.then(task)
    // 队列本身不能带着 rejected 状态传下去，否则一次失败会把后续每一次都拖挂
    tail = next.catch(() => undefined)
    return next
  }
}

/** sid 当文件名用。规矩的原样用，带怪字符的取哈希 —— 原 sid 记在文件内容和索引里 */
export function fileNameFor(sid: string): string {
  if (/^[A-Za-z0-9_-]{1,100}$/.test(sid)) return `${sid}.json`
  return `h_${createHash('sha1').update(sid).digest('hex')}.json`
}

function typingIdsOf(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []
  return messages
    .filter(
      (m): m is { id: string } =>
        !!m &&
        typeof m === 'object' &&
        (m as { role?: unknown }).role === 'assistant' &&
        (m as { status?: unknown }).status === 'typing' &&
        typeof (m as { id?: unknown }).id === 'string'
    )
    .map((m) => m.id)
}

export class ChatSessionFiles {
  private index: Record<string, SessionIndexEntry> | null = null
  private readonly enqueue = serialQueue()

  constructor(
    /** `<userData>/chat-history/sessions` */
    private readonly dir: string,
    /** 旧的单文件 `<userData>/chat-history/chat-messages.json` */
    private readonly legacyFile: string
  ) {}

  /**
   * 启动时调一次：把旧的单文件拆开，再交出索引。
   * 拆之前先把工具进度收拢掉（见 `shared/agentProgress.ts`），旧文件留作备份。
   */
  async open(): Promise<Record<string, SessionIndexEntry>> {
    return this.enqueue(async () => {
      this.loadIndexSync()
      if (existsSync(this.legacyFile)) await this.migrateLegacyFile()
      return { ...this.index! }
    })
  }

  /** 把一份「所有对话挤在一起」的 JSON 拆成一个对话一个文件。给 localStorage 里的老数据用 */
  async importLegacy(json: string): Promise<Record<string, SessionIndexEntry>> {
    return this.enqueue(async () => {
      this.loadIndexSync()
      await this.splitLegacy(JSON.parse(json))
      return { ...this.index! }
    })
  }

  /**
   * 同步读一个对话。渲染层的 store 接口是同步的，第一次碰到某个对话时走这里；
   * 单个对话就几百 KB 到几 MB，读一下是毫秒级。
   */
  readSync(sid: string): string | null {
    try {
      return readFileSync(this.pathOf(sid), 'utf8')
    } catch {
      return null
    }
  }

  async readMany(sids: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const sid of sids) {
      try {
        out[sid] = await fs.readFile(this.pathOf(sid), 'utf8')
      } catch {
        // 文件被手动删了：当作没有这个对话
      }
    }
    return out
  }

  async write(writes: readonly SessionWrite[]): Promise<void> {
    if (writes.length === 0) return
    await this.enqueue(async () => {
      this.loadIndexSync()
      await fs.mkdir(this.dir, { recursive: true })
      try {
        for (const w of writes) await this.writeOne(w)
      } finally {
        // 中途失败也把已经写成的登记进去
        await this.saveIndex()
      }
    })
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  /**
   * 索引里的文件名优先；索引里没有（没来得及登记、索引坏了）就按 sid 推出来的文件名找 ——
   * 盘上有的对话绝不能被当成空的，否则下一次保存就把它盖掉了。
   */
  private pathOf(sid: string): string {
    this.loadIndexSync()
    return join(this.dir, this.index![sid]?.file ?? fileNameFor(sid))
  }

  private async writeOne({ sid, json, typing }: SessionWrite): Promise<void> {
    const file = fileNameFor(sid)
    const target = join(this.dir, file)
    if (json === null) {
      await fs.rm(target, { force: true })
      delete this.index![sid]
      return
    }
    const tmp = `${target}.tmp`
    await fs.writeFile(tmp, json, 'utf8')
    await fs.rename(tmp, target)
    this.index![sid] = {
      file,
      ...(typing?.length ? { typing: [...typing] } : {}),
      updatedAt: Date.now()
    }
  }

  private loadIndexSync(): void {
    if (this.index) return
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, INDEX_NAME), 'utf8')) as IndexFile
      if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
        this.index = parsed.sessions
        return
      }
    } catch {
      // 没有索引或坏了：从文件重建
    }
    this.index = this.rebuildIndexSync()
  }

  /** 索引丢了时一个个文件打开来重建。只在异常情况下发生 */
  private rebuildIndexSync(): Record<string, SessionIndexEntry> {
    const index: Record<string, SessionIndexEntry> = {}
    if (!existsSync(this.dir)) return index
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json') || file === INDEX_NAME) continue
      try {
        const data = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as PersistedSession
        if (typeof data.sid !== 'string' || !data.sid) continue
        const typing = typingIdsOf(data.messages)
        index[data.sid] = { file, ...(typing.length ? { typing } : {}), updatedAt: Date.now() }
      } catch {
        // 半截文件不进索引，留在盘上
      }
    }
    if (Object.keys(index).length > 0) {
      console.warn(`[ChatHistory] 索引缺失，已从 ${Object.keys(index).length} 个对话文件重建`)
    }
    return index
  }

  private async saveIndex(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const target = join(this.dir, INDEX_NAME)
    const body: IndexFile = { version: 1, sessions: this.index! }
    await fs.writeFile(`${target}.tmp`, JSON.stringify(body), 'utf8')
    await fs.rename(`${target}.tmp`, target)
  }

  private async migrateLegacyFile(): Promise<void> {
    const aside = `${this.legacyFile}.migrated`
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.legacyFile, 'utf8'))
    } catch (error) {
      // 读不进来（比如大过了字符串上限）再试也没用：挪开，免得每次启动都卡一遍
      console.error('[ChatHistory] 旧的单文件历史读不进来，原文件挪到一边保留:', error)
      await fs.rename(this.legacyFile, aside)
      return
    }
    try {
      await this.splitLegacy(parsed)
    } catch (error) {
      // 拆到一半失败（磁盘满等）：原文件留在原处，下次启动接着拆，已经拆出来的会跳过
      console.error('[ChatHistory] 旧的单文件历史拆分中断，下次启动继续:', error)
      return
    }
    await fs.rename(this.legacyFile, aside)
    console.log(`[ChatHistory] 旧的单文件历史已拆成一个对话一个文件，原文件留在 ${aside}`)
  }

  private async splitLegacy(parsed: unknown): Promise<void> {
    const root = (parsed ?? {}) as {
      messagesBySid?: Record<string, unknown>
      historySummaryBySid?: Record<string, unknown>
      compressedUserCountBySid?: Record<string, unknown>
    }
    const messagesBySid = root.messagesBySid ?? {}
    const summaries = root.historySummaryBySid ?? {}
    const counts = root.compressedUserCountBySid ?? {}
    const sids = new Set([...Object.keys(messagesBySid), ...Object.keys(summaries)])

    await fs.mkdir(this.dir, { recursive: true })
    for (const sid of sids) {
      // 已经有单独文件的以单独文件为准 —— 那份更新
      if (this.index![sid]) continue
      const raw = messagesBySid[sid]
      const messages = Array.isArray(raw)
        ? raw.map((m) =>
            m &&
            typeof m === 'object' &&
            Array.isArray((m as { agentProcess?: unknown }).agentProcess)
              ? {
                  ...m,
                  agentProcess: [
                    ...compactProgress(
                      (m as { agentProcess: Array<{ type: string }> }).agentProcess
                    )
                  ]
                }
              : m
          )
        : []
      const session: PersistedSession = { sid, messages }
      if (typeof summaries[sid] === 'string') session.historySummary = summaries[sid]
      if (typeof counts[sid] === 'number') session.compressedUserCount = counts[sid]
      await this.writeOne({ sid, json: JSON.stringify(session), typing: typingIdsOf(messages) })
    }
    await this.saveIndex()
  }
}
