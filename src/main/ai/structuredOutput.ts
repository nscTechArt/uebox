/**
 * 结构化输出：能力表 + 兜底降级。
 *
 * 调用点（追问建议、笔记标题、知识库 Studio 的六类产出）说的是「我要一份符合
 * 这个 schema 的 JSON」，用的是 OpenAI 的 `response_format` 词汇。但各家认这个
 * 字段的程度不一样，而且**认不认是硬规则**：DeepSeek 只认 `json_object`，
 * 给它 `json_schema` 是一句 400 `This response_format type is unavailable now`。
 *
 * 以前这里是原样透传，于是配了 DeepSeek 的用户每次都白挨一个 400，追问建议
 * 恒为空 —— 而且**界面上什么都不显示**，只有控制台里有一行 error。
 *
 * 现在两层：
 *
 * 1. **能力表**（`resolveStructuredOutputApi`）—— 已知的厂商硬规则，发之前就降好档。
 * 2. **兜底降级**（`runWithStructuredOutput`）—— 表总会过期（新厂商、聚合网关、
 *    用户自建代理），所以真挨了这一类 400 就自动降一档重来，并把结论记住，
 *    同一次运行里不再撞第二回。
 *
 * 降档不是放弃约束：拿不到 `json_schema` 时把 schema 原文写进系统提示词
 * （`systemHint`），模型照样回得出可解析的 JSON，渲染层那边本来就是宽容解析。
 * 这句提示词还顺带解决 DeepSeek 的第二条硬规则 —— 用 `json_object` 时提示词里
 * **必须出现 “json” 这个词**，否则又是一句 400。
 *
 * @see https://api-docs.deepseek.com/guides/json_mode
 */

import type { ProviderConfig, StructuredOutputApi } from './types'

/** 渲染层提的要求，沿用 OpenAI 的 `response_format` 词汇 */
export type ResponseFormatRequest =
  | 'text'
  | 'json_object'
  | {
      type: 'json_object' | 'json_schema'
      json_schema?: {
        name?: string
        strict?: boolean
        schema?: Record<string, unknown>
      }
    }

/** 这次调用实际怎么发 */
export interface StructuredOutputPlan {
  /** 按这一档发的 */
  api: StructuredOutputApi
  /** 并进请求体的字段。这一档发不了 `response_format` 时没有 */
  samplingParams?: Record<string, unknown>
  /** 降档后补进系统提示词的那句话。没降档就没有 */
  systemHint?: string
}

/**
 * 本次运行学到的能力，键是 `providerId::modelId`。
 *
 * 只在内存里：models.json 是用户的文件，不该被我们按一次报错悄悄改写
 * （用户换了个后端、厂商补上了支持，落盘的结论就成了永久的错）。
 * 重启重新学一次的代价只是一个 400。
 */
const learned = new Map<string, StructuredOutputApi>()

function learnedKey(provider: ProviderConfig, modelId: string): string {
  return `${provider.id}::${modelId}`
}

/**
 * 只认厂商的**硬规则**，不猜可选行为 —— 与 imageGeneration 的 `guessImageApi`
 * 同一条边界。
 *
 * DeepSeek 是目前唯一一条：官方文档只有 json_object 一种模式。名字带斜杠的
 * 前缀是因为聚合网关会加厂商前缀（`deepseek/deepseek-chat`、
 * `deepseek-ai/DeepSeek-V3`）—— 那些网关多半也只是原样转发给 DeepSeek，
 * 猜错的代价也只是少一层强约束，而不是整次调用失败。
 */
function guessStructuredOutputApi(provider: ProviderConfig, modelId: string): StructuredOutputApi {
  const isDeepSeek = /api\.deepseek\.com/i.test(provider.baseUrl) || /(^|\/)deepseek/i.test(modelId)
  return isDeepSeek ? 'json-object' : 'json-schema'
}

/**
 * 这个模型走哪一档。三级：模型自己声明的 > 本次运行学到的 > 按厂商硬规则猜。
 *
 * 声明排在最前面是因为它是用户/内置目录明确写下的事实；学到的排在猜的前面，
 * 是因为它来自厂商的真实回答。
 */
export function resolveStructuredOutputApi(
  provider: ProviderConfig,
  modelId: string
): StructuredOutputApi {
  const declared = provider.models.find((model) => model.id === modelId)?.structuredOutputApi
  if (declared) return declared
  return learned.get(learnedKey(provider, modelId)) ?? guessStructuredOutputApi(provider, modelId)
}

/** 降一档。已经在最底下（完全不发）时返回 undefined，调用方据此放弃重试 */
export function degradeStructuredOutputApi(
  api: StructuredOutputApi
): StructuredOutputApi | undefined {
  if (api === 'json-schema') return 'json-object'
  if (api === 'json-object') return 'none'
  return undefined
}

