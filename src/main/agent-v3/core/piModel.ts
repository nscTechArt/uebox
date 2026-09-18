/**
 * `src/main/ai` 的 Provider 配置 → pi-ai 的 `Model` / `Provider`。
 *
 * 分工：
 *   - **目录层仍然是我们自己的**（`catalog.generated.ts` + 用户在设置页配的
 *     `models.json`）。它对本地推理（Ollama / LM Studio / llama.cpp）、国产云
 *     厂商官方端点、自建网关（one-api / litellm）的覆盖优于 pi-ai 内建目录。
 *   - **传输层交给 pi-ai**。我们 43 家 provider 只用到 4 种协议，pi-ai 全部实现，
 *     还附带 prompt cache、重试退避、thinking level 映射。
 *
 * 所以这里不用 pi-ai 的 `builtinProviders()`，而是用 `createProvider()` 把
 * 我们的每个 ProviderConfig 包成一个 pi Provider —— 这正是 pi 给 "models.json
 * custom providers" 留的口子。
 */

import { createProvider, type Provider } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import type { Api, Model, ProviderStreams, ThinkingLevelMap } from '@earendil-works/pi-ai'

import { findCatalogEntry } from '../../ai/catalog'
import { resolveModelLimits } from '../../ai/modelLimits'
import { resolveApiKey } from '../../ai/credentials'
import type { ProviderConfig } from '../../ai/types'
import type { ModelConfig, ProviderProtocol } from '../../../shared/aiProvider'

/**
 * 我们的 `ProviderProtocol` 与 pi-ai 的 `Model.api` 是同一套词汇，值也一样，
 * 但类型上没关系。这张表既做转换也做「pi 是否支持这个协议」的编译期保证 ——
 * 以后 ProviderProtocol 加了新成员，这里会直接报缺 key。
 */
const API_IMPL: Readonly<Record<ProviderProtocol, () => ProviderStreams>> = Object.freeze({
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  // ChatGPT 订阅账号走 pi 自带的 codex 实现：账号 id 从令牌里解、强制流式、
  // 不落库，这些 openai-responses 那一档都不做（见 shared/aiProvider.ts）。
  'openai-codex-responses': openAICodexResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi
})

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * 窗口与输出上限。查法搬到了 `ai/modelLimits.ts` —— 知识库那边也要按模型算预算，
 * 两处各写一份的话迟早对不上（上一版就是知识库那边干脆写死字符数）。
 */
function limitsFor(
  provider: ProviderConfig,
  model: ModelConfig
): { contextWindow: number; maxTokens: number } {
  const limits = resolveModelLimits(provider, model)
  return {
    contextWindow: limits.contextWindow,
    // pi 的 `maxTokens` 指的是**单次输出**上限，不是上下文总量。
    maxTokens: limits.maxOutputTokens
  }
}

function catalogModel(provider: ProviderConfig, model: ModelConfig): ModelConfig | undefined {
  return findCatalogEntry(provider.id)?.models.find((item) => item.id === model.id)
}

/**
 * pi 自带目录里的同名模型。
 *
 * 我们的目录来自 models.dev，它只说「这个模型会不会推理」，**不说它有哪几档**。
 * 档位阶梯（`thinkingLevelMap`）只有 pi 的目录有 —— 比如 DeepSeek V4 Flash
 * 是 `{minimal: null, low: "low", medium: null, high: "high", max: "max"}`，
 * 也就是它只有 low / high / max 三档，没有 minimal 和 medium。
 *
 * 不把这张表带上，内核就只能按「什么都不知道」的缺省行为列档位：
 * 列出模型根本没有的 minimal / medium，又漏掉它真有的 max。
 *
 * 按 (provider id, model id) 对齐 —— 我们的目录 id 与 pi 的同源，能对上。
 * 用户自建的网关对不上，那就没有这张表，回落到缺省行为。
 */
function builtinModel(provider: ProviderConfig, model: ModelConfig): Model<Api> | undefined {
  // getBuiltinModel 的入参是字面量联合类型，动态查得放宽；查不到会回 undefined
  const lookup = getBuiltinModel as unknown as (
    providerId: string,
    modelId: string
  ) => Model<Api> | undefined
  return lookup(provider.id, model.id)
}

