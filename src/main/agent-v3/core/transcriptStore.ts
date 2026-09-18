/**
 * 对话 transcript 的 JSONL 落盘。
 *
 * 目的只有两个：应用重启后对话能接着跑；工具执行到一半崩溃不丢上下文。
 *
 * ## 为什么不用 pi 的 `JsonlSessionRepo`
 *
 * pi 那套是围绕 CLI 编码 agent 设计的：会话按 **cwd 编码的目录**组织
 * （`JsonlSessionMetadata.cwd` 是必填），还带 lane / branch / fork 的树形抽象。
 * 我们按 chatSid 组织，接它要先实现一个 12 方法的
 * `JsonlSessionRepoFileSystem` 适配 + Entry↔AgentMessage 转换 ——
 * 成本高于这个文件本身。
 *
 * 分支（`forkTranscript`）复制一份消息就够了，用不上树形抽象 ——
 * 「从某一轮分叉」也不过是复制前把尾巴截掉，见 `sliceToUserTurns`。
 *
 * ## 格式
 *
 * 每个会话一个 `.jsonl`：第一行是 header，之后每行一条消息。
 * 追加写而不是整文件重写 —— 长对话每轮重写几 MB 会拖慢主进程。
 */

import { createReadStream, promises as fs } from 'fs'
import { createInterface } from 'readline'
import { finished } from 'node:stream/promises'
import { join } from 'path'
import { app } from 'electron'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { trimDanglingToolCalls } from './resume'
import { writeSessionFile } from './atomicSessionFile'

const DIR = 'agent-v3-sessions'
const VERSION = 1

interface Header {
  kind: 'header'
  version: number
  sessionId: string
  createdAt: number
}

interface MessageLine {
  kind: 'message'
  message: AgentMessage
}

export interface TranscriptMeta {
  sessionId: string
  createdAt: number
  modifiedAt: number
  messageCount: number
}

/**
 * 助手消息缺用量时补上的那一份全零。
 *
 * **只用在读取侧的修复上了。** 写入侧那条路（语音直答并进 Agent transcript）
 * 已经随语音会话独立而删掉 —— 现在没有任何地方往 transcript 里塞外部消息。
 * 但**盘上还留着旧版本写坏的会话**，所以这段知识和 `backfillAssistantUsage`
 * 都得留着。
 *
 * 缺了它下一轮**直接崩掉**，报 `Cannot read properties of undefined
 * (reading 'totalTokens')`。原因藏在 pi 的两份同名实现里：
 *
 *   - `pi-agent-core` 的 `getAssistantUsage` 判了 `assistantMsg.usage &&`；
 *   - `pi-ai` 的 `getLastAssistantUsageInfo`（`utils/estimate.js`）**没判**，
 *     只看 stopReason 不是 aborted/error 就直接 `usage.totalTokens`。
 *
 * 而后者在每次请求的 `clampMaxTokensToContext` 里都要跑一遍。语音直答那几句
 * 是我们自己塞进 transcript 的，没有 stopReason 也没有 usage，于是两个
 * `!==` 都成立，第三个条件当场抛异常 —— 表现是「语音说完一句话，下一轮 Agent
 * 就再也起不来了」。
 *
 * 全零而不是省略，语义上也对：这几条不是厂商生成的，本来就没有用量可报。
 * `calculateContextTokens` 算出 0，pi 就会跳过它们去找真正带用量的那条。
 */
const NO_PROVIDER_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
} as const

/** 会话文件目录。压缩检查点也写在这里，所以导出给 `compactionCheckpoint.ts` 用 */
export function sessionsDir(): string {
  return join(app.getPath('userData'), DIR)
}

/**
 * sessionId → 安全的文件名主干（不含扩展名）。
 *
 * sessionId 可能来自渲染层，直接当文件名会有路径穿越风险
 * （`../../` 能写到 userData 之外）。这里只保留安全字符。
 *
 * 导出是因为压缩检查点要按同一个 sessionId 落一个同名 `.compaction.json`：
 * 两边各写一份清洗规则的话，一个带特殊字符的 sessionId 就会让检查点和
 * transcript 落到两个不同的名字下，然后谁也找不到谁。
 */
export function safeSessionFileBase(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
  return safe || 'unnamed'
}

function fileNameFor(sessionId: string): string {
  return `${safeSessionFileBase(sessionId)}.jsonl`
}

function filePathFor(sessionId: string): string {
  return join(sessionsDir(), fileNameFor(sessionId))
}

