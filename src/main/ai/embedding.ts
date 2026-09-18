import { resolveApiKey } from './credentials'
import { readSettings } from './store'
import { ModelNotConfiguredError } from './resolveModel'
import type { ModelConfig, ProviderConfig } from './types'
import type { EmbeddingApi } from '../../shared/aiProvider'

/**
 * 本地直连的文本向量化。
 *
 * 知识库检索靠它。此前统一走官方网关上的 Jina 向量化代理，
 * 社区版没有服务端，等于这个功能整个是坏的 ——
 * 而且坏得很隐蔽：建库、灌文档都正常，只有检索悄悄失效。
 *
 * 现在改成走用户自己配的 Provider。选 `/embeddings` 这个接口是因为它是
 * **事实标准**：Ollama、LM Studio、OpenAI、阿里云百炼、硅基流动、
 * LiteLLM、One API 全都实现了同一份请求/响应格式，目录里 39 家厂商
 * 绝大多数开箱可用。
 *
 * 想完全离线零成本的话，用 Ollama 拉一个 `nomic-embed-text` 或 `bge-m3`
 * 就行，不需要任何密钥。
 */

/** 一次请求最多送多少条文本，避免超过厂商的 body 上限 */
const BATCH_SIZE = 64

/** 向量化通常比对话慢，给宽一点 */
const REQUEST_TIMEOUT_MS = 120_000

export class EmbeddingNotConfiguredError extends ModelNotConfiguredError {
  constructor() {
    super(
      '知识库检索需要一个「嵌入」模型。到 设置 → 模型，' +
        '在「向量化」分组里挑一家（Jina、OpenAI、硅基流动、百炼、智谱、Voyage 都已内置），' +
        '再把它的模型绑给「嵌入」角色。' +
        '想完全本地免费就选「Ollama（本机向量化）」—— 先 `ollama pull bge-m3`，' +
        '不需要任何密钥，也不产生费用。',
      'embedding'
    )
    this.name = 'EmbeddingNotConfiguredError'
  }
}

interface EmbeddingsApiResponse {
  data?: Array<{ index?: number; embedding?: number[] }>
  error?: { message?: string } | string
  message?: string
}

/**
 * 这段文本是**要存进库的文档**还是**用来搜的查询**。
 *
 * 对 OpenAI 那类对称模型没有区别；对 Jina v3/v4 与 Voyage 这类非对称检索模型
 * 是两个不同的向量空间，用错一边**不报错**，只是召回明显变差 ——
 * 所以调用方必须显式说清楚，这里不给默认值以外的猜测。
 */
export type EmbeddingTask = 'document' | 'query'

/** 取当前绑定的嵌入 Provider 与模型。没配就抛 */
async function resolveEmbeddingBinding(): Promise<{
  provider: ProviderConfig
  modelId: string
  model?: ModelConfig
}> {
  const settings = await readSettings()
  // 嵌入角色**不参与回落**：把对话模型顶上来只会拿到一句看不懂的厂商报错
  const binding = settings.roles.embedding
  if (!binding) throw new EmbeddingNotConfiguredError()

  const provider = settings.providers.find((item) => item.id === binding.providerId)
  if (!provider) throw new EmbeddingNotConfiguredError()

  // 模型条目可能不在清单里（用户手改过 models.json），那种情况按缺省形状走，
  // 不该因为「清单里查不到」就整个不能用
  const model = provider.models.find((item) => item.id === binding.modelId)

  return { provider, modelId: binding.modelId, model }
}

/**
 * 按接口形状补上厂商特有的参数。
 *
 * 只有一处真差异：**要不要告诉厂商「这段是文档还是查询」**。
 * 各家的字段名不一样，值也不一样，所以按形状分派而不是在调用处写 if。
 */
export function buildEmbeddingPayload(options: {
  modelId: string
  inputs: string[]
  task: EmbeddingTask
  api?: EmbeddingApi
  dimensions?: number
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: options.modelId,
    input: options.inputs
  }

  // 支持降维的模型（OpenAI v3、Jina v3/v4）显式发一下，保证同一个模型在不同
  // 机器上产出的维度一致 —— 不发的话厂商可能按账号默认值给，两台机器对不上
  if (typeof options.dimensions === 'number' && options.dimensions > 0) {
    payload.dimensions = options.dimensions
  }

  switch (options.api) {
    case 'jina-embeddings':
      payload.task = options.task === 'query' ? 'retrieval.query' : 'retrieval.passage'
      break
    case 'voyage-embeddings':
      payload.input_type = options.task === 'query' ? 'query' : 'document'
      break
    default:
      // openai-embeddings 与所有未标注的模型：没有这个概念，不发
      break
  }

  return payload
}

