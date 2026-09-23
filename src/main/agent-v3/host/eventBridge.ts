/**
 * pi `AgentEvent` → 渲染进程的 `agent-v3:*` 通道。
 *
 * V2 有 21 个 `agent:*` 通道，其中 9 个是 Router / specialist 架构的副产物
 * （specialist-progress、routing-trace、plan-created…），V3 没有那套东西，
 * 那些通道自然消失。这里只保留对话本身需要的，并补上 V2 缺的两个：
 * 工具流式进度、推理内容。
 *
 * 投影而不是直接把 pi 的事件转发出去，是为了让渲染层不依赖 pi 的类型 ——
 * 以后换内核，改这一个文件即可。
 */

import type { WebContents } from 'electron'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import {
  hasTurnUsage,
  mergeTurnUsage,
  toTurnUsage,
  type AgentTurnUsage,
  type PiUsageLike
} from '../../../shared/agentUsage'
import { classifyProviderError } from './providerError'
import type { ToolRisk } from '../tools/defineTool'
import {
  creatorPlanChatError,
  isPlanProvider,
  type CreatorPlanChatErrorCode
} from '../../../shared/creatorPlan'
import { notifyAgentRun, toRunSignal } from './runObserver'
import { rememberRunOwner } from './runOwners'
import { stripEditorSnapshotBlock } from '../core/editorSnapshot'
import { stripAttachmentBlock } from '../core/promptAttachments'
import { parseMediaRef } from '../core/promptMedia'
import { stripSteerContextBlock } from './steerQueue'
import type { QuestionPayload } from './questionChannel'

/** 发给渲染层的事件。故意做成扁平结构，渲染层不需要认识 pi 的类型。 */
export type AgentV3Event =
  | { channel: 'agent-v3:start'; payload: { sessionId: string } }
  | { channel: 'agent-v3:text'; payload: { sessionId: string; text: string } }
  | { channel: 'agent-v3:thinking'; payload: { sessionId: string; text: string } }
  | {
      channel: 'agent-v3:tool-call'
      payload: {
        sessionId: string
        toolCallId: string
        toolName: string
        args: unknown
        /** 按这次的参数算出来的风险（`effectiveRisk`）。预演、只读查询在这里就是 safe */
        risk?: ToolRisk
      }
    }
  | {
      channel: 'agent-v3:tool-progress'
      payload: { sessionId: string; toolCallId: string; toolName: string; partial: unknown }
    }
  | {
      channel: 'agent-v3:tool-result'
      payload: {
        sessionId: string
        toolCallId: string
        toolName: string
        isError: boolean
        text: string
        details: unknown
      }
    }
  | { channel: 'agent-v3:step'; payload: { sessionId: string } }
  /**
   * 一条用户消息被内核读进上下文了。
   *
   * 唯一的用处是给插话回执：IPC 那个 `success` 只说明**入队成功**，
   * 真正「模型看见了」的时刻是 pi 把排队消息注入对话时发的这条事件。
   * 没有它，用户插完话只能盯着屏幕猜自己那句到底算不算数。
   */
  | { channel: 'agent-v3:user-message'; payload: { sessionId: string; text: string } }
  | { channel: 'agent-v3:done'; payload: { sessionId: string } }
  /** 用户主动停止。与 error 分开 —— 那是意图达成，不是故障 */
  | { channel: 'agent-v3:stopped'; payload: { sessionId: string } }
  /**
   * 模型调用失败。
   *
   * `message` 是 provider 的原文（日志和「接着跑」的复盘要它），后三个字段是从原文里
   * 抠出来的事实 —— 渲染层按 `statusCode` 分类友好文案、按 `detail` 显示那句人话，
   * 抠不到就都不填，退回通用文案。见 `providerError.ts`。
   */
  | {
      channel: 'agent-v3:error'
      payload: {
        sessionId: string
        message: string
        statusCode?: number
        code?: string
        detail?: string
        /**
         * 调的是 Box Plan、且服务端回的是套餐类错误（没订阅、额度用完、
         * 套餐不含这个角色、Key 失效）。渲染层据此给一条可点的提示，而不是通用错误。
         * 别的来源永远不带这个字段。
         */
        planError?: CreatorPlanChatErrorCode
      }
    }
  /** 上下文用量条。V2 没有 —— 用户不知道离压缩还有多远 */
  | {
      channel: 'agent-v3:context-usage'
      payload: { sessionId: string; tokens: number; contextWindow: number }
    }
  /**
   * 这一次模型往返花掉的 token。界面把一轮里的每次往返加起来显示在回复下面。
   *
   * 和 context-usage 分开发：那个是「现在上下文有多大」（会被压缩打回去），
   * 这个是「这次请求实际计费多少」（只增不减）。用一个通道表达两件事的话，
   * 压缩之后界面上的数字会突然变小，用户会以为已经花掉的钱退回来了。
   */
  | { channel: 'agent-v3:turn-usage'; payload: { sessionId: string } & AgentTurnUsage }
  /** 压缩会有几秒停顿，不说一声用户会以为卡住了 */
  | { channel: 'agent-v3:compacting'; payload: { sessionId: string; tokensBefore: number } }
  /** 工具审批请求。渲染层弹窗后经 agent-v3:approval-reply 回传 */
  | {
      channel: 'agent-v3:approval-required'
      payload: {
        sessionId: string
        toolCallId: string
        toolName: string
        namespace: string
        risk: string
        args: unknown
        /** false 时界面不给「本次会话都允许」，见 `core/approval.ts` */
        allowAlways: boolean
      }
    }
  /**
   * agent 反问用户。渲染层在时间线上长出一张选项卡片，
   * 用户点完经 `agent-v3:question-reply` 回传。见 `host/questionChannel.ts`。
   *
   * 和 approval-required 分成两个通道而不是加一个 kind 字段：审批是模态的
   * 「能不能做」，提问是就地的「你想要什么」，两边的界面和三态语义都不一样，
   * 合成一条通道之后每个消费方都要先分流一次。
   */
  | {
      channel: 'agent-v3:question-required'
      payload: QuestionPayload
    }