/**
 * 这句报错是不是「这个 `response_format` 我不认」。
 *
 * 只按报错文本判断 —— 内核把厂商的响应体原样带在 message 里，而各家的错误码
 * 反倒五花八门（DeepSeek 是 `invalid_request_error`，聚合网关常常原样转发
 * 上游的一段 JSON）。宁可漏判：漏判只是不重试、和降级之前一样；误判则会拿一次
 * 无关的失败去做一次没有意义的重试，多花一次 token。
 */
export function isStructuredOutputRejection(message: string): boolean {
  if (!/response[_\s-]?format|json[_\s-]?schema|structured\s*output/i.test(message)) return false
  return /unavailable|unsupported|not\s+support|unknown|invalid|unrecognized|must\s+contain|不支持|无效/i.test(
    message
  )
}

/** 把 schema 写成一句提示词。降档之后模型只剩这一个约束来源 */
function systemHintFor(format: ResponseFormatRequest): string {
  const schema = typeof format === 'object' ? format.json_schema?.schema : undefined
  const base =
    'Output json only: a single JSON object, no prose and no markdown fences. ' +
    'The response must parse with JSON.parse.'
  return schema ? `${base}\nIt must match this JSON Schema:\n${JSON.stringify(schema)}` : base
}

/** 渲染层的简写补成完整形状：`'json_object'` → `{ type: 'json_object' }` */
function fullFormat(format: ResponseFormatRequest): Record<string, unknown> {
  return typeof format === 'string' ? { type: format } : (format as Record<string, unknown>)
}

/** 这一档下，这次要求该怎么发 */
export function planStructuredOutput(
  format: ResponseFormatRequest | undefined,
  api: StructuredOutputApi
): StructuredOutputPlan {
  // `text` 是「随便回」，本来就不是结构化输出的要求，不发也不提示
  if (!format || format === 'text') return { api }

  // 这个字段发过去只会挨 400，约束只能靠提示词
  if (api === 'none') return { api, systemHint: systemHintFor(format) }

  if (api === 'json-object') {
    return {
      api,
      samplingParams: { response_format: { type: 'json_object' } },
      // 这一档的厂商还有第二条硬规则：提示词里**必须出现 “json”**，否则同样 400。
      // 这句话顺带满足它 —— 用户要的是 schema 时，它还兼作唯一的格式约束
      systemHint: systemHintFor(format)
    }
  }

  return { api, samplingParams: { response_format: fullFormat(format) } }
}

/** 把降档补偿的那句话接到系统提示词后面。原本没有系统提示词时它自己就是 */
export function withSystemHint(
  system: string | undefined,
  plan: StructuredOutputPlan
): string | undefined {
  if (!plan.systemHint) return system
  return system ? `${system}\n\n${plan.systemHint}` : plan.systemHint
}

export interface StructuredOutputRunOptions {
  /**
   * 现在还能不能重来。
   *
   * 流式那条路要用：一旦有增量发给了渲染层，重试就会让用户看到同一段话被接了
   * 两遍 —— 那比少一层格式约束糟得多。
   */
  canRetry?: () => boolean
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 按能力表发一次；被厂商以「不认这个 response_format」拒掉就降一档重来。
 *
 * 最多降两次（json-schema → json-object → 不发），每一档都真发过一次才往下走 ——
 * 能力表可能过期，但厂商的回答不会。
 */
export async function runWithStructuredOutput<T>(
  binding: { provider: ProviderConfig; modelId: string },
  format: ResponseFormatRequest | undefined,
  run: (plan: StructuredOutputPlan) => Promise<T>,
  options: StructuredOutputRunOptions = {}
): Promise<T> {
  let api = resolveStructuredOutputApi(binding.provider, binding.modelId)

  for (;;) {
    const plan = planStructuredOutput(format, api)
    try {
      return await run(plan)
    } catch (error) {
      const next = degradeStructuredOutputApi(api)
      if (
        next === undefined ||
        plan.samplingParams === undefined ||
        options.canRetry?.() === false ||
        !isStructuredOutputRejection(describeError(error))
      ) {
        throw error
      }

      // 厂商刚亲口说了它不认这一档，记下来 —— 同一次运行里的下一次调用直接从
      // 降好的档开始，不再白挨一个 400
      learned.set(learnedKey(binding.provider, binding.modelId), next)
      api = next
    }
  }
}

/** 只给测试用：清掉本次运行学到的能力，让用例之间不互相影响 */
export function resetLearnedStructuredOutput(): void {
  learned.clear()
}
