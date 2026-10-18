/**
 * 厂商回「上下文超长」时，这一轮不停，自己补救一次。
 *
 * ## 为什么要有它
 *
 * 真机（DeepSeek V4，1M 窗口）：
 *
 * > This model's maximum context length is 1048576 tokens. However, you requested
 * > 1289691 tokens (896475 in the messages, 393216 in the completion).
 *
 * 厂商把「输入 + `max_tokens`」一起算。pi 本来会按「窗口 − 估算输入」夹 `max_tokens`，
 * 压缩也按同一个估算触发 —— 但估算是「上一轮厂商报的用量 + 之后新增的字符数 ÷ 3.5」，
 * 一轮里冒出几十万字的中文 / JSON 工具结果时能低估几十万 token。于是 `max_tokens`
 * 没夹下来（照发 393,216），85% 的压缩线也没碰到，整轮直接 400 收工。
 *
 * 事前估得再准也有漏的时候，所以在**被拒之后**补救：厂商这时已经把真实数字说出来了。
 *
 * 1. 报错里有「消息占了多少」：输出上限改成「窗口 − 真实输入 − 余量」重发。上面那次
 *    还剩 15 万，足够回话，不用动历史。
 * 2. 剩下的不够回话（或者报错里没数）：当场压缩上下文，再重发。
 *
 * 每种补救一轮最多一次；两样都试过还超，照常把厂商原话交给调用方。
 *
 * 只看第一个事件：pi 在 HTTP 失败时只推一个 `error`、不推 `start`，这时调用方还什么
 * 都没收到，换一条流接上不会留下半截内容（同 `streamFn.ts` 的 `retryOnFirstError`）。
 */

import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  isContextOverflow,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Message
} from '@earendil-works/pi-ai'

/** 按真实输入重算输出上限时，再让出这么多，防厂商计数和报的数有出入 */
export const OVERFLOW_SAFETY_TOKENS = 2_048

/**
 * 输出上限低于这个就不靠「缩输出」过关，改去压缩。
 *
 * 思考模型的思考也算在输出里：只给几千，它想到一半就被截断，回话是空的 ——
 * 比压缩一次更糟。
 */
export const MIN_OUTPUT_TOKENS = 16_384

export interface OverflowNumbers {
  /** 模型的上下文上限 */
  limit?: number
  /** 这次请求里消息（输入）占了多少 */
  input?: number
}

const num = (text: string | undefined): number | undefined => {
  if (!text) return undefined
  const value = Number(text.replace(/,/g, ''))
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 从超长报错里抠出上限和真实输入。抠不出的字段留空。
 *
 * - OpenAI 兼容（DeepSeek、OpenRouter、vLLM…）：
 *   `maximum context length is 1048576 tokens. However, you requested 1289691 tokens
 *   (896475 in the messages, 393216 in the completion)`
 * - Anthropic：`prompt is too long: 213462 tokens > 200000 maximum`
 */
export function parseOverflowNumbers(errorMessage: string): OverflowNumbers {
  const openAi = {
    limit: num(/maximum context length is ([\d,]+) tokens/i.exec(errorMessage)?.[1]),
    input: num(/\(([\d,]+) in the messages/i.exec(errorMessage)?.[1])
  }
  if (openAi.limit || openAi.input) return openAi
  const anthropic = /prompt is too long:\s*([\d,]+) tokens\s*>\s*([\d,]+)/i.exec(errorMessage)
  if (anthropic) return { input: num(anthropic[1]), limit: num(anthropic[2]) }
  return {}
}

/**
 * 按报错里的真实数字，这次能给多少输出。给不出够用的（或没数可算）返回 undefined。
 */
export function outputRoomFor(numbers: OverflowNumbers): number | undefined {
  if (!numbers.limit || !numbers.input) return undefined
  const room = numbers.limit - numbers.input - OVERFLOW_SAFETY_TOKENS
  return room >= MIN_OUTPUT_TOKENS ? room : undefined
}

export interface OverflowRecoveryDeps {
  /**
   * 当场压缩，返回压完的消息（含开头的 system 消息）；压不动返回 undefined。
   * 由宿主接到自动压缩那份闭包上，好让压出来的检查点后面的请求接着用。
   */
  compact: (signal?: AbortSignal) => Promise<Message[] | undefined>
  /** 每次补救前说一声（写日志） */
  onRecover?: (info: { action: 'shrink-output' | 'compact'; reason: string }) => void
}

/**
 * 给 streamFn 套上超长补救。见文件头。
 */
export function overflowRecoveringStreamFn(inner: StreamFn, deps: OverflowRecoveryDeps): StreamFn {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream()

    void (async () => {
      let currentContext = context
      let currentOptions = options
      let shrunk = false
      let compacted = false

      for (;;) {
        const stream: AssistantMessageEventStream = await inner(
          model,
          currentContext,
          currentOptions
        )
        const iterator = stream[Symbol.asyncIterator]()
        const head = await iterator.next()
        const failed = overflowFailure(head, model.contextWindow)

        if (failed) {
          const reason = failed.errorMessage ?? ''
          const room = shrunk ? undefined : outputRoomFor(parseOverflowNumbers(reason))
          if (room !== undefined) {
            shrunk = true
            deps.onRecover?.({ action: 'shrink-output', reason })
            currentOptions = {
              ...currentOptions,
              maxTokens: Math.min(room, currentOptions?.maxTokens ?? model.maxTokens)
            }
            continue
          }
          if (!compacted && !currentOptions?.signal?.aborted) {
            compacted = true
            deps.onRecover?.({ action: 'compact', reason })
            const messages = await deps.compact(currentOptions?.signal).catch(() => undefined)
            if (messages) {
              currentContext = { ...currentContext, messages }
              // 压完重新给一次缩输出的机会：输入变了，上一次算的余量不作数
              shrunk = false
              continue
            }
          }
        }

        if (!head.done) out.push(head.value)
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
          out.push(next.value)
        }
        break
      }
      out.end()
    })().catch((error: unknown) => {
      // 已经推过结局的话这一条会被忽略（EventStream 结束后不再收）
      out.push({
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now()
        }
      })
      out.end()
    })

    return out
  }
}

/** 第一个事件就是「上下文超长」的失败，返回那条失败消息 */
function overflowFailure(
  head: IteratorResult<AssistantMessageEvent>,
  contextWindow: number
): AssistantMessage | undefined {
  if (head.done || head.value.type !== 'error' || head.value.reason !== 'error') return undefined
  return isContextOverflow(head.value.error, contextWindow) ? head.value.error : undefined
}
