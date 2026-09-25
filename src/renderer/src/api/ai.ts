import i18n from '../i18n'
import type {
  ImageAspectRatio,
  ImageQuality,
  ImageResolution
} from '../../../shared/imageGenerationModels'
import { toPlainEditorSnapshot, type EditorSnapshot } from '../../../shared/editorSnapshot'
import { type CondensedSpeechStyle } from '../../../shared/speechBriefing'
import { toSessionProjectPayload } from '../views/Assistant/composables/sessionProjectBinding'

/**
 * 通过主进程调用用户配置的生图模型。图片返回包含真实 MIME 类型的 data URI，便于本地显示和保存。
 */
async function generateImageWithLocalModel(params: ImageGenerateParams): Promise<ImageResponse> {
  const referenceImages = params.images?.length
    ? params.images
    : params.image
      ? [params.image]
      : undefined

  const result = await window.api.ai.generateImage({
    prompt: params.prompt,
    providerId: params.localProviderId,
    modelId: params.localModelId,
    // imageSize 多数时候是 1K/2K/4K 这种档位，只有写成 1024x1024 时才是真尺寸。
    // 主进程认不出来就当没填、回落到按比例出图 —— 正是这里想要的，所以原样递过去
    size: params.imageSize,
    aspectRatio: params.aspectRatio,
    referenceImages,
    count: params.batchSize,
    seed: params.seed
  })

  if (result?.success !== true || !result.data) {
    throw new Error(result?.error || '生成失败')
  }

  return {
    ok: true,
    images: result.data.images.map((image) => ({
      url: `data:${image.mediaType};base64,${image.base64}`
    }))
  }
}

// ==================== 类型定义 ====================

/**
 * AI聊天消息角色
 */
export type ChatRole = 'system' | 'user' | 'assistant'

/**
 * 聊天消息内容类型
 */
export type ChatMessageContent =
  | string
  | Array<{
      type: 'text' | 'image_url'
      text?: string
      image_url?: {
        url: string
        detail?: 'low' | 'high' | 'auto'
      }
    }>

/**
 * 聊天消息
 */
export interface ChatMessage {
  role: ChatRole
  content: ChatMessageContent
}

/**
 * OpenAI 兼容 BYOK 请求载荷
 */
export type CustomProviderMode = 'openai-compatible' | 'anthropic-native'

/**
 * 聊天请求参数
 */
export interface ChatRequestParams {
  provider?: string
  model?: string
  /** 模型级别，服务端自动解析对应的 chatLevels 配置 */
  level?: 'fast' | 'base' | 'low' | 'medium' | 'high' | 'max'
  stream?: boolean
  maxTokens?: number
  responseFormat?:
    | 'text'
    | 'json_object'
    | {
        type: 'json_object' | 'json_schema'
        json_schema?: object
      }
  messages: ChatMessage[]
  /** 请求超时时间（毫秒），默认 30000 */
  timeout?: number
  /** 调用类型标识，用于选择对应的模型绑定（如 notebook-mindmap、notebook-report） */
  callType?: string
  /** 请模型别思考。关不掉的模型会夹到它支持的最低一档 */
  reasoning?: 'off'
  /** 透传给 OpenAI 兼容后端的额外请求体参数，如 { enable_thinking: false } */
  extra_body?: Record<string, unknown>
  /** extra_body 的驼峰别名 */
  extraBody?: Record<string, unknown>
}

/**
 * `chatText` 的参数。比 `ChatRequestParams` 多了中止与增量回调。
 */
export interface StreamedChatParams extends Omit<ChatRequestParams, 'stream'> {
  /** 中止这次生成。触发后 `chatText` 抛 {@link ChatAbortedError} */
  signal?: AbortSignal
  /** 每来一段新文本调一次。`text` 是到目前为止的全文 */
  onDelta?: (delta: string, text: string) => void
}

/**
 * 用户中止了生成。
 *
 * 单独一个类型而不是复用 Error：调用方要把「用户自己取消」和「模型出错」
 * 显示成两回事 —— 前者不该弹红色报错。
 */
export class ChatAbortedError extends Error {
  constructor() {
    super('生成已取消')
    this.name = 'ChatAbortedError'
  }
}

/**
 * 聊天响应（非流式）
 */
