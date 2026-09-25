import { ipcMain } from 'electron'
import {
  generateImages,
  getImageModelStatus,
  type GenerateImagesRequest
} from '../ai/imageGeneration'
import {
  convertToPiMessages,
  extractSystemPrompt,
  messagesHaveImages
} from '../ai/messageConverter'
import { resolveModelLimitsById } from '../ai/modelLimits'
import { complete, resolveBinding, streamText } from '../ai/piCompletion'
import { FALLBACK_MODEL_LIMITS } from '../../shared/tokenBudget'
import {
  runWithStructuredOutput,
  withSystemHint,
  type ResponseFormatRequest
} from '../ai/structuredOutput'
import type { ModelLevel, ModelRole } from '../ai/types'
import { hasTurnUsage, toTurnUsage, type AgentTurnUsage } from '../../shared/agentUsage'

interface ChatCompletionArgs {
  messages: unknown[]
  role?: ModelRole
  level?: ModelLevel
  temperature?: number
  maxTokens?: number
  callType?: string
  responseFormat?: ResponseFormatRequest
  /** 请模型别思考（关不掉的夹到最低档），见 piCompletion 的 `reasoning` */
  reasoning?: 'off'
}

interface ChatStreamArgs extends ChatCompletionArgs {
  sessionId?: string
}

/** 正在进行的流，供 ai:chat-stream-abort 取消 */
const activeStreams = new Map<string, AbortController>()

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 这一轮的 token 用量。厂商没报就返回 undefined，界面少显示一行而已 */
function turnUsage(usage: unknown): AgentTurnUsage | undefined {
  const turn = toTurnUsage(usage as Parameters<typeof toTurnUsage>[0])
  return hasTurnUsage(turn) ? turn : undefined
}