/**
 * 这个模型有哪几档思考。
 *
 * 三档回落：**用户在设置页填的** → 我们的目录 → pi 自带目录。
 *
 * 用户排在最前是因为这是唯一的兜底：pi 的目录是随包发的快照，新出的型号、
 * 自建网关、以及数据过期的情况它都覆盖不到，而厂商也没有哪个接口能报出
 * 「我有哪几档」—— 只能让知情的人自己填。
 *
 * 我们的目录排在 pi 前面（与 `reasoningFor` 相反），因为那里的阶梯**只有覆盖时才写**：
 * 每一条都对应 THINKING_OVERRIDES 里一条注明了核对日期和文档出处的记录，
 * 写下来就是「这一条 pi 那份给不对」。让 pi 压在上面，等于哪天 pi 补进来一条
 * 过期数据就把我们查证过的结论顶掉，而且是静默的。
 *
 * 这一档也是**老配置的兜底**：models.json 是加 Provider 那天从目录抄下来的快照，
 * 之后目录补了阶梯，已经存过的那份不会自己更新 —— 没有这一档，老用户要把
 * Provider 删了重加才能看见新档位。
 *
 * `null` 在这张表里表示「这一档不存在」，与「没写」是两回事，所以整张表
 * 原样带过去，不做任何过滤 —— 内核的 `getSupportedThinkingLevels` 认这个区别。
 */
function thinkingLevelMapFor(
  provider: ProviderConfig,
  model: ModelConfig
): ThinkingLevelMap | undefined {
  return (
    (model.thinkingLevelMap as ThinkingLevelMap | undefined) ??
    (catalogModel(provider, model)?.thinkingLevelMap as ThinkingLevelMap | undefined) ??
    builtinModel(provider, model)?.thinkingLevelMap
  )
}

/**
 * 这个模型会不会「先思考再回答」。
 *
 * 四档回落：models.json 里用户自己勾的 → pi 自带目录 → 我们的目录 → 否。
 *
 * pi 排在我们的目录前面，是因为**档位阶梯也来自它**（见 thinkingLevelMapFor）：
 * 两处取自同一条记录，才不会出现「说会推理、却一档都列不出来」这种自相矛盾。
 *
 * 默认取「否」而不是「是」，因为两边猜错的代价不对称：漏标只是输入框里的
 * 「思考程度」对它不起作用；错标则是给一个不会思考的模型发思考预算，
 * 厂商多半直接回 400，整条对话发不出去。
 */
function reasoningFor(provider: ProviderConfig, model: ModelConfig): boolean {
  return (
    model.supportsReasoning ??
    builtinModel(provider, model)?.reasoning ??
    catalogModel(provider, model)?.supportsReasoning ??
    false
  )
}

/**
 * 这个 Claude 走不走「自适应思考」。
 *
 * 决定的是**请求形状**：标了就发 `thinking: {type: "adaptive"}` +
 * `output_config.effort`，不标就发老式的 `budget_tokens`。
 *
 * 这一位不标就等于把 `xhigh` / `max` 悄悄废掉 —— 预算那条路的档位表只到 high
 * （pi 的 `clampReasoning` 把 xhigh 和 max 一起夹成 high），于是界面上列着最高两档、
 * 选了也不报错，发出去的请求却和 high 一模一样。用户能看见的只有「最高档没用」。
 *
 * 三档回落：models.json 里用户自己填的 → 我们的目录 → pi 自带目录。
 * 与 `thinkingLevelMapFor` 同一套顺序，而且必须同一套：这一位和档位阶梯
 * 描述的是同一件事的两半（列哪几档 / 用什么形状把它发出去），
 * 两处取自不同记录就会出现「列了 max、却按预算发」这种自相矛盾。
 *
 * 我们的目录兜底 pi 快照还没收录的新型号（比如 Claude Fable 5.1）。
 */
function adaptiveThinkingFor(provider: ProviderConfig, model: ModelConfig): boolean {
  return (
    model.adaptiveThinking ??
    catalogModel(provider, model)?.adaptiveThinking ??
    builtinAdaptiveThinking(provider, model) ??
    false
  )
}

/**
 * pi 自带目录里那条记录标没标自适应思考。
 *
 * `compat` 在 pi 的类型里是按协议分的联合，`forceAdaptiveThinking` 只长在
 * Anthropic 那一支上 —— 用 `in` 收窄而不是断言，这样哪天 pi 把这一位挪走，
 * 是类型检查先炸，而不是运行时静默取到 undefined、Claude 悄悄退回预算那条路。
 */