export interface ChatResponse {
  id: string
  model: string
  content: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * 健康检查响应
 */
export interface HealthResponse {
  ok: boolean
  provider?: string
  sseEnabled?: boolean
}

export interface CustomProviderConnectionTestResponse {
  ok: boolean
  provider: string
  model: string
  mode: CustomProviderMode
  message: string
}

/**
 * 图像生成请求参数
 */
type ImageRequestQuality = 'standard' | 'hd' | ImageQuality

export interface ImageGenerateParams {
  provider?: string
  model?: string
  /** 用户在「模型」页保存的服务商；与 localModelId 同时存在时强制走本地配置 */
  localProviderId?: string
  /** 用户在「模型」页保存的生图模型；与 localProviderId 同时存在时强制走本地配置 */
  localModelId?: string
  prompt: string
  image?: string // base64格式的图片，如 "data:image/jpeg;base64,..."，用于图生图模式
  images?: string[] // 多参考图数组（base64 或 data URL）
  /** 图像分辨率：1K/2K/4K 或像素尺寸 */
  imageSize?: ImageResolution
  /** 宽高比 */
  aspectRatio?: ImageAspectRatio
  quality?: ImageRequestQuality
  style?: 'vivid' | 'natural'
  negativePrompt?: string
  steps?: number
  seed?: number
  batchSize?: number
  messages?: ChatMessage[]
}

/**
 * 图像编辑请求参数
 */
export interface ImageEditParams {
  provider?: string
  model?: string
  prompt: string
  images: Array<{
    data: string // base64编码
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  }>
  editType?: 'modify' | 'add' | 'remove' | 'style' | 'enhance'
  /** 图像分辨率：1K/2K/4K 或像素尺寸 */
  imageSize?: ImageResolution
  /** 宽高比 */
  aspectRatio?: ImageAspectRatio
  quality?: ImageRequestQuality
  style?: 'vivid' | 'natural'
  negativePrompt?: string
  steps?: number
  seed?: number
  batchSize?: number
}

/**
 * 图像生成/编辑响应
 */
export interface ImageResponse {
  ok: boolean
  images: Array<{
    url?: string
    base64?: string
  }>
  metadata?: {
    model?: string
    size?: string
    quality?: string
    style?: string
    prompt?: string
    revisedPrompt?: string
    enhancedPrompt?: string
    negativePrompt?: string
    steps?: number
    seed?: number
    editType?: string
    inputImageCount?: number
    outputImageCount?: number
    usage?: {
      promptTokens: number
      totalTokens: number
      cost: number
    }
  }
}

/**
 * 图像服务健康检查响应
 */
export interface ImageHealthResponse {
  ok: boolean
  defaultProvider?: string
  availableProviders?: string[]
  providers?: Record<string, any>
}

/**
 * 一轮 Agent 执行的遥控器。
 *
 * `stop()` 解析出的布尔是「它真的停下来了吗」而不是「停止指令发出去了吗」——
 * 停完立刻要重发一轮的调用方（编辑消息、重新生成）必须等到前者，否则新的
 * 一轮会撞上还没收尾的旧会话。
 */
export interface AgentRunController {
  stop: () => Promise<boolean>
}

/**
 * Agent执行参数
 */
export interface AgentExecuteParams {
  prompt?: string // 向后兼容：单个用户消息
  messages?: ChatMessage[] // 完整对话历史
  model?: string
  provider?: string
  tools?: any[] // OpenAI tools 格式
  maxSteps?: number
  sessionId?: string
  chatSid?: string // 对话ID（用于会话级敏感操作自动批准）
  token?: string // 可选的用户认证令牌
  /**
   * 审批策略。三档，见内核的 `ApprovalMode`。
   *
   * 由调用方按**这条会话**的权限档位算好传进来
   * （见 views/Assistant/composables/sessionPermissionMode.ts）。
   */
  approvalMode?: AgentV3ApprovalMode
  /**
   * 思考程度。不给等同 `auto` —— 不指定，随模型自己的默认。
   *
   * 只对推理模型有效（模型上要标了「推理」），普通模型会被内核夹成不思考。
   */
  thinkingLevel?: AgentV3ThinkingLevel
  /**
   * 技能沉淀档位。不给等同 `ask` —— 想沉淀时先问用户。
   *
   * 设置存在渲染层（`aiConfig.skillLearningMode`），主进程手上没有，
   * 和思考程度一样每轮随请求带下去。
   */
  skillLearning?: AgentV3SkillLearning
  /**
   * 是否允许 AI 拍编辑器画面。不传等同**允许** —— 这一档的默认状态就是开着的
   * （见 store 里的 `editorScreenshotEnabled` 和主进程的 `EDITOR_SCREENSHOT_DEFAULT`，
   * 三处兜底必须一致）。关掉时主进程会把 `ue_screenshot` 从工具池里摘掉。
   */
  editorScreenshotEnabled?: boolean
  defaultEngineVersion?: string // 用户设置的默认引擎版本（如 "5.5"、"5.4"）
  askMode?: boolean // Ask 模式（只读模式）：仅使用读取类工具，不执行任何写入操作
  byokOpenAICompatible?: {
    mode?: CustomProviderMode
    baseUrl: string
    apiKey: string
    model: string
  }
  /**
   * 这条会话归属的 UE 工程（侧边栏按它分组的那个戳）。
   *
   * 主进程手上只有「谁连着」，归属只有渲染层知道。不带下去的话，一条挂在
   * test222 下的会话问「这是啥项目」，模型会照着当前连接答成另一个工程。
   */
  sessionProject?: { projectName: string; projectPath?: string; engineVersion?: string } | null
  /** 这条会话绑着的知识库。主进程据此注册检索工具并在提示词里说明场景 */
  notebook?: { id: string; title?: string } | null
  /**
   * 用户**按下发送那一刻**的编辑器状态（闪存）。
   *
   * 这个键**存在**就意味着「已经定了」—— 要么是抓好的那份，要么是 `null`
   * （用户点掉了标签）。任何下游都不许再抓一次：气泡上显示的必须就是模型收到的。
   * 键不存在才表示这个入口还没接闪存。
   */
  editorSnapshot?: EditorSnapshot | null
  /** 随这轮带的音视频（本地路径）。怎么让模型看由主进程决定，见 `core/promptMedia.ts` */
  mediaFiles?: Array<{ filePath: string; fileName: string; kind: 'video' | 'audio' }>
}

export interface TtsNovelCreateRequest {
  title?: string
  text: string
  speaker?: string
  model?: string
  resource_id?: string
  sample_rate?: number
  bit_rate?: number
  speech_rate?: number
  loudness_rate?: number
  emotion?: string
  emotion_scale?: number
  silence_duration?: number
  context_texts?: string[]
  segment_chars?: number
}

export interface TtsNovelCreateResponse {
  ok: boolean
  task_id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  total_segments: number
  stream_key?: string
  stream_url?: string
  download_url?: string
}

export interface TtsNovelStatusResponse {
  ok: boolean
  task_id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  title?: string
  total_segments: number
  completed_segments: number
  stream_url?: string
  download_url?: string
  audio_url?: string
  usage?: {
    chars?: number
    text_words?: number
  }
  error?: string
}

/** 将任务等级映射到用户在设置中绑定的模型角色。 */
function levelToRole(level?: ChatRequestParams['level']): 'summary' | 'chat' | 'agent' {
  switch (level) {
    case 'high':
    case 'max':
      return 'agent'
    case 'medium':
      return 'chat'
    default:
      // fast / base / low / 未指定：都用轻量任务模型
      return 'summary'
  }
}

function normalizeFollowUps(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const suggestion = item.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    if (!suggestion || seen.has(suggestion)) continue
    seen.add(suggestion)
    result.push(suggestion)
    if (result.length === 3) break
  }
  return result
}