/**
 * 一个会话的追加写句柄。
 *
 * 落盘失败一律吞掉并记日志 —— 持久化是增强功能，磁盘满了、文件被占用
 * 不该让正在进行的对话崩掉。
 */
export class TranscriptStore {
  private initialized = false
  /** 已落盘的消息条数，用于增量追加 */
  private persistedCount = 0
  /** 串行化写入，避免并发 append 交错出半行 JSON */
  private queue: Promise<void> = Promise.resolve()
  /** 会话已被删除，之后的 append 一律丢弃 */
  private discarded = false

  constructor(private readonly sessionId: string) {}

  private async ensureFile(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    await fs.mkdir(sessionsDir(), { recursive: true })

    const path = filePathFor(this.sessionId)
    try {
      await fs.access(path)
    } catch {
      const header: Header = {
        kind: 'header',
        version: VERSION,
        sessionId: this.sessionId,
        createdAt: Date.now()
      }
      await fs.writeFile(path, `${JSON.stringify(header)}\n`, 'utf8')
    }
  }

  /**
   * 把 transcript 里尚未落盘的部分追加进去。
   *
   * 传整个数组而不是单条：pi 的 `Agent` 不保证每条消息都有对应事件
   * （压缩会整体替换 messages），按「差量」处理才不会漏。
   */
  append(messages: AgentMessage[], options: { strict?: boolean } = {}): Promise<void> {
    const write = this.queue.then(async () => {
      if (this.discarded) return
      try {
        // 压缩会把 messages 整体换掉，长度可能变短 —— 那时重写整个文件，
        // 否则后续追加会接在已经不存在的历史后面。
        if (messages.length < this.persistedCount) {
          await this.rewrite(messages)
          return
        }
        if (messages.length === this.persistedCount) return

        await this.ensureFile()
        const lines = messages
          .slice(this.persistedCount)
          .map((message) => JSON.stringify({ kind: 'message', message } satisfies MessageLine))
          .join('\n')

        await fs.appendFile(filePathFor(this.sessionId), `${lines}\n`, 'utf8')
        this.persistedCount = messages.length
      } catch (error) {
        console.warn(`[AgentV3] transcript 落盘失败 (${this.sessionId}):`, error)
        if (options.strict) throw error
      }
    })
    // 单次严格写入失败不能毒化后续队列；调用方仍会收到本次失败。
    this.queue = write.catch(() => undefined)
    return write
  }

  private async rewrite(messages: AgentMessage[]): Promise<void> {
    const path = filePathFor(this.sessionId)
    const header: Header = (await readHeader(path)) ?? {
      kind: 'header',
      version: VERSION,
      sessionId: this.sessionId,
      createdAt: Date.now()
    }
    const lines = [
      JSON.stringify(header),
      ...messages.map((message) =>
        JSON.stringify({ kind: 'message', message } satisfies MessageLine)
      )
    ]
    await writeSessionFile(path, `${lines.join('\n')}\n`)
    this.initialized = true
    this.persistedCount = messages.length
  }

  /** 标记「这些消息已经在文件里了」。恢复会话后调用，避免把读出来的内容再写一遍。 */
  markPersisted(count: number): void {
    this.persistedCount = count
    this.initialized = true
  }

  /**
   * 作废这个句柄：之后的 append 一律丢弃，并等在途的写入落完。
   *
   * 用户删除一个**正在跑**的会话时必须先调它。否则 abort 之后 agent 还会发
   * 一次 `agent_end`，那条 append 会用 `fs.appendFile` 把刚删掉的文件**重新
   * 建出来** —— 而且没有 header，`listTranscripts` 看不见它，
   * `loadTranscript` 却读得回来：一个删不掉也列不出来的幽灵会话。
   *
   * 还排在队列里没执行的 append 会被标志直接挡掉；已经进了 `fs.appendFile`
   * 的那一次挡不住，所以要等 queue 排空再返回 —— 调用方紧接着就删文件，
   * 不等的话会删完又被它写回来。
   */
  async discard(): Promise<void> {
    this.discarded = true
    await this.queue.catch(() => undefined)
  }
}

/**
 * 读回一个会话的 transcript。
 *
 * 逐行流式读取而不是整文件 JSON.parse —— 长对话文件可能几十 MB。
 * 单行损坏（上次写到一半断电）只跳过那一行，不让整个会话读不出来。
 */
export async function loadTranscript(sessionId: string): Promise<AgentMessage[]> {
  const path = filePathFor(sessionId)
  try {
    await fs.access(path)
  } catch {
    return []
  }

  const messages: AgentMessage[] = []
  let badLines = 0

  const reader = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity
  })

  for await (const line of reader) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Header | MessageLine
      if (parsed.kind === 'message') messages.push(parsed.message)
    } catch {
      badLines++
    }
  }

  if (badLines > 0) {
    console.warn(`[AgentV3] transcript ${sessionId} 有 ${badLines} 行损坏，已跳过`)
  }
  return messages.map(backfillAssistantUsage)
}