interface AgentMessageLike {
  content?: unknown
}

/** 从 pi 的消息内容里抽出纯文本 */
function extractText(message: unknown): string {
  const content = (message as AgentMessageLike | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => {
      const b = block as { type?: string; text?: unknown }
      // 音视频引用也是文本块，但那是给 streamFn 换链接用的标记，不是谁说的话
      return b.type === 'text' && typeof b.text === 'string' && !parseMediaRef(b.text)
    })
    .map((block) => block.text)
    .join('')
}

/** 从工具结果里抽出给 UI 显示的文本 */
function extractResultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => {
      const x = b as { type?: string; text?: unknown }
      return x.type === 'text' && typeof x.text === 'string'
    })
    .map((b) => b.text)
    .join('\n')
}

/**
 * 这次往返一共花了多少 token。
 *
 * 除了助手消息自己的用量，还要把工具结果上挂的用量加进来 —— `task` 工具是
 * 一个子 agent，它烧掉的 token 记在工具结果上而不是主循环的助手消息里。
 * 只看助手消息的话，一个「派个子任务去改十个材质」的回合会显示成几百 token，
 * 而账单上是几万。
 */
function turnUsageOf(event: Extract<AgentEvent, { type: 'turn_end' }>): AgentTurnUsage {
  const message = event.message as { usage?: PiUsageLike } | undefined
  let usage = toTurnUsage(message?.usage)

  for (const result of event.toolResults ?? []) {
    const toolUsage = (result as { usage?: PiUsageLike } | undefined)?.usage
    if (toolUsage) usage = mergeTurnUsage(usage, toTurnUsage(toolUsage))
  }

  return usage
}

/**
 * 投影这条助手消息时需要记住的东西：**已经流出去多少**。
 *
 * 增量（`message_update`）和终稿（`message_end`）说的是同一条消息，
 * 不记账的话两边都发一遍，界面上每句话会出现两次。
 */
export interface ProjectionState {
  /** 这条助手消息已经通过增量发出去的正文 */
  streamedText: string
  /** 同上，推理内容。终稿里没有推理，它只用于跨消息复位 */
  streamedThinking: string
}

export function createProjectionState(): ProjectionState {
  return { streamedText: '', streamedThinking: '' }
}

/**
 * 终稿里还没发出去的那一截。
 *
 * - 一个字都没流过（provider 不支持流式）→ 整条发出去，也就是老行为。
 * - 流过而且终稿以它开头 → 只补差额。正常情况下差额是空的。
 * - 流过但对不上（理论上不该发生）→ 什么都不发。宁可少一截，也不能把
 *   用户已经读到的那段再重复一遍。
 */
function pendingTail(text: string, streamed: string): string {
  if (!streamed) return text
  if (text.startsWith(streamed)) return text.slice(streamed.length)
  return ''
}

/**
 * 把一个 pi 事件投影成 0..n 个渲染层事件。
 *
 * 除了改 `state` 里的记账，没有别的副作用 —— 投影错了会让界面一片空白，
 * 而那种 bug 在 UI 上很难定位，所以它要能单独测。
 */
