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

async function analyzeOpenAICompatible(
  provider: ProviderConfig,
  model: ModelConfig,
  data: string,
  prompt: string
): Promise<string> {
  const apiKey = await resolveApiKey(provider.apiKey)
  const baseUrl = provider.baseUrl.replace(/\/+$/, '')
  const url = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`
  const body = {
    model: model.id,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'video_url', video_url: { url: `data:;base64,${data}` } },
          { type: 'text', text: prompt }
        ]
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
}): Promise<ConfiguredVideoAnalysisResult | null> {
  const selected = findConfiguredVideoModel(await readSettings())
  if (!selected) return null
  if (!args.data) return { success: false, error: '没有拿到视频内容' }

  try {
    const prompt = args.prompt?.trim() || DEFAULT_PROMPT
    let content = ''
    if (selected.provider.protocol === 'openai-completions') {
      content = await analyzeOpenAICompatible(selected.provider, selected.model, args.data, prompt)
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