/**
 * 补上助手消息缺失的用量。
 *
 * 写入侧已经修好了（见 `NO_PROVIDER_USAGE`），但**盘上那些已经写坏的还在**。
 * 不在读的时候补一次，用过语音的会话会一直起不来，用户只能删掉对话重开 ——
 * 而他并不知道该删哪一条。
 *
 * 只碰缺 `usage` 的助手消息，其余原样返回。
 */
function backfillAssistantUsage(message: AgentMessage): AgentMessage {
  const candidate = message as { role?: string; usage?: unknown; stopReason?: string }
  if (candidate.role !== 'assistant' || candidate.usage) return message
  return {
    ...message,
    stopReason: candidate.stopReason ?? 'endTurn',
    usage: { ...NO_PROVIDER_USAGE }
  } as AgentMessage
}

/** 列出所有已保存的会话，最近修改的排前面 */
export async function listTranscripts(): Promise<TranscriptMeta[]> {
  let files: string[]
  try {
    files = await fs.readdir(sessionsDir())
  } catch {
    return []
  }

  const metas: TranscriptMeta[] = []
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const path = join(sessionsDir(), file)
    try {
      const [stat, header] = await Promise.all([fs.stat(path), readHeader(path)])
      if (!header) continue
      metas.push({
        sessionId: header.sessionId,
        createdAt: header.createdAt,
        modifiedAt: stat.mtimeMs,
        messageCount: await countMessages(path)
      })
    } catch {
      // 单个会话读不出来不该让整个列表失败
    }
  }

  return metas.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

async function readHeader(path: string): Promise<Header | undefined> {
  const input = createReadStream(path, 'utf8')
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as Header
      return parsed.kind === 'header' ? parsed : undefined
    }
  } catch {
    return undefined
  } finally {
    reader.close()
    // 只读首行时 readline.close 不会关闭文件句柄；Windows 下会挡住原子替换。
    input.destroy()
    await finished(input).catch(() => undefined)
  }
  return undefined
}

async function countMessages(path: string): Promise<number> {
  let count = 0
  const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of reader) {
    if (line.trim()) count++
  }
  // 减掉 header 那一行
  return Math.max(0, count - 1)
}

export async function deleteTranscript(sessionId: string): Promise<void> {
  await fs.rm(filePathFor(sessionId), { force: true })
}

export type ForkTranscriptResult =
  | { ok: true; sessionId: string; messageCount: number }
  | { ok: false; reason: 'missing' }

export interface ForkTranscriptOptions {
  /** 只复制前这么多个用户回合（「从这条往后砍掉」）。不给就整份复制 */
  keepUserTurns?: number
  /**
   * 拿这份消息当源，而不是去读盘。
   *
   * 会话正在跑的时候 IPC 层把内存里那份传进来：盘上落后于内存（turn_end 才
   * 落盘），照盘上切会切出一份和用户看到的对不上的历史。
   */
  sourceMessages?: AgentMessage[]
}

/**
 * 截到第 `keepUserTurns` 个用户回合结束的位置。
 *
 * 「从这条回复分叉」在内核侧就是这一刀。为什么按**用户消息的条数**切而不是按
 * 下标：界面上一轮只有一条用户气泡加一条回复气泡，内核里却是 1 条 user 加 n 条
 * assistant/toolResult（n 随这一轮调了几次工具变），两边的下标根本对不上，
 * 能对上的只有「这是第几个用户回合」。
 *
 * 切完还要 `trimDanglingToolCalls`：万一刀正好落在半截工具调用上
 * （toolCall 没有配对的 toolResult），分支里的第一次请求会被厂商直接拒。
 */
export function sliceToUserTurns(messages: AgentMessage[], keepUserTurns: number): AgentMessage[] {
  if (keepUserTurns <= 0) return []

  let seen = 0
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as { role?: string }).role !== 'user') continue
    seen++
    // 第 keepUserTurns + 1 条用户消息是下一轮的开头，从它这里断开
    if (seen > keepUserTurns) return trimDanglingToolCalls(messages.slice(0, i))
  }

  return messages
}