export function projectEvent(
  event: AgentEvent,
  sessionId: string,
  state: ProjectionState = createProjectionState()
): AgentV3Event[] {
  switch (event.type) {
    case 'agent_start':
      return [{ channel: 'agent-v3:start', payload: { sessionId } }]

    /**
     * 一条新的助手消息开始了，记账清零。
     *
     * 不投影成事件：界面上「开始说话」这件事由随后的第一个增量表达，
     * 提前发一条空的只会让 typing 气泡闪一下。
     */
    case 'message_start':
      state.streamedText = ''
      state.streamedThinking = ''
      return []

    /**
     * 流式增量 —— 这是「思考中」那三个字之外用户唯一能看到的东西。
     *
     * 原来这里什么都不投影，正文和推理全等到 `message_end` 一次性给：
     * 模型想两分钟，界面就空转两分钟，用户不知道它在想什么、有没有卡死，
     * 只能盯着一个转圈的点等。工具调用还有 `tool_execution_start` 顶着，
     * **第一轮**连那个都没有 —— 从发出消息到第一条工具调用之间完全是盲区。
     */
    case 'message_update': {
      const delta = event.assistantMessageEvent
      if (delta.type === 'text_delta') {
        if (!delta.delta) return []
        state.streamedText += delta.delta
        return [{ channel: 'agent-v3:text', payload: { sessionId, text: delta.delta } }]
      }
      if (delta.type === 'thinking_delta') {
        if (!delta.delta) return []
        state.streamedThinking += delta.delta
        return [{ channel: 'agent-v3:thinking', payload: { sessionId, text: delta.delta } }]
      }
      return []
    }

    case 'message_end': {
      // 正文只认 assistant 消息。pi 对**用户消息也发 message_end**
      // （agentLoop 把 prompt 和排队的插话加进上下文时都会发），
      // 不判角色的话用户自己刚说的那句会被当成助手回复回显到界面上。
      const message = event.message as {
        role?: string
        stopReason?: string
        errorMessage?: string
        /** pi 的 Model.provider，即我们的来源 id（见 piModel.ts 的 toPiModel） */
        provider?: string
      }
      if (message?.role !== 'assistant') {
        // 用户消息单发一个通道：渲染层拿它给插话打「已生效」回执，
        // 对不上任何一条待生效插话的（比如本轮最初的 prompt）会被忽略。
        if (message?.role !== 'user') return []
        /*
         * 剥掉闪存块和附件块，投出去的必须是**用户真正打的那句话**。
         *
         * 回执是按文本相等匹配的（`agentStream.markSteerApplied`）：界面上存着
         * 用户的原话，而模型收到的是「闪存块 + 附件块 + 原话」。不剥的话两边永远
         * 对不上，那条插话会一直显示「未生效」—— 而它其实早就进上下文了。
         *
         * 顺序和拼的时候一致：闪存块在最外面，图片附件块其次，插话带的文件块最里面。
         */
        const userText = stripSteerContextBlock(
          stripAttachmentBlock(stripEditorSnapshotBlock(extractText(event.message)))
        )
        return userText
          ? [{ channel: 'agent-v3:user-message', payload: { sessionId, text: userText } }]
          : []
      }

      // **provider 的失败在这里，不在异常里。**
      //
      // pi 的 StreamFn 契约明确要求「不得抛异常，失败编码进返回的事件流」——
      // 表现就是一条 stopReason 为 error/aborted 的助手消息。不看这两个字段的话，
      // 模型调不通时 agent.prompt() 会**正常返回**、IPC 报 success、界面一片空白，
      // 用户完全不知道发生了什么。
      //
      // 真实模型第一次跑就撞上了（模型 id 不对，四条验证全是 0 次调用却"成功"）。
      // 集成测试用 fauxProvider 编排的都是成功响应，暴露不出来。
      // 用户按停止走的是 agent.abort()，pi 同样用 stopReason 表达。
      // 但那是**用户的意图达成**，不是故障 —— 投到 error 通道会弹一个
      // 「模型调用被中止」的报错，用户点了停止反而被告知出错了。
      if (message.stopReason === 'aborted') {
        state.streamedText = ''
        state.streamedThinking = ''
        return [{ channel: 'agent-v3:stopped', payload: { sessionId } }]
      }

      if (message.stopReason === 'error') {
        state.streamedText = ''
        state.streamedThinking = ''
        const raw = message.errorMessage || '模型调用失败，未返回原因'
        // 状态码和错误码只存在于这串文本里（pi 在 provider 的 catch 里就把 SDK 的
        // error 对象压扁了）。抠出来发上去，渲染层那套按状态码分类的友好文案才有得用 ——
        // 不抠的话用户看到的是 `错误: 401: {"error":{"message":"Incorrect API key…"}}`
        const facts = classifyProviderError(raw)
        const planError =
          message.provider && isPlanProvider(message.provider)
            ? creatorPlanChatError(facts.statusCode, facts.code)
            : null
        return [
          {
            channel: 'agent-v3:error',
            payload: {
              sessionId,
              message: raw,
              ...facts,
              ...(planError ? { planError } : {})
            }
          }
        ]
      }

      // 只补增量还没发出去的那一截。流式跑通时这里通常是空的，
      // 而 provider 不支持流式（一个增量都没来过）时它就是整条正文。
      const tail = pendingTail(extractText(event.message), state.streamedText)
      state.streamedText = ''
      state.streamedThinking = ''
      return tail ? [{ channel: 'agent-v3:text', payload: { sessionId, text: tail } }] : []
    }

    case 'tool_execution_start':
      return [
        {
          channel: 'agent-v3:tool-call',
          payload: {
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args
          }
        }
      ]

    case 'tool_execution_update':
      // V2 没有这个 —— 长任务只能干等。现在工具能边跑边推进度。
      return [
        {
          channel: 'agent-v3:tool-progress',
          payload: {
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partial: event.partialResult
          }
        }
      ]

    case 'tool_execution_end':
      return [
        {
          channel: 'agent-v3:tool-result',
          payload: {
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            text: extractResultText(event.result),
            details: (event.result as { details?: unknown } | undefined)?.details
          }
        }
      ]

    case 'turn_end': {
      const events: AgentV3Event[] = [{ channel: 'agent-v3:step', payload: { sessionId } }]
      const usage = turnUsageOf(event)
      if (hasTurnUsage(usage)) {
        events.push({ channel: 'agent-v3:turn-usage', payload: { sessionId, ...usage } })
      }
      return events
    }

    case 'agent_end':
      return [{ channel: 'agent-v3:done', payload: { sessionId } }]

    // turn_start 不投影：它没有可显示的内容，一轮的开始由里面第一条
    // 增量或工具调用自己表达。
    default:
      return []
  }
}

