/**
 * 结构化判定（System One / TypeSafe Jev）。
 *
 * ## 这是什么
 *
 * 发一份 state 和一组**带类型的问题**，拿回每个问题的答案加一个概率分布。
 * 它不生成文本、不调工具、不对话 —— 只回答你写死在代码里的那几个问题：
 *
 *   noul   「这句话成立吗」        → 0~1 的概率
 *   choice 「选哪个」（≤255 项）   → 选中项 + 每项概率 + confidence
 *   score  「哪一档」（2~10 档）   → 档位 + 分布 + confidence
 *
 * 一次调用约 100ms，输入 $0.042/M token，输出不计费，而且**同一份 state 下
 * 多问几个问题几乎不加钱**（并行评估，只有问题本身的 token）。这两条合起来
 * 才是它的用法：判断可以放进热路径，像 `if` 一样用。
 *
 * ## 为什么值得单开一档 Provider
 *
 * V3 现在每一处需要「判断」的地方都只有两个选项：写一条确定性规则，或者
 * 花一次 8 秒的模型往返。于是我们一路选了前者 —— `searchRelevance` 只比字面
 * 重合、`loopBreaker` 按 `JSON.stringify(args)` 精确匹配、`approval` 只看三档
 * 静态风险。这些选择当时都对，理由全都是同一个：模型调用塞不进热路径。
 *
 * 这一档把那个前提拿掉了。判定是**代码在做决定**，模型只提供一个带校准概率的
 * 输入值。
 *
 * ## 三条硬约束，改这个文件之前先读
 *
 * 1. **没配置不是错误。** `judge()` 永远不抛，拿不到判定器就回 null，调用方
 *    退回自己原来那条确定性规则。社区版承诺不依赖官方服务器、本机模型不出
 *    机器 —— 这一档只有云端 API，所以它必须是「有更好，没有照常跑」的形状。
 *    任何让功能在未配置时失效的写法都是错的。
 *
 * 2. **「不会幻觉」不等于「不会错」。** 它保证答案落在你给的 schema 内，
 *    不保证答案对；校准也只在群体意义上成立（90% 那批里约 90% 对），
 *    不保证手上这一条对。所以答案只能当**输入**，不能当结论 ——
 *    高风险分支必须要么只允许往更保守的方向偏，要么再压一道确定性规则。
 *
 * 3. **中文不如英文准。** 厂商明说 CJK 支持但可靠性低于英文。`instructions`
 *    和 `criteria` 是我们自己写的，一律用英文（不面向用户，不需要翻译）；
 *    state 里的中文躲不掉，所以每条判据上线前都得拿真实中文数据测过。
 *
 * ## 已知短板（厂商自己列的）
 *
 * 读得极其字面（否定词、隐含条件按字面算）、不会数数、把日期当文本、
 * state 里无关内容越多越不准、对抗性文本能把它带偏。
 * 对应到写法：问题要原子、判据要写全边界、**state 先在代码里筛干净再发**。
 *
 * @see https://docs.typesafe.ai/api
 * @see https://docs.typesafe.ai/model-jaggedness/jev-1.13
 */

import { isPlanProvider } from '../../shared/creatorPlan'
import { planCallError } from './creatorPlan/callError'
import { resolveApiKey } from './credentials'
import { readSettings } from './store'
import type { ProviderConfig } from './types'

/** TypeSafe 的评估端点。baseUrl 存到 `/v1` 为止，路径在这里拼 */
const SYSTEM_ONE_PATH = '/systemone'

/**
 * 默认超时。
 *
 * 厂商标称 70–500ms。给到 4 秒不是留余量给慢请求，是**留给失败**：
 * 判定挂在工具执行的热路径上，它卡住一秒就是 agent 卡住一秒，而它的结果
 * 本来就是可有可无的。宁可超时走回落，也不要让一个可选增强拖住主流程。
 */
