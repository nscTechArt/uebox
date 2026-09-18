/**
 * 压缩检查点 —— 把「这段历史的摘要」存下来，而不是每次请求现生成一份。
 *
 * ## 它修的是一个正在花钱的缺陷，不是优化
 *
 * pi 的 `transformContext` 只把结果喂给**这一次**模型请求，**不写回**
 * `agent.state.messages`（`agent-loop.js`：`messages = await
 * config.transformContext(messages, signal)`，赋的是局部变量）。
 * 而 `createAutoCompact` 里记住上次摘要的 `previousSummary` 活在闭包里，
 * agent 每条用户消息重建一次 —— 于是：
 *
 *   - 同一轮里模型每调一次工具就再请求一次，每次都重新判一遍要不要压；
 *   - 一旦越过阈值，**每一次请求都重新调一次摘要模型**；
 *   - 每次生成的摘要措辞都不一样，于是每次请求的上下文前缀也都不一样，
 *     Prompt Cache 一次都命中不了。
 *
 * 长会话里这是实打实的重复计费。检查点把它变成：摘要生成一次、存盘、
 * 之后直接复用，直到真的需要再压一次为止。
 *
 * ## 为什么不直接把压缩结果写回 transcript
 *
 * 完整聊天记录要留着 —— 用户翻得到、能分支、能截断重来。检查点是**模型视图**
 * 的一层投影：盘上仍是全量历史，喂给模型的是「固定摘要 + 摘要之后的原始消息」。
 * 两者分开，压缩就不再是一次不可逆的删除。
 *
 * ## 什么时候作废
 *
 * `sourceHash` 是被换成摘要的那段消息的指纹。用户删消息、从某轮重新生成、
 * 分支出新会话，那段历史就变了 —— 指纹对不上，检查点整个丢掉重来。
 * 宁可多压一次，也不能拿一份描述着已经不存在的对话的摘要去糊弄模型。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

import { safeSessionFileBase, sessionsDir } from './transcriptStore'

/** 盘上那份检查点 */
export interface CompactionCheckpoint {
  /**
   * 第几代上下文。每真正重压一次 +1。
   *
   * 它进供应商缓存亲和键（见 `promptCacheKey`）：摘要一换，前缀就变了，
   * 继续用同一个键等于让厂商拿一段对不上的缓存去比对。
   */
  contextEpoch: number
  /** 摘要正文 */
  summary: string
  /** 切点：`messages[0, cutIndex)` 被这段摘要取代 */
  cutIndex: number
  /** 被取代那段历史的指纹。对不上就作废 */
  sourceHash: string
  createdAt: number
}

/**
 * 提示词协议版本。
 *
 * 只在**模型看到的固定前缀**的结构发生变化时才 +1（系统提示词重排、信封格式改版）。
 * 引擎连断、换工程都不该动它 —— 那正是缓存要活下来的场景。
 */
export const PROMPT_PROTOCOL_VERSION = 'p1'

/**
 * 供应商缓存亲和键。
 *
 * **不复用业务 `sessionId`**：那个是会话身份，界面、锁、审批、transcript 都认它，
 * 不能因为压缩了一次就换。缓存键是另一件事，它该在前缀变化时换，也只在那时换。
 *
 * 传下去之后 pi 会按供应商各自的形式使用（核实过 `@earendil-works/pi-ai@0.84.3`）：
 * OpenAI 家（completions / codex-responses / azure-responses）作为
 * `prompt_cache_key` 放进请求体，Anthropic 作为缓存会话 id（`cacheRetention`
 * 为 `none` 时丢弃）。**其余供应商直接忽略** —— 这一条的收益范围就这么大，
 * 别当成全体生效。
 */
export function promptCacheKey(
  sessionId: string,
  contextEpoch: number,
  toolPrefix?: string
): string {
  return `agent-v3:${PROMPT_PROTOCOL_VERSION}:${sessionId}:e${contextEpoch}${toolPrefix ? `:t${toolPrefix}` : ''}`
}

/**
 * 一段消息的指纹。
 *
 * 逐条 `JSON.stringify` 而不是整体 —— 整体 stringify 在超长历史上会先拼出一个
 * 几十 MB 的字符串再喂给 hash，逐条喂省掉那次峰值。
 */
export function hashMessages(messages: AgentMessage[]): string {
  const hash = createHash('sha256')
  hash.update(String(messages.length))
  for (const message of messages) {
    hash.update('\0')
    hash.update(JSON.stringify(message))
  }
  return hash.digest('hex')
}

function checkpointPath(sessionId: string): string {
  return join(sessionsDir(), `${safeSessionFileBase(sessionId)}.compaction.json`)
}

/**
 * 读回检查点。
 *
 * 读不出来一律按「没有」处理：这是个缓存，坏了只意味着下次重压一遍，
 * 不该让整轮对话起不来。
 */
export async function loadCheckpoint(sessionId: string): Promise<CompactionCheckpoint | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(checkpointPath(sessionId), 'utf8')) as unknown
    return isCheckpoint(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 手写校验而不是信任盘上的 JSON —— 半个文件也能 parse 成功，字段却是 undefined */
function isCheckpoint(value: unknown): value is CompactionCheckpoint {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.contextEpoch === 'number' &&
    typeof record.summary === 'string' &&
    record.summary.length > 0 &&
    typeof record.cutIndex === 'number' &&
    record.cutIndex > 0 &&
    typeof record.sourceHash === 'string' &&
    typeof record.createdAt === 'number'
  )
}

/** 落盘。失败只记日志 —— 同 transcript，持久化是增强功能，不该拖垮对话 */
export async function saveCheckpoint(
  sessionId: string,
  checkpoint: CompactionCheckpoint
): Promise<void> {
  try {
    await fs.mkdir(sessionsDir(), { recursive: true })
    await fs.writeFile(checkpointPath(sessionId), JSON.stringify(checkpoint), 'utf8')
  } catch (error) {
    console.warn(`[AgentV3] 压缩检查点落盘失败 (${sessionId}):`, error)
  }
}

/**
 * 作废检查点。
 *
 * 会话被删、被截回某一轮时必须调 —— 留着的话，那份摘要描述的是一段已经不存在的
 * 对话。`sourceHash` 本来也能挡住（指纹对不上），但那要等到下一轮才发现，
 * 而这里能当场清掉一个明知已经过期的文件。
 */
export async function deleteCheckpoint(sessionId: string): Promise<void> {
  await fs.rm(checkpointPath(sessionId), { force: true }).catch(() => undefined)
}