/**
 * 把投影结果发到渲染进程，顺便广播给主进程内部的旁路观察者。
 *
 * 桥**有状态**（哪条消息流出去多少），所以一条会话一个桥，不能共用。
 *
 * 旁路广播放在 `sender.isDestroyed()` 判断**之前**：窗口没了不代表 agent 停了，
 * 而语音前台正等着知道这一轮什么时候结束。放在后面的话，用户切走界面之后
 * 任务默默跑完，语音那边永远停在「还在跑」。
 *
 * `hooks.onUserMessage` 同理走旁路：主进程自己也要知道哪条插话被读进去了
 * （影子队列据此销号，见 `steerQueue.ts`），这件事和窗口在不在没有关系。
 * 拿桥里这份文本而不是自己再抽一遍，是因为闪存块的剥离逻辑就在这儿 ——
 * 抽两遍迟早会分叉，然后「撤回」和「已生效」认定的不是同一条。
 */
export function createEventBridge(
  sender: WebContents,
  sessionId: string,
  hooks?: {
    onUserMessage?: (text: string) => void
    /**
     * 这次调用按参数算的风险。改动台账靠它分辨「真删」和「预演」——
     * 渲染层只有按工具名定级的静态表，看不见 `riskFor`
     */
    riskOf?: (toolName: string, args: unknown) => ToolRisk | undefined
  }
) {
  const state = createProjectionState()

  // 记下这条会话属于谁。系统通知点开时要拉的是**这个**窗口，
  // 不是「主窗口」—— MiniChat 里跑的会话拉主窗口等于拉错了（见 runOwners.ts）
  rememberRunOwner(sessionId, sender.id)

  return (event: AgentEvent): void => {
    const projected = projectEvent(event, sessionId, state)
    for (const item of projected) {
      if (item.channel === 'agent-v3:tool-call' && hooks?.riskOf) {
        const risk = hooks.riskOf(item.payload.toolName, item.payload.args)
        if (risk) item.payload.risk = risk
      }
      const signal = toRunSignal(item)
      if (signal) notifyAgentRun(signal)
      if (item.channel === 'agent-v3:user-message') hooks?.onUserMessage?.(item.payload.text)
    }
    if (sender.isDestroyed()) return
    for (const item of projected) {
      sender.send(item.channel, item.payload)
    }
  }
}
