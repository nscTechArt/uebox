import { resolveApiKey } from '../../ai/credentials'
import { readSettings } from '../../ai/store'
import type { AiProviderSettings, ProviderConfig } from '../../ai/types'
import type { ModelConfig, ModelRole } from '../../../shared/aiProvider'

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_PROMPT = `请用中文分析这段视频，输出 Markdown，包含：
1. 视频主题与内容摘要
2. 关键时间点
3. 重要数据、结论与关键词
只描述视频中实际出现或听到的内容，不要猜测。`

/** 音频没有画面，问「关键时间点」之外还得把说了什么写全，否则回来一句摘要没法用 */
const DEFAULT_AUDIO_PROMPT = `请用中文分析这段音频，输出 Markdown，包含：
1. 内容摘要
2. 逐段转写（有几个人说话就标出说话人，听不清的地方写明听不清）
3. 关键时间点与重要信息
只描述音频里实际听到的内容，不要猜测。`

/** 送去理解的是视频还是音频。两者走同一批模型，但请求分片的形状不同 */
export type MediaKind = 'video' | 'audio'

export interface ConfiguredVideoAnalysisResult {
  success: boolean
  markdown?: string
  content?: string
  error?: string
  model?: string
}

export interface ConfiguredVideoModel {
  provider: ProviderConfig
  model: ModelConfig
}

const ROLE_PREFERENCE: readonly ModelRole[] = ['chat', 'agent', 'vision', 'summary']

/** 优先用已绑定且支持视频的模型，否则用模型清单里第一条显式勾选的。 */
export function findConfiguredVideoModel(
  settings: AiProviderSettings
): ConfiguredVideoModel | null {
  for (const role of ROLE_PREFERENCE) {
    const binding = settings.roles[role]
    if (!binding) continue
    const provider = settings.providers.find((item) => item.id === binding.providerId)
    const model = provider?.models.find((item) => item.id === binding.modelId)
    if (provider && model?.supportsVideo === true) return { provider, model }
  }

  for (const provider of settings.providers) {
    const model = provider.models.find((item) => item.supportsVideo === true)
    if (model) return { provider, model }
  }
  return null
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

/** 同时兼容普通 JSON 与 OpenAI 流式 SSE 响应。 */
export function parseChatCompletion(raw: string): string {
  try {
    const json = JSON.parse(raw)
    const content = textContent(json?.choices?.[0]?.message?.content)
    if (content) return content.trim()
  } catch {
    // 流式响应不是一整个 JSON，继续逐行解析
  }

  let content = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const chunk = JSON.parse(data)
      content += textContent(chunk?.choices?.[0]?.delta?.content)
    } catch {
      // 单个坏分片不影响其余有效内容
    }
  }
  return content.trim()
}

function apiError(raw: string, status: number): string {
  try {
    const message = JSON.parse(raw)?.error?.message
    if (typeof message === 'string' && message) return message
  } catch {
    // 非 JSON 错误页，下面给出截断后的正文
  }
  return raw.trim().slice(0, 300) || `HTTP ${status}`
}

/**
 * 音频在 OpenAI 兼容协议里不是 `video_url`，而是单独的 `input_audio` 分片，
 * 还要显式报格式（通义千问 omni、GPT-4o audio 都按这个收）。
 * Google 那边则统一走 `inlineData`，不用分。
 */
function audioFormatOf(mimeType: string): string | null {
  const subtype = mimeType.split('/')[1]?.toLowerCase() ?? ''
  /*
   * 不能拿 MIME 的子类型直接当 format 用。
   *
   * `.m4a` 的 MIME 是 `audio/mp4`，照搬就会发出 `format: "mp4"`；`.aiff` 同理。
   * 厂商那边只认一张很短的白名单（通义千问 omni、GPT-4o audio 都是），
   * 不在表上的值换来一次 400，而错误信息只说「unsupported format」，
   * 看不出是我们这边编错了字符串。
   *
   * 所以查表，查不到就返回 null —— 由调用方在**发出去之前**说清这个格式送不了，
   * 比让用户等一次远端 400 强。
   */
  const BY_SUBTYPE: Record<string, string> = {
    mpeg: 'mp3',
    mp3: 'mp3',
    wav: 'wav',
    'x-wav': 'wav',
    wave: 'wav',
    // m4a/aac 装在 MP4 容器里，MIME 是 audio/mp4，但 format 要报 m4a
    mp4: 'm4a',
    'x-m4a': 'm4a',
    m4a: 'm4a',
    aac: 'aac',
    flac: 'flac',
    ogg: 'ogg',
    opus: 'opus',
    webm: 'webm'
  }
  return BY_SUBTYPE[subtype] ?? null
}

