import {
  contentText,
  createModels,
  type AssistantMessage,
  type Message
} from '@earendil-works/pi-ai'
import { toPiProvider } from '../agent-v3/core/piModel'
import {
  ModelNotConfiguredError,
  describeMissingRole,
  findBinding,
  resolveRoleForRequest
} from './resolveModel'
import { readSettings } from './store'
import type { ModelRequest, ModelRole, ProviderConfig } from './types'

/**
 * 不带工具的一次模型调用。
 *
 * 应用里除 Agent 之外还有一批「一问一答」的调用点：连通性探针、蓝图自动布线、
 * 助手对话、追问建议、截图分析。它们此前走 AI SDK，而 Agent 走 pi —— 同一个
 * Provider 配置要伺候两套 HTTP 实现，等于每家厂商的怪癖都要修两遍。
 * 上一次就栽在这上面：ChatGPT 订阅的 Codex 后端在 pi 那边是好的，AI SDK 这边
 * 一调用就 400，于是又加了一层「把 pi 的模型包成 AI SDK 模型」的桥。
 *
 * 这个模块把那批调用点收敛到 pi 上，桥就不需要了。
 *
 * ## 边界
 *
 * **只做不带工具的调用。** 带工具的循环（判断该不该继续、审批、压缩）是
 * `agent-v3` 的事，那边直接用 pi 的 Agent，不经过这里。
 */

/** pi 的模型 + 它所属的 Models 实例。两者要一起用，分开拿没有意义 */
function resolveModel(
  provider: ProviderConfig,
  modelId: string
): {
  models: ReturnType<typeof createModels>
  model: Parameters<ReturnType<typeof createModels>['complete']>[0]
} {
  const models = createModels()
  models.setProvider(toPiProvider(provider))
  const model =
    models.getModel(provider.id, modelId) ??
    // 绑定的模型不在清单里（用户在设置页删了它）。按绑定现场造一个，让调用
    // 仍然打得出去 —— 厂商不认这个 id 会给出明确的报错，比在这里拦下更有
    // 诊断价值。与 piLanguageModel / streamFn 的处理保持一致。
    toPiProvider({ ...provider, models: [{ id: modelId }] }).getModels()[0]
  return { models, model }
}

/**
 * pi 失败时**不 reject**，而是回一条 `stopReason: 'error'` 的消息。
 *
 * 不在这里翻成异常的话，调用方拿到的是一条内容为空的「正常」回复 ——
 * 界面上表现为模型答了个空，而真正的报错在 errorMessage 里没人看。
 */
function throwIfFailed(message: AssistantMessage): void {
  if (message.stopReason !== 'error' && message.stopReason !== 'aborted') return
  throw new Error(message.errorMessage || `模型调用失败（${message.stopReason}）`)
}

export async function resolveBinding(
  request: ModelRequest = {}
): Promise<{ provider: ProviderConfig; modelId: string; role: ModelRole }> {
  const settings = await readSettings()
  const role = resolveRoleForRequest(settings, request)
  const found = findBinding(settings, role)
  if (!found) throw new ModelNotConfiguredError(describeMissingRole(role), role)

  const provider = settings.providers.find((item) => item.id === found.binding.providerId)
  if (!provider) {
    // normalizeRoles 已经丢弃了悬空绑定，走到这里说明配置在读取之后被改过
    throw new ModelNotConfiguredError(
      `模型绑定指向了不存在的 Provider «${found.binding.providerId}»，请重新配置。`,
      role
    )
  }

  return { provider, modelId: found.binding.modelId, role: found.usedRole }
}

export interface CompletionRequest {
  /** 系统提示词。不给就不发 */
  system?: string
  /** 对话消息。单轮直接给一条 user */
  messages: Message[]
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  /** 原样并进请求体的额外字段（如 response_format）。只有 OpenAI 兼容那几家会读 */
  samplingParams?: Record<string, unknown>
}

/** 一条纯文本的用户消息。单轮调用点占多数，省得每处都拼一遍 */
export function userMessage(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 }
}

/**
 * 一条**回放用**的助手消息。
 *
 * 内核的 `AssistantMessage` 带着 api / provider / model / usage 这些「这条是谁
 * 生成的」的元信息，因为它平时就是内核自己产出的。但界面回放历史时手上只有
 * 文字 —— 那些元信息在这条消息上本来就不存在，填 0 和空串是**如实表示没有**，
 * 而不是编一个。它们不进请求体，各家适配器只取 role 与 content。
 */
export function assistantMessage(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: '',
    provider: '',
    model: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 0
  }
}

/**
 * 发一次请求，拿回**纯文本**。
 *
 * 思考内容（ThinkingContent）不在返回值里：调用方要的是答案本身，
 * 把思考拼进去会让「取模型回复」的地方多出一段用户没要的自言自语。
 */
export async function completeText(
  provider: ProviderConfig,
  modelId: string,
  request: CompletionRequest
): Promise<string> {
  const message = await complete(provider, modelId, request)
  return contentText(message.content.filter((part) => part.type === 'text'))
}

/** 同上，但回整条消息 —— 需要 usage、stopReason 的调用点用它 */
export async function complete(
  provider: ProviderConfig,
  modelId: string,
  request: CompletionRequest
): Promise<AssistantMessage> {
  const { models, model } = resolveModel(provider, modelId)
  const message = await models.complete(
    model,
    {
      ...(request.system ? { systemPrompt: request.system } : {}),
      messages: request.messages
    },
    {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.samplingParams ? { samplingParams: request.samplingParams } : {})
    }
  )
  throwIfFailed(message)
  return message
}

/**
 * 流式版本。逐段吐出**新增的**文本。
 *
 * 给的是增量而不是全量：调用方（助手对话、库面板）要往界面上追加，
 * 拿全量还得自己做差分，而差分算错的表现是文字重复或漏字。
 */
export async function* streamText(
  provider: ProviderConfig,
  modelId: string,
  request: CompletionRequest
): AsyncGenerator<string, AssistantMessage> {
  const { models, model } = resolveModel(provider, modelId)
  const stream = models.stream(
    model,
    {
      ...(request.system ? { systemPrompt: request.system } : {}),
      messages: request.messages
    },
    {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.samplingParams ? { samplingParams: request.samplingParams } : {})
    }
  )

  // 思考增量（thinking_delta）不吐：那是模型的自言自语，界面上另有地方显示，
  // 混进正文会让「模型回复」变成一段用户没要的推理过程
  let emitted = 0
  for await (const event of stream) {
    if (event.type !== 'text_delta') continue
    emitted += event.delta.length
    yield event.delta
  }

  const message = await stream.result()
  throwIfFailed(message)

  // 收尾补一次：有的 provider 只在结束时给全文、不发增量。不补的话用户看到的
  // 是一片空白，而且没有任何报错
  const full = contentText(message.content.filter((part) => part.type === 'text'))
  if (full.length > emitted) yield full.slice(emitted)

  return message
}