/**
 * 从一个已有会话分叉出新会话：复制消息到新 sessionId 名下。
 *
 * 这就是「会话分支」在内核侧的全部 —— transcript 按 sessionId 恢复
 * （execute 里 `agent.state.messages = loadTranscript(...)`），新文件里有什么，
 * 分支的下一轮对话就带着什么。
 *
 * 给了 `keepUserTurns` 就只复制前这么多个用户回合（「从这条往后砍掉」），
 * 不给就整份复制。是否允许分叉（会话正在跑？）由 IPC 层裁决，这里只管复制 ——
 * 跑着的时候它会连内存里那份消息一起传进来（`sourceMessages`）。
 * `loadTranscript` + 重写（而不是直接拷文件）是为了 header 里的 sessionId
 * 和 createdAt 得换成新的 —— `listTranscripts` 靠 header 认会话。
 */
export async function forkTranscript(
  sourceSessionId: string,
  newSessionId: string,
  { keepUserTurns, sourceMessages }: ForkTranscriptOptions = {}
): Promise<ForkTranscriptResult> {
  const loaded = sourceMessages ?? (await loadTranscript(sourceSessionId))
  const messages =
    typeof keepUserTurns === 'number' ? sliceToUserTurns(loaded, keepUserTurns) : loaded
  // 空的分支等于一条没有上下文的新会话，不如不建 —— 让界面报「没有可复制的历史」，
  // 而不是把用户送进一个看起来像分支、实际什么都不记得的会话
  if (messages.length === 0) {
    return { ok: false, reason: 'missing' }
  }

  // 不走 TranscriptStore：它把落盘失败吞成一条日志，分支失败会被当成成功，
  // 界面那头就得到一个指向空 transcript 的新会话。这里失败要抛出去。
  await fs.mkdir(sessionsDir(), { recursive: true })
  const header: Header = {
    kind: 'header',
    version: VERSION,
    sessionId: newSessionId,
    createdAt: Date.now()
  }
  const lines = [
    JSON.stringify(header),
    ...messages.map((message) => JSON.stringify({ kind: 'message', message } satisfies MessageLine))
  ]
  await fs.writeFile(filePathFor(newSessionId), `${lines.join('\n')}\n`, 'utf8')

  return { ok: true, sessionId: newSessionId, messageCount: messages.length }
}

export type TruncateTranscriptResult =
  | { ok: true; messageCount: number; dropped: number }
  | { ok: false; reason: 'missing' }

/**
 * 把一条会话自己的 transcript 截到第 `keepUserTurns` 个用户回合结束。
 *
 * ## 为什么「重新生成」需要它
 *
 * 界面上点「重新生成」，被丢掉的是那条回复的**气泡**；内核的 transcript 是
 * 另一份账本，execute 每一轮都从盘上重新 `loadTranscript` 恢复。不截这一刀的话，
 * 模型看着自己刚被用户丢掉的那个答案，被要求再答一遍同一个问题 —— 用户以为
 * 是重来，对模型而言是追问，回出来的经常是「如前所述……」。
 *
 * 顺带也是会话分支正确的前提：两份历史的对齐靠「第几个用户回合」数出来
 * （见 `sliceToUserTurns`），retry 每污染一次，这个数就错一位。
 *
 * ## 和 forkTranscript 的区别
 *
 * 那个写的是**新文件**（新 sessionId、新 createdAt）；这个原地改写，所以
 * header 必须留着原来的 —— `listTranscripts` 靠 header 认会话和创建时间，
 * 换掉的话这条会话在列表里会变成「刚刚创建」。
 *
 * 什么都不用截时不碰文件：写一遍等于把整个 JSONL 重写一次，长对话是几十 MB。
 */
export async function truncateTranscript(
  sessionId: string,
  keepUserTurns: number
): Promise<TruncateTranscriptResult> {
  const path = filePathFor(sessionId)
  const header = await readHeader(path)
  // 没有 transcript（第一轮还没落盘、或者这条根本不是 Agent 会话）不是错 ——
  // 本来就没有多余的历史要截，调用方直接接着跑就行
  if (!header) {
    return { ok: false, reason: 'missing' }
  }

  const loaded = await loadTranscript(sessionId)
  const kept = sliceToUserTurns(loaded, keepUserTurns)
  // sliceToUserTurns 没切时返回的是同一个数组引用
  if (kept === loaded) {
    return { ok: true, messageCount: loaded.length, dropped: 0 }
  }

  const lines = [
    JSON.stringify(header),
    ...kept.map((message) => JSON.stringify({ kind: 'message', message } satisfies MessageLine))
  ]
  await fs.writeFile(path, `${lines.join('\n')}\n`, 'utf8')

  return { ok: true, messageCount: kept.length, dropped: loaded.length - kept.length }
}