const DEFAULT_TIMEOUT_MS = 4_000

/**
 * 请求体的字符上限。
 *
 * 厂商的硬限制是 64k token（state + 全部问题），state 加最长的那个问题
 * 另有 32k 的限制。这里按**字符**卡一道更保守的线，理由是两条：
 *
 * - CJK 大约 1~1.5 字符一个 token，按最坏情况折算 64k token ≈ 64k 字符；
 * - 更要紧的是 jaggedness 里那条「state 越大越不准」—— 逼近上限的请求
 *   即使发得出去，答案也已经不可信了。
 *
 * 超限**在本地就回落**，不发出去换一个 400：那次往返既花时间又没有信息。
 */
const MAX_PAYLOAD_CHARS = 48_000

/** 是非题。返回「是」的概率 */
export interface NoulQuestion {
  type: 'noul'
  instructions: string | Record<string, unknown> | unknown[]
  /** 可选：说清「是」和「否」分别指什么。边界case写在这里比写进 instructions 准 */
  criteria?: { true?: string; false?: string }
}

/** 多选题。最多 255 个选项 */
export interface ChoiceQuestion {
  type: 'choice'
  instructions: string | Record<string, unknown> | unknown[]
  /** 选项 → 该选项的说明。不需要额外说明时给 null */
  criteria: Record<string, string | null>
}

/** 评分题。criteria 是**有序**的档位描述，2~10 档 */
export interface ScoreQuestion {
  type: 'score'
  instructions: string | Record<string, unknown> | unknown[]
  criteria: string[]
}

export type JudgeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulAnswer {
  type: 'noul'
  /** 0（否）到 1（是） */
  noul: number
}

export interface ChoiceAnswer {
  type: 'choice'
  /** 概率最高的那个选项 */
  choice: string
  probabilities: Record<string, number>
  /** 分布有多集中。0~1，越高越笃定。见 https://docs.typesafe.ai/confidence */
  confidence: number
}

export interface ScoreAnswer {
  type: 'score'
  /**
   * **期望档位**（小数）：Σ 档位下标 × 概率。TypeSafe 原样回的就是它。
   *
   * Box Plan 的 `score.value` 不是它 —— 那是**概率最大的档位下标**（整数），
   * 放在 `level` 上；这里按它回的 `probabilities` 数组重新算出期望值，两家的阈值才是
   * 同一个意思。例：分布 [0.45, 0.10, 0.45] 期望 1.0、`level` 是 0，
   * 「至少第 2 档」写 `score >= 1.5` 和写 `level >= 2` 结论不同，按后果挑一个。
   */
  score: number
  /** 概率最大的档位下标（从 0 开始）。拿不到分布时没有 */
  level?: number
  /** 档位下标（字符串）→ 概率 */
  probabilities: Record<string, number>
  confidence: number
}

export type JudgeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** 问题 id → 答案。id 是调用方自己取的，原样回来 */
export type JudgeAnswers = Record<string, JudgeAnswer>

export interface JudgeUsage {
  input_tokens: number
  output_tokens: number
}

export interface JudgeResult {
  model: string
  answers: JudgeAnswers
  usage?: JudgeUsage
}

/** state 可以是字符串，也可以是结构化数据 —— 后者更好，字段名本身就是线索 */
export type JudgeState = string | Record<string, unknown> | unknown[]

interface SystemOneResponse {
  model?: string
  answers?: Record<string, unknown>
  usage?: JudgeUsage
  error?: { message?: string } | string
  message?: string
}

function extractErrorMessage(body: SystemOneResponse | null, status: number): string {
  const vendor =
    typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message || ''
  // 状态码一定带上：「测试连接」按它分出密钥错、模型不存在、限流 —— 只有厂商那句话的话
  // 401 / 404 / 429 全被归成「未知错误」，用户不知道该往哪查
  return `判定请求失败：HTTP ${status || '?'}${vendor ? ` ${vendor}` : ''}`
}

