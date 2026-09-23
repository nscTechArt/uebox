import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
  createModels,
  getSupportedThinkingLevels,
  type Api,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type MutableModels,
  type ThinkingLevel
} from '@earendil-works/pi-ai'

import { readSettings } from '../../ai/store'
import {
  ModelNotConfiguredError,
  describeMissingRole,
  findBinding,
  resolveRole,
  resolveRoleForRequest
} from '../../ai/resolveModel'
import type { AiProviderSettings, ModelRequest, ModelRole } from '../../ai/types'
import { classifyProviderError } from '../host/providerError'
import { toPiProvider } from './piModel'
import {
  contextHasMediaRefs,
  mediaUrlKinds,
  replaceMediaRefs,
  rewriteMediaInPayload
} from './promptMedia'
import { isObjectRemoved, mediaUrlFor } from '../../services/objectStorage/objectStorageService'
import {
  budgetFor,
  noteOversizedRequest,
  projectWithinBudget,
  type ProjectedContext
} from './requestBudget'

/**
 * 输入框里那个「思考程度」。
 *
 * 档位**不是我们定的**，是每个模型自己声明的：GPT-5 系有
 * minimal/low/medium/high，某些模型只有 off/high/max，本地小模型一个都没有。
 * 所以界面上的清单必须按当前模型现问（见 `listThinkingLevels`），不能写死 ——
 * 写死的结果是列出一堆这个模型根本没有的档位，选了跟没选一样。
 *
 * `auto` 是我们额外加的一档，表示**不指定**：请求里干脆不带思考预算这个字段，
 * 模型按自己的默认来。它是缺省值，所以加上这个开关不会悄悄改掉所有人的行为。
 */
export type ThinkingLevelChoice = 'auto' | ModelThinkingLevel

