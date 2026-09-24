/** @vitest-environment node */
/**
 * 套餐语音合成的单次上限：别家一段 600 字，套餐一段能到清单的 max_input_chars（2000 字），
 * 超时和音频上限跟着字数放宽，长回复不会念到一半被自己的上限掐断。
 */
import { describe, expect, it } from 'vitest'
import { MAX_SPEECH_CHARS } from '../../../shared/speech'
import type { ProviderConfig } from '../types'
import { requestPlanSpeech, speechLimits } from './speech'

describe('speechLimits', () => {
  it('600 字以内照旧：90 秒、20 MiB', () => {
    expect(speechLimits('字'.repeat(MAX_SPEECH_CHARS))).toMatchObject({
      timeoutMs: 90_000,
      maxAudioBytes: 20 * 1024 * 1024
    })
    expect(speechLimits('短').timeoutMs).toBe(90_000)
  })

  it('2000 字一段：放得下七八分钟的 24 kHz 16-bit 单声道音频', () => {
    const limits = speechLimits('字'.repeat(2000))
    // 按 4 字/秒念，2000 字是 500 秒，48000 字节/秒
    expect(limits.maxAudioBytes).toBeGreaterThan(500 * 48_000)
    expect(limits.timeoutMs).toBeGreaterThan(90_000 * 3)
  })
})

describe('requestPlanSpeech 按这个上限收', () => {
  const provider = {
    id: 'creator-plan-tts',
    displayName: 'Box Plan',
    kind: 'tts',
    protocol: 'openai-completions',
    baseUrl: 'https://plan.example/v1',
    apiKey: { kind: 'none' },
    models: [{ id: 'uebox-tts' }]
  } as unknown as ProviderConfig

  /** 回 21 MiB 的 PCM（超过 600 字那一档的 20 MiB 上限），分成 1 MiB 一片的 SSE 事件 */
  const bigAudio = (async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1).toString('base64')
    const lines = Array.from(
      { length: 21 },
      () => `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: chunk })}\n\n`
    )
    lines.push(`data: ${JSON.stringify({ type: 'speech.audio.done' })}\n\n`)
    return new Response(lines.join(''), { status: 200 })
  }) as unknown as typeof fetch

  it('2000 字一段：20 多 MB 的音频照常收完', async () => {
    let bytes = 0
    await requestPlanSpeech(
      provider,
      'uebox-tts',
      undefined,
      '字'.repeat(2000),
      'k',
      new AbortController().signal,
      (audio) => (bytes += Buffer.from(audio.base64, 'base64').length),
      bigAudio
    )
    expect(bytes).toBe(21 * 1024 * 1024)
  })

  it('600 字以内还是 20 MiB 封顶', async () => {
    await expect(
      requestPlanSpeech(
        provider,
        'uebox-tts',
        undefined,
        '字'.repeat(MAX_SPEECH_CHARS),
        'k',
        new AbortController().signal,
        () => {},
        bigAudio
      )
    ).rejects.toThrow('TTS_AUDIO_TOO_LARGE')
  })
})