function builtinAdaptiveThinking(
  provider: ProviderConfig,
  model: ModelConfig
): boolean | undefined {
  const compat = builtinModel(provider, model)?.compat
  return compat && 'forceAdaptiveThinking' in compat ? compat.forceAdaptiveThinking : undefined
}

/**
 * 系统提示词发成 `system` 还是 `developer`。
 *
 * `developer` 是 OpenAI 在 o1 那代自己造的角色名，只有它家端点认。pi 的自动
 * 探测是「按 baseUrl 认出几家已知不认的，其余一律当认」—— 名单里没有的厂商
 * （百炼 / DashScope 就是其中之一）会被当成 OpenAI，只要模型标了会推理，
 * 系统提示词就发成 `developer`，对面直接 400：
 *   `developer is not one of ['system','assistant','user','tool','function']`
 *
 * 我们统一按 `system` 发。这是取值范围最广的那个：OpenAI 现役型号（GPT-5 /
 * gpt-4o 一路）至今仍然接受 `system`，而 `developer` 在别家基本没人认。
 * 只有早已下线的 o1-preview / o1-mini 是反过来的，为它们保留探测不值得。
 *
 * 写死成名单的反面（「只有这几家发 system」）会随着新厂商不断腐坏 ——
 * 每加一家国产云或自建网关就要有人记得来补一条，漏了就是一次 400。
 * 反过来钉死则不需要维护：以后新增的 OpenAI 兼容端点自动是对的。
 *
 * codex-responses 不在此列：那条路只连 OpenAI 自己，沿用 pi 的默认。
 */
const SYSTEM_ROLE_PROTOCOLS: ReadonlySet<ProviderProtocol> = new Set([
  'openai-completions',
  'openai-responses'
])

/**
 * 几家「OpenAI 兼容，但字段名不一样」的端点。
 *
 * pi 的自动探测（`detectCompat`）认的是它自己收录过的厂商，按 baseUrl 匹配；
 * 国产云里只有 DeepSeek、智谱、Moonshot 在名单上。名单外的一律按 **OpenAI 原样**
 * 处理，而这几家的差异恰恰是「发出去就报错」的那种：
 *
 * - **`max_tokens` vs `max_completion_tokens`**：讯飞的文档里只有前者。
 *   pi 对未知端点默认发后者，于是我们设的输出上限根本没生效 ——
 *   而这**不报错**，只是模型可能一口气写到自己的上限
 * - **`store`**：这是 OpenAI 独有的「把这次补全存在服务端」开关。pi 发的是
 *   `store: false`，也就是各家的默认行为 —— 少发它一点不丢，多发它在
 *   严格校验参数的端点上就是一次 400。两家的文档里都没有这个字段
 *
 * 按 **baseUrl** 匹配而不是 provider id：用户可以给同一家配任意的 id
 * （加第二个 OpenAI 时那个 id 就变成了 `openai-2`），id 靠不住。
 *
 * 加一家新的要先去看它的官方参数表，不要凭「感觉它像 OpenAI」。
 */
const ENDPOINT_QUIRKS: readonly {
  match: RegExp
  compat: NonNullable<Model<Api>['compat']>
}[] = [
  {
    /*
     * 讯飞星火（通用 /v1 与深度推理 /x2 都在这个域名下）。
     *
     * **这一家已经不在内置目录里了** —— 别看到「目录里没有」就把这条删掉。
     *
     * 这张表按 baseUrl 匹配，管的是「谁指向这个域名」，不是「我们推荐谁」。
     * 讯飞从推荐位下架之后，仍然可能有人手动配一条指过去（老用户的
     * models.json 里那条也还在跑）。删了这条的后果是**静默的**：
     * pi 会发 `max_completion_tokens`，而讯飞只认 `max_tokens`，
     * 于是设的输出上限根本不生效，不报错，只是模型可能一口气写到自己的上限。
     */
    match: /spark-api-open\.xf-yun\.com/i,
    compat: { maxTokensField: 'max_tokens', supportsStore: false }
  },
  {
    // 火山方舟。输出上限它自己用的就是 max_completion_tokens（新一代要求如此），
    // 与 pi 的默认一致，所以这里只关掉 store
    match: /ark\.[a-z-]+\.volces\.com/i,
    compat: { supportsStore: false }
  }
]