async function analyzeOpenAICompatible(
  provider: ProviderConfig,
  model: ModelConfig,
  data: string,
  mimeType: string,
  kind: MediaKind,
  prompt: string
): Promise<string> {
  const apiKey = await resolveApiKey(provider.apiKey)
  const baseUrl = provider.baseUrl.replace(/\/+$/, '')
  const url = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`
  let mediaPart: Record<string, unknown>
  if (kind === 'audio') {
    const format = audioFormatOf(mimeType)
    // 编不出合法的 format 就别发。远端只会回一句看不懂的 400
    if (!format) {
      throw new Error(
        `${mimeType} 这种音频格式发不出去（厂商的 input_audio 不收它）。请先转成 mp3 或 wav。`
      )
    }
    mediaPart = { type: 'input_audio', input_audio: { data, format } }
  } else {
    mediaPart = { type: 'video_url', video_url: { url: `data:;base64,${data}` } }
  }
  const body = {
    model: model.id,
    messages: [
      {
        role: 'user',
        content: [mediaPart, { type: 'text', text: prompt }]
      }
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(model.id.toLowerCase().includes('omni') ? { modalities: ['text'] } : {})
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...provider.headers
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(apiError(raw, response.status))
  return parseChatCompletion(raw)
}

async function analyzeGoogle(
  provider: ProviderConfig,
  model: ModelConfig,
  data: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  const apiKey = await resolveApiKey(provider.apiKey)
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model.id)}:generateContent`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
      ...provider.headers
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ inlineData: { mimeType, data } }, { text: prompt }]
        }
      ],
      generationConfig: { maxOutputTokens: 8192 }
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(apiError(raw, response.status))
  const parts = JSON.parse(raw)?.candidates?.[0]?.content?.parts
  return textContent(parts).trim()
}

/**
 * `data` 是 base64 的视频字节，必填。
 *
 * 这里**只收字节，不收 URL**：远端地址交给厂商去 fetch 一律不成立
 * （B 站要 Referer，Gemini 的 fileUri 只认 Files API 和 YouTube），
 * 所以下载那一步归调用方，见 `videoSourceAnalysis.ts`。
 */
export async function analyzeVideoWithConfiguredModel(args: {
  data: string
  mimeType: string
  prompt?: string
  /** 默认视频。音频复用同一批模型 —— 能看视频的多模态模型基本都能听音频 */
  kind?: MediaKind
}): Promise<ConfiguredVideoAnalysisResult | null> {
  const selected = findConfiguredVideoModel(await readSettings())
  if (!selected) return null
  const kind: MediaKind = args.kind ?? 'video'
  if (!args.data)
    return { success: false, error: `没有拿到${kind === 'audio' ? '音频' : '视频'}内容` }

  try {
    const prompt = args.prompt?.trim() || (kind === 'audio' ? DEFAULT_AUDIO_PROMPT : DEFAULT_PROMPT)
    let content = ''
    if (selected.provider.protocol === 'openai-completions') {
      content = await analyzeOpenAICompatible(
        selected.provider,
        selected.model,
        args.data,
        args.mimeType,
        kind,
        prompt
      )
    } else if (selected.provider.protocol === 'google-generative-ai') {
      content = await analyzeGoogle(
        selected.provider,
        selected.model,
        args.data,
        args.mimeType,
        prompt
      )
    } else {
      return {
        success: false,
        error: `模型 ${selected.model.id} 的接口协议暂不支持视频输入，请使用 OpenAI Chat Completions 兼容协议或 Google Generative AI。`
      }
    }

    if (!content) return { success: false, error: '视频模型返回了空内容' }
    return {
      success: true,
      markdown: content,
      content,
      model: `${selected.provider.displayName}:${selected.model.id}`
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '视频分析失败'
    }
  }
}