export function registerAiIPC(): void {
  /**
   * 这个角色 / 档位实际会用哪个模型，它的窗口和输出上限是多少。
   *
   * 渲染层要这个是为了**按模型算预算**：知识库以前四处各写一个字符上限
   * （40000 / 50000 / 12000 / 8000），全是照「中文 1.5 字一 token」拍的。
   * 结果配了 1M 窗口的模型照样被 4 万字卡住，配了 8k 小模型又照样撑爆。
   *
   * 拿不到（没配模型）时不抛错，回一个 `configured: false` —— 界面该显示的是
   * 一个保守的缺省预算，而不是一片报错；真正缺模型的提示在发起生成时才给。
   */
  ipcMain.handle(
    'ai:model-limits',
    async (_event, args: { role?: ModelRole; level?: ModelLevel } = {}) => {
      try {
        const binding = await resolveBinding({ role: args.role, level: args.level ?? 'medium' })
        const limits = resolveModelLimitsById(binding.provider, binding.modelId)
        return {
          success: true,
          data: {
            configured: true,
            providerId: binding.provider.id,
            modelId: binding.modelId,
            contextWindow: limits.contextWindow,
            maxOutputTokens: limits.maxOutputTokens
          }
        }
      } catch (error) {
        console.warn('[AI IPC] model-limits 取不到绑定，回落到保守缺省:', describeError(error))
        return {
          success: true,
          data: {
            configured: false,
            contextWindow: FALLBACK_MODEL_LIMITS.contextWindow,
            maxOutputTokens: FALLBACK_MODEL_LIMITS.maxOutputTokens
          }
        }
      }
    }
  )

  /**
   * 非流式补全。用于需要一次性拿到完整结果的场景（追问建议、笔记标题、提示词优化）。
   */
  ipcMain.handle('ai:chat-completion', async (_event, args: ChatCompletionArgs) => {
    try {
      const raw = args.messages || []
      const binding = await resolveBinding({
        role: args.role,
        level: args.level ?? 'low',
        agentType: args.callType,
        hasImages: messagesHaveImages(raw)
      })

      // 结构化输出按能力表发，被厂商拒了自动降一档重来（见 structuredOutput.ts）
      const message = await runWithStructuredOutput(binding, args.responseFormat, (plan) =>
        complete(binding.provider, binding.modelId, {
          system: withSystemHint(extractSystemPrompt(raw), plan),
          messages: convertToPiMessages(raw),
          temperature: args.temperature ?? 0.7,
          ...(args.maxTokens && args.maxTokens > 0 ? { maxTokens: args.maxTokens } : {}),
          ...(plan.samplingParams ? { samplingParams: plan.samplingParams } : {}),
          ...(args.reasoning ? { reasoning: args.reasoning } : {})
        })
      )

      const usage = turnUsage(message.usage)
      return {
        success: true,
        data: {
          content: message.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            .join(''),
          usage: {
            promptTokens: usage?.input ?? 0,
            completionTokens: usage?.output ?? 0,
            totalTokens: usage?.total ?? 0
          },
          finishReason: message.stopReason || 'stop'
        }
      }
    } catch (error) {
      const message = describeError(error)
      console.error('[AI IPC] chat-completion 失败:', message)
      return { success: false, error: message }
    }
  })

  /**
   * 流式补全。
   *
   * 原先这里是个 TODO 桩（`流式接口暂未完全迁移`），渲染层绕过它直接 fetch
   * 官方网关。直连之后必须走主进程，桩补齐了。
   *
   * 增量通过事件推给渲染层而不是走 invoke 的返回值 —— invoke 是一次性的，
   * 没法边算边出。
   */
  ipcMain.handle('ai:chat-stream', async (event, args: ChatStreamArgs) => {
    const sessionId = args.sessionId || 'ai-stream'
    const controller = new AbortController()
    activeStreams.set(sessionId, controller)

    try {
      const raw = args.messages || []
      const binding = await resolveBinding({
        role: args.role,
        level: args.level ?? 'medium',
        agentType: args.callType,
        hasImages: messagesHaveImages(raw)
      })

      // 一旦有增量发给了渲染层就不能再重来 —— 用户会看到同一段话被接两遍，
      // 那比少一层格式约束糟得多
      let emitted = 0

      // 结构化输出在流式这条路上同样有用：知识库 Studio 的图谱、面试题、
      // 头脑风暴要的是 JSON，而它们因为耗时长必须走流式（要能中止）
      const result = await runWithStructuredOutput(
        binding,
        args.responseFormat,
        async (plan) => {
          const stream = streamText(binding.provider, binding.modelId, {
            system: withSystemHint(extractSystemPrompt(raw), plan),
            messages: convertToPiMessages(raw),
            temperature: args.temperature ?? 0.7,
            signal: controller.signal,
            ...(args.maxTokens && args.maxTokens > 0 ? { maxTokens: args.maxTokens } : {}),
            ...(plan.samplingParams ? { samplingParams: plan.samplingParams } : {})
          })

          let text = ''
          let final: Awaited<ReturnType<typeof stream.next>>
          while (!(final = await stream.next()).done) {
            if (controller.signal.aborted) break
            text += final.value
            emitted += final.value.length
            // 渲染层可能已经关掉了（切页面、关窗口），发之前先确认。
            if (!event.sender.isDestroyed()) {
              event.sender.send('ai:stream-chunk', { sessionId, delta: final.value })
            }
          }

          return { text, usage: final.done ? turnUsage(final.value.usage) : undefined }
        },
        { canRetry: () => emitted === 0 }
      )

      if (!event.sender.isDestroyed()) {
        event.sender.send('ai:stream-done', {
          sessionId,
          text: result.text,
          aborted: controller.signal.aborted,
          usage: result.usage
        })
      }
      return { success: true }
    } catch (error) {
      const message = describeError(error)
      console.error('[AI IPC] chat-stream 失败:', message)
      if (!event.sender.isDestroyed()) {
        event.sender.send('ai:stream-error', { sessionId, message })
      }
      return { success: false, error: message }
    } finally {
      activeStreams.delete(sessionId)
    }
  })

  ipcMain.handle('ai:chat-stream-abort', (_event, args: { sessionId?: string }) => {
    const controller = activeStreams.get(args?.sessionId || 'ai-stream')
    controller?.abort()
    return { success: true }
  })

  /**
   * 按用户配置的「生图」模型出图。
   *
   * 与聊天同理，必须走主进程：密钥不进渲染层，而且渲染层直连厂商域名会撞上 CORS。
   * 返回的是 base64 而不是 URL —— 本机 provider（Ollama、自建网关）根本不给外链，
   * 而给外链的那几家链接都是几小时后失效的临时地址，存下来的资产会集体变成裂图。
   */
  ipcMain.handle('ai:image-generate', async (_event, args: GenerateImagesRequest) => {
    try {
      return { success: true, data: { images: await generateImages(args) } }
    } catch (error) {
      const message = describeError(error)
      console.error('[AI IPC] image-generate 失败:', message)
      return { success: false, error: message }
    }
  })

  /** 只看有没有绑定，不发请求。界面据此决定显示生成按钮还是引导 */
  ipcMain.handle('ai:image-model-status', async () => ({
    success: true,
    data: await getImageModelStatus()
  }))

  console.log('[AI IPC] 处理器已注册')
}