function compatFor(provider: ProviderConfig, model: ModelConfig): Model<Api>['compat'] {
  /*
   * 自适应思考只有 Anthropic 那条路读得懂（`anthropic-messages` 与 Bedrock 的
   * converse）。按协议关门而不是「反正别家不看这一位」—— 让它跟着别的协议流出去，
   * 下次换个内核版本就可能被当成别的意思。
   */
  const adaptive =
    provider.protocol === 'anthropic-messages' && adaptiveThinkingFor(provider, model)
      ? { forceAdaptiveThinking: true }
      : undefined

  if (!SYSTEM_ROLE_PROTOCOLS.has(provider.protocol)) return adaptive
  const quirk = ENDPOINT_QUIRKS.find((item) => item.match.test(provider.baseUrl))
  return { supportsDeveloperRole: false, ...(quirk?.compat ?? {}) }
}

/** ProviderConfig + ModelConfig → pi-ai Model */
export function toPiModel(provider: ProviderConfig, model: ModelConfig): Model<Api> {
  const limits = limitsFor(provider, model)
  const thinkingLevelMap = thinkingLevelMapFor(provider, model)
  const compat = compatFor(provider, model)

  return {
    id: model.id,
    name: model.displayName || model.id,
    api: provider.protocol,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    // 为 false 时 pi 会把任何思考档位一律夹成 "off"，也就是输入框里的
    // 「思考程度」对它完全不起作用 —— 所以这一位必须如实标，见 reasoningFor。
    reasoning: reasoningFor(provider, model),
    // 这张表决定了输入框里到底列出哪几档。缺了它内核只能按缺省行为猜，
    // 会列出模型没有的档位、又漏掉它真有的（见 thinkingLevelMapFor）。
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: model.supportsVision ? ['text', 'image'] : ['text'],
    // 本地推理没有计费，云端厂商的实时价格我们也不跟踪 —— 一律 0，
    // 让 UI 不显示误导性的成本数字。
    cost: { ...ZERO_COST },
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    ...(compat ? { compat } : {}),
    ...(provider.headers ? { headers: provider.headers } : {})
  }
}

/**
 * 把一个 ProviderConfig 包成 pi Provider。
 *
 * 密钥解析桥回 `src/main/ai/credentials`：literal（safeStorage 加密）、env、
 * shell 取密、oauth 续期四种形态全部沿用，pi 这边不重复实现一套。
 */
export function toPiProvider(config: ProviderConfig): Provider<Api> {
  const models = config.models.map((model) => toPiModel(config, model))

  return createProvider<Api>({
    id: config.id,
    name: config.displayName,
    baseUrl: config.baseUrl,
    ...(config.headers ? { headers: config.headers } : {}),
    models,
    auth: {
      apiKey: {
        name: `${config.displayName} API key`,
        // 凭据的真正来源是我们自己的 credentials 模块，不是 pi 的 CredentialStore。
        // 这里忽略传入的 credential，直接按 ProviderConfig 上的引用去取。
        resolve: async () => {
          const apiKey = await resolveApiKey(config.apiKey)
          return {
            auth: {
              // 本机推理（Ollama / LM Studio）不校验密钥，但有些客户端要求非空。
              apiKey: apiKey || 'not-required',
              ...(config.headers ? { headers: config.headers } : {})
            },
            source: describeKeySource(config)
          }
        }
      }
    },
    // 单 provider 可能混用多种协议（比如 OpenAI 同时有 completions 和 responses），
    // 用 map 形态按 model.api 分派，以后放开混用不用改这里。
    api: { [config.protocol]: API_IMPL[config.protocol]() } as Partial<Record<Api, ProviderStreams>>
  })
}

/** 给状态 UI 用的密钥来源描述，不含密钥本身 */
function describeKeySource(config: ProviderConfig): string {
  switch (config.apiKey.kind) {
    case 'env':
      return config.apiKey.name
    case 'shell':
      return 'shell'
    case 'oauth':
      return `OAuth (${config.apiKey.provider})`
    case 'literal':
      return '已保存的密钥'
    case 'none':
    default:
      return '无需密钥'
  }
}