function extractErrorMessage(body: EmbeddingsApiResponse | null, status: number): string {
  if (typeof body?.error === 'string') return body.error
  if (body?.error?.message) return body.error.message
  if (body?.message) return body.message
  return `向量化失败：HTTP ${status || '?'}`
}

/** 拼出 /embeddings 的完整地址。baseUrl 末尾有没有斜杠都得对 */
function embeddingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/embeddings`
}

/**
 * 对**显式给定的** provider 发一次 /embeddings 请求，返回与 inputs 等长的向量数组。
 *
 * 不查角色绑定 —— `embedTexts` 传入的是绑定解析结果，「测试连接」传入的是
 * **还没存盘的草稿配置**，走绑定只会拿到上一个已保存的 Provider。
 *
 * @throws 厂商返回非 2xx 或响应缺向量时，message 是可直接显示给用户的中文
 */
export async function requestEmbeddings(
  provider: ProviderConfig,
  modelId: string,
  inputs: string[],
  task: EmbeddingTask,
  model?: ModelConfig,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<number[][]> {
  const apiKey = await resolveApiKey(provider.apiKey)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(embeddingsUrl(provider.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 本机推理（Ollama / LM Studio）不需要密钥，此时不要带空的 Authorization
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(provider.headers ?? {})
      },
      body: JSON.stringify(
        buildEmbeddingPayload({
          modelId,
          inputs,
          task,
          api: model?.embeddingApi,
          dimensions: model?.embeddingDimensions
        })
      ),
      signal: controller.signal
    })

    let body: EmbeddingsApiResponse | null = null
    try {
      body = (await response.json()) as EmbeddingsApiResponse
    } catch {
      body = null
    }

    if (!response.ok || !Array.isArray(body?.data)) {
      throw new Error(extractErrorMessage(body, response.status))
    }

    // 按 index 回填。多数厂商按顺序返回，但协议允许乱序，依赖顺序会静默串行。
    const out: number[][] = new Array(inputs.length)
    body.data.forEach((item, position) => {
      const index = typeof item.index === 'number' ? item.index : position
      if (Array.isArray(item.embedding)) out[index] = item.embedding
    })

    const missing = out.findIndex((vector) => !Array.isArray(vector))
    if (missing !== -1) {
      throw new Error(`向量化结果缺少第 ${missing} 条，厂商返回的条数与请求不一致`)
    }

    return out
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取文本向量，顺序与入参一一对应。
 *
 * @throws {EmbeddingNotConfiguredError} 没有绑定嵌入模型
 * @throws {MissingApiKeyError} 绑定存在但密钥取不到
 */
export async function embedTexts(
  inputs: string[],
  task: EmbeddingTask = 'document'
): Promise<number[][]> {
  if (!inputs.length) return []

  const { provider, modelId, model } = await resolveEmbeddingBinding()

  const results: number[][] = []
  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)
    results.push(...(await requestEmbeddings(provider, modelId, batch, task, model)))
  }
  return results
}

/**
 * 取**查询**文本的向量。检索时用这个，不要用 embedTexts。
 *
 * 单拎一个函数而不是让调用方记得传第二个参数：非对称检索模型上传错了不会报错，
 * 只是搜不准 —— 这种错误在代码审查里几乎看不出来，在运行时也没有任何信号。
 */
export async function embedQuery(query: string): Promise<number[]> {
  const [vector] = await embedTexts([query], 'query')
  return vector ?? []
}

/**
 * 嵌入能力是否已配置。界面据此决定显示知识库还是显示引导。
 *
 * 只看有没有绑定，**不发请求** —— 这个函数会被频繁调用（每次打开知识库、
 * 每次向量化前），真去 ping 一次厂商会把它变成一个隐形的性能与流量问题。
 */
export async function isEmbeddingConfigured(): Promise<boolean> {
  try {
    const settings = await readSettings()
    const binding = settings.roles.embedding
    if (!binding) return false
    return settings.providers.some((item) => item.id === binding.providerId)
  } catch {
    return false
  }
}

/**
 * 当前嵌入模型的标识，形如 `ollama:nomic-embed-text`。
 *
 * 存进向量表用来判断「这批向量是不是当前模型产出的」。换了嵌入模型后
 * 维度和语义空间都变了，旧向量必须重建 —— 没有这个标识就只能靠维度判断，
 * 而两个不同模型完全可能维度相同（都是 1024），那种情况下检索会**悄悄**
 * 给出乱七八糟的结果。
 */
export async function getEmbeddingModelTag(): Promise<string | null> {
  const settings = await readSettings()
  const binding = settings.roles.embedding
  return binding ? `${binding.providerId}:${binding.modelId}` : null
}