/**
 * 解析追问模型的输出。
 *
 * 正常路径是 JSON Schema；编号列表只用于兼容不支持结构化输出的本地模型。
 */
export function parseFollowUpSuggestions(raw: string): string[] {
  const content = raw.trim()
  if (!content) return []

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]
  const objectStart = content.indexOf('{')
  const objectEnd = content.lastIndexOf('}')
  const embeddedObject =
    objectStart >= 0 && objectEnd > objectStart
      ? content.slice(objectStart, objectEnd + 1)
      : undefined

  for (const candidate of [fenced, content, embeddedObject]) {
    if (!candidate) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      const followUps = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>).followUps
          : undefined
      const suggestions = normalizeFollowUps(followUps)
      if (suggestions.length > 0) return suggestions
    } catch {
      // 继续尝试下一种格式
    }
  }

  const listed = content
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:(?:[-*•])|(?:\d{1,2}[.)、:：]))\s*(.+?)\s*$/)?.[1])
    .filter((item): item is string => Boolean(item))
  return normalizeFollowUps(listed)
}

/** 会话标题的硬上限。模型偶尔会无视「不超过 15 个字」，侧边栏那一栏放不下 */
export const MAX_SESSION_TITLE_CHARS = 24

function normalizeSessionTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  const title = value
    .replace(/\s+/g, ' ')
    .trim()
    // 模型爱给标题套引号，也爱在末尾点个句号
    .replace(/^["'“”‘’「『]+|["'“”‘’」』。.]+$/g, '')
    .trim()
  return title.slice(0, MAX_SESSION_TITLE_CHARS)
}

/**
 * 解析取名模型的输出。
 *
 * 正常路径是 JSON Schema；裸一行标题只用于兼容不支持结构化输出的本地模型 ——
 * 那种模型此刻正是「轻量任务」这一档最常绑的东西，不兜住就等于这功能对它们不存在。
 */
export function parseGeneratedTitle(raw: string): string {
  const content = (raw || '').trim()
  if (!content) return ''

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]
  const objectStart = content.indexOf('{')
  const objectEnd = content.lastIndexOf('}')
  const embeddedObject =
    objectStart >= 0 && objectEnd > objectStart
      ? content.slice(objectStart, objectEnd + 1)
      : undefined

  for (const candidate of [fenced, content, embeddedObject]) {
    if (!candidate) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      const title =
        parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).title : parsed
      const normalized = normalizeSessionTitle(title)
      if (normalized) return normalized
    } catch {
      // 继续尝试下一种格式
    }
  }

  // 长得就是 JSON 却没解析出 title：那是模型给了个结构化的废话（`{"title":null}`），
  // 别把这行 JSON 当标题塞进侧边栏 —— 回空串，调用方留着截断标题
  // 以 `{` / `[` / ``` 开头却没解析出来：多半是 maxTokens 截断的半截 JSON，首行只剩一个 `{`
  if (fenced || embeddedObject || /^(?:[{[]|```)/.test(content)) return ''

  return normalizeSessionTitle(content.split(/\r?\n/).find((line) => line.trim()))
}

/**
 * 取名调用的公共部分：同一档模型、同一套参数、同一个解析器，只有喂进去的文本
 * 和那条系统提示不同。
 *
 * 走「轻量任务」模型（`summary` 角色，不传 `level` 即是它）：这是个几秒内要
 * 回来的装饰性调用，不值得占用户绑给对话/Agent 的那档模型。
 *
 * @returns 归一化后的标题。模型返回废话时是空串；模型没配、调用失败会**抛错**。
 */
async function requestSessionTitle(
  text: string,
  maxChars: number,
  systemPromptKey: string
): Promise<string> {
  const excerpt = (text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars)
  if (!excerpt) return ''

  const lang = i18n.global.locale.value === 'zh-CN' ? '中文' : 'English'

  const response = await aiAPI.chat({
    maxTokens: 128,
    callType: 'session-title',
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'session_title',
        strict: true,
        schema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title']
        }
      }
    },
    messages: [
      { role: 'system', content: i18n.global.t(systemPromptKey, { lang }) },
      { role: 'user', content: excerpt }
    ]
  })

  return parseGeneratedTitle(response.content)
}

// ==================== API方法 ====================

/**
 * 把界面沿用的 V2 形状翻译成 V3 的 `prompt` + `images`。
 *
 * V3 自己按 sessionId 恢复 transcript，所以**不需要**把历史再传一遍 ——
 * 界面传来的 `messages` 里除了这一轮的用户输入，还有临时注入的上下文
 * （当前 UE 工程信息、笔记本 RAG 命中内容）。那些是这一轮才有的新信息，
 * 必须并进 prompt，否则模型看不到。
 *
 * 图片单独抽出来走 pi 的 `prompt(input, images?)`。不抽的话
 * `[object Object]` 会被拼进正文，而用户在界面上看到图已经发出去了。
 */
/**
 * 定这一轮用哪档审批策略。
 *
 * 正常路径上调用方一定会带（那是会话自己的档位）。没带时给 `auto-edit`
 * 而不是 `ask`：`ask` 会让每一步写操作都弹窗，那是用户明确选择才该有的行为，
 * 不该是某个调用方忘了传参数的后果。
 */
export function resolveApprovalMode(params: AgentExecuteParams): AgentV3ApprovalMode {
  return params.approvalMode ?? 'auto-edit'
}

/** pi 那边的图片形状。抽出来是因为插话和普通发送两条路都要拼它 */
export type AgentV3Image = { type: 'image'; data: string; mimeType: string }

/**
 * 一批图片 URL 拆成 pi 要的 `{ data, mimeType }`。
 *
 * data URL 能内联，外链不能 —— 后者退化成一行文本（`fallbackTexts`），
 * 至少让模型知道有这么个东西，而不是当它不存在。
 */
export function toAgentV3Images(urls: readonly string[]): {
  images: AgentV3Image[]
  fallbackTexts: string[]
} {
  const images: AgentV3Image[] = []
  const fallbackTexts: string[] = []

  for (const url of urls) {
    if (!url) continue
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
    if (match) images.push({ type: 'image', data: match[2], mimeType: match[1] })
    else fallbackTexts.push(`[图片] ${url}`)
  }

  return { images, fallbackTexts }
}

export function toAgentV3Prompt(params: AgentExecuteParams): {
  prompt: string
  images: AgentV3Image[]
} {
  const texts: string[] = []
  const images: AgentV3Image[] = []

  for (const message of params.messages ?? []) {
    if (typeof message.content === 'string') {
      if (message.content.trim()) texts.push(message.content)
      continue
    }
    if (!Array.isArray(message.content)) continue

    for (const part of message.content) {
      if (part.type === 'text' && part.text?.trim()) {
        texts.push(part.text)
        continue
      }
      const url = part.image_url?.url
      if (part.type !== 'image_url' || !url) continue

      // data URL 拆成 pi 要的 { data, mimeType }；外链图片这里没法内联，
      // 退化成一行文本，至少让模型知道有这么个东西
      const converted = toAgentV3Images([url])
      images.push(...converted.images)
      texts.push(...converted.fallbackTexts)
    }
  }

  // messages 为空时退回 prompt 字段（历史调用方有直接传 prompt 的）
  const prompt = texts.join('\n\n').trim() || (params.prompt ?? '')
  return { prompt, images }
}

export const aiAPI = {
  /**
   * AI聊天补全（非流式）
   * @param params 聊天请求参数，支持自定义 timeout
   */
  async chat(params: ChatRequestParams): Promise<ChatResponse> {
    const result = await window.api.ai.chatCompletion({
      messages: params.messages,
      role: levelToRole(params.level),
      maxTokens: params.maxTokens,
      callType: params.callType,
      responseFormat: params.responseFormat,
      ...(params.reasoning ? { reasoning: params.reasoning } : {})
    })

    if (!result.success) {
      throw new Error(result.error || 'AI 调用失败')
    }

    const data = result.data as {
      content: string
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    }

    return {
      id: '',
      model: '',
      content: data.content,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.promptTokens,
            completion_tokens: data.usage.completionTokens,
            total_tokens: data.usage.totalTokens
          }
        : undefined
    }
  },

  /**
   * 一次调用，拿回**全文**，但底下走的是流式。
   *
   * 与 `chat` 的区别只有两条，而这两条正是长任务（知识库 Studio 的六类产出）
   * 需要的：
   *
   * - **能中止**。非流式那条路一旦发出去就收不回来，用户点「取消」只是让界面
   *   不再等结果，模型那边照跑照扣 token。流式有 sessionId，可以真的掐断。
   * - **有动静**。生成一份报告要几十秒到几分钟，`onDelta` 让调用方知道确实在
   *   出字，而不是对着一个不动的进度条猜是不是卡死了。
   *
   * 不返回 `Response` 也不拼 SSE：那是 `chatStream` 为四个老调用点保留的兼容层，
   * 新调用点要的是一段文本，中间过一道 SSE 再解回来只是白饶一圈。
   */
  async chatText(params: StreamedChatParams): Promise<string> {
    const sessionId = `chat-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const cleanups: Array<() => void> = []

    try {
      return await new Promise<string>((resolve, reject) => {
        if (params.signal?.aborted) {
          reject(new ChatAbortedError())
          return
        }

        let text = ''

        cleanups.push(
          window.api.ai.onStreamChunk((payload) => {
            if (payload.sessionId !== sessionId) return
            text += payload.delta
            params.onDelta?.(payload.delta, text)
          })
        )

        cleanups.push(
          window.api.ai.onStreamDone((payload) => {
            if (payload.sessionId !== sessionId) return
            // 中止时主进程也走 done（带 aborted 标记），不特殊处理的话调用方会把
            // 半截文本当成完整结果去解析
            if (payload.aborted) reject(new ChatAbortedError())
            else resolve(payload.text || text)
          })
        )

        cleanups.push(
          window.api.ai.onStreamError((payload) => {
            if (payload.sessionId !== sessionId) return
            reject(new Error(payload.message))
          })
        )

        // 监听挂好之后再发起，避免首个增量丢在监听之前
        const dispatched = window.api.ai.chatStream({
          sessionId,
          messages: params.messages,
          role: levelToRole(params.level),
          maxTokens: params.maxTokens,
          callType: params.callType,
          responseFormat: params.responseFormat
        })

        void dispatched.then(
          (result) => {
            // 发起阶段就失败时（没配模型、Provider 不存在）不会有 stream-error 事件
            if (!result?.success) reject(new Error(result?.error || 'AI 调用失败'))
          },
          // invoke 本身被拒（通道没注册、参数序列化失败、窗口已销毁）时不会有任何
          // 流事件。不接这一手，这个 Promise 就永远不结算 —— 界面上是一根停住的
          // 进度条，连取消都救不回来
          (error) => reject(error instanceof Error ? error : new Error(String(error)))
        )

        if (params.signal) {
          // 中止要**等这次 invoke 到达主进程之后**再发：主进程是在 chat-stream 的
          // 处理函数里才把 controller 记进表的，抢在前面调 abortStream 会找不到
          // 会话、变成空操作 —— 模型照跑完，用户的 token 照扣
          const onAbort = (): void => {
            void dispatched.then(
              () => window.api.ai.abortStream(sessionId),
              () => undefined
            )
          }

          if (params.signal.aborted) {
            onAbort()
          } else {
            params.signal.addEventListener('abort', onAbort, { once: true })
            cleanups.push(() => params.signal?.removeEventListener('abort', onAbort))
          }
        }
      })
    } finally {
      cleanups.forEach((off) => off())
    }
  },

  /**
   * 获取智能追加提问建议
   * 基于用户消息和AI回复，生成2-3个相关的追加提问建议
   * @param params.userMessage 用户消息内容
   * @param params.assistantMessage AI会话回复内容
   * @returns 追加提问建议数组
   */
  async getFollowUpSuggestions(params: {
    userMessage: string
    assistantMessage: string
  }): Promise<string[]> {
    try {
      const isZh = i18n.global.locale.value === 'zh-CN'
      const lang = isZh ? '中文' : 'English'

      const response = await aiAPI.chat({
        maxTokens: 256,
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'follow_ups',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                followUps: {
                  type: 'array',
                  items: { type: 'string' }
                }
              },
              required: ['followUps']
            }
          }
        },
        messages: [
          {
            role: 'system',
            content: i18n.global.t('ai.followUpSystemPrompt', { lang })
          },
          {
            role: 'user',
            content: params.userMessage
          },
          {
            role: 'assistant',
            content: params.assistantMessage
          },
          {
            role: 'user',
            content: i18n.global.t('ai.followUpUserPrompt', { lang })
          }
        ]
      })

      return parseFollowUpSuggestions(response.content)
    } catch (error) {
      console.error('获取追加提问建议失败:', error)
      // 不影响主回复，界面只是不显示追问建议
      return []
    }
  },

  /**
   * 生成笔记标题
   * 基于用户提问和AI回复内容，生成一个简洁精准的笔记标题
   * @param params.userMessage 用户消息内容
   * @param params.assistantMessage AI会话回复内容（将截断前2000字）
   * @returns 生成的笔记标题字符串
   */
  async generateNoteTitle(params: {
    userMessage: string
    assistantMessage: string
  }): Promise<string> {
    try {
      // 截断 AI 回复内容到前 2000 字符
      const truncatedAssistantMessage = params.assistantMessage.slice(0, 2000)

      const response = await aiAPI.chat({
        maxTokens: 128,
        messages: [
          {
            role: 'system',
            content:
              '你是一个专业的笔记标题生成器。根据用户的问题和AI的回答内容，生成一个简洁、精准、有信息量的中文笔记标题。标题应在5-15个字之间，能够概括对话的核心主题。仅输出JSON且必须符合schema，字段为title（字符串），不要输出其它内容或解释。'
          },
          {
            role: 'user',
            content: params.userMessage
          },
          {
            role: 'assistant',
            content: truncatedAssistantMessage
          },
          {
            role: 'user',
            content: '基于上面的对话，生成一个简洁精准的笔记标题'
          }
        ]
      })

      // 解析响应内容，提取 JSON 中的 title 字段
      let content = ''
      const responseData = response as unknown as Record<string, unknown>

      if (
        responseData.choices &&
        Array.isArray(responseData.choices) &&
        responseData.choices.length > 0
      ) {
        // OpenAI 格式
        const choice = responseData.choices[0] as { message?: { content?: string } }
        content = choice?.message?.content || ''
      } else if (typeof responseData.content === 'string') {
        // 简单格式
        content = responseData.content
      }

      content = content.trim()
      if (!content) {
        console.warn('生成笔记标题响应中未找到有效内容')
        return ''
      }

      // 尝试从 Markdown 代码块中提取 JSON
      const jsonMatch =
        content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/)
      const jsonStr = jsonMatch ? jsonMatch[1] : content

      const parsed = JSON.parse(jsonStr)
      return typeof parsed.title === 'string' ? parsed.title : ''
    } catch (error) {
      console.error('生成笔记标题失败:', error)
      // 返回空字符串，调用方会使用降级策略
      return ''
    }
  },

  /**
   * 给 AI 会话起名。
   *
   * 只喂第一条用户消息的**前 500 字**：起名要的是「这段对话讲什么」，而第一条
   * 消息的开头就已经把它讲完了 —— 后面往往是贴进来的日志或代码，喂进去只会让
   * 轻量模型跑得更慢，还容易被日志里的字样带偏。
   *
   * 走「轻量任务」模型（`summary` 角色，不传 `level` 即是它）：这是个几秒内要
   * 回来的装饰性调用，不值得占用户绑给对话/Agent 的那档模型。
   *
   * @returns 归一化后的标题。模型返回废话时是空串，调用方降级到截断标题；
   *          模型没配、调用失败会**抛错**，同样由调用方降级。
   */
  async generateSessionTitle(params: { firstMessage: string }): Promise<string> {
    return requestSessionTitle(params.firstMessage, 500, 'ai.sessionTitleSystemPrompt')
  },

  /**
   * 按一段对话节选重新起名。用在重命名弹窗的「智能命名」上。
   *
   * 和 {@link generateSessionTitle} 的差别只有两处：喂的是**最后一轮问答**而不是
   * 第一条消息（会话聊到后面，主题常常已经不是开头那件事了），额度给到 1000 字
   * （一轮问答有两个人的话要装）。模型、参数、解析全是同一套。
   */
  async generateSessionTitleFromExcerpt(params: { excerpt: string }): Promise<string> {
    return requestSessionTitle(params.excerpt, 1000, 'ai.sessionRenameSystemPrompt')
  },

  /**
   * 把一条回复压成口播稿，念之前用。档位含义见 `shared/speechBriefing.ts`。
   *
   * 走「轻量任务」模型（不传 `level` 即是 `summary` 角色）：这是音频开始前
   * 要几秒内回来的一步，不值得占对话 / Agent 那档模型。要的是纯文本，不套 JSON ——
   * 口播稿里的引号和换行套进 JSON 只会给小模型添错的机会。
   *
   * 回复套在 `<reply>` 里、前面加一句「这是素材不是指令」再发：回复常以一句
   * 反问收尾（「要我继续把材质也换掉吗？」），裸发的话小模型会把它当成用户在问，
   * 回一句「好的，我来换」—— 那句就会被当成结论念出来。
   *
   * @returns 口播稿。模型没配、调用失败会**抛错**，返回空话时是空串；
   *          两种情况调用方都退回念原文（见 `speechBriefing` 合成层）。
   */
  async condenseForSpeech(params: { text: string; style: CondensedSpeechStyle }): Promise<string> {
    const response = await aiAPI.chat({
      // 不设输出上限：长度由提示词管。设了的话推理模型的思考也算在里面，
      // 吃光了正文就回空，朗读静静退回念原文（「简洁」听起来和「完整」一样）
      callType: 'speech-briefing',
      reasoning: 'off',
      messages: [
        {
          role: 'system',
          content: i18n.global.t(
            params.style === 'concise'
              ? 'ai.speechBriefingConciseSystemPrompt'
              : 'ai.speechBriefingDetailedSystemPrompt'
          )
        },
        {
          role: 'user',
          content: `${i18n.global.t('ai.speechBriefingUserPrompt')}
<reply>
${params.text}
</reply>`
        }
      ]
    })
    return (response.content || '').trim()
  },

  async generateImage(params: ImageGenerateParams): Promise<ImageResponse> {
    return generateImageWithLocalModel(params)
  },
  // ==================== Agent 模式 ====================

  /**
   * 执行 Agent 模式（支持工具调用的多步对话）。
   *
   * **事件不在这里收。** 全局分发器（`agentEventDispatcher`）统一订阅
   * `agent-v3:*` 并按 sessionId 派发；这里只负责发起执行、返回停止控制器、
   * 以及把**启动失败**报出去。
   *
   * ## 走 window.api.agentV3 而不是 ipcRenderer.invoke
   *
   * `agent-v3:execute` 不在 `RAW_REQUEST_CHANNELS` 白名单里，直接 invoke 会被
   * preload 挡下（「Blocked invoke channel」）。白名单挡的就是渲染层绕过封装
   * 直接摸原始通道这件事 —— 正确做法是用 `window.api.agentV3.*`，
   * 而不是把通道加进白名单。
   *
   * @param params 沿用历史形状（`messages` / `askMode` 等），这里翻译成 V3 契约
   * @param listeners 只用于启动阶段的失败回报
   */
  async executeAgent(
    params: AgentExecuteParams,
    listeners: {
      onError?: (error: any) => void
    }
  ): Promise<AgentRunController> {
    const sessionId = params.sessionId || ''

    const controller: AgentRunController = {
      /**
       * 返回值是「它真的停下来了吗」。主进程那边 stop 会等会话收尾再回话，
       * 停不下来（卡在审批框、工具没退出）时回 false —— 调用方要停完接着
       * 重发一轮的话，必须看这个值，否则新的一轮会被旧的顶掉。
       */
      stop: async () => {
        if (!sessionId) {
          console.warn('[Agent] sessionId 不存在，无法停止')
          return false
        }
        try {
          const result = await window.api.agentV3.stop({ sessionId })
          return result?.drained !== false
        } catch (error) {
          console.error('[Agent] 停止失败:', error)
          return false
        }
      }
    }

    const { prompt, images } = toAgentV3Prompt(params)

    // 后台发起，不 await —— 用户要能在执行过程中随时 stop()
    window.api.agentV3
      .execute({
        sessionId,
        prompt,
        ...(images.length ? { images } : {}),
        mode: params.askMode ? 'ask' : 'agent',
        approvalMode: resolveApprovalMode(params),
        thinkingLevel: params.thinkingLevel ?? 'auto',
        skillLearning: params.skillLearning ?? 'ask',
        /*
         * 隐私档：允不允许 agent 拍编辑器画面。
         *
         * 这个字段以前在这里被**默默丢掉** —— 界面上的开关照样能关，主进程
         * 从头到尾没收到过，`ue_screenshot` 也就一直在工具池里。一个什么都不做的
         * 隐私开关比没有开关更糟：用户以为自己关上了。
         *
         * 兜底 `true` 必须和 store（`editorScreenshotEnabled` 的 `?? true`）、
         * 主进程（`EDITOR_SCREENSHOT_DEFAULT`）一致：三层各写各的默认，
         * 用户一个开关都没动过就会看到两种行为。
         */
        editorScreenshotEnabled: params.editorScreenshotEnabled ?? true,
        /*
         * 过桥前一律拍平。
         *
         * 这两样都可能是 Pinia 里取出来的响应式代理（会话戳、排队里存着的快照），
         * 而结构化克隆搬不动 Proxy —— Electron 抛 `An object could not be cloned.`，
         * 用户看到的是「发一条消息弹 Agent 执行异常，正文一个字都没有」。
         * 钉在这一层而不是指望每个调用方记得转：调用方有五个，还会更多。
         */
        sessionProject: toSessionProjectPayload(params.sessionProject),
        notebook: params.notebook ?? null,
        // 只在调用方真的定过它时才带下去。`undefined` 和 `null` 对主进程效果一样
        // （都不拼块），但少传一个键能让「这个入口还没接闪存」在日志里看得出来
        ...(params.editorSnapshot !== undefined
          ? { editorSnapshot: toPlainEditorSnapshot(params.editorSnapshot) }
          : {}),
        // 拍成普通对象：store 里那份可能是响应式代理，过不了 IPC 的结构化克隆
        ...(params.mediaFiles?.length
          ? {
              mediaFiles: params.mediaFiles.map(({ filePath, fileName, kind }) => ({
                filePath,
                fileName,
                kind
              }))
            }
          : {})
      })
      .then((result: { success?: boolean; error?: string; code?: string } | undefined) => {
        // **失败是返回值，不是异常。**
        // 只挂 .catch 的话，主进程报 { success: false, error } 时这里
        // 一声不吭，用户看到的就是「点了没反应」。
        if (result && result.success === false) {
          // `code` 要带上：主进程回码、渲染层查文案，没有它就只能把主进程
          // 那句（带 sessionId 的诊断原文）原样糊给用户
          listeners.onError?.({
            message: result.error || 'Agent 执行失败',
            ...(result.code ? { code: result.code } : {})
          })
        }
      })
      .catch((error: unknown) => {
        listeners.onError?.(error)
      })

    // 立即返回控制器
    return controller
  }
}

export default aiAPI