/** 拼出完整端点。baseUrl 末尾有没有斜杠都得对 */
export function systemOneUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${SYSTEM_ONE_PATH}`
}

/**
 * 判定请求的地址。Box Plan 是 `POST /judge`（协议 09-judge），其余按 TypeSafe 的
 * `/systemone`。按来源 id 分：套餐来源 id 固定以 `creator-plan` 开头（见 creatorPlan/apply.ts）。
 */
export function judgeUrl(provider: Pick<ProviderConfig, 'id' | 'baseUrl'>): string {
  return isPlanProvider(provider.id)
    ? `${provider.baseUrl.replace(/\/+$/, '')}/judge`
    : systemOneUrl(provider.baseUrl)
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value)

/**
 * 我们的问题 → 套餐协议的问题。两处不同：是非题叫 `boolean` 不叫 `noul`；
 * `instructions` 只收字符串（结构化的原样序列化成 JSON 文本）。
 */
export function toPlanQuestions(
  questions: Record<string, JudgeQuestion>
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      {
        ...question,
        type: question.type === 'noul' ? 'boolean' : question.type,
        instructions: asText(question.instructions)
      }
    ])
  )
}

/** 最大值的下标。空数组回 undefined */
function argmax(values: number[]): number | undefined {
  let best: number | undefined
  values.forEach((value, index) => {
    if (best === undefined || value > values[best]) best = index
  })
  return best
}

/**
 * 套餐协议的答案 → 我们的形状。判不了的问题（值为 null）直接不出现 ——
 * 调用方读到 undefined 本来就走「没有判定」那条路。
 *
 * 分数题见 ScoreAnswer 的注释：协议的 `value` 是最可能档位的下标，放到 `level`；
 * `score` 由分布重新算成期望值，与 TypeSafe 那边同义。阈值按期望值写的调用方不用改。
 */
export function fromPlanAnswers(raw: Record<string, unknown>): JudgeAnswers {
  const out: JudgeAnswers = {}
  for (const [id, value] of Object.entries(raw)) {
    const answer = value as Record<string, unknown> | null
    if (!answer || typeof answer !== 'object') continue
    const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0
    if (answer.type === 'boolean') {
      // `probability` 是答「是」的概率，与 noul 同义
      const noul =
        typeof answer.probability === 'number' ? answer.probability : answer.value ? 1 : 0
      out[id] = { type: 'noul', noul }
    } else if (answer.type === 'choice' && typeof answer.value === 'string') {
      out[id] = {
        type: 'choice',
        choice: answer.value,
        probabilities: (answer.probabilities as Record<string, number>) ?? {},
        confidence
      }
    } else if (answer.type === 'score' && typeof answer.value === 'number') {
      const distribution = Array.isArray(answer.probabilities)
        ? (answer.probabilities as unknown[]).map((p) => (typeof p === 'number' ? p : 0))
        : []
      const total = distribution.reduce((sum, p) => sum + p, 0)
      out[id] = {
        type: 'score',
        score:
          total > 0
            ? distribution.reduce((sum, p, index) => sum + index * p, 0) / total
            : answer.value,
        level: answer.value,
        probabilities: Object.fromEntries(distribution.map((p, index) => [String(index), p])),
        confidence
      }
    }
  }
  return out
}

/** TypeSafe 的分数题没有 `level`：分布的键是档位下标时补一个最可能的档位 */
function withLevels(answers: JudgeAnswers): JudgeAnswers {
  for (const answer of Object.values(answers)) {
    if (answer?.type !== 'score' || answer.level !== undefined) continue
    const values: number[] = []
    for (const [key, p] of Object.entries(answer.probabilities ?? {})) {
      const index = Number(key)
      if (Number.isInteger(index) && index >= 0 && typeof p === 'number') values[index] = p
    }
    const best = argmax(Array.from(values, (p) => p ?? -1))
    if (best !== undefined) answer.level = best
  }
  return answers
}

/**
 * 粗算请求体规模。只用来卡 `MAX_PAYLOAD_CHARS`，不需要准。
 *
 * 不引 tokenizer：这条线的作用是「明显超了就别发」，为一个保守的下限
 * 去装一个分词器不划算，而且 tokenizer 本身也不是这家厂商的那个。
 */
export function payloadSize(state: JudgeState, questions: Record<string, JudgeQuestion>): number {
  try {
    return JSON.stringify(state).length + JSON.stringify(questions).length
  } catch {
    // 循环引用之类。算不出来就当它超限 —— 序列化不了的东西本来也发不出去
    return Number.POSITIVE_INFINITY
  }
}

/** 超出厂商上限的请求不发。导出仅为可测 */
export function payloadTooLarge(
  state: JudgeState,
  questions: Record<string, JudgeQuestion>
): boolean {
  return payloadSize(state, questions) > MAX_PAYLOAD_CHARS
}

/**
 * 对**显式给定的** provider 发一次判定请求。
 *
 * 不查角色绑定 —— 「测试连接」传进来的是还没存盘的草稿配置，走绑定只会拿到
 * 上一个已保存的 Provider。这一点与 `requestEmbeddings` 是同一个理由。
 *
 * 这个函数**会抛**（探测需要看到失败原因）。热路径请用 `judge()`。
 *
 * @throws 厂商返回非 2xx、响应缺 answers、或超时
 */
export async function requestJudgement(
  provider: ProviderConfig,
  modelId: string,
  state: JudgeState,
  questions: Record<string, JudgeQuestion>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<JudgeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  /*
   * 调用方自己的取消（agent 被打断）要能穿透下来，否则一次判定会拖着
   * 整轮已经被取消的执行不放。
   *
   * **这三行必须在 `await resolveApiKey` 之前。** 取密钥是异步的（env 读、
   * shell 取、oauth 续期），把订阅放在它后面的话，这段时间里发生的 abort
   * 事件已经派发完了 —— 再挂监听永远等不到，请求照发。
   */
  const onAbort = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const apiKey = await resolveApiKey(provider.apiKey)

    const plan = isPlanProvider(provider.id)
    const response = await fetch(judgeUrl(provider), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(provider.headers ?? {})
      },
      // 套餐协议的 state 只收纯文本（≤ 48000 字符），结构化的序列化成 JSON 文本发
      body: JSON.stringify(
        plan
          ? { model: modelId, state: asText(state), questions: toPlanQuestions(questions) }
          : { model: modelId, state, questions }
      ),
      signal: controller.signal
    })

    let body: SystemOneResponse | null = null
    try {
      body = (await response.json()) as SystemOneResponse
    } catch {
      body = null
    }

    if (!response.ok || !body?.answers || typeof body.answers !== 'object') {
      const planError = plan ? planCallError(response.status, body, response.headers) : null
      if (planError) throw planError
      throw new Error(extractErrorMessage(body, response.status))
    }

    return {
      model: typeof body.model === 'string' ? body.model : modelId,
      answers: plan ? fromPlanAnswers(body.answers) : withLevels(body.answers as JudgeAnswers),
      usage: body.usage
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 取当前绑定的判定 Provider 与模型。没绑就是 null —— 不抛 */
export async function resolveJudgeBinding(): Promise<{
  provider: ProviderConfig
  modelId: string
} | null> {
  const settings = await readSettings()
  // 判定角色不参与回落：拿对话模型顶上来打的是一个不存在的端点
  const binding = settings.roles.judge
  if (!binding) return null

  const provider = settings.providers.find((item) => item.id === binding.providerId)
  if (!provider) return null

  return { provider, modelId: binding.modelId }
}

/** 当前有没有可用的判定器。调用方用它决定要不要费力去组 state */
export async function judgeAvailable(): Promise<boolean> {
  return (await resolveJudgeBinding()) !== null
}

export interface JudgeOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** 失败时的去向。默认 console.warn（主进程里进 electron-log），调用方可以换成自己的 logger */
  onError?: (error: unknown) => void
}

/**
 * 热路径上的判定。**永远不抛，失败一律返回 null。**
 *
 * 这条契约是整个模块的地基，不是防御性编程：调用方拿到 null 时走的是自己
 * 原来那条确定性规则，那条路径本来就是完整的。把异常抛出去只会让一个可选
 * 增强变成一个新的故障源 —— 用户没配判定器、网断了、厂商限流，这三件事
 * 都不该让 agent 停下来。
 *
 * 返回 null 的四种情况，调用方不需要区分：
 *   1. 没绑判定模型（最常见 —— 默认就是这个）
 *   2. 请求体超限（state 没筛干净）
 *   3. 网络失败 / 超时 / 厂商报错
 *   4. 密钥取不到
 */
export async function judge(
  state: JudgeState,
  questions: Record<string, JudgeQuestion>,
  options: JudgeOptions = {}
): Promise<JudgeResult | null> {
  // 文档承诺失败有去处：不给 onError 时也要留一行日志，不然判定器配错了永远没人发现
  const onError =
    options.onError ?? ((error: unknown) => console.warn('[judge] 判定失败，走回落规则：', error))
  try {
    const binding = await resolveJudgeBinding()
    if (!binding) return null

    if (payloadTooLarge(state, questions)) {
      onError(
        new Error(
          `判定请求体过大（${payloadSize(state, questions)} 字符，上限 ${MAX_PAYLOAD_CHARS}），` +
            '先在代码里筛掉与判据无关的字段'
        )
      )
      return null
    }

    return await requestJudgement(
      binding.provider,
      binding.modelId,
      state,
      questions,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.signal
    )
  } catch (error) {
    onError(error)
    return null
  }
}

// ==================== 读答案的小工具 ====================
//
// 这几个存在的理由只有一个：**让调用方没法忘记阈值**。
// 直接读 `answers.x.noul > 0.5` 是能跑的，但 0.5 这个数会散在各个调用点上，
// 而它恰恰是每一处都该单独定、也该单独调的那个值。

/**
 * 是非题判「是」。
 *
 * `threshold` 没有缺省值是**故意的**：它应该跟着后果走 —— 拿来放行一个
 * 不可逆操作和拿来给一条搜索结果打标签，不可能用同一个数。
 * 厂商的建议是从保守值起步，拿自己的数据测过再调。
 */
export function isYes(answer: JudgeAnswer | undefined, threshold: number): boolean {
  return answer?.type === 'noul' && answer.noul >= threshold
}

/**
 * 取一个**够笃定**的选项，不够笃定回 null。
 *
 * 只看 `choice` 而不看 `confidence` 是这套 API 最容易踩的坑：三个选项
 * 34/33/33 也会回一个 choice，读起来和 95/3/2 一模一样。分布的形状才是
 * 「它到底知不知道」，而那个信息只在 confidence 里。
 */
export function confidentChoice(
  answer: JudgeAnswer | undefined,
  minConfidence: number
): string | null {
  if (answer?.type !== 'choice') return null
  return answer.confidence >= minConfidence ? answer.choice : null
}

/**
 * 同上，评分题版本：回**最可能的那一档**（整数，从 0 开始计）。
 *
 * 取 `level`，没有时把期望值四舍五入 —— 这里要的是「是哪一档」，期望值 1.4 不是任何一档。
 * 要按期望值卡阈值就直接读 `answer.score`（见 ScoreAnswer 的注释）。
 */
export function confidentScore(
  answer: JudgeAnswer | undefined,
  minConfidence: number
): number | null {
  if (answer?.type !== 'score') return null
  if (answer.confidence < minConfidence) return null
  return answer.level ?? Math.round(answer.score)
}
