/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesignedVoice,
  deleteDesignedVoice,
  supportsVoiceDesign,
  voiceDesignEndpoint
} from './speechVoiceDesign'
import type { ProviderConfig } from './types'

const provider: ProviderConfig = {
  id: 'alibaba-tts',
  kind: 'tts',
  displayName: 'Ali',
  protocol: 'openai-completions',
  baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  apiKey: { kind: 'none' },
  models: []
}

function respond(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => vi.unstubAllGlobals())

describe('百炼声音设计', () => {
  it('从合成地址推出同域名的音色管理地址，工作空间专属域名也一样', () => {
    expect(voiceDesignEndpoint(provider.baseUrl)).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization'
    )
    expect(voiceDesignEndpoint('wss://ws1.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference')).toBe(
      'https://ws1.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization'
    )
    expect(() => voiceDesignEndpoint('https://openspeech.bytedance.com/x')).toThrow()
  })

  it('只有 qwen-audio 3.0 能用设计音色', () => {
    expect(supportsVoiceDesign('qwen-audio-3.0-tts-plus')).toBe(true)
    expect(supportsVoiceDesign('seed-tts-2.0')).toBe(false)
  })

  it('创建时绑定目标模型、按试听句选语言，拿回音色 ID 和试听 WAV', async () => {
    const fetch = respond(200, {
      output: { voice_id: 'v-1', preview_audio: { data: Buffer.from('RIFF').toString('base64') } }
    })
    const voice = await createDesignedVoice(
      provider,
      'k',
      'qwen-audio-3.0-tts-plus',
      '低沉沙哑的老铁匠',
      'Stay away from my forge, kid.',
      new AbortController().signal
    )
    expect(voice).toEqual({ voiceId: 'v-1', preview: Buffer.from('RIFF') })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: 'qwen-audio-3.0-tts-plus',
        voice_prompt: '低沉沙哑的老铁匠',
        preview_text: 'Stay away from my forge, kid.',
        prefix: 'uebox',
        language_hints: ['en']
      },
      parameters: { sample_rate: 24000, response_format: 'wav' }
    })
  })

  it('服务商报错时把它的原话带出来', async () => {
    respond(400, { code: 'Throttling.AllocationQuota', message: 'voice quota exceeded' })
    await expect(
      deleteDesignedVoice(provider, 'k', 'v-1', new AbortController().signal)
    ).rejects.toThrow('音色服务返回 400（Throttling.AllocationQuota: voice quota exceeded）')
  })
})
