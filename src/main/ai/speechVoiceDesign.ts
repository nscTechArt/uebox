import type { ProviderConfig } from './types'

/**
 * 百炼「声音设计」：一段文字描述换一个音色 ID，外加一段试听。
 * https://docs.bailian.console.aliyun.com/zh/model-studio/voice-design-api-references
 *
 * 设计出来的音色绑死在 `target_model` 上，合成时必须用同一个模型。创建不收费，
 * 但每个账号连同声音复刻一共只能存 1000 个 —— 没被采用的要删掉。
 */

/** 哪些语音合成模型能用设计出来的音色。和 speech.ts 的选路同一份前缀 */
export function supportsVoiceDesign(modelId: string): boolean {
  return modelId.startsWith('qwen-audio-3.0-tts-')
}

/**
 * 合成走 WebSocket（`wss://域名/api-ws/v1/inference`），音色管理是同一个域名下的 HTTP：
 * 通用域名和工作空间专属域名都是这个对应关系，所以从来源地址推，不另开一个配置项。
 */
export function voiceDesignEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'wss:') throw new Error('TTS_INVALID_ENDPOINT')
  return `https://${url.host}/api/v1/services/audio/tts/customization`
}

async function call(
  provider: ProviderConfig,
  key: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  parameters?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(voiceDesignEndpoint(provider.baseUrl), {
    method: 'POST',
    headers: {
      ...provider.headers,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'voice-enrollment',
      input,
      ...(parameters ? { parameters } : {})
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)])
  })
  const body = (await response.json().catch(() => ({}))) as {
    output?: Record<string, unknown>
    code?: string
    message?: string
  }
  if (!response.ok || !body.output) {
    // 服务商的原话带出去：「描述太长」「额度满了」这类只有它说得清
    const reason = [body.code, body.message].filter(Boolean).join(': ')
    throw new Error(`音色服务返回 ${response.status}${reason ? `（${reason}）` : ''}`)
  }
  return body.output
}

export interface DesignedVoice {
  voiceId: string
  /** 试听，WAV */
  preview: Buffer
}

export async function createDesignedVoice(
  provider: ProviderConfig,
  key: string,
  targetModel: string,
  voicePrompt: string,
  previewText: string,
  signal: AbortSignal
): Promise<DesignedVoice> {
  const output = await call(
    provider,
    key,
    {
      action: 'create_voice',
      target_model: targetModel,
      voice_prompt: voicePrompt,
      preview_text: previewText,
      // 只许字母数字、最多 10 位。音色 ID 里会带上它，到百炼控制台里认得出是盒子建的
      prefix: 'uebox',
      // 只认第一项，且要和试听句的语言一致
      language_hints: [/[一-鿿]/u.test(previewText) ? 'zh' : 'en']
    },
    signal,
    { sample_rate: 24000, response_format: 'wav' }
  )
  const voiceId = output.voice_id
  const data = (output.preview_audio as { data?: unknown } | undefined)?.data
  if (typeof voiceId !== 'string' || !voiceId) throw new Error('音色服务没有返回音色 ID')
  if (typeof data !== 'string' || !data) throw new Error('音色服务没有返回试听音频')
  return { voiceId, preview: Buffer.from(data, 'base64') }
}

/** `OK` 才能合成；`DEPLOYING` 还在处理，`UNDEPLOYED` 审核没过 */
export async function queryDesignedVoice(
  provider: ProviderConfig,
  key: string,
  voiceId: string,
  signal: AbortSignal
): Promise<string> {
  const output = await call(provider, key, { action: 'query_voice', voice_id: voiceId }, signal)
  return typeof output.status === 'string' ? output.status : 'UNKNOWN'
}

export async function deleteDesignedVoice(
  provider: ProviderConfig,
  key: string,
  voiceId: string,
  signal: AbortSignal
): Promise<void> {
  await call(provider, key, { action: 'delete_voice', voice_id: voiceId }, signal)
}