/** 界面上要显示的全部档位，顺序即强度。`auto` 永远在最前 */
export const THINKING_LEVEL_LADDER: readonly ThinkingLevelChoice[] = Object.freeze([
  'auto',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

function toPiReasoning(choice: ThinkingLevelChoice | undefined): ThinkingLevel | undefined {
  if (!choice || choice === 'auto') return undefined
  // pi 的 `reasoning` 参数类型里没有 "off"，但运行时是认的：它会走
  // clampThinkingLevel 再按各家 API 决定怎么表达「别思考」。类型比实际契约窄，
  // 这里如实转换而不是把 off 悄悄丢掉 —— 丢掉的话这一档点了没反应。
  return choice as ThinkingLevel
}

export interface PiModelSelection {
  model: Model<string>
  providerId: string
  modelId: string
  /** 回落之后实际命中的角色，用于日志 */
  role: ModelRole
}

/**
 * Models 集合缓存。
 *
 * `createProvider` 每次都要重新构造 lazy api 包装，而 `Agent` 的每一轮都要
 * 解析一次模型。按「配置内容」缓存而不是按 id —— 用户在设置页改了 Base URL
 * 或密钥来源之后必须立刻生效，不能等重启。
 */
let cached: { key: string; models: MutableModels } | undefined

function settingsKey(settings: AiProviderSettings): string {
  return JSON.stringify(
    settings.providers.map((p) => [p.id, p.protocol, p.baseUrl, p.headers, p.apiKey, p.models])
  )
}

function getModels(settings: AiProviderSettings): MutableModels {
  const key = settingsKey(settings)
  if (cached?.key === key) return cached.models

  // 不注册 pi-ai 的 builtinProviders：目录层是我们自己的
  // （对本地推理 / 国产云 / 自建网关的覆盖优于 pi 内建目录，见设计文档 §3.2）。
  const models = createModels()
  for (const provider of settings.providers) {
    models.setProvider(toPiProvider(provider))
  }

  cached = { key, models }
  return models
}

/** 设置变更后强制重建（IPC 保存配置时调用） */
export function invalidateProviderCache(): void {
  cached = undefined
}

/** 解析某个角色对应的模型。找不到绑定时返回 undefined，由调用方决定是报错还是回落。 */
function selectModel(
  settings: AiProviderSettings,
  models: MutableModels,
  role: ModelRole
): PiModelSelection | undefined {
  const found = findBinding(settings, role)
  if (!found) return undefined

  const config = settings.providers.find((item) => item.id === found.binding.providerId)
  if (!config) return undefined

  const model =
    models.getModel(config.id, found.binding.modelId) ??
    // 绑定的模型不在列表里 —— 用户在设置页删了它，或手改 models.json 改坏了。
    // 按绑定现场造一个，让调用仍然能打出去：厂商若不认这个 id 会返回明确的报错，
    // 比在这里拦下更有诊断价值。
    toPiProvider({ ...config, models: [{ id: found.binding.modelId }] }).getModels()[0]

  return {
    model,
    providerId: config.id,
    modelId: found.binding.modelId,
    role: found.usedRole
  }
}

/**
 * 投影，但绝不因此抛异常。
 *
 * StreamFn 的契约是**不能抛**（失败要编码进事件流里）。而投影要
 * `JSON.stringify` 整个 context，里面包含工具自己塞的 `details` —— 那是任意值，
 * 循环引用或者一个 BigInt 就会让它抛 TypeError。这些值以前从不参与序列化
 * （厂商只发 content），所以以前无所谓；现在一抛就会穿过 pi 的
 * `streamAssistantResponse`，那条路上没有 catch，整个 run 会被判失败。
 *
 * 量不出来就当没超：少一道保险，好过把一次能跑的对话变成一次崩溃。
 */
function projectSafely(context: Context, providerId: string): ProjectedContext {
  try {
    return projectWithinBudget(context, budgetFor(providerId))
  } catch (error) {
    // `bytes: -1` 而不是 0：下游要能分辨「这一轮没量出来」和「量出来是 0」。
    // 给 0 的话 `noteOversizedRequest` 的 `attemptedBytes <= 0` 会把它悄悄吃掉，
    // 于是出口闸和 413 学习**同时**失效，而日志里只有这一行。
    console.warn('[streamFn] 请求体量不出来，跳过出口闸:', error)
    return { context, bytes: -1, droppedImages: 0 }
  }
}

/**
 * 盯着这一轮的结果，厂商退 413 就把「这么大不行」记到这家名下。
 *
 * 只旁听不干预：`stream.result()` 和事件队列是两条路，读它不会影响正在
 * 消费事件流的调用方（见 pi-ai 的 `EventStream`）。pi 的契约是失败编码进
 * 消息里而不是抛出来，所以这里看的是 `stopReason`，不是异常。
 *
 * 这一轮已经失败了，救不回来 —— 但下一次（包括用户点「继续尝试」）会按学到
 * 的新预算投影，于是同一家的 413 只会发生一次。
 */
function watchForOversized(stream: unknown, providerId: string, bytes: number): void {
  // 旁听是可选的：拿到一个没有 result() 的流（假 provider、将来换实现）也只是
  // 学不到东西，绝不能因此让这一轮发不出去
  const result = (stream as { result?: () => Promise<unknown> })?.result
  if (typeof result !== 'function') return

  void Promise.resolve(result.call(stream))
    .then((value) => value as { stopReason?: string; errorMessage?: string })
    .then((message) => {
      if (message?.stopReason !== 'error') return
      if (classifyProviderError(message.errorMessage ?? '').statusCode === 413) {
        noteOversizedRequest(providerId, bytes)
      }
    })
    // 旁听失败绝不能影响这一轮：它只是为了让下一轮更聪明
    .catch(() => {})
}

export interface AgentModelRuntime {
  selection: PiModelSelection
  streamFn: StreamFn
  /** compaction 用。摘要模型可能与主模型不同 provider，所以要整个集合 */
  models: MutableModels
  /**
   * 生成摘要用的模型。
   *
   * 优先用 summary 角色 —— 压缩上下文不需要最贵的模型。没绑 summary 时回落到
   * 主模型，压缩仍然可用，只是贵一点。
   */
  summaryModel: Model<string>
}

/**
 * 解析本次调用要用的模型，连同 StreamFn 和 compaction 需要的集合。
 *
 * @throws {ModelNotConfiguredError} 没有任何可用绑定
 * @throws {MissingApiKeyError} 绑定存在但密钥取不到
 */
/** 当前绑定的模型支持哪些思考档位，供输入框那个下拉按模型列清单 */
export interface ThinkingLevelOptions {
  /** 该模型实际支持的档位，已按强度排序。`auto` 由界面自己补在最前 */
  levels: ModelThinkingLevel[]
  /**
   * 厂商给这些档位起的名字（pi 的 `thinkingLevelMap`）。
   *
   * 有的模型把 `high` 叫成别的词。界面显示厂商的说法、把标准名放在括号里，
   * 用户在别处（厂商文档、官方客户端）看到的就对得上。
   */
  levelMap: Record<string, string | null>
  /** 这次的档位清单是按哪个模型问出来的，界面上要说清楚 */
  modelId: string
}

/**
 * 问内核：**这个模型**能调哪几档思考。
 *
 * 不同模型的档位天差地别 —— 有的是 minimal/low/medium/high，有的只有
 * off/high/max，不会思考的模型只有 off。界面写死一份清单的话，用户会看到
 * 一堆当前模型根本没有的档位，选了内核会悄悄夹到最近的一档，表现就是
 * 「选了没反应」。所以清单必须现问。
 *
 * 模型没配好时返回 null 而不是抛错：这只是为了画一个下拉，
 * 不该把「还没配模型」升级成一次报错弹窗。
 */
export async function listThinkingLevels(
  request: ModelRequest = {}
): Promise<ThinkingLevelOptions | null> {
  const settings = await readSettings()
  const models = getModels(settings)
  const selection = selectModel(settings, models, resolveRoleForRequest(settings, request))
  if (!selection) return null

  return {
    levels: getSupportedThinkingLevels(selection.model),
    levelMap: (selection.model.thinkingLevelMap ?? {}) as Record<string, string | null>,
    modelId: selection.modelId
  }
}

export async function resolveAgentModel(
  request: ModelRequest = {},
  thinkingLevel?: ThinkingLevelChoice
): Promise<AgentModelRuntime> {
  const stored = await readSettings()
  // 台架钉死模型：把这一角色的绑定临时换成钉死的那对，其余（密钥、provider 表）照旧
  const settings = request.pin
    ? { ...stored, roles: { ...stored.roles, [resolveRole(request)]: request.pin } }
    : stored
  const models = getModels(settings)
  const role = resolveRoleForRequest(settings, request)

  const selection = selectModel(settings, models, role)
  if (!selection) {
    throw new ModelNotConfiguredError(describeMissingRole(role), role)
  }

  const reasoning = toPiReasoning(thinkingLevel)
  // 对话里的多媒体引用，这个模型能直接收哪几类链接，见 promptMedia.ts
  const urlKinds = mediaUrlKinds(settings, selection.providerId, selection.modelId)

  return {
    selection,
    // 契约：StreamFn **不能抛异常**，失败要编码进返回的事件流里（见 pi 的 StreamFn 文档）。
    // 这里只做分派，模型解析的失败在上面已经抛掉了。
    //
    // 思考档位放在最后覆盖：这条 streamFn 是全应用唯一给 pi 传 reasoning 的地方，
    // 用户在输入框里选了什么就是什么。
    //
    // 出口闸也挂在这里，理由同上 —— 这是**发起 agent 请求**唯一的一条路，
    // 而请求有多大不由任何一个工具说了算（见 `requestBudget.ts` 文件头）。
    // 注意压缩用的摘要请求走的是 pi 的 `models.completeSimple`，不经过这里；
    // 那条路上 `serializeConversation` 会把图片全部丢成文本，所以不需要闸。
    streamFn: (model, context, options) => {
      const projected = projectSafely(context, selection.providerId)
      if (projected.droppedImages > 0) {
        console.warn(
          `[streamFn] 本轮请求超出 ${selection.providerId} 的预算，` +
            `已丢掉 ${projected.droppedImages} 张图（最大的优先），换成占位文字`
        )
      }
      // 收不了的那几类先换成说明，剩下的（如果还有）在 onPayload 里换成链接
      const outgoing = replaceMediaRefs(projected.context, urlKinds)
      const hasMedia = contextHasMediaRefs(outgoing)
      const previousOnPayload = options?.onPayload
      const stream = models.streamSimple(model, outgoing, {
        ...options,
        ...(reasoning ? { reasoning } : {}),
        ...(hasMedia
          ? {
              onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
                const upstream = await previousOnPayload?.(payload, payloadModel)
                const current = upstream === undefined ? payload : upstream
                const rewritten = await rewriteMediaInPayload(current, {
                  urlFor: mediaUrlFor,
                  isRemoved: isObjectRemoved
                })
                return rewritten === undefined ? upstream : rewritten
              }
            }
          : {})
      })
      // 没量出来（bytes < 0）就没有可学的数 —— 别拿一个假数去调这家的预算
      if (projected.bytes >= 0) {
        watchForOversized(stream, selection.providerId, projected.bytes)
      }
      return stream
    },
    models,
    summaryModel: selectModel(settings, models, 'summary')?.model ?? selection.model
  }
}
